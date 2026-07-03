import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Run } from '../../persistence/run.entity';
import { StartRunDto } from './dto/start-run.dto';
import { parseJsonSafely, ParseJsonResult } from '../../shared/json';
import { TeamsService } from '../teams/teams.service';
import { ProjectsService } from '../projects/projects.service';
import { ChatsService } from '../chats/chats.service';
import { WsGateway } from '../ws/ws.gateway';
import * as fs from 'fs';
import * as path from 'path';

interface LlmResponse {
  content: string;
  role: string;
  model?: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}

interface StepResult {
  success: boolean;
  artifact?: Record<string, unknown>;
  error?: string;
  rawResponse?: string;
}

interface AgentConfig {
  name?: string;
  label: string;
  model: string;
  multiplier: number;
  temperature: number;
  maxTokens?: number;
}

interface TeamConfig {
  language: string;
  agents: Record<string, AgentConfig>;
  workspace: { maxFiles: number; maxCharsPerFile: number; includeExtensions: string[]; ignoreDirs: string[] };
  run: { maxReviewRounds: number; applyChanges: boolean };
}

interface TestResult {
  passed: boolean;
  tests?: Array<{ name: string; command: string; success: boolean; output: string }>;
  errors?: string[];
}

@Injectable()
export class RunsService {
  private readonly logger = new Logger(RunsService.name);

  constructor(
    @InjectRepository(Run)
    private readonly runRepo: Repository<Run>,
    private readonly teamsService: TeamsService,
    private readonly projectsService: ProjectsService,
    @Inject(forwardRef(() => ChatsService))
    private readonly chatsService: ChatsService,
    private readonly wsGateway: WsGateway,
  ) {}

  async startRun(dto: StartRunDto): Promise<{ runId: string }> {
    const run = this.runRepo.create({
      id: crypto.randomUUID(),
      chatId: dto.chatId,
      task: dto.task,
      teamId: dto.teamId,
      teamName: dto.teamName,
      projectPath: dto.projectPath,
      // ВАЖНО: создаём как 'queued', а НЕ 'running'.
      // Иначе executeRunSteps() увидит status==='running' и сразу выйдет
      // по гварде "already running, skipping", так и не запустив агентов.
      status: 'queued',
      startedAt: new Date(),
    });
    await this.runRepo.save(run);
    return { runId: run.id };
  }

  async list(): Promise<Run[]> {
    return this.runRepo.find({ order: { startedAt: 'DESC' } });
  }

  async getById(id: string): Promise<Run | null> {
    return this.runRepo.findOne({ where: { id } });
  }

  /**
   * Формат ответа для поллинга фронта (startPolling в WorkspaceView.vue).
   * Фронт читает response.status / response.events / response.error,
   * поэтому возвращаем плоскую форму. Поле run оставлено для совместимости.
   */
  async getJob(id: string): Promise<{
    id: string;
    status: string;
    error: string | null;
    events: Array<{ at: string; event: string; payload?: unknown }>;
    report: any;
    run: Run | null;
  }> {
    const run = await this.getById(id);
    if (!run) {
      return { id, status: 'failed', error: 'Run not found', events: [], report: null, run: null };
    }

    let report = run.finalReport ?? null;
    if (run.runDir) {
      try {
        const raw = await fs.promises.readFile(path.join(run.runDir, 'final-report.json'), 'utf8');
        report = JSON.parse(raw);
      } catch {
        // оставляем report из finalReport или null
      }
    }
    return {
      id: run.id,
      status: run.status,
      error: run.error ?? null,
      events: run.events ?? [],
      report,
      run,
    };
  }

  /**
   * Сохраняет событие в run.events (для поллинга) — обязательно,
   * иначе фронт через api.job() не увидит прогресс агентов.
   */
  private async appendRunEvent(runId: string, event: string, payload: unknown): Promise<void> {
    try {
      const run = await this.runRepo.findOne({ where: { id: runId } });
      if (!run) return;
      const events = Array.isArray(run.events) ? run.events : [];
      events.push({ at: new Date().toISOString(), event, payload });
      run.events = events;
      await this.runRepo.save(run);
    } catch (error) {
      this.logger.warn(`Failed to append run event: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Основная оркестрация: orchestrator -> analyst -> developer -> tester -> analyst(memory) -> orchestrator
   * Всё стримится в чат через WebSocket
   */
  async executeRunSteps(runId: string): Promise<void> {
    const MAX_RETRIES = 3;
    
    // Загружаем ран и проверяем, не превышен ли лимит ретраев
    let run = await this.runRepo.findOne({ where: { id: runId } });
    if (!run) return;
    
    // Если уже завершён (completed/failed) и retryCount >= MAX_RETRIES — не запускаем
    if (run.status === 'completed' || (run.status === 'failed' && run.retryCount >= MAX_RETRIES)) {
      this.logger.warn(`Run ${runId} already ${run.status} with ${run.retryCount} retries, skipping`);
      return;
    }
    
    // Если running — возможно, уже выполняется, не запускаем параллельно
    if (run.status === 'running') {
      this.logger.warn(`Run ${runId} already running, skipping`);
      return;
    }

    // Получаем контекст один раз (вне цикла ретраев).
    // ВАЖНО: весь блок загрузки контекста + цикл ретраев обёрнуты в try/catch (ниже,
    // после цикла for). Раньше блок контекста был ВНЕ try — если chatsService/
    // projectsService/teamsService бросали (NotFoundException, provider not
    // configured, agents not configured), executeRunSteps реджектился, но
    // run.status оставался 'queued'. Поллинг фронта крутился вечно на 'queued',
    // чат оставался заблокирован (busy=true), агентов не было видно, финального
    // "Сделано"/"Ошибка" не появлялось. Теперь при падении run помечается failed,
    // в чат идёт agent:activity с ошибкой, polling останавливается и чат
    // разблокируется с понятным сообщением.
    try {
    if (!run.chatId) throw new Error('Run has no chatId');
    const chat = await this.chatsService.getById(run.chatId);
    const projectIdFromChat = chat.chat?.projectId ?? '';
    const project = await this.projectsService.getById(run.projectId ?? projectIdFromChat ?? '');
    const team = await this.teamsService.getById(run.teamId);
    
    const chatId = run.chatId ?? '';
    const projectId = project.id ?? '';
    
    if (!team.provider || !team.provider.apiKey) {
      throw new Error('Team provider not configured');
    }

    const teamConfig = team.config as unknown as TeamConfig;
    const language = teamConfig.language || 'ru';
    const agents = teamConfig.agents || {};
    const workspace = teamConfig.workspace || { maxFiles: 12, maxCharsPerFile: 12000, includeExtensions: ['.ts', '.tsx', '.js', '.jsx', '.json', '.md', '.css', '.html', '.py', '.php', '.vue'], ignoreDirs: ['.git', 'node_modules', 'dist', 'build'] };

    const orchestratorAgent = agents.orchestrator || agents.pm;
    const analystAgent = agents.analyst;
    const developerAgent = agents.developer;
    const testerAgent = agents.tester;
    const reviewerAgent = agents.reviewer;

    if (!orchestratorAgent?.model || !analystAgent?.model || !developerAgent?.model || !testerAgent?.model) {
      throw new Error('Not all agents have models configured');
    }

    // Имена агентов
    const orchName = orchestratorAgent.name || 'Alex';
    const orchLabel = orchestratorAgent.label || 'Оркестратор';
    const anName = analystAgent.name || 'Mira';
    const anLabel = analystAgent.label || 'Аналитик';
    const devName = developerAgent.name || 'Kai';
    const devLabel = developerAgent.label || 'Разработчик';
    const testName = testerAgent.name || 'Nova';
    const testLabel = testerAgent.label || 'Тестировщик';

    const hostProjectsRoot = process.env.LOCAL_PROJECTS_ROOT || '/Users/evgenii';
    const containerProjectsRoot = process.env.CONTAINER_PROJECTS_ROOT || '/host-projects';
    const projectPath = (project.localPath || '').replace(hostProjectsRoot, containerProjectsRoot);
    const projectName = project.name || 'Unknown Project';

    // Цикл ретраев (максимум 3 попытки)
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      // Перезагружаем ран для актуального retryCount
      run = await this.runRepo.findOne({ where: { id: runId } });
      if (!run) return;
      
      run.retryCount = attempt - 1;
      await this.runRepo.save(run);
      
      // Ставим статус running
      await this.runRepo.update(runId, { status: 'running', startedAt: new Date() });
      
      // Уведомляем в чате о попытке
      if (attempt > 1) {
        await this.broadcastActivity(runId, chatId, 'orchestrator', orchName, orchLabel, 'working', `Повторная попытка ${attempt}/${MAX_RETRIES}...`);
      } else {
        await this.broadcastActivity(runId, chatId, 'orchestrator', orchName, orchLabel, 'working', 'Анализирую задачу и планирую работу команды');
      }

      let lastError: string | null = null;
      let success = false;

      try {
        // 1. ORCHESTRATOR - планирует работу.
        // ВАЖНО: повторно НЕ стримим ответ оркестратора в чат — читаемый ответ
        // уже сохранён в chats.service.sendMessageToOrchestrator. Здесь оркестратор
        // вызывается только чтобы построить план для аналитика/разработчика.
        // Повторный token:stream создавал второй пузырь текста в чате (дубль).
        const orchestratorResult = await this.callAgentStream(
          runId, chatId, 'orchestrator', orchestratorAgent, language,
          this.buildOrchestratorPrompt(run, chat.messages, project, teamConfig, projectPath),
          () => { /* no-op: не дублируем стрим оркестратора в чат */ }
        );


        if (!orchestratorResult.success) {
          if (orchestratorResult.rawResponse) {
            const extracted = this.extractPlanFromText(orchestratorResult.rawResponse);
            if (extracted) {
              orchestratorResult.success = true;
              orchestratorResult.artifact = extracted;
            }
          }
        }

        if (!orchestratorResult.success) {
          throw new Error(`Orchestrator failed: ${orchestratorResult.error}`);
        }

        let plan = orchestratorResult.artifact || {};
        const executionTask = (plan as any).executionTask || run.task;

        // ВАЖНО: НЕ останавливаем конвейер на shouldExecute=false.
        // Run стартует ТОЛЬКО когда chats.service уже решил shouldExecute=true.
        // Раньше здесь оркестратор на другом промпте мог передумать (увидев в
        // истории «код не пишите») и поставить shouldExecute=false → конвейер
        // обрывался, в чат писался дубль-ответ, run завершался, чат
        // разблокировался ДО того, как поработают агенты. Это и был баг
        // «оркестратор закрывает работу раньше агентов».
        // Теперь конвейер идёт до конца: аналитик исследует код, разработчик
        // по ТЗ «не писать код» вернёт SUMMARY: Нет изменений, тестер
        // подтвердит, финальный отчёт суммирует результат.
        await this.broadcastActivity(runId, chatId, 'orchestrator', orchName, orchLabel, 'done', 'План готов, передаю аналитику');


        // 2. ANALYST
        await this.broadcastActivity(runId, chatId, 'analyst', anName, anLabel, 'working', 'Изучаю задачу, пишу техническое задание');

        const analystResult = await this.callAgentStream(
          runId, chatId, 'analyst', analystAgent, language,
          this.buildAnalystPrompt(run, plan, project, chat.messages, projectPath, workspace),
          (delta) => this.wsGateway.broadcastTokenStream(chatId, { role: 'analyst', content: delta, done: false })
        );

        if (!analystResult.success && analystResult.rawResponse) {
          const fixed = this.tryFixAgentJson(analystResult.rawResponse, 'analyst');
          if (fixed) {
            analystResult.success = true;
            analystResult.artifact = fixed;
          }
        }

        if (!analystResult.success) {
          throw new Error(`Analyst failed: ${analystResult.error}`);
        }

        await this.broadcastActivity(runId, chatId, 'analyst', anName, anLabel, 'done', 'ТЗ готово, передаю разработчику');

        const spec = analystResult.artifact || {};
        await this.saveProjectMemory(projectId, chatId, spec, language);

        // 3. DEVELOPER
        await this.broadcastActivity(runId, chatId, 'developer', devName, devLabel, 'working', 'Начинаю реализацию по ТЗ');

        const devSpec = {
          files: (spec as any).files || [],
          requirements: (spec as any).requirements || [],
          feature: (spec as any).feature || '',
          description: (spec as any).description || '',
        };

        const developerResult = await this.callAgentStream(
          runId, chatId, 'developer', developerAgent, language,
          this.buildDeveloperPrompt(run, devSpec, project, workspace, projectPath),
          (delta) => this.wsGateway.broadcastTokenStream(chatId, { role: 'developer', content: delta, done: false })
        );

        if (!developerResult.success && developerResult.rawResponse) {
          // Слабые модели часто ломают JSON, когда пишут код в "content"
          // (неэкранированные переносы и кавычки). Маркерный формат решает это
          // кардинально — код между маркерами не требует экранирования.
          // ВАЖНО: маркерный формат проверяем ПЕРВЫМ — он приоритетнее для
          // разработчика. Иначе tryFixAgentJson может случайно распарсить
          // кусок кода {...} из маркерного ответа как JSON и вернуть мусор.
          const fixed = this.parseDeveloperMarkerFormat(developerResult.rawResponse)
            ?? this.tryFixDeveloperJson(developerResult.rawResponse);
          if (fixed) {
            developerResult.success = true;
            developerResult.artifact = fixed;
          }
        }

        if (!developerResult.success) {
          throw new Error(`Developer failed: ${developerResult.error}`);
        }

        await this.broadcastActivity(runId, chatId, 'developer', devName, devLabel, 'done', 'Код написан');

        const codeChanges = developerResult.artifact || {};
        const files = (codeChanges as any).files;
        const applyChanges = teamConfig.run?.applyChanges !== false; // по умолчанию true
        if (files && Array.isArray(files)) {
          for (const fileChange of files) {
            await this.applyFileChange(projectPath, fileChange, applyChanges);
            const verb = applyChanges ? 'Изменён' : 'Запланирован (dry-run, не записан)';
            await this.broadcastActivity(runId, chatId, 'developer', devName, devLabel, 'working', `${verb} файл: ${fileChange.path} (${fileChange.action})`);
          }
        }

        // 4. TESTER
        await this.broadcastActivity(runId, chatId, 'tester', testName, testLabel, 'working', 'Запускаю тесты');

        const testerResult = await this.callAgentStream(
          runId, chatId, 'tester', testerAgent, language,
          this.buildTesterPrompt(run, codeChanges, project),
          (delta) => this.wsGateway.broadcastTokenStream(chatId, { role: 'tester', content: delta, done: false })
        );

        if (!testerResult.success && testerResult.rawResponse) {
          const fixed = this.tryFixAgentJson(testerResult.rawResponse, 'tester');
          if (fixed) {
            testerResult.success = true;
            testerResult.artifact = fixed;
          }
        }

        if (!testerResult.success) {
          throw new Error(`Tester failed: ${testerResult.error}`);
        }

        const testResults: TestResult = (testerResult.artifact as unknown as TestResult) || { passed: true, tests: [] };
        await this.broadcastActivity(runId, chatId, 'tester', testName, testLabel, testResults.passed ? 'done' : 'error', testResults.passed ? 'Тесты пройдены' : `Тесты упали: ${(testResults.errors || []).join(', ') || 'unknown'}`);

        // 5. ANALYST - память
        await this.broadcastActivity(runId, chatId, 'analyst', anName, anLabel, 'working', 'Обновляю документацию проекта');

        const memoryUpdate = {
          ...spec,
          lastRun: {
            task: run.task,
            status: testResults.passed ? 'success' : 'failed',
            testResults,
            codeChanges: files?.map((f: any) => f.path) || [],
            timestamp: new Date().toISOString(),
          },
        };
        await this.saveProjectMemory(projectId, chatId, memoryUpdate, language);

        await this.broadcastActivity(runId, chatId, 'analyst', anName, anLabel, 'done', 'Документация обновлена');

        // 6. ORCHESTRATOR - финальный отчет
        await this.broadcastActivity(runId, chatId, 'orchestrator', orchName, orchLabel, 'working', 'Формирую итоговый отчет');

        const finalReport = await this.callAgentStream(
          runId, chatId, 'orchestrator', orchestratorAgent, language,
          this.buildFinalReportPrompt(run, plan, spec, codeChanges, testResults, memoryUpdate),
          (delta) => this.wsGateway.broadcastTokenStream(chatId, { role: 'orchestrator', content: delta, done: false })
        );

        if (!finalReport.success && finalReport.rawResponse) {
          const fixed = this.tryFixAgentJson(finalReport.rawResponse, 'orchestrator');
          if (fixed) {
            finalReport.success = true;
            finalReport.artifact = fixed;
          }
        }

        if (!finalReport.success) {
          throw new Error(`Final report failed: ${finalReport.error}`);
        }

        await this.broadcastActivity(runId, chatId, 'orchestrator', orchName, orchLabel, 'done', 'Работа завершена');

        // УСПЕХ — сохраняем и выходим из цикла
        run = await this.runRepo.findOne({ where: { id: runId } });
        if (run) {
          run.status = testResults.passed ? 'completed' : 'failed';
          run.finishedAt = new Date();
          run.finalReport = finalReport.artifact || { summary: finalReport.rawResponse };
          await this.runRepo.save(run);
        }
        success = true;
        break;

      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        this.logger.error(`Run ${runId} attempt ${attempt}/${MAX_RETRIES} failed: ${lastError}`);
        
        // Сохраняем ошибку и retryCount
        run = await this.runRepo.findOne({ where: { id: runId } });
        if (run) {
          run.error = lastError;
          run.retryCount = attempt;
          await this.runRepo.save(run);
        }
        
        // Уведомляем в чате о неудаче попытки
        await this.broadcastActivity(runId, chatId, 'orchestrator', orchName, orchLabel, 'error', `Попытка ${attempt}/${MAX_RETRIES} не удалась: ${lastError}`);
        
        // Если это последняя попытка — финальный фейл
        if (attempt === MAX_RETRIES) {
          run = await this.runRepo.findOne({ where: { id: runId } });
          if (run) {
            run.status = 'failed';
            run.finishedAt = new Date();
            await this.runRepo.save(run);
          }
          
          // Финальное сообщение оркестратора с итоговой причиной
          await this.broadcastActivity(runId, chatId, 'orchestrator', orchName, orchLabel, 'error', `Не получилось выполнить за ${MAX_RETRIES} попыток. Последняя ошибка: ${lastError}`);
          break;
        }
        
        // Небольшая пауза перед следующей попыткой
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
    } catch (contextError) {
      // Блок загрузки контекста (chat/project/team/provider/agents) упал ВНЕ
      // внутреннего try/catch попытки — chatsService.getById/projectsService.getById/
      // teamsService.getById бросили NotFoundException, либо "Team provider not
      // configured" / "Not all agents have models configured". Раньше такой throw
      // реджектил промис executeRunSteps, но run.status оставался 'queued' →
      // polling фронта крутился вечно на 'queued', чат оставался заблокирован
      // (busy=true), агентов не было видно, финального "Сделано"/"Ошибка" не было.
      // Это и был баг «оркестратор закрывает работу раньше агентов» в варианте
      // «вообще не запустилось». Теперь помечаем run failed, шлём agent:activity с
      // причиной — polling увидит status='failed' и остановит таймер, чат
      // разблокируется, а .then() в chats.service сохранит понятное сообщение.
      const errMsg = contextError instanceof Error ? contextError.message : String(contextError);
      this.logger.error(`Run ${runId} failed before/at context load: ${errMsg}`);
      try {
        const failedRun = await this.runRepo.findOne({ where: { id: runId } });
        if (failedRun && failedRun.status !== 'failed' && failedRun.status !== 'completed') {
          failedRun.status = 'failed';
          failedRun.finishedAt = new Date();
          failedRun.error = errMsg;
          failedRun.retryCount = MAX_RETRIES;
          await this.runRepo.save(failedRun);
        }
        const cid = (failedRun?.chatId ?? run?.chatId ?? '') as string;
        if (cid) {
          await this.broadcastActivity(runId, cid, 'orchestrator', 'Alex', 'Оркестратор', 'error', `Не удалось запустить команду: ${errMsg}`);
        }
      } catch (innerErr) {
        this.logger.error(`Run ${runId} failed to persist failure state: ${innerErr instanceof Error ? innerErr.message : String(innerErr)}`);
      }
    }
  }

  /**
   * Вызывает агента с стримингом токенов в WebSocket
   */
  private async callAgentStream(
    runId: string,
    chatId: string,
    stepName: string,
    agent: AgentConfig,
    language: string,
    prompt: string,
    onToken: (delta: string) => void
  ): Promise<StepResult> {
    const run = await this.runRepo.findOne({ where: { id: runId } });
    if (!run) return { success: false, error: `Run ${runId} not found` };

    const team = await this.teamsService.getById(run.teamId);
    if (!team.provider || !team.provider.apiKey) {
      return { success: false, error: 'Provider not configured' };
    }

    const provider = team.provider;
    const model = agent.model;
    const temperature = agent.temperature ?? 0.2;

    try {
      // System-prompt зависит от шага. Для разработчика используем маркерный
      // формат (код без экранирования), для остальных — строгий JSON.
      // Если смешать требование JSON с маркерным промптом, слабая модель
      // запутается и вернёт JSON с неэкранированным кодом -> парсинг упадёт.
      const systemContent = stepName === 'developer'
        ? `You are ${agent.name ?? agent.label ?? stepName}. Respond in ${language}. Use the MARKER format exactly as instructed in the task (SUMMARY:, FILE:, ACTION:, DESCRIPTION:, CONTENT_START/CONTENT_END, PATCH_START/SEARCH:/REPLACE:/PATCH_END). Do NOT wrap the answer in JSON. Do NOT use markdown code fences. Write code between markers AS-IS, without escaping quotes or newlines.`
        : `You are ${agent.name ?? agent.label ?? stepName}. Respond in ${language}. Return ONLY valid JSON. No markdown, no code fences, no text before or after the JSON object.`;

      const response = await fetch(`${provider.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${provider.apiKey}`,
        },
        body: JSON.stringify({
          model,
          temperature,
          stream: true,
          max_tokens: agent.maxTokens ?? Number(process.env.AGENT_MAX_TOKENS ?? 8000),
          messages: [
            { role: 'system', content: systemContent },
            { role: 'user', content: prompt },
          ],
        }),
      });

      if (!response.ok) {
        throw new Error(`API request failed (${response.status}): ${await response.text()}`);
      }

      let fullContent = '';
      let totalUsage: any = null;
      let finishReason: string | undefined;
      const reader = response.body?.getReader();
      const decoder = new TextDecoder();

      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          const lines = chunk.split('\n');
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const dataStr = line.slice(6).trim();
              if (dataStr === '[DONE]') continue;
              try {
                const data = JSON.parse(dataStr);
                const choice = data.choices?.[0];
                const delta = choice?.delta?.content;
                if (delta) {
                  fullContent += delta;
                  onToken(delta);
                }
                if (choice?.finish_reason) finishReason = choice.finish_reason;
                if (data.usage) totalUsage = data.usage;
              } catch { }
            }
          }
        }
      }

      // Финальный токен
      onToken('');

      if (finishReason === 'length') {
        this.logger.warn(`Agent ${stepName} truncated by max_tokens (finish_reason=length) for run ${runId}; JSON may be incomplete. Consider raising AGENT_MAX_TOKENS or splitting the task.`);
      }

      // Парсим JSON ответ
      const parseResult = parseJsonSafely(fullContent);
      
      // Сохраняем артефакт
      const artifactPath = this.getArtifactPath(runId, stepName);
      this.ensureArtifactDir(runId);
      const artifactContent = {
        role: stepName,
        prompt,
        rawResponse: fullContent,
        parsed: parseResult.success ? parseResult.data : null,
        parseError: parseResult.error,
        timestamp: new Date().toISOString(),
        model,
        usage: totalUsage,
      };
      fs.writeFileSync(artifactPath, JSON.stringify(artifactContent, null, 2), 'utf-8');

      if (!parseResult.success) {
        this.logger.error(`Failed to parse JSON for run ${runId}, step ${stepName}: ${parseResult.error}`);
        this.logger.error(`Raw response (first 1000 chars): ${fullContent.slice(0, 1000)}`);
        
        // Эвристический fallback для оркестратора: если JSON не распарсился, но это первый шаг (orchestrator)
        // и ответ содержит похожий на план текст, пытаемся извлечь план
        if (stepName === 'orchestrator' && fullContent.includes('plan') && fullContent.includes('assignments')) {
          try {
            const extracted = this.extractPlanFromText(fullContent);
            if (extracted) {
              return { success: true, artifact: extracted, rawResponse: fullContent };
            }
          } catch { }
        }
        
        return { success: false, error: parseResult.error, rawResponse: fullContent };
      }

      return { success: true, artifact: parseResult.data as Record<string, unknown>, rawResponse: fullContent };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Agent ${stepName} failed for run ${runId}: ${errorMsg}`);
      this.logger.error(`Stack trace: ${error instanceof Error ? error.stack : 'no stack'}`);
      return { success: false, error: errorMsg };
    }
  }

  // TODO: Update task progress
  // - [x] Analyze chats.service.ts for orchestrator integration
  // - [x] Check runs.service.ts for executeRunSteps error handling
  // - [x] Check json.ts for parseJsonSafely implementation
  // - [x] Check orchestrator prompt for JSON requirements
  // - [x] Identify JSON parsing issues
  // - [x] Add proper error logging

  private extractPlanFromText(text: string): Record<string, unknown> | null {
    try {
      // Ищем JSON-подобную структуру в тексте
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (parsed.plan && parsed.assignments) {
          return parsed;
        }
      }
    } catch { }
    return null;
  }

  /**
   * Пытается исправить JSON от разработчика, где content не экранирован.
   * Разработчик часто пишет код прямо в JSON без escape переносов строк и кавычек.
   */
  private tryFixDeveloperJson(text: string): Record<string, unknown> | null {
    return this.tryFixAgentJson(text, 'developer');
  }

  /**
   * Парсит МАРКЕРНЫЙ формат ответа разработчика. Это надёжная альтернатива
   * JSON для слабых моделей: код пишется как есть между явными маркерами,
   * БЕЗ экранирования переносов и кавычек. JSON-парсинг разработчика падает
   * почти всегда именно потому, что модель не экранирует код внутри "content".
   *
   * Формат:
   *   SUMMARY: текст сводки
   *
   *   FILE: путь/к/файлу
   *   ACTION: create|update|delete
   *   DESCRIPTION: что сделано
   *   PATCH_START
   *   SEARCH:
   *   <фрагмент который искать>
   *   REPLACE:
   *   <фрагмент на который заменить>
   *   PATCH_END
   *
   *   FILE: другой/файл
   *   ACTION: create
   *   DESCRIPTION: что сделано
   *   CONTENT_START
   *   <весь код файла>
   *   CONTENT_END
   *
   * Возвращает тот же artifact-объект { files: [...], summary }, что и JSON-путь,
   * поэтому остальной конвейер (applyFileChange) работает без изменений.
   */
  private parseDeveloperMarkerFormat(text: string): Record<string, unknown> | null {
    try {
      if (!text || typeof text !== 'string') return null;
      // Требуем хотя бы один маркер FILE, иначе это не маркерный формат.
      if (!/^[ \t]*FILE:/m.test(text)) return null;

      const files: Array<Record<string, unknown>> = [];

      // Сводка (необязательна).
      const summaryMatch = text.match(/^[ \t]*SUMMARY:[ \t]*(.+?)$/m);
      const summary = summaryMatch ? summaryMatch[1].trim() : '';

      // Разбиваем на блоки по маркеру FILE:.
      const fileBlocks = text.split(/^[ \t]*FILE:[ \t]*/m).slice(1);
      for (const block of fileBlocks) {
        const lines = block.split('\n');

        // Первая строка блока — путь.
        const filePath = (lines.shift() || '').trim();
        if (!filePath) continue;

        // action
        const actionIdx = lines.findIndex((l) => /^\s*ACTION:\s*/i.test(l));
        let action = 'update';
        if (actionIdx >= 0) {
          const m = lines[actionIdx].match(/^\s*ACTION:\s*(\w+)/i);
          if (m) action = m[1].toLowerCase();
          lines.splice(actionIdx, 1);
        }

        // description
        const descIdx = lines.findIndex((l) => /^\s*DESCRIPTION:\s*/i);
        let description = '';
        if (descIdx >= 0) {
          const m = lines[descIdx].match(/^\s*DESCRIPTION:\s*(.*)$/i);
          if (m) description = m[1].trim();
          lines.splice(descIdx, 1);
        }

        const rest = lines.join('\n');

        const fileObj: Record<string, unknown> = { path: filePath, action, description };

        if (action === 'delete') {
          files.push(fileObj);
          continue;
        }

        // Патч-блоки (SEARCH/REPLACE).
        if (action === 'update') {
          const patches: Array<{ search: string; replace: string }> = [];
          const patchRe = /PATCH_START\s*SEARCH:\s*([\s\S]*?)\s*REPLACE:\s*([\s\S]*?)\s*PATCH_END/g;
          let m: RegExpExecArray | null;
          while ((m = patchRe.exec(rest)) !== null) {
            patches.push({
              search: m[1].replace(/\r\n/g, '\n').trim(),
              replace: m[2].replace(/\r\n/g, '\n'),
            });
          }
          if (patches.length > 0) {
            fileObj.patches = patches;
            files.push(fileObj);
            continue;
          }
        }

        // Полный контент (CONTENT_START ... CONTENT_END).
        const contentMatch = rest.match(/CONTENT_START\s*([\s\S]*?)\s*CONTENT_END/);
        if (contentMatch) {
          fileObj.content = contentMatch[1].replace(/\r\n/g, '\n');
          files.push(fileObj);
          continue;
        }

        // Если ни патчей, ни контента не нашлось — всё равно добавим файл
        // (возможно, модель просто пометила его без изменений).
        files.push(fileObj);
      }

      if (!files.length) return null;
      return { files, summary };
    } catch (error) {
      this.logger.warn(`parseDeveloperMarkerFormat failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /**
   * Универсальный фоллбек для исправления JSON от любого агента.
   * Парсит JSON токенами и экранирует неэкранированные строковые значения.
   */
  private tryFixAgentJson(text: string, agentType: string): Record<string, unknown> | null {
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;
      
      let jsonStr = jsonMatch[0];
      
      // Пытаемся распарсить как есть
      try {
        return JSON.parse(jsonStr);
      } catch { }
      
      // Парсим JSON вручную, экранируя строковые значения
      const fixed = this.parseAndFixJson(jsonStr);
      if (fixed) {
        try {
          return JSON.parse(fixed);
        } catch { }
      }
      
    } catch { }
    return null;
  }

  /**
   * Парсит JSON строку токенами и экранирует содержимое строковых значений.
   * Обрабатывает вложенные объекты, массивы и экранированные кавычки внутри строк.
   */
  private parseAndFixJson(jsonStr: string): string | null {
    let result = '';
    let i = 0;
    let inString = false;
    let escapeNext = false;
    let stringStart = -1;
    const stringValues: Array<{ start: number; end: number; content: string }> = [];
    
    // Первый проход: находим все строковые значения и их позиции
    while (i < jsonStr.length) {
      const ch = jsonStr[i];
      
      if (escapeNext) {
        escapeNext = false;
        i++;
        continue;
      }
      
      if (ch === '\\') {
        escapeNext = true;
        i++;
        continue;
      }
      
      if (ch === '"' && !escapeNext) {
        if (!inString) {
          // Начало строки
          inString = true;
          stringStart = i;
        } else {
          // Конец строки
          inString = false;
          const content = jsonStr.slice(stringStart + 1, i);
          stringValues.push({ start: stringStart + 1, end: i, content });
        }
      }
      i++;
    }
    
    // Если строки не сбалансированы, возвращаем null
    if (inString || stringValues.length === 0) {
      return null;
    }
    
    // Второй проход: строим исправленную строку, заменяя содержимое строк на экранированное
    // Идем с конца, чтобы не сбить индексы
    let lastEnd = jsonStr.length;
    const parts: string[] = [];
    
    for (let idx = stringValues.length - 1; idx >= 0; idx--) {
      const { start, end, content } = stringValues[idx];
      // Добавляем часть после строки
      parts.unshift(jsonStr.slice(end, lastEnd));
      // Добавляем экранированное содержимое строки в кавычках
      const escaped = content
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')
        .replace(/\t/g, '\\t');
      parts.unshift(`"${escaped}"`);
      // Добавляем часть перед строкой (включая открывающую кавычку)
      parts.unshift(jsonStr.slice(stringValues[idx - 1]?.end ?? 0, start));
      lastEnd = stringValues[idx - 1]?.end ?? 0;
    }
    
    // Добавляем начало строки до первой строки
    if (lastEnd > 0) {
      parts.unshift(jsonStr.slice(0, lastEnd));
    }
    
    return parts.join('');
  }

  private ensureArtifactDir(runId: string): void {
    const dir = path.join(process.cwd(), 'runs', runId, 'artifacts');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  private getArtifactPath(runId: string, stepName: string): string {
    return path.join(process.cwd(), 'runs', runId, 'artifacts', `${stepName}.json`);
  }

  private async broadcastActivity(
    runId: string,
    chatId: string,
    role: string,
    name: string,
    label: string,
    status: 'working' | 'done' | 'error',
    message: string
  ): Promise<void> {
    // Единая форма payload: фронт (WorkspaceView.vue) читает payload.role,
    // payload.detail, payload.agentName и payload.status.
    const activityPayload = {
      runId,
      role,
      agentName: name,
      name,
      label,
      detail: message, // фронт использует payload.detail
      message,
      status,
      timestamp: new Date().toISOString(),
    };

    // 1) Сохраняем в run.events — чтобы поллинг (api.job) видел прогресс.
    await this.appendRunEvent(runId, 'agent:activity', activityPayload);

    // 2) Broadcast via WebSocket for real-time UI updates
    this.wsGateway.broadcastRunEvent(runId, chatId, 'agent:activity', activityPayload);

    // 3) Also save as a chat message for persistence and history
    try {
      await this.chatsService.addMessage(chatId, 'assistant', message, {
        type: 'agent-status',
        runId,
        agentRole: role,
        agentName: name,
        agentLabel: label,
        status,
        timestamp: new Date().toISOString(),
      });
      this.logger.log(`Saved agent activity to chat: ${role} - ${message}`);
    } catch (error) {
      this.logger.warn(`Failed to save agent activity to chat: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async applyFileChange(
    projectPath: string,
    fileChange: { path: string; action: string; content?: string; description?: string; patches?: Array<{ search: string; replace: string }> },
    applyChanges = true,
  ): Promise<void> {
    const fullPath = path.join(projectPath, fileChange.path);

    // dry-run: НЕ трогаем диск. Только логируем намерение. Так команда с
    // run.applyChanges=false работает как "только предложения" и не портит
    // файлы — это безопасно для диагностических/исследовательских запусков.
    if (!applyChanges) {
      this.logger.log(`[dry-run] skip applying ${fileChange.action} to ${fileChange.path}`);
      return;
    }

    const dir = path.dirname(fullPath);

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    if (fileChange.action === 'create' || fileChange.action === 'update') {
      // Патч-режим: применяем точечные SEARCH/REPLACE к существующему файлу.
      // Это критично для legacy-спагетти: не нужно переписывать весь файл целиком,
      // экономим токены и не теряем существующую логику.
      const patches = Array.isArray(fileChange.patches) ? fileChange.patches : [];
      if (fileChange.action === 'update' && patches.length > 0 && fs.existsSync(fullPath)) {
        let current = fs.readFileSync(fullPath, 'utf-8');
        for (const p of patches) {
          if (typeof p.search !== 'string' || typeof p.replace !== 'string') continue;
          if (current.includes(p.search)) {
            current = current.replace(p.search, p.replace);
          } else {
            this.logger.warn(`Patch search block not found in ${fileChange.path}; skipping that patch.`);
          }
        }
        fs.writeFileSync(fullPath, current, 'utf-8');
        return;
      }
      fs.writeFileSync(fullPath, fileChange.content ?? '', 'utf-8');
    } else if (fileChange.action === 'delete') {
      if (fs.existsSync(fullPath)) {
        fs.unlinkSync(fullPath);
      }
    }
  }

  /**
   * Строит компактный индекс проекта: список релевантных файлов с размерами
   * + короткое дерево директорий. Даёт агентам "карту" проекта, чтобы они
   * не выдумывали пути и не сериализовали всё подряд. Без этого слабые модели
   * фантазируют структуру и тратят токены на несуществующие файлы.
   */
  private buildProjectIndex(projectPath: string, workspace: any, maxFiles = 50): string {
    try {
      if (!projectPath || !fs.existsSync(projectPath)) {
        return 'Проект недоступен для индексации (путь не существует).';
      }
      const ignoreDirs = new Set(Array.isArray(workspace?.ignoreDirs) ? workspace.ignoreDirs : ['.git', 'node_modules', 'dist', 'build']);
      const includeExts = Array.isArray(workspace?.includeExtensions) && workspace.includeExtensions.length
        ? new Set(workspace.includeExtensions)
        : null;

      const collected: Array<{ rel: string; size: number }> = [];
      const walk = (absDir: string, relDir: string, depth: number) => {
        if (collected.length >= maxFiles || depth > 6) return;
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(absDir, { withFileTypes: true });
        } catch {
          return;
        }
        // Сначала директории, затем файлы — для читаемого дерева.
        entries.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));
        for (const entry of entries) {
          if (entry.name.startsWith('.')) continue;
          const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
          if (entry.isDirectory()) {
            if (ignoreDirs.has(entry.name)) continue;
            walk(path.join(absDir, entry.name), rel, depth + 1);
          } else {
            if (includeExts) {
              const ext = path.extname(entry.name).toLowerCase();
              if (ext && !includeExts.has(ext)) continue;
            }
            try {
              const stat = fs.statSync(path.join(absDir, entry.name));
              collected.push({ rel, size: stat.size });
            } catch { }
            if (collected.length >= maxFiles) break;
          }
        }
      };
      walk(projectPath, '', 0);

      if (!collected.length) return 'В проекте нет файлов по выбранным расширениям.';
      const lines = collected.map(f => {
        const kb = f.size > 1024 ? `${(f.size / 1024).toFixed(1)}KB` : `${f.size}B`;
        return `${f.rel}  (${kb})`;
      });
      return `Найдено ${collected.length} файлов (показаны первые ${maxFiles}):\n${lines.join('\n')}`;
    } catch (error) {
      return `Не удалось проиндексировать проект: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  /**
   * Читает существующее содержимое файла (обрезанное по лимиту), чтобы
   * разработчик видел текущий код legacy-файла и мог сделать точечный патч
   * вместо полной перегенерации. Без этого на спагетти-файлах модель теряет
   * контекст и переписывает файл с нуля, ломая существующую логику.
   */
  private readFileForContext(projectPath: string, relPath: string, maxChars = 8000): string {
    try {
      const fullPath = path.join(projectPath, relPath);
      if (!fs.existsSync(fullPath)) return '';
      const raw = fs.readFileSync(fullPath, 'utf-8');
      if (raw.length <= maxChars) return raw;
      return `${raw.slice(0, maxChars)}\n.../* файл обрезан (${raw.length} символов); используй patch для точечных правок, не переписывай весь файл */`;
    } catch {
      return '';
    }
  }

  private async saveProjectMemory(projectId: string, chatId: string, memory: any, language: string): Promise<void> {
    try {
      // Аналитик ведёт осмысленную документацию проекта (не JSON-свалку).
      // memory — это spec (ТЗ) на шаге 2 либо memoryUpdate (spec + lastRun) на шаге 5.
      const feature = memory.feature || memory.lastRun?.task || 'Выполнение задачи';
      const summaryText = String(memory.summary || memory.description || feature).slice(0, 1000);

      const detailLines: string[] = [];
      if (memory.description) detailLines.push(`Описание: ${memory.description}`);
      if (Array.isArray(memory.requirements) && memory.requirements.length) {
        detailLines.push(`Требования: ${(memory.requirements as string[]).join('; ')}`);
      }
      if (Array.isArray(memory.acceptanceCriteria) && memory.acceptanceCriteria.length) {
        detailLines.push(`Критерии приёмки: ${(memory.acceptanceCriteria as string[]).join('; ')}`);
      }
      if (memory.lastRun) {
        const status = memory.lastRun.status === 'success' ? 'успешно' : 'с ошибкой';
        detailLines.push(`Последний запуск: ${status} — ${memory.lastRun.task}`);
        if (memory.lastRun.testResults) {
          detailLines.push(`Тесты: ${memory.lastRun.testResults.passed ? 'пройдены' : 'провалены'}`);
        }
      }
      const detailsText = detailLines.join('\n') || `Language: ${language}`;

      const relatedFiles: string[] = Array.isArray(memory.lastRun?.codeChanges)
        ? memory.lastRun.codeChanges
        : Array.isArray(memory.files)
          ? (memory.files as Array<{ path?: string }>).map((f) => f.path).filter(Boolean)
          : [];

      await this.projectsService.saveMemory({
        projectId,
        title: `Документация: ${String(feature).slice(0, 180)}`,
        summary: summaryText,
        details: detailsText,
        kind: 'feature',
        tags: ['auto-generated', 'run'],
        relatedFiles,
        sourceRunId: null,
      } as any);
    } catch (error) {
      this.logger.warn(`Failed to save project memory: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private buildOrchestratorPrompt(run: Run, messages: any[], project: any, teamConfig: TeamConfig, projectPath: string): string {
    const recentMessages = messages?.slice(-10).map(m => `${m.role}: ${m.content}`).join('\n') || 'Нет истории';
    const index = projectPath ? this.buildProjectIndex(projectPath, teamConfig.workspace, 50) : '';
    return `Ты — Оркестратор. Проанализируй задачу и создай план работы для команды.

ПРОЕКТ: ${project.name || 'Unknown'}
ПУТЬ: ${project.localPath || ''}
ЗАДАЧА: ${run.task}

КАРТА ПРОЕКТА (используй только эти реальные пути, не выдумывай файлы):
${index}

ИСТОРИЯ ЧАТА (последние 10):
${recentMessages}

Твоя задача — понять, что именно делать, и раздать роли команде. НЕ пиши код. НЕ анализируй файлы подробно (это работа аналитика).

ПРАВИЛА (КРИТИЧНО):
1. ВЕРНИ ТОЛЬКО ОДИН ВАЛИДНЫЙ JSON-ОБЪЕКТ. Никакого markdown, никаких \`\`\`json блоков, никакого текста до или после { }.
2. Запуск УЖЕ идёт — команда всегда работает. ВСЕГДА заполняй assignments для аналитика, разработчика и тестера.
3. Для диагностических задач («проверь почему», «найди причину», «код не пишите», «просто проверьте»): аналитик исследует код и находит причину, разработчику дай задачу «не вносить правок, только подтвердить выводы аналитика» (он вернёт «Нет изменений»), тестер проверяет логику. Итоговый отчёт соберёт диагноз.
4. Для задач на изменения: аналитик пишет ТЗ, разработчик вносит точечные правки, тестер проверяет.
5. НЕ выдумывай пути файлов — используй только КАРТУ ПРОЕКТА выше.


Схема ответа:
{"message":"string - что ты понял и что сделает команда","teamSummary":["string"],"shouldExecute":true,"executionTask":"string - краткая задача для команды","plan":["string - шаги"],"assignments":{"analyst":"string","developer":"string","tester":"string"}}

ПРИМЕР (диагностическая задача — код не пишем):
{"message":"Понял. Назначу аналитика для поиска причины.","teamSummary":["Alex: координирует","Mira: исследует код"],"shouldExecute":true,"executionTask":"Найти причину X, код не менять","plan":["Анализ кода","Подтверждение причины"],"assignments":{"analyst":"Изучить код и найти причину","developer":"Не вносить правок, подтвердить выводы аналитика","tester":"Проверить логику вывода"}}

ПРИМЕР (задача на изменения):
{"message":"Понял. Назначу аналитика и разработчика.","teamSummary":["Alex: координирует","Mira: пишет ТЗ"],"shouldExecute":true,"executionTask":"Исправить баг X в модуле Y","plan":["Анализ","Реализация","Тесты"],"assignments":{"analyst":"Найти причину в коде","developer":"Внести точечные правки","tester":"Проверить"}}


Если вернёшь невалидный JSON — весь запуск упадёт.`;
  }

  private buildAnalystPrompt(run: Run, plan: any, project: any, messages: any[], projectPath: string, workspace: any): string {
    const index = projectPath ? this.buildProjectIndex(projectPath, workspace, 80) : '';
    // Подгружаем содержимое файлов, упомянутых оркестратором в плане (если он
    // назвал конкретные пути), чтобы аналитик опирался на реальный код, а не
    // фантазировал. Ограничиваем по размеру.
    let fileContext = '';
    try {
      const hinted = Array.isArray((plan as any)?.files) ? (plan as any).files : [];
      const seen = new Set<string>();
      for (const t of hinted) {
        const p = (t as any)?.path;
        if (typeof p !== 'string' || seen.has(p)) continue;
        seen.add(p);
        const body = this.readFileForContext(projectPath, p, 6000);
        if (body) fileContext += `\n--- ${p} (текущее содержимое) ---\n${body}\n`;
      }
    } catch { }
    return `Ты — Аналитик. Напиши ТЗ для разработчика, опираясь на РЕАЛЬНЫЙ код проекта.

ПРОЕКТ: ${project.name || 'Unknown'}
ПУТЬ: ${project.localPath || ''}
ЗАДАЧА: ${run.task}
ПЛАН ОРКЕСТРАТОРА: ${JSON.stringify(plan, null, 2)}

КАРТА ПРОЕКТА:
${index}
${fileContext ? `\nСУЩЕСТВУЮЩИЙ КОД (опирайся на него, не придумывай структуру):\n${fileContext}` : ''}

Твоя задача — точно описать ЧТО менять и ГДЕ, указывая только РЕАЛЬНЫЕ пути из карты выше. НЕ пиши сам код — это работа разработчика. Будь конкретен: файл, функция, что изменить.

ПРАВИЛА (КРИТИЧНО):
1. ВЕРНИ ТОЛЬКО ОДИН ВАЛИДНЫЙ JSON. Никакого markdown, никакого текста вне { }.
2. В files.path указывай ТОЛЬКО пути, которые есть в КАРТЕ ПРОЕКТА. Не выдумывай файлы.
3. Для существующих файлов ставь action:"update" (разработчик сделает патч), для новых — action:"create".

Схема:
{"feature":"string","description":"string","requirements":["string"],"api":{"endpoints":["string"]},"dataModels":["string"],"files":[{"path":"string - реальный путь","action":"create|update","description":"string - что менять","reason":"string - зачем"}],"acceptanceCriteria":["string"],"risks":["string"]}

ПРИМЕР:
{"feature":"Исправить удаление чата","description":"Найти причину раздувания payload","requirements":["Не сериализовать весь диалог"],"files":[{"path":"apps/api/src/modules/chats/chats.service.ts","action":"update","description":"Убрать лишние поля из payload","reason":"Сейчас передаётся вся история"}],"acceptanceCriteria":["Payload < 1KB"],"risks":["Можно потерять нужные данные"]}

Если вернёшь невалидный JSON — запуск упадёт.`;
  }

  private buildDeveloperPrompt(run: Run, spec: any, project: any, workspace: any, projectPath: string): string {
    const ignoreDirs = Array.isArray(workspace.ignoreDirs) ? workspace.ignoreDirs.join(', ') : '';
    const filesList = (spec.files || []).map((f: any) => `- ${f.path}: ${f.action} — ${f.description}`).join('\n') || 'нет файлов';
    const requirements = (spec.requirements || []).map((r: any) => `- ${r}`).join('\n') || 'нет требований';

    // Подгружаем текущее содержимое каждого файла из ТЗ, чтобы разработчик
    // видел legacy-код и делал точечные SEARCH/REPLACE патчи вместо полной
    // перегенерации файла. Это главная экономия токенов на спагетти-файлах.
    let existingFiles = '';
    try {
      const seen = new Set<string>();
      for (const f of (spec.files || [])) {
        const p = (f as any)?.path;
        if (typeof p !== 'string' || seen.has(p)) continue;
        seen.add(p);
        const body = this.readFileForContext(projectPath, p, Number(workspace.maxCharsPerFile ?? 8000));
        if (body) existingFiles += `\n===== ${p} (ТЕКУЩЕЕ СОДЕРЖИМОЕ — не переписывай весь файл, используй patches) =====\n${body}\n`;
      }
    } catch { }

    return `Ты — Разработчик. Внеси точечные изменения в код проекта по ТЗ аналитика.

ПРОЕКТ: ${project.name || 'Unknown'}
ПУТЬ: ${project.localPath || ''}
ЗАДАЧА: ${run.task}

ТРЕБОВАНИЯ ИЗ ТЗ:
${requirements}

ФАЙЛЫ ИЗ ТЗ (что изменить/создать):
${filesList}
${existingFiles ? `\nСУЩЕСТВУЮЩИЙ КОД ФАЙЛОВ:\n${existingFiles}` : ''}

ВАЖНО: ИСПОЛЬЗУЙ МАРКЕРНЫЙ ФОРМАТ (НЕ JSON). В нём код пишется как есть между маркерами — НЕ нужно экранировать переносы строк и кавычки. JSON с кодом внутри "content" почти всегда ломается из-за экранирования. Маркерный формат надёжнее.

ФОРМАТ ОТВЕТА (строго так):

SUMMARY: краткая сводка что сделано

FILE: путь/к/файлу
ACTION: create
DESCRIPTION: что сделано
CONTENT_START
весь код нового файла как есть, без экранирования
CONTENT_END

FILE: другой/файл.ts
ACTION: update
DESCRIPTION: что сделано
PATCH_START
SEARCH:
точный фрагмент текущего кода (скопируй из СУЩЕСТВУЮЩЕГО КОД выше)
REPLACE:
новый фрагмент кода вместо него
PATCH_END

FILE: третий/файл.ts
ACTION: delete
DESCRIPTION: что сделано

ПРАВИЛА (НАРУШЕНИЕ = ПРОВАЛ):
1. НЕ оборачивай ответ в JSON и НЕ используй markdown-блоки \`\`\`. Только маркеры выше.
2. Для ОБНОВЛЕНИЯ существующего файла используй PATCH_START/SEARCH:/REPLACE:/PATCH_END. Скопируй точный фрагмент из текущего кода в SEARCH. Это сохраняет остальной legacy-код.
3. Для СОЗДАНИЯ нового файла используй ACTION: create + CONTENT_START/CONTENT_END.
4. Между маркерами пиши код КАК ЕСТЬ — реальные переносы строк и обычные кавычки, без \\n и без экранирования.
5. Если изменений не требуется — верни только SUMMARY: Нет изменений (без блоков FILE).
6. Маркеры FILE:, ACTION:, DESCRIPTION:, SUMMARY: — каждый с новой строки, без пробелов перед двоеточием.

ПРИМЕР полного ответа:

SUMMARY: Убрал сериализацию всей истории чата из payload

FILE: apps/api/src/modules/chats/chats.service.ts
ACTION: update
DESCRIPTION: Убрал лишние поля из payload
PATCH_START
SEARCH:
const payload = { ...chat, messages: chat.messages }
REPLACE:
const payload = { id: chat.id, title: chat.title }
PATCH_END

Игнорируй директории: ${ignoreDirs}
Лимиты: макс ${workspace.maxFiles} файлов, до ${workspace.maxCharsPerFile} символов на файл.`;
  }

  private buildTesterPrompt(run: Run, codeChanges: any, project: any): string {
    return `Ты — Тестировщик. Проверь изменения кода разработчика на корректность (статический анализ логики).

ПРОЕКТ: ${project.name || 'Unknown'}
ПУТЬ: ${project.localPath || ''}
ИЗМЕНЕНИЯ: ${JSON.stringify(codeChanges, null, 2)}

Твоя задача — оценить, решает ли код задачу и нет ли явных ошибок. НЕ запускай реальные команды — дай статическую оценку.

ПРАВИЛА (КРИТИЧНО):
1. ВЕРНИ ТОЛЬКО ОДИН ВАЛИДНЫЙ JSON. Никакого markdown, никакого текста вне { }.
2. Если изменений нет или они выглядят корректно — passed:true.

Схема:
{"passed":boolean,"tests":[{"name":"string","command":"string","success":boolean,"output":"string"}],"errors":["string"]}

ПРИМЕР (всё ок):
{"passed":true,"tests":[{"name":"Логика payload","command":"static-review","success":true,"output":"Payload содержит только id и title"}],"errors":[]}

ПРИМЕР (есть ошибка):
{"passed":false,"tests":[{"name":"Логика payload","command":"static-review","success":false,"output":"Сериализация истории осталась"}],"errors":["Поле messages всё ещё передаётся"]}

Если тестов нет — верни {"passed":true,"tests":[],"errors":[]}.`;
  }

  private buildFinalReportPrompt(run: Run, plan: any, spec: any, codeChanges: any, testResults: any, memoryUpdate: any): string {
    return `Ты — Оркестратор. Напиши итоговый отчет пользователю.

ЗАДАЧА: ${run.task}
ПЛАН: ${JSON.stringify(plan, null, 2)}
ТЗ: ${JSON.stringify(spec, null, 2)}
ИЗМЕНЕНИЯ: ${JSON.stringify(codeChanges, null, 2)}
ТЕСТЫ: ${JSON.stringify(testResults, null, 2)}

Напиши краткий отчет на языке пользователя: что сделано, какие файлы изменены, результат тестов, следующие шаги.

Верни ТОЛЬКО валидный JSON:
{
  "message": "string - итоговое сообщение пользователю",
  "summary": "string - краткая сводка",
  "filesChanged": ["string"],
  "testResult": "passed|failed",
  "nextSteps": ["string"]
}`;
  }
}
