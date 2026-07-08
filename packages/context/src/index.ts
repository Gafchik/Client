import {
  clamp,
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
}

const TOKEN_BUDGET = 6000;
const MAX_CHUNKS = 12;
const FUNCTIONAL_MIN_CHUNKS = 3;

export function buildContextPackage(input: BuildContextInput): ContextPackage {
  const candidates: ContextCandidate[] = [];
  const taskTokens = tokenizeTask(input.task);
  const focusZones = deriveFocusZones(input);

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
      reason: evidence.reason,
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
    .map((candidate) => rankCandidate(candidate, input, taskTokens, focusZones))
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

  for (const candidate of uniqueCandidates) {
    if (selectedChunks.some((item) => item.id === candidate.id)) {
      continue;
    }

    if (estimatedTokens + candidate.tokenEstimate <= TOKEN_BUDGET && selectedChunks.length < MAX_CHUNKS) {
      selectedChunks.push(candidate);
      estimatedTokens += candidate.tokenEstimate;
    } else {
      omittedCandidates.push(candidate);
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
      "Под test/docs/config-файлы применяется штраф, если задача явно не требует их анализа.",
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
): ContextCandidate {
  let score = candidate.score;
  const filePath = candidate.filePath;

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

  if (candidate.label && focusZones.some((zone) => candidate.label.toLowerCase().includes(zone.toLowerCase()))) {
    score += 34;
  }

  if (candidate.type === "symbol") {
    score += 18;
  }

  if (filePath) {
    score += scoreByPath(filePath, taskTokens, focusZones);
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

  if (normalized.includes("web-login")) {
    zones.push("web-login");
  }

  if (normalized.includes("auth")) {
    zones.push("auth");
  }

  if (normalized.includes("verify") || normalized.includes("email")) {
    zones.push("email-verification");
  }

  return zones;
}

function extractZonesFromPath(filePath: string): string[] {
  const normalized = filePath.toLowerCase();
  const zones: string[] = [];

  if (normalized.includes("web-login")) {
    zones.push("web-login");
  }

  if (normalized.includes("/auth/") || normalized.includes("authcontroller")) {
    zones.push("auth");
  }

  if (normalized.includes("verifyemail") || normalized.includes("emailverification")) {
    zones.push("email-verification");
  }

  if (normalized.includes("/models/user")) {
    zones.push("user-models");
  }

  return zones;
}

function isFocusZoneFile(filePath: string, focusZones: string[]): boolean {
  const normalized = filePath.toLowerCase();
  return focusZones.some((zone) => normalized.includes(zone.toLowerCase().replace(/:/g, "/")));
}
