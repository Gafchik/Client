import path from "node:path";
import { promises as fs } from "node:fs";
import {
  buildAnswerPackage,
  buildControlledExecutionRuntime,
  buildValidatedAnswerPacket,
  buildValidationPacket,
  expandTaskSearchKeywords,
  validateEvidence,
} from "@client/ai";
import { buildContextPackage } from "@client/context";
import { buildGraph } from "@client/graph";
import { analyzeImpact } from "@client/impact-analysis";
import { runFullIndex } from "@client/indexer";
import { buildBackgroundProjectState, loadBestBaselineRunArtifact, loadLatestBackgroundRunCatalogEntry, promoteFactsFromResearch, queryRelevantFacts, saveKnowledgeArtifacts } from "@client/knowledge";
import { buildExecutionPlan, buildExecutionPreview } from "@client/planner";
import { deriveRepositoryScopedPaths, inspectRepository, shouldPreferSelectiveWorkspace } from "@client/repository-git";
import { runResearch } from "@client/research";
import {
  type IncrementalIndexPlan,
  type IndexResult,
  type FocusedResearchRequest,
  type FocusedResearchResult,
  type GraphState,
  normalizePath,
  stableId,
  tokenize,
  expandRussianTechTransliteration,
  type GraphInvalidationPlan,
  type PipelinePartialArtifacts,
  type PipelineRunMode,
  type PipelineRunResult,
  type PipelineRunStatus,
  type PipelineStage,
  type ValidationRecommendedAction,
  type ValidationRecommendedResearchProfile,
  type ValidationResult,
} from "@client/shared";
import { openWorkspace, openWorkspaceSelective, scanWorkspaceOverview } from "@client/workspace";
import { saveGraphSnapshot } from "./graph-store.js";

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
const MAX_VALIDATION_REFINEMENT_ITERATIONS = 2;

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

function markStatusInterrupted(status: PipelineRunStatus, reason: string, stageDetails: string): PipelineRunStatus {
  return {
    ...status,
    status: "failed",
    updatedAt: new Date().toISOString(),
    errorMessage: reason,
    stages: status.stages.map((stage) =>
      stage.status === "running"
        ? {
            ...stage,
            status: "failed",
            completedAt: new Date().toISOString(),
            details: stageDetails,
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
  };
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
        updateRunStatus(
          runId,
          markStatusInterrupted(
            status,
            "API был перезапущен во время выполнения. Run можно безопасно перезапустить с начала.",
            "Run был прерван перезапуском API. Доступен resume-from-start.",
          ),
        );
      }
    }
  } catch {
    // ignore missing status directory during bootstrap
  }
}

// Вызывается из обработчика SIGINT/SIGTERM (см. server.ts) до попытки
// закрыть процесс. Синхронное завершение долгого research/graph/index на
// большом репозитории не прерывается сигналом мгновенно (см. server.ts про
// hard-timeout), поэтому здесь мы честно помечаем то, что уже отслеживается
// в памяти этого процесса, как прерванное — чтобы UI не показывал "running"
// для run'а, чей процесс на самом деле уже умер, до следующего bootstrap.
export async function markInFlightRunsInterrupted(): Promise<void> {
  const pending: Promise<void>[] = [];

  for (const [runId, status] of runStore.entries()) {
    if (status.status !== "queued" && status.status !== "running") {
      continue;
    }

    const appRootPath = runAppRootStore.get(runId);
    const interrupted = markStatusInterrupted(
      status,
      "Сервер был остановлен во время выполнения. Run можно безопасно перезапустить с начала.",
      "Run был прерван остановкой сервера. Доступен resume-from-start.",
    );
    runStore.set(runId, interrupted);

    if (appRootPath) {
      pending.push(persistRunStatus(appRootPath, interrupted));
    }
  }

  await Promise.allSettled(pending);
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
  void persistGraphSnapshotSafely(graph);
  await yieldToEventLoop();

  const researchStartedAt = startStage(runId, "research");
  const knownFacts = await queryRelevantFacts(projectRootPath, index, repository);
  const researchInputForRun = {
    runId,
    task,
    workspace,
    index,
    graph,
    repository,
    backgroundState,
    knownFacts,
  };
  const primaryResearch = runResearch(researchInputForRun);
  const keywordExpansion = await maybeExpandResearchWithTranslatedKeywords(researchInputForRun, primaryResearch, {
    isQuestionRun,
    providerBaseUrl,
    providerModel,
    providerApiKey,
  });
  const initialResearch = keywordExpansion.research;
  completeStage(
    runId,
    "research",
    researchStartedAt,
    `Подготовлено ${initialResearch.evidence.length} опорных ссылок с уверенностью ${initialResearch.confidence}%: baseline ${initialResearch.evidenceSummary.baselineCount}, overlay ${initialResearch.evidenceSummary.overlayCount}, structural ${initialResearch.evidenceSummary.structuralCount}, recalled ${initialResearch.evidenceSummary.recalledCount}.${
      keywordExpansion.keywords.length > 0
        ? ` Дополнительно запрошены англоязычные ключевые слова через LLM: ${keywordExpansion.keywords.join(", ")}.`
        : ""
    }`,
  );
  updatePartialArtifacts(runId, {
    research: initialResearch,
  });
  // fire-and-forget: Fact Store — вспомогательная память, не должна ни
  // блокировать ответ пользователю, ни ронять run при сбое Postgres.
  void promoteFactsFromResearch(projectRootPath, initialResearch, repository, index);
  await yieldToEventLoop();

  const impactStartedAt = startStage(runId, "impact");
  const initialImpact = analyzeImpact({
    runId,
    graph,
    research: initialResearch,
  });
  completeStage(runId, "impact", impactStartedAt, `Определено ${initialImpact.affectedFiles.length} затронутых файлов и ${initialImpact.risks.length} рисков.`);
  updatePartialArtifacts(runId, {
    impact: initialImpact,
  });
  await yieldToEventLoop();

  const contextStartedAt = startStage(runId, "context");
  const initialContext = buildContextPackage({
    runId,
    task,
    workspace,
    index,
    graph,
    research: initialResearch,
    impact: initialImpact,
  });
  completeStage(runId, "context", contextStartedAt, `Собран контекстный пакет: ${initialContext.selectedChunks.length} фрагментов при бюджете ${initialContext.tokenBudget}.`);
  updatePartialArtifacts(runId, {
    context: initialContext,
  });
  await yieldToEventLoop();

  const validationLoop = await runValidationLoop({
    runId,
    task,
    projectPath,
    providerBaseUrl: isQuestionRun ? providerBaseUrl : "",
    providerModel: isQuestionRun ? providerModel : "",
    providerApiKey: isQuestionRun ? providerApiKey : "",
    workspace,
    index,
    graph,
    repository,
    backgroundState,
    research: initialResearch,
    impact: initialImpact,
    context: initialContext,
    previousRun,
    diagnostics: [
      ...workspace.diagnostics,
      ...index.diagnostics,
      ...repository.diagnostics,
      ...backgroundState.diagnostics,
    ],
  });
  updatePartialArtifacts(runId, {
    research: validationLoop.research,
    impact: validationLoop.impact,
    context: validationLoop.context,
    validation: validationLoop.validation,
    validationHistory: validationLoop.validationHistory,
    validationPacket: validationLoop.validationPacket,
    focusedResearchRequests: validationLoop.focusedResearchRequests,
    focusedResearchResults: validationLoop.focusedResearchResults,
    validatedAnswerPacket: validationLoop.validatedAnswerPacket,
  });
  await yieldToEventLoop();

  const research = validationLoop.research;
  const impact = validationLoop.impact;
  const context = validationLoop.context;
  const validation = validationLoop.validation;
  const validationHistory = validationLoop.validationHistory;
  const validationPacket = validationLoop.validationPacket;
  const focusedResearchRequests = validationLoop.focusedResearchRequests;
  const focusedResearchResults = validationLoop.focusedResearchResults;
  const validatedAnswerPacket = validationLoop.validatedAnswerPacket;

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
    validation,
    validatedAnswerPacket,
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
    validation,
    validationHistory,
    validationPacket,
    focusedResearchRequests,
    focusedResearchResults,
    validatedAnswerPacket,
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
    ...(validation ? { validation } : {}),
    ...(validationHistory.length > 0 ? { validationHistory } : {}),
    ...(validationPacket ? { validationPacket } : {}),
    ...(focusedResearchRequests.length > 0 ? { focusedResearchRequests } : {}),
    ...(focusedResearchResults.length > 0 ? { focusedResearchResults } : {}),
    ...(validatedAnswerPacket ? { validatedAnswerPacket } : {}),
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

// Составные PascalCase-имена ("DataEntry") дают фрагменты ("data", "entry")
// при камелкейс-разбиении для ловли snake_case/kebab-case вариантов файлов.
// Но по одному короткому фрагменту нельзя матчить — "data" встречается в
// пути практически любого Laravel-контейнера (Containers/*/Data/...), и
// такой фрагмент топит реальное совпадение шумом из сотен чужих файлов.
// Поэтому фрагменты одного составного слова требуют совпадения ВСЕ сразу
// (as-typed токены вроде "dataentry" остаются одиночной группой и матчатся
// как раньше — по одному substring). Используется и для текста задачи, и
// для свободных entity-hints от валидатора (см. deriveFocusedResearchPaths).
function buildCompoundTokenGroups(text: string): string[][] {
  // expandRussianTechTransliteration добавляет латинские формы для русских
  // фонетических транслитераций ("алиас" -> ещё и "alias") — без этого
  // русскоязычный вопрос про сущность с англоязычным именем в коде в
  // принципе не может её найти: буквы разные, substring не совпадёт никогда.
  const standaloneTokens = expandRussianTechTransliteration(
    tokenize(text).filter((token) => token.length >= 3),
  );
  const compoundGroups = text
    .split(/[^A-Za-z0-9_/-]+/)
    .filter(Boolean)
    .map((rawToken) =>
      rawToken
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
        .split(/[^A-Za-z0-9а-яё]+/i)
        .map((part) => part.trim().toLowerCase())
        .filter((part) => part.length >= 2),
    )
    .filter((group) => group.length > 1);

  return [...standaloneTokens.map((token) => [token]), ...compoundGroups];
}

function matchesCompoundTokenGroups(text: string, groups: string[][]): boolean {
  return groups.some((group) => group.every((token) => text.includes(token)));
}

function isStructuralHeuristicPath(relativePath: string): boolean {
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
    // Actions — общий DDD/Apiato-паттерн (не завязан на один проект): много
    // бизнес-логики живёт именно тут, а не в controllers/services.
    || lowerPath.includes("/actions/")
  );
}

// Раньше это был обычный `.slice(0, N)` по списку путей — на маленьком
// репозитории безобидно, но на большом (магенда: 144 контейнера) это значит
// "взять первые N файлов в порядке индексации" — то есть только несколько
// первых по алфавиту директорий, а все остальные ни разу не попадают в
// scan. Живой баг: вопрос "что такое транспортировка пациента" получил
// уверенный ответ "такой сущности нет", хотя Transportation.php реально
// существует — просто его директория (132-я из 144 по алфавиту) была
// далеко за пределами среза budget=90. Вместо среза с начала — берём
// директории равномерно по всему диапазону (или round-robin вглубь, если
// бюджета хватает на все директории), чтобы budget покрывал весь репозиторий,
// а не только начало алфавита.
function distributeAcrossDirectories(paths: string[], limit: number): string[] {
  const byDirectory = new Map<string, string[]>();

  for (const relativePath of paths) {
    const directory = relativePath.split("/").slice(0, -1).join("/");
    const bucket = byDirectory.get(directory);

    if (bucket) {
      bucket.push(relativePath);
    } else {
      byDirectory.set(directory, [relativePath]);
    }
  }

  const groups = Array.from(byDirectory.values());

  if (groups.length === 0) {
    return [];
  }

  if (groups.length <= limit) {
    const result: string[] = [];
    let depth = 0;

    while (result.length < limit) {
      let addedAny = false;

      for (const group of groups) {
        if (depth < group.length && result.length < limit) {
          result.push(group[depth] as string);
          addedAny = true;
        }
      }

      if (!addedAny) {
        break;
      }

      depth += 1;
    }

    return result;
  }

  const step = groups.length / limit;
  const result: string[] = [];

  for (let i = 0; i < limit; i += 1) {
    const group = groups[Math.floor(i * step)];

    if (group && group.length > 0) {
      result.push(group[0] as string);
    }
  }

  return result;
}

// Fallback для "слепой зоны перевода": детерминированный поиск (packages/
// research) — substring/prefix/suffix по токенам, плюс словарь фонетических
// заимствований техжаргона (роут->route). Он не может связать обычное
// русское слово с английским именем класса/директории в коде — живой баг:
// "транспортировка пациента" не совпала ни с одним токеном, хотя
// Transportation.php реально существует в проекте. Гоняется НЕ на каждый
// вопрос — только когда первый детерминированный проход уже слабый
// (broad-unknown/dominantModule не определён), чтобы не платить лишний
// LLM-вызов на вопросах, которые и так работают. Если перезапуск с
// добавленными LLM-словами не улучшил результат — тихо остаёмся на
// исходном research, ничего не теряем.
async function maybeExpandResearchWithTranslatedKeywords(
  researchInput: Parameters<typeof runResearch>[0],
  research: ReturnType<typeof runResearch>,
  options: {
    isQuestionRun: boolean;
    providerBaseUrl: string;
    providerModel: string;
    providerApiKey: string;
  },
): Promise<{ research: ReturnType<typeof runResearch>; keywords: string[] }> {
  const looksWeak = research.intentClass === "broad-unknown" || research.dominantModule === "не определён";
  const hasCyrillic = /[а-яё]/i.test(researchInput.task);
  const canUseProvider =
    options.isQuestionRun
    && options.providerBaseUrl.trim().length > 0
    && options.providerModel.trim().length > 0
    && options.providerApiKey.trim().length > 0;

  if (!looksWeak || !hasCyrillic || !canUseProvider) {
    return { research, keywords: [] };
  }

  const keywords = await expandTaskSearchKeywords({
    task: researchInput.task,
    providerBaseUrl: options.providerBaseUrl,
    providerModel: options.providerModel,
    providerApiKey: options.providerApiKey,
  });

  if (keywords.length === 0) {
    return { research, keywords: [] };
  }

  // `evidence` всегда обрезается до `selectTopEvidence(..., limit = 12)` —
  // на широком/структурном фолбэке кандидатов и так с избытком, поэтому
  // "evidence.length увеличился" почти никогда не сработает как сигнал
  // улучшения (оба прохода упираются в один и тот же потолок). Раз мы уже
  // попали сюда только потому, что исходный research слабый (`looksWeak`),
  // расширенный research — тот же вопрос плюс доп. слова — не может быть
  // содержательно хуже, поэтому просто используем его.
  const augmentedResearch = runResearch({
    ...researchInput,
    task: `${researchInput.task}\n\n(possible English keywords: ${keywords.join(", ")})`,
  });

  return { research: augmentedResearch, keywords };
}

function buildQuestionWorkspacePlan(
  task: string,
  repository: PipelineRunResult["repository"],
  workspace: Awaited<ReturnType<typeof openWorkspace>>,
  previousRun?: PipelineRunResult | null,
): QuestionWorkspacePlan {
  const MAX_PRIMARY_PATHS = 250;
  const DIRECT_MATCH_MIN_BUDGET = 40;
  const DIRECT_MATCH_TARGET_BUDGET = 100;
  const GRAPH_NEIGHBOR_MAX_BUDGET = 80;
  const previousIndex = previousRun?.runtimeCache?.index;
  const availableRelativePaths = Array.from(
    new Set([
      ...workspace.files.map((file) => file.relativePath),
      ...(previousIndex?.files.map((file) => normalizePath(file.filePath)) ?? []),
    ]),
  );
  const gitScopedPaths = deriveRepositoryScopedPaths(repository, workspace);
  const taskTokenGroups = buildCompoundTokenGroups(task);
  const matchesTaskTokens = (text: string): boolean => matchesCompoundTokenGroups(text, taskTokenGroups);
  const previousGraph = previousRun?.runtimeCache?.graph;
  const tokenMatchedPaths = availableRelativePaths
    .filter((relativePath) => matchesTaskTokens(relativePath.toLowerCase()));
  const previousIndexPaths = previousIndex?.files
    .map((file) => normalizePath(file.filePath))
    .filter((relativePath) => matchesTaskTokens(relativePath.toLowerCase())) ?? [];
  const previousSymbolMatchedPaths = previousIndex?.symbols
    .filter((symbol) => {
      const label = `${symbol.containerName ? `${symbol.containerName}.` : ""}${symbol.name}`.toLowerCase();
      const filePath = normalizePath(symbol.filePath).toLowerCase();
      return matchesTaskTokens(label) || matchesTaskTokens(filePath);
    })
    .map((symbol) => normalizePath(symbol.filePath)) ?? [];
  const graphMatchedPaths = previousGraph?.nodes
    .map((node) => ({
      filePath: normalizePath(node.filePath ?? ""),
      label: node.label.toLowerCase(),
    }))
    .filter((item) =>
      item.filePath
      && (matchesTaskTokens(item.filePath) || matchesTaskTokens(item.label)),
    )
    .map((item) => item.filePath) ?? [];
  const directMatchPaths = Array.from(
    new Set([
      ...previousSymbolMatchedPaths,
      ...graphMatchedPaths,
      ...tokenMatchedPaths,
      ...previousIndexPaths,
    ]),
  );
  const graphNeighborPaths = previousGraph
    ? Array.from(
        new Set(
          previousGraph.edges.flatMap((edge) => {
            const source = previousGraph.nodes.find((node) => node.id === edge.sourceId);
            const target = previousGraph.nodes.find((node) => node.id === edge.targetId);
            const sourcePath = normalizePath(source?.filePath ?? "");
            const targetPath = normalizePath(target?.filePath ?? "");
            const sourceMatched = sourcePath && directMatchPaths.includes(sourcePath);
            const targetMatched = targetPath && directMatchPaths.includes(targetPath);

            if (!sourceMatched && !targetMatched) {
              return [];
            }

            return [sourcePath, targetPath].filter(Boolean);
          }),
        ),
      )
    : [];
  const baselineDiscoveryPaths = distributeAcrossDirectories(
    previousIndex?.files.map((file) => normalizePath(file.filePath)).filter(isStructuralHeuristicPath) ?? [],
    90,
  );
  const hasStrongGraphSeed = graphMatchedPaths.length >= 3 || graphNeighborPaths.length >= 6;
  const hasRepositoryScopedSeed = gitScopedPaths.length >= 2;
  const shouldUseStructuralFallback = !hasStrongGraphSeed && !hasRepositoryScopedSeed;
  const fallbackStructuralPaths = shouldUseStructuralFallback
    ? distributeAcrossDirectories(availableRelativePaths.filter(isStructuralHeuristicPath), 120)
    : [];
  const directMatchPathSet = new Set(directMatchPaths);
  const graphNeighborOnlyPaths = graphNeighborPaths.filter((relativePath) => !directMatchPathSet.has(relativePath));
  const primaryPaths: string[] = [];
  const pushPathsWithBudget = (paths: string[], budget: number): void => {
    for (const relativePath of paths) {
      if (primaryPaths.length >= MAX_PRIMARY_PATHS) {
        return;
      }

      if (budget <= 0) {
        return;
      }

      if (primaryPaths.includes(relativePath)) {
        continue;
      }

      primaryPaths.push(relativePath);
      budget -= 1;
    }
  };

  pushPathsWithBudget(gitScopedPaths, MAX_PRIMARY_PATHS);

  const guaranteedDirectBudget = Math.min(
    Math.max(DIRECT_MATCH_MIN_BUDGET, directMatchPaths.length),
    MAX_PRIMARY_PATHS - primaryPaths.length,
  );
  pushPathsWithBudget(directMatchPaths, guaranteedDirectBudget);

  const remainingAfterGuaranteedDirect = Math.max(MAX_PRIMARY_PATHS - primaryPaths.length, 0);
  const preferredAdditionalDirectBudget = Math.min(
    Math.max(DIRECT_MATCH_TARGET_BUDGET - guaranteedDirectBudget, 0),
    remainingAfterGuaranteedDirect,
  );
  pushPathsWithBudget(directMatchPaths, preferredAdditionalDirectBudget);

  const remainingAfterDirect = Math.max(MAX_PRIMARY_PATHS - primaryPaths.length, 0);
  const graphNeighborBudget = directMatchPaths.length > 0
    ? Math.min(GRAPH_NEIGHBOR_MAX_BUDGET, remainingAfterDirect)
    : remainingAfterDirect;
  pushPathsWithBudget(graphNeighborOnlyPaths, graphNeighborBudget);

  const remainingBudget = Math.max(MAX_PRIMARY_PATHS - primaryPaths.length, 0);
  if (remainingBudget > 0) {
    pushPathsWithBudget(directMatchPaths, remainingBudget);
    pushPathsWithBudget(graphNeighborOnlyPaths, Math.max(MAX_PRIMARY_PATHS - primaryPaths.length, 0));
  }

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

async function runValidationLoop(input: {
  runId: string;
  task: string;
  projectPath: string;
  providerBaseUrl: string;
  providerModel: string;
  providerApiKey: string;
  workspace: Awaited<ReturnType<typeof openWorkspace>>;
  index: IndexResult;
  graph: GraphState;
  repository: PipelineRunResult["repository"];
  backgroundState: NonNullable<PipelineRunResult["backgroundState"]>;
  research: PipelineRunResult["research"];
  impact: PipelineRunResult["impact"];
  context: PipelineRunResult["context"];
  previousRun: PipelineRunResult | null;
  diagnostics: string[];
}): Promise<{
  research: PipelineRunResult["research"];
  impact: PipelineRunResult["impact"];
  context: PipelineRunResult["context"];
  validation: ValidationResult;
  validationHistory: ValidationResult[];
  validationPacket: ReturnType<typeof buildValidationPacket>;
  focusedResearchRequests: FocusedResearchRequest[];
  focusedResearchResults: FocusedResearchResult[];
  validatedAnswerPacket: ReturnType<typeof buildValidatedAnswerPacket>;
}> {
  let currentResearch = input.research;
  let currentImpact = input.impact;
  let currentContext = input.context;
  const validationHistory: ValidationResult[] = [];
  const focusedResearchRequests: FocusedResearchRequest[] = [];
  const focusedResearchResults: FocusedResearchResult[] = [];
  const priorActions: ValidationRecommendedAction[] = [];
  let currentPacket = buildValidationPacket({
    runId: input.runId,
    task: input.task,
    research: currentResearch,
    impact: currentImpact,
    context: currentContext,
    graph: input.graph,
    diagnostics: input.diagnostics,
    backgroundState: input.backgroundState,
    iteration: 0,
    priorActions,
    remainingIterationBudget: MAX_VALIDATION_REFINEMENT_ITERATIONS,
  });
  let currentValidation = await validateEvidence({
    packet: currentPacket,
    providerBaseUrl: input.providerBaseUrl,
    providerModel: input.providerModel,
    providerApiKey: input.providerApiKey,
  });
  validationHistory.push(currentValidation);

  for (let iteration = 1; iteration <= MAX_VALIDATION_REFINEMENT_ITERATIONS; iteration += 1) {
    if (currentValidation.status !== "needs-focused-research") {
      break;
    }

    const request = buildFocusedResearchRequest({
      runId: input.runId,
      iteration,
      task: input.task,
      projectPath: input.projectPath,
      validation: currentValidation,
      workspace: input.workspace,
      repository: input.repository,
      currentResearch,
      currentContext,
      previousRun: input.previousRun,
    });
    focusedResearchRequests.push(request);
    priorActions.push(...request.actions);

    const refinement = await runFocusedResearch({
      runId: input.runId,
      task: input.task,
      workspace: input.workspace,
      index: input.index,
      graph: input.graph,
      repository: input.repository,
      backgroundState: input.backgroundState,
      currentResearch,
      request,
    });
    focusedResearchResults.push(refinement);

    currentResearch = mergeResearchWithFocusedResult(currentResearch, refinement);
    currentImpact = analyzeImpact({
      runId: input.runId,
      graph: input.graph,
      research: currentResearch,
    });
    currentContext = buildContextPackage({
      runId: input.runId,
      task: input.task,
      workspace: input.workspace,
      index: input.index,
      graph: input.graph,
      research: currentResearch,
      impact: currentImpact,
    });
    currentPacket = buildValidationPacket({
      runId: input.runId,
      task: input.task,
      research: currentResearch,
      impact: currentImpact,
      context: currentContext,
      graph: input.graph,
      diagnostics: [...input.diagnostics, ...refinement.diagnostics],
      backgroundState: input.backgroundState,
      iteration,
      priorActions,
      remainingIterationBudget: Math.max(0, MAX_VALIDATION_REFINEMENT_ITERATIONS - iteration),
    });
    currentValidation = await validateEvidence({
      packet: currentPacket,
      providerBaseUrl: input.providerBaseUrl,
      providerModel: input.providerModel,
      providerApiKey: input.providerApiKey,
    });
    validationHistory.push(currentValidation);

    if (refinement.additionalEvidence.length === 0 && currentValidation.status === "needs-focused-research") {
      currentValidation = {
        ...currentValidation,
        status: currentValidation.directAnswerFeasibility === "partial" ? "partial-answer-allowed" : "insufficient-evidence",
        recommendedStopReason: "Focused research не дал существенного прироста evidence.",
      };
      validationHistory[validationHistory.length - 1] = currentValidation;
      break;
    }
  }

  const validatedAnswerPacket = buildValidatedAnswerPacket({
    runId: input.runId,
    questionType: currentPacket.questionType,
    validation: currentValidation,
    research: currentResearch,
  });

  return {
    research: currentResearch,
    impact: currentImpact,
    context: currentContext,
    validation: currentValidation,
    validationHistory,
    validationPacket: currentPacket,
    focusedResearchRequests,
    focusedResearchResults,
    validatedAnswerPacket,
  };
}

function buildFocusedResearchRequest(input: {
  runId: string;
  iteration: number;
  task: string;
  projectPath: string;
  validation: ValidationResult;
  workspace: Awaited<ReturnType<typeof openWorkspace>>;
  repository: PipelineRunResult["repository"];
  currentResearch: PipelineRunResult["research"];
  currentContext: PipelineRunResult["context"];
  previousRun: PipelineRunResult | null;
}): FocusedResearchRequest {
  const entityHints = input.validation.missingEntityHints ?? [];
  const focusPaths = deriveFocusedResearchPaths({
    workspace: input.workspace,
    repository: input.repository,
    actions: input.validation.recommendedActions,
    entityHints,
    task: input.task,
    research: input.currentResearch,
    previousRun: input.previousRun,
  });
  const profile = input.validation.recommendedResearchProfile ?? "focused-entrypoint-traversal";

  return {
    requestId: stableId(["focused-research-request", input.runId, input.iteration]),
    runId: input.runId,
    iteration: input.iteration,
    profile,
    actions: input.validation.recommendedActions.slice(0, 3),
    focusPaths,
    // Реальные "что искать" от валидатора (свободный текст) важнее, чем
    // тупое повторение исходных токенов вопроса — они уже участвовали в
    // первом research-проходе и не объясняют, что именно пошло не так.
    targetTokens: entityHints.length > 0 ? entityHints : tokenize(input.task).slice(0, 12),
    reason: input.validation.rationale,
    maxAdditionalFiles: profile === "focused-runtime-check" ? 40 : 60,
  };
}

async function runFocusedResearch(input: {
  runId: string;
  task: string;
  workspace: Awaited<ReturnType<typeof openWorkspace>>;
  index: IndexResult;
  graph: GraphState;
  repository: PipelineRunResult["repository"];
  backgroundState: NonNullable<PipelineRunResult["backgroundState"]>;
  currentResearch: PipelineRunResult["research"];
  request: FocusedResearchRequest;
}): Promise<FocusedResearchResult> {
  if (input.request.focusPaths.length === 0) {
    return {
      requestId: input.request.requestId,
      runId: input.runId,
      iteration: input.request.iteration,
      profile: input.request.profile,
      actions: input.request.actions,
      additionalEvidence: [],
      additionalFindings: [],
      resolvedContradictions: [],
      remainingGaps: ["Focused research не нашёл безопасного selective scope."],
      diagnostics: ["Focused research был пропущен: нечего открывать дополнительно в рамках локального scope."],
      deltaSummary: "Новые evidence не добавлены.",
    };
  }

  const focusedWorkspace = await openWorkspaceSelective(input.workspace.rootPath, {
    includePaths: input.request.focusPaths,
    maxFiles: input.request.maxAdditionalFiles,
  });
  const focusedIndex = await runFullIndex(focusedWorkspace, {
    changedPaths: input.request.focusPaths,
    deletedPaths: [],
  });
  const focusedGraph = buildGraph(focusedWorkspace, focusedIndex);
  const focusedTask = buildFocusedResearchTask(input.task, input.request);
  const focusedKnownFacts = await queryRelevantFacts(input.workspace.rootPath, focusedIndex, input.repository);
  const focusedResearch = runResearch({
    runId: `${input.runId}-focused-${input.request.iteration}`,
    task: focusedTask,
    workspace: focusedWorkspace,
    index: focusedIndex,
    graph: focusedGraph,
    repository: input.repository,
    backgroundState: input.backgroundState,
    knownFacts: focusedKnownFacts,
  });

  const previousEvidenceIds = new Set(input.currentResearch.evidence.map((item) => `${item.label}::${item.filePath ?? ""}`));
  const additionalEvidence = focusedResearch.evidence.filter((item) => !previousEvidenceIds.has(`${item.label}::${item.filePath ?? ""}`)).slice(0, 8);
  const previousFindings = new Set(input.currentResearch.findings);
  const additionalFindings = focusedResearch.findings.filter((item) => !previousFindings.has(item)).slice(0, 6);

  return {
    requestId: input.request.requestId,
    runId: input.runId,
    iteration: input.request.iteration,
    profile: input.request.profile,
    actions: input.request.actions,
    additionalEvidence,
    additionalFindings,
    resolvedContradictions: [],
    remainingGaps: focusedResearch.unknowns.slice(0, 3),
    diagnostics: focusedIndex.diagnostics.slice(0, 4),
    deltaSummary:
      additionalEvidence.length > 0 || additionalFindings.length > 0
        ? `Focused research добавил ${additionalEvidence.length} новых evidence и ${additionalFindings.length} новых findings.`
        : "Focused research не дал заметного прироста evidence.",
  };
}

function mergeResearchWithFocusedResult(
  research: PipelineRunResult["research"],
  refinement: FocusedResearchResult,
): PipelineRunResult["research"] {
  const mergedEvidence = [
    ...research.evidence,
    ...refinement.additionalEvidence,
  ]
    .sort((left, right) => right.score - left.score)
    .filter((item, index, array) =>
      array.findIndex((candidate) => `${candidate.label}::${candidate.filePath ?? ""}` === `${item.label}::${item.filePath ?? ""}`) === index,
    )
    .slice(0, 12);
  const mergedFindings = Array.from(new Set([...research.findings, ...refinement.additionalFindings])).slice(0, 10);
  const mergedUnknowns = research.unknowns.filter((item) => !refinement.remainingGaps.includes(item));

  return {
    ...research,
    findings: mergedFindings,
    evidence: mergedEvidence,
    unknowns: mergedUnknowns.length > 0 ? mergedUnknowns : research.unknowns.slice(0, 2),
    confidence: Math.min(95, research.confidence + (refinement.additionalEvidence.length > 0 ? 8 : 0)),
    summary:
      refinement.additionalEvidence.length > 0
        ? `${research.summary} Focused refinement усилил доказательную базу в релевантной зоне.`
        : research.summary,
  };
}

function deriveFocusedResearchPaths(input: {
  workspace: Awaited<ReturnType<typeof openWorkspace>>;
  repository: PipelineRunResult["repository"];
  actions: ValidationRecommendedAction[];
  entityHints: string[];
  task: string;
  research: PipelineRunResult["research"];
  previousRun: PipelineRunResult | null;
}): string[] {
  // Первый проход открывает только узкий selective overlay (workspace.files)
  // — ровно тот же набор, который уже не дал ответа. Искать "чего не хватает"
  // в нём же бессмысленно: если сущность туда не попала изначально, она не
  // появится и здесь. Поэтому universe для focused research шире — сюда же
  // подмешивается полный путь-лист из закэшированного baseline index, если
  // он есть (та же логика, что в availableRelativePaths у buildQuestionWorkspacePlan).
  const allPaths = Array.from(
    new Set([
      ...input.workspace.files.map((file) => file.relativePath),
      ...(input.previousRun?.runtimeCache?.index.files.map((file) => normalizePath(file.filePath)) ?? []),
    ]),
  );
  const taskTokens = tokenize(input.task);
  const paths = new Set<string>();

  for (const item of input.research.evidence.slice(0, 8)) {
    if (item.filePath) {
      paths.add(normalizePath(item.filePath));
    }
  }

  for (const changed of input.repository.changedFiles.slice(0, 20)) {
    paths.add(normalizePath(changed.path));
  }

  // Свободные entity-hints от валидатора (LLM или деترминированный fallback)
  // — это не сценарий из закрытого словаря actions, а конкретное "вот чего не
  // хватает" по смыслу вопроса. Матчим их так же, как задачу целиком
  // (compound-group AND-матчинг), чтобы короткий общий фрагмент составного
  // имени не топил реальное совпадение шумом (см. buildCompoundTokenGroups).
  for (const hint of input.entityHints) {
    const hintGroups = buildCompoundTokenGroups(hint);

    if (hintGroups.length === 0) {
      continue;
    }

    for (const path of allPaths.filter((filePath) => matchesCompoundTokenGroups(filePath.toLowerCase(), hintGroups)).slice(0, 20)) {
      paths.add(path);
    }

    // Путь файла — не единственное место, где сущность может "жить": связь
    // на неё бывает символом (методом/полем) в СОВСЕМ другом по имени файле
    // (например `Bill.chiroNotes` — relation-метод в Bill.php). Ищем и там,
    // а не только по filePath.
    const symbolMatches = (input.previousRun?.runtimeCache?.index.symbols ?? [])
      .filter((symbol) => {
        const label = `${symbol.containerName ? `${symbol.containerName}.` : ""}${symbol.name}`.toLowerCase();
        return matchesCompoundTokenGroups(label, hintGroups);
      })
      .slice(0, 20);

    for (const symbol of symbolMatches) {
      paths.add(normalizePath(symbol.filePath));
    }
  }

  if (input.actions.includes("check-middleware-chain")) {
    for (const path of allPaths.filter((filePath) => filePath.toLowerCase().includes("middleware")).slice(0, 12)) {
      paths.add(path);
    }
  }

  if (input.actions.includes("check-config-file") || input.actions.includes("check-env-fallback")) {
    for (const path of allPaths.filter((filePath) => filePath.toLowerCase().includes("config") || filePath.toLowerCase().includes(".env")).slice(0, 12)) {
      paths.add(path);
    }
  }

  if (input.actions.includes("check-oauth-provider-binding")) {
    for (const path of allPaths.filter((filePath) => {
      const lower = filePath.toLowerCase();
      return lower.includes("oauth") || lower.includes("google") || lower.includes("auth");
    }).slice(0, 16)) {
      paths.add(path);
    }
  }

  if (input.actions.includes("run-entrypoint-traversal") || input.actions.includes("check-route-controller-binding")) {
    for (const path of allPaths.filter((filePath) => {
      const lower = filePath.toLowerCase();
      return lower.startsWith("routes/") || lower.includes("/controllers/") || lower.includes("routeprovider");
    }).slice(0, 16)) {
      paths.add(path);
    }
  }

  if (input.actions.includes("check-history-guard-flow")) {
    for (const path of allPaths.filter((filePath) => {
      const lower = filePath.toLowerCase();
      return lower.includes("history") || lower.includes("rollback") || lower.includes("bill");
    }).slice(0, 18)) {
      paths.add(path);
    }
  }

  for (const path of allPaths.filter((filePath) => {
    const lower = filePath.toLowerCase();
    return taskTokens.some((token) => lower.includes(token));
  }).slice(0, 20)) {
    paths.add(path);
  }

  return Array.from(paths).slice(0, 50);
}

function buildFocusedResearchTask(task: string, request: FocusedResearchRequest): string {
  const actionHints = request.actions.join(", ");

  switch (request.profile) {
    case "focused-config-check":
      return `${task}. Фокус проверки: config/env fallback, service bindings. Действия: ${actionHints}.`;
    case "focused-runtime-check":
      return `${task}. Фокус проверки: runtime chain, middleware, route/controller/provider flow. Действия: ${actionHints}.`;
    case "focused-dependency-check":
      return `${task}. Фокус проверки: dependency expansion и соседние structural anchors. Действия: ${actionHints}.`;
    case "focused-entrypoint-traversal":
      return `${task}. Фокус проверки: entry points и их ближайшая функциональная цепочка. Действия: ${actionHints}.`;
    default:
      return `${task}. Focused refinement. Действия: ${actionHints}.`;
  }
}

/**
 * Персистентность графа (Slice 4, docs/architecture/008-next-generation-architecture.md, раздел 6).
 * Сохранение в Neo4j не должно блокировать или ломать pipeline run, если graph store временно
 * недоступен — это вспомогательная инвестиция в переиспользуемость, а не критический путь ответа.
 */
async function persistGraphSnapshotSafely(graph: GraphState): Promise<void> {
  try {
    await saveGraphSnapshot(graph);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn("Не удалось сохранить graph snapshot в Neo4j:", error instanceof Error ? error.message : error);
  }
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
