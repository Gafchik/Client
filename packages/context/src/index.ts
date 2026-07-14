import {
  clamp,
  isConfigPath,
  isLocalizationPath,
  stableId,
  type ContextCandidate,
  type ContextPackage,
  type GraphState,
  type ImpactReport,
  type IndexResult,
  type ResearchReport,
  type WorkspaceSnapshot,
} from "@client/shared";

interface BuildContextInput {
  runId: string;
  task: string;
  workspace: WorkspaceSnapshot;
  index: IndexResult;
  graph: GraphState;
  research: ResearchReport;
  impact: ImpactReport;
  /** includedFiles предыдущей реплики этого же диалога (см. pipeline-runner.ts) — лёгкий bias, не жёсткий приоритет. */
  priorIncludedFiles?: string[];
}

const TOKEN_BUDGET = 6000;
const MAX_CHUNKS = 12;
const FUNCTIONAL_MIN_CHUNKS = 3;
const FUNCTIONAL_MAX_CHUNKS = 6;
const STRUCTURAL_MIN_CHUNKS = 4;
const MAX_CANDIDATES_PER_ZONE = 4;
const MAX_OUTSIDE_ZONE_CANDIDATES = 2;

export function buildContextPackage(input: BuildContextInput): ContextPackage {
  const candidates: ContextCandidate[] = [];
  const taskTokens = tokenizeTask(input.task);
  const focusZones = deriveFocusZones(input);
  const queryProfileKey = input.research.queryProfileKey;

  for (const item of [
    input.research.functionalSummary,
    ...focusZones.map((zone) => `Фокус-зона: ${zone}`),
    ...input.research.entryPoints.map((entryPoint) => `Точка входа: ${entryPoint}`),
    ...input.research.primaryEntities.map((entity) => `Ключевая сущность: ${entity}`),
    ...input.research.sideEffects.map((effect) => `Побочный эффект: ${effect}`),
    ...input.research.dataSources.map((source) => `Источник данных: ${source}`),
  ]) {
    if (!item) {
      continue;
    }

    candidates.push({
      id: stableId(["context-functional", input.runId, item]),
      type: "functional",
      label: item,
      score: 0,
      priority: "critical",
      tokenEstimate: estimateTokens(item),
      reason: "Функциональный факт добавлен в контекст как объяснение поведения, назначения и active focus zone.",
      excerpt: item,
    });
  }

  for (const evidence of input.research.evidence) {
    const matchingFile = input.workspace.files.find((file) => file.relativePath === evidence.filePath);
    const excerpt = matchingFile ? extractRelevantExcerpt(matchingFile.content, taskTokens) : undefined;
    const candidate: ContextCandidate = {
      id: evidence.id,
      type: evidence.filePath ? "file" : "symbol",
      label: evidence.label,
      score: 0,
      priority: evidence.filePath ? "high" : "supporting",
      tokenEstimate: estimateTokens(excerpt ?? evidence.label),
      reason: evidence.origin === "overlay"
        ? `${evidence.reason} Источник: локальный worktree overlay.`
        : evidence.origin === "baseline"
          ? `${evidence.reason} Источник: committed baseline.`
          : evidence.origin === "recalled"
            ? `${evidence.reason} Источник: переиспользовано из предыдущего исследования (не подтверждено текущим git-состоянием).`
            : `${evidence.reason} Источник: structural graph/symbol layer.`,
    };

    if (evidence.filePath) {
      candidate.filePath = evidence.filePath;
    }

    if (excerpt) {
      candidate.excerpt = excerpt;
    }

    candidates.push(candidate);
  }

  for (const filePath of input.impact.affectedFiles) {
    const matchingFile = input.workspace.files.find((file) => file.relativePath === filePath);

    if (!matchingFile) {
      continue;
    }

    const excerpt = extractRelevantExcerpt(matchingFile.content, taskTokens);
    const candidate: ContextCandidate = {
      id: stableId(["context-file", filePath]),
      type: "file",
      label: filePath,
      score: 0,
      priority: isFocusZoneFile(filePath, focusZones) ? "high" : "supporting",
      tokenEstimate: estimateTokens(excerpt),
      reason: isFocusZoneFile(filePath, focusZones)
        ? "Файл попал в контекст как часть focus zone и подтверждённой зоны влияния."
        : "Файл попал в контекст как часть прогнозируемой зоны влияния.",
      filePath,
      excerpt,
    };

    candidates.push(candidate);
  }

  const uniqueCandidates = dedupeCandidates(candidates)
    .map((candidate) => rankCandidate(candidate, input, taskTokens, focusZones, queryProfileKey))
    .sort(compareCandidates);
  const selectedChunks: ContextCandidate[] = [];
  const omittedCandidates: ContextCandidate[] = [];
  let estimatedTokens = 0;

  for (const candidate of uniqueCandidates.filter((item) => item.type === "functional")) {
    if (selectedChunks.length >= FUNCTIONAL_MIN_CHUNKS) {
      break;
    }

    if (estimatedTokens + candidate.tokenEstimate > TOKEN_BUDGET || selectedChunks.length >= MAX_CHUNKS) {
      omittedCandidates.push(candidate);
      continue;
    }

    selectedChunks.push(candidate);
    estimatedTokens += candidate.tokenEstimate;
  }

  for (const zone of focusZones) {
    const zoneCandidate = uniqueCandidates.find((candidate) => {
      if (selectedChunks.some((item) => item.id === candidate.id)) {
        return false;
      }

      if (candidate.type === "functional") {
        return false;
      }

      return candidateMatchesZone(candidate, zone);
    });

    if (!zoneCandidate) {
      continue;
    }

    if (estimatedTokens + zoneCandidate.tokenEstimate <= TOKEN_BUDGET && selectedChunks.length < MAX_CHUNKS) {
      selectedChunks.push(zoneCandidate);
      estimatedTokens += zoneCandidate.tokenEstimate;
    } else {
      omittedCandidates.push(withOmissionReason(zoneCandidate, "Кандидат не поместился после резервирования обязательного покрытия focus zone."));
    }
  }

  for (const candidate of uniqueCandidates) {
    if (selectedChunks.some((item) => item.id === candidate.id)) {
      continue;
    }

    if (candidate.type === "functional") {
      const selectedFunctionalCount = selectedChunks.filter((item) => item.type === "functional").length;

      if (selectedFunctionalCount >= FUNCTIONAL_MAX_CHUNKS) {
        omittedCandidates.push(withOmissionReason(candidate, "Достигнут лимит purely-functional фрагментов, дальше приоритет отдаётся структурным опорам."));
        continue;
      }

      const selectedStructuralCount = selectedChunks.filter((item) => item.type !== "functional").length;
      const remainingSlots = MAX_CHUNKS - selectedChunks.length;
      const structuralDeficit = Math.max(STRUCTURAL_MIN_CHUNKS - selectedStructuralCount, 0);

      if (structuralDeficit > 0 && remainingSlots <= structuralDeficit) {
        omittedCandidates.push(withOmissionReason(candidate, "Слот зарезервирован под структурные файлы и символы для минимального инженерного покрытия."));
        continue;
      }
    }

    const rejectionReason = getCandidateRejectionReason(candidate, selectedChunks, input, focusZones);

    if (rejectionReason) {
      omittedCandidates.push(withOmissionReason(candidate, rejectionReason));
      continue;
    }

    if (estimatedTokens + candidate.tokenEstimate <= TOKEN_BUDGET && selectedChunks.length < MAX_CHUNKS) {
      selectedChunks.push(candidate);
      estimatedTokens += candidate.tokenEstimate;
    } else {
      omittedCandidates.push(withOmissionReason(candidate, "Кандидат исключён из-за token budget или лимита размера context package."));
    }
  }

  const includedFiles = [...new Set(selectedChunks.map((candidate) => candidate.filePath).filter(Boolean) as string[])];
  const selectedFunctional = selectedChunks.filter((candidate) => candidate.type === "functional");
  const confidence = clamp(
    Math.round((input.research.confidence + input.impact.confidence + Math.min(selectedChunks.length * 4, 20)) / 2),
    10,
    95,
  );

  return {
    contextId: stableId(["context", input.runId]),
    runId: input.runId,
    summary: `Собран контекстный пакет из ${selectedChunks.length} фрагментов с оценкой ${estimatedTokens} токенов при бюджете ${TOKEN_BUDGET}.`,
    functionalHighlights: selectedFunctional.map((candidate) => candidate.label).slice(0, 5),
    focusZones,
    rankingSummary: buildRankingSummary(selectedChunks, omittedCandidates, includedFiles.length, focusZones),
    tokenBudget: TOKEN_BUDGET,
    estimatedTokens,
    includedFiles,
    selectedChunks,
    omittedCandidates,
    rules: [
      "В контекст попадают только релевантные файлы, символы и functional zones.",
      "Функциональные факты о назначении, точках входа, side effects и focus zones добавляются раньше вторичных деталей.",
      "Приоритет получают прямые evidence из research, файлы из impact и зоны, подтверждённые graph/planner.",
      "Committed baseline-backed факты приоритетнее overlay-фактов, если вопрос не требует локально незакоммиченных изменений.",
      "Overlay-факты добавляются явно и отдельно, чтобы LLM не смешивала локальную разработку с каноническим baseline проекта.",
      "Под test/docs/config-файлы применяется штраф, если задача явно не требует их анализа.",
      "Query profile Research ограничивает попадание нерелевантных файлов из соседних доменов и инвентарных зон.",
      "Контекст ограничивается token budget и не включает лишние фрагменты.",
    ],
    confidence,
  };
}

function rankCandidate(
  candidate: ContextCandidate,
  input: BuildContextInput,
  taskTokens: string[],
  focusZones: string[],
  queryProfileKey: ResearchReport["queryProfileKey"],
): ContextCandidate {
  let score = candidate.score;
  const filePath = candidate.filePath;
  const infrastructureFocus = isInfrastructureQuestion(taskTokens);

  if (candidate.type === "functional") {
    score += 120;
  }

  if (filePath && input.impact.affectedFiles.includes(filePath)) {
    score += 45;
  }

  if (filePath && input.research.references.includes(filePath)) {
    score += 35;
  }

  if (filePath && input.research.moduleIntents.some((intent, index) => intent.matchedFiles.includes(filePath) && index === 0)) {
    score += 40;
  }

  if (filePath && isFocusZoneFile(filePath, focusZones)) {
    score += 42;
  }

  // Файл уже был включён в контекст предыдущей реплики этого диалога —
  // небольшой bias в пользу continuity, а не жёсткий приоритет: если новый
  // вопрос реально сменил тему, сильные структурные/impact-сигналы выше всё
  // равно перевесят.
  if (filePath && input.priorIncludedFiles?.includes(filePath)) {
    score += 20;
  }

  if (candidate.label && focusZones.some((zone) => candidate.label.toLowerCase().includes(zone.toLowerCase()))) {
    score += 34;
  }

  if (candidate.type === "symbol") {
    score += 18;
  }

  if (filePath) {
    score += scoreByPath(filePath, taskTokens, focusZones);
    score += infrastructureFocus ? scoreInfrastructurePath(filePath, candidate, input) : 0;
    score += scoreByQueryProfile(filePath, candidate, queryProfileKey, input);
  }

  if (candidate.label) {
    const normalizedLabel = candidate.label.toLowerCase();
    const matches = taskTokens.filter((token) => normalizedLabel.includes(token)).length;
    score += matches * 6;
  }

  if (candidate.priority === "critical") {
    score += 30;
  } else if (candidate.priority === "high") {
    score += 12;
  }

  return {
    ...candidate,
    score,
  };
}

function compareCandidates(left: ContextCandidate, right: ContextCandidate): number {
  const priorityOrder = {
    critical: 3,
    high: 2,
    supporting: 1,
  } satisfies Record<ContextCandidate["priority"], number>;

  return (
    right.score - left.score ||
    priorityOrder[right.priority] - priorityOrder[left.priority] ||
    left.tokenEstimate - right.tokenEstimate ||
    left.label.localeCompare(right.label)
  );
}

function getCandidateRejectionReason(
  candidate: ContextCandidate,
  selectedChunks: ContextCandidate[],
  input: BuildContextInput,
  focusZones: string[],
): string | null {
  if (candidate.type === "functional") {
    return null;
  }

  if (candidate.filePath && selectedChunks.some((item) => item.filePath === candidate.filePath && item.type !== "functional")) {
    return "Файл уже покрыт более сильным фрагментом, повторное включение не улучшает контекст.";
  }

  if (candidate.filePath) {
    const profileMismatchReason = getQueryProfileMismatchReason(candidate, input);

    if (profileMismatchReason && !isDirectStructuralAnchor(candidate, input)) {
      return profileMismatchReason;
    }
  }

  const candidateZone = deriveCandidateZone(candidate, focusZones);

  if (candidateZone) {
    const zoneCount = selectedChunks.filter((item) => deriveCandidateZone(item, focusZones) === candidateZone).length;

    if (zoneCount >= MAX_CANDIDATES_PER_ZONE) {
      return `Для зоны ${candidateZone} уже набрано достаточно сильных фрагментов.`;
    }

    return null;
  }

  if (isDirectStructuralAnchor(candidate, input)) {
    const outsideZoneCount = selectedChunks.filter((item) => item.type !== "functional" && !deriveCandidateZone(item, focusZones)).length;

    if (outsideZoneCount >= MAX_OUTSIDE_ZONE_CANDIDATES) {
      return "Вне focus zones уже добавлено достаточно прямых структурных опор.";
    }

    return null;
  }

  return "Кандидат находится вне focus zones и не подтверждён как прямая структурная опора исследования.";
}

function dedupeCandidates(candidates: ContextCandidate[]): ContextCandidate[] {
  const map = new Map<string, ContextCandidate>();

  for (const candidate of candidates) {
    const key = candidate.filePath ? `${candidate.type}:${candidate.filePath}` : `${candidate.type}:${candidate.label}`;
    const current = map.get(key);

    if (!current || current.score < candidate.score) {
      map.set(key, candidate);
    }
  }

  return [...map.values()];
}

function estimateTokens(value: string): number {
  return Math.max(20, Math.ceil(value.length / 4));
}

function extractRelevantExcerpt(content: string, taskTokens: string[]): string {
  const lines = content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const matchingLine =
    lines.find((line) => {
      const normalized = line.toLowerCase();
      return taskTokens.some((token) => normalized.includes(token));
    }) ?? lines[0] ?? "";

  return matchingLine.slice(0, 280);
}

function scoreByPath(filePath: string, taskTokens: string[], focusZones: string[]): number {
  const normalized = filePath.toLowerCase();
  let score = 0;

  if (normalized.startsWith("apps/") || normalized.startsWith("packages/")) {
    score += 10;
  }

  if (normalized.includes("/src/")) {
    score += 12;
  }

  if (focusZones.some((zone) => normalized.includes(zone.toLowerCase()))) {
    score += 22;
  }

  if (normalized.includes("/test") || normalized.includes(".test.") || normalized.includes(".spec.")) {
    score -= taskTokens.some((token) => ["test", "тест", "coverage"].includes(token)) ? 0 : 20;
  }

  if (normalized.includes("/docs/") || normalized.endsWith(".md")) {
    score -= taskTokens.some((token) => ["doc", "docs", "док", "documentation"].includes(token)) ? 0 : 16;
  }

  if (normalized.endsWith(".json") || normalized.includes("config")) {
    score -= taskTokens.some((token) => ["config", "конфиг", "env", "environment"].includes(token)) ? 0 : 8;
  }

  return score;
}

function scoreInfrastructurePath(
  filePath: string,
  candidate: ContextCandidate,
  input: BuildContextInput,
): number {
  const normalized = filePath.toLowerCase();
  const candidateText = `${candidate.label} ${candidate.excerpt ?? ""}`.toLowerCase();
  let score = 0;

  if (normalized.includes("/models/") || normalized.includes("/entities/")) {
    score += 26;
  }

  if (normalized.includes("/repositories/") || normalized.includes("/repository/")) {
    score += 26;
  }

  if (normalized.includes("/migrations/") || normalized.includes("schema")) {
    score += 30;
  }

  if (normalized.includes("/requests/")) {
    score += 20;
  }

  if (normalized.includes("/config/") || normalized.endsWith(".env") || normalized.includes(".env.")) {
    score += 24;
  }

  if (normalized.includes("credential") || normalized.includes("secret") || normalized.includes("vault")) {
    score += 24;
  }

  if (normalized.includes("server") || normalized.includes("connection") || normalized.includes("forwarding")) {
    score += 22;
  }

  if (
    candidateText.includes("host")
    || candidateText.includes("port")
    || candidateText.includes("username")
    || candidateText.includes("private_key")
    || (candidateText.includes("forwarding") && candidateText.includes("port"))
  ) {
    score += 28;
  }

  if (normalized.includes("/controllers/")) {
    score += 8;
  }

  if (normalized.includes("/views/") || normalized.includes("/resources/js/") || normalized.includes("/resources/css/")) {
    score -= 24;
  }

  if (normalized.includes("/lang/")) {
    score -= 20;
  }

  if (normalized.includes("/test") || normalized.includes(".test.") || normalized.includes(".spec.")) {
    score -= 16;
  }

  if (normalized.includes("/models/user") || normalized.includes("/users/")) {
    score -= 18;
  }

  if (
    normalized.includes("/vault/")
    && !normalized.includes("credential")
    && !candidateText.includes("private_key")
  ) {
    score -= 18;
  }

  if (
    normalized.includes("/migrations/")
    && !candidateText.includes("servers")
    && !candidateText.includes("passwords")
    && !candidateText.includes("private_key")
  ) {
    score -= 26;
  }

  if (candidate.label.toLowerCase().includes("server") && candidate.label.toLowerCase().includes("credential")) {
    score += 18;
  }

  if (input.research.references.includes(filePath)) {
    score += 10;
  }

  return score;
}

function buildRankingSummary(
  selectedChunks: ContextCandidate[],
  omittedCandidates: ContextCandidate[],
  includedFileCount: number,
  focusZones: string[],
): string[] {
  const functionalCount = selectedChunks.filter((candidate) => candidate.type === "functional").length;
  const fileCount = selectedChunks.filter((candidate) => candidate.type === "file").length;
  const symbolCount = selectedChunks.filter((candidate) => candidate.type === "symbol").length;

  return [
    `В контекст вошло ${functionalCount} functional facts, ${fileCount} файловых фрагментов и ${symbolCount} символьных опор.`,
    focusZones.length ? `Контекст собран вокруг focus zones: ${focusZones.slice(0, 4).join(", ")}.` : "Явные focus zones не были выделены.",
    `Покрыто ${includedFileCount} уникальных файлов без раздувания пакета вторичными источниками.`,
    focusZones.length
      ? `Для каждой активной focus zone сначала резервируется хотя бы одна сильная структурная опора.`
      : "При отсутствии focus zones контекст собирается только по прямым evidence и impact-совпадениям.",
    omittedCandidates.length > 0
      ? `${omittedCandidates.length} кандидатов были исключены по token budget или из-за более низкого приоритета.`
      : "Все релевантные кандидаты уместились в текущий token budget.",
  ];
}

function tokenizeTask(task: string): string[] {
  return task
    .toLowerCase()
    .split(/[^a-z0-9а-яё_/-]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function deriveFocusZones(input: BuildContextInput): string[] {
  if (input.research.queryProfileKey === "localization-inventory") {
    return ["localization", "lang", "translations", "i18n"];
  }

  if (input.research.queryProfileKey === "config-inventory") {
    return ["config", "environment", "env"];
  }

  if (input.research.queryProfileKey === "storage-topology") {
    return ["servers", "vault"];
  }

  if (input.research.queryProfileKey === "broad-scan") {
    return ["repository-overview", ...input.research.affectedModules.slice(0, 4)];
  }

  const dominantModule = input.research.dominantModule;
  const strongIntentThreshold = Math.max((input.research.moduleIntents[0]?.score ?? 0) * 0.4, 300);
  const strongIntentModules = input.research.moduleIntents
    .filter((intent) => intent.score >= strongIntentThreshold)
    .map((intent) => intent.module);
  const entryPointZones = input.research.entryPoints.flatMap(extractZonesFromText);
  const fileZones = input.impact.affectedFiles.flatMap(extractZonesFromPath);
  const candidateZones = [
    dominantModule,
    ...strongIntentModules,
    ...entryPointZones,
    ...fileZones,
  ].filter(Boolean);

  const uniqueZones = candidateZones.filter((value, index, list) => list.indexOf(value) === index);

  return uniqueZones.filter((zone) => {
    if (zone === dominantModule) {
      return true;
    }

    if (strongIntentModules.includes(zone)) {
      return true;
    }

    if (entryPointZones.includes(zone)) {
      return true;
    }

    const zoneInFiles = fileZones.includes(zone);
    const zoneInResearchPath = input.research.references.some((reference) => reference.toLowerCase().includes(zone.toLowerCase()));

    return zoneInFiles && zoneInResearchPath;
  }).slice(0, 6);
}

function extractZonesFromText(value: string): string[] {
  const normalized = value.toLowerCase();
  const zones: string[] = [];

  if (normalized.includes("auth")) {
    zones.push("auth");
  }

  if (normalized.includes("verify") || normalized.includes("email")) {
    zones.push("email-verification");
  }

  if (normalized.includes("server") || normalized.includes("ssh") || normalized.includes("host") || normalized.includes("port")) {
    zones.push("servers");
  }

  if (normalized.includes("vault") || normalized.includes("credential") || normalized.includes("private_key") || normalized.includes("passphrase")) {
    zones.push("vault");
  }

  return zones;
}

function extractZonesFromPath(filePath: string): string[] {
  const normalized = filePath.toLowerCase();
  const zones: string[] = [];

  if (normalized.includes("/auth/") || normalized.includes("authcontroller")) {
    zones.push("auth");
  }

  if (normalized.includes("verifyemail") || normalized.includes("emailverification")) {
    zones.push("email-verification");
  }

  if (normalized.includes("/models/user")) {
    zones.push("user-models");
  }

  if (
    normalized.includes("/servers/")
    || normalized.includes("/models/server")
    || (normalized.includes("server") && normalized.includes("credential"))
    || (normalized.includes("forwarding") && normalized.includes("port"))
  ) {
    zones.push("servers");
  }

  if (
    normalized.includes("/vault/")
    || normalized.includes("/models/password")
    || normalized.includes("credential")
    || normalized.includes("private_key")
    || normalized.includes("passphrase")
  ) {
    zones.push("vault");
  }

  return zones;
}

function isFocusZoneFile(filePath: string, focusZones: string[]): boolean {
  const normalized = filePath.toLowerCase();
  return focusZones.some((zone) => normalized.includes(zone.toLowerCase().replace(/:/g, "/")));
}

function candidateMatchesZone(candidate: ContextCandidate, zone: string): boolean {
  const normalizedZone = zone.toLowerCase();
  const label = candidate.label.toLowerCase();
  const filePath = candidate.filePath?.toLowerCase() ?? "";

  return label.includes(normalizedZone) || filePath.includes(normalizedZone.replace(/:/g, "/"));
}

function deriveCandidateZone(candidate: ContextCandidate, focusZones: string[]): string | null {
  for (const zone of focusZones) {
    if (candidateMatchesZone(candidate, zone)) {
      return zone;
    }
  }

  return null;
}

function isDirectStructuralAnchor(candidate: ContextCandidate, input: BuildContextInput): boolean {
  if (candidate.filePath && input.research.references.includes(candidate.filePath)) {
    return true;
  }

  if (input.research.evidence.some((item) => item.id === candidate.id)) {
    return true;
  }

  return input.research.entryPoints.some((entryPoint) => candidate.label.includes(entryPoint) || entryPoint.includes(candidate.label));
}

function withOmissionReason(candidate: ContextCandidate, omissionReason: string): ContextCandidate {
  return {
    ...candidate,
    reason: `${candidate.reason} Исключение: ${omissionReason}`,
  };
}

function isInfrastructureQuestion(taskTokens: string[]): boolean {
  return taskTokens.some((token) =>
    [
      "ssh",
      "sftp",
      "ftp",
      "server",
      "servers",
      "connection",
      "connections",
      "credential",
      "credentials",
      "host",
      "hostname",
      "port",
      "private_key",
      "passphrase",
      "vault",
      "сервер",
      "подключение",
      "подключения",
      "соединение",
      "соединения",
      "хост",
      "порт",
      "ключ",
      "пароль",
      "креды",
    ].includes(token),
  );
}

function scoreByQueryProfile(
  filePath: string,
  candidate: ContextCandidate,
  queryProfileKey: ResearchReport["queryProfileKey"],
  input: BuildContextInput,
): number {
  const normalized = filePath.toLowerCase();
  const text = `${candidate.label} ${candidate.excerpt ?? ""}`.toLowerCase();

  switch (queryProfileKey) {
    case "entrypoint-traversal":
      return scoreEntrypointContext(normalized, text);
    case "storage-topology":
      return scoreStorageTopologyContext(normalized, text);
    case "localization-inventory":
      return scoreLocalizationContext(normalized, text);
    case "config-inventory":
      return scoreConfigContext(normalized, text);
    case "broad-scan":
      return scoreBroadScanContext(normalized, text, input);
    default:
      return 0;
  }
}

function getQueryProfileMismatchReason(candidate: ContextCandidate, input: BuildContextInput): string | null {
  const filePath = candidate.filePath?.toLowerCase();

  if (!filePath) {
    return null;
  }

  switch (input.research.queryProfileKey) {
    case "localization-inventory":
      if (isLocalizationPath(filePath)) {
        return null;
      }

      if (filePath.includes("/routes/") || filePath.includes("/controllers/") || filePath.includes("/services/")) {
        return "Файл исключён: localization inventory должен собираться вокруг translation-структуры, а не runtime flow.";
      }

      return null;
    case "config-inventory":
      if (isConfigPath(filePath)) {
        return null;
      }

      if (filePath.includes("/routes/") || filePath.includes("/controllers/") || filePath.includes("/views/")) {
        return "Файл исключён: config inventory должен собираться вокруг config/env источников, а не runtime handlers.";
      }

      return null;
    case "storage-topology":
      if (isStoragePath(filePath)) {
        return null;
      }

      if (filePath.includes("/lang/") || filePath.endsWith(".md")) {
        return "Файл исключён: storage topology не должен раздуваться локализацией и документацией без прямого подтверждения.";
      }

      return null;
    default:
      return null;
  }
}

function scoreEntrypointContext(filePath: string, text: string): number {
  let score = 0;

  if (filePath.includes("/routes/")) {
    score += 28;
  }

  if (filePath.includes("/controllers/")) {
    score += 24;
  }

  if (filePath.includes("/services/") || filePath.includes("/actions/")) {
    score += 18;
  }

  if (filePath.includes("/requests/") || filePath.includes("/middleware/")) {
    score += 14;
  }

  if (filePath.includes("/models/")) {
    score += 10;
  }

  if (filePath.includes("/lang/") || filePath.includes("/config/")) {
    score -= 12;
  }

  if (text.includes("route") || text.includes("controller") || text.includes("login") || text.includes("auth")) {
    score += 12;
  }

  return score;
}

function scoreStorageTopologyContext(filePath: string, text: string): number {
  let score = 0;

  if (isStoragePath(filePath)) {
    score += 26;
  }

  if (filePath.includes("/models/") || filePath.includes("/repositories/")) {
    score += 18;
  }

  if (filePath.includes("/migrations/") || filePath.includes("/requests/")) {
    score += 16;
  }

  if (text.includes("host") || text.includes("port") || text.includes("username") || text.includes("private_key")) {
    score += 16;
  }

  if (filePath.includes("/views/") || filePath.includes("/lang/")) {
    score -= 20;
  }

  return score;
}

function scoreLocalizationContext(filePath: string, text: string): number {
  let score = 0;

  if (isLocalizationPath(filePath)) {
    score += 38;
  }

  if (text.includes("translation") || text.includes("locale") || text.includes("локал") || text.includes("язык")) {
    score += 12;
  }

  if (filePath.includes("/routes/") || filePath.includes("/controllers/") || filePath.includes("/services/")) {
    score -= 28;
  }

  return score;
}

function scoreConfigContext(filePath: string, text: string): number {
  let score = 0;

  if (isConfigPath(filePath)) {
    score += 38;
  }

  if (text.includes("env(") || text.includes("process.env") || text.includes("import.meta.env")) {
    score += 14;
  }

  if (filePath.includes("/routes/") || filePath.includes("/controllers/") || filePath.includes("/views/")) {
    score -= 28;
  }

  return score;
}

function scoreBroadScanContext(filePath: string, text: string, input: BuildContextInput): number {
  let score = 0;

  if (filePath.startsWith("app/") || filePath.startsWith("src/") || filePath.startsWith("packages/")) {
    score += 12;
  }

  if (filePath.includes("/routes/") || filePath.includes("/controllers/") || filePath.includes("/config/")) {
    score += 8;
  }

  if (input.research.references.includes(candidateFilePath(filePath, input))) {
    score += 6;
  }

  if (text.includes("summary") || text.includes("фокус-зона")) {
    score -= 4;
  }

  return score;
}

function candidateFilePath(filePath: string, _input: BuildContextInput): string {
  return filePath;
}

function isStoragePath(filePath: string): boolean {
  return (
    filePath.includes("/servers/")
    || filePath.includes("/vault/")
    || filePath.includes("/migrations/")
    || filePath.includes("/repositories/")
    || filePath.includes("/requests/")
    || (filePath.includes("server") && filePath.includes("credential"))
    || (filePath.includes("forwarding") && filePath.includes("port"))
    || filePath.includes("/models/server")
    || filePath.includes("/models/password")
  );
}
