import {
  type BackgroundProjectState,
  clamp,
  detectResearchAmbiguity,
  extractSectionBullets,
  extractSectionText,
  parseMarkdownSections,
  stableId,
  tokenize,
  type AnswerEvidenceHighlight,
  type AnswerMode,
  type AnswerPackage,
  type ContextPackage,
  type ControlledExecutionRuntime,
  type ExecutionPlan,
  type ExecutionPreview,
  type FocusedResearchRequest,
  type FocusedResearchResult,
  type GraphState,
  type ImpactReport,
  type ResearchReport,
  type ValidatedAnswerPacket,
  type ValidationPacket,
  type ValidationRecommendedAction,
  type ValidationRecommendedResearchProfile,
  type ValidationResult,
} from "@client/shared";

interface BuildControlledRuntimeInput {
  runId: string;
  research: ResearchReport;
  plan: ExecutionPlan;
  preview: ExecutionPreview;
}

interface BuildAnswerInput {
  runId: string;
  task: string;
  providerBaseUrl: string;
  providerModel: string;
  providerApiKey: string;
  research: ResearchReport;
  impact: ImpactReport;
  context: ContextPackage;
  plan: ExecutionPlan;
  preview: ExecutionPreview;
  runtime: ControlledExecutionRuntime;
  backgroundState?: BackgroundProjectState;
  validation?: ValidationResult;
  validatedAnswerPacket?: ValidatedAnswerPacket;
  /**
   * Последние реплики этого же диалога (task + прежний прямой ответ),
   * от старых к новым — нужно синтезатору, чтобы разрешать ссылки на
   * предыдущий вопрос ("при этом", "а если так", без повторения контекста).
   * Только для LLM-пути; deterministic fallback его не использует.
   */
  conversationTranscript?: Array<{ task: string; directAnswer: string }>;
  usage?: ProviderUsageAccumulator;
}

interface BuildValidationPacketInput {
  runId: string;
  task: string;
  research: ResearchReport;
  impact: ImpactReport;
  context: ContextPackage;
  graph: GraphState;
  diagnostics: string[];
  backgroundState?: BackgroundProjectState;
  iteration: number;
  priorActions: ValidationRecommendedAction[];
  remainingIterationBudget: number;
}

interface ValidateEvidenceInput {
  packet: ValidationPacket;
  providerBaseUrl: string;
  providerModel: string;
  providerApiKey: string;
  usage?: ProviderUsageAccumulator;
}

interface BuildValidatedAnswerPacketInput {
  runId: string;
  questionType: string;
  validation: ValidationResult;
  research: ResearchReport;
}

interface ProviderChatResponse {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}

// Mutable, passed by reference into whichever LLM-calling functions run
// during one pipeline run - a local instance per run (never module-level
// state), so concurrent runs never cross-contaminate each other's totals.
// Added 2026-07-15: the production pipeline had never tracked real token
// usage at all: every "how many tokens did that cost" question this
// project asked had to be answered by hand, in throwaway scripts, for the
// whole session before this.
export interface ProviderUsageAccumulator {
  promptTokens: number;
  completionTokens: number;
  callCount: number;
}

export function createUsageAccumulator(): ProviderUsageAccumulator {
  return { promptTokens: 0, completionTokens: 0, callCount: 0 };
}

export function summarizeProviderUsage(accumulator: ProviderUsageAccumulator): {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  callCount: number;
} {
  return {
    promptTokens: accumulator.promptTokens,
    completionTokens: accumulator.completionTokens,
    totalTokens: accumulator.promptTokens + accumulator.completionTokens,
    callCount: accumulator.callCount,
  };
}

function recordUsage(accumulator: ProviderUsageAccumulator | undefined, payload: ProviderChatResponse): void {
  if (!accumulator) {
    return;
  }

  accumulator.promptTokens += payload.usage?.prompt_tokens ?? 0;
  accumulator.completionTokens += payload.usage?.completion_tokens ?? 0;
  accumulator.callCount += 1;
}

interface ProviderValidatorResponse {
  validationStatus?: ValidationResult["status"];
  readinessScore?: number;
  directAnswerFeasibility?: ValidationResult["directAnswerFeasibility"];
  evidenceSufficiency?: ValidationResult["evidenceSufficiency"];
  contradictionLevel?: ValidationResult["contradictionLevel"];
  gapSummary?: string[];
  contradictions?: string[];
  missingConfirmations?: string[];
  recommendedActions?: string[];
  missingEntityHints?: string[];
  primaryEvidenceLabel?: string;
  recommendedResearchProfile?: ValidationRecommendedResearchProfile;
  recommendedStopReason?: string;
  rationale?: string;
}

type ClaimSupportLevel = "strong" | "moderate" | "weak";
type ClaimStatus = "supported" | "partial" | "rejected";
type ClaimType = "direct-answer" | "supporting" | "location" | "impact" | "plan" | "limitation";

interface QuestionContract {
  questionType: string;
  expectedAnswerShape: "yes-no" | "location" | "flow" | "configuration" | "diagnostic" | "impact" | "plan";
  proofObligations: string[];
  requiresImpact: boolean;
  requiresPlan: boolean;
}

interface ClaimCandidate {
  id: string;
  type: ClaimType;
  statement: string;
  evidence: string[];
  filePaths: string[];
  supportLevel: ClaimSupportLevel;
  status: ClaimStatus;
  caveats: string[];
}

interface ValidatedClaimSet {
  directClaim?: ClaimCandidate;
  supportingClaims: ClaimCandidate[];
  locationClaims: ClaimCandidate[];
  impactClaims: ClaimCandidate[];
  planClaims: ClaimCandidate[];
  limitationClaims: ClaimCandidate[];
  rejectedClaims: ClaimCandidate[];
}

interface AnswerBrief {
  questionContract: QuestionContract;
  claimSet: ValidatedClaimSet;
  directAnswer: string;
  explanationLead: string;
  whereToLook: string[];
  impactLines: string[];
  planLines: string[];
  materialUnknowns: string[];
}

const PROVIDER_REQUEST_TIMEOUT_MS = 25_000;
// Было 3 — но validateEvidence может вызываться до 3 раз за один run
// (initial + MAX_VALIDATION_REFINEMENT_ITERATIONS доуточнения, см.
// pipeline-runner.ts), и КАЖДЫЙ вызов сам по себе мог уйти в 3 попытки по
// 25с — в худшем случае почти 4 минуты retry на один интерактивный вопрос
// при деградации провайдера (живой репродукт: Nemotron/rout.my зависал
// именно так). 2 попытки всё ещё переживают единичный transient-сбой, но
// вдвое снижают worst-case задержку одного вызова.
const PROVIDER_MAX_ATTEMPTS = 2;
const PROVIDER_BASE_BACKOFF_MS = 1_200;
const VALIDATOR_MAX_ACTIONS = 3;
const VALIDATOR_HIGH_READINESS = 78;
const VALIDATOR_PARTIAL_READINESS = 58;
const VALIDATOR_MAX_GAPS = 4;
const VALIDATOR_MAX_CONTRADICTIONS = 3;

export function buildValidationPacket(input: BuildValidationPacketInput): ValidationPacket {
  const questionType = resolveQuestionType(input.task, input.research);
  const structuralAnchors = Array.from(
    new Set([
      ...input.research.entryPoints.slice(0, 5),
      ...input.research.primaryEntities.slice(0, 5),
      ...input.research.evidence
        .slice(0, 6)
        .map((item) => item.filePath ?? item.label)
        .filter(Boolean),
    ]),
  ).slice(0, 8);

  return {
    packetId: stableId(["validation-packet", input.runId, input.iteration]),
    runId: input.runId,
    iteration: input.iteration,
    task: input.task,
    questionType,
    researchSummary: input.research.summary,
    functionalSummary: input.research.functionalSummary,
    researchConfidence: input.research.confidence,
    impactSummary: input.impact.summary,
    impactConfidence: input.impact.confidence,
    contextSummary: input.context.summary,
    contextConfidence: input.context.confidence,
    structuralAnchors,
    evidenceHighlights: input.research.evidence.slice(0, 8).map((item) => ({
      label: item.label,
      ...(item.filePath ? { filePath: item.filePath } : {}),
      reason: item.reason,
      score: item.score,
      origin: item.origin,
    })),
    graphCoverage: {
      nodeCount: input.graph.summary.nodeCount,
      edgeCount: input.graph.summary.edgeCount,
      relevantAnchorCount: structuralAnchors.length,
      entryPointCount: input.research.entryPoints.length,
    },
    diagnostics: input.diagnostics,
    ...(input.backgroundState
      ? {
          backgroundState: {
            freshness: input.backgroundState.freshness,
            baselineSource: input.backgroundState.baselineSource,
            hasLocalChanges: input.backgroundState.hasLocalChanges,
            changedFileCount: input.backgroundState.changedFileCount,
          },
        }
      : {}),
    priorActions: input.priorActions,
    remainingIterationBudget: input.remainingIterationBudget,
  };
}

export async function validateEvidence(input: ValidateEvidenceInput): Promise<ValidationResult> {
  const fallback = buildDeterministicValidationResult(input.packet);
  const canUseProvider =
    input.providerBaseUrl.trim().length > 0
    && input.providerModel.trim().length > 0
    && input.providerApiKey.trim().length > 0;

  if (!canUseProvider) {
    return fallback;
  }

  try {
    const candidate = await synthesizeValidationWithProvider(input);
    return normalizeProviderValidationResult(candidate, input.packet, fallback);
  } catch {
    return fallback;
  }
}

export interface ExpandTaskSearchKeywordsInput {
  task: string;
  providerBaseUrl: string;
  providerModel: string;
  providerApiKey: string;
  usage?: ProviderUsageAccumulator;
}

// Детерминированный поиск (packages/research) — это substring/prefix/suffix
// сравнение токенов, плюс словарь фонетических заимствований техжаргона
// (роут->route, контроллер->controller). Он в принципе не может связать
// обычное русское слово с английским именем класса/директории в коде —
// "транспортировка" и "Transportation" не имеют ни одной общей буквенной
// подстроки, хотя семантически это одно и то же. Живой баг: вопрос про
// "транспортировку пациента" получил "такой сущности нет", хотя
// Transportation.php реально существует — просто ни разу не совпал ни с
// одним токеном вопроса. Это fallback ИМЕННО для слабого детерминированного
// сигнала (см. вызов в apps/api/pipeline-runner.ts) — не гоняется на каждый
// вопрос, только когда первый проход уже пришёл к broad-unknown/пустому
// dominantModule, чтобы не платить лишний LLM-вызов на вопросах, которые и
// так работают (auth/billing/locale — узкие, с сильным сигналом).
export async function expandTaskSearchKeywords(input: ExpandTaskSearchKeywordsInput): Promise<string[]> {
  const canUseProvider =
    input.providerBaseUrl.trim().length > 0
    && input.providerModel.trim().length > 0
    && input.providerApiKey.trim().length > 0;

  if (!canUseProvider) {
    return [];
  }

  try {
    const endpoint = `${input.providerBaseUrl.replace(/\/$/, "")}/chat/completions`;
    // Без `response_format: json_object` — часть моделей/роутеров (живой
    // пример: nvidia/nemotron-3-ultra через rout.my) отвечают 400 Bad Request
    // на строгий json-mode при коротком user-сообщении без видимой причины.
    // Просим JSON текстом в промпте и парсим терпимее (вырезаем `{...}` из
    // ответа на случай code-fence/лишнего текста вокруг).
    const response = await performProviderRequest(endpoint, input.providerApiKey, {
      model: input.providerModel,
      temperature: 0.1,
      messages: [
        {
          role: "system",
          content: [
            "You help build search terms for substring search over source code.",
            "The user asks an engineering question about a codebase, usually in Russian.",
            "The codebase usually names its entities with English words (classes, directories, fields, tables).",
            "Come up with up to 6 English words/short phrases - translations, synonyms, and common technical terms the entity or process from the question could be named in code.",
            "Do not answer the question itself. Do not invent specific class names for a specific project - only ordinary dictionary English words matching the meaning of the question.",
            "Reply with ONLY one line of JSON, no explanations, no markdown wrapping, in exactly this shape: {\"keywords\": string[]}.",
          ].join("\n"),
        },
        {
          role: "user",
          content: input.task,
        },
      ],
    });

    const payload = (await response.json()) as ProviderChatResponse;
    recordUsage(input.usage, payload);
    const content = extractProviderContent(payload);

    if (!content) {
      return [];
    }

    const jsonMatch = /\{[\s\S]*\}/.exec(content);

    if (!jsonMatch) {
      return [];
    }

    const parsed = JSON.parse(jsonMatch[0]) as { keywords?: unknown };

    if (!Array.isArray(parsed.keywords)) {
      return [];
    }

    return [...new Set(
      parsed.keywords
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter((item) => item.length >= 2 && item.length <= 40),
    )].slice(0, 6);
  } catch {
    return [];
  }
}

export interface ProjectScopeDirective {
  restricted: boolean;
  /** Labels to actually search - empty when restricted is false. */
  allowedLabels: string[];
}

// Cheap keyword pre-filter (2026-07-16, multi-path unification: user's
// explicit request to be able to say "don't touch backend"/"only in gui" in
// plain language) - most questions on a multi-repo project do NOT restrict
// scope, so this avoids the classifier LLM call entirely in the common case.
// Deliberately broad/generic (role-family words, not any one project's
// naming) - a literal match against the project's OWN registered path
// labels is checked separately by the caller before even reaching here.
const SCOPE_TRIGGER_PATTERN = /тольк|не трог|не мен|не пиш|не смотри|исключ|кроме|без\s|backend|frontend|бэкенд|бекенд|\bбэк\b|\bбек\b|фронт|десктоп|desktop|только/i;

function taskMentionsScopeTrigger(task: string, roots: Array<{ label: string }>): boolean {
  if (SCOPE_TRIGGER_PATTERN.test(task)) {
    return true;
  }

  const lowerTask = task.toLowerCase();
  return roots.some((root) => lowerTask.includes(root.label.toLowerCase()));
}

/**
 * Detects whether the user's own question restricts which physical repo(s)
 * of a multi-repo project should be searched ("не трогай бэкенд", "только в
 * gui", "разрабатываем только фронт") and resolves it to the actual root
 * labels to keep. A natural-language classifier call, not regex parsing -
 * negation scope and mixed include/exclude phrasing in one sentence
 * ("работаем только над фронтом, бэк не трогаем") are exactly the kind of
 * thing regex handles badly and an LLM handles for the cost of a few hundred
 * tokens. Only called at all when a cheap keyword pre-filter finds a
 * plausible trigger - most questions don't restrict scope, and single-repo
 * projects never need this (checked by the caller).
 */
export async function classifyProjectScopeDirective(input: {
  task: string;
  providerBaseUrl: string;
  providerModel: string;
  providerApiKey: string;
  roots: Array<{ label: string; role: string }>;
}): Promise<ProjectScopeDirective> {
  const noRestriction: ProjectScopeDirective = { restricted: false, allowedLabels: [] };

  if (input.roots.length <= 1 || !taskMentionsScopeTrigger(input.task, input.roots)) {
    return noRestriction;
  }

  try {
    const endpoint = `${input.providerBaseUrl.replace(/\/$/, "")}/chat/completions`;
    const rootsDescription = input.roots.map((root) => `"${root.label}" (role: ${root.role})`).join(", ");
    const response = await performProviderRequest(endpoint, input.providerApiKey, {
      model: input.providerModel,
      temperature: 0,
      messages: [
        {
          role: "system",
          content: [
            `This project has several physical repos, each with a short label and a role: ${rootsDescription}.`,
            "Decide whether the user's question explicitly restricts which of these repos should be searched/worked on - either by naming which one(s) to use exclusively (\"only in gui\", \"only work on the frontend\"), or by naming which one(s) to leave alone (\"don't touch the backend\").",
            "Reply with ONLY one line of JSON: {\"restricted\": boolean, \"allowedLabels\": string[]}.",
            "allowedLabels must always be the labels that SHOULD be searched - if the user says 'do not touch backend', allowedLabels is every OTHER label, not backend.",
            "If the question does not restrict scope at all (most questions don't, even ones that happen to mention a role in passing), reply {\"restricted\": false, \"allowedLabels\": []}.",
          ].join("\n"),
        },
        { role: "user", content: input.task },
      ],
    });
    const payload = (await response.json()) as ProviderChatResponse;
    const content = extractProviderContent(payload);
    const jsonMatch = content ? /\{[\s\S]*\}/.exec(content) : null;

    if (!jsonMatch) {
      return noRestriction;
    }

    const parsed = JSON.parse(jsonMatch[0]) as { restricted?: boolean; allowedLabels?: unknown };

    if (!parsed.restricted || !Array.isArray(parsed.allowedLabels)) {
      return noRestriction;
    }

    const validLabels = new Set(input.roots.map((root) => root.label));
    const allowedLabels = parsed.allowedLabels.filter((label): label is string => typeof label === "string" && validLabels.has(label));

    // Empty (misfired) or "everything" (no real restriction) both collapse
    // to "no restriction" - only a genuine, resolvable SUBSET counts.
    if (allowedLabels.length === 0 || allowedLabels.length === input.roots.length) {
      return noRestriction;
    }

    return { restricted: true, allowedLabels };
  } catch {
    return noRestriction;
  }
}

export interface DomainGlossaryTermCandidate {
  term: string;
  definition: string;
  relatedFiles: string[];
}

// Domain Glossary (2026-07-17, architecture review Tier 3): promoteFactsFromResearch
// (packages/knowledge/facts.ts) already writes to a persistent store, but its
// statement is built from evidence.reason - for agentic evidence that reason
// is always the SAME boilerplate line ("file was actually opened by the
// researcher"), never an actual business-meaning definition. This is a
// separate, purpose-built extraction over the research's own final answer
// text (already written in the conversational, business-facing style the
// answer synthesizer produces - see buildAnswerSystemPrompt) - it is the only
// good source of real domain meaning this pipeline currently produces.
export async function extractDomainGlossaryTerms(input: {
  answerText: string;
  evidenceFilePaths: string[];
  providerBaseUrl: string;
  providerModel: string;
  providerApiKey: string;
}): Promise<DomainGlossaryTermCandidate[]> {
  // Too short to plausibly contain a real definition (e.g. "не найдено" /
  // "нет доступа к файлу") - skip the call rather than risk the model
  // inventing a term to fill the response.
  if (input.answerText.trim().length < 80) {
    return [];
  }

  try {
    const endpoint = `${input.providerBaseUrl.replace(/\/$/, "")}/chat/completions`;
    const response = await performProviderRequest(endpoint, input.providerApiKey, {
      model: input.providerModel,
      temperature: 0,
      messages: [
        {
          role: "system",
          content: [
            "You extract domain-glossary entries from a developer's answer about a specific codebase.",
            "A domain-glossary entry is a business/domain TERM (an entity, status, role, or concept actually named in this codebase - e.g. a model name, a field, a state value) paired with what it concretely MEANS in THIS project, based only on what the answer actually says.",
            "Do NOT invent terms the answer doesn't support. Do NOT write generic descriptions of what a file or class does structurally (\"this class handles X\") - write what the TERM means from a business standpoint (\"an X is a Y that can only ...\").",
            "Skip this entirely if the answer contains no real domain term worth remembering (e.g. it's about tooling, config, or a pure bug/typo) - return an empty array rather than force one.",
            "Reply with ONLY one line of JSON: {\"terms\": [{\"term\": string, \"definition\": string}]}. Up to 3 entries. definition is one sentence, in Russian, standalone (understandable without re-reading the question).",
          ].join("\n"),
        },
        { role: "user", content: input.answerText.slice(0, 4000) },
      ],
    });
    const payload = (await response.json()) as ProviderChatResponse;
    const content = extractProviderContent(payload);
    const jsonMatch = content ? /\{[\s\S]*\}/.exec(content) : null;

    if (!jsonMatch) {
      return [];
    }

    const parsed = JSON.parse(jsonMatch[0]) as { terms?: unknown };

    if (!Array.isArray(parsed.terms)) {
      return [];
    }

    return parsed.terms
      .filter((entry): entry is { term: unknown; definition: unknown } => typeof entry === "object" && entry !== null)
      .map((entry) => ({
        term: typeof entry.term === "string" ? entry.term.trim() : "",
        definition: typeof entry.definition === "string" ? entry.definition.trim() : "",
        relatedFiles: input.evidenceFilePaths.slice(0, 5),
      }))
      .filter((entry) => entry.term.length >= 2 && entry.term.length <= 60 && entry.definition.length >= 10)
      .slice(0, 3);
  } catch {
    return [];
  }
}

// Belief reconciliation (2026-07-17, architecture review Tier 3): the Fact
// Store dedupes by exact statement text (stableId hash of the normalized
// string) - two DIFFERENTLY-WORDED facts about the same file(s) that
// actually contradict each other (e.g. "email validation happens inline in
// the controller" vs "email validation is delegated to a FormRequest") were
// previously just two unrelated "fresh" rows, both handed to the Researcher
// with no signal they might be in tension. This is the classification half
// of that fix - facts.ts's promoteFactsFromResearch calls it (via an
// injected callback, to keep packages/knowledge free of any LLM-calling
// code) only when a new candidate fact shares a file with an existing one
// and the two statements aren't near-identical text to begin with.
export async function classifyFactConflict(input: {
  existingStatement: string;
  candidateStatement: string;
  providerBaseUrl: string;
  providerModel: string;
  providerApiKey: string;
}): Promise<boolean> {
  try {
    const endpoint = `${input.providerBaseUrl.replace(/\/$/, "")}/chat/completions`;
    const response = await performProviderRequest(endpoint, input.providerApiKey, {
      model: input.providerModel,
      temperature: 0,
      messages: [
        {
          role: "system",
          content: [
            "You compare two short factual statements about the same source file(s) in a codebase.",
            "Reply {\"conflict\": true} only if they make genuinely INCOMPATIBLE claims about the same behavior (one says X happens, the other says X does not happen / something contradictory happens instead).",
            "Reply {\"conflict\": false} if they are simply about different aspects of the file, or one is more specific/detailed than the other without contradicting it - most pairs are this case.",
            "Reply with ONLY one line of JSON: {\"conflict\": boolean}.",
          ].join("\n"),
        },
        { role: "user", content: `Statement A (existing): ${input.existingStatement}\nStatement B (new): ${input.candidateStatement}` },
      ],
    });
    const payload = (await response.json()) as ProviderChatResponse;
    const content = extractProviderContent(payload);
    const jsonMatch = content ? /\{[\s\S]*\}/.exec(content) : null;

    if (!jsonMatch) {
      return false;
    }

    const parsed = JSON.parse(jsonMatch[0]) as { conflict?: unknown };
    return parsed.conflict === true;
  } catch {
    return false;
  }
}

export interface EmbedTextsInput {
  providerBaseUrl: string;
  providerApiKey: string;
  embeddingModel: string;
  texts: string[];
}

// Added 2026-07-16 as part of the semantic code search feature (embeddings
// index, packages/knowledge's code-embeddings.ts) - rout.my's /embeddings
// endpoint is a standard OpenAI-compatible shape (confirmed live:
// {data: [{embedding, index}], usage}), so this reuses performProviderRequest
// exactly like the chat/completions calls above rather than a bespoke client.
export async function embedTexts(input: EmbedTextsInput): Promise<number[][]> {
  if (input.texts.length === 0) {
    return [];
  }

  const endpoint = `${input.providerBaseUrl.replace(/\/$/, "")}/embeddings`;
  const response = await performProviderRequest(endpoint, input.providerApiKey, {
    model: input.embeddingModel,
    input: input.texts,
  });

  const payload = (await response.json()) as { data?: Array<{ embedding?: number[]; index?: number }> };
  const rows = [...(payload.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));

  return rows.map((row) => row.embedding ?? []);
}

export function buildValidatedAnswerPacket(input: BuildValidatedAnswerPacketInput): ValidatedAnswerPacket {
  return {
    packetId: stableId(["validated-answer-packet", input.runId, input.validation.validationId]),
    runId: input.runId,
    questionType: input.questionType,
    validationStatus: input.validation.status,
    readinessScore: input.validation.readinessScore,
    confidenceCeiling: clamp(input.validation.readinessScore, 15, 95),
    directAnswerAllowed:
      input.validation.status === "ready-for-answer"
      || input.validation.status === "partial-answer-allowed",
    mandatoryCaveats: [
      ...input.validation.gaps
        .filter((gap) => gap.severity !== "low")
        .map((gap) => gap.label),
      ...input.validation.missingConfirmations.slice(0, 2),
    ].slice(0, 4),
    validatedEvidence: applyPrimaryEvidenceOrder(input.research.evidence, input.validation.primaryEvidenceLabel)
      .slice(0, 6)
      .map((item) => ({
        label: item.label,
        ...(item.filePath ? { filePath: item.filePath } : {}),
        reason: item.reason,
        origin: item.origin,
      })),
    validatorRationale: input.validation.rationale,
  };
}

// Ретрив находит кандидатов и расставляет их по structural score — это
// работа алгоритма. Если валидатор (LLM) прямо назвал, какой из НАЙДЕННЫХ
// кандидатов реально отвечает на вопрос по смыслу, этот выбор должен
// перевешивать формальный порядок сортировки, а не теряться где-то в
// середине списка. Без primaryEvidenceLabel порядок не меняется вообще.
function applyPrimaryEvidenceOrder<T extends { label: string }>(evidence: T[], primaryEvidenceLabel: string | undefined): T[] {
  if (!primaryEvidenceLabel) {
    return evidence;
  }

  const primaryIndex = evidence.findIndex((item) => item.label === primaryEvidenceLabel);

  if (primaryIndex <= 0) {
    return evidence;
  }

  const primary = evidence[primaryIndex];

  if (!primary) {
    return evidence;
  }

  return [primary, ...evidence.slice(0, primaryIndex), ...evidence.slice(primaryIndex + 1)];
}

export function buildControlledExecutionRuntime(input: BuildControlledRuntimeInput): ControlledExecutionRuntime {
  const allowedWriteFiles = input.plan.targetFiles.slice(0, 12);
  const blockedWriteZones = deriveBlockedWriteZones(input.plan.targetFiles);
  const scopeGuards = buildScopeGuards(input);
  const approvalChecks = buildApprovalChecks(input);
  const refreshPlan = buildRefreshPlan(input.preview, input.research);
  const status = determineRuntimeStatus(input, allowedWriteFiles);

  return {
    runtimeId: stableId(["controlled-runtime", input.runId]),
    runId: input.runId,
    mode: "controlled-runtime",
    status,
    summary: buildRuntimeSummary(status, allowedWriteFiles, blockedWriteZones, approvalChecks),
    allowedWriteFiles,
    blockedWriteZones,
    scopeGuards,
    approvalChecks,
    refreshPlan,
    executionAllowed: false,
  };
}

function buildDeterministicValidationResult(packet: ValidationPacket): ValidationResult {
  const evidenceQualityScore = computeEvidenceQualityScore(packet);
  const graphCoverageScore = computeGraphCoverageScore(packet);
  const diagnosticsPenalty = computeDiagnosticsPenalty(packet.diagnostics);
  const freshnessPenalty = computeFreshnessPenalty(packet);
  const contradictionLevel = detectContradictionLevel(packet);
  const contradictions = buildValidationContradictions(packet, contradictionLevel);
  const gaps = buildValidationGaps(packet, contradictionLevel);
  const missingConfirmations = buildMissingConfirmations(packet);

  let readinessScore = clamp(
    Math.round(
      evidenceQualityScore
      + graphCoverageScore
      - diagnosticsPenalty
      - freshnessPenalty
      - (contradictionLevel === "major" ? 18 : contradictionLevel === "minor" ? 8 : 0),
    ),
    12,
    96,
  );

  const evidenceSufficiency =
    readinessScore >= VALIDATOR_HIGH_READINESS
      ? "sufficient"
      : readinessScore >= VALIDATOR_PARTIAL_READINESS
        ? "partial"
        : "insufficient";
  const directAnswerFeasibility =
    readinessScore >= VALIDATOR_HIGH_READINESS
      ? "strong"
      : readinessScore >= VALIDATOR_PARTIAL_READINESS
        ? "partial"
        : "blocked";
  const recommendedActions = buildRecommendedActions(packet, gaps, contradictionLevel);
  const recommendedResearchProfile = resolveRecommendedResearchProfile(packet, recommendedActions);
  const missingEntityHints = buildMissingEntityHints(packet);
  const status = resolveValidationStatus({
    packet,
    readinessScore,
    contradictionLevel,
    evidenceSufficiency,
    directAnswerFeasibility,
    recommendedActions,
    missingEntityHints,
  });

  if (status === "ready-for-answer" && packet.questionType === "existence" && packet.evidenceHighlights.length >= 2) {
    readinessScore = Math.max(readinessScore, 82);
  }

  return {
    validationId: stableId(["validation-result", packet.runId, packet.iteration]),
    runId: packet.runId,
    iteration: packet.iteration,
    status,
    readinessScore,
    directAnswerFeasibility,
    evidenceSufficiency,
    contradictionLevel,
    gaps: gaps.slice(0, VALIDATOR_MAX_GAPS),
    contradictions: contradictions.slice(0, VALIDATOR_MAX_CONTRADICTIONS),
    missingConfirmations: missingConfirmations.slice(0, 4),
    recommendedActions: recommendedActions.slice(0, VALIDATOR_MAX_ACTIONS),
    missingEntityHints,
    ...(recommendedResearchProfile ? { recommendedResearchProfile } : {}),
    ...(status === "insufficient-evidence" || status === "validator-unavailable"
      ? {
          recommendedStopReason:
            status === "insufficient-evidence"
              ? "Focused refinement в рамках доступного бюджета не обещает достаточного усиления evidence."
              : "Validator недоступен, используется degraded path.",
        }
      : {}),
    rationale: buildValidationRationale(packet, readinessScore, contradictionLevel, gaps, missingConfirmations, status),
  };
}

async function synthesizeValidationWithProvider(input: ValidateEvidenceInput): Promise<ProviderValidatorResponse> {
  const endpoint = `${input.providerBaseUrl.replace(/\/$/, "")}/chat/completions`;
  // Без `response_format: json_object` — как и в expandTaskSearchKeywords,
  // часть моделей/роутеров (живой пример: rout.my роутит nvidia/nemotron-3-ultra,
  // deepseek/deepseek-v4-pro и openai/gpt-5.4-mini на 400 Bad Request при
  // строгом json-mode, тогда как google/gemini-3.1-flash-lite его принимает)
  // отвечают 400 без объяснения причины. Из-за этого validateEvidence тихо
  // проваливался в deterministic fallback для этих моделей на КАЖДОМ вызове —
  // сама ошибка глоталась в validateEvidence(), так что LLM-путь валидатора
  // фактически не работал, а выглядело это как "всё ок, просто low confidence".
  // Просим JSON текстом в промпте и парсим терпимее (вырезаем `{...}` из
  // ответа на случай code-fence/лишнего текста вокруг), как в keyword-expansion.
  const response = await performProviderRequest(endpoint, input.providerApiKey, {
    model: input.providerModel,
    temperature: 0.1,
    messages: [
      {
        role: "system",
        content: [
          "You act as an engineering evidence validator.",
          "You do not answer the user and you do not research the project yourself.",
          "You only assess whether the artifacts already gathered are sufficient.",
          "Research confidence is not ground truth, it is only one input signal.",
          "The main question: does the gathered evidence actually answer THIS SPECIFIC question the user asked - not just something that looks similar by keywords.",
          "Return ONLY JSON, no explanations, no markdown wrapping, with fields validationStatus, readinessScore, directAnswerFeasibility, evidenceSufficiency, contradictionLevel, gapSummary, contradictions, missingConfirmations, recommendedActions, missingEntityHints, primaryEvidenceLabel, recommendedResearchProfile, recommendedStopReason, rationale.",
          "readinessScore - an integer from 0 to 100 (not a 0.0-1.0 fraction).",
          "gapSummary, contradictions, missingConfirmations, recommendedActions, missingEntityHints - ALWAYS a JSON array of strings, even for a single item or an empty list ([] in that case). Never return a single string instead of an array.",
          "recommendedActions - a closed vocabulary of general scenarios, do not invent values outside the allowed list.",
          "missingEntityHints - the opposite: free text in each array element. If the evidence misses the actual point of the question, name the specific entities/classes/files/concepts from the question that are missing from the evidence and worth searching for separately. Do not restrict yourself to any fixed list - write what genuinely needs to be found, in your own words or the exact name from the question. Empty array if the evidence already covers the question's substance.",
          "primaryEvidenceLabel - among the Evidence in the prompt, pick ONE item whose label answers the question most precisely by meaning, not by raw score (score is a match count, not question comprehension). This matters especially when several evidence items of the same type/domain look structurally similar (e.g. several different Model files) - a higher score alone does not mean it is the more correct one. Copy the label EXACTLY as written in Evidence. Leave empty if there is no clear candidate or all are roughly equivalent.",
        ].join("\n"),
      },
      {
        role: "user",
        content: buildValidationPrompt(input.packet),
      },
    ],
  });

  const payload = (await response.json()) as ProviderChatResponse;
  recordUsage(input.usage, payload);
  const content = extractProviderContent(payload);

  if (!content) {
    throw new Error("Provider returned empty validator answer");
  }

  const jsonMatch = /\{[\s\S]*\}/.exec(content);

  if (!jsonMatch) {
    throw new Error("Provider validator answer did not contain a JSON object");
  }

  return JSON.parse(jsonMatch[0]) as ProviderValidatorResponse;
}

// candidate.* string[] полями из провайдера мы доверять типу не можем — без
// строгого response_format-режима модели часто присылают одну строку вместо
// массива для "свободных" полей. Строка тоже валидный сигнал (один hint),
// просто её нужно завернуть в массив, а не уронить на `.filter`/`.map`.
function normalizeToStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }

  if (typeof value === "string" && value.trim().length > 0) {
    return [value];
  }

  return [];
}

function normalizeProviderValidationResult(
  candidate: ProviderValidatorResponse,
  packet: ValidationPacket,
  fallback: ValidationResult,
): ValidationResult {
  const validActions = new Set<ValidationRecommendedAction>([
    "run-entrypoint-traversal",
    "run-reverse-dependency-check",
    "run-call-chain-expansion",
    "run-inheritance-expansion",
    "run-interface-implementation-check",
    "check-middleware-chain",
    "check-route-controller-binding",
    "check-oauth-provider-binding",
    "check-runtime-locale-resolution",
    "check-history-guard-flow",
    "check-config-file",
    "check-env-fallback",
    "check-service-provider-registration",
    "check-framework-binding",
    "check-model-relation",
    "check-schema-touchpoints",
    "check-repository-usage",
    "check-db-storage-location",
    "narrow-to-entrypoint",
    "narrow-to-module",
    "narrow-to-runtime-path",
    "drop-noisy-neighbor-zone",
    "allow-partial-answer",
    "stop-with-insufficient-evidence",
    "request-background-refresh",
    "request-runtime-logs",
  ]);
  // candidate.* поля типизированы как string[] в ProviderValidatorResponse,
  // но это только TS-аннотация поверх JSON.parse — без строгого
  // response_format-режима (см. synthesizeValidationWithProvider) модели
  // регулярно присылают одну строку вместо массива на полях со свободным
  // текстом (наблюдалось на nemotron-3-ultra, deepseek-v4-pro, gpt-5.4-mini
  // через rout.my — конкретно на gapSummary и missingEntityHints). `.filter`/
  // `.map` на строке кидают TypeError, который ловится внешним catch в
  // validateEvidence() и откатывает ВЕСЬ результат на deterministic fallback —
  // то есть валидные LLM-поля (recommendedActions, contradictions и т.д.)
  // тоже терялись из-за одного нестрогого поля. normalizeToStringList терпит
  // оба варианта.
  const normalizedActions = normalizeToStringList(candidate.recommendedActions)
    .filter((item): item is ValidationRecommendedAction => validActions.has(item as ValidationRecommendedAction))
    .slice(0, VALIDATOR_MAX_ACTIONS);

  const next: ValidationResult = {
    ...fallback,
    status: isValidationStatus(candidate.validationStatus) ? candidate.validationStatus : fallback.status,
    readinessScore: clamp(Math.round(candidate.readinessScore ?? fallback.readinessScore), 12, 96),
    directAnswerFeasibility: isDirectAnswerFeasibility(candidate.directAnswerFeasibility)
      ? candidate.directAnswerFeasibility
      : fallback.directAnswerFeasibility,
    evidenceSufficiency: isEvidenceSufficiency(candidate.evidenceSufficiency)
      ? candidate.evidenceSufficiency
      : fallback.evidenceSufficiency,
    contradictionLevel: isContradictionLevel(candidate.contradictionLevel)
      ? candidate.contradictionLevel
      : fallback.contradictionLevel,
    gaps: normalizeToStringList(candidate.gapSummary)
      .filter(Boolean)
      .slice(0, VALIDATOR_MAX_GAPS)
      .map((gap, index) => ({
        id: stableId(["validation-gap", packet.runId, packet.iteration, index]),
        label: gap,
        severity: "medium" as const,
        reason: gap,
      })),
    contradictions: normalizeToStringList(candidate.contradictions)
      .filter(Boolean)
      .slice(0, VALIDATOR_MAX_CONTRADICTIONS)
      .map((item, index) => ({
        id: stableId(["validation-contradiction", packet.runId, packet.iteration, index]),
        label: item,
        severity: "medium" as const,
        reason: item,
      })),
    missingConfirmations: normalizeToStringList(candidate.missingConfirmations).filter(Boolean).slice(0, 4),
    recommendedActions: normalizedActions.length > 0 ? normalizedActions : fallback.recommendedActions,
    missingEntityHints: Array.from(
      new Set(
        normalizeToStringList(candidate.missingEntityHints)
          .map((hint) => hint.trim())
          .filter((hint) => hint.length >= 2),
      ),
    ).slice(0, 5),
    // Доверяем только точному совпадению с уже известным evidence — модель
    // не должна "изобретать" файл, которого не было в промпте.
    ...(candidate.primaryEvidenceLabel
      && packet.evidenceHighlights.some((item) => item.label === candidate.primaryEvidenceLabel)
      ? { primaryEvidenceLabel: candidate.primaryEvidenceLabel }
      : {}),
    ...(candidate.recommendedResearchProfile
      ? { recommendedResearchProfile: candidate.recommendedResearchProfile }
      : fallback.recommendedResearchProfile
        ? { recommendedResearchProfile: fallback.recommendedResearchProfile }
        : {}),
    ...(candidate.recommendedStopReason
      ? { recommendedStopReason: candidate.recommendedStopReason }
      : fallback.recommendedStopReason
        ? { recommendedStopReason: fallback.recommendedStopReason }
        : {}),
    rationale: candidate.rationale?.trim() || fallback.rationale,
  };

  // Подстраховка на случай, если модель сама себе противоречит: назвала
  // конкретную недостающую сущность, но при этом оставила статус
  // "ready-for-answer". missingEntityHints — это прямое утверждение "evidence
  // не покрывает вопрос", и оно должно перевешивать формальный статус.
  if (next.missingEntityHints.length > 0 && next.status === "ready-for-answer" && packet.remainingIterationBudget > 0) {
    next.status = "needs-focused-research";
  }

  return next;
}

export async function buildAnswerPackage(input: BuildAnswerInput): Promise<AnswerPackage> {
  const fallback = buildDeterministicAnswer(input);
  const evidenceLocked = shouldForceEvidenceLockedMode(input);

  // Diagnostic/баг-репорт вопросы законно задевают несколько модулей
  // одновременно (сам факт нескольких затронутых зон — улика, а не
  // неоднозначность) — поэтому evidence-locked проверяется первым и
  // побеждает: уточняющий вопрос имеет смысл только для "открытых"
  // вопросов без явного одного намерения, не для диагностики.
  if (!evidenceLocked) {
    const ambiguity = detectResearchAmbiguity(input.research);

    if (ambiguity.ambiguous) {
      const clarificationQuestion = buildClarificationQuestion(ambiguity.competingModules);

      return {
        ...fallback,
        answerMode: "clarification-needed",
        summary: clarificationQuestion,
        explanation: `## Уточните вопрос\n${clarificationQuestion}`,
        clarificationOptions: ambiguity.competingModules,
        synthesis: "deterministic-fallback",
      };
    }
  }

  const canUseProvider =
    !evidenceLocked
    && input.providerBaseUrl.trim().length > 0
    && input.providerModel.trim().length > 0
    && input.providerApiKey.trim().length > 0;

  if (!canUseProvider) {
    return fallback;
  }

  try {
    const llmAnswer = await synthesizeAnswerWithProvider(input, fallback);
    const validated = validateProviderAnswer(llmAnswer, input, fallback);
    const warnings = [
      ...fallback.warnings,
      ...validated.warnings,
    ].slice(0, 4);

    return {
      ...fallback,
      summary: validated.summary,
      explanation: validated.explanation,
      confirmedFacts: fallback.confirmedFacts,
      unconfirmedFacts: fallback.unconfirmedFacts,
      manualChecks: fallback.manualChecks,
      nextActions: validated.nextActions.length ? validated.nextActions : fallback.nextActions,
      warnings,
      synthesis: "llm",
      ...(input.validation ? { validation: input.validation } : {}),
      ...(input.validatedAnswerPacket ? { validatedAnswerPacket: input.validatedAnswerPacket } : {}),
      providerUsed: {
        baseUrl: input.providerBaseUrl,
        model: input.providerModel,
      },
    };
  } catch (error) {
    return {
      ...fallback,
      warnings: [
        ...fallback.warnings,
        buildProviderFallbackWarning(error),
      ].slice(0, 4),
    };
  }
}

/**
 * Полностью generic шаблон — без хардкода под конкретный проект. Сырые
 * module key (auth, billing и т.п.) сюда намеренно не подставляются —
 * человекочитаемые варианты уже показаны отдельными chip-кнопками на
 * фронте (getModuleLabel), незачем дублировать их английскими ключами
 * прямо в русской фразе.
 */
function buildClarificationQuestion(modules: string[]): string {
  return modules.length > 2
    ? "Вопрос сразу про несколько разных частей проекта — не уверен, какая именно тебя интересует. Уточни, о чём речь, или выбери вариант ниже."
    : "Тут не одна зона, а сразу пара — не уверен, какую ты имеешь в виду. Уточни, о какой именно речь, или выбери вариант ниже.";
}

function resolveQuestionType(task: string, research: ResearchReport): string {
  const normalized = task.toLowerCase();

  if (looksLikeChangeTask(task)) {
    return "plan";
  }

  if (looksLikeDiagnosticTask(task)) {
    return "diagnostic";
  }

  if (
    normalized.includes("конфиг")
    || normalized.includes("config")
    || normalized.includes("env")
    || normalized.includes("locale")
    || normalized.includes("локал")
  ) {
    return "configuration";
  }

  if (
    normalized.includes("есть")
    || normalized.includes("подключен")
    || normalized.includes("подключена")
    || normalized.includes("можно ли")
    || normalized.includes("is there")
    || normalized.includes("exists")
    || normalized.includes("oauth")
  ) {
    return "existence";
  }

  if (
    normalized.includes("где")
    || normalized.includes("where")
    || normalized.includes("используется")
    // "хран" — под "где хранится"/"что хранит", но это же substring
    // "сохранение"/"сохраняет"/"сохранить" (save) — совсем другой смысл:
    // не "где лежит", а "как проходит сам процесс сохранения". Без
    // исключения "расскажи как работает сохранение X" тоже уходил в
    // location и получал "вот файл" вместо разбора механизма.
    || (normalized.includes("хран") && !normalized.includes("сохран"))
    || normalized.includes("лежит")
  ) {
    return "location";
  }

  if (
    normalized.includes("как")
    || normalized.includes("how")
    || normalized.includes("flow")
    || research.queryProfileKey === "entrypoint-traversal"
  ) {
    return "flow";
  }

  if (
    normalized.includes("что затрон")
    || normalized.includes("impact")
    || normalized.includes("что слом")
  ) {
    return "impact";
  }

  if (
    normalized.includes("сравн")
    || normalized.includes("чем отличается")
    || normalized.includes("difference")
  ) {
    return "compare";
  }

  return "flow";
}

function buildQuestionContract(input: BuildAnswerInput): QuestionContract {
  const questionType = input.validatedAnswerPacket?.questionType ?? resolveQuestionType(input.task, input.research);

  switch (questionType) {
    case "existence":
      return {
        questionType,
        expectedAnswerShape: "yes-no",
        proofObligations: [
          "Нужен direct anchor существования механизма.",
          "Нужен supporting code location или entry point.",
        ],
        requiresImpact: false,
        requiresPlan: false,
      };
    case "location":
      return {
        questionType,
        expectedAnswerShape: "location",
        proofObligations: [
          "Нужен exact file/class/method location.",
          "Нельзя подменять location broad module summary.",
        ],
        requiresImpact: false,
        requiresPlan: false,
      };
    case "configuration":
      return {
        questionType,
        expectedAnswerShape: "configuration",
        proofObligations: [
          "Нужен runtime/config precedence or fallback source.",
          "Нужен config or middleware anchor правильного типа.",
        ],
        requiresImpact: false,
        requiresPlan: false,
      };
    case "diagnostic":
      return {
        questionType,
        expectedAnswerShape: "diagnostic",
        proofObligations: [
          "Нужна supported cause hypothesis или honest limitation.",
          "Нельзя выдавать adjacency за causality.",
        ],
        requiresImpact: true,
        requiresPlan: false,
      };
    case "impact":
      return {
        questionType,
        expectedAnswerShape: "impact",
        proofObligations: [
          "Нужен подтвержденный blast radius.",
          "Нужны concrete affected zones or files.",
        ],
        requiresImpact: true,
        requiresPlan: false,
      };
    case "plan":
      return {
        questionType,
        expectedAnswerShape: "plan",
        proofObligations: [
          "Нужен подтвержденный scope changes.",
          "Нужен reproducible step sequence.",
        ],
        requiresImpact: true,
        requiresPlan: true,
      };
    default:
      return {
        questionType,
        expectedAnswerShape: "flow",
        proofObligations: [
          "Нужен entry point or direct runtime/structural anchor.",
          "Нужна minimal causal chain.",
        ],
        requiresImpact: false,
        requiresPlan: false,
      };
  }
}

function getPrioritizedEvidence(input: BuildAnswerInput): ResearchReport["evidence"] {
  const localeBehavior = input.research.functionalSummary.toLowerCase().includes("runtime-поведению локализации");
  const task = input.task.toLowerCase();
  const locationQuestion = task.includes("где") || task.includes("where");
  const usageQuestion = task.includes("используется") || task.includes("use");
  const storageQuestion = input.research.queryProfileKey === "storage-topology";
  const filtered = input.research.evidence.filter((item) => {
    const filePath = (item.filePath ?? "").toLowerCase();
    return !(filePath.includes("/.vscode/") || filePath.startsWith(".vscode/") || filePath.endsWith("/.vscode/settings.json"));
  });

  const sorted = localeBehavior
    ? [...filtered].sort((left, right) => getLocaleEvidenceWeight(right) - getLocaleEvidenceWeight(left))
    : storageQuestion
      ? [...filtered].sort((left, right) => getStorageEvidenceWeight(right) - getStorageEvidenceWeight(left))
      : locationQuestion || usageQuestion
        ? [...filtered].sort((left, right) => getLocationEvidenceWeight(right) - getLocationEvidenceWeight(left))
        : filtered;

  // Что бы ни решила эвристика сортировки выше — явный выбор валидатора
  // (когда он есть) главнее: он смотрит на смысл вопроса, а не на структурные
  // сигналы вроде "это тоже файл модели".
  return applyPrimaryEvidenceOrder(sorted, input.validatedAnswerPacket?.validatedEvidence[0]?.label);
}

function getStorageEvidenceWeight(item: ResearchReport["evidence"][number]): number {
  const label = item.label.toLowerCase();
  const filePath = (item.filePath ?? "").toLowerCase();
  let score = item.score;

  if (filePath.includes("/models/") && (filePath.includes("server") || label.includes("server"))) score += 32;
  if (label.includes("credential") || label.includes("passphrase") || label.includes("private_key")) score += 26;
  if ((filePath.includes("/repositories/") || filePath.includes("/repository/")) && filePath.includes("server")) score += 28;
  if ((filePath.includes("/requests/") || filePath.includes("/dto/") || filePath.includes("/validators/")) && filePath.includes("server")) score += 26;
  if (filePath.includes("migrations") && (filePath.includes("server") || label.includes("migration"))) score += 24;
  if (filePath.includes("/observers/") || label.includes("observer")) score -= 60;

  return score;
}

function getLocationEvidenceWeight(item: ResearchReport["evidence"][number]): number {
  const label = item.label.toLowerCase();
  const filePath = (item.filePath ?? "").toLowerCase();
  let score = item.score;

  if (filePath.length > 0) score += 24;
  if (label.includes("migration") || label.includes("route") || label.includes("controller") || label.includes("model")) score += 8;
  if (filePath.includes("/.vscode/")) score -= 80;

  return score;
}

function buildClaimSet(input: BuildAnswerInput, contract: QuestionContract): ValidatedClaimSet {
  const strongestEvidence = getPrioritizedEvidence(input)[0];
  const caveats = input.validatedAnswerPacket?.mandatoryCaveats.slice(0, 2) ?? [];
  const directAnswerFromScenario = buildDirectAnswerFromScenario(input, contract, strongestEvidence);

  const directClaim: ClaimCandidate | undefined =
    input.validatedAnswerPacket?.directAnswerAllowed === false
      ? {
          id: stableId(["claim", input.runId, "direct-blocked"]),
          type: "direct-answer",
          statement: "Пока не хватает уверенных доказательств для прямого ответа.",
          evidence: caveats,
          filePaths: [],
          supportLevel: "weak",
          status: "partial",
          caveats,
        }
      : directAnswerFromScenario
        ? directAnswerFromScenario
        : input.research.functionalSummary.trim().length > 0
            ? {
                id: stableId(["claim", input.runId, "direct-functional"]),
                type: "direct-answer",
                statement: input.research.functionalSummary,
                evidence: strongestEvidence ? [strongestEvidence.label] : [],
                filePaths: strongestEvidence?.filePath ? [strongestEvidence.filePath] : [],
                supportLevel: strongestEvidence ? "moderate" : "weak",
                status: strongestEvidence ? "supported" : "partial",
                caveats,
              }
            : undefined;

  const supportingClaims = [
    ...input.research.findings.slice(0, 2).map((finding, index) => ({
      id: stableId(["claim", input.runId, "supporting-finding", index]),
      type: "supporting" as const,
      statement: finding,
      evidence: [finding],
      filePaths: [],
      supportLevel: "moderate" as const,
      status: "supported" as const,
      caveats: [],
    })),
  ].slice(0, 4);

  const locationClaims = getPrioritizedEvidence(input)
    .filter((item) => Boolean(item.filePath))
    .slice(0, 4)
    .map((item, index) => ({
      id: stableId(["claim", input.runId, "location", index]),
      type: "location" as const,
      statement: `${item.label}${item.reason ? ` — ${item.reason}` : ""}`,
      evidence: [item.label, item.reason].filter(Boolean),
      filePaths: item.filePath ? [item.filePath] : [],
      supportLevel: item.score >= 14 ? "strong" as const : "moderate" as const,
      status: "supported" as const,
      caveats: [],
    }));

  const impactClaims = contract.requiresImpact && input.impact.summary.trim().length > 0
    ? [{
        id: stableId(["claim", input.runId, "impact-summary"]),
        type: "impact" as const,
        statement: input.impact.summary,
        evidence: input.impact.affectedSymbols.slice(0, 3),
        filePaths: input.impact.affectedFiles
          .slice(0, 4)
          .map((item) => typeof item === "string" ? item : (item as { filePath?: string }).filePath ?? "")
          .filter(Boolean),
        supportLevel: input.impact.confidence >= 70 ? "strong" as const : "moderate" as const,
        status: "supported" as const,
        caveats: [],
      }]
    : [];

  const planClaims = contract.requiresPlan
    ? input.plan.steps.slice(0, 4).map((step, index) => ({
        id: stableId(["claim", input.runId, "plan", index]),
        type: "plan" as const,
        statement: step.title ?? step.description ?? `Шаг ${index + 1}`,
        evidence: [input.plan.summary],
        filePaths: input.plan.targetFiles.slice(index, index + 1),
        supportLevel: "moderate" as const,
        status: "supported" as const,
        caveats: [],
      }))
    : [];

  const limitationClaims = input.research.unknowns.slice(0, 3).map((item, index) => ({
    id: stableId(["claim", input.runId, "limitation", index]),
    type: "limitation" as const,
    statement: item,
    evidence: [item],
    filePaths: [],
    supportLevel: "weak" as const,
    status: "partial" as const,
    caveats: [],
  }));

  const rejectedClaims =
    input.validation?.status === "partial-answer-allowed" || input.validatedAnswerPacket?.directAnswerAllowed === false
      ? [{
          id: stableId(["claim", input.runId, "rejected-overclaim"]),
          type: "limitation" as const,
          statement: "Сильный окончательный claim намеренно не включён, потому что текущий evidence допускает только ограниченный ответ.",
          evidence: contract.proofObligations,
          filePaths: [],
          supportLevel: "weak" as const,
          status: "rejected" as const,
          caveats,
        }]
      : [];

  return {
    ...(directClaim ? { directClaim } : {}),
    supportingClaims,
    locationClaims,
    impactClaims,
    planClaims,
    limitationClaims,
    rejectedClaims,
  };
}

function buildDirectAnswerFromScenario(
  input: BuildAnswerInput,
  contract: QuestionContract,
  strongestEvidence: ResearchReport["evidence"][number] | undefined,
): ClaimCandidate | undefined {
  const task = input.task.toLowerCase();

  if (contract.questionType === "location" && strongestEvidence?.filePath) {
    const usageQuestion = task.includes("используется") || task.includes("use");
    return {
      id: stableId(["claim", input.runId, "direct-location"]),
      type: "direct-answer",
      statement: usageQuestion
        ? `Основные использования собраны вокруг \`${strongestEvidence.filePath}\`.`
        : `Главная точка для ответа находится в \`${strongestEvidence.filePath}\`.`,
      evidence: [strongestEvidence.label, strongestEvidence.reason].filter(Boolean),
      filePaths: [strongestEvidence.filePath],
      supportLevel: "strong",
      status: "supported",
      caveats: [],
    };
  }

  if (input.research.queryProfileKey === "storage-topology") {
    const topFiles = getPrioritizedEvidence(input)
      .filter((item) => Boolean(item.filePath))
      .slice(0, 3)
      .map((item) => item.filePath as string);

    if (topFiles.length > 0) {
      return {
        id: stableId(["claim", input.runId, "direct-storage"]),
        type: "direct-answer",
        statement: `Основная storage-цепочка подтверждается в ${topFiles.map((file) => `\`${file}\``).join(", ")}.`,
        evidence: topFiles,
        filePaths: topFiles,
        supportLevel: "strong",
        status: "supported",
        caveats: [],
      };
    }
  }

  return undefined;
}

function buildAnswerBrief(input: BuildAnswerInput, answerMode: AnswerMode): AnswerBrief {
  const questionContract = buildQuestionContract(input);
  const claimSet = buildClaimSet(input, questionContract);

  return {
    questionContract,
    claimSet,
    directAnswer: claimSet.directClaim?.statement ?? "Пока не хватает уверенных доказательств для прямого ответа.",
    explanationLead: claimSet.supportingClaims[0]?.statement ?? (input.research.functionalSummary || input.research.summary),
    whereToLook: claimSet.locationClaims.flatMap((claim) => claim.filePaths).slice(0, 6),
    impactLines: claimSet.impactClaims.map((claim) => claim.statement).slice(0, 3),
    planLines: claimSet.planClaims.map((claim) => claim.statement).slice(0, 4),
    materialUnknowns: claimSet.limitationClaims.map((claim) => claim.statement).slice(0, 4),
  };
}

function computeEvidenceQualityScore(packet: ValidationPacket): number {
  const highScoreEvidence = packet.evidenceHighlights.filter((item) => item.score >= 14).length;
  const fileAnchors = packet.evidenceHighlights.filter((item) => Boolean(item.filePath)).length;
  const originDiversity = new Set(packet.evidenceHighlights.map((item) => item.origin)).size;
  const anchorDensity = packet.structuralAnchors.length;
  const flowQuestionBoost =
    packet.questionType === "flow" && packet.graphCoverage.entryPointCount >= 2 && highScoreEvidence >= 3
      ? 12
      : 0;
  const locationQuestionBoost =
    packet.questionType === "location" && fileAnchors >= 3
      ? 10
      : 0;
  const existenceQuestionBoost =
    packet.questionType === "existence" && highScoreEvidence >= 2 && fileAnchors >= 2
      ? 8
      : 0;

  return (
    highScoreEvidence * 8
    + fileAnchors * 3
    + originDiversity * 4
    + Math.min(anchorDensity, 6) * 4
    + flowQuestionBoost
    + locationQuestionBoost
    + existenceQuestionBoost
  );
}

function computeGraphCoverageScore(packet: ValidationPacket): number {
  return (
    Math.min(packet.graphCoverage.relevantAnchorCount, 6) * 3
    + Math.min(packet.graphCoverage.entryPointCount, 4) * 4
    + (packet.graphCoverage.nodeCount > 0 ? 6 : 0)
  );
}

function computeDiagnosticsPenalty(diagnostics: string[]): number {
  if (diagnostics.length === 0) {
    return 0;
  }

  return Math.min(20, diagnostics.length * 4);
}

function computeFreshnessPenalty(packet: ValidationPacket): number {
  if (!packet.backgroundState) {
    return 6;
  }

  if (packet.backgroundState.freshness === "missing") {
    return 12;
  }

  if (packet.backgroundState.freshness === "stale") {
    return 8;
  }

  return packet.backgroundState.hasLocalChanges ? 3 : 0;
}

function detectContradictionLevel(packet: ValidationPacket): ValidationResult["contradictionLevel"] {
  const contradictionSignals = [
    packet.researchSummary.toLowerCase().includes("эврист"),
    packet.researchSummary.toLowerCase().includes("частично"),
    packet.functionalSummary.toLowerCase().includes("частично"),
    packet.backgroundState?.hasLocalChanges && packet.backgroundState.changedFileCount > 20,
    packet.diagnostics.length >= 3,
  ].filter(Boolean).length;

  if (contradictionSignals >= 3) {
    return "major";
  }

  if (contradictionSignals >= 2) {
    return "minor";
  }

  return "none";
}

function buildValidationContradictions(
  packet: ValidationPacket,
  level: ValidationResult["contradictionLevel"],
): ValidationResult["contradictions"] {
  if (level === "none") {
    return [];
  }

  const contradictions: ValidationResult["contradictions"] = [];

  if (packet.backgroundState?.hasLocalChanges && packet.backgroundState.changedFileCount > 20) {
    contradictions.push({
      id: stableId(["validation-contradiction", packet.runId, packet.iteration, "overlay"]),
      label: "Локальный worktree overlay существенно влияет на вывод.",
      severity: level === "major" ? "high" : "medium",
      reason: "Изменения в незакоммиченном состоянии могут конкурировать с committed baseline.",
    });
  }

  if (packet.diagnostics.length >= 3) {
    contradictions.push({
      id: stableId(["validation-contradiction", packet.runId, packet.iteration, "diagnostics"]),
      label: "Diagnostics снижают надёжность текущей картины.",
      severity: "medium",
      reason: "Indexer/graph diagnostics могут искажать полноту структурного покрытия.",
    });
  }

  return contradictions;
}

function buildValidationGaps(
  packet: ValidationPacket,
  contradictionLevel: ValidationResult["contradictionLevel"],
): ValidationResult["gaps"] {
  const gaps: ValidationResult["gaps"] = [];
  const normalizedTask = packet.task.toLowerCase();

  if (packet.evidenceHighlights.length < 2) {
    gaps.push({
      id: stableId(["validation-gap", packet.runId, packet.iteration, "evidence-count"]),
      label: "Недостаточно сильных evidence anchors.",
      severity: "high",
      reason: "Для уверенного direct answer найдено слишком мало подтверждений.",
    });
  }

  if (packet.questionType === "configuration" && !packet.structuralAnchors.some((anchor) => anchor.toLowerCase().includes("config") || anchor.toLowerCase().includes("middleware"))) {
    gaps.push({
      id: stableId(["validation-gap", packet.runId, packet.iteration, "config-anchor"]),
      label: "Нет прямого config/middleware подтверждения.",
      severity: "high",
      reason: "Для configuration-вопроса не хватает config/runtime anchor нужного типа.",
    });
  }

  if (packet.questionType === "existence" && packet.evidenceHighlights.length === 0) {
    gaps.push({
      id: stableId(["validation-gap", packet.runId, packet.iteration, "existence-direct"]),
      label: "Нет ни одного прямого подтверждения existence-вопроса.",
      severity: "high",
      reason: "Для yes/no вопроса нужен хотя бы один прямой code anchor.",
    });
  }

  if (packet.questionType === "flow" && packet.graphCoverage.entryPointCount === 0) {
    gaps.push({
      id: stableId(["validation-gap", packet.runId, packet.iteration, "entrypoint"]),
      label: "Не найдены явные entry points для flow-вопроса.",
      severity: "medium",
      reason: "Без entry point цепочка поведения остаётся частично восстановленной.",
    });
  }

  if (normalizedTask.includes("oauth") && !packet.structuralAnchors.some((anchor) => anchor.toLowerCase().includes("oauth") || anchor.toLowerCase().includes("google"))) {
    gaps.push({
      id: stableId(["validation-gap", packet.runId, packet.iteration, "oauth-anchor"]),
      label: "Нет явного OAuth/Google anchor.",
      severity: "medium",
      reason: "Для вопроса о Google OAuth стоит проверить provider/controller binding.",
    });
  }

  if (contradictionLevel === "major") {
    gaps.push({
      id: stableId(["validation-gap", packet.runId, packet.iteration, "contradiction-major"]),
      label: "Есть серьёзные противоречия в текущих материалах.",
      severity: "high",
      reason: "Нельзя переходить к уверенному ответу без локального уточнения картины.",
    });
  }

  return gaps;
}

function buildMissingConfirmations(packet: ValidationPacket): string[] {
  const confirmations: string[] = [];
  const normalizedTask = packet.task.toLowerCase();

  if (packet.questionType === "configuration" && normalizedTask.includes("locale")) {
    confirmations.push("Не хватает явного подтверждения runtime locale chain через middleware/config.");
  }

  if (packet.questionType === "existence" && normalizedTask.includes("oauth")) {
    confirmations.push("Не хватает прямого подтверждения route/controller/provider chain для OAuth.");
  }

  if (packet.questionType === "flow" && packet.graphCoverage.entryPointCount === 0) {
    confirmations.push("Не хватает подтверждённого entry point для начала flow.");
  }

  if (packet.diagnostics.length > 0) {
    confirmations.push("Нужно учитывать diagnostics indexer/graph перед окончательным выводом.");
  }

  return confirmations;
}

function buildRecommendedActions(
  packet: ValidationPacket,
  gaps: ValidationResult["gaps"],
  contradictionLevel: ValidationResult["contradictionLevel"],
): ValidationRecommendedAction[] {
  const actions: ValidationRecommendedAction[] = [];
  const normalizedTask = packet.task.toLowerCase();

  if (packet.backgroundState?.freshness === "missing" || packet.backgroundState?.freshness === "stale") {
    actions.push("request-background-refresh");
  }

  if (gaps.some((gap) => gap.label.includes("entry points")) || (packet.questionType === "flow" && packet.graphCoverage.entryPointCount === 0)) {
    actions.push("run-entrypoint-traversal");
  }

  if (packet.questionType === "configuration" && normalizedTask.includes("locale")) {
    actions.push("check-middleware-chain", "check-config-file");
  }

  if (packet.questionType === "existence" && normalizedTask.includes("oauth")) {
    actions.push("check-oauth-provider-binding", "check-route-controller-binding");
  }

  if (normalizedTask.includes("rollback") || normalizedTask.includes("ролбек")) {
    actions.push("check-history-guard-flow");
  }

  if (contradictionLevel !== "none") {
    actions.push("narrow-to-entrypoint");
  }

  if (gaps.length === 0 && packet.remainingIterationBudget <= 0) {
    actions.push("allow-partial-answer");
  }

  return Array.from(new Set(actions));
}

// Детерминированный fallback для missingEntityHints (без LLM). recommendedActions
// — это закрытый словарь общих сценариев ("проверь middleware", "проверь
// config"), а не конкретика вопроса. Здесь вместо этого просто ищем
// значимые слова из формулировки задачи, которых физически нет ни в одном
// filePath/label уже найденного evidence — то есть вопрос упоминает что-то,
// на что research пока не наткнулся вообще. LLM-путь (synthesizeValidationWithProvider)
// умеет то же самое, но по смыслу вопроса, а не по буквальному совпадению.
function buildMissingEntityHints(packet: ValidationPacket): string[] {
  const evidenceText = [
    ...packet.evidenceHighlights.flatMap((item) => [item.label, item.filePath ?? ""]),
    ...packet.structuralAnchors,
  ]
    .join(" ")
    .toLowerCase();
  // Код почти всегда именуется латиницей независимо от языка вопроса —
  // кириллические слова в русском вопросе почти всегда служебные/связующие
  // ("связаны", "обычной"), а не то, что реально можно найти в коде.
  // Без этого фильтра сюда попадает грамматический шум практически из
  // любого русскоязычного вопроса, и хинты становятся бесполезны.
  const candidateTokens = tokenize(packet.task).filter(
    (token) => token.length >= 4 && /^[a-z0-9_-]+$/.test(token),
  );

  return Array.from(new Set(candidateTokens))
    .filter((token) => !evidenceText.includes(token))
    .slice(0, 5);
}

function resolveRecommendedResearchProfile(
  packet: ValidationPacket,
  actions: ValidationRecommendedAction[],
): ValidationRecommendedResearchProfile | undefined {
  if (actions.includes("check-config-file") || actions.includes("check-env-fallback")) {
    return "focused-config-check";
  }

  if (
    actions.includes("check-middleware-chain")
    || actions.includes("check-oauth-provider-binding")
    || actions.includes("check-history-guard-flow")
  ) {
    return "focused-runtime-check";
  }

  if (
    actions.includes("run-call-chain-expansion")
    || actions.includes("run-reverse-dependency-check")
    || actions.includes("run-inheritance-expansion")
    || actions.includes("run-interface-implementation-check")
  ) {
    return "focused-dependency-check";
  }

  if (actions.includes("run-entrypoint-traversal") || actions.includes("narrow-to-entrypoint")) {
    return "focused-entrypoint-traversal";
  }

  if (packet.questionType === "configuration") {
    return "focused-config-check";
  }

  return undefined;
}

function resolveValidationStatus(input: {
  packet: ValidationPacket;
  readinessScore: number;
  contradictionLevel: ValidationResult["contradictionLevel"];
  evidenceSufficiency: ValidationResult["evidenceSufficiency"];
  directAnswerFeasibility: ValidationResult["directAnswerFeasibility"];
  recommendedActions: ValidationRecommendedAction[];
  missingEntityHints: string[];
}): ValidationResult["status"] {
  const questionTypeAllowsFastAnswer =
    input.packet.questionType === "flow"
    || input.packet.questionType === "location"
    || input.packet.questionType === "existence";
  const strongFastPathSignal =
    questionTypeAllowsFastAnswer
    && input.packet.evidenceHighlights.filter((item) => Boolean(item.filePath)).length >= 3
    && input.packet.graphCoverage.entryPointCount >= 1
    && input.packet.remainingIterationBudget > 0
    && input.missingEntityHints.length === 0
    && input.contradictionLevel === "none";

  if (input.contradictionLevel === "major") {
    return input.packet.remainingIterationBudget > 0 ? "needs-focused-research" : "contradictory-evidence";
  }

  // readinessScore меряет объём/качество evidence, но не то, отвечает ли оно
  // на РЕАЛЬНЫЙ вопрос — конкретную названную сущность readinessScore не
  // видит вообще. Если она найдена как явно отсутствующая, это перебивает
  // даже высокий score: уверенный ответ не по адресу хуже, чем ещё один
  // проход focused research.
  if (input.missingEntityHints.length > 0 && input.packet.remainingIterationBudget > 0) {
    return "needs-focused-research";
  }

  if (input.readinessScore >= VALIDATOR_HIGH_READINESS && input.directAnswerFeasibility === "strong") {
    return "ready-for-answer";
  }

  if (input.readinessScore >= VALIDATOR_PARTIAL_READINESS && input.directAnswerFeasibility !== "blocked") {
    if (strongFastPathSignal) {
      return "ready-for-answer";
    }

    return input.packet.remainingIterationBudget > 0 && input.recommendedActions.length > 0
      ? "needs-focused-research"
      : "partial-answer-allowed";
  }

  if (input.packet.remainingIterationBudget > 0 && input.recommendedActions.length > 0) {
    return "needs-focused-research";
  }

  return input.evidenceSufficiency === "partial"
    ? "partial-answer-allowed"
    : "insufficient-evidence";
}

function buildValidationRationale(
  packet: ValidationPacket,
  readinessScore: number,
  contradictionLevel: ValidationResult["contradictionLevel"],
  gaps: ValidationResult["gaps"],
  missingConfirmations: string[],
  status: ValidationResult["status"],
): string {
  const parts: string[] = [];

  parts.push(`Validator оценивает readiness независимо от upstream confidence; текущий readiness score ${readinessScore}.`);

  if (packet.researchConfidence >= 80 && readinessScore < VALIDATOR_PARTIAL_READINESS) {
    parts.push("Высокий Research confidence не принят как достаточное основание, потому что current evidence не закрывает ключевые подтверждения для этого типа вопроса.");
  }

  if (packet.researchConfidence < 60 && readinessScore >= VALIDATOR_HIGH_READINESS) {
    parts.push("Несмотря на сравнительно низкий Research confidence, для текущего вопроса найдено уже достаточно прямых anchors и quality evidence.");
  }

  if (contradictionLevel !== "none") {
    parts.push(`Обнаружен уровень противоречий: ${contradictionLevel}.`);
  }

  if (gaps.length > 0) {
    parts.push(`Ключевые gaps: ${gaps.slice(0, 2).map((gap) => gap.label).join(" | ")}.`);
  }

  if (missingConfirmations.length > 0) {
    parts.push(`Не хватает подтверждений: ${missingConfirmations.slice(0, 2).join(" | ")}.`);
  }

  if (status === "ready-for-answer") {
    parts.push("Текущий набор материалов достаточен для answer preparation.");
  } else if (status === "needs-focused-research") {
    parts.push("Есть локализуемый следующий refinement step, поэтому answer лучше отложить до focused research.");
  } else if (status === "partial-answer-allowed") {
    parts.push("Можно дать ограниченный ответ с caveats, но не стоит делать сильный final claim.");
  } else {
    parts.push("Надёжного основания для сильного ответа пока недостаточно.");
  }

  return parts.join(" ");
}

function buildValidationPrompt(packet: ValidationPacket): string {
  return [
    `Question: ${packet.task}`,
    `Question type: ${packet.questionType}`,
    `Research summary: ${packet.researchSummary}`,
    `Functional summary: ${packet.functionalSummary}`,
    `Research confidence signal: ${packet.researchConfidence}`,
    `Impact summary: ${packet.impactSummary}`,
    `Impact confidence signal: ${packet.impactConfidence}`,
    `Context summary: ${packet.contextSummary}`,
    `Context confidence signal: ${packet.contextConfidence}`,
    `Structural anchors: ${packet.structuralAnchors.join(" | ") || "(none)"}`,
    `Evidence: ${packet.evidenceHighlights.map((item) => `${item.label} :: ${item.reason} :: ${item.filePath ?? "?"} :: ${item.origin}`).join(" | ") || "(none)"}`,
    `Graph coverage: nodes=${packet.graphCoverage.nodeCount}, edges=${packet.graphCoverage.edgeCount}, anchors=${packet.graphCoverage.relevantAnchorCount}, entryPoints=${packet.graphCoverage.entryPointCount}`,
    `Diagnostics: ${packet.diagnostics.join(" | ") || "(none)"}`,
    packet.backgroundState
      ? `Background: freshness=${packet.backgroundState.freshness}, baselineSource=${packet.backgroundState.baselineSource}, localChanges=${packet.backgroundState.hasLocalChanges}, changedFiles=${packet.backgroundState.changedFileCount}`
      : "Background: (none)",
    `Prior actions: ${packet.priorActions.join(" | ") || "(none)"}`,
    `Remaining iteration budget: ${packet.remainingIterationBudget}`,
    "Evaluate whether current evidence is sufficient to answer the user. Do not inherit Research confidence automatically. Choose only allowed actions.",
  ].join("\n");
}

function isValidationStatus(value: unknown): value is ValidationResult["status"] {
  return [
    "ready-for-answer",
    "partial-answer-allowed",
    "needs-focused-research",
    "contradictory-evidence",
    "insufficient-evidence",
    "validator-unavailable",
  ].includes(String(value));
}

function isDirectAnswerFeasibility(value: unknown): value is ValidationResult["directAnswerFeasibility"] {
  return ["strong", "partial", "blocked"].includes(String(value));
}

function isEvidenceSufficiency(value: unknown): value is ValidationResult["evidenceSufficiency"] {
  return ["sufficient", "partial", "insufficient"].includes(String(value));
}

function isContradictionLevel(value: unknown): value is ValidationResult["contradictionLevel"] {
  return ["none", "minor", "major"].includes(String(value));
}

function determineRuntimeStatus(
  input: BuildControlledRuntimeInput,
  allowedWriteFiles: string[],
): ControlledExecutionRuntime["status"] {
  if (input.research.queryProfileKey === "broad-scan") {
    return "blocked";
  }

  if (allowedWriteFiles.length === 0) {
    return "blocked";
  }

  if (input.research.confidence < 45) {
    return "blocked";
  }

  return "ready-for-approval";
}

function buildRuntimeSummary(
  status: ControlledExecutionRuntime["status"],
  allowedWriteFiles: string[],
  blockedWriteZones: string[],
  approvalChecks: string[],
): string {
  return status === "ready-for-approval"
    ? `Controlled execution runtime подготовлен: ${allowedWriteFiles.length} файлов разрешены к изменению, ${blockedWriteZones.length} write-зон заблокированы, ${approvalChecks.length} approval checks обязательны.`
    : `Controlled execution runtime заблокирован: недостаточно уверенности или scope слишком широкий. Разрешённых файлов: ${allowedWriteFiles.length}, заблокированных write-зон: ${blockedWriteZones.length}.`;
}

function buildScopeGuards(input: BuildControlledRuntimeInput): string[] {
  const guards = [
    "Запрещено изменять файлы вне `plan.targetFiles`.",
    "Запрещено изменять модули вне `plan.targetModules` без повторного impact-анализа.",
    "Каждое изменение должно сохранять graph-backed dependency order из execution plan.",
    "После любого change batch обязательны reindex, graph refresh и knowledge refresh.",
  ];

  if (input.research.queryProfileKey === "storage-topology") {
    guards.push("Для storage-topology сначала подтверждаются schema/model/repository/request границы, затем только разрешается handoff на изменение.");
  }

  if (input.research.queryProfileKey === "config-inventory") {
    guards.push("Config-inventory не должен переходить в runtime mutation без отдельного уточнения целевого поведения.");
  }

  if (input.research.queryProfileKey === "localization-inventory") {
    guards.push("Localization-inventory не должен менять runtime handlers; допустимы только translation и related config зоны.");
  }

  if (input.research.queryProfileKey === "broad-scan") {
    guards.push("Broad-scan обязан остановиться до любой мутации и запросить narrower task definition.");
  }

  return guards;
}

function buildApprovalChecks(input: BuildControlledRuntimeInput): string[] {
  const checks = [
    "Подтвердить, что task соответствует текущему Research Report.",
    "Подтвердить, что file scope не выходит за Impact Report.",
    "Подтвердить, что execution plan остаётся воспроизводимым и детерминированным.",
  ];

  if (input.plan.risks.length > 0) {
    checks.push(`Подтвердить ключевые риски: ${input.plan.risks.slice(0, 2).join(" ")}`);
  }

  if (input.research.unknowns.length > 0) {
    checks.push("Подтвердить, что неизвестные зоны приняты человеком или устранены до execution.");
  }

  return checks;
}

function buildRefreshPlan(preview: ExecutionPreview, research: ResearchReport): string[] {
  const refreshPlan = [
    "Повторно выполнить индексирование после change batch.",
    "Пересобрать graph и сверить структурную сводку.",
    "Обновить knowledge artifact и историю запуска.",
  ];

  if (preview.reindexRequired) {
    refreshPlan.push("Reindex обязателен по preview contract.");
  }

  if (preview.graphRefreshRequired) {
    refreshPlan.push("Graph refresh обязателен по preview contract.");
  }

  if (preview.knowledgeRefreshRequired) {
    refreshPlan.push("Knowledge refresh обязателен по preview contract.");
  }

  if (research.queryProfileKey === "config-inventory") {
    refreshPlan.push("После config/env изменений дополнительно проверить актуальность configuration inventory.");
  }

  if (research.queryProfileKey === "localization-inventory") {
    refreshPlan.push("После localization changes дополнительно проверить полноту translation inventory.");
  }

  return refreshPlan;
}

// Generic never-write zones only (2026-07-16): раньше здесь были захардкожены
// "apps/web"/"apps/api" — раскладка ЭТОГО монорепо, утёкшая в shared-пакет и
// отображавшаяся как "заблокированные зоны" для чужих анализируемых проектов
// (Laravel-проект без apps/ вообще). Реальный write-контроль — это whitelist
// allowedWriteFiles; blockedWriteZones — универсальные табу любого проекта:
// VCS, зависимости, артефакты сборки, runtime-данные.
function deriveBlockedWriteZones(_targetFiles: string[]): string[] {
  return [
    ".git",
    "node_modules",
    "vendor",
    "dist",
    "build",
    "coverage",
    "storage",
    ".client",
  ];
}

function buildDeterministicAnswer(input: BuildAnswerInput): AnswerPackage {
  const answerMode = resolveAnswerMode(input);
  const brief = buildAnswerBrief(input, answerMode);
  const evidenceHighlights = buildEvidenceHighlights(input, brief);
  const warnings = buildWarnings(input);
  const unknowns = brief.materialUnknowns.slice(0, 4);
  const nextActions = buildNextActions(input, answerMode);
  const confirmedFacts = buildConfirmedFacts(input, brief, evidenceHighlights);
  const unconfirmedFacts = buildUnconfirmedFacts(input, unknowns);
  const manualChecks = buildManualChecks(input, nextActions, warnings);
  const explanation = buildDeterministicExplanation(input, brief, answerMode, evidenceHighlights, unknowns);

  return {
    answerId: stableId(["answer", input.runId]),
    runId: input.runId,
    answerMode,
    ...(input.validatedAnswerPacket?.questionType ? { questionType: input.validatedAnswerPacket.questionType } : {}),
    summary: buildDeterministicSummary(input, brief, answerMode),
    explanation,
    evidenceHighlights,
    confirmedFacts,
    unconfirmedFacts,
    manualChecks,
    confidence: computeAnswerConfidence(input),
    unknowns,
    warnings,
    nextActions,
    inspectorHints: [
      "Открыть Research для деталей по evidence и entry points.",
      "Открыть Git для локальных изменений и change scope.",
      "Открыть Plan, если нужен безопасный план изменений.",
    ],
    generatedAt: new Date().toISOString(),
    ...(input.validation ? { validation: input.validation } : {}),
    ...(input.validatedAnswerPacket ? { validatedAnswerPacket: input.validatedAnswerPacket } : {}),
    providerUsed: {
      baseUrl: input.providerBaseUrl,
      model: input.providerModel,
    },
    synthesis: "deterministic-fallback",
  };
}

// Rewritten 2026-07-16 (direct user feedback: "ответы очень похожи на
// шаблонные структурированые" - answers should read like chatting with a
// senior fullstack dev, not like a generated report). The old prompt forced
// the same 4-5 fixed Russian section headers onto EVERY answer ("Краткий
// ответ" then "Как это работает" then "Где искать код"...), which made a
// two-line answer to "where is X configured" look like a form being filled
// in. Now: free-form chat prose, file paths woven into the text, structure
// only where the specific question genuinely calls for it. The answer itself
// stays in Russian; the instructions are English per the standing
// prompts-in-English rule.
function buildAnswerSystemPrompt(contract: QuestionContract): string {
  const lengthHint = contract.requiresImpact || contract.requiresPlan
    ? "A question about changes/impact deserves a fuller reply - but still no more than ~200 words."
    : "A simple lookup question ('where is X', 'is there Y') deserves 2-5 sentences TOTAL. Longer only if the mechanism genuinely needs it.";

  return [
    "You are a senior fullstack engineer with 20 years of experience who knows this project's codebase well, replying to a colleague in the team chat.",
    "",
    "Facts discipline (non-negotiable):",
    "- Use exclusively the validated claims and materials given to you. Do not invent anything beyond them.",
    "- If the data is insufficient, say so honestly in one ordinary sentence ('тут не уверен, надо смотреть X') - do not pad.",
    "- Never mention internal system words: Research, Impact, Context, Plan, baseline, overlay, validation, artifacts, confidence, synthesis, fallback. The colleague doesn't know or care about the machinery.",
    "",
    "Style - this is a chat message, not a report:",
    "- Write in Russian, the way a live experienced engineer types a reply: connected prose, first person allowed, natural transitions.",
    "- NO fixed template. Do NOT use ritual section headers like 'Краткий ответ', 'Как это работает', 'Где искать код', 'Итог'. The structure must follow this specific question, not a form.",
    "- The FIRST sentence answers the question directly: for yes/no questions start with 'Да'/'Нет'/'Похоже, да'; for 'where' questions name the file/place immediately.",
    "- Weave specific files/classes/methods in backticks INTO the sentences where they matter ('линковка живёт в `LinkCaseDataAction`, оттуда дергается `SyncRelatedCasesTask`'), instead of dumping a bare file list at the end. A short bullet list is fine only when enumerating several genuinely parallel things (several routes, several configs with different roles).",
    "- Markdown '##' headers only if the answer really covers several distinct topics - most answers should have none at all.",
    `- Length matches the question. ${lengthHint}`,
    "- No introductions, no repeating the question back, no 'итог:'/'вывод:' recap at the end, no bureaucratic phrasing ('можно сделать вывод', 'подтверждается, что').",
    contract.requiresPlan
      ? "- The user is asking about making a change: end with a short numbered plan (up to 6 steps, execution order, only confirmed steps) - this is the one case where a list at the end is expected."
      : "",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

async function synthesizeAnswerWithProvider(
  input: BuildAnswerInput,
  fallback: AnswerPackage,
): Promise<{
  summary: string;
  explanation: string;
  nextActions: string[];
  warnings: string[];
}> {
  const endpoint = `${input.providerBaseUrl.replace(/\/$/, "")}/chat/completions`;
  const answerMode = resolveAnswerMode(input);
  const brief = buildAnswerBrief(input, answerMode);
  const prompt = buildAnswerPrompt(input, fallback, brief);
  const response = await performProviderRequest(endpoint, input.providerApiKey, {
    model: input.providerModel,
    temperature: 0.2,
    messages: [
      {
        role: "system",
        content: buildAnswerSystemPrompt(brief.questionContract),
      },
      {
        role: "user",
        content: prompt,
      },
    ],
  });
  const payload = (await response.json()) as ProviderChatResponse;
  recordUsage(input.usage, payload);
  const content = extractProviderContent(payload);

  if (!content) {
    throw new Error("Provider returned empty answer");
  }

  const warnings = buildProviderWarnings(response);
  const parsed = parseProviderAnswer(content, fallback);

  return {
    ...parsed,
    warnings: [...parsed.warnings, ...warnings].slice(0, 4),
  };
}

function extractProviderContent(payload: ProviderChatResponse): string {
  const firstChoice = payload.choices?.[0];
  const content = firstChoice?.message?.content;

  if (typeof content === "string") {
    return content.trim();
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => item.text ?? "")
      .join("\n")
      .trim();
  }

  return "";
}

function parseProviderAnswer(
  content: string,
  fallback: AnswerPackage,
): {
  summary: string;
  explanation: string;
  nextActions: string[];
  warnings: string[];
} {
  const trimmed = content.trim();

  if (!trimmed) {
    return {
      summary: fallback.summary,
      explanation: fallback.explanation,
      nextActions: fallback.nextActions,
      warnings: fallback.warnings,
    };
  }

  // Free-form chat answers (2026-07-16): the prompt no longer demands a
  // "## Краткий ответ" section - a proper conversational reply usually has
  // NO markdown headers at all, and the old `sections.size === 0 → discard
  // the whole answer as malformed` gate would have silently replaced every
  // such answer with the deterministic template. summary = the first
  // substantive line (the prompt requires the first sentence to BE the
  // direct answer); the legacy section names are still read as a fallback
  // for models that keep producing the old structure.
  const sections = parseMarkdownSections(trimmed);
  const legacyShortAnswer = extractSectionText(sections, "Краткий ответ");
  const firstSubstantiveLine = trimmed
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith("#"))
    ?.replace(/^[-*]\s+/, "")
    ?? "";
  const planSteps = extractSectionBullets(sections, "Рекомендуемый план действий");

  return {
    summary: legacyShortAnswer || firstSubstantiveLine.slice(0, 240) || fallback.summary,
    explanation: trimmed,
    nextActions: planSteps.length > 0 ? planSteps : fallback.nextActions,
    warnings: fallback.warnings,
  };
}

function resolveAnswerMode(input: BuildAnswerInput): AnswerMode {
  if (input.research.confidence < 45) {
    return "insufficient-data-answer";
  }

  if (looksLikeChangeTask(input.task)) {
    return "plan-summary-answer";
  }

  if (looksLikeDiagnosticTask(input.task)) {
    return "diagnostic-answer";
  }

  return "direct-answer";
}

function shouldForceEvidenceLockedMode(input: BuildAnswerInput): boolean {
  const diagnosticMode = looksLikeDiagnosticTask(input.task);
  const localeBehavior = input.research.functionalSummary.toLowerCase().includes("runtime-поведению локализации");
  // `research.unknowns` копит до 7 независимых сигналов (нет entry points,
  // нет side effects, нет data sources, indexer diagnostics и т.д.) —
  // почти любой широкий реальный вопрос набирает хотя бы один из них.
  // Раньше ЛЮБОЙ (>0) unknown полностью запирал ответ в deterministic-шаблон
  // и ни разу не пробовал LLM — на практике это означало, что почти каждый
  // не-узкий вопрос получал робо-ответ вместо синтеза, хотя confidence уже
  // отдельно штрафуется на -8 за каждый unknown (computeConfidence). Порог
  // поднят до "несколько независимых сигналов сразу", иначе LLM получает
  // шанс синтезировать честный, hedged ответ по тем же уликам — с уже
  // выставленными warnings и валидацией через validateProviderAnswer.
  const hasSevereUnknowns = input.research.unknowns.length >= 3;
  // "Few files in evidence" means something different depending on who
  // produced the research: for the deterministic scorer it means the wide
  // net came back nearly empty (a real weak-evidence signal); for the
  // agentic path (packages/agentic-research) it just means the model read
  // exactly the 1-2 files it needed for a narrow question - efficient, not
  // weak. A critic already vetted that answer before it got here, so this
  // deterministic-tuned heuristic must not apply to it (see
  // ResearchReport.researchMode).
  const lowStructuralCoverage = input.research.researchMode !== "agentic" && input.research.evidence.length < 3;

  return diagnosticMode || localeBehavior || hasSevereUnknowns || lowStructuralCoverage;
}

function computeAnswerConfidence(input: BuildAnswerInput): number {
  const validationCap = input.validatedAnswerPacket?.confidenceCeiling ?? 95;
  const freshnessPenalty =
    input.backgroundState?.freshness === "stale"
      ? 8
      : input.backgroundState?.freshness === "missing"
        ? 14
        : 0;

  return Math.max(
    15,
    Math.min(
      validationCap,
      Math.round(
        (
          input.research.confidence
          + input.impact.confidence
          + Math.min(input.context.confidence, 100)
        ) / 3,
      ) - freshnessPenalty,
    ),
  );
}

function buildEvidenceHighlights(input: BuildAnswerInput, brief?: AnswerBrief): AnswerEvidenceHighlight[] {
  const highlights: AnswerEvidenceHighlight[] = [];
  const prioritizedEvidence = getPrioritizedEvidence(input);

  for (const item of prioritizedEvidence.slice(0, 4)) {
    highlights.push({
      label: item.label,
      detail: item.reason,
    });
  }

  if ((brief?.questionContract.requiresImpact ?? false) && input.impact.affectedFiles.length > 0) {
    highlights.push({
      label: "Зона влияния",
      detail: `Подтверждено ${input.impact.affectedFiles.length} затронутых файлов.`,
    });
  }

  return highlights.slice(0, 4);
}

function getLocaleEvidenceWeight(item: ResearchReport["evidence"][number]): number {
  const label = item.label.toLowerCase();
  const filePath = (item.filePath ?? "").toLowerCase();
  let score = item.score;

  if (label.includes("locale")) {
    score += 80;
  }

  if (filePath.includes("/middleware/")) {
    score += 70;
  }

  if (filePath.endsWith("config/app.php")) {
    score += 60;
  }

  if (label.includes("x-locale") || label.includes("x-lang")) {
    score += 90;
  }

  return score;
}

function buildWarnings(input: BuildAnswerInput): string[] {
  const warnings: string[] = [];

  if (input.validation && input.validation.status !== "ready-for-answer") {
    warnings.push("Перед финальным ответом сработал validation layer: часть выводов ограничена качеством текущего evidence.");
  }

  if (input.backgroundState?.freshness === "stale") {
    warnings.push("Ответ построен поверх не полностью свежего baseline и текущего branch/worktree overlay. Для максимальной точности желательно обновить фон.");
  }

  if (input.backgroundState?.freshness === "missing") {
    warnings.push("Для текущего branch/worktree состояния ещё нет готового baseline, поэтому ответ собран в режиме первого прохода.");
  }

  if (input.research.unknowns.length > 0) {
    warnings.push("Ответ опирается на неполный набор данных, часть unknowns остаётся открытой.");
  }

  if (input.research.queryProfileKey === "broad-scan") {
    warnings.push("Запрос слишком широкий, поэтому вывод может быть менее точным, чем у узкосфокусированного вопроса.");
  }

  return Array.from(new Set(warnings)).slice(0, 3);
}

function buildNextActions(input: BuildAnswerInput, mode: AnswerMode): string[] {
  const actions: string[] = [];

  if (input.validation?.status === "partial-answer-allowed") {
    actions.push("Если нужен более сильный ответ, стоит усилить targeted research по рекомендациям validation layer.");
  }

  if (input.backgroundState?.freshness === "stale" || input.backgroundState?.freshness === "missing") {
    actions.push("Если вопрос критичен по точности, сначала запусти принудительный пересбор branch-aware фона.");
  }

  if (mode === "plan-summary-answer") {
    actions.push("Открой план, чтобы посмотреть порядок шагов и scope изменений.");
  }

  if (input.research.unknowns.length > 0) {
    actions.push("При необходимости можно сузить вопрос или добавить runtime-логи для более точного вывода.");
  }

  if (actions.length === 0) {
    actions.push("Если нужно, могу продолжить с более узким follow-up вопросом по этой же зоне.");
  }

  return actions.slice(0, 3);
}

function buildDeterministicSummary(input: BuildAnswerInput, brief: AnswerBrief, mode: AnswerMode): string {
  if (input.validatedAnswerPacket?.directAnswerAllowed === false) {
    return "Не готов дать уверенный прямой ответ — держусь только того, что реально подтверждено.";
  }

  if (mode === "insufficient-data-answer") {
    return "Пока не хватает данных для уверенного вывода, но зону уже удалось сузить.";
  }

  if (mode === "plan-summary-answer") {
    return input.plan.summary;
  }

  if (shouldForceEvidenceLockedMode(input)) {
    return buildEvidenceLockedSummary(input, brief);
  }

  if (brief.directAnswer.trim().length > 0) {
    return `${brief.directAnswer} ${buildFreshnessSuffix(input)}`.trim();
  }

  return `${input.research.summary} ${buildFreshnessSuffix(input)}`.trim();
}

function buildDeterministicExplanation(
  input: BuildAnswerInput,
  brief: AnswerBrief,
  mode: AnswerMode,
  evidenceHighlights: AnswerEvidenceHighlight[],
  unknowns: string[],
): string {
  if (shouldForceEvidenceLockedMode(input)) {
    return buildStructuredFallbackExplanation(input, brief, mode, evidenceHighlights, unknowns, true);
  }

  return buildStructuredFallbackExplanation(input, brief, mode, evidenceHighlights, unknowns, false);
}

function buildStructuredFallbackExplanation(
  input: BuildAnswerInput,
  brief: AnswerBrief,
  mode: AnswerMode,
  evidenceHighlights: AnswerEvidenceHighlight[],
  unknowns: string[],
  evidenceLocked: boolean,
): string {
  const sections: string[] = [];
  const freshnessNote = buildFreshnessExplanation(input);

  // Section: Как это работает
  const howItWorks = buildHowItWorksSection(input, brief, mode);
  if (howItWorks) {
    sections.push(howItWorks);
  }

  // Section: Где искать код
  const whereToLook = buildWhereToLookSection(input, brief);
  if (whereToLook) {
    sections.push(whereToLook);
  }

  // Section: Что изменится при модификации
  const impactSection = buildImpactSection(input, brief);
  if (impactSection) {
    sections.push(impactSection);
  }

  // Section: Возможные риски
  const risksSection = buildRisksSection(input, unknowns);
  if (risksSection) {
    sections.push(risksSection);
  }

  // Section: Рекомендуемый план действий
  const planSection = buildPlanSection(input, brief);
  if (planSection) {
    sections.push(planSection);
  }

  if (freshnessNote) {
    sections.push(`*${freshnessNote}*`);
  }

  if (evidenceLocked) {
    sections.push("*Если где-то не уверен, я это лучше не додумаю за код.*");
  }

  if (sections.length === 0) {
    return input.research.summary;
  }

  return sections.join("\n\n");
}

function buildHowItWorksSection(input: BuildAnswerInput, brief: AnswerBrief, mode: AnswerMode): string {
  const parts: string[] = [];
  const locationLike = brief.questionContract.expectedAnswerShape === "location";

  parts.push(locationLike ? "## Что найдено" : "## Как это работает");

  if (brief.explanationLead.trim().length > 0) {
    parts.push(brief.explanationLead);
  } else if (input.research.functionalSummary.trim().length > 0) {
    parts.push(input.research.functionalSummary);
  } else {
    parts.push(input.research.summary);
  }

  if (brief.claimSet.directClaim && brief.claimSet.directClaim.caveats.length > 0) {
    parts.push(`\nНа что обратить внимание:`);
    for (const caveat of brief.claimSet.directClaim.caveats.slice(0, 2)) {
      parts.push(`- ${caveat}`);
    }
  }

  if (!locationLike && input.research.entryPoints.length > 0) {
    parts.push(`\nС чего начинается цепочка:`);
    for (const ep of input.research.entryPoints.slice(0, 3)) {
      parts.push(`- ${ep}`);
    }
  }

  if (!locationLike && input.research.dataSources.length > 0 && input.research.queryProfileKey !== "entrypoint-traversal") {
    parts.push(`\nОткуда берутся данные:`);
    for (const ds of input.research.dataSources.slice(0, 2)) {
      parts.push(`- ${ds}`);
    }
  }

  if (input.research.findings.length > 0) {
    parts.push(`\nЧто особенно важно:`);
    for (const finding of input.research.findings.slice(0, 2)) {
      parts.push(`- ${finding}`);
    }
  }

  if (mode === "plan-summary-answer") {
    parts.push(`\n${input.plan.summary}`);
  }

  return parts.join("\n");
}

function buildWhereToLookSection(input: BuildAnswerInput, brief: AnswerBrief): string {
  const evidence = getPrioritizedEvidence(input).filter((item) => item.filePath).slice(0, 4);

  if (evidence.length === 0) {
    return "";
  }

  const parts: string[] = ["## Где искать код"];

  for (const item of evidence) {
    const filePath = item.filePath ?? "";
    parts.push(`- \`${filePath}\` — ${shortenEvidenceLabel(item.label, filePath)}`);
  }

  if (brief.questionContract.requiresPlan && input.plan.targetFiles.length > 0) {
    parts.push(`\nЕсли менять код, начни отсюда:`);
    for (const tf of input.plan.targetFiles.slice(0, 3)) {
      parts.push(`- \`${tf}\``);
    }
  }

  return parts.join("\n");
}

function buildImpactSection(input: BuildAnswerInput, brief: AnswerBrief): string {
  if (!brief.questionContract.requiresImpact && brief.impactLines.length === 0) {
    return "";
  }

  const parts: string[] = ["## Что это заденет"];

  parts.push(brief.impactLines[0] ?? input.impact.summary);

  if (input.impact.affectedFiles.length > 0) {
    parts.push(`\nОсновные файлы:`);
    for (const f of input.impact.affectedFiles.slice(0, 4)) {
      const path = typeof f === "string" ? f : (f as { filePath?: string }).filePath ?? "?";
      parts.push(`- \`${path}\``);
    }
  }

  return parts.join("\n");
}

function buildRisksSection(input: BuildAnswerInput, unknowns: string[]): string {
  const riskItems: string[] = [];

  if (input.impact.risks.length > 0) {
    riskItems.push(...input.impact.risks);
  }

  if (unknowns.length > 0) {
    riskItems.push(...unknowns.map((u) => `⚠️ Не подтверждено: ${u}`));
  }

  if (riskItems.length === 0) {
    return "";
  }

  const parts: string[] = ["## Что может пойти не так"];

  for (const risk of riskItems.slice(0, 3)) {
    parts.push(`- ${normalizeRiskText(risk)}`);
  }

  return parts.join("\n");
}

function buildPlanSection(input: BuildAnswerInput, brief: AnswerBrief): string {
  if (!brief.questionContract.requiresPlan && brief.planLines.length === 0) {
    return "";
  }

  const parts: string[] = ["## Как бы я менял"];

  if (brief.planLines.length > 0) {
    for (let i = 0; i < Math.min(brief.planLines.length, 4); i += 1) {
      const line = brief.planLines[i];
      if (line === undefined) {
        continue;
      }
      parts.push(`${i + 1}. ${line}`);
    }
  } else if (input.plan.steps.length > 0) {
    for (let i = 0; i < Math.min(input.plan.steps.length, 4); i++) {
      const step = input.plan.steps[i];
      if (step === undefined) {
        continue;
      }
      const label = step.title ?? step.description ?? `Шаг ${i + 1}`;
      parts.push(`${i + 1}. ${label}`);
    }
  } else {
    parts.push("Пока маловато данных, чтобы собрать конкретный план.");
  }

  if (input.plan.planningNotes) {
    parts.push(`\n*${input.plan.planningNotes}*`);
  }

  return parts.join("\n");
}

function shortenEvidenceLabel(label: string, filePath: string): string {
  if (!label || label === filePath) {
    return "сильная опора по этой зоне";
  }

  if (label.includes(filePath)) {
    return "сильная опора по этой зоне";
  }

  return label;
}

function normalizeRiskText(risk: string): string {
  return risk.replace(/^⚠️\s*/u, "").trim();
}

function buildConfirmedFacts(
  input: BuildAnswerInput,
  brief: AnswerBrief,
  evidenceHighlights: AnswerEvidenceHighlight[],
): string[] {
  const facts = [
    brief.directAnswer,
    ...brief.claimSet.supportingClaims.map((claim) => claim.statement),
    ...evidenceHighlights.map((item) => `${item.label}: ${item.detail}`),
  ];

  return [...new Set(facts.filter(Boolean))].slice(0, 4);
}

function buildUnconfirmedFacts(
  input: BuildAnswerInput,
  unknowns: string[],
): string[] {
  const items = [...unknowns];

  if (input.backgroundState?.freshness === "missing") {
    items.unshift("Для текущего branch/head ещё нет готового committed baseline, поэтому часть вывода подтверждена слабее обычного.");
  }

  if (input.backgroundState?.freshness === "stale") {
    items.unshift("Текущий ответ опирается на не полностью свежий baseline, поэтому часть состояния могла уже измениться.");
  }

  return [...new Set(items.filter(Boolean))].slice(0, 4);
}

function buildManualChecks(
  input: BuildAnswerInput,
  nextActions: string[],
  warnings: string[],
): string[] {
  const checks = [...nextActions];

  if (input.research.entryPoints.length > 0) {
    checks.push(`Проверь вручную точки входа: ${input.research.entryPoints.slice(0, 3).join(", ")}.`);
  }

  if (input.backgroundState?.hasLocalChanges) {
    checks.push("Сверь локальный незакоммиченный worktree с baseline, если ответ влияет на активную разработку.");
  }

  if (warnings.some((item) => item.toLowerCase().includes("baseline"))) {
    checks.push("Если нужна максимальная точность, сначала дождись или запусти обновление branch-aware background sync.");
  }

  return [...new Set(checks.filter(Boolean))].slice(0, 4);
}

function buildEvidenceLockedSummary(input: BuildAnswerInput, brief: AnswerBrief): string {
  const topEvidence = getPrioritizedEvidence(input)[0];

  if (brief.directAnswer.trim().length > 0 && !brief.directAnswer.startsWith("Пока не хватает уверенных доказательств")) {
    return `${brief.directAnswer} ${buildFreshnessSuffix(input)}`.trim();
  }

  if (topEvidence?.filePath) {
    return `Самая сильная опора сейчас в \`${topEvidence.filePath}\`. ${buildFreshnessSuffix(input)}`.trim();
  }

  return `Держусь только того, что реально подтверждено кодом и рантаймом — без домыслов. ${buildFreshnessSuffix(input)}`.trim();
}

function buildEvidenceLockedExplanation(
  input: BuildAnswerInput,
  evidenceHighlights: AnswerEvidenceHighlight[],
  unknowns: string[],
): string {
  const parts: string[] = [];
  const freshnessExplanation = buildFreshnessExplanation(input);

  if (freshnessExplanation) {
    parts.push(freshnessExplanation);
  }

  if (input.research.entryPoints.length > 0) {
    parts.push(`Ключевые точки входа: ${input.research.entryPoints.slice(0, 4).join(", ")}.`);
  }

  if (evidenceHighlights.length > 0) {
    parts.push(`Подтверждения: ${evidenceHighlights.map((item) => `${item.label} — ${item.detail}`).join(" | ")}.`);
  }

  if (unknowns.length > 0) {
    parts.push(`Недостаточно подтверждено: ${unknowns.slice(0, 2).join(" | ")}.`);
  }

  parts.push("Недоказанные предположения намеренно не включены в ответ.");

  return parts.join(" ");
}

/**
 * "Всё свежо, локальных изменений нет" — это нормальное, ожидаемое
 * состояние в большинстве запусков, поэтому в него не стоит вкладывать
 * отдельную фразу в каждом ответе (человек не сообщает "кстати, у меня
 * актуальные данные" на каждый вопрос — это молчаливая норма). Фраза
 * появляется только там, где реально есть о чём предупредить.
 */
function buildFreshnessSuffix(input: BuildAnswerInput): string {
  if (!input.backgroundState) {
    return "";
  }

  if (input.backgroundState.freshness === "fresh") {
    return input.backgroundState.hasLocalChanges ? "Учёл и твои локальные незакоммиченные правки." : "";
  }

  if (input.backgroundState.freshness === "stale") {
    return "Данные слегка устарели — что-то могло уже поменяться.";
  }

  if (input.backgroundState.freshness === "missing") {
    return "Разбираю эту ветку впервые, так что мог что-то упустить.";
  }

  return "";
}

function buildFreshnessExplanation(input: BuildAnswerInput): string {
  if (!input.backgroundState) {
    return "";
  }

  if (input.backgroundState.freshness === "fresh") {
    return input.backgroundState.hasLocalChanges
      ? `Учитываю и незакоммиченные изменения — их ${input.backgroundState.changedFileCount}.`
      : "";
  }

  if (input.backgroundState.freshness === "stale") {
    return `Актуальность не идеальная: с последнего полного разбора поменялось ${input.backgroundState.changedFileCount} файлов.`;
  }

  if (input.backgroundState.freshness === "missing") {
    return "Эту ветку разбираю впервые, поэтому редкие боковые связи ещё могут всплыть на следующем проходе.";
  }

  return "";
}

function buildEvidenceProvenanceExplanation(research: ResearchReport): string {
  const { overlayInfluenced } = research.evidenceSummary;

  // Технические счётчики "baseline N, overlay N, structural N" — это
  // внутренняя бухгалтерия research, не то, что интересует человека в
  // чате. Стоит упоминать, только когда это реально меняет надёжность
  // ответа (незакоммиченные правки повлияли на вывод).
  if (!overlayInfluenced) {
    return "";
  }

  return "Часть вывода опирается на твои локальные незакоммиченные изменения, а не только на то, что уже в git.";
}

function buildAnswerPrompt(input: BuildAnswerInput, fallback: AnswerPackage, brief: AnswerBrief): string {
  const evidenceList = getPrioritizedEvidence(input).length > 0
    ? getPrioritizedEvidence(input).slice(0, 8).map((item) =>
        `- \`${item.filePath ?? "?"}\`: ${item.label} — ${item.reason}`,
      ).join("\n")
    : "(no evidence)";

  const provenanceLine = [
    `baseline facts: ${input.research.evidenceSummary.baselineCount}`,
    `overlay facts: ${input.research.evidenceSummary.overlayCount}`,
    `structural anchors: ${input.research.evidenceSummary.structuralCount}`,
    input.research.evidenceSummary.overlayInfluenced
      ? "Local uncommitted changes materially affect the conclusion."
      : "The conclusion relies primarily on the committed baseline.",
  ].join(" | ");

  const freshnessLine = input.backgroundState
    ? [
        `freshness: ${input.backgroundState.freshness}`,
        `baselineSource: ${input.backgroundState.baselineSource}`,
        input.backgroundState.hasLocalChanges
          ? `There are ${input.backgroundState.changedFileCount} uncommitted changes in the worktree - this is overlay, not baseline.`
          : "Worktree is clean, all facts are from the committed baseline.",
      ].join(" | ")
    : "backgroundState is absent";

  const unknownsLine = input.research.unknowns.length > 0
    ? input.research.unknowns.slice(0, 4).map((u) => `- ${u}`).join("\n")
    : "(no unknowns)";

  const risksLine = input.impact.risks.length > 0
    ? input.impact.risks.slice(0, 5).map((r) => `- ${r}`).join("\n")
    : "(no risks identified)";

  const planStepsLine = input.plan.steps.length > 0
    ? input.plan.steps.slice(0, 6).map((s, i) => `- Step ${i + 1}: ${s.title ?? s.description ?? ""}`).join("\n")
    : "(no plan)";

  const transcriptSection = (input.conversationTranscript ?? []).length > 0
    ? [
        "=== 0. THIS CONVERSATION'S HISTORY (oldest to newest turn) ===",
        "The current request continues this conversation. If it references previous turns",
        "(\"and also\", \"what if instead\", \"the same one\", etc.) - resolve them against this history instead of asking for clarification.",
        (input.conversationTranscript ?? [])
          .map((turn, index) => `${index + 1}. Question: ${turn.task}\n   Answer: ${turn.directAnswer}`)
          .join("\n"),
        "",
      ]
    : [];

  return [
    ...transcriptSection,
    "=== USER REQUEST ===",
    input.task,
    "",
    "=== 1. QUESTION CONTRACT ===",
    `Question type: ${brief.questionContract.questionType}`,
    `Expected shape: ${brief.questionContract.expectedAnswerShape}`,
    `Proof obligations: ${brief.questionContract.proofObligations.join(" | ") || "(none)"}`,
    "",
    "=== 2. VALIDATED CLAIM SET ===",
    `Direct claim: ${brief.directAnswer}`,
    `Explanation lead: ${brief.explanationLead}`,
    "Supporting claims:",
    brief.claimSet.supportingClaims.length > 0
      ? brief.claimSet.supportingClaims.slice(0, 4).map((claim) => `- ${claim.statement}`).join("\n")
      : "(none)",
    "",
    "Location claims:",
    brief.claimSet.locationClaims.length > 0
      ? brief.claimSet.locationClaims.slice(0, 4).map((claim) => `- ${claim.filePaths[0] ?? "?"}: ${claim.statement}`).join("\n")
      : "(none)",
    "",
    "Impact claims:",
    brief.impactLines.length > 0
      ? brief.impactLines.map((line) => `- ${line}`).join("\n")
      : "(none)",
    "",
    "Plan claims:",
    brief.planLines.length > 0
      ? brief.planLines.map((line) => `- ${line}`).join("\n")
      : "(none)",
    "",
    "Rejected or unsafe claims:",
    brief.claimSet.rejectedClaims.length > 0
      ? brief.claimSet.rejectedClaims.slice(0, 3).map((claim) => `- ${claim.statement}`).join("\n")
      : "(none)",
    "",
    "Material unknowns:",
    brief.materialUnknowns.length > 0
      ? brief.materialUnknowns.map((item) => `- ${item}`).join("\n")
      : "(none)",
    "",
    "=== 3. SUPPORTING EVIDENCE ===",
    evidenceList,
    "",
    "Entry points:",
    input.research.entryPoints.length > 0
      ? input.research.entryPoints.slice(0, 6).map((ep) => `- ${ep}`).join("\n")
      : "(none)",
    "",
    "Data sources:",
    input.research.dataSources.length > 0
      ? input.research.dataSources.slice(0, 6).map((ds) => `- ${ds}`).join("\n")
      : "(none)",
    "",
    `Provenance: ${provenanceLine}`,
    "",
    `Freshness: ${freshnessLine}`,
    "",
    "=== 4. IMPACT (what will be affected by changes) ===",
    `Impact summary: ${input.impact.summary}`,
    `Affected files: ${input.impact.affectedFiles.length}`,
    input.impact.affectedFiles.length > 0
      ? input.impact.affectedFiles.slice(0, 8).map((f) => `- ${typeof f === "string" ? f : (f as { filePath?: string }).filePath ?? "?"}`).join("\n")
      : "(none)",
    "",
    "Risks:",
    risksLine,
    "",
    "=== 5. CONTEXT (relevant code fragments) ===",
    `Context confidence: ${input.context.confidence}%`,
    `Token budget: ${input.context.tokenBudget}`,
    `Selected chunks: ${input.context.selectedChunks.length}`,
    input.context.functionalHighlights.length > 0
      ? `Highlights: ${input.context.functionalHighlights.slice(0, 5).join(" | ")}`
      : "(no highlights)",
    input.context.rankingSummary
      ? `Ranking: ${input.context.rankingSummary}`
      : "",
    "",
    "=== 6. PLAN (action plan) ===",
    `Plan summary: ${input.plan.summary}`,
    `Target modules: ${input.plan.targetModules.join(", ") || "(none)"}`,
    `Target files: ${input.plan.targetFiles.length}`,
    `Approval required: ${input.plan.approvalRequired ? "yes" : "no"}`,
    input.plan.planningNotes
      ? `Planning notes: ${input.plan.planningNotes}`
      : "",
    "",
    "Steps:",
    planStepsLine,
    "",
    "=== 7. EXECUTION PREVIEW ===",
    `Preview summary: ${input.preview.summary}`,
    `Allowed actions: ${input.preview.allowedActions.length}`,
    "",
    "=== UNKNOWNS (what the system does NOT know) ===",
    unknownsLine,
    "",
    "=== INSTRUCTION ===",
    `Answer mode: ${fallback.answerMode}`,
    "Produce the answer in Russian, following the style rules from the system prompt (live chat reply, no ritual section headers).",
    "Use only claims and facts directly confirmed in the sections above.",
    "If a fact comes only from overlay findings - explicitly mark it: \"this was found in uncommitted changes\".",
    "Do not add typical guesses about Laravel, middleware order, session, cookie, query params, kernel registration - unless confirmed above.",
    "If a section lacks sufficient data - state that honestly.",
    "Do not mention the words Research, Impact, Context, Plan in the answer.",
    "Write like a senior developer explaining to a colleague.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function validateProviderAnswer(
  answer: {
    summary: string;
    explanation: string;
    nextActions: string[];
    warnings: string[];
  },
  input: BuildAnswerInput,
  fallback: AnswerPackage,
): {
  summary: string;
  explanation: string;
  nextActions: string[];
  warnings: string[];
} {
  const brief = buildAnswerBrief(input, resolveAnswerMode(input));
  const combined = `${answer.summary} ${answer.explanation}`.toLowerCase();
  const evidenceCorpus = [
    brief.directAnswer,
    brief.explanationLead,
    ...brief.claimSet.supportingClaims.map((claim) => claim.statement),
    ...brief.claimSet.locationClaims.map((claim) => claim.statement),
    ...brief.impactLines,
    ...brief.planLines,
    ...input.research.evidence.map((item) => `${item.label} ${item.reason} ${item.filePath ?? ""}`),
  ]
    .join(" ")
    .toLowerCase();
  // Только конкретные, узнаваемые технические заявления — не общая лексика
  // веб-разработки. "session"/"cookie"/"accept-language" раньше тоже были
  // в списке и рубили ЛЮБОЙ нормальный ответ про auth/OAuth-флоу: это самые
  // обычные слова для объяснения такого флоу, а не "придуманные" детали —
  // просто их не было дословно в evidence corpus (это лейблы/reasons, а не
  // исходный код).
  const hallucinationSignals = [
    "kernel.php",
    "app/http/kernel.php",
    "redis lock",
    "queue retry",
    "transaction retry",
  ].filter((token) => combined.includes(token) && !evidenceCorpus.includes(token));

  // Раньше здесь требовалось дословное совпадение первых 40 символов
  // brief.directAnswer — а для большинства flow-вопросов directAnswer это
  // ПРОСТО research.functionalSummary, внутренний деterministic-шаблон
  // ("Задача бьёт в redis-inventory, auth..."). Ни одна живая модель не
  // повторяет этот текст дословно, поэтому LLM-ответ отклонялся практически
  // всегда, независимо от модели и качества ответа — живой прогон с 3
  // разными моделями (nemotron/deepseek/gpt-5.4-mini) подтвердил: все три
  // получили одинаковый reject по этой причине. Настоящая проверка на
  // hallucination — упомянул ли ответ реальный файл/файлы, на которые
  // опирается direct claim, а не повторил ли он текст шаблона дословно.
  const directClaimFilePaths = brief.claimSet.directClaim?.filePaths ?? [];
  const directClaimMissing =
    directClaimFilePaths.length > 0
    && !directClaimFilePaths.some((filePath) => {
      const lowerPath = filePath.toLowerCase();
      const basename = lowerPath.split("/").pop() ?? lowerPath;
      // Имя класса без расширения (2026-07-16): разговорный стиль ответа
      // (по прямому запросу пользователя) пишет `LinkCaseDataAction`, а не
      // `LinkCaseDataAction.php` - строгая проверка на basename с
      // расширением отбрасывала корректные, заякоренные на реальные файлы
      // ответы и подменяла их деterministic-шаблоном (живой репродукт).
      const stem = basename.replace(/\.[a-z0-9]+$/i, "");
      return combined.includes(lowerPath) || combined.includes(basename) || (stem.length >= 4 && combined.includes(stem));
    });

  if (hallucinationSignals.length > 0 || directClaimMissing) {
    return {
      summary: fallback.summary,
      explanation: fallback.explanation,
      nextActions: fallback.nextActions,
      warnings: [
        ...fallback.warnings,
        hallucinationSignals.length > 0
          ? "LLM-ответ отклонён, потому что содержал недоказанные детали вне текущего evidence."
          : "LLM-ответ отклонён, потому что сместил direct claim относительно validated claim set.",
      ].slice(0, 4),
    };
  }

  return answer;
}

function looksLikeDiagnosticTask(task: string): boolean {
  const normalized = task.toLowerCase();
  return ["почему", "why", "иногда", "ошибка", "не работает", "не совпадает", "problem", "issue", "debug"].some((token) =>
    normalized.includes(token),
  );
}

function looksLikeChangeTask(task: string): boolean {
  const normalized = task.toLowerCase();
  return ["исправ", "fix", "добав", "implement", "измен", "change", "поддерж", "support", "поменя"].some((token) =>
    normalized.includes(token),
  );
}

// Architecture review finding (2026-07-16): intent classification was
// fragmented across 3 independent, non-communicating places (this
// diagnostic/change regex pair, used only at answer-synthesis time;
// packages/research's QuestionTypeRegistry, used only by the legacy
// deterministic path; the new path-scope classifier). None of it ever
// reached the agentic Researcher's OWN investigation strategy - it just got
// tools and a generic prompt regardless of whether the question was "where
// is X" or "why does X sometimes fail". This reuses the existing,
// already-proven regex classification (cheap, no new LLM call) as a single
// exported entry point, so the SAME classification that shapes the final
// answer's tone can also shape how deep/what-focused the investigation is.
export type QuestionShape = "diagnostic" | "change" | "compare" | "locate";

export function classifyQuestionShape(task: string): QuestionShape {
  if (looksLikeDiagnosticTask(task)) {
    return "diagnostic";
  }

  if (looksLikeChangeTask(task)) {
    return "change";
  }

  if (/чем отличается|в чём разница|в чем разница|difference between|compared to|versus\b/i.test(task)) {
    return "compare";
  }

  return "locate";
}

// English per the project's standing prompt-language rule - this text is
// appended to the agentic loop's LLM-facing message, never shown to the user.
export function buildQuestionShapeHint(shape: QuestionShape): string {
  switch (shape) {
    case "diagnostic":
      return "This looks like a DIAGNOSTIC question (why something happens, or why it is broken/inconsistent) - prioritize finding the actual failing condition/branch/edge case, not just describing the feature in general. A confident-sounding general description that never actually locates the specific condition is not a real answer to a diagnostic question.";
    case "change":
      return "This looks like a CHANGE-REQUEST question (add/fix/modify something) - prioritize identifying the full blast radius (what calls/depends on the code in question, ideally via find_references if available) and whether tests exist for this area, since that is what actually determines how risky the change is.";
    case "compare":
      return "This looks like a COMPARISON question (how do two things differ) - make sure you investigate BOTH sides with comparable depth before answering; do not let whichever one you found first dominate the answer.";
    case "locate":
      return "";
  }
}

async function performProviderRequest(endpoint: string, apiKey: string, body: Record<string, unknown>): Promise<Response> {
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= PROVIDER_MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), PROVIDER_REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        signal: controller.signal,
        body: JSON.stringify(body),
      });

      if (response.ok) {
        clearTimeout(timeoutId);
        return response;
      }

      if (!shouldRetryResponse(response.status) || attempt === PROVIDER_MAX_ATTEMPTS) {
        clearTimeout(timeoutId);
        const bodyText = await response.text().catch(() => "");
        throw new Error(`Provider request failed with ${response.status}${bodyText ? `: ${bodyText.slice(0, 300)}` : ""}`);
      }

      const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
      clearTimeout(timeoutId);
      await delay(retryAfterMs ?? computeBackoffMs(attempt));
      continue;
    } catch (error) {
      clearTimeout(timeoutId);
      lastError = error;

      const isAbortError = error instanceof DOMException && error.name === "AbortError";
      const shouldRetry = isAbortError || isTransientError(error);

      if (!shouldRetry || attempt === PROVIDER_MAX_ATTEMPTS) {
        throw error;
      }

      await delay(computeBackoffMs(attempt));
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Provider request failed");
}

function shouldRetryResponse(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function isTransientError(error: unknown): boolean {
  return error instanceof TypeError;
}

function computeBackoffMs(attempt: number): number {
  const baseMs = PROVIDER_BASE_BACKOFF_MS * attempt;
  // Random jitter (+/-20%) per rout.my's error-handling docs - avoids
  // multiple concurrent requests retrying in lockstep against the same limit.
  return baseMs + baseMs * 0.2 * (Math.random() * 2 - 1);
}

function parseRetryAfterMs(value: string | null): number | null {
  if (!value) {
    return null;
  }

  const asSeconds = Number.parseInt(value, 10);

  if (Number.isFinite(asSeconds) && asSeconds >= 0) {
    return asSeconds * 1000;
  }

  const asDate = new Date(value);

  if (Number.isNaN(asDate.getTime())) {
    return null;
  }

  return Math.max(asDate.getTime() - Date.now(), 0);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildProviderWarnings(response: Response): string[] {
  const warnings: string[] = [];
  const remaining = response.headers.get("x-ratelimit-remaining");

  if (remaining === "0") {
    warnings.push("Провайдер сообщил, что лимит запросов почти исчерпан.");
  }

  return warnings;
}

function buildProviderFallbackWarning(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") {
    return "LLM-провайдер не ответил вовремя, поэтому показан deterministic fallback ответ.";
  }

  if (error instanceof Error && error.message.includes("429")) {
    return "Провайдер вернул rate limit, поэтому показан deterministic fallback ответ.";
  }

  if (error instanceof Error && error.message.includes("5")) {
    return "Внешний LLM-провайдер временно недоступен, поэтому показан deterministic fallback ответ.";
  }

  return "Не удалось получить live-ответ от модели, поэтому показан deterministic fallback ответ.";
}
