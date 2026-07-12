import cors from "@fastify/cors";
import Fastify from "fastify";
import path from "node:path";
import { buildBackgroundProjectState, loadBestBaselineRunArtifact, loadKnowledgeCatalog, loadLatestBackgroundRunCatalogEntry, loadLatestPipelineRunArtifact, loadPipelineRunArtifact } from "@client/knowledge";
import { inspectRepository } from "@client/repository-git";
import { normalizePath, stableId, type PipelineRunMode, type PipelineRunStatus, type ProjectCatalogResponse, type ProviderCatalogResponse } from "@client/shared";
import { openWorkspaceSelective, scanWorkspaceOverview } from "@client/workspace";
import { initializeGraphStore } from "./graph-store.js";
import { closeNeo4jDriver, verifyNeo4jConnectivity } from "./neo4j-client.js";
import { bootstrapPipelineRunStatuses, enqueuePipelineRun, findActivePipelineRun, findPipelineRunByRepositoryHead, loadPipelineRunStatus } from "./pipeline-runner.js";
import { startProjectStateMonitor, stopProjectStateMonitor } from "./project-state-monitor.js";
import { deleteProject, getProjectById, initializeProjectStore, listProjects, saveProject } from "./project-store.js";
import { deleteProvider, fetchProviderModels, getCurrentProvider, initializeProviderStore, listProviders, saveProvider, setCurrentProvider } from "./provider-store.js";

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
    await initializeProviderStore();
    await initializeProjectStore();
    await initializeGraphStore();
    startProjectStateMonitor({
      appRootPath,
      providerBaseUrl: defaultProviderBaseUrl,
      providerModel: defaultProviderModel,
      providerApiKey: defaultProviderApiKey,
    });
  });

  app.addHook("onClose", async () => {
    stopProjectStateMonitor();
    await closeNeo4jDriver();
  });

  app.get("/api/health", async () => {
    const neo4jConnected = await verifyNeo4jConnectivity();
    return { status: "ok", now: new Date().toISOString(), neo4jConnected };
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

  app.delete<{ Params: { id: string } }>("/api/providers/:id", async (request, reply) => {
    const deleted = await deleteProvider(request.params.id);

    if (!deleted) {
      return reply.code(404).send({
        message: "Провайдер не найден.",
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
    const recentRuns = await loadKnowledgeCatalog(appRootPath, overview.rootPath);
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
    const projectPath = request.query.projectPath?.trim() || appRootPath;
    const runId = request.query.runId?.trim();
    const normalizedProjectPath = normalizePath(path.resolve(projectPath));

    if (!runId) {
      return reply.code(400).send({
        message: "Нужно указать runId.",
      });
    }

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
      runId?: string;
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

    return status;
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
    const providerModel = explicitProviderModel || defaultProviderModel;
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
    const acceptedStatus = enqueuePipelineRun({
      runId,
      mode,
      task: normalizedTask,
      projectPath,
      providerBaseUrl,
      providerModel,
      providerApiKey,
      appRootPath,
    });

    return reply.code(202).send(acceptedStatus);
  });

  return app;
}
