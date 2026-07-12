import {
  type BackgroundProjectState,
  clamp,
  stableId,
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
    validatedEvidence: input.research.evidence.slice(0, 6).map((item) => ({
      label: item.label,
      ...(item.filePath ? { filePath: item.filePath } : {}),
      reason: item.reason,
      origin: item.origin,
    })),
    validatorRationale: input.validation.rationale,
  };
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
  const status = resolveValidationStatus({
    packet,
    readinessScore,
    contradictionLevel,
    evidenceSufficiency,
    directAnswerFeasibility,
    recommendedActions,
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
          "Верни только JSON с полями validationStatus, readinessScore, directAnswerFeasibility, evidenceSufficiency, contradictionLevel, gapSummary, contradictions, missingConfirmations, recommendedActions, recommendedResearchProfile, recommendedStopReason, rationale.",
          "Нельзя придумывать действия вне разрешённого словаря.",
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

  return next;
}

export async function buildAnswerPackage(input: BuildAnswerInput): Promise<AnswerPackage> {
  const fallback = buildDeterministicAnswer(input);
  const evidenceLocked = shouldForceEvidenceLockedMode(input);
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
    || normalized.includes("используется")
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
    || normalized.includes("хран")
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
  const billingRollback = input.research.functionalSummary.toLowerCase().includes("rollback bill")
    || input.research.functionalSummary.toLowerCase().includes("истории статусов");

  if (localeBehavior) {
    return [...input.research.evidence].sort((left, right) => getLocaleEvidenceWeight(right) - getLocaleEvidenceWeight(left));
  }

  if (billingRollback) {
    return [...input.research.evidence].sort((left, right) => getBillingEvidenceWeight(right) - getBillingEvidenceWeight(left));
  }

  return input.research.evidence;
}

function buildClaimSet(input: BuildAnswerInput, contract: QuestionContract): ValidatedClaimSet {
  const strongestEvidence = getPrioritizedEvidence(input)[0];
  const runtimeFacts = collectRuntimeFacts(input);
  const caveats = input.validatedAnswerPacket?.mandatoryCaveats.slice(0, 2) ?? [];

  const directClaim: ClaimCandidate | undefined =
    input.validatedAnswerPacket?.directAnswerAllowed === false
      ? {
          id: stableId(["claim", input.runId, "direct-blocked"]),
          type: "direct-answer",
          statement: "Текущих подтверждений недостаточно для сильного прямого ответа.",
          evidence: caveats,
          filePaths: [],
          supportLevel: "weak",
          status: "partial",
          caveats,
        }
      : contract.questionType === "location" && strongestEvidence?.filePath
        ? {
            id: stableId(["claim", input.runId, "direct-location"]),
            type: "direct-answer",
            statement: `Главная точка для ответа находится в \`${strongestEvidence.filePath}\`.`,
            evidence: [strongestEvidence.label, strongestEvidence.reason].filter(Boolean),
            filePaths: [strongestEvidence.filePath],
            supportLevel: "strong",
            status: "supported",
            caveats,
          }
        : runtimeFacts[0]
          ? {
              id: stableId(["claim", input.runId, "direct-runtime"]),
              type: "direct-answer",
              statement: runtimeFacts[0],
              evidence: runtimeFacts.slice(0, 2),
              filePaths: strongestEvidence?.filePath ? [strongestEvidence.filePath] : [],
              supportLevel: "strong",
              status: "supported",
              caveats,
            }
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
    ...runtimeFacts.slice(1, 3).map((fact, index) => ({
      id: stableId(["claim", input.runId, "supporting-runtime", index]),
      type: "supporting" as const,
      statement: fact,
      evidence: [fact],
      filePaths: [],
      supportLevel: "strong" as const,
      status: "supported" as const,
      caveats: [],
    })),
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

function buildAnswerBrief(input: BuildAnswerInput, answerMode: AnswerMode): AnswerBrief {
  const questionContract = buildQuestionContract(input);
  const claimSet = buildClaimSet(input, questionContract);

  return {
    questionContract,
    claimSet,
    directAnswer: claimSet.directClaim?.statement ?? "Текущих подтверждений недостаточно для сильного прямого ответа.",
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
}): ValidationResult["status"] {
  if (input.contradictionLevel === "major") {
    return input.packet.remainingIterationBudget > 0 ? "needs-focused-research" : "contradictory-evidence";
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
  const billingRollback = input.research.functionalSummary.toLowerCase().includes("rollback bill")
    || input.research.functionalSummary.toLowerCase().includes("истории статусов");
  const hasUnknowns = input.research.unknowns.length > 0;
  const lowStructuralCoverage = input.research.evidence.length < 3;

  return diagnosticMode || localeBehavior || billingRollback || hasUnknowns || lowStructuralCoverage;
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

function getBillingEvidenceWeight(item: ResearchReport["evidence"][number]): number {
  const label = item.label.toLowerCase();
  const filePath = (item.filePath ?? "").toLowerCase();
  let score = item.score;

  if (label.includes("rollbackgenerated") || label.includes("rollbackdraft")) {
    score += 100;
  }

  if (filePath.includes("billcontroller.php")) {
    score += 80;
  }

  if (filePath.includes("togeneratedbillaction") || filePath.includes("todraftbillaction")) {
    score += 90;
  }

  if (filePath.includes("billmodel.php") || filePath.endsWith("/bill.php")) {
    score += 60;
  }

  if (label.includes("billhistory") || filePath.includes("billhistory")) {
    score += 70;
  }

  if (label.includes("was_been_rollback_to_generated")) {
    score += 110;
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
    warnings.push("Ответ зафиксирован в evidence-locked режиме: недоказанные гипотезы намеренно не выдаются как факты.");
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
    return "Текущих подтверждений недостаточно для сильного прямого ответа, поэтому система ограничивает вывод только тем, что реально доказано.";
  }

  if (mode === "insufficient-data-answer") {
    return "Сейчас недостаточно данных для полностью уверенного вывода, но система уже сузила вероятную зону причины.";
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
  const provenanceNote = buildEvidenceProvenanceExplanation(input.research);

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

  // Provenance note
  if (provenanceNote) {
    sections.push(`*${provenanceNote}*`);
  }

  if (freshnessNote) {
    sections.push(`*${freshnessNote}*`);
  }

  if (evidenceLocked) {
    sections.push("*Ответ зафиксирован в evidence-locked режиме: недоказанные гипотезы намеренно не включены.*");
  }

  if (sections.length === 0) {
    return input.research.summary;
  }

  return sections.join("\n\n");
}

function buildHowItWorksSection(input: BuildAnswerInput, brief: AnswerBrief, mode: AnswerMode): string {
  const parts: string[] = [];

  parts.push("## Как это работает");

  if (brief.explanationLead.trim().length > 0) {
    parts.push(brief.explanationLead);
  } else if (input.research.functionalSummary.trim().length > 0) {
    parts.push(input.research.functionalSummary);
  } else {
    parts.push(input.research.summary);
  }

  if (brief.claimSet.directClaim && brief.claimSet.directClaim.caveats.length > 0) {
    parts.push(`\nОграничения direct claim:`);
    for (const caveat of brief.claimSet.directClaim.caveats.slice(0, 2)) {
      parts.push(`- ${caveat}`);
    }
  }

  if (input.research.entryPoints.length > 0) {
    parts.push(`\nКлючевые точки входа:`);
    for (const ep of input.research.entryPoints.slice(0, 5)) {
      parts.push(`- ${ep}`);
    }
  }

  if (input.research.dataSources.length > 0) {
    parts.push(`\nИсточники данных:`);
    for (const ds of input.research.dataSources.slice(0, 4)) {
      parts.push(`- ${ds}`);
    }
  }

  if (input.research.findings.length > 0) {
    parts.push(`\nДетали:`);
    for (const finding of input.research.findings.slice(0, 5)) {
      parts.push(`- ${finding}`);
    }
  }

  if (mode === "plan-summary-answer") {
    parts.push(`\n${input.plan.summary}`);
  }

  return parts.join("\n");
}

function buildWhereToLookSection(input: BuildAnswerInput, brief: AnswerBrief): string {
  const evidence = getPrioritizedEvidence(input).filter((item) => item.filePath).slice(0, 6);

  if (evidence.length === 0) {
    return "";
  }

  const parts: string[] = ["## Где искать код"];

  for (const item of evidence) {
    const filePath = item.filePath ?? "";
    parts.push(`- \`${filePath}\` — ${item.label}`);
    if (item.reason) {
      parts.push(`  ${item.reason}`);
    }
  }

  if (brief.questionContract.requiresPlan && input.plan.targetFiles.length > 0) {
    parts.push(`\nЦелевые файлы плана (первые 5 из ${input.plan.targetFiles.length}):`);
    for (const tf of input.plan.targetFiles.slice(0, 5)) {
      parts.push(`- \`${tf}\``);
    }
  }

  return parts.join("\n");
}

function buildImpactSection(input: BuildAnswerInput, brief: AnswerBrief): string {
  if (!brief.questionContract.requiresImpact && brief.impactLines.length === 0) {
    return "";
  }

  const parts: string[] = ["## Что изменится при модификации"];

  parts.push(brief.impactLines[0] ?? input.impact.summary);

  if (input.impact.affectedFiles.length > 0) {
    parts.push(`\nЗатронутые файлы (${input.impact.affectedFiles.length}):`);
    for (const f of input.impact.affectedFiles.slice(0, 8)) {
      const path = typeof f === "string" ? f : (f as { filePath?: string }).filePath ?? "?";
      parts.push(`- \`${path}\``);
    }

    if (input.impact.affectedFiles.length > 8) {
      parts.push(`- ...и ещё ${input.impact.affectedFiles.length - 8} файлов`);
    }
  }

  if (input.impact.affectedSymbols.length > 0) {
    parts.push(`\nЗатронутые символы (${input.impact.affectedSymbols.length}): ${input.impact.affectedSymbols.slice(0, 6).join(", ")}`);
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
    return "## Возможные риски\n\nЯвных рисков не выявлено на основе текущих данных.";
  }

  const parts: string[] = ["## Возможные риски"];

  for (const risk of riskItems.slice(0, 6)) {
    parts.push(`- ${risk}`);
  }

  return parts.join("\n");
}

function buildPlanSection(input: BuildAnswerInput, brief: AnswerBrief): string {
  if (!brief.questionContract.requiresPlan && brief.planLines.length === 0) {
    return "";
  }

  const parts: string[] = ["## Рекомендуемый план действий"];

  if (brief.planLines.length > 0) {
    for (let i = 0; i < Math.min(brief.planLines.length, 6); i += 1) {
      const line = brief.planLines[i];
      if (line === undefined) {
        continue;
      }
      parts.push(`${i + 1}. ${line}`);
    }
  } else if (input.plan.steps.length > 0) {
    for (let i = 0; i < Math.min(input.plan.steps.length, 6); i++) {
      const step = input.plan.steps[i];
      if (step === undefined) {
        continue;
      }
      const label = step.title ?? step.description ?? `Шаг ${i + 1}`;
      parts.push(`${i + 1}. ${label}`);
    }
  } else {
    parts.push("Недостаточно данных для построения конкретного плана.");
  }

  if (input.plan.planningNotes) {
    parts.push(`\n*${input.plan.planningNotes}*`);
  }

  return parts.join("\n");
}

function buildConfirmedFacts(
  input: BuildAnswerInput,
  brief: AnswerBrief,
  evidenceHighlights: AnswerEvidenceHighlight[],
): string[] {
  const facts = [
    ...collectRuntimeFacts(input),
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

  if (brief.directAnswer.trim().length > 0 && !brief.directAnswer.startsWith("Текущих подтверждений недостаточно")) {
    return `${brief.directAnswer} ${buildFreshnessSuffix(input)}`.trim();
  }

  if (topEvidence?.filePath) {
    return `Наиболее сильное подтверждение сейчас находится в ${topEvidence.filePath}. ${buildFreshnessSuffix(input)}`.trim();
  }

  return `Ответ ограничен только подтвержденными структурными и runtime-сигналами текущего запуска. ${buildFreshnessSuffix(input)}`.trim();
}

function buildEvidenceLockedExplanation(
  input: BuildAnswerInput,
  evidenceHighlights: AnswerEvidenceHighlight[],
  unknowns: string[],
): string {
  const parts: string[] = [];
  const runtimeFacts = collectRuntimeFacts(input);
  const freshnessExplanation = buildFreshnessExplanation(input);

  if (runtimeFacts.length > 0) {
    parts.push(`Подтвержденные факты: ${runtimeFacts.join(" ")}`);
  } else {
    parts.push("Система не нашла достаточно прямых runtime-фактов, поэтому ответ ограничен структурными подтверждениями.");
  }

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

function buildFreshnessSuffix(input: BuildAnswerInput): string {
  if (!input.backgroundState) {
    return "";
  }

  if (input.backgroundState.freshness === "fresh") {
    return input.backgroundState.hasLocalChanges
      ? "Ответ опирается на актуальный committed baseline текущей ветки и локальный worktree overlay."
      : "Ответ опирается на актуальный committed baseline текущей ветки.";
  }

  if (input.backgroundState.freshness === "stale") {
    return "Ответ опирается на предыдущий committed baseline и текущий overlay изменений.";
  }

  if (input.backgroundState.freshness === "missing") {
    return "Ответ собран без заранее подготовленного baseline для этого состояния ветки.";
  }

  return "";
}

function buildFreshnessExplanation(input: BuildAnswerInput): string {
  if (!input.backgroundState) {
    return "";
  }

  if (input.backgroundState.freshness === "fresh") {
    return input.backgroundState.hasLocalChanges
      ? `Состояние branch/head синхронизировано по committed baseline, а текущие незакоммиченные изменения учитываются через worktree overlay (${input.backgroundState.changedFileCount} файлов).`
      : `Состояние branch/head синхронизировано: baseline source ${input.backgroundState.baselineSource}, локальный worktree чист.`;
  }

  if (input.backgroundState.freshness === "stale") {
    return `Состояние branch/head не полностью синхронизировано: используется baseline source ${input.backgroundState.baselineSource} и overlay для ${input.backgroundState.changedFileCount} изменённых файлов.`;
  }

  if (input.backgroundState.freshness === "missing") {
    return `Для этого branch/head ещё нет подготовленного committed baseline, поэтому запуск работает как первый проход и одновременно формирует знания для следующих вопросов.`;
  }

  return "";
}

function buildEvidenceProvenanceExplanation(research: ResearchReport): string {
  const { baselineCount, overlayCount, structuralCount, overlayInfluenced } = research.evidenceSummary;
  const parts = [`По происхождению фактов: baseline ${baselineCount}, overlay ${overlayCount}, structural ${structuralCount}.`];

  if (overlayInfluenced) {
    parts.push("Локальные незакоммиченные изменения materially влияют на часть вывода и отделены от committed baseline.");
  } else {
    parts.push("Ключевой вывод опирается прежде всего на committed baseline и graph-first структурные связи.");
  }

  return parts.join(" ");
}

function collectRuntimeFacts(input: BuildAnswerInput): string[] {
  const facts: string[] = [];
  const evidenceText = input.research.evidence
    .map((item) => `${item.label} ${item.reason} ${item.filePath ?? ""}`.toLowerCase())
    .join(" ");
  const findingsText = input.research.findings.join(" ").toLowerCase();
  const dataSourcesText = input.research.dataSources.join(" ").toLowerCase();

  if (evidenceText.includes("localemiddleware") || findingsText.includes("localemiddleware")) {
    facts.push("Выбор локали подтвержден через `LocaleMiddleware`.");
  }

  if (evidenceText.includes("x-locale") || dataSourcesText.includes("http-запроса")) {
    facts.push("Есть подтверждение, что локаль зависит от входящего HTTP-запроса и его заголовков.");
  }

  if (dataSourcesText.includes("fallback locale") || evidenceText.includes("config/app.php")) {
    facts.push("Есть подтверждение, что fallback локали читается из config/env-слоя.");
  }

  if (evidenceText.includes("setlocale") || findingsText.includes("locale")) {
    facts.push("Есть подтверждение явной установки locale в runtime-потоке.");
  }

  if (evidenceText.includes("rollbackgenerated") || findingsText.includes("rollbackgenerated")) {
    facts.push("Откат bill в generated подтвержден через отдельный controller/action flow `rollbackGenerated -> ToGeneratedBillAction`.");
  }

  if (evidenceText.includes("billspecifichistories") || evidenceText.includes("latestbillhistory") || dataSourcesText.includes("billhistory")) {
    facts.push("Есть подтверждение, что проверки rollback и связанных ограничений опираются на BillHistory и relations модели bill.");
  }

  if (evidenceText.includes("was_been_rollback_to_generated") || findingsText.includes("историю статусов")) {
    facts.push("Есть подтверждение вычисляемого guard-флага `was_been_rollback_to_generated`, который использует историю generated-статусов.");
  }

  if (evidenceText.includes("createbillhistoryaction") || evidenceText.includes("billhistorycreated::dispatch")) {
    facts.push("Есть подтверждение, что смена статуса создает новую запись BillHistory через `CreateBillHistoryAction`.");
  }

  return facts.slice(0, 4);
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
  const hallucinationSignals = [
    "session",
    "cookie",
    "query-параметр",
    "query param",
    "kernel.php",
    "app/http/kernel.php",
    "accept-language",
    "redis lock",
    "queue retry",
    "transaction retry",
  ].filter((token) => combined.includes(token) && !evidenceCorpus.includes(token));

  const directClaimMissing =
    brief.directAnswer.trim().length > 0
    && !combined.includes(brief.directAnswer.toLowerCase().slice(0, Math.min(40, brief.directAnswer.length)).trim());

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
        throw new Error(`Provider request failed with ${response.status}`);
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
