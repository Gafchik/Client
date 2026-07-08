import path from "node:path";
import { promises as fs } from "node:fs";
import { buildAnswerPackage, buildControlledExecutionRuntime } from "@client/ai";
import { buildContextPackage } from "@client/context";
import { buildGraph } from "@client/graph";
import { analyzeImpact } from "@client/impact-analysis";
import { runFullIndex } from "@client/indexer";
import { loadLatestPipelineRunArtifact, saveKnowledgeArtifacts } from "@client/knowledge";
import { buildExecutionPlan, buildExecutionPreview } from "@client/planner";
import { deriveRepositoryScopedPaths, inspectRepository, shouldPreferSelectiveWorkspace } from "@client/repository-git";
import { runResearch } from "@client/research";
import {
  type IncrementalIndexPlan,
  normalizePath,
  stableId,
  type GraphInvalidationPlan,
  type PipelinePartialArtifacts,
  type PipelineRunResult,
  type PipelineRunStatus,
  type PipelineStage,
} from "@client/shared";
import { openWorkspace, openWorkspaceSelective, scanWorkspaceOverview } from "@client/workspace";

export interface PipelineExecutionRequest {
  runId: string;
  task: string;
  projectPath: string;
  providerBaseUrl: string;
  providerModel: string;
  providerApiKey: string;
  appRootPath: string;
}

const runStore = new Map<string, PipelineRunStatus>();
const runAppRootStore = new Map<string, string>();
const PIPELINE_STATUS_RETENTION_MS = 1000 * 60 * 60 * 24 * 3;

export function enqueuePipelineRun(request: PipelineExecutionRequest): PipelineRunStatus {
  const createdAt = new Date().toISOString();
  const initialStatus: PipelineRunStatus = {
    runId: request.runId,
    task: request.task,
    projectPath: normalizePath(path.resolve(request.projectPath)),
    status: "queued",
    createdAt,
    updatedAt: createdAt,
    resumeContext: {
      providerBaseUrl: request.providerBaseUrl,
      providerModel: request.providerModel,
      canResumeFromStart: true,
      resumeAttempts: 0,
    },
    stages: createInitialStages(),
    partialArtifacts: {},
  };

  runStore.set(request.runId, initialStatus);
  runAppRootStore.set(request.runId, request.appRootPath);
  void persistRunStatus(request.appRootPath, initialStatus);
  void executePipelineRun(request);

  return initialStatus;
}

export function getPipelineRunStatus(runId: string): PipelineRunStatus | null {
  return runStore.get(runId) ?? null;
}

export async function loadPipelineRunStatus(appRootPath: string, runId: string): Promise<PipelineRunStatus | null> {
  const inMemory = runStore.get(runId);

  if (inMemory) {
    return inMemory;
  }

  const filePath = getPipelineStatusPath(appRootPath, runId);

  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as PipelineRunStatus;
    runStore.set(runId, parsed);
    runAppRootStore.set(runId, appRootPath);
    return parsed;
  } catch {
    return null;
  }
}

export async function bootstrapPipelineRunStatuses(appRootPath: string): Promise<void> {
  await cleanupExpiredPipelineStatuses(appRootPath);
  const directory = getPipelineStatusDirectory(appRootPath);

  try {
    const entries = await fs.readdir(directory, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }

      const runId = entry.name.replace(/\.json$/i, "");
      const status = await loadPipelineRunStatus(appRootPath, runId);

      if (status && (status.status === "queued" || status.status === "running")) {
        updateRunStatus(runId, {
          ...status,
          status: "failed",
          updatedAt: new Date().toISOString(),
          errorMessage: "API был перезапущен во время выполнения. Run можно безопасно перезапустить с начала.",
          stages: status.stages.map((stage) =>
            stage.status === "running"
              ? {
                  ...stage,
                  status: "failed",
                  completedAt: new Date().toISOString(),
                  details: "Run был прерван перезапуском API. Доступен resume-from-start.",
                }
              : stage,
          ),
          resumeContext: {
            ...(status.resumeContext ?? {
              providerBaseUrl: "",
              providerModel: "",
              canResumeFromStart: true,
              resumeAttempts: 0,
            }),
            canResumeFromStart: true,
          },
        });
      }
    }
  } catch {
    // ignore missing status directory during bootstrap
  }
}

async function executePipelineRun(request: PipelineExecutionRequest): Promise<void> {
  markRunRunning(request.runId);

  try {
    const result = await buildPipelineRunResult(request);
    const current = runStore.get(request.runId);

    if (!current) {
      return;
    }

    updateRunStatus(request.runId, {
      ...current,
      status: "completed",
      updatedAt: new Date().toISOString(),
      currentStageKey: "knowledge",
      currentStageLabel: "Знания",
      stages: result.stages,
      result,
    });
  } catch (error) {
    const current = runStore.get(request.runId);

    if (!current) {
      return;
    }

    updateRunStatus(request.runId, {
      ...current,
      status: "failed",
      updatedAt: new Date().toISOString(),
      errorMessage: error instanceof Error ? error.message : "Pipeline run завершился ошибкой.",
      stages: current.stages.map((stage) =>
        stage.status === "running"
          ? {
              ...stage,
              status: "failed",
              completedAt: new Date().toISOString(),
              details: "Этап завершился ошибкой.",
            }
          : stage,
      ),
    });
  }
}

async function buildPipelineRunResult(request: PipelineExecutionRequest): Promise<PipelineRunResult> {
  const { runId, task, projectPath, providerBaseUrl, providerModel, providerApiKey, appRootPath } = request;
  const overview = await scanWorkspaceOverview(projectPath);

  const workspaceStartedAt = startStage(runId, "workspace");
  const initialWorkspace = await openWorkspace(projectPath);
  const repositoryStartedAt = startStage(runId, "repository");
  const repository = await inspectRepository(initialWorkspace);
  completeStage(
    runId,
    "repository",
    repositoryStartedAt,
    repository.isGitRepository
      ? `Собран repository snapshot: ветка ${repository.branch || "unknown"}, изменений ${repository.summary.changedFileCount}.`
      : "Git-репозиторий не обнаружен, historical repository intelligence недоступен.",
  );

  const selectiveCandidatePaths = buildSelectiveCandidatePaths(task, repository, initialWorkspace);
  const shouldUseSelectiveWorkspace = shouldPreferSelectiveWorkspace(repository, initialWorkspace) && selectiveCandidatePaths.length > 0;
  const workspace = shouldUseSelectiveWorkspace
    ? await openWorkspaceSelective(projectPath, {
        includePaths: selectiveCandidatePaths,
        maxFiles: 250,
      })
    : initialWorkspace;
  const largeRepositoryProfile = overview.summary.profile === "large-repository";
  completeStage(
    runId,
    "workspace",
    workspaceStartedAt,
    largeRepositoryProfile
      ? shouldUseSelectiveWorkspace
        ? `Открыто ${workspace.summary.indexedFiles} индексируемых файлов. Large-repository режим переключён в selective fast-first scan.`
        : `Открыто ${workspace.summary.indexedFiles} индексируемых файлов. Активирован large-repository профиль для fast-first pipeline.`
      : `Открыто ${workspace.summary.indexedFiles} индексируемых файлов.`,
  );
  updatePartialArtifacts(runId, {
    workspace: {
      scannedAt: workspace.scannedAt,
      ignoredPaths: workspace.ignoredPaths,
      diagnostics: workspace.diagnostics,
    },
    repository,
  });

  const previousRun = await loadLatestPipelineRunArtifact(appRootPath, workspace.rootPath);
  const incrementalIndex = buildIncrementalIndexPlan(previousRun, repository, selectiveCandidatePaths, shouldUseSelectiveWorkspace);
  const graphInvalidation = buildGraphInvalidationPlan(previousRun, repository, workspace.rootPath);
  updatePartialArtifacts(runId, {
    incrementalIndex,
    graphInvalidation,
  });

  const indexStartedAt = startStage(runId, "index");
  const index = await runFullIndex(workspace, {
    previousRun,
    changedPaths: incrementalIndex.changedPaths,
    deletedPaths: incrementalIndex.deletedPaths,
  });
  completeStage(
    runId,
    "index",
    indexStartedAt,
    largeRepositoryProfile && index.manifest.mode === "selective"
      ? `Построен selective index: ${index.manifest.symbolCount} символов, ${index.manifest.relationCount} связей, reused files ${index.manifest.reusedFileCount}.`
      : `Построен index: ${index.manifest.symbolCount} символов, ${index.manifest.relationCount} связей, reused files ${index.manifest.reusedFileCount}.`,
  );
  updatePartialArtifacts(runId, {
    index: {
      manifest: index.manifest,
      stats: index.stats,
      diagnostics: index.diagnostics,
    },
  });

  const graphStartedAt = startStage(runId, "graph");
  const graph = buildGraph(workspace, index, {
    previousRun,
    invalidatedPaths: graphInvalidation.invalidatedFiles,
  });
  completeStage(runId, "graph", graphStartedAt, `Собран graph: ${graph.summary.nodeCount} узлов и ${graph.summary.edgeCount} рёбер.`);
  updatePartialArtifacts(runId, {
    graph: {
      summary: graph.summary,
    },
  });

  const researchStartedAt = startStage(runId, "research");
  const research = runResearch({
    runId,
    task,
    workspace,
    index,
    graph,
  });
  completeStage(runId, "research", researchStartedAt, `Подготовлено ${research.evidence.length} опорных ссылок с уверенностью ${research.confidence}%.`);
  updatePartialArtifacts(runId, {
    research,
  });

  const impactStartedAt = startStage(runId, "impact");
  const impact = analyzeImpact({
    runId,
    graph,
    research,
  });
  completeStage(runId, "impact", impactStartedAt, `Определено ${impact.affectedFiles.length} затронутых файлов и ${impact.risks.length} рисков.`);
  updatePartialArtifacts(runId, {
    impact,
  });

  const contextStartedAt = startStage(runId, "context");
  const context = buildContextPackage({
    runId,
    task,
    workspace,
    index,
    graph,
    research,
    impact,
  });
  completeStage(runId, "context", contextStartedAt, `Собран контекстный пакет: ${context.selectedChunks.length} фрагментов при бюджете ${context.tokenBudget}.`);
  updatePartialArtifacts(runId, {
    context,
  });

  const planStartedAt = startStage(runId, "plan");
  const plan = buildExecutionPlan({
    runId,
    task,
    research,
    impact,
    context,
    graph,
  });
  completeStage(runId, "plan", planStartedAt, `Построен план выполнения: ${plan.steps.length} шагов, требуется согласование: ${plan.approvalRequired ? "да" : "нет"}.`);
  updatePartialArtifacts(runId, {
    plan,
  });

  const previewStartedAt = startStage(runId, "preview");
  const executionPreview = buildExecutionPreview(runId, plan);
  completeStage(runId, "preview", previewStartedAt, `Подготовлено безопасное превью выполнения с ${executionPreview.allowedActions.length} разрешёнными действиями.`);
  updatePartialArtifacts(runId, {
    executionPreview,
  });

  const runtimeStartedAt = startStage(runId, "runtime");
  const executionRuntime = buildControlledExecutionRuntime({
    runId,
    research,
    plan,
    preview: executionPreview,
  });
  completeStage(runId, "runtime", runtimeStartedAt, `Подготовлен controlled runtime: статус ${executionRuntime.status}, write scope ${executionRuntime.allowedWriteFiles.length} файлов.`);
  updatePartialArtifacts(runId, {
    executionRuntime,
  });

  const answerStartedAt = startStage(runId, "answer");
  const answer = await buildAnswerPackage({
    runId,
    task,
    providerBaseUrl,
    providerModel,
    providerApiKey,
    research,
    impact,
    context,
    plan,
    preview: executionPreview,
    runtime: executionRuntime,
  });
  completeStage(runId, "answer", answerStartedAt, `Подготовлен финальный ответ: режим ${answer.answerMode}, confidence ${answer.confidence}%.`);
  updatePartialArtifacts(runId, {
    answer,
  });

  const knowledgeStartedAt = startStage(runId, "knowledge");
  const knowledge = await saveKnowledgeArtifacts({
    runId,
    task,
    appRootPath,
    workspace,
    repository,
    provider: {
      baseUrl: providerBaseUrl,
      model: providerModel,
      apiKeyMasked: maskApiKey(providerApiKey),
    },
    index,
    incrementalIndex,
    graph,
    graphInvalidation,
    research,
    impact,
    context,
    plan,
    executionPreview,
    executionRuntime,
    answer,
  });
  completeStage(runId, "knowledge", knowledgeStartedAt, `Артефакты сохранены в центральное knowledge-хранилище: ${knowledge.artifactCount} групп.`);

  return {
    runId,
    project: {
      name: workspace.projectName,
      rootPath: workspace.rootPath,
      summary: workspace.summary,
    },
    workspace: {
      scannedAt: workspace.scannedAt,
      ignoredPaths: workspace.ignoredPaths,
      diagnostics: workspace.diagnostics,
    },
    repository,
    provider: {
      baseUrl: providerBaseUrl,
      model: providerModel,
      apiKeyMasked: maskApiKey(providerApiKey),
    },
    index: {
      manifest: index.manifest,
      stats: index.stats,
      diagnostics: index.diagnostics,
    },
    incrementalIndex,
    graph: {
      summary: graph.summary,
    },
    graphInvalidation,
    stages: getCompletedStages(runId),
    research,
    impact,
    context,
    plan,
    executionPreview,
    executionRuntime,
    answer,
    knowledge,
    runtimeCache: {
      index,
      graph,
    },
  };
}

function createInitialStages(): PipelineStage[] {
  const now = new Date().toISOString();
  return [
    createPendingStage("workspace", "Workspace", now),
    createPendingStage("repository", "Repository Git", now),
    createPendingStage("index", "Index", now),
    createPendingStage("graph", "Graph", now),
    createPendingStage("research", "Исследование", now),
    createPendingStage("impact", "Анализ влияния", now),
    createPendingStage("context", "Контекст", now),
    createPendingStage("plan", "План", now),
    createPendingStage("preview", "Превью выполнения", now),
    createPendingStage("runtime", "Execution Runtime", now),
    createPendingStage("answer", "Ответ", now),
    createPendingStage("knowledge", "Знания", now),
  ];
}

function createPendingStage(key: PipelineStage["key"], label: string, now: string): PipelineStage {
  return {
    key,
    label,
    status: "pending",
    startedAt: now,
    completedAt: now,
    details: "Ожидает выполнения.",
  };
}

function markRunRunning(runId: string): void {
  const current = runStore.get(runId);

  if (!current) {
    return;
  }

  updateRunStatus(runId, {
    ...current,
    status: "running",
    updatedAt: new Date().toISOString(),
  });
}

function startStage(runId: string, stageKey: PipelineStage["key"]): string {
  const current = runStore.get(runId);
  const now = new Date().toISOString();

  if (!current) {
    return now;
  }

  updateRunStatus(runId, {
    ...current,
    updatedAt: now,
    currentStageKey: stageKey,
    currentStageLabel: current.stages.find((stage) => stage.key === stageKey)?.label ?? stageKey,
    stages: current.stages.map((stage) =>
      stage.key === stageKey
        ? {
            ...stage,
            status: "running",
            startedAt: now,
            completedAt: now,
            details: "Выполняется...",
          }
        : stage,
    ),
  });

  return now;
}

function completeStage(runId: string, stageKey: PipelineStage["key"], startedAt: string, details: string): void {
  const current = runStore.get(runId);
  const now = new Date().toISOString();

  if (!current) {
    return;
  }

  updateRunStatus(runId, {
    ...current,
    updatedAt: now,
    currentStageKey: stageKey,
    currentStageLabel: current.stages.find((stage) => stage.key === stageKey)?.label ?? stageKey,
    stages: current.stages.map((stage) =>
      stage.key === stageKey
        ? {
            ...stage,
            status: "completed",
            startedAt,
            completedAt: now,
            details,
          }
        : stage,
    ),
  });
}

function getCompletedStages(runId: string): PipelineStage[] {
  return runStore.get(runId)?.stages ?? createInitialStages();
}

function buildSelectiveCandidatePaths(
  task: string,
  repository: PipelineRunResult["repository"],
  workspace: Awaited<ReturnType<typeof openWorkspace>>,
): string[] {
  const gitScopedPaths = deriveRepositoryScopedPaths(repository, workspace);
  const normalizedTask = task.toLowerCase();
  const taskTokens = normalizedTask
    .split(/[^a-z0-9а-яё_/-]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
  const tokenMatchedPaths = workspace.files
    .map((file) => file.relativePath)
    .filter((relativePath) => {
      const lowerPath = relativePath.toLowerCase();
      return taskTokens.some((token) => lowerPath.includes(token));
    });
  const fallbackStructuralPaths = workspace.files
    .map((file) => file.relativePath)
    .filter((relativePath) => {
      const lowerPath = relativePath.toLowerCase();
      return (
        lowerPath.startsWith("routes/")
        || lowerPath.startsWith("config/")
        || lowerPath.startsWith("database/")
        || lowerPath.includes("/controllers/")
        || lowerPath.includes("/services/")
        || lowerPath.includes("/repositories/")
        || lowerPath.includes("/models/")
      );
    })
    .slice(0, 120);

  return Array.from(new Set([...gitScopedPaths, ...tokenMatchedPaths, ...fallbackStructuralPaths])).slice(0, 250);
}

function maskApiKey(value: string): string {
  if (!value) {
    return "";
  }

  if (value.length <= 8) {
    return "*".repeat(value.length);
  }

  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

async function persistRunStatus(appRootPath: string, status: PipelineRunStatus | null): Promise<void> {
  if (!status) {
    return;
  }

  const directory = getPipelineStatusDirectory(appRootPath);
  const filePath = getPipelineStatusPath(appRootPath, status.runId);

  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(status, null, 2));
}

function updateRunStatus(runId: string, status: PipelineRunStatus): void {
  runStore.set(runId, status);
  const appRootPath = runAppRootStore.get(runId);

  if (!appRootPath) {
    return;
  }

  void persistRunStatus(appRootPath, status);
}

function updatePartialArtifacts(runId: string, patch: PipelinePartialArtifacts): void {
  const current = runStore.get(runId);

  if (!current) {
    return;
  }

  updateRunStatus(runId, {
    ...current,
    updatedAt: new Date().toISOString(),
    partialArtifacts: {
      ...(current.partialArtifacts ?? {}),
      ...patch,
    },
  });
}

function getPipelineStatusDirectory(appRootPath: string): string {
  return path.join(appRootPath, ".client", "pipeline-status");
}

function getPipelineStatusPath(appRootPath: string, runId: string): string {
  return path.join(getPipelineStatusDirectory(appRootPath), `${runId}.json`);
}

async function cleanupExpiredPipelineStatuses(appRootPath: string): Promise<void> {
  const directory = getPipelineStatusDirectory(appRootPath);
  const now = Date.now();

  try {
    const entries = await fs.readdir(directory, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }

      const filePath = path.join(directory, entry.name);
      const stat = await fs.stat(filePath);

      if (now - stat.mtimeMs > PIPELINE_STATUS_RETENTION_MS) {
        await fs.unlink(filePath);
      }
    }
  } catch {
    // ignore cleanup errors in bootstrap path
  }
}

function buildGraphInvalidationPlan(
  previousRun: PipelineRunResult | null,
  repository: PipelineRunResult["repository"],
  projectRootPath: string,
): GraphInvalidationPlan {
  const normalizedProjectRoot = normalizePath(projectRootPath);
  const changedPaths = repository.changedFiles
    .map((file) => normalizePath(file.path))
    .filter((filePath) => filePath.startsWith(normalizedProjectRoot) || !filePath.startsWith("/"));
  const invalidatedModules = Array.from(
    new Set(
      changedPaths.map((filePath) => {
        const parts = filePath.split("/").filter(Boolean);
        return parts[0] ?? "root";
      }),
    ),
  );
  const invalidatedSymbolIds = Array.from(
    new Set(
      (previousRun?.runtimeCache?.index.symbols ?? [])
        .filter((symbol) => changedPaths.includes(normalizePath(symbol.filePath)))
        .map((symbol) => symbol.stableSymbolId),
    ),
  );
  const previousRunPatch = previousRun ? { previousRunId: previousRun.runId } : {};

  if (!previousRun || repository.summary.changedFileCount === 0) {
    return {
      mode: "full-refresh",
      ...previousRunPatch,
      changedPaths,
      invalidatedFiles: changedPaths,
      invalidatedModules,
      invalidatedSymbolIds,
      reason: previousRun ? "Локальные Git-изменения не обнаружены, безопаснее удерживать full-refresh baseline." : "Предыдущий run отсутствует, partial invalidation ещё не на что опереть.",
    };
  }

  const previousGraph = previousRun.runtimeCache?.graph;
  return {
    mode: changedPaths.length > 0 && changedPaths.length <= 150 ? "partial-invalidation" : "full-refresh",
    ...previousRunPatch,
    changedPaths,
    invalidatedFiles: changedPaths,
    invalidatedModules,
    invalidatedSymbolIds,
    ...(previousGraph
      ? {
          reusedNodeCount: Math.max(
            0,
            previousGraph.nodes.filter((node) => !node.filePath || !changedPaths.includes(normalizePath(node.filePath))).length,
          ),
          reusedEdgeCount: Math.max(
            0,
            previousGraph.edges.filter((edge) => {
              const sourceNode = previousGraph.nodes.find((node) => node.id === edge.sourceId);
              const targetNode = previousGraph.nodes.find((node) => node.id === edge.targetId);
              const sourceChanged = sourceNode?.filePath ? changedPaths.includes(normalizePath(sourceNode.filePath)) : false;
              const targetChanged = targetNode?.filePath ? changedPaths.includes(normalizePath(targetNode.filePath)) : false;
              return !sourceChanged && !targetChanged;
            }).length,
          ),
        }
      : {}),
    reason:
      changedPaths.length > 0 && changedPaths.length <= 150
        ? "Graph invalidation ограничен Git changed set и может идти как partial refresh."
        : "Changed set слишком широк или пуст, поэтому используется full-refresh.",
  };
}

function buildIncrementalIndexPlan(
  previousRun: PipelineRunResult | null,
  repository: PipelineRunResult["repository"],
  selectiveCandidatePaths: string[],
  shouldUseSelectiveWorkspace: boolean,
): IncrementalIndexPlan {
  const reusedSignals: string[] = [];
  const changedPaths = Array.from(new Set(repository.changedFiles.map((file) => normalizePath(file.path))));
  const deletedPaths = Array.from(
    new Set(repository.changedFiles.filter((file) => file.changeType === "deleted").map((file) => normalizePath(file.path))),
  );
  const renamedPaths = Array.from(
    new Map(
      repository.changedFiles
        .filter((file) => file.changeType === "renamed" && file.previousPath)
        .map((file) => [
          `${file.previousPath}:${file.path}`,
          {
            from: normalizePath(file.previousPath ?? ""),
            to: normalizePath(file.path),
          },
        ]),
    ).values(),
  );
  const reusablePaths = previousRun?.runtimeCache?.index.files
    .map((file) => normalizePath(file.filePath))
    .filter((filePath) => !changedPaths.includes(filePath) && !deletedPaths.includes(filePath))
    .slice(0, 500) ?? [];

  if (previousRun) {
    reusedSignals.push(`previous-run:${previousRun.runId}`);
    reusedSignals.push(`previous-graph:${previousRun.graph.summary.nodeCount}-nodes`);
    reusedSignals.push(`previous-index:${previousRun.index.manifest.symbolCount}-symbols`);
  }

  if (repository.summary.changedFileCount > 0) {
    reusedSignals.push(`git-changed-set:${repository.summary.changedFileCount}`);
  }

  if (shouldUseSelectiveWorkspace) {
    reusedSignals.push(`selective-candidates:${selectiveCandidatePaths.length}`);
    return {
      mode: "incremental-index",
      ...(previousRun ? { previousRunId: previousRun.runId } : {}),
      candidatePaths: selectiveCandidatePaths,
      changedPaths,
      deletedPaths,
      renamedPaths,
      reusablePaths,
      reusedSignals,
      reason: "Large-repository run использует Git changed set и selective candidate paths как incremental seed.",
    };
  }

  return {
    mode: "full-index",
    ...(previousRun ? { previousRunId: previousRun.runId } : {}),
    candidatePaths: selectiveCandidatePaths,
    changedPaths,
    deletedPaths,
    renamedPaths,
    reusablePaths,
    reusedSignals,
    reason: previousRun
      ? "Сигналы предыдущего run известны, но текущий сценарий требует полный индекс вместо частичного прохода."
      : "Предыдущий run отсутствует, поэтому incremental reuse ещё не на что опереть.",
  };
}
