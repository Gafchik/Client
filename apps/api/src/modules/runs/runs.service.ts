import { forwardRef, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { ChatEntity } from "../../persistence/chat.entity.js";
import { ProjectEntity } from "../../persistence/project.entity.js";
import fs from "node:fs/promises";
import path from "node:path";
import { Repository } from "typeorm";
import { RunEntity } from "../../persistence/run.entity.js";
import { TeamEntity } from "../../persistence/team.entity.js";
import { ChatsService } from "../chats/chats.service.js";
import { ProjectsService } from "../projects/projects.service.js";
import { TeamsService } from "../teams/teams.service.js";
import { StartRunDto } from "./dto/start-run.dto.js";
import { extractJson, safeJsonParse } from "../../shared/json.js";
import type { TeamConfig } from "../../shared/types.js";

type JobState = {
  id: string;
  status: string;
  events: Array<{ at: string; event: string; payload?: unknown }>;
  activeAgents?: Record<string, { status: "idle" | "working"; label: string; name: string; role: string; detail: string }>;
  error?: string;
};

@Injectable()
export class RunsService {
  private readonly jobs = new Map<string, JobState>();

  constructor(
    @InjectRepository(RunEntity)
    private readonly runsRepository: Repository<RunEntity>,
    @InjectRepository(ChatEntity)
    private readonly chatsRepository: Repository<ChatEntity>,
    @InjectRepository(ProjectEntity)
    private readonly projectsRepository: Repository<ProjectEntity>,
    private readonly teamsService: TeamsService,
    private readonly projectsService: ProjectsService,
    @Inject(forwardRef(() => ChatsService))
    private readonly chatsService: ChatsService,
    private readonly configService: ConfigService,
  ) {}

  async list() {
    return this.runsRepository.find({
      order: {
        startedAt: "DESC",
      },
    });
  }

  async getById(id: string) {
    const run = await this.runsRepository.findOneBy({ id });
    if (!run) throw new NotFoundException("Run not found");
    return run;
  }

  getJob(id: string) {
    const job = this.jobs.get(id);
    if (!job) throw new NotFoundException("Job not found");
    return job;
  }

  async startRun(input: StartRunDto) {
    const chat = await this.chatsRepository.findOneBy({ id: input.chatId });
    if (!chat) throw new NotFoundException("Chat not found");
    const project = await this.projectsService.getById(chat.projectId);
    const resolvedTeamId = project.teamId || chat.teamId;
    if (!resolvedTeamId) {
      throw new Error("Project team is not configured");
    }
    const team = await this.teamsService.getById(resolvedTeamId);
    const runId = `run-${Date.now()}`;

    const run = await this.runsRepository.save(
      this.runsRepository.create({
        id: runId,
        teamId: team.id,
        projectId: project.id,
        chatId: chat.id,
        teamName: team.name,
        task: input.task,
        projectPath: project.containerPath,
        status: "queued",
        events: [],
        finalReport: null,
        runDir: null,
        error: null,
        finishedAt: null,
      }),
    );

    const job: JobState = {
      id: runId,
      status: "queued",
      events: [],
      activeAgents: {},
    };
    this.jobs.set(runId, job);
    if (chat.teamId !== team.id) {
      chat.teamId = team.id;
      await this.chatsRepository.save(chat);
    }
    await this.chatsService.addMessage(chat.id, "user", input.task, {
      type: "task",
      runId,
    });

    void this.executeRun(run, team, project, chat, job);

    return { runId };
  }

  private async executeRun(
    run: RunEntity,
    team: TeamEntity,
    project: ProjectEntity,
    chat: ChatEntity,
    job: JobState,
  ) {
    job.status = "running";
    await this.updateRun(run.id, { status: "running" });

    try {
      const config = team.config as unknown as TeamConfig & {
        id: string;
        name: string;
        description: string;
      };
      config.id = team.id;
      this.validateProjectPath(project.localPath, run.projectPath);

      const runRoot = this.getRunRoot(team.id, run.id);
      await fs.mkdir(runRoot, { recursive: true });

      const report = await this.runPipeline(config, run, runRoot, async (event, payload) => {
        const entry = {
          at: new Date().toISOString(),
          event,
          payload,
        };
        if (event === "agent:activity" && payload && typeof payload === "object") {
          const meta = payload as any;
          job.activeAgents = {
            ...(job.activeAgents || {}),
            [meta.role]: {
              status: meta.status,
              label: meta.label,
              name: meta.agentName,
              role: meta.role,
              detail: meta.detail,
            },
          };
        }
        if ((event === "agent:done" || event === "agent:skipped") && payload && typeof payload === "object") {
          const meta = payload as any;
          const current = job.activeAgents?.[meta.agentName] || job.activeAgents?.[meta.role];
          if (current) {
            job.activeAgents = {
              ...(job.activeAgents || {}),
              [current.role]: {
                ...current,
                status: "idle",
                detail: event === "agent:done" ? "Завершил свой этап." : "Сейчас не задействован.",
              },
            };
          }
        }
        job.events.push(entry);
        await this.updateRun(run.id, {
          events: job.events.slice(-50),
        });
      });

      job.status = "done";
      await this.updateRun(run.id, {
        status: "done",
        finalReport: report,
        runDir: runRoot,
        finishedAt: new Date(),
        events: job.events.slice(-50),
      });
      await this.chatsService.addMessage(chat.id, "assistant", this.buildAssistantSummary(report), {
        type: "run-summary",
        runId: run.id,
        usageSummary: report.usageSummary,
      });
    } catch (error) {
      job.status = "failed";
      job.error = error instanceof Error ? error.message : String(error);
      await this.updateRun(run.id, {
        status: "failed",
        error: job.error,
        finishedAt: new Date(),
        events: job.events.slice(-50),
      });
      await this.chatsService.addMessage(chat.id, "assistant", `Ошибка запуска: ${job.error}`, {
        type: "run-error",
        runId: run.id,
      });
    }
  }

  private getRunRoot(teamId: string, runId: string) {
    const storageRoot = this.configService.get<string>("STORAGE_ROOT", "/app/storage");
    return path.join(storageRoot, "teams", teamId, "runs", runId);
  }

  private validateProjectPath(localPath: string, containerPath: string) {
    const localRoot = path.resolve(this.configService.get<string>("LOCAL_PROJECTS_ROOT", "/Users/evgenii"));
    const containerRoot = path.resolve(this.configService.get<string>("CONTAINER_PROJECTS_ROOT", "/host-projects"));
    if (!path.resolve(localPath).startsWith(localRoot)) {
      throw new Error(`Project local path must be inside ${localRoot}`);
    }
    if (!path.resolve(containerPath).startsWith(containerRoot)) {
      throw new Error(`Project container path must be inside ${containerRoot}`);
    }
  }

  private buildAssistantSummary(report: any) {
    if (report.orchestratorResponse?.message) {
      return report.orchestratorResponse.message;
    }

    return [
      `Задача: ${report.task}`,
      `Проект: ${report.projectPath}`,
      `Tester status: ${report.approvals?.testerStatus ?? "-"}`,
      report.orchestrator?.goal ? `Goal: ${report.orchestrator.goal}` : "",
      report.analyst?.summary ? `Analysis: ${report.analyst.summary}` : "",
      report.developer?.summary ? `Implementation: ${report.developer.summary}` : "",
      report.tester?.summary ? `Test: ${report.tester.summary}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  private async updateRun(runId: string, patch: Partial<RunEntity>) {
    const current = await this.getById(runId);
    Object.assign(current, patch);
    return this.runsRepository.save(current);
  }

  private async runPipeline(
    config: TeamConfig,
    run: RunEntity,
    runRoot: string,
    emit: (event: string, payload?: unknown) => Promise<void>,
  ) {
    const usageSummary = {
      totalActualTokens: 0,
      totalWeightedTokens: 0,
      byAgent: {} as Record<
        string,
        {
          model: string;
          multiplier: number;
          calls: number;
          actualTokens: number;
          weightedTokens: number;
        }
      >,
    };

    const trackUsage = (agentName: string, usage: any) => {
      usageSummary.totalActualTokens += usage.totalTokens;
      usageSummary.totalWeightedTokens += usage.weightedTokens;
      if (!usageSummary.byAgent[agentName]) {
        usageSummary.byAgent[agentName] = {
          model: usage.model,
          multiplier: usage.multiplier,
          calls: 0,
          actualTokens: 0,
          weightedTokens: 0,
        };
      }
      usageSummary.byAgent[agentName].calls += 1;
      usageSummary.byAgent[agentName].actualTokens += usage.totalTokens;
      usageSummary.byAgent[agentName].weightedTokens += usage.weightedTokens;
    };

    const setAgentActivity = async (
      role: string,
      status: "idle" | "working",
      detail: string,
      emitActivity = true,
    ) => {
      const identity = this.agentIdentity(
        config,
        role,
        role === "pm" ? "Alex" : role === "researcher" ? "Mira" : role === "coder" ? "Kai" : "Nova",
      );
      if (emitActivity) {
        await emit("agent:activity", {
          agentName: identity.name,
          role: identity.role,
          label: identity.label,
          status,
          detail,
        });
      }
    };

    let context = await this.buildWorkspaceContext(run.projectPath, run.task, config.workspace);
    const projectMemory = run.projectId ? await this.projectsService.listMemory(run.projectId) : [];
    context.projectMemory = projectMemory;
    await emit("run:context", { fileCount: context.fileCount });
    await emit("memory:loaded", { entries: projectMemory.length });

    await setAgentActivity("pm", "working", "Анализирует запрос и решает, кого подключать.");
    const orchestrator = await this.callAgent(config, "pm", this.buildPmPrompt(run.task, context, config), emit);
    trackUsage("orchestrator", orchestrator.usage);
    await this.writeArtifact(runRoot, "01-orchestrator.json", orchestrator.artifact);
    await emit("agent:done", {
      agentName: this.agentIdentity(config, "pm", "Alex").name,
      role: orchestrator.usage.resolvedAgentName,
      label: this.agentIdentity(config, "pm", "Alex").label,
      usage: orchestrator.usage,
    });
    await setAgentActivity("pm", "idle", "Решение по делегации принято.");

    const delegationRoles = this.extractDelegationRoles(config, orchestrator.artifact);
    const shouldUseAnalyst = delegationRoles.has("analyst");
    const shouldUseDeveloper = delegationRoles.has("developer");
    const shouldUseTester = delegationRoles.has("tester");
    const requiresConcreteChanges = this.requiresConcreteChanges(run.task, orchestrator.artifact);

    if (shouldUseDeveloper) {
      await emit("agent:note", {
        agentName: this.agentIdentity(config, "coder", "Kai").name,
        role: this.agentIdentity(config, "coder", "Kai").role,
        label: this.agentIdentity(config, "coder", "Kai").label,
        detail: requiresConcreteChanges
          ? "Ожидаются реальные изменения в файлах проекта."
          : "Проверяет, нужны ли реальные изменения в коде или достаточно ответа без правок.",
      });
    }

    const analyst = shouldUseAnalyst
      ? await (async () => {
          await setAgentActivity("researcher", "working", "Собирает контекст и уточняет постановку.");
          await emit("agent:note", {
            agentName: this.agentIdentity(config, "researcher", "Mira").name,
            role: this.agentIdentity(config, "researcher", "Mira").role,
            label: this.agentIdentity(config, "researcher", "Mira").label,
            detail: projectMemory.length
              ? `Изучает память проекта: ${projectMemory.length} записей, затем сверяет код.`
              : "Память проекта пока пуста, поэтому сразу исследует кодовую базу.",
          });
          const result = await this.callAgent(
            config,
            "researcher",
            this.buildAnalystPrompt(run.task, context, orchestrator.artifact, config),
            emit,
          );
          await setAgentActivity("researcher", "idle", "Контекст и рекомендации подготовлены.");
          return result;
        })()
      : { artifact: null, usage: null };
    if (shouldUseAnalyst && analyst.usage) {
      trackUsage("analyst", analyst.usage);
      await this.writeArtifact(runRoot, "02-analyst.json", analyst.artifact);
      await emit("agent:done", {
        agentName: this.agentIdentity(config, "researcher", "Mira").name,
        role: analyst.usage.resolvedAgentName,
        label: this.agentIdentity(config, "researcher", "Mira").label,
        usage: analyst.usage,
      });
      context = await this.expandWorkspaceContext(
        context,
        config.workspace,
        this.collectContextQueries(run.task, orchestrator.artifact, analyst.artifact),
        18,
      );
      await emit("agent:note", {
        agentName: this.agentIdentity(config, "researcher", "Mira").name,
        role: this.agentIdentity(config, "researcher", "Mira").role,
        label: this.agentIdentity(config, "researcher", "Mira").label,
        detail: `Подобрал для разработчика расширенный контекст: ${context.fileSnippets.length} файловых сниппетов.`,
      });
    } else {
      await emit("agent:skipped", {
        agentName: this.agentIdentity(config, "researcher", "Mira").name,
        role: this.agentIdentity(config, "researcher", "Mira").role,
        label: this.agentIdentity(config, "researcher", "Mira").label,
        reason: "orchestrator_not_required",
      });
    }

    const developer = shouldUseDeveloper
      ? await (async () => {
          await setAgentActivity("coder", "working", "Готовит изменения и операции по файлам.");
          let result = await this.callAgent(
            config,
            "coder",
            this.buildDeveloperPrompt(run.task, context, orchestrator.artifact, analyst.artifact, config),
            emit,
          );
          const extraUsages = [] as any[];

          if (requiresConcreteChanges && (!Array.isArray(result.artifact?.operations) || result.artifact.operations.length === 0)) {
            await emit("developer:empty-operations", {
              agentName: this.agentIdentity(config, "coder", "Kai").name,
              role: this.agentIdentity(config, "coder", "Kai").role,
              label: this.agentIdentity(config, "coder", "Kai").label,
              detail: "Не вернул ни одной правки по кодовой задаче. Запрашиваем конкретные изменения повторно.",
            });
            context = await this.expandWorkspaceContext(
              context,
              config.workspace,
              this.collectContextQueries(run.task, orchestrator.artifact, analyst.artifact, result.artifact),
              18,
            );
            await setAgentActivity("coder", "working", "Не вернул правки. Повторно формирует конкретные изменения.");
            result = await this.callAgent(
              config,
              "coder",
              this.buildDeveloperRevisionPrompt(
                run.task,
                context,
                orchestrator.artifact,
                analyst.artifact,
                result.artifact,
                config,
              ),
              emit,
            );
            extraUsages.push(result.usage);
          }

          await setAgentActivity(
            "coder",
            "idle",
            Array.isArray(result.artifact?.operations) && result.artifact.operations.length > 0
              ? `Подготовил ${result.artifact.operations.length} изменений в проекте.`
              : "Не подготовил конкретные изменения.",
          );
          await emit("agent:note", {
            agentName: this.agentIdentity(config, "coder", "Kai").name,
            role: this.agentIdentity(config, "coder", "Kai").role,
            label: this.agentIdentity(config, "coder", "Kai").label,
            detail: result.artifact?.summary || "Подготовил результат по задаче.",
          });
          return {
            ...result,
            extraUsages,
          };
        })()
      : { artifact: null, usage: null, extraUsages: [] };
    if (shouldUseDeveloper && developer.usage) {
      trackUsage("developer", developer.usage);
      for (const usage of developer.extraUsages ?? []) {
        trackUsage("developer", usage);
      }
      await this.writeArtifact(runRoot, "03-developer.json", developer.artifact);
      await emit("agent:done", {
        agentName: this.agentIdentity(config, "coder", "Kai").name,
        role: developer.usage.resolvedAgentName,
        label: this.agentIdentity(config, "coder", "Kai").label,
        usage: developer.usage,
      });
    } else {
      await emit("agent:skipped", {
        agentName: this.agentIdentity(config, "coder", "Kai").name,
        role: this.agentIdentity(config, "coder", "Kai").role,
        label: this.agentIdentity(config, "coder", "Kai").label,
        reason: "orchestrator_not_required",
      });
    }

     if (shouldUseDeveloper && requiresConcreteChanges && (!Array.isArray(developer.artifact?.operations) || developer.artifact.operations.length === 0)) {
       await emit("run:blocked", {
         agentName: this.agentIdentity(config, "coder", "Kai").name,
         role: this.agentIdentity(config, "coder", "Kai").role,
         label: this.agentIdentity(config, "coder", "Kai").label,
         detail: "Кодовая задача не привела к изменениям файлов. Прогон остановлен, чтобы не создавать ложное ощущение выполненной работы.",
       });
       
       // Generate partial report with all collected data before throwing error
       const partialReport = {
         runId: run.id,
         projectPath: run.projectPath,
         task: run.task,
         approvals: {
           testerStatus: "blocked",
         },
         orchestrator: orchestrator.artifact,
         analyst: analyst.artifact,
         developer: developer.artifact,
         tester: null,
         orchestratorResponse: {
           message: "Developer did not return any file changes for a code task.",
           error: "blocked_no_file_changes",
           summary: developer.artifact?.summary || "No changes returned",
           details: developer.artifact?.notes || [],
         },
         applyResult: { applied: [], skipped: [] },
         usageSummary,
         projectMemoryUsed: projectMemory.map((entry) => ({
           id: entry.id,
           title: entry.title,
           summary: entry.summary,
           kind: entry.kind,
           tags: entry.tags,
           relatedFiles: entry.relatedFiles,
         })),
         generatedAt: new Date().toISOString(),
       };
       
       await this.writeArtifact(runRoot, "final-report.json", partialReport);
       
       throw new Error("Developer did not return any file changes for a code task.");
     }

    let applyResult: {
      applied: Array<{ path: string; action: string; reason: string }>;
      skipped: Array<{ path: string; reason: string }>;
    } = { applied: [], skipped: [] };
    if (config.run.applyChanges && shouldUseDeveloper) {
      await emit("agent:activity", {
        agentName: this.agentIdentity(config, "coder", "Kai").name,
        role: this.agentIdentity(config, "coder", "Kai").role,
        label: this.agentIdentity(config, "coder", "Kai").label,
        status: "working",
        detail: `Применяет изменения к ${developer.artifact.operations?.length ?? 0} файлам.`,
      });
      applyResult = await this.applyOperations(run.projectPath, developer.artifact.operations ?? [], runRoot, emit);
      await this.writeArtifact(runRoot, "06-apply-result.json", applyResult);
      await emit("files:applied", applyResult);
      await emit("agent:activity", {
        agentName: this.agentIdentity(config, "coder", "Kai").name,
        role: this.agentIdentity(config, "coder", "Kai").role,
        label: this.agentIdentity(config, "coder", "Kai").label,
        status: "idle",
        detail: "Изменения в проекте применены.",
      });
    } else if (!shouldUseDeveloper) {
      await emit("files:skipped", { reason: "developer_not_requested" });
    }

    const testResults = [] as any[];
    if (shouldUseTester) {
      await emit("agent:activity", {
        agentName: this.agentIdentity(config, "tester", "Nova").name,
        role: this.agentIdentity(config, "tester", "Nova").role,
        label: this.agentIdentity(config, "tester", "Nova").label,
        status: "working",
        detail: `Запускает ${config.testing.commands?.length ?? 0} тестовых команд.`,
      });
      for (const command of config.testing.commands ?? []) {
        await emit("test:started", { command });
        testResults.push(await this.runShell(command, run.projectPath, emit));
      }
      await this.writeArtifact(runRoot, "07-local-tests.json", testResults);
      await emit("tests:done", testResults);
      await emit("agent:activity", {
        agentName: this.agentIdentity(config, "tester", "Nova").name,
        role: this.agentIdentity(config, "tester", "Nova").role,
        label: this.agentIdentity(config, "tester", "Nova").label,
        status: "idle",
        detail: "Локальные тесты завершены.",
      });
    } else {
      await emit("tests:skipped", { reason: "tester_not_requested" });
    }

    const tester = shouldUseTester
      ? await (async () => {
          await setAgentActivity("tester", "working", "Проверяет результат и прогоняет тесты.");
          const result = await this.callAgent(
            config,
            "tester",
            this.buildTesterPrompt(run.task, orchestrator.artifact, analyst.artifact, developer.artifact, testResults, config),
            emit,
          );
          await setAgentActivity("tester", "idle", "Проверка завершена.");
          return result;
        })()
      : { artifact: null, usage: null };
    if (shouldUseTester && tester.usage) {
      trackUsage("tester", tester.usage);
      await this.writeArtifact(runRoot, "08-tester.json", tester.artifact);
      await emit("agent:done", {
        agentName: this.agentIdentity(config, "tester", "Nova").name,
        role: tester.usage.resolvedAgentName,
        label: this.agentIdentity(config, "tester", "Nova").label,
        usage: tester.usage,
      });
    } else {
      await emit("agent:skipped", {
        agentName: this.agentIdentity(config, "tester", "Nova").name,
        role: this.agentIdentity(config, "tester", "Nova").role,
        label: this.agentIdentity(config, "tester", "Nova").label,
        reason: "orchestrator_not_required",
      });
    }

    const orchestratorCanAnswerDirectly =
      !shouldUseAnalyst && !shouldUseDeveloper && !shouldUseTester && Boolean(orchestrator.artifact?.messageToUser);

    const orchestratorResponse = orchestratorCanAnswerDirectly
      ? {
          artifact: {
            message: orchestrator.artifact.messageToUser,
            teamSummary: orchestrator.artifact.teamUnderstanding ?? [],
            risks: orchestrator.artifact.constraints ?? [],
            nextSteps: orchestrator.artifact.deliverables ?? [],
          },
          usage: null,
        }
      : await (async () => {
          await setAgentActivity("pm", "working", "Готовит финальный ответ пользователю.");
          const result = await this.callAgent(
            config,
            "pm",
            this.buildOrchestratorFinalPrompt(
              run.task,
              orchestrator.artifact,
              analyst.artifact,
              developer.artifact,
              tester.artifact,
              config,
            ),
            emit,
          );
          await setAgentActivity("pm", "idle", "Финальный ответ подготовлен.");
          return result;
        })();
    if (orchestratorResponse.usage) {
      trackUsage("orchestrator", orchestratorResponse.usage);
      await emit("agent:done", {
        agentName: this.agentIdentity(config, "pm", "Alex").name,
        role: orchestratorResponse.usage.resolvedAgentName,
        label: this.agentIdentity(config, "pm", "Alex").label,
        usage: orchestratorResponse.usage,
      });
    } else {
      await emit("agent:skipped", {
        agentName: this.agentIdentity(config, "pm", "Alex").name,
        role: this.agentIdentity(config, "pm", "Alex").role,
        label: this.agentIdentity(config, "pm", "Alex").label,
        reason: "initial_orchestrator_answer_used",
      });
    }
    await this.writeArtifact(runRoot, "09-orchestrator-final.json", orchestratorResponse.artifact);

    const finalReport = {
      runId: run.id,
      projectPath: run.projectPath,
      task: run.task,
      approvals: {
        testerStatus: tester.artifact?.status ?? "not_requested",
      },
      orchestrator: orchestrator.artifact,
      analyst: analyst.artifact,
      developer: developer.artifact,
      tester: tester.artifact,
      orchestratorResponse: orchestratorResponse.artifact,
      applyResult,
      usageSummary,
      projectMemoryUsed: projectMemory.map((entry) => ({
        id: entry.id,
        title: entry.title,
        summary: entry.summary,
        kind: entry.kind,
        tags: entry.tags,
        relatedFiles: entry.relatedFiles,
      })),
      generatedAt: new Date().toISOString(),
    };

    await this.writeArtifact(runRoot, "final-report.json", finalReport);
    if (run.projectId) {
      await this.updateProjectMemory(run.projectId, run.id, run.task, finalReport);
      await emit("memory:updated", { projectId: run.projectId });
    }
    return finalReport;
  }

  private async buildWorkspaceContext(projectPath: string, task: string, workspaceConfig: TeamConfig["workspace"]): Promise<{
    root: string;
    fileCount: number;
    tree: string[];
    fileSnippets: Array<{ path: string; chars: number; snippet: string }>;
    allFiles: Array<{ fullPath: string; relativePath: string; score: number }>;
    projectMemory?: Array<any>;
  }> {
    const root = path.resolve(projectPath);
    const allFiles: Array<{ fullPath: string; relativePath: string }> = [];

    const walk = async (dir: string, depth: number) => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relativePath = path.relative(root, fullPath);
        if (!relativePath) continue;

        if (entry.isDirectory()) {
          if (workspaceConfig.ignoreDirs.includes(entry.name)) continue;
          if (depth > 7) continue;
          await walk(fullPath, depth + 1);
          continue;
        }

        const ext = path.extname(entry.name).toLowerCase();
        if (!workspaceConfig.includeExtensions.includes(ext)) continue;
        allFiles.push({ fullPath, relativePath });
      }
    };

    await walk(root, 0);
    const keywords = Array.from(
      new Set(
        task
          .split(/\s+/)
          .map((word) => word.toLowerCase().replace(/[^a-z0-9а-яіїє_-]+/gi, ""))
          .filter((word) => word.length >= 3),
      ),
    );

    const rankedFiles = allFiles
      .map((file) => {
        const haystack = file.relativePath.toLowerCase();
        let score = 0;
        for (const keyword of keywords) {
          if (haystack.includes(keyword)) score += 8;
        }
        if (/(readme|package|config|src|app|lib|test)/i.test(file.relativePath)) score += 3;
        score -= file.relativePath.split(path.sep).length;
        return { ...file, score };
      })
      .sort((a, b) => b.score - a.score || a.relativePath.localeCompare(b.relativePath))
      .slice(0, workspaceConfig.maxFiles);

    const fileSnippets = [];
    for (const file of rankedFiles) {
      try {
        const content = await fs.readFile(file.fullPath, "utf8");
        fileSnippets.push({
          path: file.relativePath,
          chars: content.length,
          snippet: content.slice(0, workspaceConfig.maxCharsPerFile),
        });
      } catch {
        fileSnippets.push({
          path: file.relativePath,
          chars: 0,
          snippet: "[Could not read file as utf8 text]",
        });
      }
    }

    return {
      root,
      fileCount: allFiles.length,
      tree: allFiles.map((item) => item.relativePath).sort(),
      allFiles: rankedFiles,
      fileSnippets,
    };
  }

  private async expandWorkspaceContext(
    context: {
      root: string;
      fileCount: number;
      tree: string[];
      fileSnippets: Array<{ path: string; chars: number; snippet: string }>;
      allFiles: Array<{ fullPath: string; relativePath: string; score: number }>;
      projectMemory?: Array<any>;
    },
    workspaceConfig: TeamConfig["workspace"],
    queries: string[],
    limit = 12,
  ) {
    const existing = new Set(context.fileSnippets.map((item) => item.path));
    const normalizedTerms = Array.from(
      new Set(
        queries
          .flatMap((item) => String(item || "").split(/[\s,;:\n]+/))
          .map((item) => item.toLowerCase().replace(/[^a-z0-9а-яіїє_.\-/]+/gi, ""))
          .filter((item) => item.length >= 3),
      ),
    );

    if (!normalizedTerms.length) {
      return context;
    }

    const extraFiles = context.allFiles
      .filter((file) => !existing.has(file.relativePath))
      .map((file) => {
        const haystack = file.relativePath.toLowerCase();
        let score = file.score;
        for (const term of normalizedTerms) {
          if (haystack.includes(term)) score += 10;
          if (path.basename(haystack).includes(term)) score += 12;
        }
        return { ...file, score };
      })
      .sort((a, b) => b.score - a.score || a.relativePath.localeCompare(b.relativePath))
      .slice(0, Math.min(limit, Math.max(0, 30 - context.fileSnippets.length)));

    for (const file of extraFiles) {
      try {
        const content = await fs.readFile(file.fullPath, "utf8");
        context.fileSnippets.push({
          path: file.relativePath,
          chars: content.length,
          snippet: content.slice(0, workspaceConfig.maxCharsPerFile),
        });
      } catch {
        context.fileSnippets.push({
          path: file.relativePath,
          chars: 0,
          snippet: "[Could not read file as utf8 text]",
        });
      }
    }

    return context;
  }

  private collectContextQueries(task: string, orchestratorArtifact: any, analystArtifact?: any, developerArtifact?: any) {
    return [
      task,
      orchestratorArtifact?.goal,
      ...(Array.isArray(orchestratorArtifact?.deliverables) ? orchestratorArtifact.deliverables : []),
      ...(Array.isArray(analystArtifact?.relevantFiles) ? analystArtifact.relevantFiles : []),
      ...(Array.isArray(analystArtifact?.implementationHints) ? analystArtifact.implementationHints : []),
      ...(Array.isArray(analystArtifact?.findings) ? analystArtifact.findings : []),
      ...(Array.isArray(developerArtifact?.notes) ? developerArtifact.notes : []),
      developerArtifact?.summary,
    ].filter(Boolean);
  }

  private async callAgent(
    config: TeamConfig,
    agentName: string,
    prompt: { systemPrompt: string; userPrompt: string },
    onEvent?: (event: string, payload?: unknown) => Promise<void>,
  ) {
    const resolvedAgentName = this.resolveAgentName(config, agentName);
    const agent = config.agents[resolvedAgentName];
    if (!agent) throw new Error(`Unknown agent: ${agentName}`);
    const team = await this.teamsService.getById((config as any).id);
    const provider = team.provider;
    if (!provider) {
      throw new Error("Team provider is not configured");
    }
    if (!provider.apiKey) {
      throw new Error("Provider API key is missing");
    }

    const invoke = async (messages: Array<{ role: "system" | "user" | "assistant"; content: string }>) => {
      const response = await fetch(`${provider.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${provider.apiKey}`,
        },
        body: JSON.stringify({
          model: agent.model,
          temperature: agent.temperature,
          messages,
        }),
      });

      if (!response.ok) {
        throw new Error(`API request failed (${response.status}): ${await response.text()}`);
      }

      const data = safeJsonParse<any>(await response.text(), {});
      const rawMessage = data?.choices?.[0]?.message?.content;
      const content = Array.isArray(rawMessage)
        ? rawMessage.map((part: any) => (typeof part === "string" ? part : part?.text ?? "")).join("\n")
        : rawMessage;

      return {
        content: content ?? "",
        usage: {
          promptTokens: data?.usage?.prompt_tokens ?? this.estimateTokens(messages.map((item) => item.content).join("\n")),
          completionTokens: data?.usage?.completion_tokens ?? this.estimateTokens(content ?? ""),
          totalTokens:
            data?.usage?.total_tokens ??
            this.estimateTokens(messages.map((item) => item.content).join("\n")) + this.estimateTokens(content ?? ""),
          weightedTokens: Math.ceil(
            (data?.usage?.total_tokens ??
              this.estimateTokens(messages.map((item) => item.content).join("\n")) + this.estimateTokens(content ?? "")) *
              agent.multiplier,
          ),
          multiplier: agent.multiplier,
          model: agent.model,
          resolvedAgentName,
        },
      };
    };

    const baseMessages: Array<{ role: "system" | "user"; content: string }> = [
      { role: "system", content: prompt.systemPrompt },
      { role: "user", content: prompt.userPrompt },
    ];

    let promptTokens = 0;
    let completionTokens = 0;
    let totalTokens = 0;
    let weightedTokens = 0;
    let lastError: Error | null = null;
    let previousContent = "";

    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt > 0 && onEvent) {
        await onEvent("agent:retry", {
          agentName: agent.name || resolvedAgentName,
          role: resolvedAgentName,
          label: agent.label,
          attempt: attempt + 1,
          reason: lastError?.message ?? "invalid_json",
        });
      }

      const messages =
        attempt === 0
          ? baseMessages
          : [
              ...baseMessages,
              { role: "assistant" as const, content: previousContent },
              {
                role: "user" as const,
                content: [
                  "Your previous reply could not be parsed as valid JSON.",
                  `Parser error: ${lastError?.message ?? "unknown error"}`,
                  "Return the same result again as one strict valid JSON object only.",
                  "Do not use markdown fences, comments, explanations, or any text outside JSON.",
                ].join("\n"),
              },
            ];

      const result = await invoke(messages);
      previousContent = result.content;
      promptTokens += result.usage.promptTokens;
      completionTokens += result.usage.completionTokens;
      totalTokens += result.usage.totalTokens;
      weightedTokens += result.usage.weightedTokens;

      try {
        const artifact = extractJson(result.content || "{}");
        if (attempt > 0 && onEvent) {
          await onEvent("agent:retry-success", {
            agentName: agent.name || resolvedAgentName,
            role: resolvedAgentName,
            label: agent.label,
            attempt: attempt + 1,
          });
        }
        return {
          artifact,
          usage: {
            ...result.usage,
            promptTokens,
            completionTokens,
            totalTokens,
            weightedTokens,
          },
        };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }

    throw new Error(
      `Agent "${resolvedAgentName}" returned invalid JSON after 3 attempts. Last parser error: ${lastError?.message ?? "unknown error"}`,
    );
  }

  private estimateTokens(text: string) {
    return Math.ceil((text?.length ?? 0) / 4);
  }

  private extractDelegationRoles(config: TeamConfig, orchestratorArtifact: any) {
    const roles = new Set<string>();
    const plan = Array.isArray(orchestratorArtifact?.delegationPlan) ? orchestratorArtifact.delegationPlan : [];

    for (const step of plan) {
      const requestedRole = typeof step?.role === "string" ? step.role : "";
      if (!requestedRole) continue;
      try {
        const resolvedRole = this.resolveAgentName(config, requestedRole);
        if (resolvedRole === "researcher") roles.add("analyst");
        else if (resolvedRole === "coder") roles.add("developer");
        else if (resolvedRole === "tester") roles.add("tester");
        else if (resolvedRole === "analyst" || resolvedRole === "developer") roles.add(resolvedRole);
      } catch {
        // Ignore unknown roles from the model output.
      }
    }

    return roles;
  }

  private resolveAgentName(config: TeamConfig, requestedName: string) {
    const aliases: Record<string, string[]> = {
      pm: ["pm", "orchestrator"],
      researcher: ["researcher", "analyst"],
      specWriter: ["specWriter", "analyst", "orchestrator"],
      coder: ["coder", "developer"],
      reviewer: ["reviewer", "developer", "orchestrator"],
      tester: ["tester"],
    };

    const candidates = aliases[requestedName] ?? [requestedName];
    const found = candidates.find((candidate) => config.agents[candidate]);
    if (!found) {
      throw new Error(`Agent role "${requestedName}" is not configured in the team`);
    }
    return found;
  }

  private async writeArtifact(runRoot: string, name: string, data: unknown) {
    await fs.mkdir(runRoot, { recursive: true });
    await fs.writeFile(path.join(runRoot, name), JSON.stringify(data, null, 2), "utf8");
  }

  private async applyOperations(
    projectPath: string,
    operations: Array<any>,
    runRoot: string,
    emit?: (event: string, payload?: unknown) => Promise<void>,
  ) {
    const applied: Array<{ path: string; action: string; reason: string }> = [];
    const skipped: Array<{ path: string; reason: string }> = [];
    const backupsDir = path.join(runRoot, "backups");
    await fs.mkdir(backupsDir, { recursive: true });

    for (const operation of operations) {
      if (emit) {
        await emit("file:processing", {
          path: operation.path,
          action: operation.action,
          reason: operation.reason ?? "",
        });
      }
      const targetPath = path.resolve(projectPath, operation.path);
      const relative = path.relative(projectPath, targetPath);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
        skipped.push({ path: operation.path, reason: "Path escapes project root." });
        if (emit) {
          await emit("file:skipped", { path: operation.path, reason: "Path escapes project root." });
        }
        continue;
      }

      if (!["create", "update"].includes(operation.action)) {
        skipped.push({ path: operation.path, reason: "Only create and update are allowed." });
        if (emit) {
          await emit("file:skipped", { path: operation.path, reason: "Only create and update are allowed." });
        }
        continue;
      }

      try {
        const previous = await fs.readFile(targetPath, "utf8");
        const backupPath = path.join(backupsDir, operation.path.replace(/[\\/]/g, "__"));
        await fs.writeFile(backupPath, previous, "utf8");
      } catch {
        // no-op
      }

      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, operation.content ?? "", "utf8");
      applied.push({
        path: operation.path,
        action: operation.action,
        reason: operation.reason ?? "",
      });
      if (emit) {
        await emit("file:applied", {
          path: operation.path,
          action: operation.action,
          reason: operation.reason ?? "",
        });
      }
    }

    return { applied, skipped };
  }

  private async runShell(command: string, cwd: string, emit?: (event: string, payload?: unknown) => Promise<void>) {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);

    try {
      const { stdout, stderr } = await execFileAsync("sh", ["-lc", command], {
        cwd,
        timeout: 120000,
        maxBuffer: 1024 * 1024 * 8,
      });
      if (emit) {
        await emit("test:finished", {
          command,
          success: true,
          code: 0,
        });
      }
      return { command, success: true, stdout, stderr, code: 0 };
    } catch (error: any) {
      if (emit) {
        await emit("test:finished", {
          command,
          success: false,
          code: typeof error.code === "number" ? error.code : 1,
        });
      }
      return {
        command,
        success: false,
        stdout: error.stdout ?? "",
        stderr: error.stderr ?? error.message,
        code: typeof error.code === "number" ? error.code : 1,
      };
    }
  }

  private sharedRules() {
    return [
      "You are one role inside a multi-agent software team.",
      "Be concise, practical, and implementation-oriented.",
      "Return valid JSON only, with no prose outside JSON.",
      "Do not wrap the JSON in markdown unless explicitly asked.",
      "Prefer low-token, high-signal answers.",
    ].join("\n");
  }

  private languageInstruction(config: TeamConfig) {
    const language = this.resolveLanguageLabel((config.language || "en").trim().toLowerCase());
    return [
      `All natural-language strings inside your JSON must be written only in ${language}.`,
      `Do not switch to English unless the requested team language is English.`,
    ].join(" ");
  }

  private resolveLanguageLabel(language: string) {
    const dictionary: Record<string, string> = {
      en: "English",
      ru: "Russian",
      uk: "Ukrainian",
      de: "German",
      fr: "French",
      es: "Spanish",
      it: "Italian",
      pt: "Portuguese",
      pl: "Polish",
      tr: "Turkish",
      zh: "Chinese",
      ja: "Japanese",
    };

    return dictionary[language] || language || "English";
  }

  private agentIdentity(config: TeamConfig, role: string, fallbackLabel: string) {
    const resolved = this.resolveAgentName(config, role);
    const agent = config.agents[resolved];
    return {
      role: resolved,
      name: agent?.name?.trim() || fallbackLabel,
      label: agent?.label?.trim() || fallbackLabel,
    };
  }

  private buildPmPrompt(task: string, context: any, config: TeamConfig) {
    const self = this.agentIdentity(config, "pm", "Alex");
    const roster = Object.entries(config.agents).map(([role, agent]) => ({
      role,
      name: agent.name || role,
      label: agent.label,
      model: agent.model,
      multiplier: agent.multiplier,
    }));

    return {
      systemPrompt: `${this.sharedRules()}
${this.languageInstruction(config)}
Your name is ${self.name}. Your role title is ${self.label}.
You are the orchestrator and public representative of the whole team.
You are the single entry point for the user. You must understand who is in the team,
what each role is responsible for, and decide how to delegate the work.
Delegate only when another role is truly needed. If you can answer the user yourself,
keep delegationPlan empty and put the direct answer into messageToUser.
Output schema:
{
  "goal": "string",
  "teamUnderstanding": ["string"],
  "successCriteria": ["string"],
  "constraints": ["string"],
  "deliverables": ["string"],
  "delegationPlan": [{"role": "analyst|developer|tester|orchestrator", "objective": "string"}],
  "messageToUser": "string"
}`,
      userPrompt: `User task:\n${task}\n\nWorkspace summary:\n${JSON.stringify(
        {
          root: context.root,
          fileCount: context.fileCount,
          treeSample: context.tree.slice(0, 80),
          teamRoster: roster,
        },
        null,
        2,
      )}`,
    };
  }

  private buildAnalystPrompt(task: string, context: any, orchestratorArtifact: any, config: TeamConfig) {
    const self = this.agentIdentity(config, "researcher", "Mira");
    return {
      systemPrompt: `${this.sharedRules()}
${this.languageInstruction(config)}
Your name is ${self.name}. Your role title is ${self.label}.
You are the analyst. Your job is to clarify the request, study project context,
and prepare implementation guidance for the developer.
First use the provided project memory to reuse known knowledge and prior decisions.
Only if the memory is insufficient should you rely on code inspection.
You are given a partial set of focused file snippets plus a broader project file list.
Do not claim files are missing unless they are absent from the provided project file list.
Output schema:
{
  "summary": "string",
  "relevantFiles": ["string"],
  "findings": ["string"],
  "unknowns": ["string"],
  "implementationHints": ["string"],
  "acceptanceCriteria": ["string"]
}`,
      userPrompt: `Task:\n${task}\n\nOrchestrator artifact:\n${JSON.stringify(orchestratorArtifact, null, 2)}\n\nProject memory:\n${JSON.stringify(
        (context.projectMemory ?? []).map((entry: any) => ({
          title: entry.title,
          summary: entry.summary,
          details: entry.details,
          kind: entry.kind,
          tags: entry.tags,
          relatedFiles: entry.relatedFiles,
        })),
        null,
        2,
      )}\n\nProject file list:\n${JSON.stringify(
        context.tree.slice(0, 400),
        null,
        2,
      )}\n\nFile snippets:\n${JSON.stringify(
        context.fileSnippets,
        null,
        2,
      )}`,
    };
  }

  private buildDeveloperPrompt(
    task: string,
    context: any,
    orchestratorArtifact: any,
    analystArtifact: any,
    config: TeamConfig,
  ) {
    const self = this.agentIdentity(config, "coder", "Kai");
    return {
      systemPrompt: `${this.sharedRules()}
${this.languageInstruction(config)}
Your name is ${self.name}. Your role title is ${self.label}.
You are the developer. Implement the task using the analyst guidance and project context.
Produce concrete file operations.
If the task requires code or UI changes, operations must not be empty.
Do not answer with high-level advice only when concrete implementation is expected.
You are given a partial set of focused file snippets plus a broader project file list.
Do not claim files are missing unless they are absent from the provided project file list.
Output schema:
{
  "summary": "string",
  "operations": [
    {
      "path": "relative/path",
      "action": "create|update",
      "reason": "string",
      "content": "full file content"
    }
  ],
  "notes": ["string"],
  "testsToRun": ["string"]
}`,
      userPrompt: `Task:\n${task}\n\nOrchestrator artifact:\n${JSON.stringify(
        orchestratorArtifact,
        null,
        2
      )}\n\nProject memory:\n${JSON.stringify(
        (context.projectMemory ?? []).map((entry: any) => ({
          title: entry.title,
          summary: entry.summary,
          kind: entry.kind,
          relatedFiles: entry.relatedFiles,
        })),
        null,
        2,
      )}\n\nProject file list:\n${JSON.stringify(
        context.tree.slice(0, 400),
        null,
        2,
      )}\n\nAnalyst artifact:\n${JSON.stringify(
        analystArtifact,
        null,
        2
      )}\n\nWorkspace file snippets:\n${JSON.stringify(
        context.fileSnippets,
        null,
        2,
      )}`,
    };
  }

  private buildDeveloperRevisionPrompt(
    task: string,
    context: any,
    orchestratorArtifact: any,
    analystArtifact: any,
    previousDeveloperArtifact: any,
    config: TeamConfig,
  ) {
    const self = this.agentIdentity(config, "coder", "Kai");
    return {
      systemPrompt: `${this.sharedRules()}
${this.languageInstruction(config)}
Your name is ${self.name}. Your role title is ${self.label}.
You are retrying because your previous answer did not include concrete file changes.
For this retry, you must either:
1. return at least one valid file operation, or
2. clearly state a blocking reason in notes and keep operations empty only if implementation is impossible.
Do not return vague guidance without concrete edits when the task is implementable.
You are given a partial set of focused file snippets plus a broader project file list.
Do not claim files are missing unless they are absent from the provided project file list.
Output schema:
{
  "summary": "string",
  "operations": [
    {
      "path": "relative/path",
      "action": "create|update",
      "reason": "string",
      "content": "full file content"
    }
  ],
  "notes": ["string"],
  "testsToRun": ["string"]
}`,
      userPrompt: `Task:\n${task}\n\nOrchestrator artifact:\n${JSON.stringify(
        orchestratorArtifact,
        null,
        2,
      )}\n\nProject memory:\n${JSON.stringify(
        (context.projectMemory ?? []).map((entry: any) => ({
          title: entry.title,
          summary: entry.summary,
          kind: entry.kind,
          relatedFiles: entry.relatedFiles,
        })),
        null,
        2,
      )}\n\nProject file list:\n${JSON.stringify(
        context.tree.slice(0, 400),
        null,
        2,
      )}\n\nAnalyst artifact:\n${JSON.stringify(
        analystArtifact,
        null,
        2,
      )}\n\nPrevious developer artifact:\n${JSON.stringify(
        previousDeveloperArtifact,
        null,
        2,
      )}\n\nWorkspace file snippets:\n${JSON.stringify(
        context.fileSnippets,
        null,
        2,
      )}`,
    };
  }

  private requiresConcreteChanges(task: string, orchestratorArtifact: any) {
    const haystack = [
      task,
      orchestratorArtifact?.goal,
      ...(Array.isArray(orchestratorArtifact?.deliverables) ? orchestratorArtifact.deliverables : []),
      ...(Array.isArray(orchestratorArtifact?.successCriteria) ? orchestratorArtifact.successCriteria : []),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    return /(fix|implement|change|update|edit|refactor|create|build|wire|patch|rewrite|feature|ui|frontend|backend|code|file|endpoint|component|screen|chat|task|status|сдел|исправ|добав|измени|обнов|реализ|перепиш|почини|экран|чат|код|файл|роут|эндпоинт)/i.test(
      haystack,
    );
  }

  private async updateProjectMemory(projectId: string, runId: string, task: string, finalReport: any) {
    const relatedFiles = [
      ...(Array.isArray(finalReport?.developer?.operations) ? finalReport.developer.operations.map((item: any) => item.path) : []),
      ...(Array.isArray(finalReport?.analyst?.relevantFiles) ? finalReport.analyst.relevantFiles : []),
    ]
      .filter(Boolean)
      .slice(0, 20);

    const tags = Array.from(
      new Set(
        task
          .split(/\s+/)
          .map((word: string) => word.toLowerCase().replace(/[^a-z0-9а-яіїє_-]+/gi, ""))
          .filter((word: string) => word.length >= 3),
      ),
    ).slice(0, 12);

    const summary =
      finalReport?.orchestratorResponse?.message ||
      finalReport?.developer?.summary ||
      finalReport?.analyst?.summary ||
      task;

    const details = [
      finalReport?.analyst?.summary ? `Analysis: ${finalReport.analyst.summary}` : "",
      Array.isArray(finalReport?.analyst?.findings) && finalReport.analyst.findings.length
        ? `Findings: ${finalReport.analyst.findings.join("; ")}`
        : "",
      finalReport?.developer?.summary ? `Implementation: ${finalReport.developer.summary}` : "",
      finalReport?.tester?.summary ? `Validation: ${finalReport.tester.summary}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    await this.projectsService.saveMemory({
      projectId,
      sourceRunId: runId,
      title: task.slice(0, 140),
      summary,
      details,
      kind: this.requiresConcreteChanges(task, finalReport?.orchestrator) ? "feature" : "research",
      tags,
      relatedFiles,
    });
  }

  private buildTesterPrompt(task: string, orchestratorArtifact: any, analystArtifact: any, developerArtifact: any, testResults: any[], config: TeamConfig) {
    const self = this.agentIdentity(config, "tester", "Nova");
    return {
      systemPrompt: `${this.sharedRules()}
${this.languageInstruction(config)}
Your name is ${self.name}. Your role title is ${self.label}.
You are the tester / QA agent.
Output schema:
{
  "status": "passed|warning|failed",
  "summary": "string",
  "findings": ["string"],
  "nextSteps": ["string"]
}`,
      userPrompt: `Task:\n${task}\n\nOrchestrator artifact:\n${JSON.stringify(
        orchestratorArtifact,
        null,
        2
      )}\n\nAnalyst artifact:\n${JSON.stringify(
        analystArtifact,
        null,
        2
      )}\n\nDeveloper artifact:\n${JSON.stringify(
        developerArtifact,
        null,
        2,
      )}\n\nLocal test results:\n${JSON.stringify(testResults, null, 2)}`,
    };
  }

  private buildOrchestratorFinalPrompt(task: string, orchestratorArtifact: any, analystArtifact: any, developerArtifact: any, testerArtifact: any, config: TeamConfig) {
    const self = this.agentIdentity(config, "pm", "Alex");
    return {
      systemPrompt: `${this.sharedRules()}
${this.languageInstruction(config)}
Your name is ${self.name}. Your role title is ${self.label}.
You are the orchestrator and the only role that speaks back to the user on behalf of the team.
Summarize what happened, what the team decided, what was changed, and what the next action is.
Output schema:
{
  "message": "string",
  "teamSummary": ["string"],
  "risks": ["string"],
  "nextSteps": ["string"]
}`,
      userPrompt: `User task:\n${task}\n\nInitial orchestrator artifact:\n${JSON.stringify(
        orchestratorArtifact,
        null,
        2,
      )}\n\nAnalyst artifact:\n${JSON.stringify(
        analystArtifact,
        null,
        2,
      )}\n\nDeveloper artifact:\n${JSON.stringify(
        developerArtifact,
        null,
        2,
      )}\n\nTester artifact:\n${JSON.stringify(
        testerArtifact,
        null,
        2,
      )}`,
    };
  }
}
