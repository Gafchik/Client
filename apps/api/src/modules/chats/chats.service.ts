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
import { safeJsonParse } from "../../shared/json.js";
import { RunsService } from "../runs/runs.service.js";
import { WsGateway } from "../ws/ws.gateway.js";
import * as fs from "fs";
import * as path from "path";

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
    @Inject(forwardRef(() => RunsService))
    private readonly runsService: RunsService,
    private readonly wsGateway: WsGateway,
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

    const orchestrator = (team.config as any)?.agents?.orchestrator || (team.config as any)?.agents?.pm;
    const teamLanguage = this.resolveTeamLanguage((team.config as any)?.language);
    if (!orchestrator?.model) {
      throw new Error("Orchestrator model is not configured");
    }

    const systemPrompt = this.loadOrchestratorPrompt(teamLanguage.label, teamLanguage.code);

    // Стриминговый запрос к LLM
    const streamResponse = await fetch(`${team.provider.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${team.provider.apiKey}`,
      },
      body: JSON.stringify({
        model: orchestrator.model,
        temperature: orchestrator.temperature ?? 0.2,
        stream: true,
        messages: [
          {
            role: "system",
            content: systemPrompt,
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
                  language: teamLanguage.code,
                  roles: Object.entries((team.config as any)?.agents || {}).map(([role, agent]: [string, any]) => ({
                    role,
                    name: agent?.name,
                    label: agent?.label,
                    model: agent?.model,
                    multiplier: agent?.multiplier,
                    temperature: agent?.temperature,
                  })),
                },
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

    if (!streamResponse.ok) {
      throw new Error(`API request failed (${streamResponse.status}): ${await streamResponse.text()}`);
    }

    // Читаем стрим и отправляем токены через WebSocket
    let fullContent = "";
    let totalUsage: any = null;
    const reader = streamResponse.body?.getReader();
    const decoder = new TextDecoder();

    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split("\n");
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const dataStr = line.slice(6).trim();
            if (dataStr === "[DONE]") continue;
            try {
              const data = JSON.parse(dataStr);
              const delta = data.choices?.[0]?.delta?.content;
              if (delta) {
                fullContent += delta;
                this.wsGateway.broadcastTokenStream(chat.id, {
                  role: "orchestrator",
                  content: delta,
                  done: false,
                });
              }
              if (data.usage) totalUsage = data.usage;
            } catch { }
          }
        }
      }
    }

    // Финальный токен
    this.wsGateway.broadcastTokenStream(chat.id, {
      role: "orchestrator",
      content: "",
      done: true,
    });

    const text = fullContent;
    const usage = {
      promptTokens: totalUsage?.prompt_tokens ?? 0,
      completionTokens: totalUsage?.completion_tokens ?? 0,
      totalTokens: totalUsage?.total_tokens ?? 0,
      weightedTokens: Math.ceil((totalUsage?.total_tokens ?? 0) * (orchestrator.multiplier ?? 1)),
      multiplier: orchestrator.multiplier ?? 1,
      model: orchestrator.model,
      role: "orchestrator",
      name: orchestrator.name || "Alex",
      label: orchestrator.label || "Оркестратор",
    };
    const orchestratorPayload = safeJsonParse<any>(text || "{}", {
      message: text || "Оркестратор не вернул ответ.",
      teamSummary: [],
      shouldExecute: false,
      executionTask: "",
    });
    const requestId = `chatreq-${Date.now()}`;

    let autoRunId: string | null = null;
    const shouldExecute = Boolean(orchestratorPayload.shouldExecute);
    const executionTask = String(orchestratorPayload.executionTask || content).trim();
    if (shouldExecute && executionTask) {
      const run = await this.runsService.startRun({
        chatId: chat.id,
        task: executionTask,
        teamId: resolvedTeamId,
        teamName: team.name,
        projectPath: project.localPath,
      });
      autoRunId = run.runId;
    }

    const finalMessage = [
      orchestratorPayload.message || "Оркестратор обработал сообщение.",
      autoRunId ? "" : null,
      autoRunId ? `Команда запущена в работу. Run ID: ${autoRunId}` : null,
    ]
      .filter(Boolean)
      .join("\n");

    const assistantMessage = await this.addMessage(chat.id, "assistant", finalMessage, {
      type: "conversation",
      requestId,
      usage,
      autoRunId,
      orchestratorPayload,
    });

    return {
      chat,
      message: assistantMessage,
      createdTasks: [],
      autoRunId,
    };
  }

  private resolveTeamLanguage(rawLanguage?: string | null) {
    const normalized = String(rawLanguage || "en").trim().toLowerCase();
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

    return {
      code: normalized || "en",
      label: dictionary[normalized] || normalized || "English",
    };
  }

  private loadOrchestratorPrompt(languageLabel: string, languageCode: string): string {
    const promptPath = path.join(process.cwd(), "src/modules/chats/prompts/orchestrator.system.txt");
    let template = "";
    try {
      template = fs.readFileSync(promptPath, "utf-8");
    } catch {
      template = `You are the orchestrator and representative of the AI team.
Team communication language: {{teamLanguage}}.
All natural-language text in your JSON response must be written only in {{teamLanguage}}.
Do not answer in English unless the team language is {{teamLanguageCode}}.
You answer user questions about the project and the team.
You know the exact team roster, including each member name, role, label, and model.
When the user asks who someone is, first check the provided team roster and answer from it.
If the user asks to do work, you coordinate the team directly.
Return valid JSON only.
Output schema: {"message":"string","teamSummary":["string"],"shouldExecute":boolean,"executionTask":"string"}`;
    }
    return template
      .replace(/{{teamLanguage}}/g, languageLabel)
      .replace(/{{teamLanguageCode}}/g, languageCode);
  }
}