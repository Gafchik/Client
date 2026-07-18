import cors from "@fastify/cors";
import Fastify from "fastify";
import path from "node:path";
import { buildBackgroundProjectState, catalogEntryToBaselineMetadata, deleteKnowledgeRuns, loadBestBaselineCatalogEntry, loadConversationTurns, loadKnowledgeCatalog, loadLatestBackgroundRunCatalogEntry, loadLatestConversationTurn, loadLatestPipelineRunArtifact, loadPipelineRunArtifact } from "@client/knowledge";
import { inspectRepository } from "@client/repository-git";
import { normalizePath, stableId, type ConversationTurnsResponse, type ObserverStatusResponse, type PipelineRunMode, type PipelineRunStatus, type ProjectCatalogResponse, type ProviderCatalogResponse, type ProviderUsageSummary, type TeamCatalogResponse } from "@client/shared";
import { openWorkspaceSelective, scanWorkspaceOverview } from "@client/workspace";
import { startEmbeddingIndexer, stopEmbeddingIndexer } from "./embedding-indexer.js";
import { initializeGraphStore } from "./graph-store.js";
import { closeNeo4jDriver, verifyNeo4jConnectivity } from "./neo4j-client.js";
import { closePostgresPool, initializePostgresSchema, verifyPostgresConnectivity } from "./postgres-client.js";
import { closeRedisClient, verifyRedisConnectivity } from "./redis-client.js";
import { bootstrapPipelineRunStatuses, enqueuePipelineRun, findActivePipelineRun, findPipelineRunByRepositoryHead, loadPipelineRunStatus, waitForPipelineRunCompletion } from "./pipeline-runner.js";
import { getObserverProgress, listObserverRunners, startObserver, stopAllObservers, stopObserver } from "./observer-monitor.js";
import { startProjectStateMonitor, stopProjectStateMonitor } from "./project-state-monitor.js";
import { deleteProject, getProjectById, initializeProjectStore, listProjects, saveProject } from "./project-store.js";
import { deleteProvider, fetchProviderModels, getCurrentProvider, initializeProviderStore, listProviders, saveProvider, setCurrentProvider, setProviderDefaultModel } from "./provider-store.js";
import { initializeSecretCrypto } from "./secret-crypto.js";
import { classifyApprovalResponse, classifyAutoMergeIntent, classifyChatIntent, classifyPostCompletionCommand, classifyProjectScopeDirective, classifyTestsOffer, createUsageAccumulator, planDevelopSubtasks } from "@client/ai";
import { deleteTeam, getSelectedTeam, initializeTeamStore, listTeams, saveTeam, setSelectedTeam } from "./team-store.js";
import { cleanupDevelopRunWorktrees, cleanupTelemetryDevelopRunWorktrees, findLatestDevelopRunForConversation, getDevelopRunStatus, listDevelopWorktreeEntries, listDevelopWorktreeEntriesFromTelemetry, mergeDevelopRunToRealCheckout, resolvePendingApproval, startDevelopRun } from "./develop-runner.js";

interface PipelineRunRequest {
  task?: string;
  projectPath?: string;
  projectId?: string;
  providerBaseUrl?: string;
  providerModel?: string;
  providerApiKey?: string;
  providerId?: string;
  forceRefresh?: boolean;
  hardResync?: boolean;
  /** Продолжение существующего диалога — если не передан, стартует новый (см. §7 в pipeline-runner.ts). */
  conversationId?: string;
}

interface CompactPipelineRunStatusResponse {
  runId: string;
  status: PipelineRunStatus["status"];
  updatedAt: string;
  currentStageKey?: PipelineRunStatus["currentStageKey"];
  currentStageLabel?: PipelineRunStatus["currentStageLabel"];
  errorMessage?: string;
  result?: {
    answer?: {
      answerMode?: string;
      summary?: string;
      explanation?: string;
      warnings?: string[];
      synthesis?: string;
    };
    validation?: {
      status?: string;
      readinessScore?: number;
    };
    provider?: {
      model?: string;
    };
    stages?: Array<{
      key: string;
      label: string;
      status: string;
      details: string;
    }>;
    usage?: ProviderUsageSummary;
  };
}

interface EvalScenarioRequest {
  id?: string;
  task?: string;
  projectPath?: string;
}

interface EvalRunRequest {
  scenarios?: EvalScenarioRequest[];
  models?: string[];
  timeoutMs?: number;
}

interface BackgroundBaselineInfo {
  sameHeadRunId?: string;
  sameHeadRunStatus?: PipelineRunStatus["status"];
  baselineRunId?: string;
  latestBackgroundRunId?: string;
  baselineExactForHead: boolean;
  hasLocalOverlay: boolean;
  localOverlayChangeCount: number;
  backgroundSyncRecommended: boolean;
}

interface SaveProviderRequest {
  id?: string;
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  isActive?: boolean;
  isCurrent?: boolean;
}

interface SaveTeamRequest {
  id?: string;
  name?: string;
  researcherModel?: string;
  criticModel?: string;
  observerModel?: string;
  developerModel?: string;
  reviewerModel?: string;
  isSelected?: boolean;
}

interface SaveProjectRequest {
  id?: string;
  name?: string;
  description?: string;
  paths?: Array<{
    id?: string;
    name?: string;
    rootPath?: string;
  }>;
}

async function resolveProjectRecord(input: {
  projectId?: string | undefined;
  projectPath?: string | undefined;
}) {
  const requestedProjectId = input.projectId?.trim() || "";
  const requestedProjectPath = input.projectPath?.trim() ? normalizePath(path.resolve(input.projectPath.trim())) : "";
  let projectRecord = requestedProjectId ? await getProjectById(requestedProjectId) : null;

  if (!projectRecord && requestedProjectPath) {
    const projects = await listProjects();

    projectRecord = projects.find((project) =>
      project.paths.some((projectPath) => normalizePath(path.resolve(projectPath.rootPath)) === requestedProjectPath),
    ) ?? null;
  }

  return projectRecord;
}

function buildCompactPipelineRunStatus(status: PipelineRunStatus): CompactPipelineRunStatusResponse {
  return {
    runId: status.runId,
    status: status.status,
    updatedAt: status.updatedAt,
    ...(status.currentStageKey ? { currentStageKey: status.currentStageKey } : {}),
    ...(status.currentStageLabel ? { currentStageLabel: status.currentStageLabel } : {}),
    ...(status.errorMessage ? { errorMessage: status.errorMessage } : {}),
    ...(status.result
      ? {
          result: {
            ...(status.result.answer
              ? {
                  answer: {
                    ...(status.result.answer.answerMode ? { answerMode: status.result.answer.answerMode } : {}),
                    ...(status.result.answer.summary ? { summary: status.result.answer.summary } : {}),
                    ...(status.result.answer.explanation ? { explanation: status.result.answer.explanation } : {}),
                    ...(status.result.answer.warnings ? { warnings: status.result.answer.warnings } : {}),
                    ...(status.result.answer.synthesis ? { synthesis: status.result.answer.synthesis } : {}),
                  },
                }
              : {}),
            ...(status.result.validation
              ? {
                  validation: {
                    ...(status.result.validation.status ? { status: status.result.validation.status } : {}),
                    ...(typeof status.result.validation.readinessScore === "number"
                      ? { readinessScore: status.result.validation.readinessScore }
                      : {}),
                  },
                }
              : {}),
            ...(status.result.provider?.model
              ? {
                  provider: {
                    model: status.result.provider.model,
                  },
                }
              : {}),
            ...(status.result.usage ? { usage: status.result.usage } : {}),
            stages: status.stages.map((stage) => ({
              key: stage.key,
              label: stage.label,
              status: stage.status,
              details: stage.details,
            })),
          },
        }
      : {}),
  };
}

function buildEvalSummary(status: PipelineRunStatus | null, elapsedMs: number, model: string, scenario: EvalScenarioRequest) {
  return {
    scenarioId: scenario.id?.trim() || "scenario",
    task: scenario.task?.trim() || "",
    projectPath: scenario.projectPath?.trim() || "",
    model,
    elapsedMs,
    runId: status?.runId ?? null,
    status: status?.status ?? "failed",
    currentStageLabel: status?.currentStageLabel ?? null,
    answerMode: status?.result?.answer?.answerMode ?? null,
    synthesis: status?.result?.answer?.synthesis ?? null,
    summary: status?.result?.answer?.summary ?? null,
    explanation: status?.result?.answer?.explanation ?? null,
    warnings: status?.result?.answer?.warnings ?? [],
    validationStatus: status?.result?.validation?.status ?? null,
    validationReadiness: status?.result?.validation?.readinessScore ?? null,
    stageDetails: status?.stages.map((stage) => ({
      key: stage.key,
      status: stage.status,
      details: stage.details,
    })) ?? [],
    errorMessage: status?.errorMessage ?? null,
  };
}

export function createApp() {
  const app = Fastify({
    logger: true,
  });
  const appRootPath = process.cwd();
  const defaultProviderBaseUrl = process.env.CLIENT_PROVIDER_BASE_URL?.trim() || "";
  const defaultProviderModel = process.env.CLIENT_PROVIDER_MODEL?.trim() || "";
  const defaultProviderApiKey = process.env.CLIENT_PROVIDER_API_KEY?.trim() || "";

  app.register(cors, {
    origin: true,
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  });

  void bootstrapPipelineRunStatuses(appRootPath);

  app.addHook("onReady", async () => {
    await initializePostgresSchema();
    await initializeSecretCrypto(appRootPath);
    await initializeProviderStore();
    await initializeTeamStore();
    await initializeProjectStore();
    // Live incident (2026-07-15): Neo4j got OOM-killed by Docker's shared VM
    // memory ceiling more than once this session, and this call had no error
    // handling - a Neo4j outage at boot meant the WHOLE API failed to start,
    // not just the graph feature degrading. The persisted code graph is
    // already confirmed secondary (Task 25 investigation: it only feeds
    // Impact/Context side-panel metadata, not the actual agentic research
    // that produces the answer) - not worth being a single point of failure
    // for the rest of the app (Postgres/Redis/providers/teams/the real
    // pipeline) that don't depend on it at all.
    try {
      await initializeGraphStore();
    } catch (error) {
      app.log.warn({ err: error }, "[app] Neo4j graph store init failed - continuing without it (Impact/Context panels will degrade, the rest of the app is unaffected)");
    }
    startProjectStateMonitor({
      appRootPath,
      fallbackProviderBaseUrl: defaultProviderBaseUrl,
      fallbackProviderModel: defaultProviderModel,
      fallbackProviderApiKey: defaultProviderApiKey,
    });
    // Semantic code search index (2026-07-16) - background-only, like the
    // Observer's graph crawl: never blocks a live question, just opportunistically
    // keeps an embeddings index warm so semantic_search has something to query.
    startEmbeddingIndexer({
      fallbackProviderBaseUrl: defaultProviderBaseUrl,
      fallbackProviderApiKey: defaultProviderApiKey,
    });
    // Observer no longer auto-starts (2026-07-15) - it's a per-project
    // runner the user explicitly starts/stops, like a runner, not an
    // always-on background monitor. See /api/observer/*.
  });

  app.addHook("onClose", async () => {
    stopProjectStateMonitor();
    stopEmbeddingIndexer();
    stopAllObservers();
    await closeNeo4jDriver();
    await closePostgresPool();
    await closeRedisClient();
  });

  app.get("/api/health", async () => {
    const [neo4jConnected, postgresConnected, redisConnected] = await Promise.all([
      verifyNeo4jConnectivity(),
      verifyPostgresConnectivity(),
      verifyRedisConnectivity(),
    ]);
    return { status: "ok", now: new Date().toISOString(), neo4jConnected, postgresConnected, redisConnected };
  });

  app.get("/api/providers", async () => {
    const providers = await listProviders();
    const currentProvider = providers.find((provider) => provider.isCurrent) ?? null;
    const catalog = await fetchProviderModels(currentProvider?.id);

    return {
      providers,
      currentProvider,
      models: catalog.models,
      recommendedModelId: catalog.recommendedModelId,
    } satisfies ProviderCatalogResponse;
  });

  app.post<{ Body: SaveProviderRequest }>("/api/providers", async (request, reply) => {
    const name = request.body.name?.trim();
    const baseUrl = request.body.baseUrl?.trim();

    if (!name || !baseUrl) {
      return reply.code(400).send({
        message: "Нужно указать имя провайдера и base URL.",
      });
    }

    const provider = await saveProvider({
      ...(request.body.id?.trim() ? { id: request.body.id.trim() } : {}),
      name,
      baseUrl,
      apiKey: request.body.apiKey?.trim() || "",
      isActive: request.body.isActive ?? true,
      isCurrent: request.body.isCurrent ?? false,
    });

    return reply.code(200).send(provider);
  });

  app.post<{ Params: { id: string } }>("/api/providers/:id/select", async (request, reply) => {
    const provider = await setCurrentProvider(request.params.id);

    if (!provider) {
      return reply.code(404).send({
        message: "Провайдер не найден.",
      });
    }

    return provider;
  });

  app.post<{ Params: { id: string }; Body: { model?: string } }>("/api/providers/:id/default-model", async (request, reply) => {
    const model = request.body.model?.trim();

    if (!model) {
      return reply.code(400).send({
        message: "Нужно указать модель.",
      });
    }

    const provider = await setProviderDefaultModel(request.params.id, model);

    if (!provider) {
      return reply.code(404).send({
        message: "Провайдер не найден.",
      });
    }

    return provider;
  });

  app.delete<{ Params: { id: string } }>("/api/providers/:id", async (request, reply) => {
    const deleted = await deleteProvider(request.params.id);

    if (!deleted) {
      return reply.code(404).send({
        message: "Провайдер не найден.",
      });
    }

    return { ok: true };
  });

  app.get("/api/teams", async () => {
    const teams = await listTeams();
    const selectedTeam = teams.find((team) => team.isSelected) ?? null;

    return { teams, selectedTeam } satisfies TeamCatalogResponse;
  });

  // Global by design (2026-07-15, per direct request): shown the same way
  // in every chat regardless of which project is currently selected, not
  // scoped to one projectPath - the point is to see at a glance which
  // projects have a runner going right now.
  app.get("/api/observer/status", async () => {
    const projects = await listProjects();
    // Not normalized/resolved on purpose - matches the raw rootPath string
    // stored on the project record and used as-is throughout
    // observer-monitor.ts, so status/start/stop all agree on the same key.
    const allPaths = [...new Set(projects.flatMap((project) => project.paths.map((projectPath) => projectPath.rootPath)))];
    const runnerByPath = new Map(listObserverRunners().map((runner) => [runner.projectPath, runner]));

    const observers = await Promise.all(
      allPaths.map(async (projectPath) => {
        const runner = runnerByPath.get(projectPath);

        return {
          projectPath,
          status: runner?.status ?? ("stopped" as const),
          activity: runner?.activity ?? null,
          progress: await getObserverProgress(projectPath),
          resting: runner?.resting ?? false,
        };
      }),
    );

    return { observers } satisfies ObserverStatusResponse;
  });

  app.post<{ Body: { projectPath?: string } }>("/api/observer/start", async (request, reply) => {
    const projectPath = request.body.projectPath?.trim();

    if (!projectPath) {
      return reply.code(400).send({ message: "Нужно указать projectPath." });
    }

    startObserver(projectPath);
    return { ok: true };
  });

  app.post<{ Body: { projectPath?: string } }>("/api/observer/stop", async (request, reply) => {
    const projectPath = request.body.projectPath?.trim();

    if (!projectPath) {
      return reply.code(400).send({ message: "Нужно указать projectPath." });
    }

    stopObserver(projectPath);
    return { ok: true };
  });

  app.post("/api/observer/stop-all", async () => {
    const stopped = stopAllObservers();
    return { ok: true, stopped };
  });

  app.post<{ Body: SaveTeamRequest }>("/api/teams", async (request, reply) => {
    const name = request.body.name?.trim();

    if (!name) {
      return reply.code(400).send({
        message: "Нужно указать имя команды.",
      });
    }

    const team = await saveTeam({
      ...(request.body.id?.trim() ? { id: request.body.id.trim() } : {}),
      name,
      researcherModel: request.body.researcherModel?.trim() || "",
      criticModel: request.body.criticModel?.trim() || "",
      observerModel: request.body.observerModel?.trim() || "",
      developerModel: request.body.developerModel?.trim() || "",
      reviewerModel: request.body.reviewerModel?.trim() || "",
      isSelected: request.body.isSelected ?? false,
    });

    return reply.code(200).send(team);
  });

  app.post<{ Params: { id: string } }>("/api/teams/:id/select", async (request, reply) => {
    const team = await setSelectedTeam(request.params.id);

    if (!team) {
      return reply.code(404).send({
        message: "Команда не найдена.",
      });
    }

    return team;
  });

  app.delete<{ Params: { id: string } }>("/api/teams/:id", async (request, reply) => {
    const deleted = await deleteTeam(request.params.id);

    if (!deleted) {
      return reply.code(404).send({
        message: "Команда не найдена.",
      });
    }

    return { ok: true };
  });

  app.get("/api/projects", async () => {
    const projects = await listProjects();

    return {
      projects,
    } satisfies ProjectCatalogResponse;
  });

  app.post<{ Body: SaveProjectRequest }>("/api/projects", async (request, reply) => {
    const name = request.body.name?.trim();
    const paths = Array.isArray(request.body.paths) ? request.body.paths : [];

    if (!name) {
      return reply.code(400).send({
        message: "Нужно указать имя проекта.",
      });
    }

    if (!paths.length) {
      return reply.code(400).send({
        message: "Нужно добавить хотя бы один путь проекта.",
      });
    }

    try {
      const project = await saveProject({
        ...(request.body.id?.trim() ? { id: request.body.id.trim() } : {}),
        name,
        description: request.body.description?.trim() || "",
        paths: paths.map((item) => ({
          ...(item.id?.trim() ? { id: item.id.trim() } : {}),
          name: item.name?.trim() || "",
          rootPath: item.rootPath?.trim() || "",
        })),
      });

      return reply.code(200).send(project);
    } catch (error) {
      return reply.code(400).send({
        message: error instanceof Error ? error.message : "Не удалось сохранить проект.",
      });
    }
  });

  app.delete<{ Params: { id: string } }>("/api/projects/:id", async (request, reply) => {
    const deleted = await deleteProject(request.params.id);

    if (!deleted) {
      return reply.code(404).send({
        message: "Проект не найден.",
      });
    }

    return { ok: true };
  });

  app.get<{
    Querystring: {
      projectId?: string;
      projectPath?: string;
    };
  }>("/api/project", async (request, reply) => {
    const projectRecord = await resolveProjectRecord({
      projectId: request.query.projectId,
      projectPath: request.query.projectPath,
    });
    const projectPath = request.query.projectPath?.trim() || projectRecord?.paths[0]?.rootPath || appRootPath;

    if (request.query.projectId?.trim() && !projectRecord && !request.query.projectPath?.trim()) {
      return reply.code(404).send({
        message: "Проект не найден.",
      });
    }

    const overview = await scanWorkspaceOverview(projectPath);
    // background-sync — это фоновая пересборка project intelligence, инициированная
    // системой, а не пользователем. Она гоняет служебную фразу через тот же pipeline
    // ради обновления графа/знаний, но не должна маскироваться под реальный чат:
    // у неё уже есть отдельный канал уведомления через backgroundState/пилюлю статуса.
    const recentRuns = (await loadKnowledgeCatalog(appRootPath, overview.rootPath)).filter(
      (entry) => entry.mode !== "background-sync",
    );
    const latestRun = await loadLatestPipelineRunArtifact(appRootPath, overview.rootPath);
    const latestBackgroundRun = await loadLatestBackgroundRunCatalogEntry(appRootPath, overview.rootPath);
    const repositoryWorkspace = await openWorkspaceSelective(projectPath, {
      includePaths: [],
      maxFiles: 0,
    });
    const repository = await inspectRepository(repositoryWorkspace);
    // Каталожные метаданные вместо полного артефакта (2026-07-16) — этот
    // GET-статус дёргается UI регулярно, а background-sync артефакт ~120MB;
    // см. loadBestBaselineCatalogEntry в packages/knowledge.
    const baselineSelection = await loadBestBaselineCatalogEntry(appRootPath, overview.rootPath, repository);
    const backgroundState = buildBackgroundProjectState({
      projectId: overview.projectId,
      projectRootPath: overview.rootPath,
      repository,
      latestRunId: latestBackgroundRun?.runId ?? null,
      baselineRun: catalogEntryToBaselineMetadata(baselineSelection.entry),
      baselineSource: baselineSelection.source,
    });
    const activeBackgroundRun = findActivePipelineRun(projectPath, "background-sync");
    const sameHeadRun = findPipelineRunByRepositoryHead({
      projectPath,
      mode: "background-sync",
      headFingerprint: repository.headFingerprint,
    });

    return {
      projectRecord,
      name: overview.projectName,
      rootPath: overview.rootPath,
      summary: overview.summary,
      recentRuns,
      latestRun,
      repository,
      backgroundState,
      activeBackgroundRun,
      baselineInfo: {
        ...(sameHeadRun ? { sameHeadRunId: sameHeadRun.runId, sameHeadRunStatus: sameHeadRun.status } : {}),
        ...(backgroundState.baselineRunId ? { baselineRunId: backgroundState.baselineRunId } : {}),
        ...(backgroundState.latestRunId ? { latestBackgroundRunId: backgroundState.latestRunId } : {}),
        baselineExactForHead: backgroundState.baselineExactForHead,
        hasLocalOverlay: backgroundState.hasLocalChanges,
        localOverlayChangeCount: backgroundState.changedFileCount,
        backgroundSyncRecommended:
          !backgroundState.baselineExactForHead
          && !backgroundState.hasLocalChanges
          && sameHeadRun?.status !== "queued"
          && sameHeadRun?.status !== "running",
      } satisfies BackgroundBaselineInfo,
    };
  });

  app.get<{
    Querystring: {
      projectPath?: string;
      runId?: string;
    };
  }>("/api/runs/selected", async (request, reply) => {
    const projectPath = request.query.projectPath?.trim() || "";
    const runId = request.query.runId?.trim();

    if (!runId) {
      return reply.code(400).send({
        message: "Нужно указать runId.",
      });
    }

    // Без явного projectPath запрос ранее тихо уходил в appRootPath и мог
    // вернуть run из совершенно другого проекта (тот самый cross-project leak) —
    // лучше явная ошибка, чем ответ не по адресу.
    if (!projectPath) {
      return reply.code(400).send({
        message: "Нужно явно передать projectPath.",
      });
    }

    const normalizedProjectPath = normalizePath(path.resolve(projectPath));

    const artifact = await loadPipelineRunArtifact(appRootPath, normalizedProjectPath, runId);

    if (!artifact) {
      return reply.code(404).send({
        message: "Запуск не найден.",
      });
    }

    return artifact;
  });

  app.get<{
    Querystring: {
      projectPath?: string;
      conversationId?: string;
    };
  }>("/api/runs/conversation", async (request, reply) => {
    const projectPath = request.query.projectPath?.trim() || "";
    const conversationId = request.query.conversationId?.trim();

    if (!conversationId) {
      return reply.code(400).send({
        message: "Нужно указать conversationId.",
      });
    }

    if (!projectPath) {
      return reply.code(400).send({
        message: "Нужно явно передать projectPath.",
      });
    }

    const normalizedProjectPath = normalizePath(path.resolve(projectPath));
    const turns = await loadConversationTurns(appRootPath, normalizedProjectPath, conversationId);

    if (turns.length === 0) {
      return reply.code(404).send({
        message: "Диалог не найден.",
      });
    }

    return { conversationId, turns } satisfies ConversationTurnsResponse;
  });

  /**
   * Удаление чатов (run/history entries) — одного или пачкой.
   * projectPath передаётся явно и обязательно: удаление деструктивно,
   * поэтому здесь намеренно нет fallback на appRootPath — лучше явная
   * ошибка 400, чем риск удалить чаты не того проекта.
   */
  app.post<{
    Body: {
      projectPath?: string;
      runIds?: string[];
    };
  }>("/api/runs/delete", async (request, reply) => {
    const runIds = Array.isArray(request.body.runIds)
      ? request.body.runIds.map((id) => id.trim()).filter(Boolean)
      : [];

    if (!runIds.length) {
      return reply.code(400).send({
        message: "Нужно указать хотя бы один runId для удаления.",
      });
    }

    const explicitProjectPath = request.body.projectPath?.trim() || "";

    if (!explicitProjectPath) {
      return reply.code(400).send({
        message: "Нужно явно передать projectPath, чтобы не удалить чаты не того проекта.",
      });
    }

    const normalizedProjectPath = normalizePath(path.resolve(explicitProjectPath));
    const result = await deleteKnowledgeRuns(appRootPath, normalizedProjectPath, runIds);

    return { ok: true, ...result };
  });

  app.get<{
    Querystring: {
      runId?: string;
      compact?: string;
    };
  }>("/api/pipeline/status", async (request, reply) => {
    const runId = request.query.runId?.trim();

    if (!runId) {
      return reply.code(400).send({
        message: "Нужно указать runId.",
      });
    }

    const status = await loadPipelineRunStatus(appRootPath, runId);

    if (!status) {
      return reply.code(404).send({
        message: "Статус запуска не найден.",
      });
    }

    const compactRequested =
      request.query.compact === "1"
      || request.query.compact === "true"
      || request.query.compact === "yes";

    return compactRequested ? buildCompactPipelineRunStatus(status) : status;
  });

  app.post<{ Body: PipelineRunRequest }>("/api/pipeline/run", async (request, reply) => {
    const task = request.body.task?.trim();

    if (!task) {
      return reply.code(400).send({
        message: "Нужно указать задачу.",
      });
    }

    const explicitProjectPath = request.body.projectPath?.trim() || "";
    const explicitProviderBaseUrl = request.body.providerBaseUrl?.trim() || "";
    const explicitProviderModel = request.body.providerModel?.trim() || "";
    const explicitProviderApiKey = request.body.providerApiKey?.trim() || "";

    if (!request.body.projectId?.trim() && !explicitProjectPath) {
      return reply.code(400).send({
        message: "Нужно выбрать проект перед отправкой вопроса. Ни projectId, ни projectPath не переданы.",
      });
    }

    let projectRecord = null;

    if (request.body.projectId?.trim()) {
      try {
        projectRecord = await resolveProjectRecord({
          projectId: request.body.projectId,
          projectPath: request.body.projectPath,
        });
      } catch (error) {
        if (!explicitProjectPath) {
          request.log.error(error);
          return reply.code(500).send({
            message: "Не удалось загрузить проект из хранилища.",
          });
        }
      }

      if (!projectRecord && !explicitProjectPath) {
        return reply.code(404).send({
          message: "Проект с указанным projectId не найден и projectPath не передан. Вопрос не выполнен, чтобы не отвечать по неверному проекту.",
        });
      }
    }

    const projectPath = request.body.projectPath?.trim() || projectRecord?.paths[0]?.rootPath || appRootPath;
    let currentProvider = null;
    let selectedProvider = null;
    let effectiveProvider = null;

    const needsProviderStoreLookup =
      (!explicitProviderBaseUrl || !explicitProviderApiKey)
      || Boolean(request.body.providerId?.trim());

    if (needsProviderStoreLookup) {
      try {
        currentProvider = await getCurrentProvider();
        selectedProvider = request.body.providerId?.trim() ? await setCurrentProvider(request.body.providerId.trim()) : null;
        effectiveProvider = request.body.providerId?.trim()
          ? await getCurrentProvider()
          : currentProvider;
        void selectedProvider;
      } catch (error) {
        if (!explicitProviderBaseUrl || !explicitProviderApiKey) {
          request.log.error(error);
          return reply.code(500).send({
            message: "Не удалось загрузить AI provider из хранилища.",
          });
        }
      }
    }

    const providerBaseUrl = explicitProviderBaseUrl || effectiveProvider?.baseUrl || defaultProviderBaseUrl;
    // effectiveProvider?.defaultModel — персистентный выбор модели в БД (см.
    // provider-store.ts). Раньше эта ветка отсутствовала: выбор модели никогда
    // не читался из БД и всегда падал на CLIENT_PROVIDER_MODEL из .env, если
    // вызывающая сторона явно не передала providerModel в теле запроса.
    const providerModel = explicitProviderModel || effectiveProvider?.defaultModel || defaultProviderModel;
    const providerApiKey = explicitProviderApiKey || effectiveProvider?.apiKey || defaultProviderApiKey;
    const mode: PipelineRunMode = request.body.hardResync
      ? "hard-resync"
      : request.body.forceRefresh
        ? "background-sync"
        : "question-run";
    const normalizedTask = request.body.hardResync
      ? `Операторский хард ресинк project intelligence.\n\nОригинальная задача: ${task}`
      : request.body.forceRefresh
      ? `Принудительно пересобери branch-aware project intelligence.\n\nОригинальная задача: ${task}`
      : task;
    // Declared here, not inside the question-run block below, because it
    // needs to reach enqueuePipelineRun() further down - classifyChatIntent
    // runs before any run object exists, so this is the only place its real
    // cost can be captured and carried forward (see PipelineExecutionRequest.preludeUsage).
    let chatIntentUsage: ReturnType<typeof createUsageAccumulator> | null = null;

    // Chat intent routing (docs/architecture/011-developer-pipeline.md):
    // пользователь пишет в ОДИН чат и вопросы, и задачи разработки, и
    // корректировки уже сделанного — различает их система. Только для
    // обычного question-run (системные resync/refresh — не разработка) и
    // только при выбранной Team. Любой сбой роутинга безопасно откатывается
    // в обычный Q&A-путь.
    if (mode === "question-run") {
      try {
        const selectedTeam = await getSelectedTeam();

        if (selectedTeam && providerBaseUrl && providerApiKey) {
          const conversationKey = request.body.conversationId?.trim() || "";
          const priorDevelop = conversationKey ? findLatestDevelopRunForConversation(conversationKey) : null;
          // Path-scoped chat directives for the Developer pipeline (2026-07-18,
          // explicit product-owner directive: "делай только фронт"/"только
          // бек"/"только gui" must not silently leave the Developer able to
          // touch every repo). The Q&A pipeline already has this
          // (classifyProjectScopeDirective, pipeline-runner.ts) but it was
          // never wired here - a multi-root develop task always got a
          // worktree for EVERY registered path regardless of what the user
          // said, relying purely on the model's own judgment not to wander
          // into repos nobody asked about. Filtering projectPaths BEFORE
          // createTaskWorktree runs means the Developer has no worktree for
          // an excluded repo at all - it cannot see or edit it, not "was
          // asked nicely not to" (same "не полагаться на послушание модели"
          // stance as every other deterministic gate in this pipeline).
          // A continuation (needs-clarification/needs-approval/tests-offer
          // reply, develop-correction) must keep EXACTLY the scope the
          // original run already committed to, never re-classify from the
          // reply text - a bare "да"/"нет" obviously doesn't restate scope
          // and would otherwise reset to "all repos", which both breaks
          // executeDevelopRun's worktree-reuse match (continueFrom.worktrees
          // length must equal this run's root count) and silently defeats
          // whatever restriction the user originally gave.
          const priorWorktreeLabels = priorDevelop?.worktrees.length
            ? new Set(priorDevelop.worktrees.map((worktree) => worktree.label))
            : null;
          const scopeDirective = !priorWorktreeLabels && projectRecord && projectRecord.paths.length > 1
            ? await classifyProjectScopeDirective({
                task,
                providerBaseUrl,
                providerModel: selectedTeam.criticModel,
                providerApiKey,
                roots: projectRecord.paths.map((pathRecord) => ({ label: pathRecord.name, role: pathRecord.role })),
              })
            : { restricted: false, allowedLabels: [] as string[] };
          const effectiveProjectPaths = priorWorktreeLabels
            ? projectRecord?.paths.filter((pathRecord) => priorWorktreeLabels.has(pathRecord.name))
            : scopeDirective.restricted
              ? projectRecord?.paths.filter((pathRecord) => scopeDirective.allowedLabels.includes(pathRecord.name))
              : projectRecord?.paths;
          const developInputBase = {
            projectPath: normalizePath(path.resolve(projectPath)),
            ...(effectiveProjectPaths?.length ? { projectPaths: effectiveProjectPaths } : {}),
            providerBaseUrl,
            providerApiKey,
            developerModel: selectedTeam.developerModel,
            reviewerModel: selectedTeam.reviewerModel,
            ...(conversationKey ? { conversationId: conversationKey } : {}),
          };

          if (priorDevelop?.status === "running") {
            return reply.code(409).send({
              message: "По этому диалогу ещё выполняется задача разработки — дождись её завершения, прежде чем отправлять следующее сообщение.",
            });
          }

          // DB safety (2026-07-18): ответ на запрос апрува чувствительной
          // команды — та же схема, что и needs-clarification (продолжение без
          // классификации намерения, диалог сам только что спросил), но
          // разрешение конкретно да/нет/непонятно, fail-closed на "непонятно"
          // (никогда не выполняем миграцию без однозначного согласия).
          if (priorDevelop?.result?.stopped === "needs-approval" && priorDevelop.result.pendingApproval) {
            const pendingApproval = priorDevelop.result.pendingApproval;
            const decision = await classifyApprovalResponse({
              message: task,
              pendingCommand: pendingApproval.command,
              pendingReason: pendingApproval.reason,
              providerBaseUrl,
              providerModel: selectedTeam.criticModel,
              providerApiKey,
            });

            if (decision === "unclear") {
              // Fail-closed (2026-07-18): re-emit the SAME still-pending record
              // rather than guessing - reuses the develop-kind shape the
              // frontend already knows how to render (pendingApproval card),
              // instead of inventing a response shape it cannot display.
              return reply.code(200).send({ kind: "develop", ...priorDevelop });
            }

            const resolvedAction = await resolvePendingApproval(pendingApproval, priorDevelop.worktrees, decision);
            const composedTask = decision === "approved"
              ? `${priorDevelop.task}\n\nПользователь ПОДТВЕРДИЛ выполнение команды "${resolvedAction.command}". Она выполнена: exit code ${resolvedAction.exitCode ?? "?"}. Продолжи задачу, учитывая результат.`
              : `${priorDevelop.task}\n\nПользователь ОТКЛОНИЛ выполнение команды "${resolvedAction.command}". Продолжи задачу БЕЗ неё — либо предложи альтернативный путь, либо честно опиши в итоговом summary, что это заблокировано и требует ручного вмешательства.`;
            const status = startDevelopRun({
              ...developInputBase,
              task: composedTask,
              continueFrom: {
                worktrees: priorDevelop.worktrees,
                priorTask: priorDevelop.task,
                priorSummary: priorDevelop.result?.summary ?? "",
                priorSensitiveActions: [
                  ...(priorDevelop.result.sensitiveActions ?? []).filter((entry) => !(entry.status === "pending" && entry.command === resolvedAction.command)),
                  resolvedAction,
                ],
              },
            });
            return reply.code(202).send({ kind: "develop", ...status });
          }

          // Ответ на уточняющий вопрос Developer'а — продолжение разработки
          // без классификации: система сама только что спросила.
          if (priorDevelop?.result?.stopped === "needs-clarification") {
            const composedTask = [
              priorDevelop.task,
              "",
              `Ответ пользователя на уточняющий вопрос («${priorDevelop.result.clarificationQuestion ?? ""}»): ${task}`,
            ].join("\n");
            const status = startDevelopRun({
              ...developInputBase,
              task: composedTask,
              continueFrom: {
                worktrees: priorDevelop.worktrees,
                priorTask: priorDevelop.task,
                priorSummary: priorDevelop.result?.summary ?? "",
              },
            });
            return reply.code(202).send({ kind: "develop", ...status });
          }

          // "Занеси в текущую ветку" / "почисти ворктри" (2026-07-18,
          // explicit product-owner request): unlike the tests-offer
          // question above, these are not a one-shot window tied to the
          // message right after completion - the user may ask at any
          // point while a delivered run's worktrees still exist, so this
          // checks on every message in that state rather than being
          // consumed once. The cheap keyword pre-filter inside
          // classifyPostCompletionCommand keeps this from costing an LLM
          // call on the common case (an unrelated new question/task).
          if (priorDevelop?.status === "completed" && priorDevelop.worktrees.length > 0) {
            const postCompletionAction = await classifyPostCompletionCommand({
              message: task,
              providerBaseUrl,
              providerModel: selectedTeam.criticModel,
              providerApiKey,
            });

            if (postCompletionAction === "merge-to-branch") {
              const outcomes = await mergeDevelopRunToRealCheckout(priorDevelop.worktrees);
              // Stored on the record too (2026-07-18) - same field the
              // button/auto-merge paths write, so the Developer message
              // card can show "занесено ✓" without the user re-asking.
              priorDevelop.autoMergeOutcome = outcomes;
              const allApplied = outcomes.every((outcome) => outcome.applied);
              const lines = outcomes.map((outcome) =>
                outcome.applied
                  ? `✓ ${outcome.label}: применено (${outcome.changedFiles.length} файл(ов)) — незакоммичено, смотри diff в IDE.`
                  : `✗ ${outcome.label}: не применилось — ${outcome.error ?? "неизвестная ошибка"}`,
              );
              const message = [allApplied ? "Занёс в текущую ветку:" : "Частично не удалось занести:", ...lines].join("\n");
              return reply.code(200).send({ kind: "question", answer: { summary: message, explanation: message } });
            }

            if (postCompletionAction === "cleanup-worktree") {
              await cleanupDevelopRunWorktrees(priorDevelop);
              const message = "Ворктри и служебные ветки этой задачи убраны.";
              return reply.code(200).send({ kind: "question", answer: { summary: message, explanation: message } });
            }
          }

          // Tests-as-separate-step (2026-07-18, docs/architecture/011
          // §4.12): the completed run's summary just asked "покрыть
          // тестами?" - classify THIS message as an answer to that specific
          // question before treating it as a normal chat message. Consumed
          // exactly once regardless of outcome (even "unclear") by flipping
          // testsOffered back off, so a later unrelated message never gets
          // re-interpreted as answering a stale question.
          if (priorDevelop?.status === "completed" && priorDevelop.testsOffered) {
            priorDevelop.testsOffered = false;

            const offerResponse = await classifyTestsOffer({
              message: task,
              task: priorDevelop.task,
              providerBaseUrl,
              providerModel: selectedTeam.criticModel,
              providerApiKey,
            });

            if (offerResponse?.wantsTests) {
              const testsTask = [
                `Напиши тесты для уже сделанного и одобренного изменения: "${priorDevelop.task}"`,
                `Что было сделано: "${(priorDevelop.result?.summary ?? "").slice(0, 1200)}"`,
                ...(offerResponse.scope ? [`Пользователь уточнил охват: ${offerResponse.scope}`] : []),
              ].join("\n");
              const status = startDevelopRun({
                ...developInputBase,
                task: testsTask,
                continueFrom: {
                  worktrees: priorDevelop.worktrees,
                  priorTask: priorDevelop.task,
                  priorSummary: priorDevelop.result?.summary ?? "",
                },
              });
              return reply.code(202).send({ kind: "develop", ...status });
            }

            if (offerResponse && !offerResponse.wantsTests) {
              return reply.code(200).send({ kind: "question", answer: { summary: "Хорошо, без тестов.", explanation: "Хорошо, без тестов." } });
            }
            // offerResponse === null - not actually an answer to the offer,
            // fall through to normal classification below.
          }

          // Real cost, spent before any run object exists to attach it to
          // (2026-07-18, live user report - "Подробнее" showed too few
          // tokens because this call was invisible to the eventual run's
          // usage total). Assigned to the outer-scope variable declared
          // above so it survives to the enqueuePipelineRun() call further
          // down, once we know the outcome is actually "question".
          chatIntentUsage = createUsageAccumulator();
          const intent = await classifyChatIntent({
            task,
            providerBaseUrl,
            providerModel: selectedTeam.criticModel,
            providerApiKey,
            usage: chatIntentUsage,
            ...(priorDevelop?.status === "completed"
              ? { priorDevelop: { task: priorDevelop.task, summary: priorDevelop.result?.summary ?? "" } }
              : {}),
          });

          if (intent === "develop" || intent === "develop-correction") {
            // Bug-debug flow (2026-07-18): a bug report reads as a plain
            // question ("не работает X", "почему Y") and gets diagnosed by
            // the normal Q&A pipeline (looksLikeDiagnosticTask already routes
            // it to evidence-locked diagnostic-answer mode); a follow-up
            // "какие варианты фикса?" is ALSO just a question, answered with
            // a numbered plan (looksLikeChangeTask extended for this). Only
            // the explicit go-ahead ("делай пункт 2", ...) is an imperative
            // and classifies as "develop" here - but a bare "делай пункт 2"
            // means nothing to the Developer without the diagnosis/options
            // that were actually shown. This carries the immediately prior
            // Q&A turn in the SAME conversation forward as context, so the
            // Developer sees the root cause and the option the user picked -
            // never fires without this classifier's explicit "develop"
            // verdict, so a plain question or a fix-options question still
            // never touches code on its own.
            let composedTask = task;

            if (intent === "develop" && conversationKey) {
              try {
                const priorTurn = await loadLatestConversationTurn(appRootPath, normalizePath(path.resolve(projectPath)), conversationKey);

                if (priorTurn) {
                  composedTask = [
                    `Предыдущее сообщение в этом диалоге: "${priorTurn.research.task}"`,
                    `Ответ на него: "${(priorTurn.answer.explanation || priorTurn.answer.summary).slice(0, 1500)}"`,
                    "",
                    `Текущее сообщение пользователя: "${task}"`,
                  ].join("\n");
                }
              } catch {
                // Prior-turn context is an enrichment, never a dependency.
              }
            }

            // "И сразу занеси это в ветку" said inside THIS message
            // (2026-07-18, see classifyAutoMergeIntent) - fired here, in
            // parallel with decomposition below, against the user's raw
            // message (not composedTask, which may carry prior-turn context
            // that would dilute the signal). Only for a fresh task, same
            // scoping as decomposition - a correction round already has an
            // existing autoMergeOnCompletion on priorDevelop if the original
            // task asked for it, and re-classifying a correction's own text
            // would incorrectly require the user to repeat the instruction
            // on every follow-up.
            const autoMergeIntentPromise = intent === "develop"
              ? classifyAutoMergeIntent({ taskMessage: task, providerBaseUrl, providerModel: selectedTeam.criticModel, providerApiKey })
              : Promise.resolve(false);

            // Task decomposition (2026-07-18, docs/architecture/011 §4.11):
            // only for a FRESH task, never a correction round (a correction
            // is already scoped to what was just delivered - decomposing it
            // further would just fragment review feedback). Fails closed to
            // a single step (planDevelopSubtasks itself already returns
            // [task] on any classification failure), so this can never
            // block a develop task from starting.
            let chain: { chainRemaining: string[]; chainInfo: { subtaskIndex: number; totalSubtasks: number } } | undefined;

            if (intent === "develop") {
              try {
                const subtasks = await planDevelopSubtasks({
                  task: composedTask,
                  providerBaseUrl,
                  providerModel: selectedTeam.criticModel,
                  providerApiKey,
                });

                if (subtasks.length >= 2) {
                  composedTask = subtasks[0] as string;
                  chain = {
                    chainRemaining: subtasks.slice(1),
                    chainInfo: { subtaskIndex: 0, totalSubtasks: subtasks.length },
                  };
                }
              } catch {
                // Decomposition is an optimization, never a dependency.
              }
            }

            const autoMergeOnCompletion = intent === "develop"
              ? await autoMergeIntentPromise
              // A correction round carries the ORIGINAL run's intent forward
              // (2026-07-18) - otherwise "занеси в ветку" said once on the
              // first message would silently stop applying the moment the
              // Reviewer asked for a fix, and the user would have to repeat
              // it on every correction.
              : Boolean(priorDevelop?.autoMergeOnCompletion);

            const shouldContinueExistingWorktree = Boolean(priorDevelop?.worktrees.length);
            const status = startDevelopRun({
              ...developInputBase,
              task: composedTask,
              ...(chain ? chain : {}),
              ...(autoMergeOnCompletion ? { autoMergeOnCompletion: true } : {}),
              ...((intent === "develop-correction" || shouldContinueExistingWorktree) && priorDevelop
                ? {
                    continueFrom: {
                      worktrees: priorDevelop.worktrees,
                      priorTask: priorDevelop.task,
                      priorSummary: priorDevelop.result?.summary ?? "",
                    },
                  }
                : {}),
            });
            return reply.code(202).send({ kind: "develop", ...status });
          }
        }
      } catch (error) {
        request.log.warn(error, "chat intent routing failed - falling back to the question pipeline");
      }
    }

    if (mode === "background-sync") {
      const repositoryWorkspace = await openWorkspaceSelective(projectPath, {
        includePaths: [],
        maxFiles: 0,
      });
      const repository = await inspectRepository(repositoryWorkspace);

      if (repository.isDirty) {
        return reply.code(409).send({
          message: "Фоновый sync собирает committed baseline и не запускается при локальных незакоммиченных изменениях. Для текущих правок используй обычный вопрос в чате или сначала зафиксируй/stash изменения.",
        });
      }

      const sameHeadActiveRun = findPipelineRunByRepositoryHead({
        projectPath,
        mode: "background-sync",
        headFingerprint: repository.headFingerprint,
        statuses: ["queued", "running"],
      });

      if (sameHeadActiveRun) {
        return reply.code(202).send(sameHeadActiveRun);
      }
    }

    if (mode === "hard-resync") {
      const sameHardResyncRun = findActivePipelineRun(projectPath, "hard-resync");

      if (sameHardResyncRun) {
        return reply.code(202).send(sameHardResyncRun);
      }
    }

    const runId = stableId(["run", mode, projectPath, normalizedTask, Date.now()]);
    // Пустой/отсутствующий conversationId — новый тред, стартующий с этой
    // реплики (её runId и становится conversationId, см. соглашение в
    // normalizePipelineRunArtifact для обратной совместимости старых артефактов).
    const conversationId = request.body.conversationId?.trim() || runId;
    const acceptedStatus = enqueuePipelineRun({
      runId,
      mode,
      conversationId,
      task: normalizedTask,
      projectPath,
      ...(projectRecord?.paths.length ? { projectPaths: projectRecord.paths } : {}),
      providerBaseUrl,
      providerModel,
      providerApiKey,
      appRootPath,
      ...(chatIntentUsage && chatIntentUsage.callCount > 0
        ? {
            preludeUsage: {
              promptTokens: chatIntentUsage.promptTokens,
              completionTokens: chatIntentUsage.completionTokens,
              callCount: chatIntentUsage.callCount,
            },
          }
        : {}),
    });

    return reply.code(202).send(acceptedStatus);
  });

  // Developer pipeline (docs/architecture/011-developer-pipeline.md):
  // change-задача -> изолированный worktree -> Developer-цикл -> Reviewer ->
  // diff человеку. 202 + poll по /api/develop/status, как у pipeline/run.
  app.post<{
    Body: {
      task?: string;
      projectPath?: string;
      projectId?: string;
    };
  }>("/api/develop/run", async (request, reply) => {
    const task = request.body.task?.trim();

    if (!task) {
      return reply.code(400).send({ message: "Нужно указать задачу разработки." });
    }

    if (!request.body.projectId?.trim() && !request.body.projectPath?.trim()) {
      return reply.code(400).send({ message: "Нужно выбрать проект: ни projectId, ни projectPath не переданы." });
    }

    let projectRecord = null;

    if (request.body.projectId?.trim()) {
      try {
        projectRecord = await resolveProjectRecord({
          projectId: request.body.projectId,
          projectPath: request.body.projectPath,
        });
      } catch (error) {
        request.log.error(error);
      }

      if (!projectRecord && !request.body.projectPath?.trim()) {
        return reply.code(404).send({ message: "Проект с указанным projectId не найден и projectPath не передан." });
      }
    }

    const projectPath = request.body.projectPath?.trim() || projectRecord?.paths[0]?.rootPath || "";

    if (!projectPath) {
      return reply.code(400).send({ message: "Не удалось определить путь проекта." });
    }

    let provider = null;

    try {
      provider = await getCurrentProvider();
    } catch (error) {
      request.log.error(error);
    }

    const providerBaseUrl = provider?.baseUrl || defaultProviderBaseUrl;
    const providerApiKey = provider?.apiKey || defaultProviderApiKey;

    if (!providerBaseUrl || !providerApiKey) {
      return reply.code(409).send({ message: "AI provider не настроен — разработка требует настроенного провайдера." });
    }

    const selectedTeam = await getSelectedTeam().catch(() => null);

    if (!selectedTeam) {
      return reply.code(409).send({ message: "Не выбрана Team — Developer использует researcher-модель команды, Reviewer — critic-модель." });
    }

    const status = startDevelopRun({
      task,
      projectPath: normalizePath(path.resolve(projectPath)),
      ...(projectRecord?.paths.length ? { projectPaths: projectRecord.paths } : {}),
      providerBaseUrl,
      providerApiKey,
      developerModel: selectedTeam.developerModel,
      reviewerModel: selectedTeam.reviewerModel,
    });

    return reply.code(202).send(status);
  });

  app.get<{ Querystring: { runId?: string } }>("/api/develop/status", async (request, reply) => {
    const runId = request.query.runId?.trim();

    if (!runId) {
      return reply.code(400).send({ message: "Нужно указать runId." });
    }

    const status = getDevelopRunStatus(runId);

    if (!status) {
      return reply.code(404).send({ message: "Статус разработки не найден (после перезапуска сервера статусы живут только в телеметрии developer_runs)." });
    }

    return status;
  });

  app.get<{ Querystring: { projectPath?: string; conversationId?: string } }>("/api/develop/worktrees", async (request, reply) => {
    const projectPath = request.query.projectPath?.trim()
      ? normalizePath(path.resolve(request.query.projectPath.trim()))
      : "";
    const conversationId = request.query.conversationId?.trim() || "";

    const liveEntries = listDevelopWorktreeEntries({
      ...(projectPath ? { projectPath } : {}),
      ...(conversationId ? { conversationId } : {}),
    });
    const telemetryEntries = await listDevelopWorktreeEntriesFromTelemetry({
      ...(projectPath ? { projectPath } : {}),
      ...(conversationId ? { conversationId } : {}),
    }).catch(() => []);

    const merged = new Map<string, ReturnType<typeof listDevelopWorktreeEntries>[number]>();
    for (const entry of telemetryEntries) {
      merged.set(entry.runId, entry);
    }
    for (const entry of liveEntries) {
      merged.set(entry.runId, entry);
    }

    return reply.send({
      entries: [...merged.values()].sort((left, right) => right.startedAt.localeCompare(left.startedAt)),
    });
  });

  // Button counterparts of the "занеси в ветку"/"почисти ворктри" chat
  // commands (2026-07-18, explicit product-owner request: "и через чат и
  // через кнопку") - same underlying functions, called directly by runId
  // instead of going through classifyPostCompletionCommand, so a button
  // click never depends on message classification succeeding.
  // `label` scopes the action to ONE physical repo of a multi-root run
  // (2026-07-19, live user request - a 4-path run's panel had a single
  // shared button pair acting on all 4 worktrees at once). Omitted `label`
  // keeps acting on everything, same as before.
  app.post<{ Body: { runId?: string; label?: string } }>("/api/develop/merge-to-checkout", async (request, reply) => {
    const runId = request.body.runId?.trim();
    const label = request.body.label?.trim() || undefined;

    if (!runId) {
      return reply.code(400).send({ message: "Нужно указать runId." });
    }

    const record = getDevelopRunStatus(runId);

    if (!record) {
      return reply.code(404).send({ message: "Run не найден (после перезапуска сервера статусы не сохраняются)." });
    }

    const targets = label ? record.worktrees.filter((worktree) => worktree.label === label) : record.worktrees;

    if (targets.length === 0) {
      return reply.code(409).send({ message: "У этого run'а больше нет worktree — уже занесено и очищено, либо ничего не менялось." });
    }

    const outcomes = await mergeDevelopRunToRealCheckout(targets);
    // Merge into the existing outcome list rather than overwrite it - a
    // per-label merge must not erase what other labels already recorded.
    const outcomeByLabel = new Map((record.autoMergeOutcome ?? []).map((outcome) => [outcome.label, outcome]));
    for (const outcome of outcomes) {
      outcomeByLabel.set(outcome.label, outcome);
    }
    record.autoMergeOutcome = [...outcomeByLabel.values()];
    return reply.send({ outcomes });
  });

  app.post<{ Body: { runId?: string; label?: string } }>("/api/develop/cleanup-worktree", async (request, reply) => {
    const runId = request.body.runId?.trim();
    const label = request.body.label?.trim() || undefined;

    if (!runId) {
      return reply.code(400).send({ message: "Нужно указать runId." });
    }

    const record = getDevelopRunStatus(runId);

    if (!record) {
      const cleaned = await cleanupTelemetryDevelopRunWorktrees(runId, label);

      if (!cleaned) {
        return reply.code(404).send({ message: "Run не найден ни в памяти, ни в telemetry developer_runs." });
      }

      return reply.send({ ok: true });
    }

    await cleanupDevelopRunWorktrees(record, label);
    return reply.send({ ok: true });
  });

  app.post<{ Body: EvalRunRequest }>("/api/pipeline/eval", async (request, reply) => {
    const scenarios = Array.isArray(request.body.scenarios)
      ? request.body.scenarios
        .map((scenario) => ({
          id: scenario.id?.trim() || "",
          task: scenario.task?.trim() || "",
          projectPath: scenario.projectPath?.trim() || "",
        }))
        .filter((scenario) => scenario.task && scenario.projectPath)
      : [];
    const models = Array.isArray(request.body.models)
      ? request.body.models.map((model) => model.trim()).filter(Boolean)
      : [];
    const timeoutMs = Math.max(5_000, Math.min(request.body.timeoutMs ?? 240_000, 600_000));

    if (!scenarios.length) {
      return reply.code(400).send({
        message: "Нужно передать хотя бы один eval scenario с task и projectPath.",
      });
    }

    if (!models.length) {
      return reply.code(400).send({
        message: "Нужно передать хотя бы одну модель для eval.",
      });
    }

    const currentProvider = await getCurrentProvider();
    const providerBaseUrl = currentProvider?.baseUrl || defaultProviderBaseUrl;
    const providerApiKey = currentProvider?.apiKey || defaultProviderApiKey;

    if (!providerBaseUrl || !providerApiKey) {
      return reply.code(400).send({
        message: "Для eval нужен активный provider с baseUrl и apiKey.",
      });
    }

    const results: Array<ReturnType<typeof buildEvalSummary>> = [];

    for (const scenario of scenarios) {
      for (const model of models) {
        const runId = stableId(["eval-run", scenario.projectPath, scenario.task, model, Date.now(), Math.random()]);
        const startedAt = Date.now();
        enqueuePipelineRun({
          runId,
          mode: "question-run",
          conversationId: runId,
          task: scenario.task!,
          projectPath: scenario.projectPath!,
          providerBaseUrl,
          providerModel: model,
          providerApiKey,
          appRootPath,
        });
        const status = await waitForPipelineRunCompletion(appRootPath, runId, {
          timeoutMs,
          pollIntervalMs: 700,
        });
        results.push(buildEvalSummary(status, Date.now() - startedAt, model, scenario));
      }
    }

    return {
      generatedAt: new Date().toISOString(),
      timeoutMs,
      resultCount: results.length,
      results,
    };
  });

  return app;
}
