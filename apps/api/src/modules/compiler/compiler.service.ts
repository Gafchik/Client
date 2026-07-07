import { Inject, Injectable } from "@nestjs/common";
import { CompileRequestDto } from "./dto/compile-request.dto.js";
import { IntentAnalyzerService } from "./services/intent-analyzer.service.js";
import { KnowledgeEngineService } from "./services/knowledge-engine.service.js";
import { ImpactAnalyzerService } from "./services/impact-analyzer.service.js";
import { ContextOptimizerService } from "./services/context-optimizer.service.js";
import { ExecutionPlannerService } from "./services/execution-planner.service.js";
import { RunsService } from "../runs/runs.service.js";
import { TeamsService } from "../teams/teams.service.js";
import { ProjectsService } from "../projects/projects.service.js";

@Injectable()
export class CompilerService {
  constructor(
    @Inject(IntentAnalyzerService)
    private readonly intentAnalyzer: IntentAnalyzerService,
    @Inject(KnowledgeEngineService)
    private readonly knowledgeEngine: KnowledgeEngineService,
    @Inject(ImpactAnalyzerService)
    private readonly impactAnalyzer: ImpactAnalyzerService,
    @Inject(ContextOptimizerService)
    private readonly contextOptimizer: ContextOptimizerService,
    @Inject(ExecutionPlannerService)
    private readonly executionPlanner: ExecutionPlannerService,
    @Inject(RunsService)
    private readonly runsService: RunsService,
    @Inject(TeamsService)
    private readonly teamsService: TeamsService,
    @Inject(ProjectsService)
    private readonly projectsService: ProjectsService,
  ) {}

  async compile(input: CompileRequestDto) {
    const task = String(input.task || "").trim();
    if (!task) throw new Error("task is required");
    if (!input.projectId) throw new Error("projectId is required");

    const project = await this.projectsService.getById(input.projectId);
    const detected = this.intentAnalyzer.analyze(task);
    const mode = input.mode && input.mode !== "auto" ? input.mode : detected.mode;
    const resolvedIntent = { ...detected, mode };

    const knowledge = await this.knowledgeEngine.getSnapshot(project.id, task);
    const impact = await this.impactAnalyzer.analyze(project.id, resolvedIntent, task);
    const contextPack = this.contextOptimizer.buildPack(resolvedIntent, knowledge, impact, input.maxContextTokens ?? 2600);
    const plan = this.executionPlanner.build(resolvedIntent, impact, task);

    let run: null | { runId: string } = null;
    if (mode === "build" && input.execute && input.chatId) {
      const resolvedTeamId = input.teamId || project.teamId || "";
      if (!resolvedTeamId) throw new Error("teamId is required for build execution");
      const team = await this.teamsService.getById(resolvedTeamId);
      run = await this.runsService.startRun({
        chatId: input.chatId,
        projectId: project.id,
        task: plan.executionTask,
        originalMessage: task,
        teamId: team.id,
        teamName: team.name,
        projectPath: project.localPath,
      });
      void this.runsService.executeRunSteps(run.runId).catch(() => {});
    }

    return {
      mode,
      intent: resolvedIntent,
      project: {
        id: project.id,
        name: project.name,
      },
      knowledge: {
        coverage: knowledge.coverage,
        unknowns: knowledge.unknowns,
        topEntities: knowledge.topEntities.slice(0, 10),
        topMemory: knowledge.topMemory.slice(0, 6),
      },
      impact,
      contextPack,
      plan,
      run,
    };
  }

  async ask(input: CompileRequestDto) {
    const compiled = await this.compile({
      ...input,
      mode: "ask",
      execute: false,
    });
    const answer = this.buildAskAnswer(compiled.intent.intentType, input.task, compiled);
    return {
      ...compiled,
      answer,
    };
  }

  private buildAskAnswer(intentType: string, task: string, compiled: any): string {
    if (intentType === "impact_question") {
      return [
        `Impact for "${task}":`,
        `Risk: ${compiled.impact.riskLevel} (${compiled.impact.riskScore})`,
        `Impacted files: ${(compiled.impact.impactedFiles || []).slice(0, 20).join(", ") || "none"}`,
        `Tests to run: ${(compiled.impact.testsToRun || []).slice(0, 20).join(", ") || "none"}`,
      ].join("\n");
    }

    if (intentType === "dependency_question") {
      return [
        `Dependency answer for "${task}":`,
        `Top related entities: ${(compiled.knowledge.topEntities || []).slice(0, 8).map((e: any) => e.name).join(", ") || "none"}`,
        `Impacted services: ${(compiled.impact.impactedServices || []).slice(0, 12).join(", ") || "none"}`,
        `Impacted API: ${(compiled.impact.impactedApi || []).slice(0, 12).join(", ") || "none"}`,
      ].join("\n");
    }

    if (intentType === "test_question") {
      return [
        `Suggested tests for "${task}":`,
        ...(compiled.impact.testsToRun || []).slice(0, 24),
      ].join("\n");
    }

    if (intentType === "status_question") {
      return [
        `Project status snapshot for "${task}":`,
        `Knowledge coverage: ${Object.entries(compiled.knowledge.coverage || {}).map(([k, v]) => `${k}:${v}%`).join(", ") || "n/a"}`,
        `Open unknowns: ${(compiled.knowledge.unknowns || []).slice(0, 12).join("; ") || "none"}`,
      ].join("\n");
    }

    return [
      `Knowledge-based answer for "${task}":`,
      `Top entities: ${(compiled.knowledge.topEntities || []).slice(0, 8).map((e: any) => `${e.name} (${e.kind})`).join(", ") || "none"}`,
      `Relevant memory: ${(compiled.knowledge.topMemory || []).slice(0, 6).map((m: any) => m.title).join(", ") || "none"}`,
      `Risk profile: ${compiled.impact.riskLevel} (${compiled.impact.riskScore})`,
    ].join("\n");
  }
}

