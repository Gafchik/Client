import cors from "@fastify/cors";
import Fastify from "fastify";
import path from "node:path";
import { buildContextPackage } from "@client/context";
import { buildGraph } from "@client/graph";
import { analyzeImpact } from "@client/impact-analysis";
import { runFullIndex } from "@client/indexer";
import { loadKnowledgeCatalog, loadLatestPipelineRunArtifact, loadPipelineRunArtifact, saveKnowledgeArtifacts } from "@client/knowledge";
import { buildExecutionPlan, buildExecutionPreview } from "@client/planner";
import { runResearch } from "@client/research";
import { normalizePath, stableId, type PipelineRunResult, type PipelineStage } from "@client/shared";
import { openWorkspace, scanWorkspaceOverview } from "@client/workspace";

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
    const workspaceStartedAt = new Date().toISOString();
    const workspace = await openWorkspace(projectPath);
    const workspaceCompletedAt = new Date().toISOString();
    const indexStartedAt = new Date().toISOString();
    const index = await runFullIndex(workspace);
    const indexCompletedAt = new Date().toISOString();
    const graphStartedAt = new Date().toISOString();
    const graph = buildGraph(workspace, index);
    const graphCompletedAt = new Date().toISOString();
    const researchStartedAt = new Date().toISOString();
    const research = runResearch({
      runId,
      task,
      workspace,
      index,
      graph,
    });
    const researchCompletedAt = new Date().toISOString();
    const impactStartedAt = new Date().toISOString();
    const impact = analyzeImpact({
      runId,
      graph,
      research,
    });
    const impactCompletedAt = new Date().toISOString();
    const contextStartedAt = new Date().toISOString();
    const context = buildContextPackage({
      runId,
      task,
      workspace,
      index,
      graph,
      research,
      impact,
    });
    const contextCompletedAt = new Date().toISOString();
    const planStartedAt = new Date().toISOString();
    const plan = buildExecutionPlan({
      runId,
      task,
      research,
      impact,
      context,
      graph,
    });
    const planCompletedAt = new Date().toISOString();
    const previewStartedAt = new Date().toISOString();
    const executionPreview = buildExecutionPreview(runId, plan);
    const previewCompletedAt = new Date().toISOString();
    const knowledgeStartedAt = new Date().toISOString();
    const stages: PipelineStage[] = [
      {
        key: "workspace",
        label: "Workspace",
        status: "completed",
        startedAt: workspaceStartedAt,
        completedAt: workspaceCompletedAt,
        details: `Открыто ${workspace.summary.indexedFiles} индексируемых файлов, проигнорировано ${workspace.ignoredPaths.length}.`,
      },
      {
        key: "index",
        label: "Index",
        status: "completed",
        startedAt: indexStartedAt,
        completedAt: indexCompletedAt,
        details: `Построен index: ${index.manifest.symbolCount} символов и ${index.manifest.relationCount} связей.`,
      },
      {
        key: "graph",
        label: "Graph",
        status: "completed",
        startedAt: graphStartedAt,
        completedAt: graphCompletedAt,
        details: `Собран graph: ${graph.summary.nodeCount} узлов и ${graph.summary.edgeCount} рёбер.`,
      },
      {
        key: "research",
        label: "Исследование",
        status: "completed",
        startedAt: researchStartedAt,
        completedAt: researchCompletedAt,
        details: `Подготовлено ${research.evidence.length} опорных ссылок с уверенностью ${research.confidence}%.`,
      },
      {
        key: "impact",
        label: "Анализ влияния",
        status: "completed",
        startedAt: impactStartedAt,
        completedAt: impactCompletedAt,
        details: `Определено ${impact.affectedFiles.length} затронутых файлов и ${impact.risks.length} рисков.`,
      },
      {
        key: "context",
        label: "Контекст",
        status: "completed",
        startedAt: contextStartedAt,
        completedAt: contextCompletedAt,
        details: `Собран контекстный пакет: ${context.selectedChunks.length} фрагментов при бюджете ${context.tokenBudget}.`,
      },
      {
        key: "plan",
        label: "План",
        status: "completed",
        startedAt: planStartedAt,
        completedAt: planCompletedAt,
        details: `Построен план выполнения: ${plan.steps.length} шагов, требуется согласование: ${plan.approvalRequired ? "да" : "нет"}.`,
      },
      {
        key: "preview",
        label: "Превью выполнения",
        status: "completed",
        startedAt: previewStartedAt,
        completedAt: previewCompletedAt,
        details: `Подготовлено безопасное превью выполнения с ${executionPreview.allowedActions.length} разрешёнными действиями.`,
      },
    ];
    const knowledge = await saveKnowledgeArtifacts({
      runId,
      task,
      appRootPath,
      workspace,
      provider: {
        baseUrl: providerBaseUrl,
        model: providerModel,
        apiKeyMasked: maskApiKey(providerApiKey),
      },
      index,
      graph,
      research,
      impact,
      context,
      plan,
      executionPreview,
    });
    const knowledgeCompletedAt = new Date().toISOString();
    stages.push({
      key: "knowledge",
      label: "Знания",
      status: "completed",
      startedAt: knowledgeStartedAt,
      completedAt: knowledgeCompletedAt,
      details: `Артефакты сохранены в центральное knowledge-хранилище: ${knowledge.artifactCount} групп.`,
    });

    const result: PipelineRunResult = {
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
      graph: {
        summary: graph.summary,
      },
      stages,
      research,
      impact,
      context,
      plan,
      executionPreview,
      knowledge,
    };

    return result;
  });

  return app;
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
