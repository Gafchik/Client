import { extractSectionBullets, extractSectionText, parseMarkdownSections, stableId, type ResearchReport, type ValidationResult } from "@client/shared";
import { toResearchReport, toValidationResult } from "./adapter.js";
import { runAgenticLoop, type AgenticRunOptions, type AgenticRunResult } from "./loop.js";

export { runAgenticLoop, type AgenticRunOptions, type AgenticRunResult } from "./loop.js";
export { toResearchReport, toValidationResult } from "./adapter.js";
export * from "./tools.js";
export { listWorkUnits } from "./worklist.js";

export interface CrawlUnitInput {
  projectRootPath: string;
  unitPath: string;
  observerModel: string;
  criticModel: string;
  providerBaseUrl: string;
  providerApiKey: string;
  maxTurns?: number;
  shouldAbort?: () => boolean;
}

export interface CrawlUnitResult {
  featureSummary: string;
  keyMechanisms: string[];
  gotchas: string[];
  touchedFiles: string[];
  confidence: number;
  raw: AgenticRunResult;
}

// Observer's task is deliberately open-ended-but-scoped: unlike a user
// question (find THE answer), this is "describe this one unit well enough
// to save the next Researcher time" - the finite worklist item (one
// directory) is what gives it an objective stopping point, not a turn
// budget or a nudge.
export async function crawlUnit(input: CrawlUnitInput): Promise<CrawlUnitResult> {
  const task = [
    `Опиши бизнес-логику директории "${input.unitPath}" для другого разработчика, который впервые сюда зайдёт.`,
    "Что она реализует, с какими другими модулями/директориями реально связана (по коду, не по догадке), и на что стоит обратить внимание — например, соседние директории с похожим именем, но другим назначением.",
    `Исследуй именно "${input.unitPath}" и то, что она реально использует - не весь проект целиком.`,
    // Structured output (2026-07-15) - previously the whole answer was one
    // flat paragraph, so business_graph_entries.key_mechanisms/gotchas (real
    // columns in the schema) were always saved empty. Reuses the same
    // "## Section Name" convention packages/ai's answer synthesizer already
    // uses (parseMarkdownSections/extractSectionBullets, moved to
    // packages/shared) instead of inventing a new format.
    "Ответь в формате: сначала \"## Резюме\" (2-3 предложения по сути), затем \"## Ключевые механизмы\" (маркированный список конкретных механизмов/поведений, до 5 пунктов), затем \"## Подводные камни\" (маркированный список того, на что разработчик может наткнуться неожиданно - до 5 пунктов, пустой список нормален если ничего примечательного не нашёл).",
  ].join(" ");

  const raw = await runAgenticLoop({
    task,
    projectRootPath: input.projectRootPath,
    researcherModel: input.observerModel,
    criticModel: input.criticModel,
    providerBaseUrl: input.providerBaseUrl,
    providerApiKey: input.providerApiKey,
    ...(input.maxTurns ? { maxTurns: input.maxTurns } : {}),
    ...(input.shouldAbort ? { shouldAbort: input.shouldAbort } : {}),
  });

  const confidence = raw.stopped !== "final_answer"
    ? 25
    : raw.criticVerdict === "approved"
      ? 75
      : 55;

  if (!raw.finalAnswer) {
    return {
      featureSummary: `Обход не завершился выводом (${raw.stopped}${raw.error ? `: ${raw.error}` : ""}).`,
      keyMechanisms: [],
      gotchas: [],
      touchedFiles: raw.touchedFiles,
      confidence,
      raw,
    };
  }

  const sections = parseMarkdownSections(raw.finalAnswer);
  const summaryFromSections = extractSectionText(sections, "Резюме");
  const keyMechanisms = extractSectionBullets(sections, "Ключевые механизмы", 5);
  const gotchas = extractSectionBullets(sections, "Подводные камни", 5);
  // Falls back to the raw answer verbatim when the model didn't follow the
  // "## Резюме" structure (e.g. an implicit-answer turn with no headings at
  // all) - a slightly messier hint beats silently losing the answer.
  const featureSummary = summaryFromSections || raw.finalAnswer;

  return { featureSummary, keyMechanisms, gotchas, touchedFiles: raw.touchedFiles, confidence, raw };
}

export interface RunAgenticResearchInput {
  runId?: string;
  task: string;
  projectRootPath: string;
  researcherModel: string;
  criticModel: string;
  providerBaseUrl: string;
  providerApiKey: string;
  maxTurns?: number;
  /** See AgenticRunOptions.priorTurnFiles - files already found in the previous turn of this conversation. */
  priorTurnFiles?: string[];
  /** See AgenticRunOptions.graphHintTerms - symbol names from the persisted code graph matching the task. */
  graphHintTerms?: string[];
}

export interface RunAgenticResearchResult {
  research: ResearchReport;
  validation: ValidationResult;
  raw: AgenticRunResult;
}

export async function runAgenticResearch(input: RunAgenticResearchInput): Promise<RunAgenticResearchResult> {
  const runId = input.runId ?? stableId(["agentic-research-run", input.task, input.projectRootPath, Date.now()]);
  const options: AgenticRunOptions = {
    task: input.task,
    projectRootPath: input.projectRootPath,
    researcherModel: input.researcherModel,
    criticModel: input.criticModel,
    providerBaseUrl: input.providerBaseUrl,
    providerApiKey: input.providerApiKey,
    ...(input.maxTurns ? { maxTurns: input.maxTurns } : {}),
    ...(input.priorTurnFiles?.length ? { priorTurnFiles: input.priorTurnFiles } : {}),
    ...(input.graphHintTerms?.length ? { graphHintTerms: input.graphHintTerms } : {}),
  };

  const raw = await runAgenticLoop(options);

  return {
    research: toResearchReport(runId, input.task, raw),
    validation: toValidationResult(runId, raw),
    raw,
  };
}
