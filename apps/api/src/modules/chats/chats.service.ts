import { forwardRef, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { ChatEntity } from "../../persistence/chat.entity.js";
import { MessageEntity } from "../../persistence/message.entity.js";
import { ProjectEntity } from "../../persistence/project.entity.js";
import { ProjectMemoryEntryEntity } from "../../persistence/project-memory.entity.js";
import { TeamEntity } from "../../persistence/team.entity.js";
import { RunEntity } from "../../persistence/run.entity.js";
import { SaveChatDto } from "./dto/save-chat.dto.js";
import { TeamsService } from "../teams/teams.service.js";
import { parseJsonSafely, safeJsonParse } from "../../shared/json.js";
import { createLlmStreamRequest } from "../../shared/llm-client.js";
import { RunsService } from "../runs/runs.service.js";
import { ProvidersService } from "../providers/providers.service.js";
import { WsGateway } from "../ws/ws.gateway.js";
import * as fs from "fs";
import * as path from "path";
import crypto from "node:crypto";
import {
  cleanupPathsInTask,
  isUrlLikePath,
} from "../../shared/path-utils.js";

@Injectable()
export class ChatsService {
  private readonly logger = new Logger(ChatsService.name);

  private createMessageId(): string {
    return `msg-${crypto.randomUUID()}`;
  }

  constructor(
    @InjectRepository(ChatEntity)
    private readonly chatsRepository: Repository<ChatEntity>,
    @InjectRepository(MessageEntity)
    private readonly messagesRepository: Repository<MessageEntity>,
    @InjectRepository(ProjectEntity)
    private readonly projectsRepository: Repository<ProjectEntity>,
    @InjectRepository(ProjectMemoryEntryEntity)
    private readonly projectMemoryRepository: Repository<ProjectMemoryEntryEntity>,
    @InjectRepository(TeamEntity)
    private readonly teamsRepository: Repository<TeamEntity>,
    @InjectRepository(RunEntity)
    private readonly runsRepository: Repository<RunEntity>,
    @Inject(TeamsService)
    private readonly teamsService: TeamsService,
    @Inject(forwardRef(() => RunsService))
    private readonly runsService: RunsService,
    @Inject(WsGateway)
    private readonly wsGateway: WsGateway,
    @Inject(ProvidersService)
    private readonly providersService: ProvidersService,
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
      id: this.createMessageId(),
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
    // Сначала явно удаляем все run'ы этого чата. Раньше FK runs.chatId был
    // onDelete: SET NULL — поэтому при удалении чата runs просто теряли chatId
    // и оставались в БД навсегда как orphan-зомби (status='running', никто их
    // больше не поллит, а executeRunSteps их skips по гварде "already running").
    // Это и были «зомби» fbaf14a0/f6c2d316, из-за которых чат висел заблокирован.
    // Теперь: (1) FK переведён на CASCADE, (2) здесь дублируем удаление в коде —
    // двойная защита, не зависящая от того, пересоздал ли synchronize FK.
    try {
      await this.runsService.deleteRunsByChat(id);
    } catch (error) {
      this.logger?.warn?.(`deleteRunsByChat failed for chat ${id}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const result = await this.chatsRepository.delete(id);
    if (result.affected === 0) throw new NotFoundException("Chat not found");
    return { ok: true };
  }

  async sendMessageToOrchestrator(chatId: string, content: string, overrideTeamId?: string, overrideProjectId?: string) {
    const { chat, messages } = await this.getById(chatId);
    if (overrideProjectId && overrideProjectId !== chat.projectId) {
      throw new Error(`Chat ${chat.id} belongs to project ${chat.projectId}, but request tried to run on ${overrideProjectId}`);
    }
    const project = await this.projectsRepository.findOneBy({ id: chat.projectId });
    if (!project) throw new Error("Project not found");

    // Вычисляем путь в контейнере (как в runs.service.ts)
    const projectPath = path.resolve(project.localPath || "").replace(
      process.env.HOST_PROJECTS_ROOT || "/projects",
      process.env.CONTAINER_PROJECTS_ROOT || "/workspace",
    );

    const resolvedTeamId = overrideTeamId || project.teamId || chat.teamId;
    if (!resolvedTeamId) throw new Error("Project team is not configured");
    const team = await this.teamsService.getById(resolvedTeamId);
    // Провайдер команды может быть не привязан — тогда берём текущий (активный).
    const provider = team?.provider ?? await this.providersService.getActive().catch(() => null);
    if (!provider) throw new Error("No provider configured — add one in Settings → Providers");
    if (!provider.apiKey) throw new Error("Provider API key is missing");
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

    const systemPrompt = this.loadOrchestratorPrompt(teamLanguage.label, teamLanguage.code, projectPath);
    const memoryEntries = (await this.projectMemoryRepository.find({
      where: { projectId: project.id, isActive: true },
      order: { updatedAt: "DESC" },
      take: 5,
    })).filter((entry) => !this.isPrescriptiveMemoryEntry(entry));

    // Git-контекст: status + diff для оркестратора
    let gitStatus = "";
    let gitDiffStat = "";
    if (project.localPath) {
      try {
        const { execSync } = await import("child_process");
        gitStatus = execSync("git status --short", {
          cwd: project.localPath,
          encoding: "utf-8",
          timeout: 5000,
        }).trim();
      } catch { }
      try {
        const { execSync } = await import("child_process");
        gitDiffStat = execSync("git diff --stat", {
          cwd: project.localPath,
          encoding: "utf-8",
          timeout: 5000,
        }).trim();
      } catch { }
    }

    // Стриминговый запрос к LLM
    const streamResponse = await createLlmStreamRequest({
      url: `${provider.baseUrl.replace(/\/$/, "")}/chat/completions`,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${provider.apiKey}`,
      },
        body: JSON.stringify({
        model: orchestrator.model,
        temperature: orchestrator.temperature ?? 0.2,
        stream: true,
        reasoning_effort: process.env.LLM_REASONING_EFFORT ?? 'high',
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
                  localPath: projectPath,
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
                gitContext: {
                  status: gitStatus || "(нет изменений или git недоступен)",
                  diffStat: gitDiffStat || "(нет изменений)",
                },
                projectMemory: memoryEntries.map((entry) => ({
                  title: entry.title,
                  summary: entry.summary,
                  details: entry.details,
                  graph: entry.graph,
                  kind: entry.kind,
                  tags: entry.tags,
                  relatedFiles: entry.relatedFiles,
                })),
                userMessage: content,
              },
              null,
              2,
            ),
          },
        ],
      }),
      logger: this.logger,
      requestKey: `${provider.id}:${orchestrator.model}`,
      onRetry: ({ attempt, maxAttempts, delayMs, status }) => {
        const seconds = Math.max(1, Math.round(delayMs / 1000));
        this.wsGateway.broadcastTokenStream(chat.id, {
          role: "orchestrator",
          content: status === 429
            ? `\n[жду лимит провайдера ${seconds}с, повтор ${attempt}/${maxAttempts}]`
            : `\n[временная ошибка провайдера, повтор через ${seconds}с ${attempt}/${maxAttempts}]`,
          done: false,
        });
      },
    });

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
    
    // Используем parseJsonSafely для лучшей обработки ошибок и логирования
    const parseResult = parseJsonSafely<any>(text || "{}");
    if (!parseResult.success) {
      this.logger.warn(`Orchestrator returned invalid JSON: ${parseResult.error}. Raw response: ${text.slice(0, 500)}`);
    }
    
    const orchestratorPayload = parseResult.success && parseResult.data 
      ? parseResult.data 
      : {
          message: text || "Оркестратор не вернул ответ.",
          teamSummary: [],
          shouldExecute: false,
          executionTask: "",
        };
    
    // Эвристический fallback: если JSON не распарсился, но сообщение пользователя содержит ключевые слова действий,
    // пытаемся извлечь задачу из сообщения пользователя
    let shouldExecute = Boolean(orchestratorPayload.shouldExecute);
    let executionTask = String(orchestratorPayload.executionTask || content).trim();
    
    if (!parseResult.success && !shouldExecute) {
      // Эвристика включается ТОЛЬКО когда оркестратор не вернул валидный JSON.
      // «проверь/проверить/посмотри/изучи/разберись» — это диагностика, а не
      // правки кода, поэтому их здесь НЕТ. Иначе фраза «проверьте почему такой
      // большой конфирм диалог, код не пишите» форсила запуск команды и
      // разработчик переписывал файлы вопреки просьбе.
      const actionKeywords = [
        'создай', 'создать', 'добавь', 'добавить', 'исправь', 'исправить',
        'реализуй', 'реализовать', 'напиши', 'написать', 'сделай', 'сделать',
        'обнови', 'обновить', 'удали файл', 'рефактор', 'рефакторинг',
        'тестируй', 'запусти', 'запустить',
        'create', 'add', 'fix', 'implement', 'write', 'make', 'update',
        'refactor', 'run', 'execute', 'build', 'deploy',
        // Investigation keywords — команда имеет доступ к файловой системе
        'проверь', 'проверить', 'посмотри', 'посмотреть', 'посмотрите',
        'изучи', 'изучить', 'разберись', 'разобраться',
        'что нового', 'что не закомичено', 'git status', 'git diff',
        'что изменилось', 'что поменялось',
        'check', 'inspect', 'investigate', 'look at',
      ];
      const lowerContent = content.toLowerCase();
      const hasActionKeyword = actionKeywords.some(keyword => lowerContent.includes(keyword));

      if (hasActionKeyword) {
        this.logger.log(`Heuristic fallback triggered: user message contains action keywords, forcing execution`);
        shouldExecute = true;
        executionTask = content;
      }
    }
    
    // Серверный оверрайд: если в ИСХОДНОМ сообщении пользователя есть стоп-фраза
    // «код не пишите / только проверить / без правок», НЕ блокируем shouldExecute,
    // а добавляем ограничение «только чтение» в executionTask. Раньше это форсило
    // shouldExecute=false и оркестратор не мог делегировать «посмотри git status».
    const userStopPhrases = [
      'не пишите код', 'не пишу код', 'код не пишите', 'код не писать',
      'только проверить', 'только проверь', 'только проверьте',
      'просто проверить', 'просто проверь', 'просто проверьте',
      'без правок', 'без изменений', 'ничего не меняй', 'не меняй код',
      "don't write code", 'no code changes', 'just check', 'read only', 'без изменения кода',
    ];
    const userLower = content.toLowerCase();
    const userHasStopPhrase = userStopPhrases.some(p => userLower.includes(p));
    if (userHasStopPhrase && shouldExecute) {
      this.logger.log(`Server override: stop phrase detected — adding READ-ONLY constraint to executionTask`);
      executionTask = `[ТОЛЬКО ЧТЕНИЕ — не менять файлы, не коммитить, не создавать новые файлы]\n${executionTask}\n[ОГРАНИЧЕНИЕ: Только чтение/анализ. Запрещено: запись файлов, git commit, git push, создание файлов, удаление файлов.]`;
    }

    executionTask = this.normalizeExecutionTaskFromUserIntent(content, executionTask, project.localPath || "");

    // Очищаем дублированные пути в executionTask (баг "apps/api/apps/web/...")
    if (project.localPath) {
      const cleanedBefore = executionTask;
      executionTask = cleanupPathsInTask(project.localPath, executionTask, fs.existsSync);
      if (cleanedBefore !== executionTask) {
        this.logger.log(`Cleaned up duplicate paths in executionTask for project ${project.localPath}`);
      }
    }

    // Логируем решение оркестратора
    this.logger.log(`Orchestrator decision: shouldExecute=${shouldExecute}, executionTask="${executionTask}"`);
    
    const requestId = `chatreq-${Date.now()}`;

    let autoRunId: string | null = null;
    let finalOrchestratorMessage = orchestratorPayload.message || "Оркестратор обработал сообщение.";
    
    if (shouldExecute && executionTask) {
      const run = await this.runsService.startRun({
        chatId: chat.id,
        projectId: project.id,
        task: executionTask,
        // ИСХОДНОЕ сообщение пользователя нужно runs.service для детерминированного
        // detectRunMode: executionTask оркестратора часто теряет стоп-фразу «код не
        // пишите», и режим ошибочно определялся как implementation → разраб кодил.
        originalMessage: content,
        teamId: resolvedTeamId,
        teamName: team.name,
        projectPath: projectPath,
      });
      autoRunId = run.runId;
      // Локальная константа со строгим типом string — TS не сужает let autoRunId
      // внутри замыкания .then(), поэтому используем activeRunId для фонового вызова.
      const activeRunId = run.runId;

      // Сохраняем начальное сообщение оркестратора (план) и СРАЗУ возвращаем ответ.
      // Выполнение команды агентами запускаем В ФОНЕ — чтобы фронтенд немедленно
      // получил autoRunId, начал поллинг и показывал прогресс/стрим агентов в реальном времени.
      // Финальное сообщение ("Сделано" / "Ошибка") сохранится в чат после завершения run.
      const initialMessage = [
        finalOrchestratorMessage,
        `Команда запущена в работу. Run ID: ${autoRunId}`,
      ].join("\n");

      const assistantMessage = await this.addMessage(chat.id, "assistant", initialMessage, {
        type: "conversation",
        requestId,
        usage,
        autoRunId,
        orchestratorPayload,
      });

      if (orchestratorPayload?.executionTask) {
        await this.addMessage(chat.id, "assistant", `ТЗ оркестратора:\n${String(orchestratorPayload.executionTask).trim()}`, {
          type: "agent-brief",
          requestId,
          autoRunId,
          agentRole: "orchestrator",
          agentName: orchestrator.name || "Alex",
          agentLabel: orchestrator.label || "Оркестратор",
          executionTask: orchestratorPayload.executionTask,
          teamSummary: Array.isArray(orchestratorPayload?.teamSummary) ? orchestratorPayload.teamSummary : [],
          timestamp: new Date().toISOString(),
        });
      }

      this.logger.log(`Saved initial assistant message to chat ${chat.id}: ${assistantMessage.id}`);

      // Фоновое выполнение команды агентов (НЕ блокирует HTTP-ответ).
      // После завершения сохраняем финальный отчёт оркестратора в чат.
      void this.runsService.executeRunSteps(activeRunId)
        .then(async () => {
          try {
            const completedRun = await this.runsService.getJob(activeRunId);
            if (!completedRun?.run) {
              await this.addMessage(chat.id, "assistant", "Работа завершена, но отчёт недоступен.", {
                type: "conversation",
                requestId,
                autoRunId,
                orchestratorPayload,
                finalReport: true,
              });
              return;
            }
            const runEntity = completedRun.run;
            const report: any = completedRun.report || runEntity.finalReport;

            // Защита от бага "финальный ответ = дубль планировочного сообщения".
            // Слабая LLM-финалка иногда перепечатывает план ("Понял задачу,
            // назначу...") вместо итога. Если детектим это — и у нас есть
            // diagnosis аналитика (режим диагностики) или summary — собираем
            // настоящий ответ из артефактов run, а не из мусорного message.
            const looksLikePlanDup = (msg: string) => /^(понял|назначу|проверю|нужно проверить|давайте|сейчас назначу)/i.test(String(msg || '').trim());

            let finalMessage = "";
            if (runEntity.status === 'completed') {
              const rawMessage = report?.message || report?.summary || "";
              const isPlanDup = looksLikePlanDup(rawMessage);
              const hasDiagnosis = Array.isArray(report?.diagnosis) && report.diagnosis.length;

              if (isPlanDup && report?.mode === 'diagnostics' && hasDiagnosis) {
                // Перепечатка плана в диагностике — собираем реальный диагноз.
                const diagLines = report.diagnosis.map((d: any) => {
                  const file = d?.file || '';
                  const loc = d?.location ? ` (${d.location})` : '';
                  const issue = d?.issue || '';
                  return `• ${file}${loc}: ${issue}`.trim();
                });
                finalMessage = report?.rootCause || report?.summary || 'Найдена причина:';
                if (diagLines.length) finalMessage += `\n\n${diagLines.join('\n')}`;
                if (Array.isArray(report?.recommendations) && report.recommendations.length) {
                  finalMessage += `\n\nРекомендации:\n${report.recommendations.map((r: string) => `• ${r}`).join('\n')}`;
                }
                this.logger.log(`Detected plan-duplication in final report; rebuilt message from diagnosis for run ${autoRunId}`);
              } else if (isPlanDup && hasDiagnosis) {
                // Реализация, но финалка перепечатала план — хотя бы покажем
                // что было сделано из filesChanged/testResult ниже, а message
                // заменим на нейтральное "Работа выполнена".
                finalMessage = report?.summary || 'Работа выполнена.';
              } else if (isPlanDup) {
                // Финалка перепечатала план, а diagnosis пуст (аналитик не дал
                // диагноз). Раньше в этот else-ветке уходил rawMessage = дубль
                // "Понял задачу. Нужно проверить..." — пользователь видел бред.
                // Теперь отдаём нейтральный итог по режиму, без перепечатки плана.
                finalMessage = report?.mode === 'diagnostics'
                  ? 'Проверка завершена: код не изменялся. Аналитик не сформировал конкретный диагноз — попробуйте уточнить вопрос.'
                  : (report?.summary || 'Работа выполнена.');
                this.logger.log(`Plan-duplication in final report without diagnosis; using neutral message for run ${autoRunId}`);
              } else {
                finalMessage = rawMessage || "✅ Сделано. Работа успешно завершена.";
              }
            } else if (runEntity.status === 'failed') {
              finalMessage = `❌ Ошибка: работа не удалась после ${runEntity.retryCount || 3} попыток. ${runEntity.error || 'Неизвестная ошибка'}`;
              if (report?.message && !looksLikePlanDup(report.message)) finalMessage += `\n\n${report.message}`;
            } else {
              finalMessage = `Статус: ${runEntity.status}`;
            }

            if (report?.filesChanged?.length) {
              finalMessage += `\n\n📁 Изменённые файлы:\n${report.filesChanged.map((f: string) => `  • ${f}`).join('\n')}`;
            }
            if (report?.testResult) {
              finalMessage += `\n\n🧪 Тесты: ${report.testResult === 'passed' ? '✅ Пройдены' : '❌ Провалены'}`;
            }
            const shouldShowNextSteps = /(?:следующ|next steps|что дальше|what next|дальше|roadmap|план действий|action items)/i.test(String(content || ""));
            if (shouldShowNextSteps && report?.nextSteps?.length) {
              finalMessage += `\n\n📋 Следующие шаги:\n${report.nextSteps.map((s: string) => `  • ${s}`).join('\n')}`;
            }

            await this.addMessage(chat.id, "assistant", finalMessage, {
              type: "conversation",
              requestId,
              autoRunId,
              orchestratorPayload,
              finalReport: true,
            });
            this.logger.log(`Saved final report message to chat ${chat.id} for run ${autoRunId}`);
          } catch (err) {
            this.logger.error(`Failed to save final report for run ${autoRunId}: ${err instanceof Error ? err.message : String(err)}`);
          }
        })
        .catch(async (error) => {
          const errorMsg = error instanceof Error ? error.message : String(error);
          this.logger.error(`Run ${autoRunId} failed: ${errorMsg}`);
          try {
            await this.addMessage(chat.id, "assistant", `❌ Ошибка при выполнении: ${errorMsg}`, {
              type: "conversation",
              requestId,
              autoRunId,
              orchestratorPayload,
              finalReport: true,
            });
          } catch { /* ignore */ }
        });

      return {
        chat,
        message: assistantMessage,
        createdTasks: [],
        autoRunId,
      };
    }

    // Диалоговый режим: выполнение не требуется — сохраняем обычный ответ оркестратора
    const assistantMessage = await this.addMessage(chat.id, "assistant", finalOrchestratorMessage, {
      type: "conversation",
      requestId,
      usage,
      autoRunId,
      orchestratorPayload,
    });

    this.logger.log(`Saved assistant message to chat ${chat.id}: ${assistantMessage.id}`);

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

  private loadOrchestratorPrompt(languageLabel: string, languageCode: string, workingDirectory: string): string {
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
      .replace(/{{teamLanguageCode}}/g, languageCode)
      .replace(/{{workingDirectory}}/g, workingDirectory);
  }

  private isPrescriptiveMemoryEntry(entry: any): boolean {
    const kind = String(entry?.kind || "").toLowerCase();
    if (kind !== "implementation" && kind !== "feature") return false;

    const text = [
      entry?.title,
      entry?.summary,
      entry?.details,
    ].filter(Boolean).join("\n").toLowerCase();
    if (!text.trim()) return false;

    const imperativeScore = [
      "шаг 1",
      "шаг 2",
      "если чего-то не хватает",
      "добавь ",
      "добавить ",
      "создай ",
      "создать ",
      "computed ",
      "const issending",
      "aria-label",
      "keydown",
      "npm run dev",
      "кнопка отправки",
      "после textarea",
    ].reduce((score, token) => score + (text.includes(token) ? 1 : 0), 0);

    return imperativeScore >= 4 || /команды:\s|последний запуск:\s|тесты:\s/i.test(text);
  }

  private normalizeExecutionTaskFromUserIntent(userMessage: string, executionTask: string, projectPath: string): string {
    const original = String(userMessage || "").trim();
    let task = String(executionTask || "").trim();
    if (!original || !task) return task;
    const existsFn = (p: string) => {
      try { return fs.existsSync(p); } catch { return false; }
    };

    // Очищаем дублированные пути (apps/api/apps/web/... → apps/web/...)
    if (projectPath) {
      task = cleanupPathsInTask(projectPath, task, existsFn);
    }

    const lowerOriginal = original.toLowerCase();
    const lowerTask = task.toLowerCase();
    const isReadOnly = task.includes("[ТОЛЬКО ЧТЕНИЕ");
    const looksLikeOverprescribedPlan =
      /шаг 1|шаг 2|если чего-то не хватает|добавь const|computed |aria-label|tailwind|после textarea|event\.key === 'enter'/i.test(task)
      || task.length > 1400;

    const implementationHints = [
      "исправь", "исправить", "добавь", "добавить", "сделай", "сделать",
      "переделать", "реализуй", "реализовать", "перепиши", "создай", "создать",
      "refactor", "fix", "add", "implement", "make",
    ];
    const looksImplementation = implementationHints.some((hint) => lowerOriginal.includes(hint));
    if (isReadOnly || !looksImplementation || !looksLikeOverprescribedPlan) return task;

    const pathMatches = Array.from(task.matchAll(/\b(?:[a-z0-9_-]+\/)+[a-z0-9_.-]+\b/gi))
      .map((match) => match[0])
      .filter((value) => !isUrlLikePath(value))
      .map((value) => {
        if (!projectPath) return value;
        const cleaned = cleanupPathsInTask(projectPath, value, existsFn).trim();
        return cleaned || value;
      })
      .filter((value) => {
        if (!projectPath || !value) return !!value;
        const fullPath = path.join(projectPath, value);
        const parentPath = path.join(projectPath, path.dirname(value));
        return existsFn(fullPath) || existsFn(parentPath);
      })
      .filter((value, index, arr) => arr.indexOf(value) === index);
    const fileLines = pathMatches.length
      ? `Файлы:\n- ${pathMatches.join("\n- ")}\n`
      : "";

    return [
      `Задача: ${original}`,
      fileLines.trimEnd(),
      "Подход:",
      "- Сначала прочитай текущую реализацию и определи, что уже есть.",
      "- Если нужное поведение уже реализовано корректно под другими именами или в другой структуре файла, не переписывай код ради совпадения названий.",
      "- Внеси только недостающие точечные изменения в реальные файлы проекта.",
      "Ограничения: Не выходить за пределы указанных файлов без необходимости. Не создавать новые файлы и не менять store/API/WebSocket без явной причины.",
    ].filter(Boolean).join("\n");
  }
}
