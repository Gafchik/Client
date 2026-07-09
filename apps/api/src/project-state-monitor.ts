import { buildBackgroundProjectState, loadBestBaselineRunArtifact, loadLatestBackgroundRunCatalogEntry } from "@client/knowledge";
import { inspectRepository } from "@client/repository-git";
import { normalizePath, stableId, type BackgroundProjectState } from "@client/shared";
import { openWorkspaceSelective, scanWorkspaceOverview } from "@client/workspace";
import { enqueuePipelineRun, findPipelineRunByRepositoryHead } from "./pipeline-runner.js";
import { listProjects } from "./project-store.js";

interface ProjectStateMonitorConfig {
  appRootPath: string;
  providerBaseUrl: string;
  providerModel: string;
  providerApiKey: string;
  intervalMs?: number;
  minAutoSyncIntervalMs?: number;
}

interface ProjectMonitorSnapshot {
  projectId: string;
  projectPathId: string;
  projectPath: string;
  backgroundState: BackgroundProjectState;
  observedAt: string;
}

const DEFAULT_INTERVAL_MS = 15_000;
const DEFAULT_MIN_AUTO_SYNC_INTERVAL_MS = 60_000;

let monitorTimer: NodeJS.Timeout | null = null;
let monitorRunning = false;
const observedStates = new Map<string, ProjectMonitorSnapshot>();
const recentAutoSyncAttempts = new Map<string, number>();

export function startProjectStateMonitor(config: ProjectStateMonitorConfig): void {
  if (monitorTimer) {
    return;
  }

  const intervalMs = config.intervalMs ?? DEFAULT_INTERVAL_MS;
  void pollProjectStates(config);

  monitorTimer = setInterval(() => {
    void pollProjectStates(config);
  }, intervalMs);
  monitorTimer.unref?.();
}

export function stopProjectStateMonitor(): void {
  if (!monitorTimer) {
    return;
  }

  clearInterval(monitorTimer);
  monitorTimer = null;
}

export function getObservedProjectState(projectPath: string): ProjectMonitorSnapshot | null {
  const normalizedPath = normalizePath(projectPath);
  return observedStates.get(normalizedPath) ?? null;
}

async function pollProjectStates(config: ProjectStateMonitorConfig): Promise<void> {
  if (monitorRunning) {
    return;
  }

  monitorRunning = true;

  try {
    const projects = await listProjects();

    for (const project of projects) {
      for (const projectPath of project.paths) {
        await observeProjectPath(config, project.id, projectPath.id, projectPath.rootPath);
      }
    }
  } finally {
    monitorRunning = false;
  }
}

async function observeProjectPath(
  config: ProjectStateMonitorConfig,
  projectId: string,
  projectPathId: string,
  projectPath: string,
): Promise<void> {
  try {
    const overview = await scanWorkspaceOverview(projectPath);
    const workspace = await openWorkspaceSelective(projectPath, {
      includePaths: [],
      maxFiles: 0,
    });
    const repository = await inspectRepository(workspace);
    const baselineSelection = await loadBestBaselineRunArtifact(config.appRootPath, overview.rootPath, repository);
    const latestBackgroundRun = await loadLatestBackgroundRunCatalogEntry(config.appRootPath, overview.rootPath);
    const backgroundState = buildBackgroundProjectState({
      projectId: overview.projectId,
      projectRootPath: overview.rootPath,
      repository,
      latestRunId: latestBackgroundRun?.runId ?? null,
      baselineRun: baselineSelection.run,
      baselineSource: baselineSelection.source,
    });
    const normalizedPath = normalizePath(overview.rootPath);

    observedStates.set(normalizedPath, {
      projectId,
      projectPathId,
      projectPath: normalizedPath,
      backgroundState,
      observedAt: new Date().toISOString(),
    });

    await maybeEnqueueAutoBackgroundSync(config, normalizedPath, backgroundState);
  } catch {
    // Monitoring must never break the API process because of one problematic project path.
  }
}

async function maybeEnqueueAutoBackgroundSync(
  config: ProjectStateMonitorConfig,
  projectPath: string,
  backgroundState: BackgroundProjectState,
): Promise<void> {
  if (backgroundState.syncStatus === "degraded") {
    return;
  }

  if (backgroundState.freshness === "fresh") {
    return;
  }

  if (backgroundState.hasLocalChanges) {
    return;
  }

  const activeSameHeadRun = findPipelineRunByRepositoryHead({
    projectPath,
    mode: "background-sync",
    headFingerprint: backgroundState.headFingerprint,
    statuses: ["queued", "running", "completed"],
  });

  if (activeSameHeadRun?.status === "queued" || activeSameHeadRun?.status === "running" || activeSameHeadRun?.status === "completed") {
    return;
  }

  const throttleKey = `${projectPath}::${backgroundState.headFingerprint}`;
  const now = Date.now();
  const minAutoSyncIntervalMs = config.minAutoSyncIntervalMs ?? DEFAULT_MIN_AUTO_SYNC_INTERVAL_MS;
  const lastAttempt = recentAutoSyncAttempts.get(throttleKey) ?? 0;

  if (now - lastAttempt < minAutoSyncIntervalMs) {
    return;
  }

  recentAutoSyncAttempts.set(throttleKey, now);

  enqueuePipelineRun({
    runId: stableId(["auto-background-sync", projectPath, backgroundState.headFingerprint, now]),
    mode: "background-sync",
    task: `Автоматически обнови committed baseline для ветки ${backgroundState.branch || "HEAD"} и HEAD ${backgroundState.headCommit}.`,
    projectPath,
    providerBaseUrl: config.providerBaseUrl,
    providerModel: config.providerModel,
    providerApiKey: config.providerApiKey,
    appRootPath: config.appRootPath,
  });
}
