import { forwardRef, Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Run } from '../../persistence/run.entity';
import { MessageEntity } from '../../persistence/message.entity';
import { StartRunDto } from './dto/start-run.dto';
import { parseJsonSafely, ParseJsonResult } from '../../shared/json';
import { createLlmStreamRequest } from '../../shared/llm-client';
import { TeamsService } from '../teams/teams.service';
import { ProjectsService } from '../projects/projects.service';
import { ChatsService } from '../chats/chats.service';
import { ProvidersService } from '../providers/providers.service';
import { WsGateway } from '../ws/ws.gateway';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'node:child_process';
import {
  stripMirroredProjectPrefixes,
  normalizePathByProjectSuffix,
  relPathWithinProject,
  cleanupPathsInTask,
  hasSuspiciousMirroredPath,
  isUrlLikePath,
} from '../../shared/path-utils.js';

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
  run: { maxReviewRounds: number; applyChanges: boolean; requireApprovalForCommands?: boolean; requireApprovalForFileWrites?: boolean };
  testing?: { commands?: string[] };
}

interface TestResult {
  passed: boolean;
  summary?: string;
  tests?: Array<{ name: string; command: string; success: boolean; output: string }>;
  errors?: string[];
}

interface ReworkDecision {
  shouldRework: boolean;
  reason: string;
}

interface ApprovalRequest {
  id: string;
  /** Вид действия: команда шелла, миграция БД, запись файла. */
  kind: 'command' | 'migration' | 'file_write';
  role: ExecutionRole;
  /** Короткий заголовок — что именно собирается сделать агент. */
  title: string;
  /** Что делает действие — развёрнутое описание одним абзацем. */
  description: string;
  /** Зачем это нужно — rationale, какую цель преследует агент. */
  rationale?: string;
  /** Уровень риска для подсветки в UI. */
  riskLevel?: 'safe' | 'moderate' | 'risky';
  /** Категория для иконки/группировки в UI. */
  category?: string;
  command: string;
  cwd?: string;
  status: 'pending' | 'approved' | 'rejected';
  /** Что выбрал пользователь: approve / reject_skip (пропустить, продолжить) / reject_cancel (отменить всю работу). */
  resolution?: 'approve' | 'reject_skip' | 'reject_cancel' | null;
  createdAt: string;
  resolvedAt?: string | null;
  reason?: string | null;
}

/** Специальная ошибка — пользователь отменил работу. Ловится в цикле ретраев, чистый выход без retry. */
class RunCancelledError extends Error {
  constructor(message = 'Run cancelled by user') {
    super(message);
    this.name = 'RunCancelledError';
  }
}


type RunMode = 'diagnostics' | 'implementation' | 'research';
type ExecutionRole = 'analyst' | 'developer' | 'reviewer' | 'tester';

interface RoleExecutionPlan {
  enabled: boolean;
  assignment: string;
  reason: string;
}

interface NormalizedExecutionPlan {
  message: string;
  executionTask: string;
  plan: string[];
  roles: Record<ExecutionRole, RoleExecutionPlan>;
  files?: Array<{ path?: string; action?: string; description?: string; reason?: string }>;
}

@Injectable()
export class RunsService implements OnModuleInit {
  private readonly logger = new Logger(RunsService.name);

  constructor(
    @InjectRepository(Run)
    private readonly runRepo: Repository<Run>,
    @Inject(TeamsService)
    private readonly teamsService: TeamsService,
    @Inject(ProjectsService)
    private readonly projectsService: ProjectsService,
    @Inject(forwardRef(() => ChatsService))
    private readonly chatsService: ChatsService,
    @Inject(WsGateway)
    private readonly wsGateway: WsGateway,
    @Inject(ProvidersService)
    private readonly providersService: ProvidersService,
    @InjectRepository(MessageEntity)
    private readonly messagesRepo: Repository<MessageEntity>,
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
      projectId: dto.projectId,
      task: dto.task,
      // Сохраняем ИСХОДНОЕ сообщение пользователя. detectRunMode ниже использует
      // его в приоритете перед run.task (= executionTask оркестратора), который
      // часто теряет стоп-фразу «код не пишите» → режим ошибочно = implementation.
      originalMessage: dto.originalMessage ?? null,
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
   * Обработка ответа пользователя на запрос разрешения.
   * resolution:
   *  - 'approve'      — да, разрешаю (status='approved', run возвращается в running).
   *  - 'reject_skip'  — нет, пропустить это действие и продолжить работу (status='rejected',
   *    run возвращается в running — агент получит «не одобрено» и пойдёт дальше).
   *  - 'reject_cancel'— нет, отменить всю работу (status='rejected', run → cancelled,
   *    executeRunSteps увидит статус cancelled и выйдет из цикла).
   * reason — текст пользователя «как сделать надо» (опционально).
   */
  async resolveApproval(
    runId: string,
    approvalId: string,
    approved: boolean,
    reason?: string,
    resolution?: 'approve' | 'reject_skip' | 'reject_cancel',
  ) {
    const run = await this.runRepo.findOne({ where: { id: runId } });
    if (!run) throw new Error('Run not found');
    const events = Array.isArray(run.events) ? [...run.events] : [];
    let updated = false;
    let chosen: ApprovalRequest | null = null;
    for (const entry of events) {
      if (entry.event !== 'approval:requested' || !entry.payload || typeof entry.payload !== 'object') continue;
      const payload = entry.payload as ApprovalRequest;
      if (payload.id !== approvalId || payload.status !== 'pending') continue;
      payload.status = approved ? 'approved' : 'rejected';
      payload.reason = reason ?? null;
      payload.resolvedAt = new Date().toISOString();
      payload.resolution = resolution ?? (approved ? 'approve' : 'reject_skip');
      updated = true;
      chosen = payload;
    }
    if (!updated) {
      return { ok: false, reason: 'Approval request not found or already resolved' };
    }
    run.events = events;

    // Если пользователь выбрал «отменить всю работу» — помечаем run cancelled.
    // executeRunSteps крутится в requestApproval / между этапами и увидит это.
    if (chosen?.resolution === 'reject_cancel') {
      run.status = 'cancelled';
      run.finishedAt = new Date();
      run.cancelReason = reason ?? 'Пользователь отменил работу в запросе разрешения';
      await this.runRepo.save(run);
      try {
        if (run.chatId) {
          await this.broadcastActivity(
            runId, run.chatId, 'orchestrator', 'Alex', 'Оркестратор', 'error',
            reason ? `Работа отменена пользователем: ${reason}` : 'Работа отменена пользователем',
          );
        }
      } catch { /* ignore */ }
      return { ok: true, cancelled: true };
    }

    if (run.status === 'waiting_approval') {
      run.status = 'running';
    }
    await this.runRepo.save(run);
    return { ok: true };
  }

  /**
   * Остановить работу агента (cancel). Текущая попытка executeRunSteps увидит
   * status='cancelled' на ближайшей проверке между этапами и выйдет. Если run
   * сейчас ждёт разрешения — тоже выйдет (requestApproval увидит cancelled).
   */
  async cancelRun(runId: string, reason?: string): Promise<{ ok: boolean; reason?: string }> {
    const run = await this.runRepo.findOne({ where: { id: runId } });
    if (!run) return { ok: false };
    const terminal = ['completed', 'failed', 'cancelled'];
    if (terminal.includes(run.status)) {
      return { ok: false, reason: `Run already ${run.status}` };
    }
    run.status = 'cancelled';
    run.finishedAt = new Date();
    run.cancelReason = reason ?? 'Остановлено пользователем';
    await this.runRepo.save(run);
    if (run.chatId) {
      try {
        await this.broadcastActivity(
          runId, run.chatId, 'orchestrator', 'Alex', 'Оркестратор', 'error',
          reason ? `Останавливаю работу: ${reason}` : 'Останавливаю работу по запросу пользователя',
        );
      } catch { /* ignore */ }
    }
    return { ok: true };
  }

  /**
   * Поставить работу на паузу. executeRunSteps увидит status='paused' на
   * ближайшей проверке и выйдет из цикла (без пометки failed). Resume поднимет
   * прогон заново.
   */
  async pauseRun(runId: string, reason?: string): Promise<{ ok: boolean; reason?: string }> {
    const run = await this.runRepo.findOne({ where: { id: runId } });
    if (!run) return { ok: false };
    const active = ['running', 'queued', 'waiting_approval'];
    if (!active.includes(run.status)) {
      return { ok: false, reason: `Run is ${run.status}, cannot pause` };
    }
    run.status = 'paused';
    run.cancelReason = reason ?? null;
    await this.runRepo.save(run);
    if (run.chatId) {
      try {
        await this.broadcastActivity(
          runId, run.chatId, 'orchestrator', 'Alex', 'Оркестратор', 'working',
          reason ? `Ставлю работу на паузу: ${reason}` : 'Работа поставлена на паузу',
        );
      } catch { /* ignore */ }
    }
    return { ok: true };
  }

  /**
   * Продолжить работу после паузы. Просто перезапускаем executeRunSteps — он
   * подхватит контекст заново (attempt продолжится по retryCount). Если есть
   * pendingTask (пользователь дал новую задачу) — используем её как task/originalMessage.
   */
  async resumeRun(runId: string): Promise<{ ok: boolean; started: boolean; reason?: string }> {
    const run = await this.runRepo.findOne({ where: { id: runId } });
    if (!run) return { ok: false, started: false };
    if (run.status !== 'paused') {
      return { ok: false, started: false, reason: `Run is ${run.status}, not paused` };
    }
    // Если пользователь дал новую задачу — подменяем task/originalMessage.
    if (run.pendingTask && String(run.pendingTask).trim()) {
      run.task = String(run.pendingTask).trim();
      run.originalMessage = String(run.pendingTask).trim();
      run.pendingTask = null;
    }
    run.status = 'queued';
    run.cancelReason = null;
    await this.runRepo.save(run);
    if (run.chatId) {
      try {
        await this.broadcastActivity(
          runId, run.chatId, 'orchestrator', 'Alex', 'Оркестратор', 'working',
          'Продолжаю работу',
        );
      } catch { /* ignore */ }
    }
    // Запуск в фоне.
    void this.executeRunSteps(runId).catch((error) => {
      this.logger.error(`Resume run ${runId} failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    return { ok: true, started: true };
  }

  /**
   * Дать агенту новую задачу. Если run сейчас на паузе — кладём в pendingTask,
   * resume подхватит. Если run активен (running/queued/waiting) — сначала
   * ставим паузу, затем кладём pendingTask и сразу resume (по сути «перенаправить»).
   * Если run уже завершён — возвращаем ok:false, фронт тогда должен начать
   * новый чат/run.
   */
  async replaceTask(
    runId: string,
    newTask: string,
  ): Promise<{ ok: boolean; action: 'queued_for_resume' | 'redirected' | 'unavailable'; reason?: string }> {
    const run = await this.runRepo.findOne({ where: { id: runId } });
    if (!run) return { ok: false, action: 'unavailable', reason: 'Прогон не найден' };
    const task = String(newTask || '').trim();
    if (!task) return { ok: false, action: 'unavailable', reason: 'Пустая задача' };

    const terminal = ['completed', 'failed', 'cancelled'];
    if (terminal.includes(run.status)) {
      return { ok: false, action: 'unavailable', reason: `Прогон уже завершён (${run.status})` };
    }

    if (run.status === 'paused') {
      run.pendingTask = task;
      await this.runRepo.save(run);
      if (run.chatId) {
        try {
          await this.broadcastActivity(
            runId, run.chatId, 'orchestrator', 'Alex', 'Оркестратор', 'working',
            `Принял новую задачу. Возобновите работу, чтобы агент начал её.`,
          );
        } catch { /* ignore */ }
      }
      return { ok: true, action: 'queued_for_resume' };
    }

    // Активный run — ставим паузу, кладём задачу, тут же resume.
    run.status = 'paused';
    run.pendingTask = task;
    await this.runRepo.save(run);
    if (run.chatId) {
      try {
        await this.broadcastActivity(
          runId, run.chatId, 'orchestrator', 'Alex', 'Оркестратор', 'working',
          'Перенаправляю на новую задачу…',
        );
      } catch { /* ignore */ }
    }
    // resume перечитает run, подхватит pendingTask и запустит executeRunSteps.
    await this.resumeRun(runId);
    return { ok: true, action: 'redirected' };
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

  private getPendingApprovals(run: Run | null): ApprovalRequest[] {
    if (!run || !Array.isArray(run.events)) return [];
    return run.events
      .filter((entry) => entry.event === 'approval:requested' && entry.payload && typeof entry.payload === 'object')
      .map((entry) => entry.payload as ApprovalRequest)
      .filter((approval) => approval.status === 'pending');
  }

  /**
   * Проверяет, был ли run остановлен/приостановлен пользователем во время
   * работы. executeRunSteps вызывает её между этапами (оркестратор→аналитик→
   * разработчик→тестер→финалка) и при выходе из ожидания разрешения. Если run
   * отменён/на паузе — выбрасываем RunCancelledError, который ловится в цикле
   * ретраев как «чистый выход, без retry и без пометки failed».
   */
  private async assertRunContinuable(runId: string, context = 'step'): Promise<void> {
    const run = await this.runRepo.findOne({ where: { id: runId } });
    if (!run) throw new RunCancelledError(`Run ${runId} not found (${context})`);
    if (run.status === 'cancelled') {
      throw new RunCancelledError(run.cancelReason || `Run cancelled (${context})`);
    }
    if (run.status === 'paused') {
      throw new RunCancelledError(`Run paused by user (${context})`);
    }
  }


  private async requestApproval(
    runId: string,
    chatId: string,
    role: ExecutionRole,
    name: string,
    label: string,
    input: Omit<ApprovalRequest, 'id' | 'status' | 'createdAt'>,
  ): Promise<{ approved: boolean; approvalId: string }> {
    const approval: ApprovalRequest = {
      ...input,
      id: `approval-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    await this.appendRunEvent(runId, 'approval:requested', approval);
    await this.broadcastActivity(runId, chatId, role, name, label, 'working', `Жду разрешение на действие: ${approval.title}`);
    await this.runRepo.update(runId, { status: 'waiting_approval' });

    const started = Date.now();
    while (Date.now() - started < 30 * 60 * 1000) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const run = await this.runRepo.findOne({ where: { id: runId } });
      const pending = this.getPendingApprovals(run);
      const current = Array.isArray(run?.events)
        ? run?.events
            .filter((entry) => entry.event === 'approval:requested' && entry.payload && typeof entry.payload === 'object')
            .map((entry) => entry.payload as ApprovalRequest)
            .find((item) => item.id === approval.id)
        : undefined;
      if (!current) break;
      if (current.status === 'approved') {
        await this.broadcastActivity(runId, chatId, role, name, label, 'done', `Разрешение получено: ${approval.title}`);
        return { approved: true, approvalId: approval.id };
      }
      if (current.status === 'rejected') {
        await this.broadcastActivity(runId, chatId, role, name, label, 'error', `Действие отклонено: ${approval.title}`);
        return { approved: false, approvalId: approval.id };
      }
      // Пользователь остановил/приостановил работу, пока мы ждали разрешения —
      // выходим из ожидания. По reject_cancel approval уже помечен rejected и
      // мы вышли выше; сюда попадаем при cancelRun/pauseRun без resolveApproval.
      if (run?.status === 'cancelled' || run?.status === 'paused') {
        return { approved: false, approvalId: approval.id };
      }
      if (!pending.some((item) => item.id === approval.id)) break;
    }


    await this.broadcastActivity(runId, chatId, role, name, label, 'error', `Истекло ожидание разрешения: ${approval.title}`);
    return { approved: false, approvalId: approval.id };
  }

  /**
   * Основная оркестрация. Оркестратор сначала строит план, после чего рантайм
   * сам решает, каких агентов реально подключать для конкретной задачи.
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
    const resolvedProjectId = run.projectId ?? projectIdFromChat ?? '';
    if (!resolvedProjectId) {
      throw new Error(`Run ${runId} has no projectId and chat ${run.chatId} has no projectId`);
    }
    if (run.projectId && projectIdFromChat && run.projectId !== projectIdFromChat) {
      throw new Error(`Run ${runId} points to project ${run.projectId}, but chat ${run.chatId} belongs to ${projectIdFromChat}`);
    }
    const project = await this.projectsService.getById(resolvedProjectId);
    const team = await this.teamsService.getById(run.teamId);
    
    const chatId = run.chatId ?? '';
    const projectId = project.id ?? '';
    
    // Провайдер команды может быть не привязан — тогда берём текущий (активный).
    const teamProvider = team?.provider ?? await this.providersService.getActive().catch(() => null);
    if (!teamProvider || !teamProvider.apiKey) {
      throw new Error('No provider configured — add one in Settings → Providers');
    }
    team.provider = teamProvider;

    const teamConfig = team.config as unknown as TeamConfig;
    const language = teamConfig.language || 'ru';
    const agents = teamConfig.agents || {};
    const workspace = teamConfig.workspace || { maxFiles: 12, maxCharsPerFile: 12000, includeExtensions: ['.ts', '.tsx', '.js', '.jsx', '.json', '.md', '.css', '.html', '.py', '.php', '.vue'], ignoreDirs: ['.git', 'node_modules', 'dist', 'build'] };
    const testingCommands = Array.isArray(teamConfig.testing?.commands)
      ? teamConfig.testing?.commands.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : [];

    const orchestratorAgent = agents.orchestrator || agents.pm;
    const analystAgent = agents.analyst;
    const developerAgent = agents.developer;
    const testerAgent = agents.tester;

    if (!orchestratorAgent?.model) {
      throw new Error('Orchestrator model is not configured');
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
    const containerProjectsRoot = process.env.CONTAINER_PROJECTS_ROOT || hostProjectsRoot;
    const resolvedLocalPath = path.isAbsolute(project.localPath || '')
      ? path.resolve(project.localPath || '')
      : path.resolve(hostProjectsRoot, project.localPath || '');
    const projectPath = resolvedLocalPath.replace(hostProjectsRoot, containerProjectsRoot).replace(/\/+$/, '');
    const projectName = project.name || 'Unknown Project';
    if (run.projectPath !== project.localPath || run.projectId !== project.id) {
      run.projectPath = project.localPath;
      run.projectId = project.id;
      await this.runRepo.save(run);
    }

    // Финальная очистка run.task от дублированных путей (apps/api/apps/web/... → apps/web/...)
    if (run.task && project.localPath) {
      const cleanedTask = cleanupPathsInTask(project.localPath, run.task, fs.existsSync);
      if (cleanedTask !== run.task) {
        this.logger.warn(`[${runId}] Cleaned duplicate path in run.task: "${run.task.slice(0, 80)}..." → "${cleanedTask.slice(0, 80)}..."`);
        run.task = cleanedTask;
        await this.runRepo.save(run);
      }
    }

    // Защита: если projectPath не абсолютный или не существует — роняем с понятной ошибкой,
    // чтобы агенты не писали файлы в cwd API-процесса (apps/api).
    if (!path.isAbsolute(projectPath)) {
      const msg = `projectPath не абсолютный: "${projectPath}". localPath="${project.localPath}", hostProjectsRoot="${hostProjectsRoot}". Проверьте LOCAL_PROJECTS_ROOT в .env и localPath в БД.`;
      this.logger.error(msg);
      throw new Error(msg);
    }
    if (!fs.existsSync(projectPath)) {
      const msg = `projectPath не существует: "${projectPath}". Проверьте, что проект примонтирован и путь корректен.`;
      this.logger.error(msg);
      throw new Error(msg);
    }
    this.logger.log(`Project path resolved: ${projectPath} (localPath=${project.localPath})`);

    // Режим прогона: 'diagnostics' (только анализ, БЕЗ правок кода) или
    // 'implementation' (внести изменения). Определяем ДЕТЕРМИНИРОВАННО по
    // тексту задачи, а НЕ полагаемся на LLM: слабая модель на planning-шаге
    // оркестратора часто игнорирует "код не пишите" и всё равно ставит
    // разработчику задачу писать код. Фиксит баг "разраб пишет код, хотя
    // пользователь явно просил только проверить".
    // Режим определяем по ИСХОДНОМУ сообщению пользователя (run.originalMessage),
    // а не по run.task (= executionTask оркестратора). Оркестратор часто теряет
    // стоп-фразу «код не пишите» в переложении задачи — без этого фикса режим
    // ошибочно становился implementation, и разработчик переписывал файлы
    // вопреки прямой просьбе пользователя «просто проверь».
    const modeSource = run.originalMessage || run.task;
    const runMode = this.detectRunMode(modeSource);
    this.logger.log(`Run ${runId} mode: ${runMode} (source="${modeSource.slice(0, 80)}")`);
    const memoryContext = await this.buildMemoryContext(projectId, run.task);

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

        const rawPlan = (orchestratorResult.artifact || {}) as Record<string, unknown>;
        const plan = this.normalizeExecutionPlan(rawPlan, run.task, runMode, teamConfig);
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
        await this.broadcastActivity(
          runId,
          chatId,
          'orchestrator',
          orchName,
          orchLabel,
          'done',
          this.describeExecutionPlan(plan),
        );

        // Проверка: не остановил/приостановил ли пользователь работу, пока
        // оркестратор строил план. Если да — выходим чисто (RunCancelledError).
        await this.assertRunContinuable(runId, 'after-orchestrator');

        let spec: Record<string, unknown> = this.buildFallbackSpecFromPlan(plan, runMode);

        let analystWorked = false;
        if (plan.roles.analyst.enabled) {
          if (!analystAgent?.model) {
            throw new Error('Analyst role is required by the plan, but its model is not configured');
          }

          await this.broadcastActivity(runId, chatId, 'analyst', anName, anLabel, 'working', this.buildAnalystStatus(plan, runMode));

          const analystResult = await this.callAgentStream(
            runId, chatId, 'analyst', analystAgent, language,
            this.buildAnalystPrompt(run, plan, project, chat.messages, projectPath, workspace, runMode, memoryContext),
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

          spec = (analystResult.artifact || {}) as Record<string, unknown>;
          analystWorked = true;
          await this.broadcastActivity(runId, chatId, 'analyst', anName, anLabel, 'done', this.buildAnalystDoneStatus(plan, runMode));
          // Сохраняем ТЗ аналитика как сообщение в чат, чтобы оно персистило
          // и не исчезало при перезагрузке страницы.
          const analystRawText = String(analystResult.rawResponse || '').trim();
          if (analystRawText) {
            await this.chatsService.addMessage(chatId, 'assistant', analystRawText, {
              type: 'agent-brief',
              role: 'analyst',
              name: anName,
              label: anLabel,
              runId,
            } as Record<string, unknown>);
          }
          await this.saveProjectMemory(projectId, chatId, spec, language, runMode, runId);
        } else {
          await this.broadcastActivity(runId, chatId, 'analyst', anName, anLabel, 'done', `Этап пропущен: ${plan.roles.analyst.reason}`);
        }

        let codeChanges: Record<string, unknown> = { files: [], summary: 'Нет изменений' };
        let developerWorked = false;
        if (plan.roles.developer.enabled) {
          if (!developerAgent?.model) {
            throw new Error('Developer role is required by the plan, but its model is not configured');
          }

          await this.broadcastActivity(runId, chatId, 'developer', devName, devLabel, 'working', this.buildDeveloperStatus(plan, runMode));

          const devSpec = {
            files: (spec as any).files || [],
            requirements: (spec as any).requirements || [],
            feature: (spec as any).feature || '',
            description: (spec as any).description || '',
            diagnosis: (spec as any).diagnosis || [],
            assignment: plan.roles.developer.assignment,
          };

          try {
            if (Array.isArray(devSpec.files)) {
              devSpec.files = devSpec.files
                .map((file: any) => {
                  const originalPath = String(file?.path || '').trim();
                  if (!originalPath || isUrlLikePath(originalPath)) {
                    return null;
                  }
                  const relPath = this.relPathWithinProject(projectPath, originalPath);
                  if (!relPath || hasSuspiciousMirroredPath(relPath)) return null;
                  const fullPath = path.join(projectPath, relPath);
                  const parentPath = path.join(projectPath, path.dirname(relPath));
                  const action = String(file?.action || '').trim().toLowerCase();
                  const exists = fs.existsSync(fullPath) || fs.existsSync(parentPath);
                  if (!exists && action !== 'create') return null;
                  return { ...file, path: relPath };
                })
                .filter(Boolean);
            }
          } catch (sanitizeError) {
            this.logger.warn(`Failed to sanitize developer file list: ${sanitizeError instanceof Error ? sanitizeError.message : String(sanitizeError)}`);
          }

          const developerResult = await this.callAgentStream(
            runId, chatId, 'developer', developerAgent, language,
            this.buildDeveloperPrompt(run, devSpec, project, workspace, projectPath, runMode, memoryContext),
            (delta) => this.wsGateway.broadcastTokenStream(chatId, { role: 'developer', content: delta, done: false })
          );

          if (!developerResult.success) {
            throw new Error(`Developer failed: ${developerResult.error}`);
          }

          codeChanges = (developerResult.artifact || {}) as Record<string, unknown>;

          // АВТОКОНВЕРТАЦИЯ create → update для существующих файлов.
          // Developer-модель часто возвращает ACTION: create для файлов, которые
          // уже существуют на диске — потому что в ТЗ аналитик написал "создай",
          // а файл уже был. applyFileChange при create перезаписывает файл целиком
          // (стирая весь legacy-код), вместо точечного патча. Автоматически
          // конвертируем create → update, чтобы существующий контент не терялся.
          try {
            const devFiles = Array.isArray((codeChanges as any)?.files) ? (codeChanges as any).files : [];
            for (const f of devFiles) {
              if (typeof f?.path !== 'string' || f.action !== 'create') continue;
              const rel = this.relPathWithinProject(projectPath, f.path);
              if (!rel) continue;
              const fullPath = path.join(projectPath, rel);
              if (fs.existsSync(fullPath)) {
                // Файл существует — конвертируем create → update.
                // Если у файла нет patches — создаём "заменить всё содержимое" патч.
                const hasPatches = Array.isArray(f.patches) && f.patches.length > 0;
                const hasContent = typeof f.content === 'string' && f.content.trim().length > 0;
                if (!hasPatches && hasContent) {
                  // Превращаем content в patch: SEARCH=current, REPLACE=new
                  // (но только если файл небольшой, иначе — перезапись допустима)
                  const currentContent = fs.readFileSync(fullPath, 'utf-8');
                  f.patches = [{ search: currentContent.slice(0, 5000), replace: f.content }];
                  delete f.content;
                }
                f.action = 'update';
                this.logger.log(`Auto-converted create→update for existing file: ${f.path} (run ${runId})`);
              }
            }
          } catch (convErr) {
            this.logger.warn(`Auto-convert create→update failed: ${convErr instanceof Error ? convErr.message : String(convErr)}`);
          }

          // САМОПРОВЕРКА РАЗРАБОТЧИКА (pre-flight валидация SEARCH с фидбеком).
          // До применения патчей проверяем, что каждый SEARCH-блок РЕАЛЬНО
          // присутствует в текущем коде. Если нет — плохой SEARCH раньше тихо
          // скипался в applyFileChange (просто warn в лог), разработчик об этом
          // не знал и правка не попадала в файл. Теперь замыкаем цикл: показываем
          // разработчику его «промахи» + реальный текущий код и просим
          // исправленные патчи. До maxReviewRounds. Только для implementation
          // (в diagnostics/research правок нет в принципе).
          if (runMode === 'implementation' && teamConfig.run?.applyChanges !== false) {
            const maxRounds = Math.max(1, Number(teamConfig.run?.maxReviewRounds ?? 1));
            for (let round = 0; round < maxRounds; round++) {
              const problems = this.validateDeveloperPatches(projectPath, codeChanges);
              if (!problems.length) break;
              await this.broadcastActivity(runId, chatId, 'developer', devName, devLabel, 'working', `Самопроверка: ${problems.length} SEARCH-блок(ов) не найдены в текущем коде — прошу исправить (раунд ${round + 1}/${maxRounds})`);
              const fixPrompt = this.buildDeveloperSelfCheckPrompt(run, devSpec, project, projectPath, problems);
              const fixResult = await this.callAgentStream(
                runId, chatId, 'developer', developerAgent, language, fixPrompt,
                (delta) => this.wsGateway.broadcastTokenStream(chatId, { role: 'developer', content: delta, done: false })
              );
              if (!fixResult.success && fixResult.rawResponse) {
                const fixed = this.parseDeveloperMarkerFormat(fixResult.rawResponse) ?? this.tryFixDeveloperJson(fixResult.rawResponse);
                if (fixed) { fixResult.success = true; fixResult.artifact = fixed; }
              }
              if (!fixResult.success) break; // не роняем run — оставляем исходные патчи
              const fixedChanges = (fixResult.artifact || {}) as Record<string, unknown>;
              const fixedFiles = Array.isArray((fixedChanges as any)?.files) ? (fixedChanges as any).files : [];
              if (!fixedFiles.length) break; // разработчик сказал «нет изменений» — выходим
              // Мержим исправленные патчи поверх исходных codeChanges: заменяем
              // файлы с тем же путём, новые добавляем.
              const byPath = new Map<string, any>();
              for (const f of (codeChanges as any).files || []) byPath.set(String(f.path), f);
              for (const f of fixedFiles) byPath.set(String(f.path), f);
              (codeChanges as any).files = Array.from(byPath.values());
            }
          }

          const requestedCommands = this.parseAgentCommandRequests(developerResult.rawResponse || '');

          const executedDeveloperCommands: Array<{ command: string; success: boolean; output: string; code: number | null }> = [];
          for (const request of requestedCommands) {
            const relCwd = request.cwd ? this.relPathWithinProject(projectPath, request.cwd) : '';
            const cwd = relCwd ? path.join(projectPath, relCwd) : projectPath;
            const suspiciousNestedCwd =
              !!relCwd &&
              /^(apps|packages|services|libs)\/[^/]+$/i.test(relCwd) &&
              Array.isArray((codeChanges as any).files) &&
              ((codeChanges as any).files as Array<any>).some((file) => {
                const p = String(file?.path || '').replace(/\\/g, '/');
                return p.startsWith('apps/web/') || p.endsWith('.vue');
              });
            if (suspiciousNestedCwd) {
              executedDeveloperCommands.push({
                command: request.command,
                success: false,
                code: null,
                output: `Blocked suspicious developer CWD "${request.cwd}". Для этой задачи команды должны запускаться из корня выбранного проекта.`,
              });
              continue;
            }
            const result = await this.executeCommandWithApproval(
              runId,
              chatId,
              'developer',
              devName,
              devLabel,
              request.command,
              cwd,
              `Команда разработчика: ${request.command}`,
              request.reason || 'Разработчик запросил выполнение команды',
              teamConfig,
            );
            executedDeveloperCommands.push({
              command: request.command,
              success: result.success,
              output: result.output.slice(0, 4000),
              code: result.code,
            });
          }
          (codeChanges as any).executedCommands = executedDeveloperCommands;
          developerWorked = true;
          await this.broadcastActivity(runId, chatId, 'developer', devName, devLabel, 'done', this.buildDeveloperDoneStatus(plan, runMode, codeChanges));
        } else {
          await this.broadcastActivity(runId, chatId, 'developer', devName, devLabel, 'done', `Этап пропущен: ${plan.roles.developer.reason}`);
        }

        const files = (codeChanges as any).files;
        // Документационные артефакты разработчика (.md отчёты, architecture-report
        // и т.п.) — НЕ пишем в репо, но СОХРАНЯЕМ полный контент в project memory,
        // чтобы потом пользователь мог попросить «напечатай architecture-report.md»
        // и агент выдал реальный текст, а не галлюцинировал другой проект.
        const docArtifacts: Array<{ path: string; content: string; description?: string }> = [];
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
        const appliedFilePaths: string[] = [];
        const failedFileChanges: Array<{ path: string; error: string }> = [];
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
                await this.broadcastActivity(runId, chatId, 'developer', devName, devLabel, 'working', `Документация «${fileChange.path}» — сохраняю в памяти проекта (БД), в репо не пишу`);
                // Раньше контент .md-артефакта просто выбрасывался → когда
                // пользователь просил «напечатай architecture-report.md», файла
                // физически не было, и агент галлюцинировал ДРУГОЙ проект
                // (React+Zustand вместо реального Electron+Vue). Теперь сохраняем
                // полный контент в project memory — агент сможет его прочитать.
                if (typeof fileChange.content === 'string' && fileChange.content.trim()) {
                  docArtifacts.push({ path: fileChange.path, content: fileChange.content, description: fileChange.description });
                }
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
                appliedFilePaths.push(String(fileChange.path || '').trim());
                await this.broadcastActivity(runId, chatId, 'developer', devName, devLabel, 'working', `${verb} файл: ${fileChange.path} (${fileChange.action})`);
              } else {
                failedFileChanges.push({ path: String(fileChange.path || '').trim(), error: String(res.error || 'unknown') });
                await this.broadcastActivity(runId, chatId, 'developer', devName, devLabel, 'error', `Не удалось применить ${fileChange.path}: ${res.error}`);
              }
            }
          }
        }
        (codeChanges as any).appliedFiles = appliedFilePaths;
        (codeChanges as any).failedFiles = failedFileChanges;

        // REVIEWER (code review) — после developer, до tester.
        // Проверяет стили, потенциальные баги, архитектурные риски.
        // Может предлагать SEARCH/REPLACE-патчи — они мержатся в codeChanges.
        let reviewerWorked = false;
        if (plan.roles.reviewer?.enabled) {
          if (!developerAgent?.model) {
            throw new Error('Reviewer role is required by the plan, but developer model is not configured (reused for reviewer)');
          }

          const reviewerAgentCfg: AgentConfig = {
            ...developerAgent,
            name: agents.reviewer?.name || agents.developer?.name || 'Kai',
            label: agents.reviewer?.label || agents.developer?.label || 'Разработчик',
          };
          const rvName = reviewerAgentCfg.name || 'Kai';
          const rvLabel = reviewerAgentCfg.label || 'Ревьюер';

          await this.broadcastActivity(runId, chatId, 'reviewer', rvName, rvLabel, 'working', this.buildReviewerStatus(plan, runMode));

          const reviewerResult = await this.callAgentStream(
            runId, chatId, 'reviewer', reviewerAgentCfg, language,
            this.buildReviewerPrompt(run, codeChanges, project, workspace, projectPath, runMode, plan),
            (delta) => this.wsGateway.broadcastTokenStream(chatId, { role: 'reviewer', content: delta, done: false })
          );

          if (!reviewerResult.success && reviewerResult.rawResponse) {
            const fixed = this.parseReviewerMarkerFormat(reviewerResult.rawResponse)
              ?? this.tryFixAgentJson(reviewerResult.rawResponse, 'reviewer');
            if (fixed) {
              reviewerResult.success = true;
              reviewerResult.artifact = fixed;
            }
          }

          if (reviewerResult.success && reviewerResult.artifact) {
            const reviewArtifact = reviewerResult.artifact as Record<string, unknown>;
            const reviewFiles = Array.isArray((reviewArtifact as any)?.files) ? (reviewArtifact as any).files : [];

            if (reviewFiles.length && runMode === 'implementation' && applyChanges) {
              await this.broadcastActivity(runId, chatId, 'reviewer', rvName, rvLabel, 'working', `Ревьюер предложил ${reviewFiles.length} исправлений — применяю`);
              // Мержим патчи ревьюера поверх codeChanges разработчика
              const byPath = new Map<string, any>();
              for (const f of (codeChanges as any).files || []) byPath.set(String(f.path), f);
              for (const f of reviewFiles) byPath.set(String(f.path), f);
              (codeChanges as any).files = Array.from(byPath.values());
            }

            // Добавляем findings ревьюера в финальный отчёт (metadata)
            const findings = Array.isArray((reviewArtifact as any)?.findings) ? (reviewArtifact as any).findings : [];
            if (findings.length) {
              (codeChanges as any).reviewFindings = findings;
            }
            reviewerWorked = true;
            await this.broadcastActivity(runId, chatId, 'reviewer', rvName, rvLabel, 'done', this.buildReviewerDoneStatus(plan, runMode, reviewArtifact));
          } else if (!reviewerResult.success) {
            // Ревьюер не критичен — логируем ошибку, но не роняем run
            this.logger.warn(`Reviewer failed for run ${runId}: ${reviewerResult.error}`);
            await this.broadcastActivity(runId, chatId, 'reviewer', reviewerAgentCfg.name || 'Kai', reviewerAgentCfg.label || 'Ревьюер', 'error', `Ревью не удался: ${reviewerResult.error}`);
          }
        } else if (plan.roles.reviewer) {
          const rvName = agents.reviewer?.name || 'Kai';
          const rvLabel = agents.reviewer?.label || 'Ревьюер';
          await this.broadcastActivity(runId, chatId, 'reviewer', rvName, rvLabel, 'done', `Этап пропущен: ${plan.roles.reviewer.reason}`);
        }

        // Сохраняем doc-артефакты в project memory с ПОЛНЫМ контентом — чтобы
        // потом агент мог их прочитать (например, «напечатай architecture-report.md»)
        // и выдать реальный текст про ТОТ же проект, а не галлюцинировать другой.
        for (const doc of docArtifacts) {
          try {
            await this.saveProjectMemory(projectId, chatId, {
              feature: doc.path.split('/').pop() || doc.path,
              description: doc.description || `Артефакт разработчика: ${doc.path}`,
              details: doc.content,
              tags: ['documentation', 'artifact', String(doc.path.split('/').pop() || '')],
            } as any, language, runMode, runId);
          } catch (err) {
            this.logger.warn(`Failed to save doc artifact ${doc.path}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        const memoryUpdate: {
          [key: string]: unknown;
          lastRun: {
            task: string;
            status: 'success' | 'failed';
            testResults: TestResult;
            codeChanges: string[];
            executedCommands?: string[];
            timestamp: string;
          };
        } = {
          ...spec,
          lastRun: {
            task: run.task,
            status: 'success',
            testResults: { passed: true, tests: [], errors: [] },
            codeChanges: files?.map((f: any) => f.path) || [],
            executedCommands: [],
            timestamp: new Date().toISOString(),
          },
        };

        let testResults: TestResult = {
          passed: true,
          summary: '',
          tests: [],
          errors: [],
        };
        if (plan.roles.tester.enabled) {
          if (!testerAgent?.model) {
            throw new Error('Tester role is required by the plan, but its model is not configured');
          }

          await this.broadcastActivity(runId, chatId, 'tester', testName, testLabel, 'working', this.buildTesterStatus(plan, runMode));

          const testerResult = await this.callAgentStream(
            runId, chatId, 'tester', testerAgent, language,
            this.buildTesterPrompt(run, codeChanges, project, plan, runMode, testingCommands, projectPath),
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

          testResults = (testerResult.artifact as unknown as TestResult) || testResults;
          const requestedTests = Array.isArray(testResults.tests) ? testResults.tests : [];
          const executedTests: Array<{ name: string; command: string; success: boolean; output: string }> = [];
          // Запускаем одобренные пользователем реальные команды ВСЕГДА — не
          // только в implementation и не только когда команда из белого списка
          // testingCommands. Раньше в research/диагностике тестер предлагал
          // «проверить через grep», пользователь разрешал, но:
          //   а) runMode !== 'implementation' → блок вообще пропускался;
          //   б) command не из testingCommands → continue, команда не бежала;
          // в итоге пользователь видел «Тесты: ❌ Провалены», хотя команду он
          // одобрил и хотел её результат. Теперь: если команда одобрена —
          // бежит, её вывод попадает в executedTests, а итог run зависит от
          // того, БЕЖАЛИ ли команды и в каком режиме.
          if (requestedTests.length) {
            for (const test of requestedTests) {
              if (!test?.command || !String(test.command).trim()) continue;
              const result = await this.executeCommandWithApproval(
                runId,
                chatId,
                'tester',
                testName,
                testLabel,
                test.command,
                projectPath,
                `Тестовая команда: ${test.command}`,
                test.output || `Тестировщик хочет выполнить ${test.command}`,
                teamConfig,
              );
              executedTests.push({
                name: test.name || test.command,
                command: test.command,
                success: result.success,
                output: result.output.slice(0, 4000),
              });
            }
          }
          if (executedTests.length) {
            testResults.tests = executedTests;
            const anyFailed = executedTests.some((item) => !item.success);
            // MODE-AWARE итог. В research/диагностике провал команды (включая
            // ENOENT «путь недоступен» или grep «не найдено») — это ИНФОРМАЦИЯ,
            // а не провал run'а. Пользователь одобрил grep именно чтобы узнать
            // «есть ли термин в коде»; если путь не существует или grep ничего
            // не нашёл — это и есть ответ, run должен ЗАВЕРШИТЬСЯ (completed), а
            // не падать в «работа не удалась после 3 попыток / Тесты провалены».
            // Только в implementation провал тест-команды реально означает, что
            // правка что-то сломала → passed=false → run failed.
            const commandFailureFailsRun = runMode === 'implementation';
            testResults.passed = commandFailureFailsRun ? !anyFailed : true;
            if (!testResults.summary) {
              testResults.summary = anyFailed
                ? (commandFailureFailsRun
                    ? 'Часть реальных команд проверки завершилась с ошибкой.'
                    : 'Часть команд завершилась с ошибкой (путь недоступен / не найдено) — это часть ответа, а не провал проверки.')
                : 'Реальные команды проверки выполнены успешно.';
            }
            if (anyFailed) {
              // Сохраняем РЕАЛЬНЫЙ вывод упавших команд в errors — финальный
              // отчёт оркестратора получит их через JSON.stringify(testResults)
              // и перескажет пользователю фактику (ENOENT/«НЕ НАЙДЕНО»), а не
              // абстрактное «работа не удалась / не верифицировано».
              testResults.errors = [
                ...(testResults.errors || []),
                ...executedTests.filter((item) => !item.success).map((item) => `Команда «${item.command}»: ${String(item.output || '').slice(0, 600)}`),
              ];
            }
            // В research/диагностике кладём ПОЛНЫЙ вывод всех команд в summary,
            // чтобы оркестратор в финальке опирался на реальный вывод (grep
            // «НЕ НАЙДЕНО» / ENOENT), а не галлюцинировал «полноту подтвердить
            // нельзя». Это прямо закрывает жалобу про «поиск не дал результатов,
            // полноту подтвердить нельзя».
            if (!commandFailureFailsRun) {
              const outputs = executedTests
                .map((item) => `[${item.command}]: ${String(item.output || '').slice(0, 1000)}`)
                .join('\n');
              testResults.summary = `${testResults.summary}\nВывод команд:\n${outputs}`;
            }
          } else {
            // Реальные команды не бежали (пользователь ничего не одобрял или
            // тестер не предложил команд). НЕ доверяем галке passed от LLM —
            // она любит ставить false «на всякий случай», что роняло run в
            // «Провалены» безосновательно. Считаем проверку нейтрально
            // пройденной: статическое мнение тестера получено, команд не было
            // → run не должен падать только из-за этого.
            testResults.tests = [];
            testResults.passed = true;
            if (!testResults.summary) {
              testResults.summary = runMode === 'research'
                ? 'Мнение тестировщика получено, реальные команды не запускались.'
                : 'Статическая проверка выполнена, реальные команды не запускались.';
            }
            if (Array.isArray(testResults.errors) && testResults.errors.length) {
              // Если тестер назвал конкретные риски в errors — не роняем run,
              // но сохраняем их в summary, чтобы пользователь их видел.
              testResults.summary = `${testResults.summary} Риски: ${testResults.errors.join('; ')}`;
              testResults.errors = [];
            }
          }
          await this.broadcastActivity(
            runId,
            chatId,
            'tester',
            testName,
            testLabel,
            testResults.passed ? 'done' : 'error',
            testResults.passed ? this.buildTesterDoneStatus(plan, runMode) : `Тесты упали: ${(testResults.errors || []).join(', ') || 'unknown'}`,
          );

          const testerRework = this.decideTesterRework(runMode, testResults, codeChanges);
          if (testerRework.shouldRework && developerAgent?.model) {
            await this.broadcastActivity(
              runId,
              chatId,
              'tester',
              testName,
              testLabel,
              'working',
              `Нашёл баги, возвращаю задачу разработчику: ${testerRework.reason}`,
            );
            const reworkPrompt = this.buildDeveloperReworkPrompt(run, project, projectPath, codeChanges, testResults);
            const reworkResult = await this.callAgentStream(
              runId,
              chatId,
              'developer',
              developerAgent,
              language,
              reworkPrompt,
              (delta) => this.wsGateway.broadcastTokenStream(chatId, { role: 'developer', content: delta, done: false }),
            );

            if (reworkResult.success) {
              const reworkChanges = (reworkResult.artifact || {}) as Record<string, unknown>;
              const reworkFiles = Array.isArray((reworkChanges as any)?.files) ? (reworkChanges as any).files : [];
              if (reworkFiles.length && teamConfig.run?.applyChanges !== false) {
                for (const fileChange of reworkFiles as Array<{ path: string; action: string; content?: string; description?: string; patches?: Array<{ search: string; replace: string }> }>) {
                  const res = await this.applyFileChange(projectPath, fileChange, true);
                  if (res.ok) {
                    const relPath = this.relPathWithinProject(projectPath, fileChange.path);
                    if (relPath) appliedFilePaths.push(relPath);
                  } else {
                    failedFileChanges.push({ path: fileChange.path, error: res.error || 'Неизвестная ошибка применения правки' });
                  }
                }
                (codeChanges as any).appliedFiles = appliedFilePaths;
                (codeChanges as any).failedFiles = failedFileChanges;
                await this.broadcastActivity(runId, chatId, 'developer', devName, devLabel, 'done', 'Исправил замечания тестировщика');
              } else {
                await this.broadcastActivity(runId, chatId, 'developer', devName, devLabel, 'done', 'Разработчик не вернул дополнительных правок после замечаний тестировщика');
              }
            } else {
              await this.broadcastActivity(runId, chatId, 'developer', devName, devLabel, 'error', `Не удалось вернуть задачу разработчику: ${reworkResult.error || 'unknown'}`);
            }
          }

        } else {
          await this.broadcastActivity(runId, chatId, 'tester', testName, testLabel, 'done', `Этап пропущен: ${plan.roles.tester.reason}`);
        }

        if (analystWorked || developerWorked || plan.roles.tester.enabled) {
          await this.broadcastActivity(runId, chatId, 'analyst', anName, anLabel, 'working', 'Обновляю память проекта');

          memoryUpdate.lastRun = {
            task: run.task,
            status: testResults.passed ? 'success' : 'failed',
            testResults,
            codeChanges: appliedFilePaths,
            executedCommands: Array.isArray((testResults as any)?.tests)
              ? (testResults as any).tests.map((item: any) => item.command).filter(Boolean)
              : [],
            timestamp: new Date().toISOString(),
          };
          await this.saveProjectMemory(projectId, chatId, memoryUpdate, language, runMode, runId);

          await this.broadcastActivity(runId, chatId, 'analyst', anName, anLabel, 'done', 'Память проекта обновлена');
        }

        // 6. ORCHESTRATOR - финальный отчет
        await this.broadcastActivity(runId, chatId, 'orchestrator', orchName, orchLabel, 'working', 'Формирую итоговый отчет');

        const finalReport = await this.callAgentStream(
          runId, chatId, 'orchestrator', orchestratorAgent, language,
          this.buildFinalReportPrompt(run, plan, spec, codeChanges, testResults, memoryUpdate, runMode, project, projectPath),
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
          this.logger.warn(`Final report JSON failed for run ${runId}; falling back to synthesized report: ${finalReport.error}`);
          finalReport.success = true;
          finalReport.artifact = this.buildFallbackFinalReport(run, runMode, spec, codeChanges, testResults, finalReport.rawResponse);
        }

        await this.broadcastActivity(runId, chatId, 'orchestrator', orchName, orchLabel, 'done', 'Работа завершена');

        // УСПЕХ — сохраняем и выходим из цикла
        run = await this.runRepo.findOne({ where: { id: runId } });
        if (run) {
          run.status = testResults.passed ? 'completed' : 'failed';
          run.finishedAt = new Date();
          const finalArtifact = this.normalizeFinalReportArtifact(
            ((finalReport.artifact as Record<string, unknown>) || { summary: finalReport.rawResponse }),
            run,
            runMode,
            spec,
            codeChanges,
            testResults,
          );
          run.finalReport = finalArtifact;
          await this.runRepo.save(run);
        }
        success = true;
        break;

      } catch (error) {
        // Пользователь остановил/приостановил работу между этапами — это НЕ
        // ошибка и НЕ повод для retry. status уже выставлен cancelRun/pauseRun
        // (cancelled/paused). Просто выходим из цикла ретраев без пометки failed.
        if (error instanceof RunCancelledError) {
          this.logger.log(`Run ${runId} stopped by user at attempt ${attempt}: ${error.message}`);
          success = true; // считаем «чистым выходом», чтобы не идти в финальный фейл-блок
          // Статус уже cancelled/paused — перечитываем и фиксируем finishedAt
          // только если cancelled (paused оставляем без finishedAt, чтобы resume
          // мог поднять).
          run = await this.runRepo.findOne({ where: { id: runId } });
          if (run && run.status === 'cancelled' && !run.finishedAt) {
            run.finishedAt = new Date();
            await this.runRepo.save(run);
          }
          break;
        }

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
    // Провайдер команды может быть не привязан — тогда берём текущий (активный).
    const provider = team?.provider ?? await this.providersService.getActive().catch(() => null);
    if (!provider || !provider.apiKey) {
      return { success: false, error: 'No provider configured — add one in Settings → Providers' };
    }
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

      // Для reasoning-моделей (o1, o3, gpt-5.x, DeepSeek-R1) используем
      // max_completion_tokens вместо max_tokens. С max_tokens reasoning-модель
      // может потратить ВСЕ токены на "мышление" (reasoning_content) и вернуть
      // пустой content — именно это вызывало "Empty or invalid response".
      // max_completion_tokens явно отделяет бюджет вывода от reasoning.
      const maxTokens = agent.maxTokens ?? Number(process.env.AGENT_MAX_TOKENS ?? 16000);
      const bodyObj: Record<string, unknown> = {
        model,
        temperature,
        stream: true,
        messages: [
          { role: 'system', content: systemContent },
          { role: 'user', content: prompt },
        ],
      };
      // reasoning-модели (gpt-5.x, o1, o3, deepseek-r1) требуют max_completion_tokens;
      // обычные модели (deepseek-v4, gpt-4, claude) используют max_tokens.
      // ВАЖНО: deepseek-v4-pro / deepseek-v4-flash — это НЕ reasoning-модели,
      // только deepseek-r1 является reasoning.
      const isReasoningModel = /gpt-5|o[1-4]|deepseek-r1/i.test(model);
      if (isReasoningModel) {
        bodyObj.max_completion_tokens = maxTokens;
      } else {
        bodyObj.max_tokens = maxTokens;
      }
      // reasoning_effort передаём только если задан в env — не все провайдеры
      // его поддерживают, и он может вызывать 400 ошибки.
      const reasoningEffort = process.env.LLM_REASONING_EFFORT;
      if (reasoningEffort && isReasoningModel) {
        bodyObj.reasoning_effort = reasoningEffort;
      }
      const requestBody = JSON.stringify(bodyObj);

      const response = await createLlmStreamRequest({
        url: `${provider.baseUrl.replace(/\/$/, '')}/chat/completions`,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${provider.apiKey}`,
        },
        body: requestBody,
        logger: this.logger,
        requestKey: `${provider.id}:${model}`,
        onRetry: async ({ attempt, maxAttempts, delayMs, reason, status }) => {
          const waitSec = Math.max(1, Math.round(delayMs / 1000));
          await this.broadcastActivity(
            runId,
            chatId,
            stepName,
            agent.name ?? stepName,
            agent.label ?? stepName,
            'working',
            status === 429
              ? `Уперся в rate limit, жду ${waitSec}с и повторяю (${attempt}/${maxAttempts})`
              : `Временная ошибка провайдера (${reason}), повторю через ${waitSec}с (${attempt}/${maxAttempts})`,
          );
        },
      });

      let fullContent = '';
      let reasoningContent = '';  // reasoning-модели (o1, o3, gpt-5.x) отдают "мышление" отдельно
      let totalUsage: any = null;
      let finishReason: string | undefined;
      // Буфер для диагностики: храним сырые SSE-события, чтобы при пустом
      // ответе понять, что именно вернул провайдер (ошибка, reasoning_content,
      // нестандартный формат и т.п.).
      const rawSseEvents: string[] = [];
      let streamHadError = false;
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

                // Диагностика: сохраняем первые N событий для анализа.
                if (rawSseEvents.length < 20) {
                  rawSseEvents.push(dataStr.slice(0, 500));
                }

                // Провайдер может вернуть ошибку прямо в SSE-стриме
                // (например {"error":{"message":"..."}}). Раньше это молча
                // проглатывалось — fullContent оставалась пустой, и мы не
                // знали почему. Теперь логируем.
                if (data.error) {
                  const errMsg = typeof data.error === 'string'
                    ? data.error
                    : data.error.message || JSON.stringify(data.error);
                  this.logger.warn(`Agent ${stepName} SSE error event: ${errMsg}`);
                  streamHadError = true;
                }

                const choice = data.choices?.[0];
                // Поддержка reasoning-моделей (o1, o3, gpt-5.x, DeepSeek-R1 и т.п.):
                // они отдают контент в reasoning_content, а не в content.
                // ВАЖНО: используем || вместо ??, т.к. content может быть ""
                // (пустая строка — не null/undefined), и ?? не пропустит к reasoning_content.
                const contentDelta = choice?.delta?.content;
                const reasoningDelta = choice?.delta?.reasoning_content;
                if (contentDelta) {
                  fullContent += contentDelta;
                  onToken(contentDelta);
                } else if (reasoningDelta) {
                  reasoningContent += reasoningDelta;
                  onToken(reasoningDelta);
                }
                if (choice?.finish_reason) finishReason = choice.finish_reason;
                if (data.usage) totalUsage = data.usage;
              } catch {
                // Логируем нестандартные SSE-строки для диагностики.
                const snippet = line.slice(0, 200);
                if (rawSseEvents.length < 20) {
                  rawSseEvents.push(`[unparsed] ${snippet}`);
                }
              }
            }
          }
        }
      } else {
        this.logger.warn(`Agent ${stepName}: response.body is null (no reader) for run ${runId}`);
      }

      // Финальный токен
      onToken('');

      // Fallback для reasoning-моделей: если content был пустой (модель отдала
      // всё через reasoning_content, как gpt-5-mini при некоторых промптах),
      // берём reasoningContent как основной ответ. Без этого developer-шаг
      // падал с "Empty or invalid response" — модель "думала", но "не отвечала".
      // ВАЖНО: для developer reasoningContent НЕ подходит как fallback — там
      // текст размышлений ("I'm trying to figure out..."), а не маркерный формат
      // (SUMMARY:/FILE:/PATCH_START). Парсинг всё равно упадёт, но с лишними
      // ретраями. Лучше сразу вернуть ошибку "empty content" — система сделает
      // retry с новым запросом, где модель, возможно, ответит в content.
      if (!fullContent && reasoningContent) {
        if (stepName === 'developer') {
          // Проверяем: возможно модель (reasoning-модель) положила структурированный
          // ответ (SUMMARY:/FILE:/PATCH_START) в reasoning_content вместо content.
          // Это бывает у o1/o3/gpt-5.x когда промпт содержит "respond only with JSON"
          // или маркерный формат — модель "думает" в reasoning и отвечает тоже там.
          const reasoningHasMarkers = /^[ \t]*(SUMMARY:|FILE:|PATCH_START|CONTENT_START)/m.test(reasoningContent);
          const reasoningHasJson = reasoningContent.trim().startsWith('{');
          if (reasoningHasMarkers || reasoningHasJson) {
            this.logger.log(`Agent ${stepName}: content was empty, but reasoningContent contains ${reasoningHasMarkers ? 'markers' : 'JSON'} — using it as response for run ${runId} (${reasoningContent.length} chars)`);
            fullContent = reasoningContent;
          } else {
            this.logger.warn(`Agent ${stepName}: content was empty, reasoningContent has ${reasoningContent.length} chars but it's reasoning text, not marker format — treating as empty for run ${runId}`);
            // НЕ присваиваем fullContent = reasoningContent для developer.
            // reasoningContent содержит размышления модели, а не SUMMARY:/FILE: формат.
            // Помечаем finishReason = 'length' если reasoning обрезан — это сигнал
            // что модель потратила все токены на "мышление" и не успела ответить.
            if (!finishReason) finishReason = 'reasoning_only';
          }
        } else {
          this.logger.log(`Agent ${stepName}: content was empty, using reasoningContent (${reasoningContent.length} chars) for run ${runId}`);
          fullContent = reasoningContent;
        }
      }

      // Диагностика пустого ответа: логируем сырые SSE-события, чтобы понять
      // что именно вернул провайдер. Без этого при пустом fullContent мы
      // видим только "Empty or invalid response" и не можем отладить.
      if (!fullContent) {
        this.logger.warn(
          `Agent ${stepName} returned empty content for run ${runId}. ` +
          `SSE events captured (${rawSseEvents.length}): ${rawSseEvents.join(' | ').slice(0, 2000)}` +
          (streamHadError ? ' [stream contained error events]' : '') +
          (finishReason ? ` [finish_reason=${finishReason}]` : ' [no finish_reason]') +
          (reader ? '' : ' [no reader — response.body was null]'),
        );
      }

      if (finishReason === 'length') {
        this.logger.warn(`Agent ${stepName} truncated by max_tokens (finish_reason=length) for run ${runId}; JSON may be incomplete. Consider raising AGENT_MAX_TOKENS or splitting the task.`);
      }

      // Парсим ответ агента. Для developer-шага ПРИОРИТЕТ — маркерный формат
      // (SUMMARY:/FILE:/PATCH_START/...), JSON только как fallback. Для остальных
      // шагов — сначала JSON, потом маркерный (если applicable).
      let parseResult: ParseJsonResult = { success: false, error: 'not attempted', rawResponse: fullContent };

      if (stepName === 'developer') {
        // 1) Маркерный формат (основной для developer)
        const markerResult = this.parseDeveloperMarkerFormat(fullContent);
        if (markerResult) {
          parseResult = { success: true, data: markerResult, rawResponse: fullContent };
        } else {
          // 2) JSON fallback (на случай если модель вернула JSON)
          parseResult = parseJsonSafely(fullContent);
          // 3) Ещё одна попытка — tryFixDeveloperJson
          if (!parseResult.success && fullContent) {
            const fixed = this.tryFixDeveloperJson(fullContent);
            if (fixed) {
              parseResult = { success: true, data: fixed, rawResponse: fullContent };
            }
          }
          // 4) NATURAL LANGUAGE FALLBACK: если модель ответила обычным текстом
          // (не маркеры, не JSON) — например "Я не могу завершить задачу, так как
          // предоставлен неполный код" — это НЕ парсинг-ошибка, а валидный ответ
          // агента "нет изменений". Без этого fallback 3 попытки тратятся на
          // ретраи, которые не изменят ответ модели. Лучше считать это "нет
          // изменений" с summary = текст модели.
          if (!parseResult.success && fullContent && fullContent.length > 20) {
            const hasMarkers = /^[ \t]*(SUMMARY:|FILE:|PATCH_START|CONTENT_START)/m.test(fullContent);
            const looksLikeJson = fullContent.trim().startsWith('{');
            if (!hasMarkers && !looksLikeJson) {
              this.logger.log(`Agent ${stepName}: returned natural language (no markers/JSON), treating as "no changes" for run ${runId}: ${fullContent.slice(0, 200)}`);
              parseResult = {
                success: true,
                data: { files: [], summary: fullContent.trim().slice(0, 2000) },
                rawResponse: fullContent,
              };
              // Показываем текст developer'а в чате как понятное сообщение,
              // а не как "пишет код". Без этого пользователь видит стрим
              // токенов (выглядит как "разработчик работает"), но не видит
              // реальный текст "Я не могу завершить задачу, т.к. предоставлен
              // неполный код". Теперь текст модели явно сохраняется в чат.
              try {
                await this.broadcastActivity(
                  runId, chatId, stepName,
                  agent.name ?? stepName, agent.label ?? stepName,
                  'working',
                  `Ответ без правок: ${fullContent.trim().slice(0, 500)}`,
                );
              } catch { /* не критично */ }
            }
          }
        }
      } else {
        parseResult = parseJsonSafely(fullContent);

        // NATURAL LANGUAGE FALLBACK для analyst/reviewer/tester:
        // Модель может вернуть текст вместо JSON (особенно слабые модели,
        // или когда reasoning-модель кладёт ответ в reasoning_content).
        // Без этого fallback 3 попытки тратятся на ретраи, которые не
        // изменят ответ модели. Лучше считать это валидным ответом и
        // извлечь из текста то, что можем.
        if (!parseResult.success && fullContent && fullContent.length > 20) {
          const looksLikeJson = fullContent.trim().startsWith('{') || fullContent.trim().startsWith('[');
          if (!looksLikeJson) {
            const naturalFallback = this.buildNaturalLanguageFallback(stepName, fullContent);
            if (naturalFallback) {
              this.logger.log(`Agent ${stepName}: returned natural language (no JSON), extracting fallback for run ${runId}: ${fullContent.slice(0, 200)}`);
              parseResult = { success: true, data: naturalFallback, rawResponse: fullContent };
            }
          }
        }
      }
      
      // Дамп ответа агента на диск — чисто отладочный, по умолчанию выключен.
      // Эти artifacts/<role>.json никто не читает: рантайм и контроллер
      // ходят только в runs/<id>/final-report.json. Чтобы не плодить мусор
      // (и не коммитить его в репо), дамп пишем только при SAVE_AGENT_ARTIFACTS=1.
      if (process.env.SAVE_AGENT_ARTIFACTS === '1') {
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
      }

      
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
        if (parsed.plan && (parsed.assignments || parsed.roles)) {
          return parsed;
        }
      }
    } catch { }
    return null;
  }

  private normalizeExecutionPlan(
    rawPlan: Record<string, unknown>,
    task: string,
    runMode: RunMode,
    teamConfig: TeamConfig,
  ): NormalizedExecutionPlan {
    const rawAssignments = (rawPlan.assignments && typeof rawPlan.assignments === 'object')
      ? (rawPlan.assignments as Record<string, unknown>)
      : {};
    const rawRoles = (rawPlan.roles && typeof rawPlan.roles === 'object')
      ? (rawPlan.roles as Record<string, unknown>)
      : {};
    const steps = Array.isArray(rawPlan.plan)
      ? rawPlan.plan.map((item) => String(item).trim()).filter(Boolean)
      : [];

    const testingCommands = Array.isArray(teamConfig.testing?.commands)
      ? teamConfig.testing?.commands.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : [];
    const explicitRoleRequest = this.detectExplicitRoleRequest(task);
    const wantsVerificationPass = /\b(подтверд|подтвержд|верифиц|перепроверь|вторая проверка|second opinion|double-check|validate|verify)\b/i.test(task);
    const wantsOnlyOpinion = /\b(мнение|opinion|что думаешь|what do you think|оцени|evaluate|compare)\b/i.test(task);

    const resolveRole = (
      role: ExecutionRole,
      fallbackAssignment: string,
      fallbackEnabled: boolean,
      fallbackReason: string,
    ): RoleExecutionPlan => {
      const rolePayload = rawRoles[role];
      const assignment = String(rawAssignments[role] ?? fallbackAssignment).trim() || fallbackAssignment;

      if (rolePayload && typeof rolePayload === 'object') {
        const payload = rolePayload as Record<string, unknown>;
        const enabled = typeof payload.enabled === 'boolean' ? payload.enabled : fallbackEnabled;
        return {
          enabled,
          assignment: String(payload.assignment ?? assignment).trim() || assignment,
          reason: String(payload.reason ?? fallbackReason).trim() || fallbackReason,
        };
      }

      return {
        enabled: fallbackEnabled,
        assignment,
        reason: fallbackReason,
      };
    };

    const isResearch = runMode === 'research';
    const isDiagnostics = runMode === 'diagnostics';
    const defaultAnalystEnabled =
      isDiagnostics
      || isResearch
      || /\b(исслед|проанализ|разбер|найд|root cause|investigat|analy[sz]e|diagnos)/i.test(task)
      || steps.some((step) => /анализ|диагноз|исслед|research|spec|design/i.test(step));
    const defaultDeveloperEnabled =
      runMode === 'implementation'
      && !/\b(документ|описан|список|summary|plan only)\b/i.test(task);
    const defaultTesterEnabled =
      (defaultDeveloperEnabled && testingCommands.length > 0)
      || /\b(тест|проверь|validate|verify|check)\b/i.test(task)
      || steps.some((step) => /тест|провер|validate|verify|check/i.test(step));

    const defaultReviewerEnabled =
      runMode === 'implementation'
      && /\b(ревью|review|проверь код|code review|посмотри код|прочитай код)\b/i.test(task);

    const roles: Record<ExecutionRole, RoleExecutionPlan> = {
      analyst: resolveRole(
        'analyst',
        isDiagnostics || isResearch
          ? 'Изучить код, локализовать причину и дать конкретный диагноз по реальным файлам.'
          : 'Разобрать задачу по коду и подготовить точечное ТЗ только по нужным изменениям.',
        defaultAnalystEnabled,
        defaultAnalystEnabled ? 'Нужен анализ кода и формализация решения.' : 'Задача достаточно определена, отдельный анализ не обязателен.',
      ),
      developer: resolveRole(
        'developer',
        isDiagnostics
          ? 'НЕ вносить правок в код. Только подтвердить выводы аналитика. Вернуть SUMMARY: Нет изменений.'
          : 'Внести точечные изменения по подтверждённому плану, не переписывая лишние файлы.',
        defaultDeveloperEnabled,
        defaultDeveloperEnabled ? 'Нужны реальные изменения в проекте.' : 'Код менять не требуется.',
      ),
      reviewer: resolveRole(
        'reviewer',
        'Провести code review изменений разработчика: проверить стили, потенциальные баги, архитектурные риски.',
        defaultReviewerEnabled,
        defaultReviewerEnabled ? 'Запрошен code review изменений.' : 'Code review не запрошен явно.',
      ),
      tester: resolveRole(
        'tester',
        isDiagnostics
          ? 'Проверить состоятельность диагноза и подтвердить, что он объясняет наблюдаемое поведение.'
          : testingCommands.length
              ? `Проверить изменения и опереться на команды: ${testingCommands.join(', ')}`
              : 'Проверить изменения статически и отметить риски.',
        defaultTesterEnabled,
        defaultTesterEnabled ? 'Нужна верификация результата.' : 'Отдельная проверка сейчас не добавит сигнала.',
      ),
    };

    if (isDiagnostics) {
      roles.developer.enabled = explicitRoleRequest === 'developer' || wantsVerificationPass;
      roles.developer.assignment = roles.developer.enabled
        ? 'НЕ вносить правок в код. Только подтвердить выводы аналитика. Вернуть SUMMARY: Нет изменений.'
        : '';
      roles.developer.reason = roles.developer.enabled
        ? 'Пользователь явно просит инженерную сверку без правок.'
        : 'Диагностика по умолчанию ограничена аналитиком; разработчик не нужен без прямого запроса на сверку.';
      roles.tester.enabled = explicitRoleRequest === 'tester' || wantsVerificationPass;
      roles.tester.assignment = roles.tester.enabled
        ? 'Проверить состоятельность диагноза и подтвердить, что он объясняет наблюдаемое поведение.'
        : '';
      roles.tester.reason = roles.tester.enabled
        ? 'Пользователь явно просит дополнительную верификацию диагноза.'
        : 'Отдельная верификация не нужна, пока пользователь прямо её не просил.';
    }

    if (isResearch) {
      const allowDeveloperOpinion = explicitRoleRequest === 'developer';
      const allowTesterOpinion = explicitRoleRequest === 'tester';
      const allowAnalystOpinion = explicitRoleRequest === 'analyst' || !explicitRoleRequest;
      roles.analyst.enabled = allowAnalystOpinion;
      roles.analyst.assignment = allowAnalystOpinion
        ? (wantsOnlyOpinion
            ? 'Изучить код и дать мнение строго по запросу, без новых задач и без правок.'
            : 'Изучить код и дать точный ответ строго по запросу, без новых задач и без правок.')
        : '';
      roles.analyst.reason = allowAnalystOpinion
        ? 'Исследовательская задача по умолчанию решается аналитиком.'
        : 'Пользователь попросил мнение другой роли.';
      roles.developer.enabled = allowDeveloperOpinion;
      roles.developer.assignment = allowDeveloperOpinion
        ? 'Изучить код и дать инженерное мнение строго по запросу. Никаких правок, файлов и дополнительных задач.'
        : '';
      roles.developer.reason = allowDeveloperOpinion
        ? 'Пользователь явно попросил мнение разработчика.'
        : 'Это исследовательская задача: разработчик не нужен без явной просьбы о его мнении.';
      roles.tester.enabled = allowTesterOpinion;
      roles.tester.assignment = allowTesterOpinion
        ? 'Изучить код и дать мнение тестировщика строго по запросу. Никаких правок, файлов и дополнительных задач.'
        : '';
      roles.tester.reason = allowTesterOpinion
        ? 'Пользователь явно попросил мнение тестировщика.'
        : 'Это исследовательская задача: тестировщик не нужен без явной просьбы о его мнении.';
    }

    if (!roles.analyst.enabled && !roles.developer.enabled && !roles.tester.enabled) {
      roles.analyst.enabled = true;
      roles.analyst.reason = 'Хотя бы один агент должен проверить задачу на содержательность.';
    }

    const normalizedFiles = Array.isArray(rawPlan.files)
      ? rawPlan.files.filter((item): item is { path?: string; action?: string; description?: string; reason?: string } => !!item && typeof item === 'object')
      : undefined;

    return {
      message: String(rawPlan.message ?? '').trim() || 'План работы сформирован.',
      executionTask: String(rawPlan.executionTask ?? task).trim() || task,
      plan: steps,
      roles,
      files: normalizedFiles,
    };
  }

  private describeExecutionPlan(plan: NormalizedExecutionPlan): string {
    const activeRoles = (Object.entries(plan.roles) as Array<[ExecutionRole, RoleExecutionPlan]>)
      .filter(([, rolePlan]) => rolePlan.enabled)
      .map(([role]) => this.roleLabel(role));

    if (!activeRoles.length) {
      return 'План готов, но активных ролей не выбрано.';
    }

    return `План готов. Подключаю: ${activeRoles.join(', ')}.`;
  }

  private roleLabel(role: ExecutionRole): string {
    if (role === 'analyst') return 'аналитика';
    if (role === 'developer') return 'разработчика';
    if (role === 'reviewer') return 'ревьюера';
    return 'тестировщика';
  }

  private buildFallbackSpecFromPlan(
    plan: NormalizedExecutionPlan,
    runMode: RunMode,
  ): Record<string, unknown> {
    if (runMode === 'diagnostics' || runMode === 'research') {
      return {
        feature: plan.executionTask,
        description: plan.message,
        diagnosis: [],
        rootCause: '',
        recommendations: [],
        risks: [],
      };
    }

    return {
      feature: plan.executionTask,
      description: plan.message,
      requirements: plan.plan,
      files: Array.isArray(plan.files) ? plan.files : [],
      acceptanceCriteria: [],
      risks: [],
    };
  }

  private buildAnalystStatus(plan: NormalizedExecutionPlan, runMode: RunMode): string {
    if (runMode === 'research') return 'Изучаю код и готовлю ответ строго по запросу без лишних действий';
    if (runMode === 'diagnostics') return 'Изучаю код и собираю точный диагноз';
    return plan.roles.developer.enabled ? 'Изучаю код и готовлю точечное ТЗ' : 'Изучаю код и формирую краткий разбор задачи';
  }

  private buildAnalystDoneStatus(plan: NormalizedExecutionPlan, runMode: RunMode): string {
    if (runMode === 'research') return 'Исследование готово';
    if (runMode === 'diagnostics') return 'Диагноз готов';
    return plan.roles.developer.enabled ? 'ТЗ готово' : 'Разбор задачи готов';
  }

  private buildDeveloperStatus(plan: NormalizedExecutionPlan, runMode: RunMode): string {
    if (runMode === 'research') return 'Готовлю инженерное мнение без правок кода';
    if (runMode === 'diagnostics') return 'Сверяю выводы аналитика без правок кода';
    if (!plan.roles.analyst.enabled) return 'Выполняю задачу напрямую по плану оркестратора';
    return 'Начинаю реализацию по подтверждённому ТЗ';
  }

  private buildDeveloperDoneStatus(
    plan: NormalizedExecutionPlan,
    runMode: RunMode,
    codeChanges: Record<string, unknown>,
  ): string {
    if (runMode === 'research') return 'Инженерное мнение готово';
    if (runMode === 'diagnostics') return 'Диагноз подтверждён, код не трогал';
    const files = Array.isArray((codeChanges as any)?.appliedFiles)
      ? (codeChanges as any).appliedFiles.length
      : Array.isArray((codeChanges as any)?.files)
        ? (codeChanges as any).files.length
        : 0;
    return files > 0 ? `Подготовил изменения по ${files} файл(ам)` : 'Проверил задачу, правки не понадобились';
  }

  private buildTesterStatus(plan: NormalizedExecutionPlan, runMode: RunMode): string {
    if (runMode === 'research') return 'Готовлю мнение тестировщика без запуска тестов';
    if (runMode === 'diagnostics') return 'Проверяю состоятельность диагноза';
    if (plan.roles.developer.enabled) return 'Проверяю изменения и риски';
    return 'Проверяю решение оркестратора без правок кода';
  }

  private buildTesterDoneStatus(plan: NormalizedExecutionPlan, runMode: RunMode): string {
    if (runMode === 'research') return 'Мнение тестировщика готово';
    if (runMode === 'diagnostics') return 'Диагноз подтверждён';
    if (plan.roles.developer.enabled) return 'Проверка завершена';
    return 'Сверка завершена';
  }

  private detectExplicitRoleRequest(task: string): ExecutionRole | null {
    const t = String(task || '').toLowerCase();
    if (!t.trim()) return null;
    if (/\b(мнение аналитика|спроси аналитика|аналитик считает|analyst opinion|ask the analyst)\b/i.test(t)) return 'analyst';
    if (/\b(мнение разработчика|спроси разработчика|разработчик считает|developer opinion|ask the developer|engineering opinion)\b/i.test(t)) return 'developer';
    if (/\b(мнение тестировщика|спроси тестировщика|тестировщик считает|tester opinion|qa opinion|ask the tester|ask qa)\b/i.test(t)) return 'tester';
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

  private parseAgentCommandRequests(text: string): Array<{ command: string; cwd?: string; reason?: string }> {
    const normalized = String(text || '').replace(/\r\n/g, '\n');
    const commands: Array<{ command: string; cwd?: string; reason?: string }> = [];
    const regex = /COMMAND:\s*(.+?)(?:\nCWD:\s*(.+?))?(?:\nREASON:\s*(.+?))?(?=\nCOMMAND:|\nFILE:|\nSUMMARY:|$)/gms;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(normalized)) !== null) {
      const command = String(match[1] || '').trim();
      if (!command) continue;
      commands.push({
        command,
        cwd: String(match[2] || '').trim() || undefined,
        reason: String(match[3] || '').trim() || undefined,
      });
    }
    return commands;
  }

  private ensureArtifactDir(runId: string): void {
    // Артефакты API-процесса (диагностические дампы агентов) НЕ относятся к
    // проекту пользователя — храним в рабочей директории API-процесса.
    // process.cwd() в production = apps/api, это безопасно.
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
        type: (status === 'working' && (role === 'orchestrator' || role === 'analyst')) ? 'agent-brief' : 'agent-status',
        runId,
        agentRole: role,
        agentName: name,
        agentLabel: label,
        status,
        content: message,
        timestamp: new Date().toISOString(),
      });
      this.logger.log(`Saved agent activity to chat: ${role} - ${message}`);
    } catch (error) {
      this.logger.warn(`Failed to save agent activity to chat: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Делегат к общей библиотеке path-utils.
   * Все агенты используют единую логику нормализации путей.
   */
  private relPathWithinProject(projectPath: string, relOrAbs: string): string {
    return relPathWithinProject(projectPath, relOrAbs, fs.existsSync.bind(fs));
  }

  private buildShellErrorSummary(output: string): string {
    return String(output || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 6)
      .join(' | ')
      .slice(0, 700);
  }

  private shouldRetryWithShell(command: string): boolean {
    const normalized = String(command || '').trim();
    if (!normalized) return false;
    if (/[;&]/.test(normalized)) return false;
    if (/[|><$`]/.test(normalized)) return false;
    if (!/["']/.test(normalized)) return false;
    return /\s/.test(normalized);
  }

  private summarizeTesterIssues(testResults: TestResult): string[] {
    const problems: string[] = [];
    if (Array.isArray(testResults.errors)) {
      for (const error of testResults.errors) {
        const text = String(error || '').trim();
        if (text) problems.push(text);
      }
    }
    if (Array.isArray(testResults.tests)) {
      for (const test of testResults.tests) {
        if (test?.success) continue;
        const label = String(test?.name || test?.command || 'Команда тестировщика').trim();
        const output = this.buildShellErrorSummary(String(test?.output || ''));
        problems.push(`${label}: ${output || 'команда завершилась с ошибкой'}`);
      }
    }
    return problems.slice(0, 6);
  }

  private decideTesterRework(runMode: RunMode, testResults: TestResult, codeChanges: Record<string, unknown>): ReworkDecision {
    if (runMode !== 'implementation') {
      return { shouldRework: false, reason: 'Не implementation-режим.' };
    }
    if (testResults.passed !== false) {
      return { shouldRework: false, reason: 'Тестер не нашёл блокирующих проблем.' };
    }
    const appliedFiles = Array.isArray((codeChanges as any)?.appliedFiles)
      ? (codeChanges as any).appliedFiles.filter(Boolean)
      : [];
    if (!appliedFiles.length) {
      return { shouldRework: false, reason: 'Нет реально применённых файлов.' };
    }
    const issues = this.summarizeTesterIssues(testResults);
    if (!issues.length) {
      return { shouldRework: false, reason: 'Нет конкретных замечаний тестера.' };
    }
    return { shouldRework: true, reason: issues.join('\n') };
  }

  private buildDeveloperReworkPrompt(
    run: Run,
    project: any,
    projectPath: string,
    codeChanges: Record<string, unknown>,
    testResults: TestResult,
  ): string {
    const appliedFiles = Array.isArray((codeChanges as any)?.appliedFiles)
      ? (codeChanges as any).appliedFiles.map((file: any) => String(file || '').trim()).filter(Boolean)
      : [];
    const issues = this.summarizeTesterIssues(testResults);
    const existingFiles = appliedFiles
      .map((file: string) => {
        const body = this.readFileForContext(projectPath, file, 12000);
        return body ? `\n===== ${file} (ТЕКУЩЕЕ СОДЕРЖИМОЕ) =====\n${body}\n` : '';
      })
      .filter(Boolean)
      .join('\n');

    return `Ты — Разработчик. После твоих правок тестировщик нашёл проблемы. Нужно исправить именно их.

ПРОЕКТ: ${project.name || 'Unknown'}
РАБОЧАЯ ДИРЕКТОРИЯ: ${projectPath}
ИСХОДНАЯ ЗАДАЧА: ${run.task}

РЕАЛЬНО ИЗМЕНЁННЫЕ ФАЙЛЫ:
${appliedFiles.length ? appliedFiles.map((file: string) => `- ${file}`).join('\n') : '- нет'}

ЗАМЕЧАНИЯ ТЕСТИРОВЩИКА:
${issues.length ? issues.map((item) => `- ${item}`).join('\n') : '- нет'}

ТЕКУЩИЙ КОД:
${existingFiles || '(код файлов недоступен)'}

Верни ответ только в маркерном формате:

SUMMARY: кратко что исправил

FILE: путь/к/файлу
ACTION: update
DESCRIPTION: что исправлено
PATCH_START
SEARCH:
<точный фрагмент текущего кода>
REPLACE:
<исправленный фрагмент>
PATCH_END

Если правки не нужны — верни только SUMMARY: Нет изменений.`;
  }

  private async applyFileChange(
    projectPath: string,
    fileChange: { path: string; action: string; content?: string; description?: string; patches?: Array<{ search: string; replace: string }> },
    applyChanges = true,
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      if (isUrlLikePath(fileChange.path)) {
        return { ok: false, error: `URL-подобный путь от агента: ${fileChange.path}` };
      }
      const relPath = this.relPathWithinProject(projectPath, fileChange.path);
      if (!relPath) return { ok: true };
      if (hasSuspiciousMirroredPath(relPath)) {
        return { ok: false, error: `Подозрительный нормализованный путь: ${relPath}` };
      }
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
        // Защита: если модель вернула ACTION: create для существующего файла —
        // принудительно конвертируем в update. Без этого developer перезаписывает
        // весь файл CONTENT_START/CONTENT_END, теряя существующий код.
        if (fileChange.action === 'create' && fs.existsSync(fullPath)) {
          this.logger.warn(`applyFileChange: action=create for existing file ${relPath}, forcing to update`);
          fileChange.action = 'update';
        }
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

  private async executeCommandWithApproval(
    runId: string,
    chatId: string,
    role: ExecutionRole,
    name: string,
    label: string,
    command: string,
    cwd: string,
    title: string,
    description: string,
    teamConfig: TeamConfig,
  ): Promise<{ success: boolean; output: string; code: number | null; approved: boolean }> {
    // СЕРВЕРНАЯ БЛОКИРОВКА git-команд записи.
    // Агенты НИКОГДА не должны коммитить, пушить или добавлять файлы в staging.
    // Это разрушительные операции — пользователь сам решает, когда коммитить.
    // Блокируем на уровне сервера, независимо от того, что попросит модель.
    const normalizedCmd = String(command || '').trim();
    if (normalizedCmd) {
      const blockedPatterns = [
        /\bgit\s+commit\b/i,
        /\bgit\s+push\b/i,
        /\bgit\s+add\b/i,
        /\bgit\s+rm\b/i,
        /\bgit\s+tag\b/i,
        /\bgit\s+reset\s+--hard\b/i,
        /\brm\s+-rf\b/i,
        /\bsudo\b/i,
        /\bchmod\s+777\b/i,
        /\bchown\b/i,
      ];
      for (const pattern of blockedPatterns) {
        if (pattern.test(normalizedCmd)) {
          const blockMsg = `Blocked destructive command: "${normalizedCmd.slice(0, 200)}". Команды git commit/push/add, а также rm -rf, sudo, chmod 777, chown запрещены на серверном уровне. Используйте только команды чтения (grep, ls, git log, git status, npm test, npm run build и т.д.).`;
          this.logger.warn(`[run ${runId}] ${blockMsg}`);
          await this.broadcastActivity(runId, chatId, role, name, label, 'error', blockMsg);
          await this.appendRunEvent(runId, 'command:blocked', { role, agentName: name, label, command, cwd, reason: 'destructive command blocked', title });
          return { success: false, output: blockMsg, code: 1, approved: false };
        }
      }
    }

    if (teamConfig.run?.requireApprovalForCommands !== false) {
      const approval = await this.requestApproval(runId, chatId, role, name, label, {
        kind: 'command',
        role,
        title,
        description,
        command,
        cwd,
      });
      if (!approval.approved) {
        return { success: false, output: 'Command was not approved', code: null, approved: false };
      }
    }

    await this.appendRunEvent(runId, 'command:started', { role, agentName: name, label, command, cwd, title });
    try {
      const output = execSync(command, {
        cwd,
        encoding: 'utf-8',
        timeout: 120000,
        maxBuffer: 1024 * 1024 * 4,
        shell: '/bin/zsh',
      }).toString();
      await this.appendRunEvent(runId, 'command:finished', { role, agentName: name, label, command, cwd, success: true, code: 0, output: output.slice(0, 4000) });
      return { success: true, output, code: 0, approved: true };
    } catch (error: any) {
      const output = String(error?.stdout || error?.stderr || error?.message || 'Command failed');
      const code = typeof error?.status === 'number' ? error.status : 1;
      if (this.shouldRetryWithShell(command)) {
        try {
          const escaped = command.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
          const retried = execSync(`/bin/zsh -lc "${escaped}"`, {
            cwd,
            encoding: 'utf-8',
            timeout: 120000,
            maxBuffer: 1024 * 1024 * 4,
            shell: '/bin/zsh',
          }).toString();
          await this.appendRunEvent(runId, 'command:finished', { role, agentName: name, label, command, cwd, success: true, code: 0, output: retried.slice(0, 4000), retriedWithShell: true });
          return { success: true, output: retried, code: 0, approved: true };
        } catch (retryError: any) {
          const retryOutput = String(retryError?.stdout || retryError?.stderr || retryError?.message || output || 'Command failed');
          const retryCode = typeof retryError?.status === 'number' ? retryError.status : code;
          await this.appendRunEvent(runId, 'command:finished', { role, agentName: name, label, command, cwd, success: false, code: retryCode, output: retryOutput.slice(0, 4000), retriedWithShell: true });
          return { success: false, output: retryOutput, code: retryCode, approved: true };
        }
      }
      await this.appendRunEvent(runId, 'command:finished', { role, agentName: name, label, command, cwd, success: false, code, output: output.slice(0, 4000) });
      return { success: false, output, code, approved: true };
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
      const diffStat = run('git diff --stat --no-color');
      const diffStatCached = run('git diff --cached --stat --no-color');
      const parts: string[] = [];
      if (branch) parts.push(`Ветка: ${branch}`);
      if (log) parts.push(`Последние коммиты (git log --oneline -n 15):\n${log}`);
      if (status) parts.push(`Незакоммиченные изменения (git status --short):\n${status || '(рабочее дерево чистое)'}`);
      if (diffStat) parts.push(`Diff unstaged (git diff --stat):\n${diffStat}`);
      if (diffStatCached) parts.push(`Diff staged (git diff --cached --stat):\n${diffStatCached}`);
      // Последние 5 изменённых файлов — показываем агентам, что недавно менялось,
      // чтобы они понимали «горячие» зоны проекта и не пытались «починить»
      // уже исправленный файл или наоборот не трогали стабильный код.
      const recentFiles = run('git diff --name-only HEAD~5..HEAD 2>/dev/null || git diff --name-only HEAD~3..HEAD 2>/dev/null || echo ""');
      if (recentFiles) parts.push(`Недавно изменённые файлы (последние 5 коммитов):\n${recentFiles}`);
      return parts.length ? parts.join('\n\n') : '';
    } catch {
      return '';
    }
  }

  /**
   * Строит компактный индекс проекта: список релевантных файлов с размерами
   * + короткое дерево директорий + архитектурные метки + зависимости.
   * Даёт агентам "карту" проекта, чтобы они не выдумывали пути и не
   * сериализовали всё подряд. Без этого слабые модели фантазируют структуру
   * и тратят токены на несуществующие файлы.
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

  /**
   * Выбирает топ-K файлов из карты проекта, релевантных задаче, и читает их
   * содержимое. Это даёт исследовательским агентам (research/analyst) РЕАЛЬНЫЙ
   * код для ответа, а не только список имён. Раньше на «оцени архитектуру
   * без кода» модель получала пустой контекст (оркестратор не называл файлов
   * в plan.files) и галлюцинировала. Теперь мы заранее подгружаем самые
   * релевантные файлы по эвристике: совпадение слов из задачи с путём +
   * предпочтение исходникам + штраф за размер (не читать огромные файлы).
   */
  private buildRelevantFileContext(
    projectPath: string,
    workspace: any,
    task: string,
    maxFiles = 8,
    maxCharsPerFile = 6000,
  ): string {
    try {
      if (!projectPath || !fs.existsSync(projectPath)) return '';
      const ignoreDirs = new Set(Array.isArray(workspace?.ignoreDirs) ? workspace.ignoreDirs : ['.git', 'node_modules', 'dist', 'build']);
      const includeExts = Array.isArray(workspace?.includeExtensions) && workspace.includeExtensions.length
        ? new Set(workspace.includeExtensions)
        : null;
      // Код-расширения приоритетнее документации/конфигов при равенстве счёта.
      const codeExts = new Set(['.ts', '.tsx', '.js', '.jsx', '.vue', '.py', '.php', '.go', '.rs', '.java', '.cs', '.rb']);

      // Извлекаем значимые слова из задачи (длина >= 4, не стоп-слова).
      const stop = new Set(['this', 'that', 'with', 'from', 'have', 'your', 'please', 'которые', 'который', 'чтобы', 'этого', 'этот', 'этом', 'проверьте', 'сделай', 'сделайте', 'почему', 'что-то']);
      const words = String(task || '')
        .toLowerCase()
        .split(/[^a-zа-я0-9_]+/i)
        .map(w => w.trim())
        .filter(w => w.length >= 4 && !stop.has(w));
      const wordSet = new Set(words);

      const collected: Array<{ rel: string; size: number; score: number }> = [];
      const walk = (absDir: string, relDir: string, depth: number) => {
        if (depth > 6) return;
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(absDir, { withFileTypes: true });
        } catch {
          return;
        }
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
              if (stat.size > 200000) continue; // пропускаем огромные файлы (минификации, лок-файлы и т.п.)
              const lower = rel.toLowerCase();
              let score = 0;
              for (const w of wordSet) {
                if (lower.includes(w)) score += 3;
              }
              const ext = path.extname(entry.name).toLowerCase();
              if (codeExts.has(ext)) score += 1;
              // Лёгкий буст «основным» файлам модулей (service/controller/entity).
              if (/(service|controller|entity|module|gateway|store|model|aggregate|view)\./i.test(lower)) score += 1;
              // Штраф за размер — предпочитаем читаемые файлы.
              score -= Math.min(2, Math.floor(stat.size / 30000));
              if (score > 0) collected.push({ rel, size: stat.size, score });
            } catch { }
          }
        }
      };
      walk(projectPath, '', 0);

      collected.sort((a, b) => b.score - a.score);
      const top = collected.slice(0, maxFiles);
      if (!top.length) return '';

      let out = '';
      for (const f of top) {
        const body = this.readFileForContext(projectPath, f.rel, maxCharsPerFile);
        if (body) out += `\n--- ${f.rel} (текущее содержимое) ---\n${body}\n`;
      }
      return out.trim();
    } catch {
      return '';
    }
  }

  /**
   * Pre-flight валидация SEARCH-блоков разработчика: для каждого update-файла
   * с patches[] проверяем, что каждый search-фрагмент РЕАЛЬНО присутствует в
   * текущем содержимом файла. Возвращаем список рассинхронов, чтобы закрыть
   * цикл обратной связи — подсунуть разработчику его же «промахи» и попросить
   * исправленные патчи. Без этого плохой SEARCH тихо скипается в applyFileChange
   * (просто warn в лог) — разработчик об этом не узнает и правка не попадёт.
   */
  private validateDeveloperPatches(
    projectPath: string,
    codeChanges: Record<string, unknown>,
  ): Array<{ file: string; index: number; searchPreview: string; currentPreview: string }> {
    const problems: Array<{ file: string; index: number; searchPreview: string; currentPreview: string }> = [];
    try {
      const files = Array.isArray((codeChanges as any)?.files) ? (codeChanges as any).files : [];
      for (const f of files) {
        const p = (f as any)?.path;
        const action = (f as any)?.action;
        const patches = Array.isArray((f as any)?.patches) ? (f as any).patches : [];
        if (typeof p !== 'string' || action !== 'update' || !patches.length) continue;
        const rel = this.relPathWithinProject(projectPath, p);
        if (!rel) continue;
        const fullPath = path.join(projectPath, rel);
        if (!fs.existsSync(fullPath)) {
          // update несуществующего файла — это тоже проблема (нужен create).
          problems.push({
            file: p,
            index: -1,
            searchPreview: '(файл не существует — нужен ACTION: create, а не update)',
            currentPreview: '(файл отсутствует на диске)',
          });
          continue;
        }
        const current = fs.readFileSync(fullPath, 'utf-8');
        patches.forEach((patch: any, idx: number) => {
          if (typeof patch?.search !== 'string') return;
          if (!current.includes(patch.search)) {
            problems.push({
              file: p,
              index: idx,
              searchPreview: patch.search.slice(0, 240),
              currentPreview: current.slice(0, 600),
            });
          }
        });
      }
    } catch {
      // ошибки валидации не должны ронять run — просто нет фидбека
    }
    return problems;
  }

  /**
   * Промпт корректирующего раунда для разработчика: показывает ему его же
   * SEARCH-блоки, которые НЕ найдены в текущем коде, + реальное текущее
   * содержимое файлов, и просит выдать ИСПРАВЛЕННЫЕ патчи в том же маркерном
   * формате. Это замыкает цикл самопроверки: модель видит свой «промах» и
   * текущий код глазами, а не только намерение.
   */
  private buildDeveloperSelfCheckPrompt(
    run: Run,
    spec: any,
    project: any,
    projectPath: string,
    problems: Array<{ file: string; index: number; searchPreview: string; currentPreview: string }>,
  ): string {
    const fileList = problems.map((pr, i) => {
      const head = pr.index < 0
        ? `ФАЙЛ ${i + 1}: ${pr.file}\nПРОБЛЕМА: ${pr.searchPreview}`
        : `ФАЙЛ ${i + 1}: ${pr.file} (патч #${pr.index + 1})\nSEARCH (не найден в текущем коде):\n${pr.searchPreview}`;
      return `${head}\nРЕАЛЬНОЕ ТЕКУЩЕЕ НАЧАЛО ФАЙЛА:\n${pr.currentPreview}`;
    }).join('\n\n');

    return `Ты — Разработчик. САМОПРОВЕРКА. Твой предыдущий ответ содержал SEARCH-блоки, которые НЕ найдены в реальном текущем коде файлов. Значит, ты скопировал SEARCH неточно (или опирался на выдуманный код). Перепиши ТОЛЬКО проблемные патчи, взяв SEARCH строго из РЕАЛЬНОГО текущего кода ниже.

ПРОЕКТ: ${project.name || 'Unknown'}
ЗАДАЧА: ${run.task}

ПРОБЛЕМНЫЕ ФАЙЛЫ (${problems.length}):
${fileList}

ОТВЕТ (строго маркерный формат, только проблемные файлы):

SUMMARY: Исправил SEARCH-блоки по реальному коду

FILE: <путь>
ACTION: update
DESCRIPTION: Исправленный патч
PATCH_START
SEARCH:
<ТОЧНЫЙ фрагмент из РЕАЛЬНОГО ТЕКУЩЕГО кода выше — скопируй буквально>
REPLACE:
<новый фрагмент>
PATCH_END

ПРАВИЛА (КРИТИЧНО):
1. SEARCH бери ТОЛЬКО из «РЕАЛЬНОГО ТЕКУЩЕГО НАЧАЛО ФАЙЛА» — копируй буквально, с теми же отступами и переносами.
2. Возвращай ТОЛЬКО проблемные файлы. Не повторяй файлы, где SEARCH был найден.
3. Не оборачивай в JSON, не используй markdown-блоки.
4. Если понял, что правка не нужна — верни SUMMARY: Нет изменений (без блоков FILE).
5. Никаких .md/README/документации — только код.`;
  }


  // ──────────────────────────────────────────────────────────────────
  // REVIEWER helpers
  // ──────────────────────────────────────────────────────────────────

  private buildReviewerStatus(plan: NormalizedExecutionPlan, runMode: RunMode): string {
    if (runMode === 'research') return 'Проверяю инженерное мнение разработчика';
    if (runMode === 'diagnostics') return 'Проверяю диагноз разработчика';
    return 'Провожу code review изменений разработчика';
  }

  private buildReviewerDoneStatus(
    plan: NormalizedExecutionPlan,
    runMode: RunMode,
    reviewArtifact: Record<string, unknown>,
  ): string {
    const files = Array.isArray((reviewArtifact as any)?.files) ? (reviewArtifact as any).files.length : 0;
    const findings = Array.isArray((reviewArtifact as any)?.findings) ? (reviewArtifact as any).findings.length : 0;
    if (runMode === 'research') return findings > 0 ? `Ревью: ${findings} замечание(й)` : 'Ревью инженерного мнения готово';
    if (runMode === 'diagnostics') return findings > 0 ? `Ревью: ${findings} замечание(й)` : 'Ревью диагноза готово';
    return files > 0 ? `Ревью: ${files} исправление(й), ${findings} замечание(й)` : findings > 0 ? `Ревью: ${findings} замечание(й)` : 'Ревью завершено, замечаний нет';
  }

  private buildReviewerPrompt(
    run: Run,
    codeChanges: Record<string, unknown>,
    project: any,
    workspace: any,
    projectPath: string,
    runMode: RunMode,
    plan: NormalizedExecutionPlan,
  ): string {
    const assignment = plan.roles.reviewer?.assignment || 'Провести code review';
    const filesChanged = Array.isArray((codeChanges as any)?.appliedFiles)
      ? (codeChanges as any).appliedFiles.map((file: any) => ({ path: String(file || '').trim(), action: 'applied', description: 'Файл успешно изменён' }))
      : Array.isArray((codeChanges as any)?.files)
        ? (codeChanges as any).files
        : [];
    const filesSummary = filesChanged.length
      ? filesChanged.map((f: any) => `- ${f.path} (${f.action}): ${f.description || '—'}`).join('\n')
      : 'нет изменений';
    const modeLine = runMode === 'research'
      ? 'РЕЖИМ: исследование. Ревьюер проверяет инженерное мнение разработчика на полноту и корректность.'
      : runMode === 'diagnostics'
        ? 'РЕЖИМ: диагностика. Ревьюер проверяет, что выводы разработчика по диагнозу корректны.'
        : 'РЕЖИМ: реализация. Ревьюер проверяет изменения кода на баги, стиль и архитектурные риски.';

    return `Ты — Ревьюер (Code Review). Проведи ревью результатов работы разработчика.

ПРОЕКТ: ${project.name || 'Unknown'}
РАБОЧАЯ ДИРЕКТОРИЯ: ${projectPath}
ЗАДАЧА: ${run.task}
${modeLine}
НАЗНАЧЕНИЕ: ${assignment}

ИЗМЕНЕНИЯ РАЗРАБОТЧИКА (codeChanges):
${JSON.stringify(codeChanges, null, 2)}

СПИСОК ИЗМЕНЁННЫХ ФАЙЛОВ:
${filesSummary}

Твоя задача — найти проблемы в изменениях разработчика: баги, нарушения стиля, архитектурные риски, несогласованности. Если проблем нет — верни findings:[], files:[]. Если есть критичные проблемы — верни исправленные патчи (SEARCH/REPLACE) в files[].

ПРАВИЛА (КРИТИЧНО):
1. ВЕРНИ ТОЛЬКО ОДИН ВАЛИДНЫЙ JSON. Никакого markdown, никакого текста вне { }.
2. В findings[] перечисли конкретные замечания (severity: info|warning|critical).
3. В files[] верни ИСПРАВЛЕННЫЕ патчи (SEARCH/REPLACE) — только для критичных проблем.
4. Если всё хорошо — {"summary":"Ревью завершено, замечаний нет.","findings":[],"files":[]}.
5. Не трогай файлы, которые не менял разработчик.
6. В research/diagnostics ревьюер только проверяет корректность выводов, НЕ генерирует код.

Схема:
{"summary":"string","findings":[{"file":"string","severity":"info|warning|critical","message":"string"}],"files":[{"path":"string","action":"update","description":"string","patches":[{"search":"string","replace":"string"}]}]}

ПРИМЕР (есть критичная проблема):
{"summary":"Найдена критичная проблема: неправильная обработка null.","findings":[{"file":"apps/api/src/modules/chats/chats.service.ts","severity":"critical","message":"Не проверяется chat.chat на null перед обращением к projectId"}],"files":[{"path":"apps/api/src/modules/chats/chats.service.ts","action":"update","description":"Добавить null-check","patches":[{"search":"const projectId = chat.chat.projectId","replace":"const projectId = chat.chat?.projectId ?? ''"}]}]}

ПРИМЕР (всё хорошо):
{"summary":"Ревью завершено, критичных замечаний нет.","findings":[],"files":[]}

Если вернёшь невалидный JSON — запуск упадёт.`;
  }

  /**
   * Парсит маркерный формат ответа ревьюера: SUMMARY + FINDINGS + FILE/PATCH.
   * Ревьюер использует тот же маркерный формат, что и разработчик, но с
   * дополнительным блоком FINDINGS.
   */
  private parseReviewerMarkerFormat(text: string): Record<string, unknown> | null {
    try {
      if (!text || typeof text !== 'string') return null;

      const summaryMatch = text.match(/^[ \t]*SUMMARY:[ \t]*(.+?)$/m);
      const summary = summaryMatch ? summaryMatch[1].trim() : '';

      // FINDINGS-блок
      const findingsMatch = text.match(/^[ \t]*FINDINGS:[ \t]*$/m);
      const findings: Array<{ file: string; severity: string; message: string }> = [];
      if (findingsMatch) {
        const afterFindings = text.slice(text.indexOf(findingsMatch[0]) + findingsMatch[0].length);
        const endIdx = afterFindings.search(/^[ \t]*(FILE:|SUMMARY:|$)/m);
        const findingsBlock = endIdx >= 0 ? afterFindings.slice(0, endIdx) : afterFindings;
        for (const line of findingsBlock.split('\n')) {
          const m = line.match(/^\s*-\s*\[?(info|warning|critical)\]?\s*([^:]+?):\s*(.+)$/i);
          if (m) findings.push({ file: m[2].trim(), severity: m[1].toLowerCase(), message: m[3].trim() });
        }
      }

      if (!/^[ \t]*FILE:/m.test(text)) {
        return { summary, findings, files: [] };
      }

      const files = this.parseDeveloperMarkerFormat(text)?.files || [];
      return { summary, findings, files };
    } catch {
      return null;
    }
  }

  private async buildMemoryContext(projectId: string, task: string): Promise<string> {
    try {
      const entries = (await this.projectsService.searchMemory(projectId, task, 10))
        .filter((entry: any) => !this.isPrescriptiveMemoryEntry(entry))
        .slice(0, 6);
      if (!entries.length) return '';
      return entries.map((entry, index) => {
        const files = Array.isArray(entry.relatedFiles) && entry.relatedFiles.length
          ? `\nФайлы: ${entry.relatedFiles.join(', ')}`
          : '';
        const tags = Array.isArray(entry.tags) && entry.tags.length
          ? `\nТеги: ${entry.tags.join(', ')}`
          : '';
        return [
          `#${index + 1}. ${entry.title}`,
          `Сводка: ${entry.summary}`,
          entry.details ? `Детали:\n${entry.details}` : '',
          files,
          tags,
        ].filter(Boolean).join('\n');
      }).join('\n\n');
    } catch (error) {
      this.logger.warn(`Failed to build memory context: ${error instanceof Error ? error.message : String(error)}`);
      return '';
    }
  }

  private isPrescriptiveMemoryEntry(entry: any): boolean {
    const kind = String(entry?.kind || '').toLowerCase();
    const summary = String(entry?.summary || '');
    const details = String(entry?.details || '');
    const title = String(entry?.title || '');
    const text = `${title}\n${summary}\n${details}`.toLowerCase();

    if (!text.trim()) return false;
    if (kind !== 'implementation' && kind !== 'feature') return false;

    const imperativeScore = [
      'добавь ',
      'добавить ',
      'создай ',
      'создать ',
      'внеси ',
      'внести ',
      'убедись ',
      'нужно ',
      'проверь, есть ли',
      'если чего-то не хватает',
      'шаг 1',
      'шаг 2',
      'кнопка отправки',
      'const issending',
      'computed issenddisabled',
      'keydown',
      'aria-label',
      'tailwind',
      'npm run dev',
    ].reduce((score, token) => score + (text.includes(token) ? 1 : 0), 0);

    const hasCommandDump = /команды:\s|последний запуск:\s|тесты:\s/i.test(details);
    const looksLikeRecipe = imperativeScore >= 4 || hasCommandDump;
    return looksLikeRecipe;
  }

  private inferMemoryKind(memory: any, runMode?: RunMode): string {
    if (runMode === 'research') return 'research';
    if (runMode === 'diagnostics') return 'diagnostic';
    if (Array.isArray(memory?.requirements) && memory.requirements.length) return 'implementation';
    return 'feature';
  }

  private buildMemoryTags(memory: any, runMode?: RunMode): string[] {
    const tags = new Set<string>(['auto-generated', 'run', this.inferMemoryKind(memory, runMode)]);
    if (Array.isArray(memory?.tags)) {
      for (const tag of memory.tags) {
        const normalized = String(tag || '').trim().toLowerCase();
        if (normalized) tags.add(normalized);
      }
    }
    if (runMode === 'research') tags.add('analysis');
    if (runMode === 'diagnostics') tags.add('root-cause');
    if (memory?.feature) {
      for (const token of String(memory.feature).toLowerCase().split(/[\s,.;:!?()[\]{}"']+/).filter((item: string) => item.length > 3).slice(0, 6)) {
        tags.add(token);
      }
    }
    return Array.from(tags);
  }

  private async saveProjectMemory(projectId: string, chatId: string, memory: any, language: string, runMode?: RunMode, sourceRunId?: string): Promise<void> {
    try {
      const feature = memory.feature || memory.lastRun?.task || 'Выполнение задачи';
      const relatedFiles: string[] = this.normalizeMemoryRelatedFiles(
        Array.isArray(memory.lastRun?.codeChanges)
          ? memory.lastRun.codeChanges
          : Array.isArray(memory.files)
            ? (memory.files as Array<{ path?: string }>).map((f) => f.path).filter(Boolean)
            : [],
      );
      const hasSuspiciousPaths = relatedFiles.some((file) => /^apps\/api\/apps\//.test(file));
      const effectiveRunMode: RunMode | undefined = hasSuspiciousPaths && runMode === 'implementation'
        ? 'diagnostics'
        : runMode;
      const summaryText = String(
        memory.summary
        || memory.opinion
        || memory.rootCause
        || memory.description
        || feature,
      ).slice(0, 1000);

      // Если аналитик заполнил документацию (implementation-режим), сохраняем
      // структурированно в details + обогащаем summary.
      const doc = memory.documentation && typeof memory.documentation === 'object' ? memory.documentation : null;

      const detailLines: string[] = [];
      if (memory.description) detailLines.push(`Описание: ${memory.description}`);
      if (memory.opinion) detailLines.push(`Мнение: ${memory.opinion}`);

      // Структурированная документация проекта от аналитика — приоритетный источник знаний.
      // Сохраняем все поля, чтобы следующие run'ы видели архитектуру и не галлюцинировали.
      if (doc) {
        if (typeof doc.overview === 'string' && doc.overview.trim()) {
          detailLines.push(`--- ОБЗОР ПРОЕКТА ---\n${doc.overview.trim()}`);
        }
        if (typeof doc.architecture === 'string' && doc.architecture.trim()) {
          detailLines.push(`--- АРХИТЕКТУРА ---\n${doc.architecture.trim()}`);
        }
        if (Array.isArray(doc.components) && doc.components.length) {
          const compLines = doc.components.map((c: any) => {
            const deps = Array.isArray(c.dependencies) && c.dependencies.length
              ? ` (зависимости: ${c.dependencies.join(', ')})`
              : '';
            const api = Array.isArray(c.publicApi) && c.publicApi.length
              ? ` | API: ${c.publicApi.join(', ')}`
              : '';
            return `• ${c.name || '?'} [${c.path || '?'}] — ${c.responsibility || ''}${deps}${api}`;
          });
          detailLines.push(`--- КОМПОНЕНТЫ ---\n${compLines.join('\n')}`);
        }
        if (typeof doc.dataFlow === 'string' && doc.dataFlow.trim()) {
          detailLines.push(`--- ПОТОК ДАННЫХ ---\n${doc.dataFlow.trim()}`);
        }
        if (typeof doc.codePatterns === 'string' && doc.codePatterns.trim()) {
          detailLines.push(`--- ПАТТЕРНЫ КОДА ---\n${doc.codePatterns.trim()}`);
        }
      }
      if (Array.isArray(memory.requirements) && memory.requirements.length) {
        detailLines.push(`Требования: ${(memory.requirements as string[]).join('; ')}`);
      }
      if (Array.isArray(memory.acceptanceCriteria) && memory.acceptanceCriteria.length) {
        detailLines.push(`Критерии приёмки: ${(memory.acceptanceCriteria as string[]).join('; ')}`);
      }
      if (Array.isArray(memory.evidence) && memory.evidence.length) {
        detailLines.push(`Доказательства:\n${memory.evidence.map((item: any) => `- ${item.file || '?'}${item.location ? ` (${item.location})` : ''}: ${item.note || ''}`).join('\n')}`);
      }
      if (Array.isArray(memory.diagnosis) && memory.diagnosis.length) {
        detailLines.push(`Диагноз:\n${memory.diagnosis.map((item: any) => `- ${item.file || '?'}${item.location ? ` (${item.location})` : ''}: ${item.issue || item}`).join('\n')}`);
      }
      if (memory.rootCause) detailLines.push(`Главная причина: ${memory.rootCause}`);
      if (Array.isArray(memory.recommendations) && memory.recommendations.length) {
        detailLines.push(`Рекомендации: ${(memory.recommendations as string[]).join('; ')}`);
      }
      if (Array.isArray(memory.risks) && memory.risks.length) {
        detailLines.push(`Риски: ${(memory.risks as string[]).join('; ')}`);
      }
      if (memory.lastRun) {
        const status = memory.lastRun.status === 'success' ? 'успешно' : 'с ошибкой';
        detailLines.push(`Последний запуск: ${status} — ${memory.lastRun.task}`);
        if (memory.lastRun.testResults) {
          detailLines.push(`Тесты: ${memory.lastRun.testResults.passed ? 'пройдены' : 'провалены'}`);
        }
        if (Array.isArray(memory.lastRun.executedCommands) && memory.lastRun.executedCommands.length) {
          detailLines.push(`Команды: ${memory.lastRun.executedCommands.join('; ')}`);
        }
      }
      const detailsText = detailLines.join('\n') || `Language: ${language}`;

      await this.projectsService.saveMemory({
        projectId,
        title: `Документация: ${String(feature).slice(0, 180)}`,
        summary: summaryText,
        details: detailsText,
        kind: this.inferMemoryKind(memory, effectiveRunMode),
        tags: this.buildMemoryTags(memory, effectiveRunMode),
        relatedFiles,
        sourceRunId: sourceRunId ?? null,
        sourceChatId: chatId,
        relevanceScore: effectiveRunMode === 'research' ? 0.95 : effectiveRunMode === 'diagnostics' ? 0.9 : hasSuspiciousPaths ? 0.2 : 0.75,
      } as any);
    } catch (error) {
      this.logger.warn(`Failed to save project memory: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private normalizeMemoryRelatedFiles(rawFiles: unknown[]): string[] {
    if (!Array.isArray(rawFiles)) return [];
    const out: string[] = [];
    for (const raw of rawFiles) {
      const value = String(raw || '').replace(/\\/g, '/').trim();
      if (!value) continue;
      if (/^apps\/api\/apps\//.test(value)) continue;
      out.push(value);
    }
    return out;
  }

  private buildOrchestratorPrompt(run: Run, messages: any[], project: any, teamConfig: TeamConfig, projectPath: string, runMode: RunMode): string {
    const recentMessages = messages?.slice(-10).map(m => `${m.role}: ${m.content}`).join('\n') || 'Нет истории';
    const index = projectPath ? this.buildProjectIndex(projectPath, teamConfig.workspace, 50) : '';
    const gitContext = projectPath ? this.getGitContext(projectPath) : '';
    // Режим уже определён детерминированно в executeRunSteps. Сообщаем его
    // модели как ФАКТ (не вопрос) — она не должна «решать» заново. Раньше
    // слабая модель на этом шаге игнорила «код не пишите» и всё равно ставила
    // разрабу задачу кодить. Теперь режим зафиксирован в промпте явно.
    const modeLine = runMode === 'research'
      ? `РЕЖИМ: ИССЛЕДОВАНИЕ / МНЕНИЕ. Нужно только изучить, проанализировать или дать мнение по запросу. НИКАКИХ новых задач, НИКАКОГО расширения объёма, НИКАКИХ правок кода, если пользователь явно этого не просил.`
      : runMode === 'diagnostics'
        ? `РЕЖИМ: ДИАГНОСТИКА (только анализ, БЕЗ правок кода). Пользователь явно просил проверить/найти причину, НЕ писать код. Разработчик НЕ должен трогать файлы.`
        : `РЕЖИМ: РЕАЛИЗАЦИЯ (внести точечные правки в код).`;
    return `Ты — Оркестратор. Проанализируй задачу и создай план работы для команды.
 
⚠️ РАБОЧАЯ ДИРЕКТОРИЯ: ${projectPath}
Это КОРЕНЬ ПРОЕКТА. Все пути к файлам должны быть ОТНОСИТЕЛЬНЫМИ от этой директории.
В КАРТЕ ПРОЕКТА ниже пути УЖЕ относительные от ${projectPath} — используй их КАК ЕСТЬ, не добавляй префиксов.
КРИТИЧНО: НЕ добавляй к путям "${projectPath}" или любой другой префикс. Бери пути ТОЧНО как в КАРТЕ ПРОЕКТА.
ЗАПРЕЩЕНО: абсолютные пути, дублирование сегментов (типа apps/web/apps/web/...), префиксы чужого репозитория или текущего раннера.
 
ПРОЕКТ: ${project.name || 'Unknown'}
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
2. Запуск УЖЕ идёт — но зови ТОЛЬКО тех, кто реально нужен. Не включай роль ради ритуала.
3. РЕЖИМ уже задан выше — НЕ меняй его. В диагностике разработчик может быть только verifier без правок. В research-режиме нельзя самовольно включать разработчика или тестировщика.
4. НЕ выдумывай пути файлов — используй только КАРТУ ПРОЕКТА выше.
5. Если отдельный этап не нужен, явно отключи его через roles.<role>.enabled=false и кратко объясни why в reason.
6. НЕЛЬЗЯ расширять задачу. Отвечай только на прямой запрос пользователя. Не придумывай дополнительные подзадачи, проверки, рефакторы, улучшения или "следующие логичные шаги", если их не просили.
7. Для implementation НЕ превращай executionTask в микро-ТЗ с выдуманными именами функций, переменных, CSS-классов или готовыми кусками кода, если ты не видел их в реальном файле. Формулируй по наблюдаемому поведению и реальным путям файлов.
8. Если пользователь уже указал экран/URL/файл и желаемое поведение, executionTask должен быть коротким и предметным: цель, реальный файл/модуль, ограничения по области. Не расписывай пошагово "добавь const X" или "создай функцию Y", если это не подтверждено кодом.
9. ПУТИ В JSON-ОТВЕТЕ: бери пути ТОЧНО как в КАРТЕ ПРОЕКТА выше (например "apps/web/src/views/WorkspaceView.vue"). НЕ добавляй "${projectPath}" как префикс (не делай "apps/web/apps/web/src/..."). НЕ добавляй абсолютные пути (не делай "/Users/..."). Просто скопируй путь из карты.
 
Схема ответа:
{"message":"string - что ты понял и что сделает команда","teamSummary":["string"],"shouldExecute":true,"executionTask":"string - краткая задача для команды","plan":["string - шаги"],"roles":{"analyst":{"enabled":true,"assignment":"string","reason":"string"},"developer":{"enabled":true,"assignment":"string","reason":"string"},"tester":{"enabled":true,"assignment":"string","reason":"string"}},"files":[{"path":"string","action":"create|update","description":"string","reason":"string"}]}
 
ПРИМЕР (ДИАГНОСТИКА):
{"message":"Нужно локализовать причину и подтвердить её без правок.","teamSummary":["Alex: координирует","Mira: исследует код"],"shouldExecute":true,"executionTask":"Найти причину X, код не менять","plan":["Разобрать код","Проверить диагноз"],"roles":{"analyst":{"enabled":true,"assignment":"Изучить код и найти причину.","reason":"Без анализа нельзя назвать точную причину."},"developer":{"enabled":true,"assignment":"НЕ вносить правок в код. Только подтвердить выводы аналитика. Вернуть SUMMARY: Нет изменений.","reason":"Нужна техническая сверка без изменений файлов."},"tester":{"enabled":true,"assignment":"Проверить, что диагноз объясняет поведение.","reason":"Нужна независимая верификация вывода."}},"files":[{"path":"apps/api/src/modules/chats/chats.service.ts","action":"update","description":"Проверить участок с формированием payload","reason":"Вероятное место проблемы"}]}
 
ПРИМЕР (РЕАЛИЗАЦИЯ):
{"message":"Нужно быстро внести точечную правку и проверить её.","teamSummary":["Alex: координирует","Kai: меняет код"],"shouldExecute":true,"executionTask":"Исправить баг X в модуле Y","plan":["Подтвердить место правки","Изменить код","Проверить результат"],"roles":{"analyst":{"enabled":false,"assignment":"","reason":"Задача уже локализована в конкретном модуле."},"developer":{"enabled":true,"assignment":"Внести точечные правки по задаче.","reason":"Нужны реальные изменения в коде."},"tester":{"enabled":true,"assignment":"Проверить изменение статически и по тестовым командам.","reason":"Нужно подтвердить, что правка не ломает поведение."}},"files":[{"path":"apps/api/src/modules/runs/runs.service.ts","action":"update","description":"Исправить логику выбора ролей","reason":"Главная точка поведения"}]}
 
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
  private detectRunMode(task: string): RunMode {
    const t = String(task || '').toLowerCase();
    if (!t.trim()) return 'implementation';
    const researchKeywords = [
      'изучи', 'изучи', 'изучить', 'изучите',
      'ресерч', 'research',
      'проанализируй', 'проанализировать', 'анализни',
      'разбери', 'разобрать', 'посмотри',
      'дай мнение', 'нужно мнение', 'спроси мнение', 'мнение аналитика', 'мнение разработчика', 'мнение команды',
      'что думаешь', 'what do you think', 'opinion', 'review idea',
      'оцени идею', 'оцени подход', 'сравни варианты', 'compare options',
    ];
    const hasResearch = researchKeywords.some((k) => t.includes(k));
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
    // Research-паттерны приоритетнее общей фразы "только анализ": если
    // пользователь просит изучить/дать мнение/сделать ресерч, не надо
    // превращать это в диагностику с verifier-этапом разработчика.
    if (hasResearch) return 'research';
    if (hasDiag) return 'diagnostics';
    // Если задача сформулирована как вопрос («почему», «зачем», «как работает»)
    // и НЕ содержит глаголов изменения — тоже диагностика.
    const isQuestion = /\b(почему|зачем|как (работает|устроен)|отчего|due to|why)\b/.test(t);
    const isResearchQuestion = /\b(что думаешь|какое мнение|как лучше|какой вариант|стоит ли|what do you think|which option)\b/.test(t);
    const implVerbs = ['создай', 'создать', 'добавь', 'добавить', 'исправь', 'исправить', 'реализуй', 'реализовать', 'напиши', 'написать', 'сделай', 'сделать', 'обнови', 'обновить', 'удали', 'удалить', 'рефактор', 'create', 'add', 'fix', 'implement', 'write', 'make', 'update', 'delete', 'refactor'];
    const hasImpl = implVerbs.some((k) => t.includes(k));
    if (isResearchQuestion && !hasImpl) return 'research';
    if (isQuestion && !hasImpl) return 'diagnostics';
    return 'implementation';
  }

  private buildAnalystPrompt(run: Run, plan: NormalizedExecutionPlan, project: any, messages: any[], projectPath: string, workspace: any, runMode: RunMode, memoryContext = ''): string {
    const index = projectPath ? this.buildProjectIndex(projectPath, workspace, 80) : '';
    const gitContext = projectPath ? this.getGitContext(projectPath) : '';
    // Подгружаем содержимое файлов, упомянутых оркестратором в плане (если он
    // назвал конкретные пути), чтобы аналитик опирался на реальный код, а не
    // фантазировал. Ограничиваем по размеру.
    let fileContext = '';
    try {
      const hinted = Array.isArray(plan.files) ? plan.files : [];
      const seen = new Set<string>();
      for (const t of hinted) {
        const p = (t as any)?.path;
        if (typeof p !== 'string' || seen.has(p)) continue;
        seen.add(p);
        const body = this.readFileForContext(projectPath, p, 6000);
        if (body) fileContext += `\n--- ${p} (текущее содержимое) ---\n${body}\n`;
      }
      // Если оркестратор НЕ назвал конкретные файлы (часто в research/diagnostics
      // «оцени архитектуру», «почему так»), аналитик оставался без реального
      // кода и галлюцинировал. Предзагружаем топ-K файлов по релевантности к
      // задаче — чтобы у аналитика были реальные исходники, а не только карта имён.
      if (!fileContext && projectPath) {
        const relevant = this.buildRelevantFileContext(projectPath, workspace, run.task, 8, 6000);
        if (relevant) fileContext = relevant;
      }
    } catch { }


    // В режиме диагностики аналитик НЕ выдаёт files[] — иначе разработчик
    // увидит файлы и начнёт их править (баг «разраб пишет код, хотя просили
    // только проверить»). Вместо этого аналитик возвращает diagnosis[] —
    // конкретные выводы: файл, функция, механизм проблемы.
    if (runMode === 'research') {
      return `Ты — Аналитик. РЕЖИМ: ИССЛЕДОВАНИЕ / МНЕНИЕ. Твоя задача — ответить СТРОГО на тот вопрос, который поставил пользователь. Никаких дополнительных задач, улучшений, проверок, рефакторов или скрытых рекомендаций сверх запроса.

ПРОЕКТ: ${project.name || 'Unknown'}
РАБОЧАЯ ДИРЕКТОРИЯ: ${projectPath}
ЗАДАЧА: ${run.task}
ПЛАН ОРКЕСТРАТОРА: ${JSON.stringify(plan, null, 2)}
НАЗНАЧЕНИЕ ДЛЯ ТЕБЯ: ${plan.roles.analyst.assignment}

КАРТА ПРОЕКТА:
${index}
${gitContext ? `\nGIT-КОНТЕКСТ:\n${gitContext}` : ''}
${fileContext ? `\nСУЩЕСТВУЮЩИЙ КОД:\n${fileContext}` : ''}
${memoryContext ? `\nПАМЯТЬ ПРОЕКТА ИЗ БД (используй это как готовую документацию и не дублируй заново без причины):\n${memoryContext}` : ''}

ПРАВИЛА (КРИТИЧНО):
1. Отвечай ТОЛЬКО на прямой запрос пользователя.
2. Не предлагай делать новые задачи, если пользователь об этом не просил.
3. Не расширяй область анализа за пределы вопроса.
4. Не возвращай files, patches, implementation plan или code changes.
5. ВЕРНИ ТОЛЬКО ОДИН ВАЛИДНЫЙ JSON.
6. АНТИ-ГАЛЛЮЦИНАЦИЯ: отчёт должен быть ПРО ПРОЕКТ "${project.name || 'Unknown'}". Запрещено описывать другой проект, другое имя или другой стек (React/Vue/Angular/Zustand/Pinia/Vite/Webpack и т.п.) — только то, что реально в КАРТЕ, GIT и ПАМЯТИ. Не выдумывай файлы/библиотеки/сторы, которых там нет. Если данных недостаточно — честно скажи, не придумывай.
7. Если пользователь просит напечатать/показать документ или отчёт (например, «напечатай architecture-report.md») — найди его в ПАМЯТЬ ПРОЕКТА выше и приведи РЕАЛЬНЫЙ текст в поле "opinion" или "description". Если документа в памяти нет — честно скажи, что он не найден, НЕ выдумывай содержимое и не подставляй другой проект.

Схема:
{"feature":"string","description":"string - прямой ответ по сути запроса","opinion":"string - мнение или вывод по запросу","evidence":[{"file":"string","location":"string","note":"string"}],"risks":["string"],"recommendations":["string - только если прямо следуют из запроса, без новых задач"]}

Если вернёшь невалидный JSON — запуск упадёт.`;
    }

    if (runMode === 'diagnostics') {
      return `Ты — Аналитик. Проведи ДИАГНОСТИКУ кода проекта и найди причину. РЕЖИМ: только анализ, БЕЗ правок кода.

ПРОЕКТ: ${project.name || 'Unknown'}
РАБОЧАЯ ДИРЕКТОРИЯ: ${projectPath}
ЗАДАЧА: ${run.task}
ПЛАН ОРКЕСТРАТОРА: ${JSON.stringify(plan, null, 2)}
НАЗНАЧЕНИЕ ДЛЯ ТЕБЯ: ${plan.roles.analyst.assignment}

КАРТА ПРОЕКТА:
${index}
${gitContext ? `\nGIT-КОНТЕКСТ (актуальный, серверный — НЕ создавай файлы для git log/diff, он уже здесь):\n${gitContext}` : ''}
${fileContext ? `\nСУЩЕСТВУЮЩИЙ КОД (опирайся на него, не придумывай структуру):\n${fileContext}` : ''}
${memoryContext ? `\nПАМЯТЬ ПРОЕКТА ИЗ БД:\n${memoryContext}` : ''}

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

    return `Ты — Аналитик. Напиши ТЗ для разработчика И ВЕДИ ДОКУМЕНТАЦИЮ ПРОЕКТА, опираясь на РЕАЛЬНЫЙ код проекта.

ПРОЕКТ: ${project.name || 'Unknown'}
РАБОЧАЯ ДИРЕКТОРИЯ: ${projectPath}
ЗАДАЧА: ${run.task}
ПЛАН ОРКЕСТРАТОРА: ${JSON.stringify(plan, null, 2)}
НАЗНАЧЕНИЕ ДЛЯ ТЕБЯ: ${plan.roles.analyst.assignment}

КАРТА ПРОЕКТА:
${index}
${gitContext ? `\nGIT-КОНТЕКСТ (актуальный, серверный — НЕ создавай файлы для git log/diff, он уже здесь):\n${gitContext}` : ''}
${fileContext ? `\nСУЩЕСТВУЮЩИЙ КОД (опирайся на него, не придумывай структуру):\n${fileContext}` : ''}
${memoryContext ? `\nПАМЯТЬ ПРОЕКТА ИЗ БД (существующая документация — дополни/уточни, НЕ дублируй):\n${memoryContext}` : ''}

У ТЕБЯ ДВЕ ЗАДАЧИ:
1. Написать точное ТЗ для разработчика (ЧТО менять и ГДЕ, только реальные пути).
2. ВЕСТИ ДОКУМЕНТАЦИЮ ПРОЕКТА в поле "documentation" — ОБЯЗАТЕЛЬНО заполни его. Эта документация будет доступна всем будущим запускам аналитика и оркестратора. Опиши структуру проекта, архитектуру, ключевые компоненты, API, поток данных — всё, что ты узнал из кода. Чем лучше документация сейчас, тем точнее будут следующие запуски.

ПРАВИЛА (КРИТИЧНО):
1. ВЕРНИ ТОЛЬКО ОДИН ВАЛИДНЫЙ JSON. Никакого markdown, никакого текста вне { }.
2. В files.path указывай ТОЛЬКО пути, которые есть в КАРТЕ ПРОЕКТА. Не выдумывай файлы.
3. Для существующих файлов ставь action:"update" (разработчик сделает патч), для новых — action:"create".
4. НЕ добавляй в files[] документацию, README, файлы .md/.mdx/.rst, файлы из docs/. Документация живёт в БД (поле documentation), а НЕ в файлах репозитория.
5. Описывай изменения СЕМАНТИЧЕСКИ по текущему коду. Если нужное поведение уже реализовано под другими именами, не требуй переименования ради совпадения со словами пользователя.
6. ПОЛЕ "documentation" ЗАПОЛНЯЙ ВСЕГДА — это твоя главная ценность как аналитика. Даже если задача маленькая, опиши контекст и затронутые компоненты. Следующий запуск аналитика увидит твою доку и не будет галлюцинировать.
7. Если в ПАМЯТИ ПРОЕКТА уже есть documentation по этим же файлам — ДОПОЛНИ и УТОЧНИ её, а не перезаписывай с нуля. Сохраняй полезное из старой документации.
8. В documentation.codePatterns опиши паттерны и соглашения, которые ты заметил в коде (формат имён, структура папок, принятые библиотеки, стиль). Это критично для разработчика.

Схема:
{
  "feature": "string — краткое название задачи",
  "description": "string — суть изменений для разработчика",
  "requirements": ["string — конкретные требования"],
  "api": {"endpoints": ["string — затронутые API-эндпоинты"]},
  "dataModels": ["string — затронутые модели данных"],
  "files": [
    {
      "path": "string — реальный путь из карты",
      "action": "create|update",
      "description": "string — что конкретно менять (семантически, НЕ код)",
      "reason": "string — почему это нужно"
    }
  ],
  "acceptanceCriteria": ["string — как проверить что сделано правильно"],
  "risks": ["string — возможные проблемы"],
  "documentation": {
    "overview": "string — общее описание проекта/модуля (стек, назначение, ключевые фичи)",
    "architecture": "string — архитектурный обзор (слои, модули, как они связаны)",
    "components": [
      {
        "name": "string — имя компонента/модуля/сервиса",
        "path": "string — путь к файлу/папке",
        "responsibility": "string — за что отвечает",
        "dependencies": ["string — от чего зависит"],
        "publicApi": ["string — экспортируемые функции/методы/компоненты"]
      }
    ],
    "dataFlow": "string — как данные проходят через систему (от запроса до ответа)",
    "codePatterns": "string — принятые паттерны и соглашения в коде (стиль имён, структура, библиотеки)"
  }
}

ПРИМЕР (сокращённый):
{
  "feature": "Добавить кнопку отправки в чат",
  "description": "В WorkspaceView.vue добавить кнопку отправки с блокировкой и обработку Enter/Shift+Enter",
  "requirements": ["Кнопка отправки disabled пока нет текста", "Enter отправляет", "Shift+Enter — перенос строки"],
  "files": [{"path": "apps/web/src/views/WorkspaceView.vue", "action": "update", "description": "Добавить кнопку отправки после textarea, привязать @keydown.enter", "reason": "Сейчас только textarea без кнопки"}],
  "acceptanceCriteria": ["Enter отправляет сообщение", "Shift+Enter делает перенос", "Пустой ввод не отправляется"],
  "documentation": {
    "overview": "Фронтенд на Vue 3 + TypeScript, чат в WorkspaceView.vue",
    "architecture": "Компоненты вьюх лежат в src/views/, API-клиент в src/api.ts, роутер в src/router.ts",
    "components": [
      {"name": "WorkspaceView", "path": "apps/web/src/views/WorkspaceView.vue", "responsibility": "Основной интерфейс чата с оркестратором", "dependencies": ["api.ts", "router.ts", "ws"], "publicApi": ["textarea ввода", "список сообщений", "селектор команды"]}
    ],
    "dataFlow": "Пользователь вводит текст → POST /chats/:id/messages → оркестратор → стрим ответа через WebSocket → отображение в чате",
    "codePatterns": "Vue 3 Composition API с <script setup>, Pinia не используется, API через fetch в api.ts"
  }
}

Если вернёшь невалидный JSON — запуск упадёт.`;
  }

  private buildDeveloperPrompt(run: Run, spec: any, project: any, workspace: any, projectPath: string, runMode: RunMode, memoryContext = ''): string {
    const ignoreDirs = Array.isArray(workspace.ignoreDirs) ? workspace.ignoreDirs.join(', ') : '';
    const filesList = (spec.files || []).map((f: any) => `- ${f.path}: ${f.action} — ${f.description}`).join('\n') || 'нет файлов';
    const requirements = (spec.requirements || []).map((r: any) => `- ${r}`).join('\n') || 'нет требований';
    const assignmentLine = spec.assignment ? `\nНАЗНАЧЕНИЕ ОРКЕСТРАТОРА:\n${spec.assignment}\n` : '';

    if (runMode === 'research') {
      // Раньше research-разработчик получал ТОЛЬКО имя проекта и задачу — без
      // карты/git/памяти. На «оцени архитектуру без кода» модель оставалась
      // без реального контекста и галлюцинировала ДРУГОЙ проект (React+Zustand
      // вместо Electron+Vue). Теперь даём реальные данные + анти-галлюцинацию.
      const index = projectPath ? this.buildProjectIndex(projectPath, workspace, 80) : '';
      const gitContext = projectPath ? this.getGitContext(projectPath) : '';
      const projectUnavailable = !index || /недоступн|нет файлов/i.test(index);
      // Раньше research-разработчик видел ТОЛЬКО карту имён. На «оцени
      // архитектуру» без реального кода модель галлюцинировала. Подгружаем
      // топ-K файлов по релевантности к задаче — даём РЕАЛЬНЫЙ код, с большим
      // лимитом символов для research (нужно место «подумать»).
      const relevantFiles = projectPath && !projectUnavailable
        ? this.buildRelevantFileContext(projectPath, workspace, run.task, 8, 10000)
        : '';
      return `Ты — Разработчик. РЕЖИМ: ИССЛЕДОВАНИЕ / МНЕНИЕ. Пользователь просит инженерную оценку, а НЕ правки кода.

ПРОЕКТ: ${project.name || 'Unknown'}
РАБОЧАЯ ДИРЕКТОРИЯ: ${projectPath}
ОПИСАНИЕ ПРОЕКТА: ${project.description || '(нет описания)'}
ЗАДАЧА: ${run.task}
${assignmentLine}

КАРТА ПРОЕКТА (реальные файлы — опирайся ТОЛЬКО на них):
${index || '(карта недоступна)'}
${gitContext ? `\nGIT-КОНТЕКСТ:\n${gitContext}` : ''}
${relevantFiles ? `\nРЕАЛЬНЫЙ КОД (топ релевантных файлов — читай и опирайся на него, не выдумывай):\n${relevantFiles}` : ''}
${memoryContext ? `\nПАМЯТЬ ПРОЕКТА ИЗ БД:\n${memoryContext}` : ''}


Твоя задача — дать инженерное мнение строго по вопросу пользователя, опираясь на РЕАЛЬНУЮ карту/git/память выше. Никаких изменений файлов, патчей, планов реализации и новых задач.

АНТИ-ГАЛЛЮЦИНАЦИЯ (КРИТИЧНО):
1. Отчёт должен быть ПРО ПРОЕКТ "${project.name || 'Unknown'}". Запрещено описывать другой проект, другое имя или другой стек (React/Vue/Angular/Zustand/Pinia/Vite/Webpack и т.п.) — только то, что реально видно в КАРТЕ, GIT и ПАМЯТИ.
2. Не выдумывай файлы, библиотеки, сторы, роуты, которых нет в карте/git/памяти.
3. ${projectUnavailable ? `ВНИМАНИЕ: код проекта НЕДОСТУПЕН (путь не существует или пуст). НЕ выдумывай архитектуру/стек. В SUMMARY честно напиши: "Не могу прочитать код проекта (путь ${projectPath} недоступен) — примонтируйте проект, тогда дам оценку."` : `Если данных недостаточно для ответа — так и скажи, не придумывай.`}

ОТВЕТ (строго так, одной строкой):

SUMMARY: <инженерное мнение по запросу, опираясь на реальные данные про "${project.name || 'Unknown'}">

ПРАВИЛА:
1. Никаких FILE:, PATCH_START, CONTENT_START и JSON.
2. Не придумывай follow-up задачи.
3. Не пиши про "нужно сделать" или "я бы ещё добавил", если пользователь этого не просил.
4. Верни только строку SUMMARY:.`;
    }

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
РАБОЧАЯ ДИРЕКТОРИЯ: ${projectPath}
ЗАДАЧА: ${run.task}
${assignmentLine}

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
РАБОЧАЯ ДИРЕКТОРИЯ: ${projectPath}
ЗАДАЧА: ${run.task}
${assignmentLine}

⚠️ Все пути к файлам должны быть ОТНОСИТЕЛЬНЫМИ от рабочей директории ${projectPath}.
Используй только реальные пути из ФАЙЛЫ ИЗ ТЗ и КАРТЫ ПРОЕКТА.
ЗАПРЕЩЕНО: абсолютные пути, дублирование сегментов, префиксы чужого репозитория или текущего раннера.

ТРЕБОВАНИЯ ИЗ ТЗ:
${requirements}

ФАЙЛЫ ИЗ ТЗ (что изменить/создать):
${filesList}
${existingFiles ? `\nСУЩЕСТВУЮЩИЙ КОД ФАЙЛОВ:\n${existingFiles}` : ''}

ВАЖНО: ИСПОЛЬЗУЙ МАРКЕРНЫЙ ФОРМАТ (НЕ JSON). В нём код пишется как есть между маркерами — НЕ нужно экранировать переносы строк и кавычки. JSON с кодом внутри "content" почти всегда ломается из-за экранирования. Маркерный формат надёжнее.

ФОРМАТ ОТВЕТА (строго так):

SUMMARY: краткая сводка что сделано

COMMAND: npm test
CWD: .
REASON: Нужно прогнать локальные тесты модуля после правок

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
2. Для ОБНОВЛЕНИЯ существующего файла используй ACTION: update + PATCH_START/SEARCH:/REPLACE:/PATCH_END. Скопируй точный фрагмент из текущего кода в SEARCH. Это сохраняет остальной legacy-код.
3. Для СОЗДАНИЯ НОВОГО файла (которого НЕТ в списке СУЩЕСТВУЮЩИЙ КОД ФАЙЛОВ выше) используй ACTION: create + CONTENT_START/CONTENT_END.
4. КРИТИЧНО: НЕ используй ACTION: create для файлов, которые УЖЕ ЕСТЬ в списке «СУЩЕСТВУЮЩИЙ КОД ФАЙЛОВ». Если файл существует — ты ОБЯЗАН использовать ACTION: update + PATCH_START/SEARCH:/REPLACE:. ACTION: create для существующего файла будет ОТКЛЁН. Если файл существует в списке выше, но ТЗ говорит «создай» — это означает «обнови», используй update.
5. Между маркерами пиши код КАК ЕСТЬ — реальные переносы строк и обычные кавычки, без \\n и без экранирования.
6. Если изменений не требуется — верни только SUMMARY: Нет изменений (без блоков FILE).
7. Маркеры FILE:, ACTION:, DESCRIPTION:, SUMMARY: — каждый с новой строки, без пробелов перед двоеточием.
8. Если для работы нужна консольная команда, добавь блок COMMAND/CWD/REASON. Не выдумывай результат команды, сервер выполнит её отдельно после подтверждения пользователя.
9. НЕ создавай .md/README/документационные файлы. Документацию проекта ведёт Аналитик в памяти проекта (БД), а не в репозитории. Создавай только КОД. Если в ТЗ есть .md — пропусти его.
10. НЕ создавай мусорные/временные/логовые/текстовые файлы: git_log_output.txt, scratch.txt, output_*.txt, *.log, *.tmp, *.out и подобные. git-контекст УЖЕ в промпте (сервер выполняет git log/status сам). Если нужно сохранить вывод — используй SUMMARY, а не файл. Все .txt/.log/.tmp пути будут отклонены.
11. Пиши пути ОТНОСИТЕЛЬНО корня проекта (например src/domain/dog/aggregates/Dog.ts), БЕЗ ведущего /host-projects/... и БЕЗ абсолютных путей. Абсолютные пути будут нормализованы.
12. САМОПРОВЕРКА ПЕРЕД ОТДАЧЕЙ (КРИТИЧНО): прежде чем вернуть ответ, мысленно перепрочитай КАЖДЫЙ свой SEARCH-блок и сверь с СУЩЕСТВУЮЩИМ КОДОМ выше. SEARCH должен быть БУКВАЛЬНОЙ копией фрагмента текущего файла (те же отступы, переносы, кавычки). Если SEARCH не совпадает с реальным кодом символ-в-символ — патч будет отклонён сервером. Проверь также: не сломал ли REPLACE импорты/синтаксис, нет ли дублей, согласованы ли call-сайты, если меняешь сигнатуру/экспорт. Если хоть один SEARCH вызывает сомнение — перепиши его по реальному коду. Сервер всё равно перепроверит каждый SEARCH по текущему файлу и вернёт тебе рассинхрон на исправление, но лучше сделать верно с первого раза.
13. Выполняй задачу по СМЫСЛУ, а не по буквальному совпадению имён из ТЗ/памяти. Если поведение уже есть под другими именами или в другой локальной структуре файла, не переписывай код ради косметического совпадения.
14. Если после чтения текущего файла видишь, что требуемое поведение уже реализовано и правки не нужны, верни только SUMMARY: Нет изменений.

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

  private buildTesterPrompt(
    run: Run,
    codeChanges: any,
    project: any,
    plan: NormalizedExecutionPlan,
    runMode: RunMode,
    testingCommands: string[],
    projectPath: string,
  ): string {
    const appliedFiles = Array.isArray((codeChanges as any)?.appliedFiles)
      ? (codeChanges as any).appliedFiles.map((file: any) => String(file || '').trim()).filter(Boolean)
      : [];
    const failedFiles = Array.isArray((codeChanges as any)?.failedFiles)
      ? (codeChanges as any).failedFiles
      : [];
    const modeLine = runMode === 'research'
      ? 'РЕЖИМ: исследование. Дай мнение тестировщика по вопросу пользователя без запуска тестов и без новых задач.'
      : runMode === 'diagnostics'
        ? 'РЕЖИМ: диагностика. Кода могло не быть вовсе — твоя задача подтвердить или опровергнуть сам диагноз.'
        : 'РЕЖИМ: реализация. Оцени изменения кода и риски.'
    ;
    return `Ты — Тестировщик. Проверь результат работы команды на корректность и предложи, какие реальные команды нужно выполнить.

ПРОЕКТ: ${project.name || 'Unknown'}
РАБОЧАЯ ДИРЕКТОРИЯ: ${projectPath}
${modeLine}
НАЗНАЧЕНИЕ ОРКЕСТРАТОРА: ${plan.roles.tester.assignment}
ИЗМЕНЕНИЯ: ${JSON.stringify(codeChanges, null, 2)}
РЕАЛЬНО ПРИМЕНЁННЫЕ ФАЙЛЫ: ${appliedFiles.length ? appliedFiles.join(', ') : 'нет'}
ОШИБКИ ПРИ ПРИМЕНЕНИИ: ${failedFiles.length ? JSON.stringify(failedFiles) : 'нет'}
КОМАНДЫ ПРОВЕРКИ: ${testingCommands.length ? testingCommands.join(', ') : 'не заданы'}

Твоя задача — понять, решает ли результат задачу, и предложить краткий набор реальных проверок. Команды выполняет сервер, не ты.

ПРАВИЛА (КРИТИЧНО):
1. ВЕРНИ ТОЛЬКО ОДИН ВАЛИДНЫЙ JSON. Никакого markdown, никакого текста вне { }.
2. Если изменений нет, но диагностический вывод выглядит убедительно — тоже passed:true.
3. В research-режиме дай краткое мнение в поле "summary" и не придумывай дополнительные проверки, если их не просили.
4. tests.command — это ЛЮБАЯ shell-команда, которую ты предлагаешь выполнить для проверки/исследования. Не ограничивайся списком КОМАНДЫ ПРОВЕРКИ (это лишь предпочтительные): можно grep/find/rg/ls/git/cat и т.п., если они нужны для ответа. Сервер попросит пользователя подтвердить каждую команду. Не ставь success:false «на всякий случай» — реальный success определит сервер после выполнения. Если команд не нужно — верни tests:[].
5. НЕ выдумывай результат команды в поле output — напиши ЧТО команда должна проверить, а не что она якобы вернёт. Сервер выполнит команду сам.
6. В research/диагностике: если нужно проверить наличие чего-то в коде (термин, файл, использование) — предлагай конкретную grep/rg команду с реальным путём проекта. Не сообщай об «ошибке ENOENT» как о провале — это просто «не найдено», пользователь видит реальный вывод.

Схема:
{"passed":boolean,"summary":"string","tests":[{"name":"string","command":"string","success":true,"output":"string - что именно эта команда должна проверить (НЕ выдумывай результат)"}],"errors":["string"]}

ПРИМЕР (всё ок):
{"passed":true,"summary":"Изменение выглядит целевым.","tests":[{"name":"API unit tests","command":"npm run test -w apps/api","success":true,"output":"Проверит, что API не сломался после правки"}],"errors":[]}

ПРИМЕР (research — проверка наличия термина в коде):
{"passed":true,"summary":"Предлагаю grep для проверки наличия функционала репликации пациента в бэкенде.","tests":[{"name":"Поиск термина репликации пациента","command":"grep -rn 'replica' /Users/evgenii/Работа/magendamd/magendamd_backend/app/src || echo 'НЕ НАЙДЕНО'","success":true,"output":"Проверит, есть ли вообще упоминания репликации пациента в бэкенде magendamd_backend"}],"errors":[]}

ПРИМЕР (есть ошибка):
{"passed":false,"summary":"Нужна дополнительная проверка edge cases.","tests":[{"name":"Web build","command":"npm run build -w apps/web","success":true,"output":"Проверит, что сборка фронта остаётся валидной"}],"errors":["Есть риск регрессии в отображении"]} 

Если команд не нужно — верни {"passed":true,"summary":"","tests":[],"errors":[]}.`;

  }

  private buildFinalReportPrompt(run: Run, plan: any, spec: any, codeChanges: any, testResults: any, memoryUpdate: any, runMode: RunMode, project: any = null, projectPath = ''): string {
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
    const modeDirective = runMode === 'research'
      ? `Это ИССЛЕДОВАТЕЛЬСКАЯ задача. Нужно дать только ответ по существу исходного вопроса пользователя. НЕЛЬЗЯ расширять задачу, придумывать новые поручения или описывать несделанные работы.`
      : runMode === 'diagnostics'
        ? `Это ДИАГНОСТИЧЕСКАЯ задача. Код НЕ изменялся (так и задумано). Итоговый отчёт — это ДИАГНОЗ: причину, конкретные файлы/функции, механизм проблемы и рекомендации.`
        : `Это задача на реализацию. Код уже изменён разработчиком и проверен тестером. Итоговый отчёт — что реально сделано.`;

    return `Ты — Оркестратор. Работа команды УЖЕ завершена. Напиши ИТОГОВЫЙ ОТЧЁТ пользователю — РЕЗУЛЬТАТ, а НЕ повтор плана.

ЗАДАЧА: ${run.task}
${modeDirective}
ПРОЕКТ: ${project?.name || 'Unknown'}
РАБОЧАЯ ДИРЕКТОРИЯ: ${projectPath}

АНТИ-ГАЛЛЮЦИНАЦИЯ (КРИТИЧНО): Итоговый отчёт должен быть ПРО ПРОЕКТ "${project?.name || 'Unknown'}". Запрещено описывать другой проект, другое имя или другой стек технологий (React/Vue/Angular/Zustand/Pinia/Vite и т.п.). Опирайся ТОЛЬКО на diagnosis/spec/codeChanges выше — это результаты работы с реальным кодом проекта "${project?.name || 'Unknown'}". Если в diagnosis/spec пусто — честно скажи, что данных недостаточно, НЕ выдумывай архитектуру/стек/файлы.
ПЛАН (только для контекста, НЕ повторяй его в отчёте): ${JSON.stringify(plan, null, 2)}
ТЗ/ДИАГНОЗ АНАЛИТИКА: ${JSON.stringify(spec, null, 2)}
ИЗМЕНЕНИЯ КОДА: ${JSON.stringify(codeChanges, null, 2)}
ТЕСТЫ: ${JSON.stringify(testResults, null, 2)}
${diagnosisText ? `\nДИАГНОЗ АНАЛИТИКА (опирайся на это в сообщении):\n${diagnosisText}` : ''}${rootCause}

КРИТИЧНО:
1. "message" — это ОТВЕТ ПОЛЬЗОВАТЕЛЮ на его вопрос/задачу. НЕ начинай с "Понял задачу" или "Назначу". Не повторяй план. Работа уже сделана.
2. В режиме ИССЛЕДОВАНИЯ в "message" дай только прямой ответ/мнение/анализ по запросу пользователя. Без расширения задачи. Без "ещё стоит сделать". Без новых поручений команде.
3. В режиме ДИАГНОСТИКИ в "message" изложи конкретную причину проблемы (файлы, функции, механизм) и рекомендации — это и есть ответ, который ждёт пользователь.
4. В режиме РЕАЛИЗАЦИИ в "message" кратко напиши, что реально изменено и результат тестов.
5. ВЕРНИ ТОЛЬКО валидный JSON, без markdown и текста вне { }.

Схема:
{
  "message": "string - итоговый ответ пользователю (РЕЗУЛЬТАТ, не план)",
  "summary": "string - краткая сводка в одно-два предложения",
  "filesChanged": ["string - реальные пути изменённых файлов, если есть"],
  "testResult": "passed|failed",
  "diagnosis": ["string - пункты диагноза, только для диагностического режима"],
  "nextSteps": ["string"]
}

ДОПОЛНИТЕЛЬНО:
- Если пользователь НЕ просил следующие шаги, "nextSteps" верни как [].
- В research/diagnostics не придумывай новые поручения команде.
- Если сомневаешься в JSON, верни минимальный валидный объект по схеме выше.`;
  }

  private shouldIncludeNextSteps(task: string): boolean {
    const t = String(task || '').toLowerCase();
    if (!t.trim()) return false;
    return /\b(следующ|next steps|что дальше|what next|дальше|roadmap|план действий|action items)\b/i.test(t);
  }

  /**
   * Natural language fallback для analyst/reviewer/tester.
   * Когда модель возвращает текст вместо JSON, извлекаем из текста
   * минимальную структуру, достаточную для продолжения конвейера.
   * Без этого 3 попытки тратятся на ретраи, которые не изменят ответ модели.
   */
  private buildNaturalLanguageFallback(stepName: string, text: string): Record<string, unknown> | null {
    if (!text || text.length < 20) return null;
    const trimmed = text.trim();

    if (stepName === 'analyst') {
      // Аналитик вернул текст вместо JSON — оборачиваем в минимальную структуру spec.
      return {
        feature: 'Анализ (из текстового ответа)',
        description: trimmed.slice(0, 3000),
        requirements: [],
        files: [],
        diagnosis: [],
        rootCause: '',
        recommendations: [],
        risks: [],
      };
    }

    if (stepName === 'reviewer') {
      return {
        summary: trimmed.slice(0, 2000),
        findings: [],
        files: [],
      };
    }

    if (stepName === 'tester') {
      return {
        passed: true,
        summary: trimmed.slice(0, 2000),
        tests: [],
        errors: [],
      };
    }

    if (stepName === 'orchestrator') {
      // Для оркестратора есть extractPlanFromText — не дублируем.
      return null;
    }

    // Неизвестный шаг — не извлекаем.
    return null;
  }

  private buildFallbackFinalReport(
    run: Run,
    runMode: RunMode,
    spec: Record<string, unknown>,
    codeChanges: Record<string, unknown>,
    testResults: TestResult,
    rawResponse?: string,
  ): Record<string, unknown> {
    const filesChanged = Array.isArray((codeChanges as any)?.appliedFiles)
      ? (codeChanges as any).appliedFiles.map((file: any) => String(file || '').trim()).filter(Boolean)
      : [];
    const failedFiles = Array.isArray((codeChanges as any)?.failedFiles)
      ? (codeChanges as any).failedFiles as Array<{ path?: string; error?: string }>
      : [];
    const testResult = testResults?.passed === false || failedFiles.length > 0 ? 'failed' : 'passed';
    const cleanedMessage = String(rawResponse || '').replace(/```[\s\S]*?```/g, '').trim();
    const fallbackMessage = runMode === 'research'
      ? String((spec as any)?.opinion || (spec as any)?.description || (codeChanges as any)?.summary || (testResults as any)?.summary || 'Исследование завершено.')
      : runMode === 'diagnostics'
        ? String((spec as any)?.rootCause || (spec as any)?.description || 'Диагностика завершена.')
        : failedFiles.length > 0
          ? `Изменения не были применены. Ошибки: ${failedFiles.map((item) => `${item.path}: ${item.error}`).join('; ')}`
          : String(cleanedMessage || (codeChanges as any)?.summary || 'Работа завершена.');
    const artifact: Record<string, unknown> = {
      mode: runMode,
      message: cleanedMessage || fallbackMessage,
      summary: String((spec as any)?.description || (codeChanges as any)?.summary || (testResults as any)?.summary || fallbackMessage),
      filesChanged,
      testResult,
      nextSteps: this.shouldIncludeNextSteps(run.task) ? [] : [],
    };
    if (runMode === 'diagnostics') {
      artifact.diagnosis = Array.isArray((spec as any)?.diagnosis) ? (spec as any).diagnosis : [];
      artifact.rootCause = (spec as any)?.rootCause || '';
      artifact.recommendations = Array.isArray((spec as any)?.recommendations) ? (spec as any).recommendations : [];
    }
    return artifact;
  }

  private normalizeFinalReportArtifact(
    artifact: Record<string, unknown>,
    run: Run,
    runMode: RunMode,
    spec: Record<string, unknown>,
    codeChanges: Record<string, unknown>,
    testResults: TestResult,
  ): Record<string, unknown> {
    const normalized = { ...artifact } as Record<string, unknown>;
    const appliedFiles = Array.isArray((codeChanges as any)?.appliedFiles)
      ? (codeChanges as any).appliedFiles.map((file: any) => String(file || '').trim()).filter(Boolean)
      : [];
    normalized.mode = runMode;
    if (!normalized.message || !String(normalized.message).trim()) {
      normalized.message = this.buildFallbackFinalReport(run, runMode, spec, codeChanges, testResults).message;
    }
    if (!normalized.summary || !String(normalized.summary).trim()) {
      normalized.summary = String((spec as any)?.description || (codeChanges as any)?.summary || (testResults as any)?.summary || normalized.message || '');
    }
    normalized.filesChanged = appliedFiles;
    const failedFiles = Array.isArray((codeChanges as any)?.failedFiles)
      ? (codeChanges as any).failedFiles as Array<{ path?: string; error?: string }>
      : [];
    normalized.testResult = testResults?.passed === false || failedFiles.length > 0 ? 'failed' : 'passed';
    if (failedFiles.length > 0) {
      normalized.filesChanged = appliedFiles;
      if (!normalized.message || /задача выполнена|реализовано|изменена обработка/i.test(String(normalized.message))) {
        normalized.message = `Изменения не были применены. ${failedFiles.map((item) => `${item.path}: ${item.error}`).join('; ')}`;
      }
      if (!normalized.summary || /задача выполнена|реализовано/i.test(String(normalized.summary))) {
        normalized.summary = `Изменения не применились: ${failedFiles.map((item) => item.path).filter(Boolean).join(', ')}`;
      }
    }
    if (!this.shouldIncludeNextSteps(run.task)) {
      normalized.nextSteps = [];
    } else if (!Array.isArray(normalized.nextSteps)) {
      normalized.nextSteps = [];
    }
    if (runMode === 'diagnostics') {
      if (!Array.isArray((normalized as any).diagnosis)) {
        normalized.diagnosis = Array.isArray((spec as any)?.diagnosis) ? (spec as any).diagnosis : [];
      }
      if (!(normalized as any).rootCause) {
        normalized.rootCause = (spec as any)?.rootCause || '';
      }
      if (!Array.isArray((normalized as any).recommendations)) {
        normalized.recommendations = Array.isArray((spec as any)?.recommendations) ? (spec as any).recommendations : [];
      }
    }
    return normalized;
  }
}
