import { stableId, type ResearchReport, type ValidationResult } from "@client/shared";
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
}

export interface CrawlUnitResult {
  featureSummary: string;
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
  ].join(" ");

  const raw = await runAgenticLoop({
    task,
    projectRootPath: input.projectRootPath,
    researcherModel: input.observerModel,
    criticModel: input.criticModel,
    providerBaseUrl: input.providerBaseUrl,
    providerApiKey: input.providerApiKey,
    ...(input.maxTurns ? { maxTurns: input.maxTurns } : {}),
  });

  const featureSummary = raw.finalAnswer
    ?? `Обход не завершился выводом (${raw.stopped}${raw.error ? `: ${raw.error}` : ""}).`;
  const confidence = raw.stopped !== "final_answer"
    ? 25
    : raw.criticVerdict === "approved"
      ? 75
      : 55;

  return { featureSummary, touchedFiles: raw.touchedFiles, confidence, raw };
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
  };

  const raw = await runAgenticLoop(options);

  return {
    research: toResearchReport(runId, input.task, raw),
    validation: toValidationResult(runId, raw),
    raw,
  };
}
