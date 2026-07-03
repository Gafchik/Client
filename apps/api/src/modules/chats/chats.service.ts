import { forwardRef, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { ChatEntity } from "../../persistence/chat.entity.js";
import { MessageEntity } from "../../persistence/message.entity.js";
import { ProjectEntity } from "../../persistence/project.entity.js";
import { TeamEntity } from "../../persistence/team.entity.js";
import { RunEntity } from "../../persistence/run.entity.js";
import { SaveChatDto } from "./dto/save-chat.dto.js";
import { TeamsService } from "../teams/teams.service.js";
import { TasksService } from "../tasks/tasks.service.js";
import { safeJsonParse } from "../../shared/json.js";
import { RunsService } from "../runs/runs.service.js";

@Injectable()
export class ChatsService {
  constructor(
    @InjectRepository(ChatEntity)
    private readonly chatsRepository: Repository<ChatEntity>,
    @InjectRepository(MessageEntity)
    private readonly messagesRepository: Repository<MessageEntity>,
    @InjectRepository(ProjectEntity)
    private readonly projectsRepository: Repository<ProjectEntity>,
    @InjectRepository(TeamEntity)
    private readonly teamsRepository: Repository<TeamEntity>,
    @InjectRepository(RunEntity)
    private readonly runsRepository: Repository<RunEntity>,
    private readonly teamsService: TeamsService,
    private readonly tasksService: TasksService,
    @Inject(forwardRef(() => RunsService))
    private readonly runsService: RunsService,
  ) {}

  async list(projectId?: string) {
    return this.chatsRepository.find({
      where: projectId ? { projectId } : {},
      order: { updatedAt: "DESC" },
    });
  }

  async getById(id: string) {
    const chat = await this.chatsRepository.findOneBy({ id });
    if (!chat) throw new NotFoundException("Chat not found");
    const messages = await this.messagesRepository.find({
      where: { chatId: id },
      order: { createdAt: "ASC" },
    });
    const runs = await this.runsRepository.find({
      where: { chatId: id },
      order: { startedAt: "DESC" },
    });

    const usageByRole: Record<
      string,
      {
        actualTokens: number;
        weightedTokens: number;
        promptTokens: number;
        completionTokens: number;
        calls: number;
        model?: string;
        label?: string;
        name?: string;
      }
    > = {};

    const addUsage = (role: string, usage: any) => {
      if (!usage) return;
      if (!usageByRole[role]) {
        usageByRole[role] = {
          actualTokens: 0,
          weightedTokens: 0,
          promptTokens: 0,
          completionTokens: 0,
          calls: 0,
          model: usage.model,
          label: usage.label,
          name: usage.name,
        };
      }
      usageByRole[role].actualTokens += usage.totalTokens ?? 0;
      usageByRole[role].weightedTokens += usage.weightedTokens ?? 0;
      usageByRole[role].promptTokens += usage.promptTokens ?? 0;
      usageByRole[role].completionTokens += usage.completionTokens ?? 0;
      usageByRole[role].calls += 1;
      usageByRole[role].model = usage.model ?? usageByRole[role].model;
      usageByRole[role].label = usage.label ?? usageByRole[role].label;
      usageByRole[role].name = usage.name ?? usageByRole[role].name;
    };

    for (const message of messages) {
      const usage = (message.meta as any)?.usage;
      addUsage(String(usage?.role || "orchestrator"), usage);
    }

    for (const run of runs) {
      const usageSummary = (run.finalReport as any)?.usageSummary;
      if (!usageSummary?.byAgent) continue;
      for (const [role, usage] of Object.entries<any>(usageSummary.byAgent)) {
        addUsage(role, {
          totalTokens: usage.actualTokens,
          weightedTokens: usage.weightedTokens,
          promptTokens: 0,
          completionTokens: 0,
          model: usage.model,
          multiplier: usage.multiplier,
        });
      }
    }

    const stats = {
      requestCount: messages.filter((message) => message.role === "user").length,
      runCount: runs.length,
      totalActualTokens: Object.values(usageByRole).reduce((sum, item) => sum + item.actualTokens, 0),
      totalWeightedTokens: Object.values(usageByRole).reduce((sum, item) => sum + item.weightedTokens, 0),
      byRole: usageByRole,
    };

    return { chat, messages, runs, stats };
  }

  async save(input: SaveChatDto) {
    const existing = input.id ? await this.chatsRepository.findOneBy({ id: input.id }) : null;
    const project = await this.projectsRepository.findOneBy({ id: input.projectId || existing?.projectId || "" });
    const resolvedTeamId = input.teamId || project?.teamId || existing?.teamId || "";
    const team = await this.teamsRepository.findOneBy({ id: resolvedTeamId });
    if (!project) throw new Error("projectId is invalid");
    if (!team) throw new Error("teamId is invalid");

    const entity = this.chatsRepository.create({
      id: existing?.id || `chat-${Date.now()}`,
      projectId: project.id,
      teamId: team.id,
      title: input.title?.trim() || existing?.title || `Новый чат`,
      summary: input.summary?.trim() || existing?.summary || "",
      isActive: true,
      createdAt: existing?.createdAt || new Date(),
      updatedAt: new Date(),
    });

    return this.chatsRepository.save(entity);
  }

  async addMessage(chatId: string, role: string, content: string, meta: Record<string, unknown> | null = null) {
    const chat = await this.chatsRepository.findOneBy({ id: chatId });
    if (!chat) throw new NotFoundException("Chat not found");

    const message = this.messagesRepository.create({
      id: `msg-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      chatId,
      role,
      content,
      meta,
    });
    await this.messagesRepository.save(message);

    chat.updatedAt = new Date();
    if (role === "assistant" && !chat.summary) {
      chat.summary = content.slice(0, 160);
    }
    await this.chatsRepository.save(chat);
    return message;
  }

  async remove(id: string) {
    const chat = await this.chatsRepository.findOneBy({ id });
    if (!chat) throw new NotFoundException("Chat not found");
    await this.chatsRepository.remove(chat);
    return { ok: true };
  }

  async sendMessageToOrchestrator(chatId: string, content: string) {
    const { chat, messages } = await this.getById(chatId);
    const project = await this.projectsRepository.findOneBy({ id: chat.projectId });
    if (!project) throw new Error("Project not found");
    const resolvedTeamId = project.teamId || chat.teamId;
    if (!resolvedTeamId) throw new Error("Project team is not configured");
    const team = await this.teamsService.getById(resolvedTeamId);
    if (!team.provider) throw new Error("Team provider is not configured");
    if (!team.provider.apiKey) throw new Error("Provider API key is missing");
    if (chat.teamId !== team.id) {
      chat.teamId = team.id;
      await this.chatsRepository.save(chat);
    }

    await this.addMessage(chat.id, "user", content, { type: "conversation" });

    const taskSnapshot = await this.tasksService.list(project.id);
    const orchestrator = (team.config as any)?.agents?.orchestrator || (team.config as any)?.agents?.pm;
    if (!orchestrator?.model) {
      throw new Error("Orchestrator model is not configured");
    }

    const response = await fetch(`${team.provider.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${team.provider.apiKey}`,
      },
      body: JSON.stringify({
        model: orchestrator.model,
        temperature: orchestrator.temperature ?? 0.2,
        messages: [
          {
            role: "system",
            content: [
              "You are the orchestrator and representative of the AI team.",
              "You answer user questions about the project and the team.",
              "You know the exact team roster, including each member name, role, label, and model.",
              "When the user asks who someone is, first check the provided team roster and answer from it.",
              "If the answer does not require work, do not create any task.",
              "Create tasks only when the user explicitly asks to do work or when real follow-up execution is needed.",
              "If work should start immediately, set shouldExecute to true and provide executionTask.",
              "Return valid JSON only.",
              'Output schema: {"message":"string","suggestedTasks":[{"title":"string","description":"string","status":"backlog|in_progress|done"}],"teamSummary":["string"],"shouldExecute":boolean,"executionTask":"string"}',
            ].join("\n"),
          },
          {
            role: "user",
            content: JSON.stringify(
              {
                project: {
                  id: project.id,
                  name: project.name,
                  description: project.description,
                  localPath: project.localPath,
                },
                team: {
                  id: team.id,
                  name: team.name,
                  description: team.description,
                  roles: Object.entries((team.config as any)?.agents || {}).map(([role, agent]: [string, any]) => ({
                    role,
                    name: agent?.name,
                    label: agent?.label,
                    model: agent?.model,
                    multiplier: agent?.multiplier,
                    temperature: agent?.temperature,
                  })),
                },
                tasks: taskSnapshot.map((task) => ({
                  id: task.id,
                  title: task.title,
                  description: task.description,
                  status: task.status,
                })),
                chatHistory: messages.slice(-12).map((message) => ({
                  role: message.role,
                  content: message.content,
                })),
                userMessage: content,
              },
              null,
              2,
            ),
          },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(`API request failed (${response.status}): ${await response.text()}`);
    }

    const data = safeJsonParse<any>(await response.text(), {});
    const rawMessage = data?.choices?.[0]?.message?.content;
    const text = Array.isArray(rawMessage)
      ? rawMessage.map((part: any) => (typeof part === "string" ? part : part?.text ?? "")).join("\n")
      : rawMessage;
    const usage = {
      promptTokens: data?.usage?.prompt_tokens ?? 0,
      completionTokens: data?.usage?.completion_tokens ?? 0,
      totalTokens: data?.usage?.total_tokens ?? 0,
      weightedTokens: Math.ceil((data?.usage?.total_tokens ?? 0) * (orchestrator.multiplier ?? 1)),
      multiplier: orchestrator.multiplier ?? 1,
      model: orchestrator.model,
      role: "orchestrator",
      name: orchestrator.name || "Alex",
      label: orchestrator.label || "Оркестратор",
    };
    const orchestratorPayload = safeJsonParse<any>(text || "{}", {
      message: text || "Оркестратор не вернул ответ.",
      suggestedTasks: [],
      teamSummary: [],
      shouldExecute: false,
      executionTask: "",
    });
    const requestId = `chatreq-${Date.now()}`;

    const createdTasks = [];
    for (const task of orchestratorPayload.suggestedTasks || []) {
      if (!task?.title) continue;
      createdTasks.push(
        await this.tasksService.save({
          projectId: project.id,
          title: task.title,
          description: task.description || "",
          status: task.status || "backlog",
          sourceChatId: chat.id,
        }),
      );
    }

    let autoRunId: string | null = null;
    const shouldExecute = Boolean(orchestratorPayload.shouldExecute);
    const executionTask = String(orchestratorPayload.executionTask || content).trim();
    if (shouldExecute && executionTask) {
      if (!createdTasks.length) {
        createdTasks.push(
          await this.tasksService.save({
            projectId: project.id,
            title: executionTask.slice(0, 120),
            description: executionTask,
            status: "in_progress",
            sourceChatId: chat.id,
          }),
        );
      } else {
        const primaryTask = createdTasks[0];
        if (primaryTask.status !== "in_progress") {
          const updatedTask = await this.tasksService.save({
            ...primaryTask,
            status: "in_progress",
          });
          createdTasks[0] = updatedTask;
        }
      }

      const run = await this.runsService.startRun({
        chatId: chat.id,
        task: executionTask,
      });
      autoRunId = run.runId;
    }

    const finalMessage = [
      orchestratorPayload.message || "Оркестратор обработал сообщение.",
      createdTasks.length ? "" : null,
      createdTasks.length ? `Создано задач: ${createdTasks.length}` : null,
      ...createdTasks.map((task) => `- [${task.status}] ${task.title}`),
      autoRunId ? "" : null,
      autoRunId ? `Команда запущена в работу. Run ID: ${autoRunId}` : null,
    ]
      .filter(Boolean)
      .join("\n");

    const assistantMessage = await this.addMessage(chat.id, "assistant", finalMessage, {
      type: "conversation",
      requestId,
      usage,
      createdTaskIds: createdTasks.map((task) => task.id),
      autoRunId,
      orchestratorPayload,
    });

    return {
      chat,
      message: assistantMessage,
      createdTasks,
      autoRunId,
    };
  }
}
