import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { Logger } from "@nestjs/common";
import { RunsService } from "./runs.service.js";
import { StartRunDto } from "./dto/start-run.dto.js";
import { safeJsonParse } from "../../shared/json.js";
import fs from "node:fs/promises";
import path from "node:path";

@Controller()
export class RunsController {
  private readonly logger = new Logger(RunsController.name);
  constructor(private readonly runsService: RunsService) {}

  @Get("runs")
  async listRuns() {
    const runs = await this.runsService.list();
    return { runs };
  }

  @Post("runs")
  async startRun(@Body() dto: StartRunDto) {
    const { runId } = await this.runsService.startRun(dto);
    // Блокируем ответ — ждём завершения выполнения
    await this.runsService.executeRunSteps(runId);
    return { runId };
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
