import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Run } from '../../persistence/run.entity';
import { StartRunDto } from './dto/start-run.dto';
import { parseJsonSafely, ParseJsonResult } from '../../shared/json';
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

@Injectable()
export class RunsService {
  private readonly logger = new Logger(RunsService.name);

  constructor(
    @InjectRepository(Run)
    private readonly runRepo: Repository<Run>,
  ) {}

  async startRun(dto: StartRunDto): Promise<{ runId: string }> {
    const run = this.runRepo.create({
      id: crypto.randomUUID(),
      chatId: dto.chatId,
      task: dto.task,
      teamId: dto.teamId,
      teamName: dto.teamName,
      projectPath: dto.projectPath,
      status: 'running',
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

  async getJob(id: string): Promise<{ run: Run | null; report: any }> {
    const run = await this.getById(id);
    if (!run) return { run: null, report: null };
    
    let report = null;
    if (run.runDir) {
      try {
        const raw = await fs.promises.readFile(path.join(run.runDir, 'final-report.json'), 'utf8');
        report = JSON.parse(raw);
      } catch {
        report = null;
      }
    }
    return { run, report };
  }

  /**
   * Вызывает LLM для заданной роли и парсит ответ с устойчивой стратегией.
   * При ошибке парсинга — логирует сырой ответ, сохраняет артефакт с ошибкой,
   * возвращает StepResult с success=false, не выбрасывает исключение.
   */
  async callAgentAndParse(
    runId: string,
    stepName: string,
    prompt: string,
    role: string,
  ): Promise<StepResult> {
    const run = await this.runRepo.findOne({ where: { id: runId } });
    if (!run) {
      return { success: false, error: `Run ${runId} not found` };
    }

    // TODO: интеграция с реальным LLM-провайдером (myroute)
    // Пока мокируем вызов для демонстрации структуры
    const llmResponse = await this.mockLlmCall(prompt, role);

    // Парсим ответ с fallback-стратегиями
    const parseResult: ParseJsonResult = parseJsonSafely(llmResponse.content);

    // Сохраняем сырой ответ в артефакте для отладки
    const artifactPath = this.getArtifactPath(runId, stepName);
    this.ensureArtifactDir(runId);
    
    const artifactContent = {
      role,
      prompt,
      rawResponse: llmResponse.content,
      parsed: parseResult.success ? parseResult.data : null,
      parseError: parseResult.error,
      timestamp: new Date().toISOString(),
      model: llmResponse.model,
      usage: llmResponse.usage,
    };

    fs.writeFileSync(artifactPath, JSON.stringify(artifactContent, null, 2), 'utf-8');

    if (!parseResult.success) {
      this.logger.error(
        `Failed to parse JSON for run ${runId}, step ${stepName}, role ${role}: ${parseResult.error}`,
      );
      this.logger.debug(`Raw response: ${parseResult.rawResponse}`);

      return {
        success: false,
        error: `JSON parse error: ${parseResult.error}`,
        rawResponse: parseResult.rawResponse,
      };
    }

    this.logger.log(`Successfully parsed JSON for run ${runId}, step ${stepName}, role ${role}`);

    return {
      success: true,
      artifact: parseResult.data as Record<string, unknown>,
      rawResponse: parseResult.rawResponse,
    };
  }

  /**
   * Запускает последовательность шагов оркестратора.
   * При ошибке на шаге — логирует, сохраняет артефакт, продолжает или останавливает run.
   */
  async executeRunSteps(runId: string): Promise<void> {
    const run = await this.runRepo.findOne({ where: { id: runId } });
    if (!run) return;

    const steps = [
      { name: 'orchestrator', role: 'orchestrator', prompt: this.buildOrchestratorPrompt(run) },
      { name: 'analyst', role: 'analyst', prompt: this.buildAnalystPrompt(run) },
      { name: 'developer', role: 'developer', prompt: this.buildDeveloperPrompt(run) },
      { name: 'reviewer', role: 'reviewer', prompt: this.buildReviewerPrompt(run) },
      { name: 'tester', role: 'tester', prompt: this.buildTesterPrompt(run) },
    ];

    let hasCriticalFailure = false;

    for (const step of steps) {
      if (hasCriticalFailure) break;

      const result = await this.callAgentAndParse(runId, step.name, step.prompt, step.role);

      if (!result.success) {
        // Критическая ошибка парсинга — помечаем run как failed
        hasCriticalFailure = true;
        run.status = 'failed';
        run.error = `Step ${step.name} failed: ${result.error}`;
        run.finishedAt = new Date();
        await this.runRepo.save(run);
        this.logger.error(`Run ${runId} marked as failed at step ${step.name}: ${result.error}`);
        break;
      }

      // Сохраняем успешный артефакт в run metadata (опционально)
      // run.artifacts = run.artifacts || {};
      // run.artifacts[step.name] = result.artifact;
      // await this.runRepo.save(run);
    }

    if (!hasCriticalFailure) {
      run.status = 'completed';
      run.finishedAt = new Date();
      await this.runRepo.save(run);
      this.logger.log(`Run ${runId} completed successfully`);
    }
  }

  private getArtifactPath(runId: string, stepName: string): string {
    const baseDir = process.env.STORAGE_PATH || 'storage';
    return path.join(baseDir, 'teams', 'default', 'runs', runId, `${stepName}.json`);
  }

  private ensureArtifactDir(runId: string): void {
    const baseDir = process.env.STORAGE_PATH || 'storage';
    const dir = path.join(baseDir, 'teams', 'default', 'runs', runId);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  // Мок вызова LLM — заменить на реальную интеграцию с myroute
  private async mockLlmCall(prompt: string, role: string): Promise<LlmResponse> {
    // В реальности здесь HTTP запрос к api.rout.my/v1
    // Возвращаем валидный JSON для демонстрации
    return {
      content: JSON.stringify({
        role,
        status: 'ok',
        output: `Processed by ${role}`,
        timestamp: new Date().toISOString(),
      }),
      role,
      model: 'myroute-model',
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    };
  }

  private buildOrchestratorPrompt(run: Run): string {
    return `Orchestrator task: ${run.task}`;
  }

  private buildAnalystPrompt(run: Run): string {
    return `Analyst task: ${run.task}`;
  }

  private buildDeveloperPrompt(run: Run): string {
    return `Developer task: ${run.task}`;
  }

  private buildReviewerPrompt(run: Run): string {
    return `Reviewer task: ${run.task}`;
  }

  private buildTesterPrompt(run: Run): string {
    return `Tester task: ${run.task}`;
  }
}
