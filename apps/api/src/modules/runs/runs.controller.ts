import { Body, Controller, Get, Inject, Logger, Param, Post } from "@nestjs/common";
import { RunsService } from "./runs.service.js";
import { StartRunDto } from "./dto/start-run.dto.js";
import { safeJsonParse } from "../../shared/json.js";
import fs from "node:fs/promises";
import path from "node:path";

@Controller()
export class RunsController {
  private readonly logger = new Logger(RunsController.name);
  constructor(@Inject(RunsService) private readonly runsService: RunsService) {}

  @Get("runs")
  async listRuns() {
    const runs = await this.runsService.list();
    return { runs };
  }

  @Post("runs")
  async startRun(@Body() dto: StartRunDto) {
    const { runId } = await this.runsService.startRun(dto);
    // Запуск прогона В ФОНЕ — НЕ блокируем HTTP-ответ. Раньше тут стоял
    // `await this.runsService.executeRunSteps(runId)` и фронт висел на запросе
    // всё время выполнения команды (десятки секунд/минут): WS-события
    // приходили, но UI их отбрасывал, т.к. ещё не получил runId, а потом всё
    // вываливалось разом и чат «прыгал». Теперь отвечаем мгновенно — фронт
    // сразу получает runId, подключается к сокету и показывает прогресс.
    void this.runsService.executeRunSteps(runId).catch((error) => {
      this.logger.error(`Background run ${runId} failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    return { runId };
  }

  @Post("runs/:id/approvals/:approvalId")
  async resolveApproval(
    @Param("id") id: string,
    @Param("approvalId") approvalId: string,
    @Body() body: { approved?: boolean; reason?: string; resolution?: "approve" | "reject_skip" | "reject_cancel" },
  ) {
    const approved = body?.approved !== false;
    return this.runsService.resolveApproval(id, approvalId, approved, body?.reason, body?.resolution);
  }

  // Остановить работу агента (cancel). Текущая попытка выйдет на ближайшей
  // проверке между этапами и пометки failed не будет.
  @Post("runs/:id/cancel")
  async cancelRun(@Param("id") id: string, @Body() body: { reason?: string }) {
    return this.runsService.cancelRun(id, body?.reason);
  }

  // Поставить работу на паузу. Resume поднимет прогон заново.
  @Post("runs/:id/pause")
  async pauseRun(@Param("id") id: string, @Body() body: { reason?: string }) {
    return this.runsService.pauseRun(id, body?.reason);
  }

  // Продолжить работу после паузы (подхватит pendingTask, если задали новую).
  @Post("runs/:id/resume")
  async resumeRun(@Param("id") id: string) {
    return this.runsService.resumeRun(id);
  }

  // Дать агенту новую задачу. На паузе — отложится до resume; в активном
  // состоянии — перенаправит (пауза → resume с новой задачей).
  @Post("runs/:id/replace-task")
  async replaceTask(@Param("id") id: string, @Body() body: { task?: string }) {
    return this.runsService.replaceTask(id, String(body?.task ?? "").trim());
  }


  @Get("runs/:id")
  async getRun(@Param("id") id: string) {
    const run = await this.runsService.getById(id);
    if (!run) return { run: null, report: null };
    
    let report = null;

    if (run.runDir) {
      try {
        const raw = await fs.readFile(path.join(run.runDir, "final-report.json"), "utf8");
        report = safeJsonParse(raw, null);
      } catch {
        report = null;
      }
    }

    return { run, report };
  }

  @Get("runs/:id/summary")
  async getRunSummary(@Param("id") id: string) {
    const run = await this.runsService.getById(id);
    if (!run) return { run: null, summary: null };
    
    let report: any = null;

    if (run.runDir) {
      try {
        const raw = await fs.readFile(path.join(run.runDir, "final-report.json"), "utf8");
        report = safeJsonParse(raw, null);
      } catch {
        report = null;
      }
    }

    if (!report) {
      return { run, summary: null };
    }

    // Extract key information for user display
    const summary = {
      task: report.task,
      status: run.status,
      error: run.error,
      approvals: report.approvals,
      orchestrator: {
        goal: report.orchestrator?.goal,
        message: report.orchestratorResponse?.message,
        teamSummary: report.orchestratorResponse?.teamSummary || report.orchestrator?.teamUnderstanding,
        risks: report.orchestratorResponse?.risks || report.orchestrator?.constraints,
        nextSteps: report.orchestratorResponse?.nextSteps,
      },
      teamWork: {
        analyst: {
          executed: !!report.analyst,
          summary: report.analyst?.summary,
          findings: report.analyst?.findings,
        },
        developer: {
          executed: !!report.developer,
          summary: report.developer?.summary,
          operationsCount: report.developer?.operations?.length || 0,
          notes: report.developer?.notes,
        },
        tester: {
          executed: !!report.tester,
          status: report.tester?.status,
          summary: report.tester?.summary,
          findings: report.tester?.findings,
        },
      },
      tokenUsage: {
        totalActualTokens: report.usageSummary?.totalActualTokens || 0,
        totalWeightedTokens: report.usageSummary?.totalWeightedTokens || 0,
        byAgent: report.usageSummary?.byAgent || {},
      },
      fileChanges: {
        applied: report.applyResult?.applied?.length || 0,
        skipped: report.applyResult?.skipped?.length || 0,
        details: report.applyResult,
      },
      generatedAt: report.generatedAt,
    };

    return { run, summary };
  }

  @Get("jobs/:id")
  async getJob(@Param("id") id: string) {
    return this.runsService.getJob(id);
  }
}
