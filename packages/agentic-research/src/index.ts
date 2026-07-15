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
  // Translated to English (2026-07-16, user's request) - this text is never
  // shown to the human user directly (it feeds business_graph_entries, then
  // buildObserverHintSuffix's hint block for the live Researcher, which
  // re-labels it with its own Russian headers), so there is no Russian-output
  // requirement here the way there is for the interactive Researcher's
  // final_answer.
  const task = [
    `Describe the business logic of the directory "${input.unitPath}" for another developer coming here for the first time.`,
    "What it implements, which other modules/directories it is actually connected to (by code, not by guessing), and what to watch out for - e.g. neighboring directories with a similar name but a different purpose.",
    `Investigate specifically "${input.unitPath}" and what it actually uses - not the whole project.`,
    // Structured output (2026-07-15) - previously the whole answer was one
    // flat paragraph, so business_graph_entries.key_mechanisms/gotchas (real
    // columns in the schema) were always saved empty. Reuses the same
    // "## Section Name" convention packages/ai's answer synthesizer already
    // uses (parseMarkdownSections/extractSectionBullets, moved to
    // packages/shared) instead of inventing a new format.
    "Answer in this format: first \"## Summary\" (2-3 sentences on the substance), then \"## Key mechanisms\" (a bulleted list of concrete mechanisms/behaviors, up to 5 items), then \"## Gotchas\" (a bulleted list of things a developer might unexpectedly run into - up to 5 items, an empty list is fine if nothing noteworthy was found).",
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
  const summaryFromSections = extractSectionText(sections, "Summary");
  const keyMechanisms = extractSectionBullets(sections, "Key mechanisms", 5);
  const gotchas = extractSectionBullets(sections, "Gotchas", 5);
  // Falls back to the raw answer verbatim when the model didn't follow the
  // "## Summary" structure (e.g. an implicit-answer turn with no headings at
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
  /** See AgenticRunOptions.observerHint - kept separate from `task` so it never leaks into ResearchReport.task (the chat UI's "Задача" display). */
  observerHint?: string;
  /** See AgenticRunOptions.semanticSearch. */
  semanticSearch?: (query: string) => Promise<string>;
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
    ...(input.observerHint ? { observerHint: input.observerHint } : {}),
    ...(input.semanticSearch ? { semanticSearch: input.semanticSearch } : {}),
  };

  const raw = await runAgenticLoop(options);

  return {
    research: toResearchReport(runId, input.task, raw),
    validation: toValidationResult(runId, raw),
    raw,
  };
}
