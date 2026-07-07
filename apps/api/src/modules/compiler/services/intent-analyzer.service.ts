import { Injectable } from "@nestjs/common";
import { IntentAnalysis } from "../types/compiler.types.js";

@Injectable()
export class IntentAnalyzerService {
  analyze(taskInput: string): IntentAnalysis {
    const task = String(taskInput || "").trim();
    const lower = task.toLowerCase();

    const askPatterns = [
      /\bкак работает\b/i,
      /\bпочему\b/i,
      /\bгде используется\b/i,
      /\bчто изменилось\b/i,
      /\bкакие файлы\b/i,
      /\bкакие тесты\b/i,
      /\bwhere used\b/i,
      /\bwhat changed\b/i,
      /\bwhy\b/i,
      /\bhow does\b/i,
    ];
    const implementationPatterns = [
      /\bисправ(ь|ить)\b/i,
      /\bдобав(ь|ить)\b/i,
      /\bреализ(уй|овать)\b/i,
      /\bсозда(й|ть)\b/i,
      /\bupdate\b/i,
      /\bfix\b/i,
      /\bimplement\b/i,
      /\brefactor\b/i,
    ];
    const diagnosticsPatterns = [
      /\bкод не пиш(и|ите)\b/i,
      /\bтолько провер(ь|ить)\b/i,
      /\bнайди причин(у|ы)\b/i,
      /\bдиагност/i,
      /\broot cause\b/i,
      /\binvestigate\b/i,
    ];
    const researchPatterns = [
      /\bпроанализируй\b/i,
      /\bисследуй\b/i,
      /\bдай мнение\b/i,
      /\bсравни\b/i,
      /\bresearch\b/i,
      /\bopinion\b/i,
      /\bcompare\b/i,
    ];
    const impactPatterns = [
      /\bкакие файлы затронет\b/i,
      /\bimpact\b/i,
      /\bblast radius\b/i,
      /\bчто затронет\b/i,
    ];
    const dependencyPatterns = [
      /\bгде используется\b/i,
      /\bзависимост/i,
      /\bdependencies\b/i,
      /\bused by\b/i,
    ];
    const testPatterns = [
      /\bкакие тесты\b/i,
      /\bкакие команды тест/i,
      /\btests to run\b/i,
      /\btest plan\b/i,
    ];
    const statusPatterns = [
      /\bчто изменилось\b/i,
      /\bпоследние коммиты\b/i,
      /\bgit status\b/i,
      /\bgit diff\b/i,
    ];

    const reasons: string[] = [];
    const entities = this.extractEntities(task);

    const askHit = askPatterns.some((pattern) => pattern.test(lower));
    const implHit = implementationPatterns.some((pattern) => pattern.test(lower));
    const diagHit = diagnosticsPatterns.some((pattern) => pattern.test(lower));
    const researchHit = researchPatterns.some((pattern) => pattern.test(lower));
    const impactHit = impactPatterns.some((pattern) => pattern.test(lower));
    const depHit = dependencyPatterns.some((pattern) => pattern.test(lower));
    const testHit = testPatterns.some((pattern) => pattern.test(lower));
    const statusHit = statusPatterns.some((pattern) => pattern.test(lower));

    if (implHit && !askHit) {
      reasons.push("Detected implementation verbs.");
      return {
        mode: "build",
        intentType: diagHit ? "diagnostics" : researchHit ? "research" : "implementation",
        confidence: diagHit || researchHit ? 0.85 : 0.92,
        reasons,
        entities,
      };
    }

    if (impactHit) {
      reasons.push("Detected impact analysis query.");
      return {
        mode: "ask",
        intentType: "impact_question",
        confidence: 0.93,
        reasons,
        entities,
      };
    }
    if (depHit) {
      reasons.push("Detected dependency query.");
      return {
        mode: "ask",
        intentType: "dependency_question",
        confidence: 0.91,
        reasons,
        entities,
      };
    }
    if (testHit) {
      reasons.push("Detected test scope query.");
      return {
        mode: "ask",
        intentType: "test_question",
        confidence: 0.9,
        reasons,
        entities,
      };
    }
    if (statusHit) {
      reasons.push("Detected project status query.");
      return {
        mode: "ask",
        intentType: "status_question",
        confidence: 0.88,
        reasons,
        entities,
      };
    }

    if (diagHit) {
      reasons.push("Diagnostics markers without explicit implementation.");
      return {
        mode: "build",
        intentType: "diagnostics",
        confidence: 0.82,
        reasons,
        entities,
      };
    }

    if (researchHit || askHit || this.looksLikeQuestion(task)) {
      reasons.push("Detected informational / question-style intent.");
      return {
        mode: "ask",
        intentType: "research",
        confidence: 0.8,
        reasons,
        entities,
      };
    }

    reasons.push("Fallback to build mode for actionable task.");
    return {
      mode: "build",
      intentType: "implementation",
      confidence: 0.68,
      reasons,
      entities,
    };
  }

  private looksLikeQuestion(task: string): boolean {
    return /\?|^\s*(как|почему|где|что|какие|зачем)\b/i.test(task);
  }

  private extractEntities(task: string): string[] {
    return Array.from(
      new Set(
        String(task || "")
          .split(/[\s,.;:!?()[\]{}"'`]+/)
          .map((token) => token.trim())
          .filter((token) => token.length > 2)
          .filter((token) => /[a-zа-я0-9_/.-]/i.test(token))
          .slice(0, 16),
      ),
    );
  }
}

