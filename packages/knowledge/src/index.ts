import { promises as fs } from "node:fs";
import path from "node:path";
import {
  type ControlledExecutionRuntime,
  type ContextPackage,
  type ExecutionPlan,
  type ExecutionPreview,
  type GraphState,
  type ImpactReport,
  type IndexResult,
  type KnowledgeCatalogEntry,
  type KnowledgeSaveResult,
  type PipelineRunResult,
  type ProviderRuntimeConfig,
  type RepositorySnapshot,
  type ResearchReport,
  stableId,
  type WorkspaceSnapshot,
} from "@client/shared";

interface SaveKnowledgeInput {
  runId: string;
  task: string;
  appRootPath: string;
  workspace: WorkspaceSnapshot;
  repository: RepositorySnapshot;
  provider: ProviderRuntimeConfig;
  index: IndexResult;
  graph: GraphState;
  research: ResearchReport;
  impact: ImpactReport;
  context: ContextPackage;
  plan: ExecutionPlan;
  executionPreview: ExecutionPreview;
  executionRuntime: ControlledExecutionRuntime;
}

export async function saveKnowledgeArtifacts(input: SaveKnowledgeInput): Promise<KnowledgeSaveResult> {
  const stateDirectory = getKnowledgeProjectDirectory(input.appRootPath, input.workspace.rootPath);
  const runsDirectory = path.join(stateDirectory, "runs");
  const catalogPath = path.join(stateDirectory, "catalog.json");
  const storagePath = path.join(runsDirectory, `${input.runId}.json`);
  const savedAt = new Date().toISOString();

  await fs.mkdir(runsDirectory, { recursive: true });

  const artifact = {
    runId: input.runId,
    task: input.task,
    savedAt,
    workspace: {
      projectName: input.workspace.projectName,
      rootPath: input.workspace.rootPath,
      summary: input.workspace.summary,
    },
    repository: input.repository,
    provider: input.provider,
    index: {
      manifest: input.index.manifest,
      stats: input.index.stats,
      diagnostics: input.index.diagnostics,
    },
    graph: {
      graphId: input.graph.graphId,
      summary: input.graph.summary,
    },
    research: input.research,
    impact: input.impact,
    context: input.context,
    plan: input.plan,
    executionPreview: input.executionPreview,
    executionRuntime: input.executionRuntime,
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

  return {
    runId: input.runId,
    savedAt,
    storagePath,
    catalogPath,
    artifactCount: 5,
  };
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
    return normalizePipelineRunArtifact(JSON.parse(content) as Partial<PipelineRunResult>, runId);
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

function getKnowledgeProjectDirectory(appRootPath: string, projectRootPath: string): string {
  const projectKey = stableId(["knowledge-project", projectRootPath]);
  return path.join(appRootPath, ".client", "knowledge", "projects", projectKey);
}

function normalizePipelineRunArtifact(
  artifact: Partial<PipelineRunResult>,
  runId: string,
): PipelineRunResult | null {
  if (
    !artifact.runId ||
    !artifact.project ||
    !artifact.workspace ||
    !artifact.repository ||
    !artifact.provider ||
    !artifact.index ||
    !artifact.graph ||
    !artifact.research ||
    !artifact.impact ||
    !artifact.knowledge
  ) {
    return null;
  }

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
    project: artifact.project,
    workspace: artifact.workspace,
    repository: artifact.repository,
    provider: artifact.provider,
    index: artifact.index,
    graph: artifact.graph,
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
    knowledge: {
      ...artifact.knowledge,
      artifactCount: artifact.knowledge.artifactCount ?? 8,
    },
  };
}
