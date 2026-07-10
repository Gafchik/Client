import path from "node:path";
import { promises as fs } from "node:fs";
import { buildAnswerPackage, buildControlledExecutionRuntime } from "@client/ai";
import { buildContextPackage } from "@client/context";
import { buildGraph } from "@client/graph";
import { analyzeImpact } from "@client/impact-analysis";
import { runFullIndex } from "@client/indexer";
import { buildBackgroundProjectState, loadBestBaselineRunArtifact, loadLatestBackgroundRunCatalogEntry, saveKnowledgeArtifacts } from "@client/knowledge";
import { buildExecutionPlan, buildExecutionPreview } from "@client/planner";
import { deriveRepositoryScopedPaths, inspectRepository, shouldPreferSelectiveWorkspace } from "@client/repository-git";
import { runResearch } from "@client/research";
import {
  type IncrementalIndexPlan,
  normalizePath,
  stableId,
  tokenize,
  type GraphInvalidationPlan,
  type PipelinePartialArtifacts,
  type PipelineRunMode,
  type PipelineRunResult,
  type PipelineRunStatus,
  type PipelineStage,
} from "@client/shared";
import { openWorkspace, openWorkspaceSelective, scanWorkspaceOverview } from "@client/workspace";

export interface PipelineExecutionRequest {
  runId: string;
  mode: PipelineRunMode;
  task: string;
  projectPath: string;
  providerBaseUrl: string;
  providerModel: string;
  providerApiKey: string;
  appRootPath: string;
}

interface QuestionWorkspacePlan {
  paths: string[];
  mode: "baseline-graph-first" | "baseline-discovery-slice" | "repository-scoped" | "structural-fallback" | "empty";
  summary: string;
}

const runStore = new Map<string, PipelineRunStatus>();
const runAppRootStore = new Map<string, string>();
const PIPELINE_STATUS_RETENTION_MS = 1000 * 60 * 60 * 24 * 3;

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

export function enqueuePipelineRun(request: PipelineExecutionRequest): PipelineRunStatus {
  const createdAt = new Date().toISOString();
  const initialStatus: PipelineRunStatus = {
    runId: request.runId,
    mode: request.mode,
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
  setTimeout(() => {
    void executePipelineRun(request);
  }, 0);

  return initialStatus;
}

export function getPipelineRunStatus(runId: string): PipelineRunStatus | null {
  return runStore.get(runId) ?? null;
}

export function findActivePipelineRun(projectPath: string, mode: PipelineRunMode): PipelineRunStatus | null {
  const normalizedProjectPath = normalizePath(path.resolve(projectPath));
  const candidates = Array.from(runStore.values())
    .filter((status) =>
      status.projectPath === normalizedProjectPath
      && status.mode === mode
      && (status.status === "queued" || status.status === "running"),
    )
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

  return candidates[0] ?? null;
}

export function findPipelineRunByRepositoryState(input: {
  projectPath: string;
  mode: PipelineRunMode;
  stateFingerprint: string;
  statuses?: PipelineRunStatus["status"][];
}): PipelineRunStatus | null {
  const normalizedProjectPath = normalizePath(path.resolve(input.projectPath));
  const allowedStatuses = input.statuses ?? ["queued", "running", "completed"];
  const candidates = Array.from(runStore.values())
    .filter((status) =>
      status.projectPath === normalizedProjectPath
      && status.mode === input.mode
      && allowedStatuses.includes(status.status)
      && resolveRunStateFingerprint(status) === input.stateFingerprint,
    )
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

  return candidates[0] ?? null;
}

export function findPipelineRunByRepositoryHead(input: {
  projectPath: string;
  mode: PipelineRunMode;
  headFingerprint: string;
  statuses?: PipelineRunStatus["status"][];
}): PipelineRunStatus | null {
  const normalizedProjectPath = normalizePath(path.resolve(input.projectPath));
  const allowedStatuses = input.statuses ?? ["queued", "running", "completed"];
  const candidates = Array.from(runStore.values())
    .filter((status) =>
      status.projectPath === normalizedProjectPath
      && status.mode === input.mode
      && allowedStatuses.includes(status.status)
      && resolveRunHeadFingerprint(status) === input.headFingerprint,
    )
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

  return candidates[0] ?? null;
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
  await yieldToEventLoop();

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
  const { runId, mode, task, projectPath, providerBaseUrl, providerModel, providerApiKey, appRootPath } = request;
  const overview = await scanWorkspaceOverview(projectPath);
  const largeRepositoryProfile = overview.summary.profile === "large-repository";
  const isQuestionRun = mode === "question-run";
  const isHardResync = mode === "hard-resync";

  const workspaceStartedAt = startStage(runId, "workspace");
  const repositoryWorkspace = await openWorkspaceSelective(projectPath, {
    includePaths: [],
    maxFiles: 0,
  });
  const repositoryStartedAt = startStage(runId, "repository");
  const repository = await inspectRepository(repositoryWorkspace);
  completeStage(
    runId,
    "repository",
    repositoryStartedAt,
    repository.isGitRepository
      ? `Собран repository snapshot: ветка ${repository.branch || "unknown"}, изменений ${repository.summary.changedFileCount}.`
      : "Git-репозиторий не обнаружен, historical repository intelligence недоступен.",
  );
  await yieldToEventLoop();

  const projectRootPath = overview.rootPath;
  const projectId = overview.projectId;
  const baselineSelection = await loadBestBaselineRunArtifact(appRootPath, projectRootPath, repository);
  const previousRun = isHardResync ? null : baselineSelection.run;
  const latestBackgroundEntry = await loadLatestBackgroundRunCatalogEntry(appRootPath, projectRootPath);
  const backgroundState = buildBackgroundProjectState({
    projectId,
    projectRootPath,
    repository,
    latestRunId: latestBackgroundEntry?.runId ?? null,
    baselineRun: previousRun,
    baselineSource: baselineSelection.source,
  });
  await yieldToEventLoop();

  const baselineWorkspace = previousRun ? await openWorkspaceSelective(projectPath, {
    includePaths: [],
    maxFiles: 0,
  }) : null;
  const questionWorkspacePlan = buildQuestionWorkspacePlan(task, repository, baselineWorkspace ?? repositoryWorkspace, previousRun);
  const selectiveCandidatePaths = questionWorkspacePlan.paths;
  const shouldPreferSelectiveQuestionWorkspace =
    isQuestionRun && selectiveCandidatePaths.length > 0;
  const shouldUseSelectiveWorkspace =
    !isHardResync
    && (shouldPreferSelectiveWorkspace(repository, baselineWorkspace ?? repositoryWorkspace) || shouldPreferSelectiveQuestionWorkspace)
    && selectiveCandidatePaths.length > 0;
  const workspace = shouldUseSelectiveWorkspace
    ? await openWorkspaceSelective(projectPath, {
        includePaths: selectiveCandidatePaths,
        maxFiles: isQuestionRun
          ? questionWorkspacePlan.mode === "baseline-discovery-slice"
            ? 90
            : 120
          : 250,
      })
    : await openWorkspace(projectPath);

  completeStage(
    runId,
    "workspace",
    workspaceStartedAt,
    isQuestionRun && shouldUseSelectiveWorkspace
      ? `Открыт lightweight workspace overlay: ${workspace.summary.indexedFiles} файлов. ${questionWorkspacePlan.summary}`
      : isHardResync
        ? `Открыт полный workspace для операторского хард ресинка: ${workspace.summary.indexedFiles} индексируемых файлов без selective reuse.`
        : largeRepositoryProfile
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
    backgroundState,
  });
  await yieldToEventLoop();
  const incrementalIndex = buildIncrementalIndexPlan(previousRun, repository, selectiveCandidatePaths, shouldUseSelectiveWorkspace);
  const graphInvalidation = buildGraphInvalidationPlan(previousRun, repository, workspace.rootPath);
  updatePartialArtifacts(runId, {
    incrementalIndex,
    graphInvalidation,
  });
  await yieldToEventLoop();

  const canUseLightweightQuestionFlow =
    isQuestionRun
    && Boolean(previousRun?.runtimeCache?.index)
    && Boolean(previousRun?.runtimeCache?.graph)
    && backgroundState.freshness !== "missing";
  const indexStartedAt = startStage(runId, "index");
  const index = canUseLightweightQuestionFlow
    ? await runFullIndex(workspace, {
        previousRun,
        changedPaths: incrementalIndex.changedPaths,
        deletedPaths: incrementalIndex.deletedPaths,
      })
    : await runFullIndex(workspace, {
        previousRun,
        changedPaths: incrementalIndex.changedPaths,
        deletedPaths: incrementalIndex.deletedPaths,
      });
  completeStage(
    runId,
    "index",
    indexStartedAt,
    canUseLightweightQuestionFlow
      ? `Построен lightweight question index overlay: ${index.manifest.symbolCount} символов, reused files ${index.manifest.reusedFileCount}. Режим graph-first reuse активен.`
      : isHardResync
        ? `Построен полный index для хард ресинка: ${index.manifest.symbolCount} символов, ${index.manifest.relationCount} связей, reused files ${index.manifest.reusedFileCount}.`
      : largeRepositoryProfile && index.manifest.mode === "selective"
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
  await yieldToEventLoop();

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
  await yieldToEventLoop();

  const researchStartedAt = startStage(runId, "research");
  const research = runResearch({
    runId,
    task,
    workspace,
    index,
    graph,
    repository,
    backgroundState,
  });
  completeStage(
    runId,
    "research",
    researchStartedAt,
    `Подготовлено ${research.evidence.length} опорных ссылок с уверенностью ${research.confidence}%: baseline ${research.evidenceSummary.baselineCount}, overlay ${research.evidenceSummary.overlayCount}, structural ${research.evidenceSummary.structuralCount}.`,
  );
  updatePartialArtifacts(runId, {
    research,
  });
  await yieldToEventLoop();

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
  await yieldToEventLoop();

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
  await yieldToEventLoop();

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
  await yieldToEventLoop();

  const previewStartedAt = startStage(runId, "preview");
  const executionPreview = buildExecutionPreview(runId, plan);
  completeStage(runId, "preview", previewStartedAt, `Подготовлено безопасное превью выполнения с ${executionPreview.allowedActions.length} разрешёнными действиями.`);
  updatePartialArtifacts(runId, {
    executionPreview,
  });
  await yieldToEventLoop();

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
  await yieldToEventLoop();

  const answerStartedAt = startStage(runId, "answer");
  const answer = await buildAnswerPackage({
    runId,
    task,
    providerBaseUrl: isQuestionRun ? providerBaseUrl : "",
    providerModel: isQuestionRun ? providerModel : "",
    providerApiKey: isQuestionRun ? providerApiKey : "",
    research,
    impact,
    context,
    plan,
    preview: executionPreview,
    runtime: executionRuntime,
    backgroundState,
  });
  completeStage(runId, "answer", answerStartedAt, `Подготовлен финальный ответ: режим ${answer.answerMode}, confidence ${answer.confidence}%.`);
  updatePartialArtifacts(runId, {
    answer,
  });
  await yieldToEventLoop();

  const knowledgeStartedAt = startStage(runId, "knowledge");
  const knowledge = await saveKnowledgeArtifacts({
    runId,
    mode,
    task,
    appRootPath,
    workspace,
    repository,
    backgroundState,
    provider: {
      baseUrl: isQuestionRun ? providerBaseUrl : "",
      model: isQuestionRun ? providerModel : "",
      apiKeyMasked: isQuestionRun ? maskApiKey(providerApiKey) : "",
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
    mode,
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
      baseUrl: isQuestionRun ? providerBaseUrl : "",
      model: isQuestionRun ? providerModel : "",
      apiKeyMasked: isQuestionRun ? maskApiKey(providerApiKey) : "",
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
    backgroundState,
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

function resolveRunStateFingerprint(status: PipelineRunStatus): string | null {
  return (
    status.result?.repository.stateFingerprint
    ?? status.partialArtifacts?.backgroundState?.stateFingerprint
    ?? status.partialArtifacts?.repository?.stateFingerprint
    ?? null
  );
}

function resolveRunHeadFingerprint(status: PipelineRunStatus): string | null {
  return (
    status.result?.repository.headFingerprint
    ?? status.partialArtifacts?.backgroundState?.headFingerprint
    ?? status.partialArtifacts?.repository?.headFingerprint
    ?? null
  );
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

function buildQuestionWorkspacePlan(
  task: string,
  repository: PipelineRunResult["repository"],
  workspace: Awaited<ReturnType<typeof openWorkspace>>,
  previousRun?: PipelineRunResult | null,
): QuestionWorkspacePlan {
  const previousIndex = previousRun?.runtimeCache?.index;
  const availableRelativePaths = Array.from(
    new Set([
      ...workspace.files.map((file) => file.relativePath),
      ...(previousIndex?.files.map((file) => normalizePath(file.filePath)) ?? []),
    ]),
  );
  const gitScopedPaths = deriveRepositoryScopedPaths(repository, workspace);
  const normalizedTask = task.toLowerCase();
  const billingRollbackFocus =
    normalizedTask.includes("rollback")
    || normalizedTask.includes("ролбек")
    || normalizedTask.includes("generated")
    || normalizedTask.includes("дженер")
    || normalizedTask.includes("billhistory")
    || normalizedTask.includes("истори");
  const taskTokens = Array.from(
    new Set([
      ...tokenize(task),
      ...task
        .split(/[^A-Za-z0-9_/-]+/)
        .filter(Boolean)
        .flatMap((token) =>
          token
            .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
            .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
            .split(/[^A-Za-z0-9а-яё]+/i)
            .map((part) => part.trim().toLowerCase())
            .filter((part) => part.length >= 2),
        ),
    ]),
  ).filter((token) => token.length >= 3);
  const previousGraph = previousRun?.runtimeCache?.graph;
  const tokenMatchedPaths = availableRelativePaths
    .filter((relativePath) => {
      const lowerPath = relativePath.toLowerCase();
      return taskTokens.some((token) => lowerPath.includes(token));
    });
  const previousIndexPaths = previousIndex?.files
    .map((file) => normalizePath(file.filePath))
    .filter((relativePath) => {
      const lowerPath = relativePath.toLowerCase();
      return taskTokens.some((token) => lowerPath.includes(token));
    }) ?? [];
  const previousSymbolMatchedPaths = previousIndex?.symbols
    .filter((symbol) => {
      const label = `${symbol.containerName ? `${symbol.containerName}.` : ""}${symbol.name}`.toLowerCase();
      const filePath = normalizePath(symbol.filePath).toLowerCase();
      return taskTokens.some((token) => label.includes(token) || filePath.includes(token));
    })
    .map((symbol) => normalizePath(symbol.filePath)) ?? [];
  const graphMatchedPaths = previousGraph?.nodes
    .map((node) => ({
      filePath: normalizePath(node.filePath ?? ""),
      label: node.label.toLowerCase(),
    }))
    .filter((item) =>
      item.filePath
      && taskTokens.some((token) => item.filePath.includes(token) || item.label.includes(token)),
    )
    .map((item) => item.filePath) ?? [];
  const graphNeighborPaths = previousGraph
    ? Array.from(
        new Set(
          previousGraph.edges.flatMap((edge) => {
            const source = previousGraph.nodes.find((node) => node.id === edge.sourceId);
            const target = previousGraph.nodes.find((node) => node.id === edge.targetId);
            const sourcePath = normalizePath(source?.filePath ?? "");
            const targetPath = normalizePath(target?.filePath ?? "");
            const sourceMatched = sourcePath && graphMatchedPaths.includes(sourcePath);
            const targetMatched = targetPath && graphMatchedPaths.includes(targetPath);

            if (!sourceMatched && !targetMatched) {
              return [];
            }

            return [sourcePath, targetPath].filter(Boolean);
          }),
        ),
      )
    : [];
  const baselineDiscoveryPaths = previousIndex?.files
    .map((file) => normalizePath(file.filePath))
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
        || lowerPath.includes("/middlewares/")
      );
    })
    .slice(0, 90) ?? [];
  const hasStrongGraphSeed = graphMatchedPaths.length >= 3 || graphNeighborPaths.length >= 6;
  const hasRepositoryScopedSeed = gitScopedPaths.length >= 2;
  const shouldUseStructuralFallback = !hasStrongGraphSeed && !hasRepositoryScopedSeed;
  const fallbackStructuralPaths = shouldUseStructuralFallback
    ? availableRelativePaths
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
            || lowerPath.includes("/middlewares/")
          );
        })
        .slice(0, 120)
    : [];
  const billingRollbackPaths = billingRollbackFocus
    ? availableRelativePaths
        .filter((relativePath) => {
          const lowerPath = relativePath.toLowerCase();
          return (
            lowerPath.includes("/containers/billing/bill/ui/api/routes/routeprovider.php")
            || lowerPath.includes("/containers/billing/bill/ui/api/controllers/billcontroller.php")
            || lowerPath.includes("/containers/billing/bill/actions/togeneratedbillaction.php")
            || lowerPath.includes("/containers/billing/bill/actions/todraftbillaction.php")
            || lowerPath.includes("/containers/billing/bill/models/bill.php")
            || lowerPath.includes("/ship/parents/models/billmodel.php")
            || lowerPath.includes("/containers/billing/billhistory/")
            || lowerPath.includes("/containers/billing/bill/support/billhistorydocumentsyncresolver.php")
            || lowerPath.includes("/containers/billing/billhistory/actions/createbillhistoryaction.php")
          );
        })
        .slice(0, 40)
    : [];
  const localizationRuntimeFocus =
    normalizedTask.includes("locale")
    || normalizedTask.includes("localization")
    || normalizedTask.includes("локал")
    || normalizedTask.includes("язык")
    || normalizedTask.includes("header")
    || normalizedTask.includes("заголов")
    || normalizedTask.includes("middleware");
  const localizationRuntimePaths = localizationRuntimeFocus
    ? availableRelativePaths
        .filter((relativePath) => {
          const lowerPath = relativePath.toLowerCase();
          return (
            lowerPath.includes("/middleware/localemiddleware.php")
            || lowerPath.endsWith("/bootstrap/app.php")
            || lowerPath.includes("/enums/localeenum.php")
            || lowerPath.endsWith("/config/app.php")
          );
        })
        .slice(0, 20)
    : [];

  const primaryPaths = Array.from(
    new Set([
      ...localizationRuntimePaths,
      ...billingRollbackPaths,
      ...gitScopedPaths,
      ...previousSymbolMatchedPaths,
      ...graphMatchedPaths,
      ...graphNeighborPaths,
      ...tokenMatchedPaths,
      ...previousIndexPaths,
    ]),
  ).slice(0, 250);

  if (primaryPaths.length > 0) {
    const mode = hasStrongGraphSeed
      ? "baseline-graph-first"
      : hasRepositoryScopedSeed
        ? "repository-scoped"
        : "structural-fallback";

    return {
      paths: primaryPaths,
      mode,
      summary:
        mode === "baseline-graph-first"
          ? "Question-run стартовал от baseline graph/index cache и открыл только task-relevant, graph-neighbor и overlay-пути."
          : mode === "repository-scoped"
            ? "Question-run использовал Git changed set и baseline cache как основной seed вместо широкого сканирования."
            : "Question-run нашёл ограниченный набор task-specific путей и избежал полного сканирования.",
    };
  }

  if (baselineDiscoveryPaths.length > 0) {
    return {
      paths: baselineDiscoveryPaths,
      mode: "baseline-discovery-slice",
      summary: "Прямой graph/task seed оказался слабым, поэтому открыт небольшой baseline discovery slice из routes/config/controllers/services/models вместо полного сканирования проекта.",
    };
  }

  if (fallbackStructuralPaths.length > 0) {
    return {
      paths: Array.from(new Set(fallbackStructuralPaths)).slice(0, 120),
      mode: "structural-fallback",
      summary: "Baseline cache недоступен или слишком слаб, поэтому выполнен ограниченный structural fallback slice.",
    };
  }

  return {
    paths: [],
    mode: "empty",
    summary: "Question-run не смог безопасно построить selective slice и будет вынужден открыть полный workspace.",
  };
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
