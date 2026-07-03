import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { RunsService } from "./runs.service.js";
import { StartRunDto } from "./dto/start-run.dto.js";
import { safeJsonParse } from "../../shared/json.js";
import fs from "node:fs/promises";
import path from "node:path";

@Controller()
export class RunsController {
  constructor(private readonly runsService: RunsService) {}

  @Get("runs")
  async listRuns() {
    const runs = await this.runsService.list();
    return { runs };
  }

  @Get("runs/:id")
  async getRun(@Param("id") id: string) {
    const run = await this.runsService.getById(id);
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

  @Post("runs")
  async startRun(@Body() body: StartRunDto) {
    return this.runsService.startRun(body);
  }

  @Get("jobs/:id")
  async getJob(@Param("id") id: string) {
    return this.runsService.getJob(id);
  }
}
