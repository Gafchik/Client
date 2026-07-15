import { stableId, type ModuleIntentMatch, type ResearchReport, type ValidationResult } from "@client/shared";
import path from "node:path";
import type { AgenticRunResult } from "./loop.js";

const ROOT_SEGMENTS_TO_SKIP = new Set(["app", "src", "apps", "packages", "lib", "source"]);

// Heuristic module label from files actually touched during exploration -
// not a hardcoded domain-profile lookup (deliberately: that's the exact
// pattern this whole feature exists to escape). Picks the most common
// meaningful path segment across touched files.
function deriveDominantModule(touchedFiles: string[]): string {
  const counts = new Map<string, number>();

  for (const filePath of touchedFiles) {
    const segments = filePath.split("/").filter(Boolean);
    const candidate = segments.find((segment) => !ROOT_SEGMENTS_TO_SKIP.has(segment.toLowerCase()));

    if (candidate) {
      counts.set(candidate, (counts.get(candidate) ?? 0) + 1);
    }
  }

  let bestLabel = "";
  let bestCount = 0;

  for (const [label, count] of counts) {
    if (count > bestCount) {
      bestLabel = label;
      bestCount = count;
    }
  }

  return bestLabel || "не определён";
}

function deriveEntryPoints(touchedFiles: string[]): string[] {
  const entryLike = touchedFiles.filter((filePath) => /controller|action|route/i.test(filePath));
  return entryLike.length > 0 ? entryLike : touchedFiles.slice(0, 3);
}

function derivePrimaryEntities(touchedFiles: string[]): string[] {
  const entities = new Set<string>();

  for (const filePath of touchedFiles) {
    entities.add(path.basename(filePath, path.extname(filePath)));
  }

  return [...entities].slice(0, 12);
}

// intentClass/strategyKey/queryProfileKey are a closed union read
// exhaustively (with safe defaults, confirmed no `never`-assertions) all
// over packages/ai and packages/shared - reusing an existing, coherent
// triple keeps every downstream switch working unmodified instead of
// widening the union for one new producer.
const AGENTIC_INTENT_CLASS: ResearchReport["intentClass"] = "functional-flow";
const AGENTIC_STRATEGY_KEY: ResearchReport["strategyKey"] = "graph-functional-entrypoints";
const AGENTIC_QUERY_PROFILE_KEY: ResearchReport["queryProfileKey"] = "entrypoint-traversal";

export function toResearchReport(runId: string, task: string, result: AgenticRunResult): ResearchReport {
  const touchedFiles = result.touchedFiles;
  const dominantModule = deriveDominantModule(touchedFiles);
  const entryPoints = deriveEntryPoints(touchedFiles);
  const primaryEntities = derivePrimaryEntities(touchedFiles);

  const functionalSummary = result.finalAnswer
    ? result.finalAnswer
    : "Agentic-исследование не пришло к выводу в рамках бюджета шагов - конкретных подтверждённых фактов нет.";

  const moduleIntents: ModuleIntentMatch[] = dominantModule !== "не определён"
    ? [{
        module: dominantModule,
        score: touchedFiles.length * 100,
        reasons: ["Определено по файлам, реально просмотренным agentic-исследователем, а не по словарю доменов."],
        matchedFiles: touchedFiles,
      }]
    : [];

  const evidence = touchedFiles.map((filePath, index) => ({
    id: stableId(["agentic-evidence", runId, filePath]),
    label: path.basename(filePath),
    score: Math.max(10, 60 - index * 5),
    reason: "Файл реально открыт agentic-исследователем в ходе изучения вопроса (не по формальному текстовому совпадению).",
    filePath,
    origin: "structural" as const,
  }));

  const unknowns: string[] = [];

  if (result.stopped !== "final_answer") {
    unknowns.push("Agentic-исследование не завершилось финальным ответом в рамках бюджета шагов.");
  }

  if (result.criticVerdict === "rejected-budget-exhausted") {
    unknowns.push("Критик не одобрил ответ полностью, но бюджет доуточнений исчерпан.");
  }

  return {
    runId,
    task,
    summary: functionalSummary,
    researchMode: "agentic",
    intentClass: AGENTIC_INTENT_CLASS,
    strategyKey: AGENTIC_STRATEGY_KEY,
    queryProfileKey: AGENTIC_QUERY_PROFILE_KEY,
    functionalSummary,
    dominantModule,
    moduleIntents,
    entryPoints,
    primaryEntities,
    sideEffects: [],
    dataSources: [],
    // Deliberately NOT [finalAnswer] here: functionalSummary already carries
    // the full narrative, and packages/ai's answer template renders findings
    // as a SEPARATE "Что особенно важно" section after functionalSummary -
    // duplicating the same text into both produced a visibly repeated
    // paragraph in every agentic-mode deterministic-fallback answer (live
    // repro: 2026-07-15 "что мы знаем о юзере" conversation). findings is
    // meant to be distinct granular facts, which the agentic loop doesn't
    // produce as a separate structure - leaving it empty cleanly omits the
    // section instead of repeating the narrative.
    findings: [],
    baselineFindings: [],
    overlayFindings: [],
    evidence,
    evidenceSummary: {
      baselineCount: 0,
      overlayCount: 0,
      structuralCount: evidence.length,
      recalledCount: 0,
      conversationCount: 0,
      overlayInfluenced: false,
    },
    affectedModules: dominantModule !== "не определён" ? [dominantModule] : [],
    unknowns,
    confidence: deriveConfidence(result),
    references: touchedFiles,
  };
}

function deriveConfidence(result: AgenticRunResult): number {
  if (result.stopped !== "final_answer") {
    return 20;
  }

  switch (result.criticVerdict) {
    case "approved":
      return 85;
    case "rejected-once-then-accepted":
      return 65;
    case "rejected-budget-exhausted":
      return 45;
    default:
      return 40;
  }
}

// Team-mode's own critic gate (inside the agentic loop) already validated
// the answer before it was ever returned - this builds the minimal valid
// ValidationResult confirmed sufficient by review (buildAnswerPackage/
// buildValidatedAnswerPacket never touch gaps/contradictions/etc. beyond
// reading them) instead of re-running the deterministic validateEvidence
// loop a second time on top of an already-critiqued answer.
export function toValidationResult(runId: string, result: AgenticRunResult): ValidationResult {
  const readinessScore = deriveConfidence(result);
  const hasAnswer = result.stopped === "final_answer" && Boolean(result.finalAnswer);

  const status: ValidationResult["status"] = !hasAnswer
    ? "insufficient-evidence"
    : result.criticVerdict === "rejected-budget-exhausted"
      ? "partial-answer-allowed"
      : "ready-for-answer";

  const directAnswerFeasibility: ValidationResult["directAnswerFeasibility"] = !hasAnswer
    ? "blocked"
    : result.criticVerdict === "approved"
      ? "strong"
      : "partial";

  const evidenceSufficiency: ValidationResult["evidenceSufficiency"] = !hasAnswer
    ? "insufficient"
    : result.criticVerdict === "approved"
      ? "sufficient"
      : "partial";

  return {
    validationId: stableId(["agentic-validation", runId]),
    runId,
    iteration: 0,
    status,
    readinessScore,
    directAnswerFeasibility,
    evidenceSufficiency,
    contradictionLevel: "none",
    gaps: [],
    contradictions: [],
    missingConfirmations: [],
    recommendedActions: [],
    missingEntityHints: [],
    rationale: hasAnswer
      ? `Agentic-исследование (${result.turnsUsed} ходов) + критик: ${result.criticVerdict}.`
      : `Agentic-исследование не завершилось ответом (${result.stopped}${result.error ? `: ${result.error}` : ""}).`,
  };
}
