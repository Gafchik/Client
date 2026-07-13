import {
  type BackgroundProjectState,
  clamp,
  detectResearchAmbiguity,
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
const PROVIDER_MAX_ATTEMPTS = 3;
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
            "Ты помогаешь построить поисковые термины для substring-поиска по исходному коду.",
            "Пользователь задаёт инженерный вопрос о кодовой базе, обычно на русском.",
            "Кодовая база обычно называет сущности английскими словами (классы, директории, поля, таблицы).",
            "Придумай до 6 английских слов/коротких словосочетаний — переводов, синонимов и распространённых технических терминов, которыми в коде могла бы называться сущность или процесс из вопроса.",
            "Не отвечай на сам вопрос. Не придумывай конкретные имена классов конкретного проекта — только обычные словарные английские слова по смыслу вопроса.",
            "Ответь ТОЛЬКО одной строкой JSON без пояснений и без markdown-обрамления, ровно в таком виде: {\"keywords\": string[]}.",
          ].join("\n"),
        },
        {
          role: "user",
          content: input.task,
        },
      ],
    });

    const payload = (await response.json()) as ProviderChatResponse;
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
  const response = await performProviderRequest(endpoint, input.providerApiKey, {
    model: input.providerModel,
    temperature: 0.1,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: [
          "Ты выступаешь как engineering evidence validator.",
          "Ты не отвечаешь пользователю и не исследуешь проект самостоятельно.",
          "Ты оцениваешь только достаточность уже собранных артефактов.",
          "Research confidence не является истиной, это лишь один из входных сигналов.",
          "Главный вопрос: реально ли собранный evidence отвечает на ТОТ вопрос, который задал пользователь — а не просто на что-то похожее по ключевым словам.",
          "Верни только JSON с полями validationStatus, readinessScore, directAnswerFeasibility, evidenceSufficiency, contradictionLevel, gapSummary, contradictions, missingConfirmations, recommendedActions, missingEntityHints, primaryEvidenceLabel, recommendedResearchProfile, recommendedStopReason, rationale.",
          "recommendedActions — закрытый словарь общих сценариев, нельзя придумывать значения вне разрешённого списка.",
          "missingEntityHints — наоборот, свободный текст: если evidence не бьёт в суть вопроса, назови конкретные сущности/классы/файлы/понятия из вопроса, которых не хватает в evidence и которые стоит поискать отдельно. Не ограничивайся никаким списком — пиши то, что реально нужно найти, своими словами или точным именем из вопроса. Пусто, если evidence уже покрывает вопрос по существу.",
          "primaryEvidenceLabel — среди Evidence в промпте выбери ОДИН элемент, чей label точнее всего отвечает на вопрос по смыслу, а не по формальному score (score — это подсчёт совпадений, не понимание вопроса). Особенно важно, когда несколько evidence одного типа/домена выглядят структурно похоже (например несколько разных Model-файлов) — тогда просто выше по score не значит правильнее по сути. Скопируй label ТОЧНО как он написан в Evidence. Пусто, если нет явного кандидата или все примерно равнозначны.",
        ].join("\n"),
      },
      {
        role: "user",
        content: buildValidationPrompt(input.packet),
      },
    ],
  });

  const payload = (await response.json()) as ProviderChatResponse;
  const content = extractProviderContent(payload);

  if (!content) {
    throw new Error("Provider returned empty validator answer");
  }

  return JSON.parse(content) as ProviderValidatorResponse;
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
  const normalizedActions = (candidate.recommendedActions ?? [])
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
    gaps: (candidate.gapSummary ?? [])
      .filter(Boolean)
      .slice(0, VALIDATOR_MAX_GAPS)
      .map((gap, index) => ({
        id: stableId(["validation-gap", packet.runId, packet.iteration, index]),
        label: gap,
        severity: "medium" as const,
        reason: gap,
      })),
    contradictions: (candidate.contradictions ?? [])
      .filter(Boolean)
      .slice(0, VALIDATOR_MAX_CONTRADICTIONS)
      .map((item, index) => ({
        id: stableId(["validation-contradiction", packet.runId, packet.iteration, index]),
        label: item,
        severity: "medium" as const,
        reason: item,
      })),
    missingConfirmations: (candidate.missingConfirmations ?? []).filter(Boolean).slice(0, 4),
    recommendedActions: normalizedActions.length > 0 ? normalizedActions : fallback.recommendedActions,
    missingEntityHints: Array.from(
      new Set(
        (candidate.missingEntityHints ?? [])
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

  return (
    highScoreEvidence * 8
    + fileAnchors * 3
    + originDiversity * 4
    + Math.min(anchorDensity, 6) * 4
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

function deriveBlockedWriteZones(targetFiles: string[]): string[] {
  const blocked = new Set<string>([
    "node_modules",
    ".git",
    ".client/knowledge",
    "dist",
    "build",
  ]);

  if (!targetFiles.some((file) => file.startsWith("apps/web"))) {
    blocked.add("apps/web");
  }

  if (!targetFiles.some((file) => file.startsWith("apps/api"))) {
    blocked.add("apps/api");
  }

  return [...blocked];
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

function buildAnswerSystemPrompt(contract: QuestionContract): string {
  const sections: string[] = ["## Краткий ответ\n1-2 предложения по сути вопроса. Никаких вступлений."];

  if (contract.expectedAnswerShape !== "yes-no") {
    sections.push(
      "## Как это работает\nМеханизм по делу, без пересказа очевидного. 2-4 предложения максимум.",
    );
  }

  sections.push(
    "## Где искать код\nТолько конкретные файлы/классы/методы из evidence, bullet-список, без пояснений на пункт.",
  );

  if (contract.requiresImpact) {
    sections.push(
      "## Риски и что затронет\nТолько если реально подтверждено claims/impact-анализом. 2-3 пункта максимум.",
    );
  }

  if (contract.requiresPlan) {
    sections.push(
      "## Рекомендуемый план действий\nШаги в порядке выполнения, только подтверждённые plan claims. Не больше 6 шагов.",
    );
  }

  const sectionNames = sections.map((section) => section.split("\n")[0]).join(", ");
  const wordBudget = contract.requiresImpact || contract.requiresPlan ? "220" : "130";

  return [
    "Ты senior software engineer, который разбирается в кодовой базе проекта и помогает коллегам в чате.",
    "",
    "Твоя задача — дать чёткий ответ на вопрос пользователя, опираясь исключительно на переданные тебе validated claims и supporting materials.",
    "",
    "Правила по содержанию:",
    "- Не выдумывай факты, которых нет в артефактах.",
    "- Если данных недостаточно — честно скажи об этом одной фразой, не растягивай.",
    "- Не упоминай внутренние названия артефактов (Research, Impact, Context, Plan) в ответе.",
    "- Не пересказывай артефакты дословно — синтезируй ответ своими словами.",
    "- Пиши по-русски, в стиле опытного инженера, который отвечает коллеге в чате, а не пишет отчёт.",
    "- Никогда не начинай ответ и не строй его вокруг служебных фраз про происхождение данных ('ответ опирается на committed baseline', 'по происхождению фактов', 'baseline source exact-head', 'evidence-locked режим' и подобных) — это внутренняя механика системы, а не то, что интересует человека. Если нужно упомянуть неуверенность — скажи это одной обычной фразой ('не до конца уверен, но похоже, что...'), а не терминами системы.",
    "- Пиши как человек, а не как система, описывающая саму себя: не 'система ограничивает вывод', а прямо по делу.",
    "",
    "Правила по объёму и форме (это критично, ответы регулярно получаются слишком длинными и неструктурированными):",
    `- Пиши ТОЛЬКО перечисленные ниже разделы: ${sectionNames}. Больше никаких разделов не создавай, даже если кажется, что "для полноты" стоит что-то добавить.`,
    "- Если раздел неприменим или по нему нет данных — не пиши ни заголовок, ни заглушку вида 'недостаточно данных'. Просто пропусти раздел целиком.",
    `- Общий объём ответа — не больше ${wordBudget} слов суммарно по всем разделам. Это жёсткий лимит, а не ориентир.`,
    "- Никакой воды: без вступлений, без 'таким образом', без повторения вопроса, без заключений и резюме в конце.",
    "- Каждый пункт списка — максимум одна строка. Не объясняй каждый файл отдельным абзацем.",
    "- Заголовки строго в формате Markdown `## Название`, каждый список — строки, начинающиеся с `- `.",
    "",
    "Структура ответа (используй ровно эти разделы, в этом порядке, ничего лишнего):",
    "",
    sections.join("\n\n"),
  ].join("\n");
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
  const sections = parseMarkdownSections(content);

  if (sections.size === 0) {
    return {
      summary: fallback.summary,
      explanation: fallback.explanation,
      nextActions: fallback.nextActions,
      warnings: fallback.warnings,
    };
  }

  const shortAnswer = extractSectionText(sections, "Краткий ответ");
  const planSteps = extractSectionBullets(sections, "Рекомендуемый план действий");

  return {
    summary: shortAnswer || fallback.summary,
    explanation: content.trim() || fallback.explanation,
    nextActions: planSteps.length > 0 ? planSteps : fallback.nextActions,
    warnings: fallback.warnings,
  };
}

function parseMarkdownSections(content: string): Map<string, string> {
  const result = new Map<string, string>();
  const lines = content.split("\n");

  let currentSection = "";
  let currentLines: string[] = [];

  for (const raw of lines) {
    const line = raw.trim();
    const headingMatch = /^##\s+(.+)/.exec(line);

    if (headingMatch && headingMatch[1] !== undefined) {
      if (currentSection && currentLines.length > 0) {
        result.set(currentSection, currentLines.join("\n").trim());
      }

      currentSection = headingMatch[1].trim();
      currentLines = [];
      continue;
    }

    if (currentSection) {
      currentLines.push(raw);
    }
  }

  if (currentSection && currentLines.length > 0) {
    result.set(currentSection, currentLines.join("\n").trim());
  }

  return result;
}

function extractSectionText(sections: Map<string, string>, sectionName: string): string {
  const raw = sections.get(sectionName);

  if (!raw) {
    return "";
  }

  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^[-*•]/.test(line))
    .join(" ")
    .trim();
}

function extractSectionBullets(sections: Map<string, string>, sectionName: string): string[] {
  const raw = sections.get(sectionName);

  if (!raw) {
    return [];
  }

  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[-*•]/.test(line))
    .map((line) => line.replace(/^[-*•]\s*/, "").trim())
    .filter(Boolean)
    .slice(0, 4);
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
  const lowStructuralCoverage = input.research.evidence.length < 3;

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

  if (input.runtime.status === "blocked") {
    warnings.push("Execution runtime заблокирован: для автоматического изменения проекта нужно дополнительное подтверждение или уточнение.");
  }

  if (input.research.queryProfileKey === "broad-scan") {
    warnings.push("Запрос слишком широкий, поэтому вывод может быть менее точным, чем у узкосфокусированного вопроса.");
  }

  if (shouldForceEvidenceLockedMode(input)) {
    warnings.push("Держусь только доказанного — недоказанные гипотезы сюда намеренно не попали.");
  }

  return warnings.slice(0, 3);
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

  if (input.plan.targetFiles.length > 0) {
    actions.push("Можно открыть Inspector и посмотреть затронутые файлы и evidence.");
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
    : "(нет evidence)";

  const provenanceLine = [
    `baseline-фактов: ${input.research.evidenceSummary.baselineCount}`,
    `overlay-фактов: ${input.research.evidenceSummary.overlayCount}`,
    `structural-опор: ${input.research.evidenceSummary.structuralCount}`,
    input.research.evidenceSummary.overlayInfluenced
      ? "Локальные незакоммиченные изменения materially влияют на вывод."
      : "Вывод опирается прежде всего на committed baseline.",
  ].join(" | ");

  const freshnessLine = input.backgroundState
    ? [
        `freshness: ${input.backgroundState.freshness}`,
        `baselineSource: ${input.backgroundState.baselineSource}`,
        input.backgroundState.hasLocalChanges
          ? `Есть ${input.backgroundState.changedFileCount} незакоммиченных изменений в worktree — это overlay, а не baseline.`
          : "Worktree чист, все факты из committed baseline.",
      ].join(" | ")
    : "backgroundState отсутствует";

  const unknownsLine = input.research.unknowns.length > 0
    ? input.research.unknowns.slice(0, 4).map((u) => `- ${u}`).join("\n")
    : "(нет unknowns)";

  const risksLine = input.impact.risks.length > 0
    ? input.impact.risks.slice(0, 5).map((r) => `- ${r}`).join("\n")
    : "(риски не выявлены)";

  const planStepsLine = input.plan.steps.length > 0
    ? input.plan.steps.slice(0, 6).map((s, i) => `- Шаг ${i + 1}: ${s.title ?? s.description ?? ""}`).join("\n")
    : "(плана нет)";

  return [
    "=== ЗАПРОС ПОЛЬЗОВАТЕЛЯ ===",
    input.task,
    "",
    "=== 1. QUESTION CONTRACT ===",
    `Question type: ${brief.questionContract.questionType}`,
    `Expected shape: ${brief.questionContract.expectedAnswerShape}`,
    `Proof obligations: ${brief.questionContract.proofObligations.join(" | ") || "(нет)"}`,
    "",
    "=== 2. VALIDATED CLAIM SET ===",
    `Direct claim: ${brief.directAnswer}`,
    `Explanation lead: ${brief.explanationLead}`,
    "Supporting claims:",
    brief.claimSet.supportingClaims.length > 0
      ? brief.claimSet.supportingClaims.slice(0, 4).map((claim) => `- ${claim.statement}`).join("\n")
      : "(нет)",
    "",
    "Location claims:",
    brief.claimSet.locationClaims.length > 0
      ? brief.claimSet.locationClaims.slice(0, 4).map((claim) => `- ${claim.filePaths[0] ?? "?"}: ${claim.statement}`).join("\n")
      : "(нет)",
    "",
    "Impact claims:",
    brief.impactLines.length > 0
      ? brief.impactLines.map((line) => `- ${line}`).join("\n")
      : "(нет)",
    "",
    "Plan claims:",
    brief.planLines.length > 0
      ? brief.planLines.map((line) => `- ${line}`).join("\n")
      : "(нет)",
    "",
    "Rejected or unsafe claims:",
    brief.claimSet.rejectedClaims.length > 0
      ? brief.claimSet.rejectedClaims.slice(0, 3).map((claim) => `- ${claim.statement}`).join("\n")
      : "(нет)",
    "",
    "Material unknowns:",
    brief.materialUnknowns.length > 0
      ? brief.materialUnknowns.map((item) => `- ${item}`).join("\n")
      : "(нет)",
    "",
    "=== 3. SUPPORTING EVIDENCE ===",
    evidenceList,
    "",
    "Entry points:",
    input.research.entryPoints.length > 0
      ? input.research.entryPoints.slice(0, 6).map((ep) => `- ${ep}`).join("\n")
      : "(нет)",
    "",
    "Data sources:",
    input.research.dataSources.length > 0
      ? input.research.dataSources.slice(0, 6).map((ds) => `- ${ds}`).join("\n")
      : "(нет)",
    "",
    `Provenance: ${provenanceLine}`,
    "",
    `Freshness: ${freshnessLine}`,
    "",
    "=== 4. IMPACT (что будет затронуто при изменениях) ===",
    `Impact summary: ${input.impact.summary}`,
    `Affected files: ${input.impact.affectedFiles.length}`,
    input.impact.affectedFiles.length > 0
      ? input.impact.affectedFiles.slice(0, 8).map((f) => `- ${typeof f === "string" ? f : (f as { filePath?: string }).filePath ?? "?"}`).join("\n")
      : "(нет)",
    "",
    "Риски:",
    risksLine,
    "",
    "=== 5. CONTEXT (релевантные фрагменты кода) ===",
    `Context confidence: ${input.context.confidence}%`,
    `Token budget: ${input.context.tokenBudget}`,
    `Selected chunks: ${input.context.selectedChunks.length}`,
    input.context.functionalHighlights.length > 0
      ? `Highlights: ${input.context.functionalHighlights.slice(0, 5).join(" | ")}`
      : "(нет highlights)",
    input.context.rankingSummary
      ? `Ranking: ${input.context.rankingSummary}`
      : "",
    "",
    "=== 6. PLAN (план действий) ===",
    `Plan summary: ${input.plan.summary}`,
    `Target modules: ${input.plan.targetModules.join(", ") || "(нет)"}`,
    `Target files: ${input.plan.targetFiles.length}`,
    `Approval required: ${input.plan.approvalRequired ? "да" : "нет"}`,
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
    "=== UNKNOWNS (чего система НЕ знает) ===",
    unknownsLine,
    "",
    "=== ИНСТРУКЦИЯ ===",
    `Режим ответа: ${fallback.answerMode}`,
    "Сформируй ответ по-русски строго по структуре из system prompt.",
    "Используй только claims и факты, прямо подтверждённые в секциях выше.",
    "Если факт только из overlay findings — явно обозначь: «это обнаружено в незакоммиченных изменениях».",
    "Не добавляй типичные догадки про Laravel, middleware order, session, cookie, query params, kernel registration — если они не подтверждены выше.",
    "Если по разделу данных недостаточно — честно напиши об этом.",
    "Не упоминай слова Research, Impact, Context, Plan в ответе.",
    "Пиши как senior-разработчик, который объясняет коллеге.",
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
      return combined.includes(lowerPath) || combined.includes(basename);
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
  return PROVIDER_BASE_BACKOFF_MS * attempt;
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
