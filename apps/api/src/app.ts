import cors from "@fastify/cors";
import Fastify from "fastify";
import path from "node:path";
import { buildBackgroundProjectState, deleteKnowledgeRuns, loadBestBaselineRunArtifact, loadConversationTurns, loadKnowledgeCatalog, loadLatestBackgroundRunCatalogEntry, loadLatestPipelineRunArtifact, loadPipelineRunArtifact } from "@client/knowledge";
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
import { deleteTeam, initializeTeamStore, listTeams, saveTeam, setSelectedTeam } from "./team-store.js";

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
    const baselineSelection = await loadBestBaselineRunArtifact(appRootPath, overview.rootPath, repository);
    const backgroundState = buildBackgroundProjectState({
      projectId: overview.projectId,
      projectRootPath: overview.rootPath,
      repository,
      latestRunId: latestBackgroundRun?.runId ?? null,
      baselineRun: baselineSelection.run,
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
      providerBaseUrl,
      providerModel,
      providerApiKey,
      appRootPath,
    });

    return reply.code(202).send(acceptedStatus);
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
