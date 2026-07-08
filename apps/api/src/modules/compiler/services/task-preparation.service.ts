import { Injectable } from "@nestjs/common";
import {
  CodeConstraints,
  CompilerIR,
  ContextPack,
  ExecutionPlan,
  ImpactSnapshot,
  IntentAnalysis,
  ProjectKnowledgeSnapshot,
  SimilarSolution,
} from "../types/compiler.types.js";

@Injectable()
export class TaskPreparationService {
  prepare(
    task: string,
    intent: IntentAnalysis,
    knowledge: ProjectKnowledgeSnapshot,
    impact: ImpactSnapshot,
    contextPack: ContextPack,
    plan: ExecutionPlan,
  ): {
    ir: CompilerIR;
    executionTask: string;
    constraints: CodeConstraints;
    architectureRules: string[];
    acceptanceCriteria: string[];
    relatedEntities: string[];
    similarSolutions: SimilarSolution[];
  } {
    const relatedEntities = this.pickRelatedEntities(knowledge, impact, intent);
    const similarSolutions = this.findSimilarSolutions(knowledge, intent, impact);
    const constraints = this.buildConstraints(impact, knowledge);
    const architectureRules = this.buildArchitectureRules(intent, impact, constraints);
    const acceptanceCriteria = this.buildAcceptanceCriteria(intent, impact, constraints, architectureRules);

    const ir: CompilerIR = {
      task,
      normalizedTask: this.normalizeTask(task),
      intentType: intent.intentType,
      entities: intent.entities,
      relatedEntities,
      impact: {
        riskLevel: impact.riskLevel,
        riskScore: impact.riskScore,
        impactedFiles: impact.impactedFiles.slice(0, 60),
        impactedServices: impact.impactedServices.slice(0, 40),
        impactedApi: impact.impactedApi.slice(0, 40),
        testsToRun: impact.testsToRun.slice(0, 40),
      },
      context: {
        maxTokens: Math.max(contextPack.totalEstimatedTokens, 1),
        usedTokens: contextPack.totalEstimatedTokens,
        droppedItems: contextPack.droppedItems,
        selectedItems: contextPack.items.map((item) => ({
          type: item.type,
          id: item.id,
          title: item.title,
          estimatedTokens: item.estimatedTokens,
          weight: item.weight,
        })),
      },
      constraints,
      architectureRules,
      acceptanceCriteria,
      similarSolutions,
    };

    const executionTask = this.buildExecutionTask(task, plan.runMode, ir);

    return {
      ir,
      executionTask,
      constraints,
      architectureRules,
      acceptanceCriteria,
      relatedEntities,
      similarSolutions,
    };
  }

  private normalizeTask(task: string): string {
    return String(task || "")
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, 2000);
  }

  private pickRelatedEntities(
    knowledge: ProjectKnowledgeSnapshot,
    impact: ImpactSnapshot,
    intent: IntentAnalysis,
  ): string[] {
    const out = new Set<string>();
    for (const entity of knowledge.topEntities || []) {
      if (out.size >= 40) break;
      const text = `${entity.name} ${entity.location} ${entity.kind}`.toLowerCase();
      if (intent.entities.some((token) => text.includes(String(token).toLowerCase()))) {
        out.add(`${entity.name} (${entity.kind}) @ ${entity.location}`);
      }
    }
    for (const file of (impact.impactedFiles || []).slice(0, 40)) {
      out.add(`file:${file}`);
    }
    for (const api of (impact.impactedApi || []).slice(0, 24)) {
      out.add(`api:${api}`);
    }
    return Array.from(out).slice(0, 60);
  }

  private findSimilarSolutions(
    knowledge: ProjectKnowledgeSnapshot,
    intent: IntentAnalysis,
    impact: ImpactSnapshot,
  ): SimilarSolution[] {
    const scored: SimilarSolution[] = [];
    for (const memory of knowledge.topMemory || []) {
      const text = `${memory.title}\n${memory.summary}\n${(memory.relatedFiles || []).join(" ")}`.toLowerCase();
      let score = 0;
      for (const token of intent.entities) {
        if (text.includes(String(token).toLowerCase())) score += 2;
      }
      for (const file of impact.impactedFiles || []) {
        if (text.includes(String(file).toLowerCase())) score += 3;
      }
      if (memory.kind === "knowledge-graph-index") score += 1;
      if (score <= 0) continue;
      scored.push({
        id: memory.id,
        title: memory.title,
        summary: memory.summary,
        kind: memory.kind,
        relatedFiles: (memory.relatedFiles || []).slice(0, 20),
        score,
      });
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, 8);
  }

  private buildConstraints(impact: ImpactSnapshot, knowledge: ProjectKnowledgeSnapshot): CodeConstraints {
    const allowedFiles = Array.from(new Set([...(impact.impactedFiles || []).slice(0, 80), ...(impact.changed || []).slice(0, 40)]));

    const immutableFiles = allowedFiles.filter((file) => /package-lock\.json$|pnpm-lock\.yaml$|yarn\.lock$|docker-compose\.yml$|\.env/i.test(file));

    const forbiddenPaths = [
      "**/node_modules/**",
      "**/vendor/**",
      "**/.git/**",
      "**/dist/**",
      "**/build/**",
      "**/.next/**",
      "**/coverage/**",
      "**/.turbo/**",
      "**/.cache/**",
    ];

    const notes = [
      "Запрещено изменять сгенерированные и lock-файлы без явного требования.",
      "Любые правки должны оставаться в зоне impactedFiles/changedFiles.",
      `Покрытие знаний: ${Object.entries(knowledge.coverage || {}).map(([k, v]) => `${k}:${v}%`).join(", ") || "n/a"}`,
    ];

    return { allowedFiles, forbiddenPaths, immutableFiles, notes };
  }

  private buildArchitectureRules(intent: IntentAnalysis, impact: ImpactSnapshot, constraints: CodeConstraints): string[] {
    const rules = [
      "Не менять публичные контракты API без необходимости и без миграционного пути.",
      "Сохранять слоистую архитектуру: контроллеры -> сервисы -> модели/репозитории.",
      "Переиспользовать существующие сущности и утилиты, не дублировать логику.",
      "Соблюдать текущий стиль проекта и соглашения по именованию.",
      "Не трогать запрещенные директории и lock-файлы.",
    ];

    if ((impact.impactedApi || []).length) {
      rules.push("Изменения API требуют совместимости и обновления связанных тестов/документации.");
    }
    if (intent.intentType === "diagnostics") {
      rules.push("Режим диагностики: анализ без изменения бизнес-логики и без нецелевых рефакторингов.");
    }
    if (constraints.allowedFiles.length) {
      rules.push(`Разрешённая зона изменений: ${constraints.allowedFiles.slice(0, 20).join(", ")}`);
    }

    return rules.slice(0, 12);
  }

  private buildAcceptanceCriteria(
    intent: IntentAnalysis,
    impact: ImpactSnapshot,
    constraints: CodeConstraints,
    architectureRules: string[],
  ): string[] {
    const criteria: string[] = [
      "Изменения решают задачу пользователя без регрессий в затронутой области.",
      "Изменения ограничены разрешёнными файлами и не затрагивают запрещённые пути.",
      "Соблюдены архитектурные правила и стиль проекта.",
    ];

    if ((impact.testsToRun || []).length) {
      criteria.push(`Проходят целевые тесты: ${(impact.testsToRun || []).slice(0, 12).join(", ")}`);
    } else {
      criteria.push("Добавлены/обновлены уместные тесты или приведено обоснование, почему тесты не требуются.");
    }

    if ((impact.impactedApi || []).length) {
      criteria.push("API-поведение сохранено или явно задокументировано изменение контракта.");
    }

    if (intent.intentType === "diagnostics") {
      criteria.push("Подготовлен проверяемый технический диагноз с файлами и причинами.");
    }

    criteria.push(`Нарушения ограничений отсутствуют (forbidden: ${constraints.forbiddenPaths.slice(0, 4).join(", ")}).`);
    criteria.push(`Архитектурные правила учтены: ${architectureRules.length}.`);

    return criteria.slice(0, 12);
  }

  private buildExecutionTask(task: string, runMode: ExecutionPlan["runMode"], ir: CompilerIR): string {
    const lines: string[] = [
      "=== Execution Spec (Prepared by Client Platform) ===",
      `Task: ${task}`,
      `Run mode: ${runMode}`,
      "",
      "1) What to do:",
      `- ${ir.normalizedTask}`,
      "",
      "2) Allowed files:",
      ...(ir.constraints.allowedFiles.length ? ir.constraints.allowedFiles.slice(0, 80).map((f) => `- ${f}`) : ["- (derive from impacted context)"]),
      "",
      "3) Forbidden paths:",
      ...ir.constraints.forbiddenPaths.map((p) => `- ${p}`),
      "",
      "4) Immutable files:",
      ...(ir.constraints.immutableFiles.length ? ir.constraints.immutableFiles.map((f) => `- ${f}`) : ["- none"]),
      "",
      "5) Related entities:",
      ...(ir.relatedEntities.length ? ir.relatedEntities.slice(0, 60).map((e) => `- ${e}`) : ["- none"]),
      "",
      "6) Architecture rules:",
      ...ir.architectureRules.map((r) => `- ${r}`),
      "",
      "7) Acceptance criteria:",
      ...ir.acceptanceCriteria.map((c) => `- ${c}`),
      "",
      "8) Similar past solutions:",
      ...(ir.similarSolutions.length
        ? ir.similarSolutions.map((s) => `- [${s.score}] ${s.title} (${s.kind}) :: ${(s.relatedFiles || []).slice(0, 5).join(", ")}`)
        : ["- none"]),
      "",
      "9) Impact summary:",
      `- Risk: ${ir.impact.riskLevel} (${ir.impact.riskScore})`,
      `- Impacted services: ${(ir.impact.impactedServices || []).slice(0, 20).join(", ") || "none"}`,
      `- Impacted API: ${(ir.impact.impactedApi || []).slice(0, 20).join(", ") || "none"}`,
      `- Tests to run: ${(ir.impact.testsToRun || []).slice(0, 20).join(", ") || "none"}`,
      "",
      "Developer focus: implement code only. Analysis/planning already prepared by platform.",
      "=== End Execution Spec ===",
    ];

    return lines.join("\n");
  }
}
