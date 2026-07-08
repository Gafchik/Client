import { Module } from "@nestjs/common";
import { CompilerController } from "./compiler.controller.js";
import { CompilerService } from "./compiler.service.js";
import { IntentAnalyzerService } from "./services/intent-analyzer.service.js";
import { KnowledgeEngineService } from "./services/knowledge-engine.service.js";
import { ImpactAnalyzerService } from "./services/impact-analyzer.service.js";
import { ContextOptimizerService } from "./services/context-optimizer.service.js";
import { ExecutionPlannerService } from "./services/execution-planner.service.js";
import { TaskPreparationService } from "./services/task-preparation.service.js";
import { ProjectsModule } from "../projects/projects.module.js";
import { TeamsModule } from "../teams/teams.module.js";
import { RunsModule } from "../runs/runs.module.js";

@Module({
  imports: [ProjectsModule, TeamsModule, RunsModule],
  controllers: [CompilerController],
  providers: [
    CompilerService,
    IntentAnalyzerService,
    KnowledgeEngineService,
    ImpactAnalyzerService,
    ContextOptimizerService,
    ExecutionPlannerService,
    TaskPreparationService,
  ],
  exports: [CompilerService],
})
export class CompilerModule {}
