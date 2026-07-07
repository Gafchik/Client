import { Injectable } from "@nestjs/common";
import { ContextPack, ContextPackItem, ImpactSnapshot, IntentAnalysis, ProjectKnowledgeSnapshot } from "../types/compiler.types.js";

@Injectable()
export class ContextOptimizerService {
  buildPack(
    intent: IntentAnalysis,
    knowledge: ProjectKnowledgeSnapshot,
    impact: ImpactSnapshot,
    maxTokens = 2600,
  ): ContextPack {
    const items: ContextPackItem[] = [];

    for (const memory of knowledge.topMemory.slice(0, 8)) {
      items.push({
        type: "memory",
        id: memory.id,
        title: memory.title || "Memory",
        content: `${memory.summary}\nFiles: ${memory.relatedFiles.join(", ")}`,
        weight: this.weightMemory(memory, intent),
        estimatedTokens: this.estimateTokens(memory.summary) + this.estimateTokens(memory.relatedFiles.join(" ")),
      });
    }

    for (const file of (impact.impactedFiles || []).slice(0, 20)) {
      items.push({
        type: "file",
        id: file,
        title: file,
        content: file,
        weight: this.weightFile(file, intent),
        estimatedTokens: this.estimateTokens(file),
      });
    }

    for (const entity of knowledge.topEntities.slice(0, 18)) {
      items.push({
        type: "entity",
        id: entity.id,
        title: entity.name,
        content: `${entity.kind} @ ${entity.location}`,
        weight: this.weightEntity(entity, intent),
        estimatedTokens: this.estimateTokens(entity.name + entity.location + entity.kind),
      });
    }

    for (const test of (impact.testsToRun || []).slice(0, 12)) {
      items.push({
        type: "test",
        id: test,
        title: "Test",
        content: test,
        weight: intent.mode === "build" ? 0.7 : 0.35,
        estimatedTokens: this.estimateTokens(test),
      });
    }

    items.push({
      type: "impact",
      id: "risk",
      title: "Risk profile",
      content: `risk=${impact.riskLevel} score=${impact.riskScore}; reasons=${impact.reasons.join(" | ")}`,
      weight: 1,
      estimatedTokens: this.estimateTokens(impact.reasons.join(" ")),
    });

    const sorted = items.sort((a, b) => b.weight - a.weight || a.estimatedTokens - b.estimatedTokens);
    const picked: ContextPackItem[] = [];
    let total = 0;
    let dropped = 0;
    for (const item of sorted) {
      if (total + item.estimatedTokens > maxTokens) {
        dropped += 1;
        continue;
      }
      picked.push(item);
      total += item.estimatedTokens;
    }

    return {
      items: picked,
      totalEstimatedTokens: total,
      droppedItems: dropped,
    };
  }

  private estimateTokens(text: string): number {
    return Math.max(1, Math.ceil(String(text || "").length / 4));
  }

  private weightMemory(memory: { title: string; summary: string; relatedFiles: string[] }, intent: IntentAnalysis): number {
    const text = `${memory.title}\n${memory.summary}`.toLowerCase();
    const overlap = intent.entities.filter((entity) => text.includes(entity.toLowerCase())).length;
    return 0.55 + overlap * 0.12 + (memory.relatedFiles.length ? 0.1 : 0);
  }

  private weightFile(file: string, intent: IntentAnalysis): number {
    const low = String(file || "").toLowerCase();
    let score = 0.5;
    for (const entity of intent.entities) {
      if (low.includes(entity.toLowerCase())) score += 0.1;
    }
    if (/\.(spec|test)\./i.test(file)) score -= 0.08;
    return score;
  }

  private weightEntity(entity: { kind: string; name: string; location: string }, intent: IntentAnalysis): number {
    const text = `${entity.name} ${entity.location}`.toLowerCase();
    let score = 0.35;
    for (const token of intent.entities) {
      if (text.includes(token.toLowerCase())) score += 0.1;
    }
    if (/service|controller|module|component|view/i.test(entity.kind)) score += 0.08;
    return score;
  }
}

