import { buildBackgroundProjectState, loadBestBaselineRunArtifact, loadLatestBackgroundRunCatalogEntry } from "@client/knowledge";
import { inspectRepository } from "@client/repository-git";
import { normalizePath, stableId, type BackgroundProjectState } from "@client/shared";
import { openWorkspaceSelective, scanWorkspaceOverview } from "@client/workspace";
import { enqueuePipelineRun, findPipelineRunByRepositoryHead } from "./pipeline-runner.js";
import { getCurrentProvider } from "./provider-store.js";
import { listProjects } from "./project-store.js";

interface ProjectStateMonitorConfig {
  appRootPath: string;
  // Используются только если в БД ещё нет ни одного провайдера (например
  // самый первый запуск до initializeProviderStore()) — обычный путь всегда
  // берёт baseUrl/apiKey/model из getCurrentProvider() свежо на каждый тик,
  // а не из значений, замороженных в момент старта процесса (см. resolveMonitorProvider).
  fallbackProviderBaseUrl: string;
  fallbackProviderModel: string;
  fallbackProviderApiKey: string;
  intervalMs?: number;
  minAutoSyncIntervalMs?: number;
}

interface ResolvedMonitorProvider {
  providerBaseUrl: string;
  providerModel: string;
  providerApiKey: string;
}

async function resolveMonitorProvider(config: ProjectStateMonitorConfig): Promise<ResolvedMonitorProvider> {
  try {
    const provider = await getCurrentProvider();

    if (provider) {
      return {
        providerBaseUrl: provider.baseUrl || config.fallbackProviderBaseUrl,
        providerModel: provider.defaultModel || config.fallbackProviderModel,
        providerApiKey: provider.apiKey || config.fallbackProviderApiKey,
      };
    }
  } catch {
    // БД временно недоступна — используем bootstrap-фолбэк, не роняем monitor tick.
  }

  return {
    providerBaseUrl: config.fallbackProviderBaseUrl,
    providerModel: config.fallbackProviderModel,
    providerApiKey: config.fallbackProviderApiKey,
  };
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
    const resolvedProvider = await resolveMonitorProvider(config);
    const projects = await listProjects();

    for (const project of projects) {
      for (const projectPath of project.paths) {
        await observeProjectPath(config, resolvedProvider, project.id, projectPath.id, projectPath.rootPath);
      }
    }
  } catch (error) {
    // Этот тик вызывается из setInterval через `void pollProjectStates(...)` —
    // необработанное исключение здесь становится unhandled promise rejection
    // и роняет весь процесс (проверено живьём: временная недоступность
    // Postgres убивала API в течение 15 секунд без возможности восстановления).
    console.warn("[project-state-monitor] poll tick failed, will retry next interval:", error);
  } finally {
    monitorRunning = false;
  }
}

async function observeProjectPath(
  config: ProjectStateMonitorConfig,
  resolvedProvider: ResolvedMonitorProvider,
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

    await maybeEnqueueAutoBackgroundSync(config, resolvedProvider, normalizedPath, backgroundState);
  } catch {
    // Monitoring must never break the API process because of one problematic project path.
  }
}

async function maybeEnqueueAutoBackgroundSync(
  config: ProjectStateMonitorConfig,
  resolvedProvider: ResolvedMonitorProvider,
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

  const autoSyncRunId = stableId(["auto-background-sync", projectPath, backgroundState.headFingerprint, now]);

  enqueuePipelineRun({
    runId: autoSyncRunId,
    mode: "background-sync",
    // background-sync — не вопрос пользователя, диалоговая нить к нему не
    // применима; conversationId = собственный runId, как и для старых
    // артефактов без явного треда (см. normalizePipelineRunArtifact).
    conversationId: autoSyncRunId,
    task: `Автоматически обнови committed baseline для ветки ${backgroundState.branch || "HEAD"} и HEAD ${backgroundState.headCommit}.`,
    projectPath,
    providerBaseUrl: resolvedProvider.providerBaseUrl,
    providerModel: resolvedProvider.providerModel,
    providerApiKey: resolvedProvider.providerApiKey,
    appRootPath: config.appRootPath,
  });
}
