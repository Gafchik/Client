import { promises as fs } from "node:fs";
import path from "node:path";
import {
  type AnswerPackage,
  type BackgroundProjectState,
  type ControlledExecutionRuntime,
  type ContextPackage,
  type ExecutionPlan,
  type ExecutionPreview,
  type GraphState,
  type ImpactReport,
  type IndexResult,
  type KnowledgeCatalogEntry,
  type KnowledgeSaveResult,
  type PipelineWorkspaceDetails,
  type PipelineRunResult,
  type ProviderRuntimeConfig,
  type RepositorySnapshot,
  type ResearchReport,
  stableId,
  type WorkspaceSnapshot,
} from "@client/shared";

interface SaveKnowledgeInput {
  runId: string;
  mode: PipelineRunResult["mode"];
  task: string;
  appRootPath: string;
  workspace: WorkspaceSnapshot;
  repository: RepositorySnapshot;
  backgroundState?: BackgroundProjectState;
  provider: ProviderRuntimeConfig;
  index: IndexResult;
  incrementalIndex: PipelineRunResult["incrementalIndex"];
  graph: GraphState;
  graphInvalidation: PipelineRunResult["graphInvalidation"];
  research: ResearchReport;
  impact: ImpactReport;
  context: ContextPackage;
  plan: ExecutionPlan;
  executionPreview: ExecutionPreview;
  executionRuntime: ControlledExecutionRuntime;
  answer: AnswerPackage;
}

interface PersistedWorkspaceSummary {
  projectName: string;
  rootPath: string;
  summary: WorkspaceSnapshot["summary"];
}

interface PersistedPipelineRunArtifact {
  runId?: string;
  mode?: PipelineRunResult["mode"];
  task?: string;
  savedAt?: string;
  project?: PipelineRunResult["project"];
  workspace?: PersistedWorkspaceSummary;
  repository?: RepositorySnapshot;
  backgroundState?: BackgroundProjectState;
  provider?: ProviderRuntimeConfig;
  index?: PipelineRunResult["index"];
  incrementalIndex?: PipelineRunResult["incrementalIndex"];
  graph?: PipelineRunResult["graph"];
  graphInvalidation?: PipelineRunResult["graphInvalidation"];
  stages?: PipelineRunResult["stages"];
  research?: ResearchReport;
  impact?: ImpactReport;
  context?: ContextPackage;
  plan?: ExecutionPlan;
  executionPreview?: ExecutionPreview;
  executionRuntime?: ControlledExecutionRuntime;
  answer?: AnswerPackage;
  knowledge?: KnowledgeSaveResult;
  runtimeCache?: PipelineRunResult["runtimeCache"];
}

export async function saveKnowledgeArtifacts(input: SaveKnowledgeInput): Promise<KnowledgeSaveResult> {
  const stateDirectory = getKnowledgeProjectDirectory(input.appRootPath, input.workspace.rootPath);
  const runsDirectory = path.join(stateDirectory, "runs");
  const catalogPath = path.join(stateDirectory, "catalog.json");
  const storagePath = path.join(runsDirectory, `${input.runId}.json`);
  const savedAt = new Date().toISOString();

  await fs.mkdir(runsDirectory, { recursive: true });

  const knowledge: KnowledgeSaveResult = {
    runId: input.runId,
    savedAt,
    storagePath,
    catalogPath,
    artifactCount: 5,
  };

  const artifact = {
    runId: input.runId,
    mode: input.mode,
    task: input.task,
    savedAt,
    project: {
      name: input.workspace.projectName,
      rootPath: input.workspace.rootPath,
      summary: input.workspace.summary,
    },
    workspace: {
      projectName: input.workspace.projectName,
      rootPath: input.workspace.rootPath,
      summary: input.workspace.summary,
    },
    repository: input.repository,
    ...(input.backgroundState
      ? {
          backgroundState: input.backgroundState,
        }
      : {}),
    provider: input.provider,
    index: {
      manifest: input.index.manifest,
      stats: input.index.stats,
      diagnostics: input.index.diagnostics,
    },
    incrementalIndex: input.incrementalIndex,
    graph: {
      graphId: input.graph.graphId,
      summary: input.graph.summary,
    },
    graphInvalidation: input.graphInvalidation,
    research: input.research,
    impact: input.impact,
    context: input.context,
    plan: input.plan,
    executionPreview: input.executionPreview,
    executionRuntime: input.executionRuntime,
    answer: input.answer,
    knowledge,
    runtimeCache: {
      index: input.index,
      graph: input.graph,
    },
  };

  await fs.writeFile(storagePath, JSON.stringify(artifact, null, 2));
  const catalog = await loadKnowledgeCatalog(input.appRootPath, input.workspace.rootPath);
  const nextEntry: KnowledgeCatalogEntry = {
    runId: input.runId,
    task: input.task,
    savedAt,
    storagePath,
    summary: input.research.summary,
  };
  const nextCatalog = [nextEntry, ...catalog.filter((entry) => entry.runId !== input.runId)].slice(0, 20);
  await fs.writeFile(catalogPath, JSON.stringify(nextCatalog, null, 2));

  return knowledge;
}

export async function loadKnowledgeCatalog(appRootPath: string, projectRootPath: string): Promise<KnowledgeCatalogEntry[]> {
  const catalogPath = path.join(getKnowledgeProjectDirectory(appRootPath, projectRootPath), "catalog.json");

  try {
    const content = await fs.readFile(catalogPath, "utf8");
    return JSON.parse(content) as KnowledgeCatalogEntry[];
  } catch {
    return [];
  }
}

export async function loadPipelineRunArtifact(
  appRootPath: string,
  projectRootPath: string,
  runId: string,
): Promise<PipelineRunResult | null> {
  const runsDirectory = path.join(getKnowledgeProjectDirectory(appRootPath, projectRootPath), "runs");
  const storagePath = path.join(runsDirectory, `${runId}.json`);

  try {
    const content = await fs.readFile(storagePath, "utf8");
    return normalizePipelineRunArtifact(JSON.parse(content) as PersistedPipelineRunArtifact, runId, storagePath);
  } catch {
    return null;
  }
}

export async function loadLatestPipelineRunArtifact(
  appRootPath: string,
  projectRootPath: string,
): Promise<PipelineRunResult | null> {
  const catalog = await loadKnowledgeCatalog(appRootPath, projectRootPath);
  const latestRun = catalog[0];

  if (!latestRun) {
    return null;
  }

  return loadPipelineRunArtifact(appRootPath, projectRootPath, latestRun.runId);
}

export async function loadLatestBackgroundRunArtifact(
  appRootPath: string,
  projectRootPath: string,
): Promise<PipelineRunResult | null> {
  const artifacts = await loadAllPipelineRunArtifacts(appRootPath, projectRootPath);
  return artifacts.find((artifact) => artifact.mode === "background-sync") ?? null;
}

export async function loadAllPipelineRunArtifacts(
  appRootPath: string,
  projectRootPath: string,
): Promise<PipelineRunResult[]> {
  const catalog = await loadKnowledgeCatalog(appRootPath, projectRootPath);
  const results = await Promise.all(
    catalog.map((entry) => loadPipelineRunArtifact(appRootPath, projectRootPath, entry.runId)),
  );

  return results.filter((item): item is PipelineRunResult => Boolean(item));
}

export async function loadBestBaselineRunArtifact(
  appRootPath: string,
  projectRootPath: string,
  repository: RepositorySnapshot,
): Promise<{
  run: PipelineRunResult | null;
  source: BackgroundProjectState["baselineSource"];
}> {
  const artifacts = (await loadAllPipelineRunArtifacts(appRootPath, projectRootPath))
    .filter((artifact) => artifact.mode === "background-sync");

  if (artifacts.length === 0) {
    return { run: null, source: "none" };
  }

  const exactHead = artifacts.find((artifact) =>
    artifact.repository.repositoryId === repository.repositoryId
    && artifact.repository.headCommit === repository.headCommit,
  );

  if (exactHead) {
    return { run: exactHead, source: "exact-head" };
  }

  const mergeBase = artifacts.find((artifact) =>
    artifact.repository.repositoryId === repository.repositoryId
    && artifact.repository.headCommit === repository.mergeBase,
  );

  if (mergeBase) {
    return { run: mergeBase, source: "merge-base" };
  }

  const recentBranch = artifacts.find((artifact) =>
    artifact.repository.repositoryId === repository.repositoryId
    && artifact.repository.branch === repository.branch,
  );

  if (recentBranch) {
    return { run: recentBranch, source: "recent-branch" };
  }

  return { run: artifacts[0] ?? null, source: "recent-branch" };
}

export function buildBackgroundProjectState(input: {
  projectId: string;
  projectRootPath: string;
  repository: RepositorySnapshot;
  latestRun: PipelineRunResult | null;
  baselineRun: PipelineRunResult | null;
  baselineSource: BackgroundProjectState["baselineSource"];
}): BackgroundProjectState {
  const latestRunId = input.latestRun?.runId;
  const baselineRunId = input.baselineRun?.runId;
  const baselineHeadCommit = input.baselineRun?.repository.headCommit;
  const exactHeadMatch = input.baselineRun?.repository.headFingerprint === input.repository.headFingerprint;
  const freshness: BackgroundProjectState["freshness"] =
    !input.baselineRun
      ? "missing"
      : exactHeadMatch
        ? "fresh"
        : "stale";
  const syncStatus: BackgroundProjectState["syncStatus"] =
    !input.repository.isGitRepository
      ? "degraded"
      : freshness === "fresh"
        ? "ready"
        : "syncing";
  const reusableFileCount = input.baselineRun?.index.manifest.reusedFileCount
    ?? input.baselineRun?.index.manifest.fileCount
    ?? 0;
  const invalidatedFileCount = input.repository.summary.changedFileCount;
  const worktreeStatus: BackgroundProjectState["worktreeStatus"] =
    input.repository.hasUnmergedPaths
      ? "conflict"
      : input.repository.isDirty
        ? "overlay"
        : "clean";

  return {
    stateId: stableId([
      "background-project-state",
      input.projectId,
      input.repository.headFingerprint,
      input.repository.stateFingerprint,
      latestRunId ?? "none",
      baselineRunId ?? "none",
    ]),
    projectId: input.projectId,
    projectRootPath: input.projectRootPath,
    repositoryId: input.repository.repositoryId,
    branch: input.repository.branch,
    headCommit: input.repository.headCommit,
    headFingerprint: input.repository.headFingerprint,
    mergeBase: input.repository.mergeBase,
    branchFingerprint: input.repository.branchFingerprint,
    worktreeFingerprint: input.repository.worktreeFingerprint,
    stateFingerprint: input.repository.stateFingerprint,
    ...(latestRunId ? { latestRunId } : {}),
    ...(baselineRunId ? { baselineRunId } : {}),
    ...(baselineHeadCommit ? { baselineHeadCommit } : {}),
    baselineSource: input.baselineSource,
    baselineExactForHead: exactHeadMatch,
    freshness,
    syncStatus,
    worktreeStatus,
    hasLocalChanges: input.repository.isDirty,
    changedFileCount: input.repository.summary.changedFileCount,
    reusableFileCount,
    invalidatedFileCount,
    refreshedAt: new Date().toISOString(),
    diagnostics: [
      ...input.repository.diagnostics,
      ...(input.repository.isDirty
        ? ["Есть локальные незакоммиченные изменения. Они учитываются через worktree overlay и не должны автоматически становиться committed baseline."]
        : []),
      ...(freshness === "stale"
        ? ["Фоновое понимание проекта устарело относительно текущего branch/head состояния репозитория."]
        : []),
      ...(freshness === "missing"
        ? ["Для текущего branch/head состояния ещё нет сохранённого background baseline run."]
        : []),
    ].slice(0, 8),
  };
}

function getKnowledgeProjectDirectory(appRootPath: string, projectRootPath: string): string {
  const projectKey = stableId(["knowledge-project", projectRootPath]);
  return path.join(appRootPath, ".client", "knowledge", "projects", projectKey);
}

function normalizePipelineRunArtifact(
  artifact: PersistedPipelineRunArtifact,
  runId: string,
  storagePath: string,
): PipelineRunResult | null {
  if (
    !artifact.runId ||
    !artifact.workspace ||
    !artifact.repository ||
    !artifact.provider ||
    !artifact.index ||
    !artifact.graph ||
    !artifact.research ||
    !artifact.impact
  ) {
    return null;
  }

  const project = artifact.project ?? {
    name: artifact.workspace.projectName,
    rootPath: artifact.workspace.rootPath,
    summary: artifact.workspace.summary,
  };
  const workspace: PipelineWorkspaceDetails = "scannedAt" in artifact.workspace
    ? artifact.workspace as unknown as PipelineWorkspaceDetails
    : {
        scannedAt: artifact.savedAt ?? new Date(0).toISOString(),
        ignoredPaths: [],
        diagnostics: [],
      };

  const knowledge: KnowledgeSaveResult = artifact.knowledge ?? {
    runId: artifact.runId,
    savedAt: artifact.savedAt ?? new Date(0).toISOString(),
    storagePath,
    catalogPath: path.join(path.dirname(path.dirname(storagePath)), "catalog.json"),
    artifactCount: 8,
  };

  const context: ContextPackage = artifact.context ?? {
    contextId: stableId(["context", artifact.runId]),
    runId: artifact.runId,
    summary: "Контекстный пакет отсутствовал в старом артефакте и был восстановлен в режиме совместимости.",
    functionalHighlights: artifact.research.functionalSummary ? [artifact.research.functionalSummary] : [],
    focusZones: artifact.research.affectedModules ?? [],
    rankingSummary: ["Старый артефакт не содержал ranking summary; данные восстановлены в режиме совместимости."],
    tokenBudget: 0,
    estimatedTokens: 0,
    includedFiles: [],
    selectedChunks: [],
    omittedCandidates: [],
    rules: ["Совместимость со старым run-артефактом без модуля сборки контекста."],
    confidence: artifact.research.confidence ?? 0,
  };

  const plan: ExecutionPlan = artifact.plan ?? {
    planId: stableId(["plan", artifact.runId]),
    runId: artifact.runId,
    summary: "План выполнения отсутствовал в старом артефакте и был восстановлен в режиме совместимости.",
    strategy: "sequential",
    risks: artifact.impact.risks ?? [],
    targetModules: artifact.research.affectedModules ?? [],
    targetFiles: artifact.impact.affectedFiles ?? [],
    entryPoints: artifact.research.entryPoints ?? [],
    validationScope: artifact.impact.validationScope ?? [],
    planningNotes: ["Старый артефакт не содержал planning notes; данные восстановлены в режиме совместимости."],
    dependencyChains: [],
    approvalRequired: true,
    steps: [],
  };

  const executionPreview: ExecutionPreview = artifact.executionPreview ?? {
    previewId: stableId(["execution-preview", artifact.runId]),
    runId: artifact.runId,
    mode: "safe-preview",
    summary: "Превью выполнения отсутствовало в старом артефакте и было восстановлено в режиме совместимости.",
    allowedActions: [],
    blockedActions: [],
    reindexRequired: true,
    graphRefreshRequired: true,
    knowledgeRefreshRequired: true,
  };

  const executionRuntime: ControlledExecutionRuntime = artifact.executionRuntime ?? {
    runtimeId: stableId(["controlled-runtime", artifact.runId]),
    runId: artifact.runId,
    mode: "controlled-runtime",
    status: "blocked",
    summary: "Controlled runtime отсутствовал в старом артефакте и был восстановлен в режиме совместимости.",
    allowedWriteFiles: [],
    blockedWriteZones: [".git", ".client/knowledge"],
    scopeGuards: ["Старый артефакт не содержал execution runtime contract."],
    approvalChecks: ["Перед execution требуется повторный запуск pipeline на новом формате артефакта."],
    refreshPlan: ["После изменений обязательны reindex, graph refresh и knowledge refresh."],
    executionAllowed: false,
  };

  const stages = artifact.stages ?? [];

  return {
    runId: artifact.runId,
    mode: artifact.mode ?? "question-run",
    project,
    workspace,
    repository: artifact.repository,
    provider: artifact.provider,
    index: artifact.index,
    ...(artifact.incrementalIndex ? { incrementalIndex: artifact.incrementalIndex } : {}),
    graph: artifact.graph,
    ...(artifact.graphInvalidation ? { graphInvalidation: artifact.graphInvalidation } : {}),
    stages,
    research: {
      ...artifact.research,
      intentClass: artifact.research.intentClass ?? "broad-unknown",
      strategyKey: artifact.research.strategyKey ?? "broad-repository-scan",
      queryProfileKey: artifact.research.queryProfileKey ?? "broad-scan",
      functionalSummary: artifact.research.functionalSummary ?? "Функциональная сводка отсутствовала в старом артефакте.",
      dominantModule: artifact.research.dominantModule ?? "не определён",
      moduleIntents: artifact.research.moduleIntents ?? [],
      entryPoints: artifact.research.entryPoints ?? [],
      primaryEntities: artifact.research.primaryEntities ?? [],
      sideEffects: artifact.research.sideEffects ?? [],
      dataSources: artifact.research.dataSources ?? [],
    },
    impact: artifact.impact,
    context,
    plan,
    executionPreview,
    executionRuntime,
    answer:
      artifact.answer
      ?? {
        answerId: stableId(["answer", artifact.runId]),
        runId: artifact.runId,
        answerMode: "fallback-answer",
        summary: artifact.research.summary,
        explanation: artifact.research.functionalSummary ?? artifact.research.summary,
        evidenceHighlights: safeEvidenceHighlights(artifact.research.findings ?? []),
        confirmedFacts: [],
        unconfirmedFacts: artifact.research.unknowns ?? [],
        manualChecks: ["Для полноценного answer synthesis требуется повторный запуск pipeline на новом формате."],
        confidence: artifact.research.confidence ?? 0,
        unknowns: artifact.research.unknowns ?? [],
        warnings: ["Старый артефакт не содержал Answer Package и был восстановлен в режиме совместимости."],
        nextActions: ["Для полноценного answer synthesis требуется повторный запуск pipeline на новом формате."],
        inspectorHints: ["Открыть Research и Plan для деталей."],
        generatedAt: knowledge.savedAt,
        synthesis: "deterministic-fallback",
      },
    knowledge: {
      ...knowledge,
      artifactCount: knowledge.artifactCount ?? 8,
    },
    ...(artifact.backgroundState
      ? {
          backgroundState: artifact.backgroundState as BackgroundProjectState,
        }
      : {}),
    ...(artifact.runtimeCache && artifact.runtimeCache.index && artifact.runtimeCache.graph
      ? {
          runtimeCache: {
            index: artifact.runtimeCache.index as IndexResult,
            graph: artifact.runtimeCache.graph as GraphState,
          },
        }
      : {}),
  };
}

function safeEvidenceHighlights(findings: string[]): Array<{ label: string; detail: string }> {
  return findings.slice(0, 3).map((finding, index) => ({
    label: `Finding ${index + 1}`,
    detail: finding,
  }));
}
