import { forwardRef, Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
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
import { execSync } from 'node:child_process';

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
export class RunsService implements OnModuleInit {
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

  /**
   * Recovery «зомби»-ранов при старте приложения.
   *
   * Если процесс API упал (kill -9, OOM, краш контейнера) посреди executeRunSteps,
   * в БД остаются run'ы со status='running' и без finishedAt. Никто их больше не
   * поднимет — executeRunSteps имеет гварду "already running, skipping", а фронт
   * не поллит их (chatId у них часто пустой после cascade). Это и были
   * «зомби» fbaf14a0 / f6c2d316, которые пользователь видел как зависший чат.
   *
   * На старте модуля помечаем все stale 'running' → 'failed' с понятной ошибкой,
   * чтобы они перестали считаться «активными» и не висели вечно.
   */
  async onModuleInit(): Promise<void> {
    try {
      const stale = await this.runRepo.find({ where: { status: 'running' } });
      if (!stale.length) return;
      this.logger.warn(`Found ${stale.length} stale running run(s) on startup — marking as failed (recovery)`);
      for (const run of stale) {
        run.status = 'failed';
        run.finishedAt = new Date();
        if (!run.error) run.error = 'Process restarted while run was in progress (stale recovery)';
        await this.runRepo.save(run);
        this.logger.log(`Recovered stale run ${run.id} (chatId=${run.chatId ?? '<null>'})`);
      }
    } catch (error) {
      this.logger.error(`Stale run recovery failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Удаляет все run'ы, привязанные к чату. Вызывается из ChatsService.remove()
   * ПЕРЕД удалением самого чата — чтобы orphan-зомби (run без chatId) больше
   * не плодились. Раньше FK был onDelete: SET NULL, поэтому при удалении чата
   * runs просто теряли chatId и оставались в БД навсегда как мусор/зомби.
   *
   * Удаляем явно, а не полагаемся только на CASCADE FK: synchronize:true не
   * всегда пересоздаёт FK при смене onDelete, поэтому дублируем удаление в коде
   * — это гарантирует очистку независимо от состояния схемы БД.
   */
  async deleteRunsByChat(chatId: string): Promise<number> {
    try {
      const result = await this.runRepo.delete({ chatId });
      const affected = result.affected ?? 0;
      if (affected > 0) {
        this.logger.log(`Deleted ${affected} run(s) for chat ${chatId} (cascade on chat delete)`);
      }
      return affected;
    } catch (error) {
      this.logger.error(`Failed to delete runs for chat ${chatId}: ${error instanceof Error ? error.message : String(error)}`);
      return 0;
    }
  }

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

    // Режим прогона: 'diagnostics' (только анализ, БЕЗ правок кода) или
    // 'implementation' (внести изменения). Определяем ДЕТЕРМИНИРОВАННО по
    // тексту задачи, а НЕ полагаемся на LLM: слабая модель на planning-шаге
    // оркестратора часто игнорирует "код не пишите" и всё равно ставит
    // разработчику задачу писать код. Фиксит баг "разраб пишет код, хотя
    // пользователь явно просил только проверить".
    const runMode = this.detectRunMode(run.task);
    this.logger.log(`Run ${runId} mode: ${runMode} (task="${run.task.slice(0, 80)}")`);

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
          this.buildOrchestratorPrompt(run, chat.messages, project, teamConfig, projectPath, runMode),
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
          this.buildAnalystPrompt(run, plan, project, chat.messages, projectPath, workspace, runMode),
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
        // В diagnostic-режиме разработчик НЕ трогает код. Раньше здесь хардкод
        // «Начинаю реализацию по ТЗ» + «Код написан» вещался ВСЕГДА — даже когда
        // пользователь явно просил «код не пишите». В чате горело «Код написан»,
        // хотя код не менялся. Это ломало доверие («агенты врут/тупые»).
        await this.broadcastActivity(runId, chatId, 'developer', devName, devLabel, 'working', runMode === 'diagnostics' ? 'Изучаю выводы аналитика' : 'Начинаю реализацию по ТЗ');

        const devSpec = {
          files: (spec as any).files || [],
          requirements: (spec as any).requirements || [],
          feature: (spec as any).feature || '',
          description: (spec as any).description || '',
        };

        const developerResult = await this.callAgentStream(
          runId, chatId, 'developer', developerAgent, language,
          this.buildDeveloperPrompt(run, devSpec, project, workspace, projectPath, runMode),
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

        await this.broadcastActivity(runId, chatId, 'developer', devName, devLabel, 'done', runMode === 'diagnostics' ? 'Диагноз подтверждён, код не трогал' : 'Код написан');

        const codeChanges = developerResult.artifact || {};
        const files = (codeChanges as any).files;
        let applyChanges = teamConfig.run?.applyChanges !== false; // по умолчанию true
        // ЖЁСТКАЯ защита режима диагностики: даже если разработчик ослушался и
        // вернул блоки FILE (а слабые модели регулярно это делают), мы НИКОГДА
        // не пишем их на диск и НЕ спамим «Изменён файл» в чат. Иначе фраза
        // «проверьте … код не пишите» приводила к тому, что в чат вылетало
        // 6 строк «Изменён файл: …» — ровно то, на что жаловался пользователь.
        const isDiagnostics = runMode === 'diagnostics';
        if (isDiagnostics) {
          applyChanges = false;
        }
        if (files && Array.isArray(files) && files.length) {
          if (isDiagnostics) {
            // В диагностике молча игнорируем любые правки — не портим проект
            // и не плодим фейковые «Изменён файл» в чате.
            this.logger.log(`[diagnostics] ignored ${files.length} file change(s) from developer (run ${runId})`);
          } else {
            for (const fileChange of files) {
              // Фильтр: аналитик ведёт доку проекта в БД (project memory), а НЕ
              // в репозитории. Поэтому .md/README/docs файлы из ТЗ игнорируем —
              // не засоряем чужой проект документацией. Фикс жалобы «написали
              // тут какую-то доку в репозитории».
              if (this.isDocumentationPath(fileChange.path)) {
                await this.broadcastActivity(runId, chatId, 'developer', devName, devLabel, 'working', `Документация «${fileChange.path}» — оставляю в памяти проекта (БД), в репо не пишу`);
                continue;
              }
              // Фильтр мусорных/временных файлов. Слабые модели «имитируют»
              // shell-команды (git log, git diff) созданием файлов вроде
              // git_log_output.txt / scratch.txt / output_*.txt и НЕ удаляют
              // их за собой — репо засоряется. Фикс жалобы «они создали
              // git_log_output.txt и не удалили за собой». Такие пути НИКОГДА
              // не пишутся на диск.
              if (this.isJunkPath(fileChange.path)) {
                await this.broadcastActivity(runId, chatId, 'developer', devName, devLabel, 'error', `Мусорный файл «${fileChange.path}» — не пишу в репо (временные/лог/выводные файлы запрещены, используй память проекта)`);
                continue;
              }
              const verb = applyChanges ? 'Изменён' : 'Запланирован (dry-run, не записан)';
              // applyFileChange теперь устойчив: один плохой путь (ENOTDIR —
              // например когда в середине пути стоит файл вместо директории,
              // как в dog-borrowing-back/src/domain/dog/aggregates) НЕ роняет
              // весь run. Логируем ошибку в чат и идём к следующему файлу.
              // Раньше throw здесь срывал все 3 попытки, и чат падал в «Ошибка».
              const res = await this.applyFileChange(projectPath, fileChange, applyChanges);
              if (res.ok) {
                await this.broadcastActivity(runId, chatId, 'developer', devName, devLabel, 'working', `${verb} файл: ${fileChange.path} (${fileChange.action})`);
              } else {
                await this.broadcastActivity(runId, chatId, 'developer', devName, devLabel, 'error', `Не удалось применить ${fileChange.path}: ${res.error}`);
              }
            }
          }
        }

        // 4. TESTER
        await this.broadcastActivity(runId, chatId, 'tester', testName, testLabel, 'working', runMode === 'diagnostics' ? 'Проверяю выводы аналитика' : 'Запускаю тесты');

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
          this.buildFinalReportPrompt(run, plan, spec, codeChanges, testResults, memoryUpdate, runMode),
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
          const finalArtifact: Record<string, unknown> =
            (finalReport.artifact as Record<string, unknown>) || { summary: finalReport.rawResponse };
          // Гарантируем, что в finalReport сохранён diagnosis аналитика —
          // чтобы chats.service мог собрать итоговый ответ пользователю даже
          // если LLM-финалка перепечатала план вместо результата (баг
          // "финальный ответ = дубль планировочного сообщения").
          if (runMode === 'diagnostics' && Array.isArray((spec as any)?.diagnosis) && !Array.isArray((finalArtifact as any).diagnosis)) {
            (finalArtifact as any).diagnosis = (spec as any).diagnosis;
          }
          if (runMode === 'diagnostics') (finalArtifact as any).mode = 'diagnostics';
          run.finalReport = finalArtifact;
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

      // Сводка (необязательна).
      const summaryMatch = text.match(/^[ \t]*SUMMARY:[ \t]*(.+?)$/m);
      const summary = summaryMatch ? summaryMatch[1].trim() : '';

      // ДИАГНОСТИЧЕСКИЙ ответ: только SUMMARY, БЕЗ блоков FILE.
      // Промпт разработчика в режиме diagnostics прямо требует вернуть
      // "SUMMARY: Нет изменений..." — это НЕ JSON и не маркерный FILE-формат,
      // поэтому старая проверка (/^[ \t]*FILE:/m) отбрасывала его и разработчик
      // падал с "Failed to parse JSON after all fallback strategies" 3 раза →
      // run failed. Здесь признаём SUMMARY-only ответ валидным артефактом
      // "нет изменений": files: [], summary — конвейер идёт дальше к тестеру.
      if (!/^[ \t]*FILE:/m.test(text)) {
        if (summary) {
          return { files: [], summary };
        }
        return null;
      }

      const files: Array<Record<string, unknown>> = [];


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

  /**
   * Приводит путь из ТЗ разработчика к относительному виду внутри проекта.
   * Слабые модели регулярно пишут АБСОЛЮТНЫЕ пути вида
   *   /host-projects/<project>/src/...
   * или даже полные host-пути. path.join(projectPath, absPath) с абсолютным
   * вторым аргументом ВЫБРАСЫВАЕТ projectPath и пишет файл чёрт знает где
   * (иногда — в чужой проект). Здесь нормализуем: обрезаем projectPath /
   * префикс host-projects/<projBase>/ и всегда работаем по относительному
   * пути внутри проекта. Фикс бага, когда правки «уезжали» из проекта.
   */
  private relPathWithinProject(projectPath: string, relOrAbs: string): string {
    let p = String(relOrAbs || '').trim();
    if (!p) return '';
    const normProject = path.resolve(projectPath).replace(/\/+$/, '');
    const projBase = path.basename(normProject);
    // Windows-слеши на всякий случай.
    p = p.replace(/\\/g, '/').trim();
    // Если путь абсолютный и лежит внутри проекта — берём относительную часть.
    try {
      const abs = path.resolve(p);
      if (abs === normProject) return '';
      if (abs.startsWith(normProject + '/')) {
        return path.relative(normProject, abs);
      }
    } catch { }
    // Обрезаем ведущие слеши (модель пишет /src/... вместо src/...).
    p = p.replace(/^\/+/, '');
    // Срезаем возможный префикс "host-projects/<projBase>/" если модель
    // писала контейнерный путь без ведущего слеша.
    if (projBase) {
      const hostPrefix = `host-projects/${projBase}/`;
      if (p.startsWith(hostPrefix)) p = p.slice(hostPrefix.length);
      else if (p === `host-projects/${projBase}`) p = '';
      else if (p.startsWith(`${projBase}/`)) p = p.slice(`${projBase}/`.length);
      else if (p === projBase) p = '';
    }
    // Защита от выхода за пределы проекта (../).
    p = p.replace(/^(\.\.\/)+/, '');
    return p;
  }

  private async applyFileChange(
    projectPath: string,
    fileChange: { path: string; action: string; content?: string; description?: string; patches?: Array<{ search: string; replace: string }> },
    applyChanges = true,
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      const relPath = this.relPathWithinProject(projectPath, fileChange.path);
      if (!relPath) return { ok: true };
      const fullPath = path.join(projectPath, relPath);

      // dry-run: НЕ трогаем диск. Только логируем намерение. Так команда с
      // run.applyChanges=false работает как "только предложения" и не портит
      // файлы — это безопасно для диагностических/исследовательских запусков.
      if (!applyChanges) {
        this.logger.log(`[dry-run] skip applying ${fileChange.action} to ${relPath}`);
        return { ok: true };
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
              this.logger.warn(`Patch search block not found in ${relPath}; skipping that patch.`);
            }
          }
          fs.writeFileSync(fullPath, current, 'utf-8');
          return { ok: true };
        }
        fs.writeFileSync(fullPath, fileChange.content ?? '', 'utf-8');
      } else if (fileChange.action === 'delete') {
        if (fs.existsSync(fullPath)) {
          const stat = fs.statSync(fullPath);
          if (stat.isDirectory()) {
            // Это директория, а не файл. fs.unlinkSync на директории падает с
            // EISDIR/ENOTDIR и ронял весь run. Используем rmSync recursive —
            // как git удаляет папки. Фикс «ENOTDIR при mkdir aggregates».
            fs.rmSync(fullPath, { recursive: true, force: true });
          } else {
            fs.unlinkSync(fullPath);
          }
        }
      }
      return { ok: true };
    } catch (error) {
      // Любая ошибка диска (ENOTDIR — в пути есть файл вместо директории,
      // EACCES, ENOSPC, ENOENT и т.п.) теперь НЕ роняет весь run. Возвращаем
      // ошибку вызывающему — он транслирует её в чат и продолжает остальные
      // файлы. Раньше throw здесь срывал все 3 попытки прогона.
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.warn(`applyFileChange failed for ${fileChange.path}: ${msg}`);
      return { ok: false, error: msg };
    }
  }

  /**
   * Защита от засорения репозитория документацией. Аналитик ведёт доку
   * проекта в БД (project memory через saveProjectMemory), а НЕ файлами
   * в репо. Поэтому .md/README/docs/.rst из ТЗ разработчика игнорируем —
   * не пишем их на диск. Фикс жалобы «они мне написали тут какую-то доку
   * в репозитории».
   */
  private isDocumentationPath(relPath: string): boolean {
    const p = String(relPath || '').toLowerCase().trim();
    if (!p) return false;
    const base = p.split('/').pop() || '';
    if (p.endsWith('.md') || p.endsWith('.mdx') || p.endsWith('.rst')) return true;
    if (base.startsWith('readme')) return true;
    if (p.startsWith('docs/') || p.includes('/docs/')) return true;
    if (p.startsWith('documentation/') || p.includes('/documentation/')) return true;
    return false;
  }

  /**
   * Защита от засорения репозитория мусорными/временными файлами. Слабые
   * модели «имитируют» shell-команды (git log, git diff, npm test) созданием
   * текстовых файлов-«выводов» (git_log_output.txt, scratch.txt, output_*.txt)
   * и НЕ удаляют их за собой — репо засоряется. Фикс жалобы «они создали
   * git_log_output.txt и не удалили за собой». Такие пути НИКОГДА не пишутся.
   */
  private isJunkPath(relPath: string): boolean {
    const p = String(relPath || '').toLowerCase().trim();
    if (!p) return true;
    const base = p.split('/').pop() || '';
    if (p.endsWith('.log') || p.endsWith('.tmp') || p.endsWith('.temp') || p.endsWith('.out') || p.endsWith('.bak') || p.endsWith('.swp')) return true;
    if (p.endsWith('.txt')) {
      // .txt почти всегда — мусорная имитация вывода команды. Разрешаем только
      // явные данные проекта (data/ и public/), остальное блокируем.
      if (!p.startsWith('data/') && !p.includes('/data/') && !p.startsWith('public/') && !p.includes('/public/')) return true;
    }
    if (base.startsWith('git_log') || base.startsWith('gitlog') || base.startsWith('git_diff') || base.startsWith('gitdiff') || base.startsWith('git_status')) return true;
    if (base.startsWith('scratch') || base.startsWith('temp_') || base.startsWith('tmp_') || base.startsWith('output_') || base.startsWith('console_') || base.startsWith('log_') || base.startsWith('debug_')) return true;
    if (p.startsWith('tmp/') || p.startsWith('temp/') || p.startsWith('scratch/') || p.includes('/tmp/') || p.includes('/scratch/')) return true;
    return false;
  }

  /**
   * Даёт агентам РЕАЛЬНЫЙ git-контекст проекта (ветка, последние коммиты,
   * незакоммиченные изменения). Раньше у агентов не было shell-доступа, и
   * слабая модель «имитировала» `git log` созданием файла git_log_output.txt
   * (и не удаляла его). Теперь сервер сам выполняет git log/status/diff и
   * вкладывает результат в промпт — агентам НЕ нужно плодить файлы, у них
   * уже есть актуальный контекст. Если git недоступен — возвращаем пустую
   * строку (безопасно, промпты работают и без неё).
   */
  private getGitContext(projectPath: string): string {
    try {
      if (!projectPath || !fs.existsSync(projectPath)) return '';
      const dotGit = path.join(projectPath, '.git');
      if (!fs.existsSync(dotGit)) return '';
      const run = (cmd: string): string => {
        try {
          return execSync(cmd, { cwd: projectPath, encoding: 'utf-8', timeout: 8000, maxBuffer: 1024 * 512 })
            .toString().trim();
        } catch {
          return '';
        }
      };
      const branch = run('git rev-parse --abbrev-ref HEAD');
      const log = run('git log --oneline -n 15 --no-decorate');
      const status = run('git status --short');
      const parts: string[] = [];
      if (branch) parts.push(`Ветка: ${branch}`);
      if (log) parts.push(`Последние коммиты (git log --oneline -n 15):\n${log}`);
      if (status) parts.push(`Незакоммиченные изменения (git status --short):\n${status || '(рабочее дерево чистое)'}`);
      return parts.length ? parts.join('\n\n') : '';
    } catch {
      return '';
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

  private buildOrchestratorPrompt(run: Run, messages: any[], project: any, teamConfig: TeamConfig, projectPath: string, runMode: 'diagnostics' | 'implementation'): string {
    const recentMessages = messages?.slice(-10).map(m => `${m.role}: ${m.content}`).join('\n') || 'Нет истории';
    const index = projectPath ? this.buildProjectIndex(projectPath, teamConfig.workspace, 50) : '';
    const gitContext = projectPath ? this.getGitContext(projectPath) : '';
    // Режим уже определён детерминированно в executeRunSteps. Сообщаем его
    // модели как ФАКТ (не вопрос) — она не должна «решать» заново. Раньше
    // слабая модель на этом шаге игнорила «код не пишите» и всё равно ставила
    // разрабу задачу кодить. Теперь режим зафиксирован в промпте явно.
    const modeLine = runMode === 'diagnostics'
      ? `РЕЖИМ: ДИАГНОСТИКА (только анализ, БЕЗ правок кода). Пользователь явно просил проверить/найти причину, НЕ писать код. Разработчик НЕ должен трогать файлы.`
      : `РЕЖИМ: РЕАЛИЗАЦИЯ (внести точечные правки в код).`;
    const devAssignment = runMode === 'diagnostics'
      ? 'НЕ вносить правок в код. Только подтвердить выводы аналитика. Вернуть SUMMARY: Нет изменений.'
      : 'Внести точечные правки по ТЗ аналитика.';
    return `Ты — Оркестратор. Проанализируй задачу и создай план работы для команды.

ПРОЕКТ: ${project.name || 'Unknown'}
ПУТЬ: ${project.localPath || ''}
ЗАДАЧА: ${run.task}
${modeLine}

КАРТА ПРОЕКТА (используй только эти реальные пути, не выдумывай файлы):
${index}
${gitContext ? `\nGIT-КОНТЕКСТ (актуальный, серверный — НЕ создавай файлы для git log/diff, он уже здесь):\n${gitContext}` : ''}

ИСТОРИЯ ЧАТА (последние 10):
${recentMessages}

Твоя задача — понять, что именно делать, и раздать роли команде. НЕ пиши код. НЕ анализируй файлы подробно (это работа аналитика). НЕ требуй от команды создавать временные/лог/текстовые файлы — git-контекст уже в промпте выше.

ПРАВИЛА (КРИТИЧНО):
1. ВЕРНИ ТОЛЬКО ОДИН ВАЛИДНЫЙ JSON-ОБЪЕКТ. Никакого markdown, никаких \`\`\`json блоков, никакого текста до или после { }.
2. Запуск УЖЕ идёт — команда всегда работает. ВСЕГДА заполняй assignments для аналитика, разработчика и тестера.
3. РЕЖИМ уже задан выше — НЕ меняй его. В assignments.developer пишИ ровно: "${devAssignment}"
4. НЕ выдумывай пути файлов — используй только КАРТУ ПРОЕКТА выше.

Схема ответа:
{"message":"string - что ты понял и что сделает команда","teamSummary":["string"],"shouldExecute":true,"executionTask":"string - краткая задача для команды","plan":["string - шаги"],"assignments":{"analyst":"string","developer":"string","tester":"string"}}

ПРИМЕР (ДИАГНОСТИКА):
{"message":"Понял. Назначу аналитика для поиска причины.","teamSummary":["Alex: координирует","Mira: исследует код"],"shouldExecute":true,"executionTask":"Найти причину X, код не менять","plan":["Анализ кода","Подтверждение причины"],"assignments":{"analyst":"Изучить код и найти причину","developer":"НЕ вносить правок в код. Только подтвердить выводы аналитика. Вернуть SUMMARY: Нет изменений.","tester":"Проверить логику вывода"}}

ПРИМЕР (РЕАЛИЗАЦИЯ):
{"message":"Понял. Назначу аналитика и разработчика.","teamSummary":["Alex: координирует","Mira: пишет ТЗ"],"shouldExecute":true,"executionTask":"Исправить баг X в модуле Y","plan":["Анализ","Реализация","Тесты"],"assignments":{"analyst":"Найти причину в коде","developer":"Внести точечные правки по ТЗ аналитика.","tester":"Проверить"}}

Если вернёшь невалидный JSON — весь запуск упадёт.`;
  }

  /**
   * Детерминированное определение режима прогона по тексту задачи.
   * 'diagnostics' — пользователь хочет только проверить/найти причину/диагноз,
   *   явно запрещает писать код. В этом режиме разработчик НЕ трогает файлы,
   *   а финальный отчёт содержит diagnosis аналитика.
   * 'implementation' — задача на реальное изменение кода.
   * Определяем по ключевым словам, а НЕ по решению LLM — слабые модели часто
   * игнорят «код не пишите» на planning-шаге и всё равно дают разрабу кодить.
   */
  private detectRunMode(task: string): 'diagnostics' | 'implementation' {
    const t = String(task || '').toLowerCase();
    if (!t.trim()) return 'implementation';
    const diagKeywords = [
      'код не пиш', 'не пишите код', 'не писать код', 'без кода', 'только провер',
      'просто провер', 'проверь почему', 'проверьте почему', 'почему так',
      'почему возник', 'найди причину', 'найти причину', 'в чём причина', 'в чем причина',
      'диагност', 'разберись почему', 'разберись в чем', 'объясни почему',
      'только анализ', 'только диагност', 'не трогай код', 'не меняй код',
      "don't write code", 'no code', 'diagnos', 'investigate why', 'find the cause',
      'just check', 'only check', 'why does', 'root cause',
    ];
    const hasDiag = diagKeywords.some((k) => t.includes(k));
    if (hasDiag) return 'diagnostics';
    // Если задача сформулирована как вопрос («почему», «зачем», «как работает»)
    // и НЕ содержит глаголов изменения — тоже диагностика.
    const isQuestion = /\b(почему|зачем|как (работает|устроен)|отчего|due to|why)\b/.test(t);
    const implVerbs = ['создай', 'создать', 'добавь', 'добавить', 'исправь', 'исправить', 'реализуй', 'реализовать', 'напиши', 'написать', 'сделай', 'сделать', 'обнови', 'обновить', 'удали', 'удалить', 'рефактор', 'create', 'add', 'fix', 'implement', 'write', 'make', 'update', 'delete', 'refactor'];
    const hasImpl = implVerbs.some((k) => t.includes(k));
    if (isQuestion && !hasImpl) return 'diagnostics';
    return 'implementation';
  }

  private buildAnalystPrompt(run: Run, plan: any, project: any, messages: any[], projectPath: string, workspace: any, runMode: 'diagnostics' | 'implementation'): string {
    const index = projectPath ? this.buildProjectIndex(projectPath, workspace, 80) : '';
    const gitContext = projectPath ? this.getGitContext(projectPath) : '';
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

    // В режиме диагностики аналитик НЕ выдаёт files[] — иначе разработчик
    // увидит файлы и начнёт их править (баг «разраб пишет код, хотя просили
    // только проверить»). Вместо этого аналитик возвращает diagnosis[] —
    // конкретные выводы: файл, функция, механизм проблемы.
    if (runMode === 'diagnostics') {
      return `Ты — Аналитик. Проведи ДИАГНОСТИКУ кода проекта и найди причину. РЕЖИМ: только анализ, БЕЗ правок кода.

ПРОЕКТ: ${project.name || 'Unknown'}
ПУТЬ: ${project.localPath || ''}
ЗАДАЧА: ${run.task}
ПЛАН ОРКЕСТРАТОРА: ${JSON.stringify(plan, null, 2)}

КАРТА ПРОЕКТА:
${index}
${gitContext ? `\nGIT-КОНТЕКСТ (актуальный, серверный — НЕ создавай файлы для git log/diff, он уже здесь):\n${gitContext}` : ''}
${fileContext ? `\nСУЩЕСТВУЮЩИЙ КОД (опирайся на него, не придумывай структуру):\n${fileContext}` : ''}

Твоя задача — изучить РЕАЛЬНЫЙ код и найти ТОЧНУЮ причину описанной проблемы. Укажи конкретные файлы, функции и механизм, который вызывает эффект. НЕ предлагай писать/менять код — только диагноз.

ПРАВИЛА (КРИТИЧНО):
1. ВЕРНИ ТОЛЬКО ОДИН ВАЛИДНЫЙ JSON. Никакого markdown, никакого текста вне { }.
2. В diagnosis.file указывай ТОЛЬКО пути из КАРТЫ ПРОЕКТА. Не выдумывай файлы.
3. НЕ возвращай поле "files" — в этом режиме правок кода НЕ будет. Верни "diagnosis".
4. Каждый пункт diagnosis должен быть конкретным: файл + функция/строка + что именно вызывает эффект.

Схема:
{"feature":"string - краткое название диагноза","description":"string - суть проблемы","diagnosis":[{"file":"string - реальный путь","location":"string - функция/метод/блок","issue":"string - что именно вызывает эффект","evidence":"string - цитата или описание логики"}],"rootCause":"string - главная причина одним абзацем","recommendations":["string - что можно сделать (описание, не код)"],"risks":["string"]}

ПРИМЕР:
{"feature":"Раздувание payload при удалении чата","description":"При удалении чата сериализуется весь диалог и конфигурация","diagnosis":[{"file":"apps/api/src/modules/chats/chats.service.ts","location":"sendMessageToOrchestrator / getById","issue":"В payload попадают все сообщения и meta с usage","evidence":"messages.slice(-12) + meta.usage суммируется по всем ролям"}],"rootCause":"getById отдаёт в чат всю историю + usageSummary всех run'ов, а удаление/сохранение сериализует это целиком.","recommendations":["Ограничить payload только нужными полями","Не вкладывать usageSummary в ответ удаления"],"risks":["Можно потерять нужные данные"]}

Если вернёшь невалидный JSON — запуск упадёт.`;
    }

    return `Ты — Аналитик. Напиши ТЗ для разработчика, опираясь на РЕАЛЬНЫЙ код проекта.

ПРОЕКТ: ${project.name || 'Unknown'}
ПУТЬ: ${project.localPath || ''}
ЗАДАЧА: ${run.task}
ПЛАН ОРКЕСТРАТОРА: ${JSON.stringify(plan, null, 2)}

КАРТА ПРОЕКТА:
${index}
${gitContext ? `\nGIT-КОНТЕКСТ (актуальный, серверный — НЕ создавай файлы для git log/diff, он уже здесь):\n${gitContext}` : ''}
${fileContext ? `\nСУЩЕСТВУЮЩИЙ КОД (опирайся на него, не придумывай структуру):\n${fileContext}` : ''}

Твоя задача — точно описать ЧТО менять и ГДЕ, указывая только РЕАЛЬНЫЕ пути из карты выше. НЕ пиши сам код — это работа разработчика. Будь конкретен: файл, функция, что изменить.

ПРАВИЛА (КРИТИЧНО):
1. ВЕРНИ ТОЛЬКО ОДИН ВАЛИДНЫЙ JSON. Никакого markdown, никакого текста вне { }.
2. В files.path указывай ТОЛЬКО пути, которые есть в КАРТЕ ПРОЕКТА. Не выдумывай файлы.
3. Для существующих файлов ставь action:"update" (разработчик сделает патч), для новых — action:"create".
4. НЕ добавляй в files[] документацию, README, файлы .md/.mdx/.rst, файлы из docs/. Документацию проекта ты ВЕДЁШЬ В ПАМЯТИ ПРОЕКТА (БД) — полями description/requirements/acceptanceCriteria, а НЕ файлами в репозитории. В files[] только КОД. Если хочешь зафиксировать архитектурное решение — опиши его в description/requirements, не создавай .md.

Схема:
{"feature":"string","description":"string","requirements":["string"],"api":{"endpoints":["string"]},"dataModels":["string"],"files":[{"path":"string - реальный путь","action":"create|update","description":"string - что менять","reason":"string - зачем"}],"acceptanceCriteria":["string"],"risks":["string"]}

ПРИМЕР:
{"feature":"Исправить удаление чата","description":"Найти причину раздувания payload","requirements":["Не сериализовать весь диалог"],"files":[{"path":"apps/api/src/modules/chats/chats.service.ts","action":"update","description":"Убрать лишние поля из payload","reason":"Сейчас передаётся вся история"}],"acceptanceCriteria":["Payload < 1KB"],"risks":["Можно потерять нужные данные"]}

Если вернёшь невалидный JSON — запуск упадёт.`;
  }

  private buildDeveloperPrompt(run: Run, spec: any, project: any, workspace: any, projectPath: string, runMode: 'diagnostics' | 'implementation'): string {
    const ignoreDirs = Array.isArray(workspace.ignoreDirs) ? workspace.ignoreDirs.join(', ') : '';
    const filesList = (spec.files || []).map((f: any) => `- ${f.path}: ${f.action} — ${f.description}`).join('\n') || 'нет файлов';
    const requirements = (spec.requirements || []).map((r: any) => `- ${r}`).join('\n') || 'нет требований';

    // В режиме диагностики разработчик НЕ должен трогать код. Возвращаем
    // короткий промпт, который заставляет его ответить «Нет изменений».
    // Раньше разраб получал ТЗ с files[] и кодил 6 файлов, хотя пользователь
    // явно писал «код не пишите» — это и был жалоба пользователя.
    if (runMode === 'diagnostics') {
      const diagnosisText = Array.isArray((spec as any)?.diagnosis)
        ? (spec as any).diagnosis.map((d: any) => `- ${d.file} / ${d.location || '?'}: ${d.issue || ''}`).join('\n')
        : '';
      return `Ты — Разработчик. РЕЖИМ: ДИАГНОСТИКА. Код править ЗАПРЕЩЕНО — пользователь явно просил НЕ писать код.

ПРОЕКТ: ${project.name || 'Unknown'}
ЗАДАЧА: ${run.task}

ВЫВОДЫ АНАЛИТИКА (диагноз):
${diagnosisText || '(аналитик не дал диагноз)'}

Твоя задача — только ПОДТВЕРДИТЬ или дополнить выводы аналитика техническими замечаниями (если они есть). НЕ создавай, НЕ изменяй и НЕ удаляй файлы.

ОТВЕТ (строго так, без блоков FILE):

SUMMARY: Нет изменений. Диагноз аналитика подтверждён.${diagnosisText ? '' : ' (аналитик не дал диагноз — оставляю как есть)'}

ПРАВИЛА:
1. НЕ оборачивай ответ в JSON. Никаких блоков FILE:, никаких патчей.
2. Возвращай ТОЛЬКО строку SUMMARY: Нет изменений... как написано выше.
3. Если хочешь добавить техническое замечание к диагнозу — впиши его после слова "Диагноз аналитика подтверждён." в той же строке SUMMARY.
4. Любой блок FILE в этом режиме = НАРУШЕНИЕ.`;
    }

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
7. НЕ создавай .md/README/документационные файлы. Документацию проекта ведёт Аналитик в памяти проекта (БД), а не в репозитории. Создавай только КОД. Если в ТЗ есть .md — пропусти его.
8. НЕ создавай мусорные/временные/логовые/текстовые файлы: git_log_output.txt, scratch.txt, output_*.txt, *.log, *.tmp, *.out и подобные. git-контекст УЖЕ в промпте (сервер выполняет git log/status сам). Если нужно сохранить вывод — используй SUMMARY, а не файл. Все .txt/.log/.tmp пути будут отклонены.
9. Пиши пути ОТНОСИТЕЛЬНО корня проекта (например src/domain/dog/aggregates/Dog.ts), БЕЗ ведущего /host-projects/... и БЕЗ абсолютных путей. Абсолютные пути будут нормализованы.

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

  private buildFinalReportPrompt(run: Run, plan: any, spec: any, codeChanges: any, testResults: any, memoryUpdate: any, runMode: 'diagnostics' | 'implementation'): string {
    // Усиливаем промпт финалки: работа УЖЕ выполнена, нужно ИТОГ, а не
    // перепечатка плана. Раньше слабая модель возвращала {message:"Понял
    // задачу, назначу..."} — то есть перепечатывала planning-сообщение, и
    // пользователь не получал реального ответа. Теперь явно требуем итог и
    // передаём diagnosis аналитика, чтобы модель опиралась на результат, а не
    // на план.
    const diagnosisText = Array.isArray((spec as any)?.diagnosis)
      ? (spec as any).diagnosis.map((d: any) => `- ${d.file} / ${d.location || '?'}: ${d.issue || ''}${d.evidence ? ` (доказательство: ${d.evidence})` : ''}`).join('\n')
      : '';
    const rootCause = (spec as any)?.rootCause ? `\nГЛАВНАЯ ПРИЧИНА: ${(spec as any).rootCause}` : '';
    const modeDirective = runMode === 'diagnostics'
      ? `Это ДИАГНОСТИЧЕСКАЯ задача. Код НЕ изменялся (так и задумано). Итоговый отчёт — это ДИАГНОЗ: причину, конкретные файлы/функции, механизм проблемы и рекомендации.`
      : `Это задача на реализацию. Код уже изменён разработчиком и проверен тестером. Итоговый отчёт — что реально сделано.`;

    return `Ты — Оркестратор. Работа команды УЖЕ завершена. Напиши ИТОГОВЫЙ ОТЧЁТ пользователю — РЕЗУЛЬТАТ, а НЕ повтор плана.

ЗАДАЧА: ${run.task}
${modeDirective}
ПЛАН (только для контекста, НЕ повторяй его в отчёте): ${JSON.stringify(plan, null, 2)}
ТЗ/ДИАГНОЗ АНАЛИТИКА: ${JSON.stringify(spec, null, 2)}
ИЗМЕНЕНИЯ КОДА: ${JSON.stringify(codeChanges, null, 2)}
ТЕСТЫ: ${JSON.stringify(testResults, null, 2)}
${diagnosisText ? `\nДИАГНОЗ АНАЛИТИКА (опирайся на это в сообщении):\n${diagnosisText}` : ''}${rootCause}

КРИТИЧНО:
1. "message" — это ОТВЕТ ПОЛЬЗОВАТЕЛЮ на его вопрос/задачу. НЕ начинай с "Понял задачу" или "Назначу". Не повторяй план. Работа уже сделана.
2. В режиме ДИАГНОСТИКИ в "message" изложи конкретную причину проблемы (файлы, функции, механизм) и рекомендации — это и есть ответ, который ждёт пользователь.
3. В режиме РЕАЛИЗАЦИИ в "message" кратко напиши, что реально изменено и результат тестов.
4. ВЕРНИ ТОЛЬКО валидный JSON, без markdown и текста вне { }.

Схема:
{
  "message": "string - итоговый ответ пользователю (РЕЗУЛЬТАТ, не план)",
  "summary": "string - краткая сводка в одно-два предложения",
  "filesChanged": ["string - реальные пути изменённых файлов, если есть"],
  "testResult": "passed|failed",
  "diagnosis": ["string - пункты диагноза, только для диагностического режима"],
  "nextSteps": ["string"]
}`;
  }
}
