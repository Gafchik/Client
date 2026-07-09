import {
  type BackgroundProjectState,
  stableId,
  type AnswerEvidenceHighlight,
  type AnswerMode,
  type AnswerPackage,
  type ContextPackage,
  type ControlledExecutionRuntime,
  type ExecutionPlan,
  type ExecutionPreview,
  type ImpactReport,
  type ResearchReport,
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
}

interface ProviderChatResponse {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
    };
  }>;
}

const PROVIDER_REQUEST_TIMEOUT_MS = 25_000;
const PROVIDER_MAX_ATTEMPTS = 3;
const PROVIDER_BASE_BACKOFF_MS = 1_200;

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
  const evidenceHighlights = buildEvidenceHighlights(input);
  const warnings = buildWarnings(input);
  const unknowns = input.research.unknowns.slice(0, 4);
  const nextActions = buildNextActions(input, answerMode);
  const confirmedFacts = buildConfirmedFacts(input, evidenceHighlights);
  const unconfirmedFacts = buildUnconfirmedFacts(input, unknowns);
  const manualChecks = buildManualChecks(input, nextActions, warnings);
  const explanation = buildDeterministicExplanation(input, answerMode, evidenceHighlights, unknowns);

  return {
    answerId: stableId(["answer", input.runId]),
    runId: input.runId,
    answerMode,
    summary: buildDeterministicSummary(input, answerMode),
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
    providerUsed: {
      baseUrl: input.providerBaseUrl,
      model: input.providerModel,
    },
    synthesis: "deterministic-fallback",
  };
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
  const prompt = buildAnswerPrompt(input, fallback);
  const response = await performProviderRequest(endpoint, input.providerApiKey, {
    model: input.providerModel,
    temperature: 0.2,
    messages: [
      {
        role: "system",
        content:
          "Ты инженерный AI-ассистент. Отвечай только на основе переданных артефактов. Не выдумывай факты. Пиши по-русски. Сначала дай краткий ответ по сути, потом короткое объяснение, потом 1-3 следующих шага, если они нужны.",
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
  const lines = content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return {
      summary: fallback.summary,
      explanation: fallback.explanation,
      nextActions: fallback.nextActions,
      warnings: fallback.warnings,
    };
  }

  const summary = lines[0] ?? fallback.summary;
  const remaining = lines.slice(1);
  const bulletLines = remaining.filter((line) => /^[-*•]/.test(line));
  const nonBullet = remaining.filter((line) => !/^[-*•]/.test(line));

  return {
    summary,
    explanation: nonBullet.join(" ") || fallback.explanation,
    nextActions: bulletLines
      .map((line) => line.replace(/^[-*•]\s*/, "").trim())
      .filter(Boolean)
      .slice(0, 3),
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
  const billingRollback = input.research.functionalSummary.toLowerCase().includes("rollback bill")
    || input.research.functionalSummary.toLowerCase().includes("истории статусов");
  const hasUnknowns = input.research.unknowns.length > 0;
  const lowStructuralCoverage = input.research.evidence.length < 3;

  return diagnosticMode || localeBehavior || billingRollback || hasUnknowns || lowStructuralCoverage;
}

function computeAnswerConfidence(input: BuildAnswerInput): number {
  const freshnessPenalty =
    input.backgroundState?.freshness === "stale"
      ? 8
      : input.backgroundState?.freshness === "missing"
        ? 14
        : 0;

  return Math.max(
    15,
    Math.min(
      95,
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

function buildEvidenceHighlights(input: BuildAnswerInput): AnswerEvidenceHighlight[] {
  const highlights: AnswerEvidenceHighlight[] = [];
  const localeBehavior = input.research.functionalSummary.toLowerCase().includes("runtime-поведению локализации");
  const billingRollback = input.research.functionalSummary.toLowerCase().includes("rollback bill")
    || input.research.functionalSummary.toLowerCase().includes("истории статусов");
  const prioritizedEvidence = localeBehavior
    ? [...input.research.evidence].sort((left, right) => getLocaleEvidenceWeight(right) - getLocaleEvidenceWeight(left))
    : billingRollback
      ? [...input.research.evidence].sort((left, right) => getBillingEvidenceWeight(right) - getBillingEvidenceWeight(left))
      : input.research.evidence;

  for (const item of prioritizedEvidence.slice(0, 4)) {
    highlights.push({
      label: item.label,
      detail: item.reason,
    });
  }

  if (input.impact.affectedFiles.length > 0) {
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

function buildDeterministicSummary(input: BuildAnswerInput, mode: AnswerMode): string {
  if (mode === "insufficient-data-answer") {
    return "Сейчас недостаточно данных для полностью уверенного вывода, но система уже сузила вероятную зону причины.";
  }

  if (mode === "plan-summary-answer") {
    return input.plan.summary;
  }

  if (shouldForceEvidenceLockedMode(input)) {
    return buildEvidenceLockedSummary(input);
  }

  if (input.research.functionalSummary.trim().length > 0) {
    return `${input.research.functionalSummary} ${buildFreshnessSuffix(input)}`.trim();
  }

  return `${input.research.summary} ${buildFreshnessSuffix(input)}`.trim();
}

function buildDeterministicExplanation(
  input: BuildAnswerInput,
  mode: AnswerMode,
  evidenceHighlights: AnswerEvidenceHighlight[],
  unknowns: string[],
): string {
  if (shouldForceEvidenceLockedMode(input)) {
    return buildEvidenceLockedExplanation(input, evidenceHighlights, unknowns);
  }

  const parts: string[] = [];

  if (mode === "plan-summary-answer") {
    parts.push(input.plan.summary);
    parts.push(`План затрагивает ${input.plan.targetFiles.length} файлов и ${input.plan.targetModules.length} модулей.`);
  } else {
    parts.push(input.research.summary);
    const freshnessExplanation = buildFreshnessExplanation(input);
    const provenanceExplanation = buildEvidenceProvenanceExplanation(input.research);

    if (freshnessExplanation) {
      parts.push(freshnessExplanation);
    }

    if (provenanceExplanation) {
      parts.push(provenanceExplanation);
    }

    if (input.research.functionalSummary.trim().length > 0) {
      parts.push(input.research.functionalSummary);
    }

    if (input.research.entryPoints.length > 0) {
      parts.push(`Ключевые точки входа: ${input.research.entryPoints.slice(0, 4).join(", ")}.`);
    }

    if (input.research.dataSources.length > 0) {
      parts.push(`Основные источники данных: ${input.research.dataSources.slice(0, 4).join(", ")}.`);
    }
  }

  if (evidenceHighlights.length > 0) {
    parts.push(`Подтверждения: ${evidenceHighlights.map((item) => `${item.label} — ${item.detail}`).join(" | ")}.`);
  }

  if (unknowns.length > 0) {
    parts.push(`Открытые вопросы: ${unknowns.slice(0, 2).join(" | ")}.`);
  }

  return parts.join(" ");
}

function buildConfirmedFacts(
  input: BuildAnswerInput,
  evidenceHighlights: AnswerEvidenceHighlight[],
): string[] {
  const facts = [
    ...collectRuntimeFacts(input),
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

function buildEvidenceLockedSummary(input: BuildAnswerInput): string {
  const topEvidence = input.research.evidence[0];

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

function buildAnswerPrompt(input: BuildAnswerInput, fallback: AnswerPackage): string {
  return [
    `Запрос пользователя: ${input.task}`,
    `Режим ответа: ${fallback.answerMode}`,
    `Research summary: ${input.research.summary}`,
    `Functional summary: ${input.research.functionalSummary}`,
    `Entry points: ${input.research.entryPoints.slice(0, 6).join(", ") || "нет данных"}`,
    `Data sources: ${input.research.dataSources.slice(0, 6).join(", ") || "нет данных"}`,
    `Findings: ${input.research.findings.slice(0, 8).join(" | ") || "нет данных"}`,
    `Baseline findings: ${input.research.baselineFindings.slice(0, 6).join(" | ") || "нет данных"}`,
    `Overlay findings: ${input.research.overlayFindings.slice(0, 4).join(" | ") || "нет данных"}`,
    `Evidence provenance: baseline=${input.research.evidenceSummary.baselineCount}, overlay=${input.research.evidenceSummary.overlayCount}, structural=${input.research.evidenceSummary.structuralCount}`,
    `Unknowns: ${input.research.unknowns.slice(0, 4).join(" | ") || "нет данных"}`,
    `Impact summary: ${input.impact.summary}`,
    `Impact risks: ${input.impact.risks.slice(0, 5).join(" | ") || "нет данных"}`,
    `Context highlights: ${input.context.functionalHighlights.slice(0, 5).join(" | ") || "нет данных"}`,
    `Plan summary: ${input.plan.summary}`,
    `Execution preview: ${input.preview.summary}`,
    `Fallback summary: ${fallback.summary}`,
    "Сформируй короткий пользовательский ответ по-русски.",
    "Разрешено использовать только факты, которые прямо подтверждены переданными evidence, findings, data sources и entry points.",
    "Если факт опирается только на локальный незакоммиченный overlay, это нужно явно обозначить и не выдавать как committed baseline проекта.",
    "Запрещено добавлять типичные догадки про Laravel, middleware order, session, cookie, query params, kernel registration или другие детали, если они не подтверждены во входных данных.",
    "Если чего-то не хватает для уверенного вывода, прямо скажи, что это не подтверждено текущими данными.",
    "Не упоминай названия внутренних артефактов как основной результат. Не выдумывай то, чего нет в данных.",
  ].join("\n");
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
  const combined = `${answer.summary} ${answer.explanation}`.toLowerCase();
  const evidenceCorpus = [
    input.research.summary,
    input.research.functionalSummary,
    ...input.research.findings,
    ...input.research.dataSources,
    ...input.research.entryPoints,
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

  if (hallucinationSignals.length > 0) {
    return {
      summary: fallback.summary,
      explanation: fallback.explanation,
      nextActions: fallback.nextActions,
      warnings: [
        ...fallback.warnings,
        "LLM-ответ отклонён, потому что содержал недоказанные детали вне текущего evidence.",
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
