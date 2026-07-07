import { Injectable } from "@nestjs/common";
import { ExecutionPlan, ImpactSnapshot, IntentAnalysis } from "../types/compiler.types.js";

@Injectable()
export class ExecutionPlannerService {
  build(intent: IntentAnalysis, impact: ImpactSnapshot, task: string): ExecutionPlan {
    const runMode: "implementation" | "diagnostics" | "research" =
      intent.intentType === "diagnostics"
        ? "diagnostics"
        : intent.intentType === "research"
          ? "research"
          : "implementation";

    const roles = {
      pm: true,
      developer: intent.mode === "build" && runMode === "implementation",
      reviewer: intent.mode === "build" && (impact.riskLevel === "high" || impact.impactedApi.length > 0),
      tester: intent.mode === "build" && (impact.testsToRun.length > 0 || runMode !== "implementation"),
    };

    if (runMode === "diagnostics") {
      roles.developer = false;
      roles.reviewer = false;
      roles.tester = true;
    }
    if (runMode === "research") {
      roles.developer = false;
      roles.reviewer = false;
      roles.tester = false;
    }

    const stages = [
      {
        id: "intent",
        title: "Intent Analyzer",
        deterministic: true,
        enabled: true,
        reason: "Task intent parsed by deterministic policy rules.",
      },
      {
        id: "knowledge",
        title: "Knowledge Engine",
        deterministic: true,
        enabled: true,
        reason: "Knowledge snapshot extracted from memory + graph.",
      },
      {
        id: "impact",
        title: "Impact Analyzer",
        deterministic: true,
        enabled: true,
        reason: "Dependency traversal and blast radius computed by code.",
      },
      {
        id: "context",
        title: "Context Optimizer",
        deterministic: true,
        enabled: true,
        reason: "Minimal context pack selected by token-aware ranking.",
      },
      {
        id: "planning",
        title: "Execution Planner",
        deterministic: true,
        enabled: true,
        reason: "Role routing selected by risk and intent policies.",
      },
      {
        id: "developer",
        title: "Developer",
        deterministic: false,
        enabled: roles.developer,
        reason: roles.developer ? "Implementation requires code change generation." : "No code generation required.",
      },
      {
        id: "reviewer",
        title: "Reviewer",
        deterministic: false,
        enabled: roles.reviewer,
        reason: roles.reviewer ? "High risk or API impact requires review." : "Risk low, review skipped.",
      },
      {
        id: "tester",
        title: "Tester",
        deterministic: false,
        enabled: roles.tester,
        reason: roles.tester ? "Verification required by policy." : "No verification stage required.",
      },
      {
        id: "knowledge-update",
        title: "Knowledge Update",
        deterministic: true,
        enabled: true,
        reason: "Project memory update is always required.",
      },
    ];

    return {
      mode: intent.mode,
      runMode,
      roles,
      stages,
      executionTask: this.buildExecutionTask(intent, task, impact),
      testsToRun: impact.testsToRun.slice(0, 20),
    };
  }

  private buildExecutionTask(intent: IntentAnalysis, task: string, impact: ImpactSnapshot): string {
    if (intent.mode === "ask") {
      return task;
    }
    const changed = impact.changed.length ? `; focus=${impact.changed.slice(0, 8).join(", ")}` : "";
    const risk = `; risk=${impact.riskLevel}`;
    return `${task}${changed}${risk}`.trim();
  }
}

