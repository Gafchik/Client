import { Inject, Injectable } from "@nestjs/common";
import { ProjectsService } from "../../projects/projects.service.js";
import { ImpactSnapshot, IntentAnalysis } from "../types/compiler.types.js";

@Injectable()
export class ImpactAnalyzerService {
  constructor(
    @Inject(ProjectsService)
    private readonly projectsService: ProjectsService,
  ) {}

  async analyze(projectId: string, intent: IntentAnalysis, task: string): Promise<ImpactSnapshot> {
    const changedCandidates = this.extractChangedCandidates(task, intent.entities);
    const impact = await this.projectsService.analyzeImpact(projectId, changedCandidates);

    const reasons: string[] = [];
    if ((impact.impactedFiles || []).length > 15) reasons.push("Large impacted file set.");
    if ((impact.impactedServices || []).length > 8) reasons.push("Cross-service impact detected.");
    if ((impact.testsToRun || []).length > 10) reasons.push("Broad test surface.");
    if ((impact.impactedApi || []).length > 4) reasons.push("API contracts may be affected.");
    if (!reasons.length) reasons.push("Localized change scope.");

    const riskScore = this.computeRiskScore(impact);
    const riskLevel = riskScore >= 75 ? "high" : riskScore >= 40 ? "medium" : "low";

    return {
      changed: changedCandidates,
      impactedNodes: impact.impactedNodes || [],
      impactedFiles: impact.impactedFiles || [],
      impactedServices: impact.impactedServices || [],
      impactedApi: impact.impactedApi || [],
      impactedPages: impact.impactedPages || [],
      testsToRun: impact.testsToRun || [],
      riskScore,
      riskLevel,
      reasons,
    };
  }

  private extractChangedCandidates(task: string, entities: string[]): string[] {
    const pathLike = Array.from(
      String(task || "")
        .matchAll(/\b(?:[a-z0-9_-]+\/)+[a-z0-9_.-]+\b/gi),
    ).map((match) => String(match[0] || "").trim());

    const merged = new Set<string>([
      ...pathLike,
      ...entities.filter((item) => item.includes("/") || item.includes(".")),
    ]);
    return Array.from(merged).slice(0, 32);
  }

  private computeRiskScore(impact: any): number {
    const files = Number((impact.impactedFiles || []).length || 0);
    const services = Number((impact.impactedServices || []).length || 0);
    const api = Number((impact.impactedApi || []).length || 0);
    const tests = Number((impact.testsToRun || []).length || 0);
    const raw = files * 2 + services * 4 + api * 6 + Math.min(12, tests);
    return Math.max(0, Math.min(100, raw));
  }
}

