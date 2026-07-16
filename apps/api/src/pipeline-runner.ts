import path from "node:path";
import { promises as fs } from "node:fs";
import {
  buildAnswerPackage,
  buildControlledExecutionRuntime,
  buildValidatedAnswerPacket,
  buildValidationPacket,
  createUsageAccumulator,
  embedTexts,
  expandTaskSearchKeywords,
  summarizeProviderUsage,
  validateEvidence,
  type ProviderUsageAccumulator,
} from "@client/ai";
import { buildContextPackage } from "@client/context";
import { buildGraph } from "@client/graph";
import { analyzeImpact } from "@client/impact-analysis";
import { runFullIndex } from "@client/indexer";
import { buildBackgroundProjectState, findSemanticMatches, loadBestBaselineRunArtifact, loadConversationTurns, loadLatestBackgroundRunCatalogEntry, promoteFactsFromResearch, queryBusinessGraphEntries, queryRelevantFacts, saveKnowledgeArtifacts } from "@client/knowledge";
import { buildExecutionPlan, buildExecutionPreview } from "@client/planner";
import { deriveRepositoryScopedPaths, inspectRepository, shouldPreferSelectiveWorkspace } from "@client/repository-git";
import { runResearch } from "@client/research";
import {
  type IncrementalIndexPlan,
  type IndexResult,
  type FocusedResearchRequest,
  type FocusedResearchResult,
  type GraphState,
  detectResearchAmbiguity,
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
import { runAgenticResearch } from "@client/agentic-research";
import { saveGraphSnapshot } from "./graph-store.js";
import { getRedisClient } from "./redis-client.js";
import { getSelectedTeam } from "./team-store.js";

export interface PipelineExecutionRequest {
  runId: string;
  mode: PipelineRunMode;
  conversationId: string;
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

type QuestionRuntimeMode = "chat-fast-path" | "deep-research-path" | "team-mode";

const runStore = new Map<string, PipelineRunStatus>();
const runAppRootStore = new Map<string, string>();
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
    conversationId: request.conversationId,
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
  void persistRunStatus(initialStatus);
  setTimeout(() => {
    void executePipelineRun(request);
  }, 0);

  return initialStatus;
}

export function getPipelineRunStatus(runId: string): PipelineRunStatus | null {
  return runStore.get(runId) ?? null;
}

// Наблюдатель (observer-monitor.ts) не должен запускать обход, пока живой
// пользователь ведёт интерактивный диалог с ЛЮБЫМ проектом — они делят один
// и тот же provider (baseUrl/apiKey), и агрессивный многоходовой agentic-обход
// реально конкурирует за rate limit/соединения с обычным вопросом
// пользователя. Живой репродукт: "сообщения не отправляются" совпадал по
// времени с фоновым обходом.
export function hasAnyActiveQuestionRun(): boolean {
  return Array.from(runStore.values()).some(
    (status) => status.mode === "question-run" && (status.status === "queued" || status.status === "running"),
  );
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

// Live incident (2026-07-15): .client/pipeline-status/ (this was file-based)
// grew to 2.8GB and OOM-crashed the API on startup - bootstrap unconditionally
// JSON.parses every status file, and result.runtimeCache (the full project
// index+graph, re-embedded on every single status update) had bloated some
// files to 140MB. Moved to Redis: TTL means expiry is automatic instead of a
// manual mtime-scan at bootstrap, and this data was always ephemeral (pure
// live-progress-polling cache - the real reuse-optimization this cache was
// FOR reads from the separate, Postgres-backed knowledge-artifacts store, not
// from here) so losing it on a Redis restart costs nothing but a "resume from
// start" on whatever was mid-flight, same as the old interrupted-run handling.
const PIPELINE_STATUS_TTL_SECONDS = 60 * 60 * 24 * 3;
// Defense-in-depth: toPersistableRunStatus already stops the bloat at the
// source, but a value this large stored in Redis is never a status a human
// is going to read anyway - skip it rather than let a future regression
// repeat the same failure shape against a different backing store.
const MAX_STATUS_VALUE_BYTES = 10 * 1024 * 1024;

function pipelineStatusRedisKey(runId: string): string {
  return `pipeline-status:${runId}`;
}

export async function loadPipelineRunStatus(appRootPath: string, runId: string): Promise<PipelineRunStatus | null> {
  const inMemory = runStore.get(runId);

  if (inMemory) {
    return inMemory;
  }

  try {
    const raw = await getRedisClient().get(pipelineStatusRedisKey(runId));

    if (!raw) {
      return null;
    }

    if (raw.length > MAX_STATUS_VALUE_BYTES) {
      console.warn(`[pipeline-runner] skipping oversized status value (${Math.round(raw.length / 1024 / 1024)}MB) for run ${runId}`);
      return null;
    }

    const parsed = JSON.parse(raw) as PipelineRunStatus;
    runStore.set(runId, parsed);
    runAppRootStore.set(runId, appRootPath);
    return parsed;
  } catch {
    return null;
  }
}

export async function waitForPipelineRunCompletion(
  appRootPath: string,
  runId: string,
  options?: {
    timeoutMs?: number;
    pollIntervalMs?: number;
  },
): Promise<PipelineRunStatus | null> {
  const timeoutMs = options?.timeoutMs ?? 1000 * 60 * 4;
  const pollIntervalMs = options?.pollIntervalMs ?? 700;
  const startedAt = Date.now();

  for (;;) {
    const status = await loadPipelineRunStatus(appRootPath, runId);

    if (!status) {
      return null;
    }

    if (status.status === "completed" || status.status === "failed") {
      return status;
    }

    if (Date.now() - startedAt >= timeoutMs) {
      return status;
    }

    await new Promise((resolve) => {
      setTimeout(resolve, pollIntervalMs);
    });
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
  try {
    // SCAN, not KEYS - non-blocking even if the keyspace is large, unlike
    // KEYS which would freeze Redis while it walks the whole keyspace.
    const stream = getRedisClient().scanStream({ match: "pipeline-status:*", count: 100 });

    for await (const keys of stream as AsyncIterable<string[]>) {
      for (const key of keys) {
        const runId = key.replace(/^pipeline-status:/, "");
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
    }
  } catch (error) {
    console.warn("[pipeline-runner] bootstrap scan failed (Redis unavailable?):", error);
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

    const interrupted = markStatusInterrupted(
      status,
      "Сервер был остановлен во время выполнения. Run можно безопасно перезапустить с начала.",
      "Run был прерван остановкой сервера. Доступен resume-from-start.",
    );
    runStore.set(runId, interrupted);

    if (runAppRootStore.get(runId)) {
      pending.push(persistRunStatus(interrupted));
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
  const { runId, mode, conversationId, task, projectPath, providerBaseUrl, providerModel, providerApiKey, appRootPath } = request;
  const overview = await scanWorkspaceOverview(projectPath);
  const largeRepositoryProfile = overview.summary.profile === "large-repository";
  const isQuestionRun = mode === "question-run";
  const isHardResync = mode === "hard-resync";
  // One accumulator per run (local variable, never module-level state) -
  // covers every LLM call made anywhere in this run, deterministic or
  // agentic path, keyword-expansion/validation/answer-synthesis alike.
  const usageAccumulator = createUsageAccumulator();

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
  // Реплики этого же диалога, по порядку — источник prior-turn контекста для
  // research/context/answer ниже (см. §8 плана: applyPriorTurnEvidence и
  // conversationTranscript). Отдельно от loadBestBaselineRunArtifact — тот
  // отвечает только за structural graph/index reuse через background-sync
  // baseline и никогда не выбирает question-run в качестве previousRun.
  const conversationTurns = isQuestionRun
    ? await loadConversationTurns(appRootPath, projectRootPath, conversationId)
    : [];
  const priorConversationTurn = conversationTurns[conversationTurns.length - 1] ?? null;
  const turnIndex = conversationTurns.length;
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
  // let, не const (2026-07-16): team-mode перестраивает workspace/index/graph
  // ПОСЛЕ agentic-исследования, добавляя файлы, которые исследователь реально
  // прочитал — см. блок "evidence-to-impact seam" ниже.
  let workspace = shouldUseSelectiveWorkspace
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
  // canUseLightweightQuestionFlow влияет только на текст completeStage ниже -
  // сам вызов индексатора одинаковый (был дословно продублированный ternary
  // с идентичными ветками, схлопнут 2026-07-16).
  let index = await runFullIndex(workspace, {
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
  let graph = buildGraph(workspace, index, {
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
  // Team-mode: если для вопроса выбрана команда (Researcher/Critic/Observer,
  // см. team-store.ts), agentic-исследование (packages/agentic-research)
  // заменяет детерминированный runResearch целиком — сама модель ходит
  // list_dir/grep_content/read_file по проекту вместо готового промпта от
  // алгоритма. Kill-switch по конструкции: без выбранной команды пайплайн
  // работает ровно как раньше.
  const selectedTeam = isQuestionRun ? await getSelectedTeam() : null;
  let initialResearch: PipelineRunResult["research"];
  let teamValidation: ValidationResult | null = null;

  if (selectedTeam) {
    updateStageLabel(runId, "research", `Команда «${selectedTeam.name}»: Researcher исследует проект инструментами...`);
    const observerHint = await buildObserverHintSuffix(projectRootPath, task);
    const knownFactsHintText = buildKnownFactsHint(knownFacts);
    // Тот же conversationTurns, что уже питает приоритетную evidence для
    // детерминированного пути (см. priorTurn чуть ниже) - agentic-путь
    // раньше вообще не участвовал в этом механизме, из-за чего каждая
    // следующая реплика диалога заново исследовала с нуля вместо того чтобы
    // опереться на уже найденные в прошлой реплике файлы.
    const priorTurnFiles = priorConversationTurn
      ? [...new Set(priorConversationTurn.research.evidence.map((item) => item.filePath).filter((item): item is string => Boolean(item)))]
      : [];
    // Graph-symbol hints: DISABLED after live testing (2026-07-15), not
    // deleted - findGraphSymbolHints (graph-store.ts) is real and works for
    // precise terms (resolved "relation cases" to UnlinkRelatedCasesAction
    // cleanly, no Eloquent withRelations()/relationLoaded() noise), but a
    // second live run on the same question showed the opposite failure: the
    // term "relation" also substring-matches an unrelated real feature
    // (CausalRelationshipRequest/SaveCausalRelationshipAction in
    // AcuNotes/PainManagementNote - "Relationship" contains "relation") and
    // steered a run to a confidently-wrong answer. Attempted a fix (require
    // 2+ distinct seed terms to converge on the same namespace cluster
    // before trusting a match) but the actual graph data doesn't support it:
    // most matching labels (334/500 in a spot check) are bare identifiers
    // with no namespace path to cluster by, and container depth in the ones
    // that do isn't a fixed, project-generic offset. Shipping a mechanism
    // that can make a wrong answer MORE confident is worse than the current
    // honest-hedging behavior without it - needs real ranking (e.g. match
    // density per cluster) before this is trustworthy enough to re-enable.
    // const graphHintTerms = await findGraphSymbolHints(graphProjectId, computeTaskSearchTokens(task));
    const agenticResult = await runAgenticResearch({
      runId,
      // Bug fix (2026-07-15): task used to have observerHint concatenated
      // straight into it - this flows into ResearchReport.task, which the
      // chat UI renders verbatim as "Задача", so the hint text ("Подсказка
      // от фонового обхода проекта...") was leaking into what the user sees
      // as their own question. observerHint is now passed as its own field
      // (AgenticRunOptions.observerHint) - still reaches the model, just
      // appended to the LLM-facing message only, not the visible task.
      task,
      projectRootPath,
      researcherModel: selectedTeam.researcherModel,
      criticModel: selectedTeam.criticModel,
      providerBaseUrl,
      providerApiKey,
      ...(priorTurnFiles.length ? { priorTurnFiles } : {}),
      ...(observerHint ? { observerHint } : {}),
      semanticSearch: buildSemanticSearchTool(projectRootPath, providerBaseUrl, providerApiKey),
      // Speed pass (2026-07-16, по одобренному плану): контент топ-файлов
      // семантического индекса кладётся в контекст ДО первого хода (см.
      // AgenticRunOptions.semanticSeedFiles) - главный рычаг задержки на
      // лёгких вопросах (2-3 хода экономии по замерам).
      semanticSeedFiles: buildSemanticSeedLookup(projectRootPath, providerBaseUrl, providerApiKey),
      // Факт-стор теперь питает и agentic-путь (раньше только легаси
      // детерминированный) - подтверждённые прошлыми прогонами факты как
      // "проверь и опирайся"-затравка.
      ...(knownFactsHintText ? { knownFactsHint: knownFactsHintText } : {}),
      onProgress: ({ turn, filesRead }) => {
        updateStageLabel(
          runId,
          "research",
          `Команда «${selectedTeam.name}»: ход ${turn}, прочитано файлов: ${filesRead}...`,
        );
      },
    });
    initialResearch = agenticResult.research;
    teamValidation = agenticResult.validation;
    // The agentic loop already tracks its own (Researcher + Critic) usage
    // internally (packages/agentic-research) - merge it into the same
    // per-run accumulator that the deterministic path's calls feed, so
    // usage reflects the true total regardless of which path answered.
    usageAccumulator.promptTokens += agenticResult.raw.totalPromptTokens;
    usageAccumulator.completionTokens += agenticResult.raw.totalCompletionTokens;
    // turnsUsed = Researcher calls, criticRounds = Critic calls - an exact
    // count, not an approximation from actionsLog (which also logs non-LLM
    // tool observations).
    usageAccumulator.callCount += agenticResult.raw.turnsUsed + agenticResult.raw.criticRounds;
    completeStage(
      runId,
      "research",
      researchStartedAt,
      `Команда «${selectedTeam.name}»: изучено ${agenticResult.raw.touchedFiles.length} файлов за ${agenticResult.raw.turnsUsed} ход(а/ов), критик: ${agenticResult.raw.criticVerdict}.`,
    );

    // Evidence-to-impact seam (2026-07-16): agentic-исследователь читает файлы
    // напрямую с диска и не ограничен selective workspace (~120 файлов),
    // собранным ДО исследования — поэтому реально прочитанные файлы часто
    // отсутствовали в workspace/index/graph, и impact давал "0 затронутых
    // файлов", а context терял содержимое evidence-файлов (сопоставление там —
    // точное строковое равенство путей). Пересобираем все три артефакта с
    // touchedFiles в срезе; по замерам стадий index+graph на таком срезе — доли
    // секунды, так что это дешевле одного лишнего хода модели.
    const workspaceFilePathSet = new Set(workspace.files.map((file) => file.relativePath));
    const touchedOutsideWorkspace = agenticResult.raw.touchedFiles.filter(
      (filePath) => !workspaceFilePathSet.has(filePath),
    );

    if (touchedOutsideWorkspace.length > 0) {
      workspace = await openWorkspaceSelective(projectPath, {
        includePaths: [...new Set([...agenticResult.raw.touchedFiles, ...workspace.files.map((file) => file.relativePath)])],
        maxFiles: workspace.files.length + touchedOutsideWorkspace.length,
      });
      index = await runFullIndex(workspace, {
        previousRun,
        changedPaths: incrementalIndex.changedPaths,
        deletedPaths: incrementalIndex.deletedPaths,
      });
      graph = buildGraph(workspace, index, {
        previousRun,
        invalidatedPaths: graphInvalidation.invalidatedFiles,
      });
      updatePartialArtifacts(runId, {
        index: {
          manifest: index.manifest,
          stats: index.stats,
          diagnostics: index.diagnostics,
        },
        graph: {
          summary: graph.summary,
        },
      });
    }
  } else {
    const researchInputForRun = {
      runId,
      task,
      workspace,
      index,
      graph,
      repository,
      backgroundState,
      knownFacts,
      ...(priorConversationTurn
        ? {
            priorTurn: {
              task: priorConversationTurn.research.task,
              summary: priorConversationTurn.research.summary,
              dominantModule: priorConversationTurn.research.dominantModule,
              evidence: priorConversationTurn.research.evidence,
              moduleIntents: priorConversationTurn.research.moduleIntents,
              intentClass: priorConversationTurn.research.intentClass,
              strategyKey: priorConversationTurn.research.strategyKey,
              queryProfileKey: priorConversationTurn.research.queryProfileKey,
            },
          }
        : {}),
    };
    const primaryResearch = runResearch(researchInputForRun);
    const keywordExpansion = await maybeExpandResearchWithTranslatedKeywords(researchInputForRun, primaryResearch, {
      isQuestionRun,
      providerBaseUrl,
      providerModel,
      providerApiKey,
      usage: usageAccumulator,
    });
    initialResearch = keywordExpansion.research;
    completeStage(
      runId,
      "research",
      researchStartedAt,
      `Подготовлено ${initialResearch.evidence.length} опорных ссылок с уверенностью ${initialResearch.confidence}%: baseline ${initialResearch.evidenceSummary.baselineCount}, overlay ${initialResearch.evidenceSummary.overlayCount}, structural ${initialResearch.evidenceSummary.structuralCount}, recalled ${initialResearch.evidenceSummary.recalledCount}, из диалога ${initialResearch.evidenceSummary.conversationCount}.${
        keywordExpansion.keywords.length > 0
          ? ` Дополнительно запрошены англоязычные ключевые слова через LLM: ${keywordExpansion.keywords.join(", ")}.`
          : ""
      }`,
    );
  }

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

  const questionRuntimeMode: QuestionRuntimeMode = selectedTeam
    ? "team-mode"
    : isQuestionRun && shouldUseChatFastPath({
      task,
      research: initialResearch,
      impact: initialImpact,
      diagnostics: [
        ...workspace.diagnostics,
        ...index.diagnostics,
        ...repository.diagnostics,
        ...backgroundState.diagnostics,
      ],
    })
      ? "chat-fast-path"
      : "deep-research-path";

  const contextStartedAt = startStage(runId, "context");
  const initialContext = buildContextPackage({
    runId,
    task,
    workspace,
    index,
    graph,
    research: initialResearch,
    impact: initialImpact,
    ...(priorConversationTurn ? { priorIncludedFiles: priorConversationTurn.context.includedFiles } : {}),
  });
  completeStage(runId, "context", contextStartedAt, `Собран контекстный пакет: ${initialContext.selectedChunks.length} фрагментов при бюджете ${initialContext.tokenBudget}.`);
  updatePartialArtifacts(runId, {
    context: initialContext,
  });
  await yieldToEventLoop();

  // Раньше у validation loop (LLM-проверка evidence + до
  // MAX_VALIDATION_REFINEMENT_ITERATIONS раундов доуточнения, каждый —
  // отдельный LLM-вызов с retry/backoff до PROVIDER_MAX_ATTEMPTS попыток)
  // не было своей стадии — она "пряталась" между `context` и `plan`, и при
  // деградации/таймаутах внешнего провайдера пользователь видел статичную
  // метку "Контекст" сколько угодно долго без единого признака прогресса.
  // Живой репродукт: run завис на несколько минут именно в этом промежутке.
  const validationStartedAt = startStage(runId, "validation");
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
    runtimeMode: questionRuntimeMode,
    ...(teamValidation ? { precomputedTeamValidation: teamValidation } : {}),
    usage: usageAccumulator,
  });
  completeStage(
    runId,
    "validation",
    validationStartedAt,
    `${questionRuntimeMode === "team-mode" ? "Команда уже проверила ответ критиком." : questionRuntimeMode === "chat-fast-path" ? "Chat fast-path." : "Deep research path."} Проверка ответа завершена за ${validationLoop.validationHistory.length} раунд(а/ов): статус ${validationLoop.validation.status}, readiness ${validationLoop.validation.readinessScore}%.`,
  );
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

  // Компактная история треда для reference resolution в финальном синтезе
  // ("при регистрации через гугл" отсылает к предыдущему вопросу про Google
  // OAuth) — последние 3 реплики, чтобы не раздувать промпт на длинных диалогах.
  const conversationTranscript = conversationTurns.slice(-3).map((turn) => ({
    task: turn.research.task,
    directAnswer: turn.answer.summary,
  }));

  const answerStartedAt = startStage(runId, "answer");
  const answer = await buildAnswerPackage({
    runId,
    task,
    providerBaseUrl: isQuestionRun ? providerBaseUrl : "",
    // Team-mode: финальная прозa всё ещё идёт через существующий, уже
    // настроенный "человеческий" system prompt (buildAnswerSystemPrompt) —
    // просто моделью Researcher выбранной команды, а не общей моделью пайплайна.
    providerModel: isQuestionRun ? (selectedTeam?.researcherModel || providerModel) : "",
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
    ...(conversationTranscript.length > 0 ? { conversationTranscript } : {}),
    usage: usageAccumulator,
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
    conversationId,
    turnIndex,
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
    usage: summarizeProviderUsage(usageAccumulator),
  });
  completeStage(runId, "knowledge", knowledgeStartedAt, `Артефакты сохранены в центральное knowledge-хранилище: ${knowledge.artifactCount} групп.`);

  return {
    runId,
    mode,
    conversationId,
    turnIndex,
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
    usage: summarizeProviderUsage(usageAccumulator),
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
    createPendingStage("validation", "Проверка ответа", now),
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

// Обновляет только видимую метку текущей стадии, не трогая её status/timestamps
// (стадия остаётся "running") — для стадий с несколькими внутренними шагами
// (см. runValidationLoop), где без этого пользователь видит статичную метку
// сколько угодно долго, пока идёт несколько последовательных LLM-вызовов.
function updateStageLabel(runId: string, stageKey: PipelineStage["key"], label: string): void {
  const current = runStore.get(runId);

  if (!current) {
    return;
  }

  updateRunStatus(runId, {
    ...current,
    updatedAt: new Date().toISOString(),
    currentStageLabel: label,
  });
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
    usage?: ProviderUsageAccumulator;
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
    ...(options.usage ? { usage: options.usage } : {}),
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
  // Map/Set вместо nodes.find/paths.includes на каждое ребро (2026-07-16):
  // на реальном background-sync графе (проект ~8000 файлов, сотни тысяч
  // рёбер) старый вариант был O(edges × nodes) и стабильно съедал ~85 СЕКУНД
  // чистого CPU на каждый question-run — это была самая долгая часть всей
  // workspace-стадии, дороже загрузки самого 120MB артефакта в 30+ раз.
  // Замерено стадийными таймингами двух живых прогонов подряд.
  const directMatchPathSet = new Set(directMatchPaths);
  const graphNodePathById = previousGraph
    ? new Map(previousGraph.nodes.map((node) => [node.id, normalizePath(node.filePath ?? "")]))
    : null;
  const graphNeighborPaths = previousGraph && graphNodePathById
    ? Array.from(
        new Set(
          previousGraph.edges.flatMap((edge) => {
            const sourcePath = graphNodePathById.get(edge.sourceId) ?? "";
            const targetPath = graphNodePathById.get(edge.targetId) ?? "";
            const sourceMatched = sourcePath && directMatchPathSet.has(sourcePath);
            const targetMatched = targetPath && directMatchPathSet.has(targetPath);

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

const OBSERVER_HINT_MIN_TOKEN_LENGTH = 4;
const OBSERVER_HINT_MAX_ENTRIES = 2;

// Live evidence (2026-07-15): "папка w9" never matched a real, relevant
// entry because "w9" (length 2) was dropped by a length>=4 filter, while
// generic 4+ char words let an unrelated entry through. Short alphanumeric
// identifiers (w9, s3, oauth2) are exactly the tokens most likely to be a
// real, distinctive match - length alone is the wrong signal, so a digit
// anywhere in the token bypasses the length floor instead of being
// penalized by it. Shared by the Observer-hint matcher and the graph-symbol
// lookup below - same "what is this question actually about" signal, used
// twice.
function computeTaskSearchTokens(task: string): string[] {
  const tokens = tokenize(task).filter((token) => token.length >= OBSERVER_HINT_MIN_TOKEN_LENGTH || /\d/.test(token));
  // Bug found while verifying the graph-symbol-hint feature (2026-07-15):
  // this returned raw Cyrillic tokens ("релейшн", "кейсов") straight from
  // tokenize() with no transliteration, so a lookup against Latin-script
  // code (class labels, Observer's business-graph text) could never match
  // anything - the graph hint silently contributed nothing on the one run
  // that looked like a success. expandRussianTechTransliteration adds the
  // English equivalents ("relation", "case") alongside the originals.
  return [...new Set([...tokens, ...expandRussianTechTransliteration(tokens)])];
}

// Observer's накопленные записи (packages/knowledge graph-entries) — не
// подтверждённый факт, а подсказка ("похоже, было здесь"): живой Researcher
// сам решает, доверять ли ей, после проверки по актуальному коду. Именно
// поэтому формулировка ниже явно говорит "проверь", а не "вот факт".
const SEMANTIC_SEARCH_EMBEDDING_MODEL = "qwen/qwen3-embedding-8b";

// Injected into AgenticRunOptions.semanticSearch (2026-07-16) - kept here,
// not in packages/agentic-research, so that package stays free of any
// DB/provider-embeddings dependency (mirrors how shouldAbort is injected).
// Queries whatever apps/api/src/embedding-indexer.ts has built so far in the
// background; never builds/blocks on an index itself, so a project with no
// embeddings yet just degrades to an honest "nothing indexed yet" message
// rather than stalling a live question.
function buildSemanticSearchTool(
  projectRootPath: string,
  providerBaseUrl: string,
  providerApiKey: string,
): (query: string) => Promise<string> {
  return async (query: string): Promise<string> => {
    try {
      const [queryEmbedding] = await embedTexts({
        providerBaseUrl,
        providerApiKey,
        embeddingModel: SEMANTIC_SEARCH_EMBEDDING_MODEL,
        texts: [query],
      });

      if (!queryEmbedding) {
        return "(semantic search failed: no embedding returned)";
      }

      const matches = await findSemanticMatches(projectRootPath, queryEmbedding, 8);

      if (matches.length === 0) {
        return "(no semantic index built yet for this project, or no match found - try list_dir/grep_content instead)";
      }

      return matches.map((match) => `${match.filePath} (similarity ${match.score.toFixed(2)})`).join("\n");
    } catch (error) {
      return `(semantic search error: ${error instanceof Error ? error.message : String(error)})`;
    }
  };
}

// Порог 0.45 эмпирический: живые замеры этой сессии - правильные файлы для
// точного вопроса скорили 0.62-0.72 (англ. запрос) и 0.40-0.49 (сырой
// русский), нерелевантные - ниже ~0.42. Ниже порога сид просто пуст - это
// оптимизация, а не зависимость.
const SEMANTIC_SEED_MIN_SCORE = 0.45;

function buildSemanticSeedLookup(
  projectRootPath: string,
  providerBaseUrl: string,
  providerApiKey: string,
): (query: string) => Promise<string[]> {
  return async (query: string): Promise<string[]> => {
    try {
      const [queryEmbedding] = await embedTexts({
        providerBaseUrl,
        providerApiKey,
        embeddingModel: SEMANTIC_SEARCH_EMBEDDING_MODEL,
        texts: [query],
      });

      if (!queryEmbedding) {
        return [];
      }

      const matches = await findSemanticMatches(projectRootPath, queryEmbedding, 3);
      return matches.filter((match) => match.score >= SEMANTIC_SEED_MIN_SCORE).map((match) => match.filePath);
    } catch {
      return [];
    }
  };
}

// Формирует "verify, then rely"-блок из подтверждённых фактов прошлых
// прогонов (fact store) для agentic-цикла. Только свежие (не stale) факты с
// файлами - у протухших content hash уже разошёлся с кодом.
function buildKnownFactsHint(knownFacts: Awaited<ReturnType<typeof queryRelevantFacts>>): string {
  const usable = knownFacts
    .filter((fact) => fact.status === "fresh" && fact.filePaths.length > 0)
    .slice(0, 5);

  if (usable.length === 0) {
    return "";
  }

  return [
    "Facts confirmed by PREVIOUS answered questions about this project (verify against current code before relying - the code may have changed):",
    ...usable.map((fact) => `- ${fact.statement} (files: ${fact.filePaths.slice(0, 3).join(", ")})`),
  ].join("\n");
}

async function buildObserverHintSuffix(projectRootPath: string, task: string): Promise<string> {
  try {
    const entries = await queryBusinessGraphEntries(projectRootPath);
    const freshEntries = entries.filter((entry) => !entry.isStale && entry.featureSummary.trim());

    if (freshEntries.length === 0) {
      return "";
    }

    const taskTokens = computeTaskSearchTokens(task);
    const relevant = freshEntries
      .filter((entry) => {
        const haystack = `${entry.unitPath} ${entry.featureSummary} ${entry.keyMechanisms.join(" ")} ${entry.gotchas.join(" ")}`.toLowerCase();
        return taskTokens.some((token) => haystack.includes(token));
      })
      .slice(0, OBSERVER_HINT_MAX_ENTRIES);

    if (relevant.length === 0) {
      return "";
    }

    // Structured layers (2026-07-15) - keyMechanisms/gotchas are now real,
    // separately-populated fields (see observer-monitor.ts's crawlUnit call),
    // not just decoration on the schema. Rendered as their own labeled lines
    // so the live Researcher can weigh "confirmed mechanism" vs "watch out
    // for" separately from the free-text summary.
    // Translated to English (2026-07-16, user's request) - this whole block
    // is appended to the agentic loop's LLM-facing message
    // (AgenticRunOptions.observerHint, loop.ts), never shown to the human
    // user directly (see the 2026-07-15 fix that stopped it from leaking
    // into ResearchReport.task/"Задача").
    const hintLines = relevant.flatMap((entry) => [
      `- "${entry.unitPath}": ${entry.featureSummary}`,
      ...(entry.keyMechanisms.length ? [`  Mechanisms: ${entry.keyMechanisms.join("; ")}`] : []),
      ...(entry.gotchas.length ? [`  Gotchas: ${entry.gotchas.join("; ")}`] : []),
    ]);

    return [
      "Hint from the project's background scan (Observer) - NOT a confirmed fact, just a lead on where to start. Make sure to verify it against the current code before relying on it, the code may have changed since the scan:",
      ...hintLines,
    ].join("\n");
  } catch {
    return "";
  }
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
  runtimeMode: QuestionRuntimeMode;
  precomputedTeamValidation?: ValidationResult;
  usage?: ProviderUsageAccumulator;
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
  if (input.runtimeMode === "team-mode" && input.precomputedTeamValidation) {
    // Team-mode's own critic gate (packages/agentic-research) already
    // validated the answer before it was ever returned here - re-running
    // the deterministic validateEvidence loop on top would be a redundant
    // second opinion, not a real safety improvement. Still build a real
    // ValidationPacket (cheap, no LLM call) purely to get a consistent
    // questionType for buildValidatedAnswerPacket, same as every other path.
    const teamPacket = buildValidationPacket({
      runId: input.runId,
      task: input.task,
      research: input.research,
      impact: input.impact,
      context: input.context,
      graph: input.graph,
      diagnostics: input.diagnostics,
      backgroundState: input.backgroundState,
      iteration: 0,
      priorActions: [],
      remainingIterationBudget: 0,
    });
    updateStageLabel(input.runId, "validation", "Команда уже проверила ответ критиком — пропускаю отдельный validation loop...");
    const teamValidation = input.precomputedTeamValidation;
    const validatedAnswerPacket = buildValidatedAnswerPacket({
      runId: input.runId,
      questionType: teamPacket.questionType,
      validation: teamValidation,
      research: input.research,
    });

    return {
      research: input.research,
      impact: input.impact,
      context: input.context,
      validation: teamValidation,
      validationHistory: [teamValidation],
      validationPacket: teamPacket,
      focusedResearchRequests: [],
      focusedResearchResults: [],
      validatedAnswerPacket,
    };
  }

  if (input.runtimeMode === "chat-fast-path") {
    const fastPacket = buildValidationPacket({
      runId: input.runId,
      task: input.task,
      research: input.research,
      impact: input.impact,
      context: input.context,
      graph: input.graph,
      diagnostics: input.diagnostics,
      backgroundState: input.backgroundState,
      iteration: 0,
      priorActions: [],
      remainingIterationBudget: 0,
    });
    updateStageLabel(input.runId, "validation", "Сигнал сильный — пропускаю глубокую проверку и собираю быстрый ответ...");
    const fastValidation = await validateEvidence({
      packet: fastPacket,
      providerBaseUrl: "",
      providerModel: "",
      providerApiKey: "",
      ...(input.usage ? { usage: input.usage } : {}),
    });
    const validatedAnswerPacket = buildValidatedAnswerPacket({
      runId: input.runId,
      questionType: fastPacket.questionType,
      validation: fastValidation,
      research: input.research,
    });

    return {
      research: input.research,
      impact: input.impact,
      context: input.context,
      validation: fastValidation,
      validationHistory: [fastValidation],
      validationPacket: fastPacket,
      focusedResearchRequests: [],
      focusedResearchResults: [],
      validatedAnswerPacket,
    };
  }

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
  updateStageLabel(input.runId, "validation", "Проверяю, отвечает ли найденное на вопрос...");
  const shouldBypassProviderOnInitialValidation = shouldUseFastValidationPath(currentPacket, currentResearch);
  let currentValidation = await validateEvidence({
    packet: currentPacket,
    providerBaseUrl: shouldBypassProviderOnInitialValidation ? "" : input.providerBaseUrl,
    providerModel: shouldBypassProviderOnInitialValidation ? "" : input.providerModel,
    providerApiKey: shouldBypassProviderOnInitialValidation ? "" : input.providerApiKey,
    ...(input.usage ? { usage: input.usage } : {}),
  });
  validationHistory.push(currentValidation);

  for (let iteration = 1; iteration <= MAX_VALIDATION_REFINEMENT_ITERATIONS; iteration += 1) {
    if (currentValidation.status !== "needs-focused-research") {
      break;
    }

    updateStageLabel(
      input.runId,
      "validation",
      `Данных не хватает — доуточняю (раунд ${iteration} из ${MAX_VALIDATION_REFINEMENT_ITERATIONS})...`,
    );

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
      ...(input.usage ? { usage: input.usage } : {}),
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

function shouldUseChatFastPath(input: {
  task: string;
  diagnostics: string[];
  research: PipelineRunResult["research"];
  impact: PipelineRunResult["impact"];
}): boolean {
  if (looksLikeHighRiskChangeTask(input.task, input.impact)) {
    return false;
  }

  if (input.research.confidence < 72) {
    return false;
  }

  if (input.research.evidence.length < 4) {
    return false;
  }

  if (input.research.unknowns.length >= 2) {
    return false;
  }

  if (input.diagnostics.length >= 2) {
    return false;
  }

  if (detectResearchAmbiguity(input.research).ambiguous) {
    return false;
  }

  const summaryText = `${input.research.summary} ${input.research.functionalSummary}`.toLowerCase();

  if (
    summaryText.includes("частично")
    || summaryText.includes("эврист")
    || summaryText.includes("не найдено")
    || summaryText.includes("не удалось")
  ) {
    return false;
  }

  return true;
}

function looksLikeHighRiskChangeTask(task: string, impact: PipelineRunResult["impact"]): boolean {
  const normalized = task.toLowerCase();

  if (
    normalized.includes("измени")
    || normalized.includes("передел")
    || normalized.includes("реализ")
    || normalized.includes("добавь")
    || normalized.includes("исправ")
    || normalized.includes("refactor")
    || normalized.includes("implement")
    || normalized.includes("change")
    || normalized.includes("rewrite")
  ) {
    return true;
  }

  return impact.risks.length >= 2 || impact.affectedFiles.length >= 10;
}

function shouldUseFastValidationPath(
  packet: ReturnType<typeof buildValidationPacket>,
  research: PipelineRunResult["research"],
): boolean {
  if (research.intentClass === "broad-unknown") {
    return false;
  }

  if (research.queryProfileKey === "broad-scan") {
    return false;
  }

  const fileBackedEvidenceCount = packet.evidenceHighlights.filter((item) => Boolean(item.filePath)).length;
  const strongEvidenceCount = packet.evidenceHighlights.filter((item) => item.score >= 16).length;
  const hasRoutingAnchor =
    packet.graphCoverage.entryPointCount >= 2
    || packet.graphCoverage.relevantAnchorCount >= 4;
  const lowNoise =
    packet.diagnostics.length === 0
    && research.unknowns.length <= 1
    && research.confidence >= 80;

  return (
    packet.remainingIterationBudget === MAX_VALIDATION_REFINEMENT_ITERATIONS
    && packet.evidenceHighlights.length >= 4
    && fileBackedEvidenceCount >= 3
    && strongEvidenceCount >= 3
    && hasRoutingAnchor
    && lowNoise
  );
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

// Live incident (2026-07-15): .client/pipeline-status/ grew to 2.8GB (files
// up to 140MB each) and crashed the API with an OOM on startup, because
// bootstrapPipelineRunStatuses JSON.parses every file in that directory.
// Root cause: result.runtimeCache (the full project index + graph) was
// written into this file on every single status update, for every run -
// but this directory exists only for live progress polling
// (/api/pipeline/status) and bootstrap's "was this interrupted" check,
// neither of which ever reads runtimeCache. The actual reuse-optimization
// this cache exists for (buildIncrementalIndexPlan/buildGraphInvalidationPlan
// etc.) reads `previousRun` from loadBestBaselineRunArtifact, which loads
// from the SEPARATE knowledge-artifacts directory - runtimeCache is already
// persisted there too (see packages/knowledge's saveKnowledgeArtifacts), so
// stripping it here only removes a pure duplicate, not the capability.
function toPersistableRunStatus(status: PipelineRunStatus): PipelineRunStatus {
  const result = status.result;

  if (!result?.runtimeCache) {
    return status;
  }

  const { runtimeCache: _runtimeCache, ...resultWithoutRuntimeCache } = result;
  return { ...status, result: resultWithoutRuntimeCache };
}

async function persistRunStatus(status: PipelineRunStatus): Promise<void> {
  try {
    await getRedisClient().set(
      pipelineStatusRedisKey(status.runId),
      JSON.stringify(toPersistableRunStatus(status)),
      "EX",
      PIPELINE_STATUS_TTL_SECONDS,
    );
  } catch (error) {
    console.warn(`[pipeline-runner] failed to persist status for run ${status.runId} to Redis:`, error);
  }
}

function updateRunStatus(runId: string, status: PipelineRunStatus): void {
  runStore.set(runId, status);

  // Redis key is global (runId is already unique) - the appRootPath
  // association only still matters as "is this a run we actually manage"
  // (a defensive gate carried over from the file-based version).
  if (!runAppRootStore.get(runId)) {
    return;
  }

  void persistRunStatus(status);
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
