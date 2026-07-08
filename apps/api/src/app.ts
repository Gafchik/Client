import cors from "@fastify/cors";
import Fastify from "fastify";
import path from "node:path";
import { loadKnowledgeCatalog, loadLatestPipelineRunArtifact, loadPipelineRunArtifact } from "@client/knowledge";
import { normalizePath, stableId, type PipelineRunStatus, type ProviderCatalogResponse } from "@client/shared";
import { scanWorkspaceOverview } from "@client/workspace";
import { bootstrapPipelineRunStatuses, enqueuePipelineRun, loadPipelineRunStatus } from "./pipeline-runner.js";
import { deleteProvider, fetchProviderModels, getCurrentProvider, initializeProviderStore, listProviders, saveProvider, setCurrentProvider } from "./provider-store.js";

interface PipelineRunRequest {
  task?: string;
  projectPath?: string;
  providerBaseUrl?: string;
  providerModel?: string;
  providerApiKey?: string;
  providerId?: string;
}

interface SaveProviderRequest {
  id?: string;
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  isActive?: boolean;
  isCurrent?: boolean;
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
  });

  void bootstrapPipelineRunStatuses(appRootPath);

  app.addHook("onReady", async () => {
    await initializeProviderStore();
  });

  app.get("/api/health", async () => {
    return { status: "ok", now: new Date().toISOString() };
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

  app.get<{
    Querystring: {
      projectPath?: string;
    };
  }>("/api/project", async (request) => {
    const projectPath = request.query.projectPath?.trim() || appRootPath;
    const overview = await scanWorkspaceOverview(projectPath);
    const recentRuns = await loadKnowledgeCatalog(appRootPath, overview.rootPath);
    const latestRun = await loadLatestPipelineRunArtifact(appRootPath, overview.rootPath);

    return {
      name: overview.projectName,
      rootPath: overview.rootPath,
      summary: overview.summary,
      recentRuns,
      latestRun,
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

    const projectPath = request.body.projectPath?.trim() || appRootPath;
    const currentProvider = await getCurrentProvider();
    const selectedProvider = request.body.providerId?.trim() ? await setCurrentProvider(request.body.providerId.trim()) : null;
    const effectiveProvider = request.body.providerId?.trim()
      ? await getCurrentProvider()
      : currentProvider;
    const providerBaseUrl = request.body.providerBaseUrl?.trim() || effectiveProvider?.baseUrl || defaultProviderBaseUrl;
    const providerModel = request.body.providerModel?.trim() || defaultProviderModel;
    const providerApiKey = request.body.providerApiKey?.trim() || effectiveProvider?.apiKey || defaultProviderApiKey;

    void selectedProvider;
    const runId = stableId(["run", projectPath, task, Date.now()]);
    const acceptedStatus = enqueuePipelineRun({
      runId,
      task,
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
