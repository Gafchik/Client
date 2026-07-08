import cors from "@fastify/cors";
import Fastify from "fastify";
import path from "node:path";
import { loadKnowledgeCatalog, loadLatestPipelineRunArtifact, loadPipelineRunArtifact } from "@client/knowledge";
import { normalizePath, stableId, type PipelineRunStatus } from "@client/shared";
import { scanWorkspaceOverview } from "@client/workspace";
import { bootstrapPipelineRunStatuses, enqueuePipelineRun, loadPipelineRunStatus } from "./pipeline-runner.js";

interface PipelineRunRequest {
  task?: string;
  projectPath?: string;
  providerBaseUrl?: string;
  providerModel?: string;
  providerApiKey?: string;
}

export function createApp() {
  const app = Fastify({
    logger: true,
  });
  const appRootPath = process.cwd();

  app.register(cors, {
    origin: true,
  });

  void bootstrapPipelineRunStatuses(appRootPath);

  app.get("/api/health", async () => {
    return { status: "ok", now: new Date().toISOString() };
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
    const providerBaseUrl = request.body.providerBaseUrl?.trim() || "";
    const providerModel = request.body.providerModel?.trim() || "";
    const providerApiKey = request.body.providerApiKey?.trim() || "";
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
