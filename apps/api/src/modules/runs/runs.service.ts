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
   * Основная оркестрация: orchestrator -> analyst -> developer -> tester -> analyst(memory) -> orchestrator
   * Всё стримится в чат через WebSocket
   */
  async executeRunSteps(runId: string): Promise<void> {
    const run = await this.runRepo.findOne({ where: { id: runId } });
    if (!run) return;

    let chatId = run.chatId ?? '';
    let projectId = run.projectId ?? '';

    try {
      // Получаем контекст
      if (!run.chatId) throw new Error('Run has no chatId');
      const chat = await this.chatsService.getById(run.chatId);
      const projectIdFromChat = chat.chat?.projectId ?? '';
      const project = await this.projectsService.getById(run.projectId ?? projectIdFromChat ?? '');
      const team = await this.teamsService.getById(run.teamId);
      
      chatId = run.chatId ?? '';
      projectId = project.id ?? '';

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

      const orchName = orchestratorAgent.name || 'Alex';
      const orchLabel = orchestratorAgent.label || 'Оркестратор';
      const anName = analystAgent.name || 'Mira';
      const anLabel = analystAgent.label || 'Аналитик';
      const devName = developerAgent.name || 'Kai';
      const devLabel = developerAgent.label || 'Разработчик';
      const testName = testerAgent.name || 'Nova';
      const testLabel = testerAgent.label || 'Тестировщик';

      const projectPath = project.localPath || '';
      const projectName = project.name || 'Unknown Project';

      // 1. ORCHESTRATOR - планирует работу
      await this.broadcastActivity(runId, chatId, 'orchestrator', orchName, orchLabel, 'working', 'Анализирую задачу и планирую работу команды');
      
      const orchestratorResult = await this.callAgentStream(
        runId, chatId, 'orchestrator', orchestratorAgent, language,
        this.buildOrchestratorPrompt(run, chat.messages, project, teamConfig),
        (delta) => this.wsGateway.broadcastTokenStream(chatId, { role: 'orchestrator', content: delta, done: false })
      );
      
      await this.broadcastActivity(runId, chatId, 'orchestrator', orchName, orchLabel, 'done', 'План готов, передаю аналитику');
      
      let plan = orchestratorResult.artifact || {};
      const executionTask = (plan as any).executionTask || run.task;

      // 2. ANALYST - пишет ТЗ, обновляет память
      await this.broadcastActivity(runId, chatId, 'analyst', anName, anLabel, 'working', 'Изучаю задачу, пишу техническое задание');
      
      const analystResult = await this.callAgentStream(
        runId, chatId, 'analyst', analystAgent, language,
        this.buildAnalystPrompt(run, plan, project, chat.messages),
        (delta) => this.wsGateway.broadcastTokenStream(chatId, { role: 'analyst', content: delta, done: false })
      );
      
      await this.broadcastActivity(runId, chatId, 'analyst', anName, anLabel, 'done', 'ТЗ готово, передаю разработчику');
      
      const spec = analystResult.artifact || {};
      
      // Аналитик сохраняет память проекта
      await this.saveProjectMemory(projectId, chatId, spec, language);

      // 3. DEVELOPER - пишет код
      await this.broadcastActivity(runId, chatId, 'developer', devName, devLabel, 'working', 'Начинаю реализацию по ТЗ');
      
      const developerResult = await this.callAgentStream(
        runId, chatId, 'developer', developerAgent, language,
        this.buildDeveloperPrompt(run, spec, project, workspace),
        (delta) => this.wsGateway.broadcastTokenStream(chatId, { role: 'developer', content: delta, done: false })
      );
      
      await this.broadcastActivity(runId, chatId, 'developer', devName, devLabel, 'done', 'Код написан');
      
      const codeChanges = developerResult.artifact || {};
      
      // Применяем изменения к файлам
      const files = (codeChanges as any).files;
      if (files && Array.isArray(files)) {
        for (const fileChange of files) {
          await this.applyFileChange(projectPath, fileChange);
          await this.broadcastActivity(runId, chatId, 'developer', devName, devLabel, 'working', `Файл: ${fileChange.path} (${fileChange.action})`);
        }
      }

      // 4. TESTER - запускает тесты
      await this.broadcastActivity(runId, chatId, 'tester', testName, testLabel, 'working', 'Запускаю тесты');
      
      const testerResult = await this.callAgentStream(
        runId, chatId, 'tester', testerAgent, language,
        this.buildTesterPrompt(run, codeChanges, project),
        (delta) => this.wsGateway.broadcastTokenStream(chatId, { role: 'tester', content: delta, done: false })
      );
      
      const testResults: TestResult = (testerResult.artifact as unknown as TestResult) || { passed: true, tests: [] };
      await this.broadcastActivity(runId, chatId, 'tester', testName, testLabel, testResults.passed ? 'done' : 'error', testResults.passed ? 'Тесты пройдены' : `Тесты упали: ${(testResults.errors || []).join(', ') || 'unknown'}`);

      // 5. ANALYST - обновляет память проекта с результатами
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
      
      await this.broadcastActivity(runId, chatId, 'orchestrator', orchName, orchLabel, 'done', 'Работа завершена');

      // Сохраняем финальный отчет
      run.status = testResults.passed ? 'completed' : 'failed';
      run.finishedAt = new Date();
      run.finalReport = finalReport.artifact || { summary: finalReport.rawResponse };
      await this.runRepo.save(run);

    } catch (error) {
      this.logger.error(`Run ${runId} failed: ${error instanceof Error ? error.message : String(error)}`);
      run.status = 'failed';
      run.error = error instanceof Error ? error.message : String(error);
      run.finishedAt = new Date();
      await this.runRepo.save(run);
      this.wsGateway.broadcastRunEvent(runId, chatId, 'run:failed', { error: run.error });
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
          messages: [
            { role: 'system', content: `You are ${agent.name ?? agent.label ?? stepName}. Respond in ${language}. Return valid JSON only.` },
            { role: 'user', content: prompt },
          ],
        }),
      });

      if (!response.ok) {
        throw new Error(`API request failed (${response.status}): ${await response.text()}`);
      }

      let fullContent = '';
      let totalUsage: any = null;
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
                const delta = data.choices?.[0]?.delta?.content;
                if (delta) {
                  fullContent += delta;
                  onToken(delta);
                }
                if (data.usage) totalUsage = data.usage;
              } catch { }
            }
          }
        }
      }

      // Финальный токен
      onToken('');

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
        return {
          success: false,
          error: `JSON parse error: ${parseResult.error}`,
          rawResponse: fullContent,
        };
      }

      return {
        success: true,
        artifact: parseResult.data as Record<string, unknown>,
        rawResponse: fullContent,
      };

    } catch (error) {
      this.logger.error(`Agent ${stepName} call failed: ${error instanceof Error ? error.message : String(error)}`);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Сохраняет/обновляет память проекта
   */
  private async saveProjectMemory(projectId: string, chatId: string, spec: any, language: string): Promise<void> {
    try {
      const title = `Project Spec: ${(spec as any).feature || 'Feature'}`;
      const summary = (spec as any).description || (spec as any).overview || 'Technical specification';
      const details = JSON.stringify(spec, null, 2);
      
      await this.projectsService.saveMemory({
        projectId,
        title,
        summary,
        details,
        kind: 'spec',
        tags: ['spec', 'auto-generated'],
        relatedFiles: ((spec as any).files || []).map((f: any) => f.path) || [],
        sourceRunId: null,
      });
    } catch (error) {
      this.logger.warn(`Failed to save project memory: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Применяет изменения к файлам
   */
  private async applyFileChange(projectPath: string, fileChange: { path: string; action: 'create' | 'update' | 'delete'; content?: string }): Promise<void> {
    const fullPath = path.join(projectPath, fileChange.path);
    const dir = path.dirname(fullPath);
    
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    if (fileChange.action === 'delete') {
      if (fs.existsSync(fullPath)) {
        fs.unlinkSync(fullPath);
      }
    } else {
      fs.writeFileSync(fullPath, fileChange.content || '', 'utf-8');
    }
  }

  private async broadcastActivity(runId: string, chatId: string, role: string, agentName: string, label: string, status: 'working' | 'idle' | 'done' | 'error', detail: string): Promise<void> {
    this.wsGateway.broadcastAgentActivity(chatId, { role, agentName, label, status, detail });
    this.wsGateway.broadcastRunEvent(runId, chatId, 'agent:activity', { role, agentName, label, status, detail });
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

  // ===== PROMPTS =====

  private buildOrchestratorPrompt(run: Run, messages: any[], project: any, teamConfig: TeamConfig): string {
    const agents = teamConfig.agents || {};
    const agentList = Object.entries(agents).map(([role, agent]: [string, any]) => 
      `- ${role}: ${agent.name || agent.label} (${agent.model})`
    ).join('\n');

    return `Ты — Оркестратор команды AI. Твоя задача — проанализировать запрос пользователя и составить план работы для команды.

ПРОЕКТ: ${project.name || 'Unknown'}
ПУТЬ: ${project.localPath || ''}
ЗАДАЧА: ${run.task}

КОМАНДА:
${agentList}

ИСТОРИЯ ЧАТА (последние 10):
${messages.slice(-10).map(m => `${m.role}: ${m.content}`).join('\n')}

Верни ТОЛЬКО валидный JSON:
{
  "executionTask": "string - задача для исполнения командой",
  "plan": ["string - шаги плана"],
  "assignments": {
    "analyst": "string - что делает аналитик",
    "developer": "string - что делает разработчик", 
    "tester": "string - что делает тестер"
  },
  "shouldExecute": true
}`;
  }

  private buildAnalystPrompt(run: Run, plan: any, project: any, messages: any[]): string {
    return `Ты — Аналитик (Бизнес-аналитик). Твоя задача — написать детальное техническое задание (ТЗ) на основе плана оркестратора.

ПРОЕКТ: ${project.name || 'Unknown'}
ПУТЬ: ${project.localPath || ''}
ЗАДАЧА: ${run.task}
ПЛАН ОРКЕСТРАТОРА: ${JSON.stringify(plan, null, 2)}

Напиши ТЗ для разработчика. Включи:
1. Описание фичи/задачи
2. Требования к API/интерфейсу
3. Структура данных/модели
4. Список файлов для создания/изменения
5. Критерии приемки

Верни ТОЛЬКО валидный JSON:
{
  "feature": "string - название фичи",
  "description": "string - описание",
  "requirements": ["string"],
  "api": { "endpoints": ["string"] },
  "dataModels": ["string"],
  "files": [{"path": "string", "action": "create|update", "description": "string"}],
  "acceptanceCriteria": ["string"]
}`;
  }

  private buildDeveloperPrompt(run: Run, spec: any, project: any, workspace: any): string {
    const ignoreDirs = Array.isArray(workspace.ignoreDirs) ? workspace.ignoreDirs.join(', ') : '';
    return `Ты — Разработчик. Твоя задача — реализовать код по ТЗ аналитика.

ПРОЕКТ: ${project.name || 'Unknown'}
ПУТЬ: ${project.localPath || ''}
ТЗ: ${JSON.stringify(spec, null, 2)}

Правила:
- Пиши чистый, типизированный код
- Следуй структуре проекта
- Макс файлов: ${workspace.maxFiles}, макс символов: ${workspace.maxCharsPerFile}
- Игнорируй: ${ignoreDirs}

Верни ТОЛЬКО валидный JSON:
{
  "files": [
    {"path": "string", "action": "create|update", "content": "string", "description": "string"}
  ],
  "summary": "string - что сделано"
}`;
  }

  private buildTesterPrompt(run: Run, codeChanges: any, project: any): string {
    return `Ты — Тестировщик. Твоя задача — проверить код разработчика.

ПРОЕКТ: ${project.name || 'Unknown'}
ПУТЬ: ${project.localPath || ''}
ИЗМЕНЕНИЯ: ${JSON.stringify(codeChanges, null, 2)}

Определи команды для тестирования и запусти их. Верни результат.

Верни ТОЛЬКО валидный JSON:
{
  "passed": boolean,
  "tests": [{"name": "string", "command": "string", "success": boolean, "output": "string"}],
  "errors": ["string"]
}`;
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