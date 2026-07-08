import {
  getCodeNodes,
  getEntryPointNeighbors,
  getModuleRelationSummary,
  getModuleRelations,
  getNodesByKind,
  getRouteNodes,
  getRoutesForModule,
} from "@client/graph";
import {
  clamp,
  scoreText,
  tokenize,
  type GraphState,
  type IndexSymbol,
  type IndexResult,
  type ModuleIntentMatch,
  type ResearchReport,
  type ScoredReference,
  type WorkspaceSnapshot,
} from "@client/shared";

interface ResearchInput {
  runId: string;
  task: string;
  workspace: WorkspaceSnapshot;
  index: IndexResult;
  graph: GraphState;
}

interface IntentProfile {
  key: string;
  aliases: string[];
}

const INTENT_PROFILES: IntentProfile[] = [
  {
    key: "auth",
    aliases: [
      "auth",
      "authentication",
      "authorization",
      "authorize",
      "authorisation",
      "login",
      "signin",
      "sign-in",
      "signon",
      "session",
      "token",
      "jwt",
      "oauth",
      "passport",
      "web-login",
      "verify",
      "verified",
      "авторизация",
      "авторизации",
      "авториз",
      "аутентификация",
      "аутентификации",
      "аутентифик",
      "логин",
      "вход",
      "токен",
      "сессия",
    ],
  },
  {
    key: "billing",
    aliases: [
      "billing",
      "bill",
      "payment",
      "payments",
      "invoice",
      "subscription",
      "subscriptions",
      "checkout",
      "cashier",
      "paddle",
      "subscribed",
      "биллинг",
      "платеж",
      "платежи",
      "оплата",
      "счет",
      "инвойс",
      "подписка",
      "подписки",
    ],
  },
  {
    key: "user",
    aliases: ["user", "users", "profile", "profiles", "account", "accounts", "пользователь", "профиль", "аккаунт"],
  },
  {
    key: "notification",
    aliases: ["notification", "notifications", "email", "mail", "sms", "уведомление", "уведомления", "письмо"],
  },
];

export function runResearch(input: ResearchInput): ResearchReport {
  const tokens = expandTaskTokens(input.task);
  const fileEvidence: ScoredReference[] = [];
  const symbolEvidence: ScoredReference[] = [];
  const moduleIntents = detectModuleIntents(input, tokens);
  const dominantModule = moduleIntents[0]?.module ?? "не определён";
  const functionalFocus = isFunctionalQuestion(tokens);
  const routeNodes = getRouteNodes(input.graph);
  const codeNodes = getCodeNodes(input.graph);
  const graphModules = getNodesByKind(input.graph, "module");

  for (const file of input.workspace.files) {
    const score =
      scoreText(file.relativePath, tokens) * 6 +
      scoreText(file.content.slice(0, 4000), tokens) +
      getModuleBoost(file.relativePath, moduleIntents);

    if (score <= 0) {
      continue;
    }

    fileEvidence.push({
      id: file.id,
      label: file.relativePath,
      score,
      reason: buildFileReason(file.relativePath, moduleIntents),
      filePath: file.relativePath,
    });
  }

  for (const symbol of input.index.symbols) {
    const label = symbol.containerName ? `${symbol.containerName}.${symbol.name}` : symbol.name;
    const score =
      scoreText(label, tokens) * 8 +
      scoreText(symbol.filePath, tokens) * 3 +
      getModuleBoost(symbol.filePath, moduleIntents) +
      getSymbolKindBoost(symbol.kind, functionalFocus, tokens);

    if (score <= 0) {
      continue;
    }

    symbolEvidence.push({
      id: symbol.id,
      label,
      score,
      reason: buildSymbolReason(symbol.filePath, moduleIntents),
      filePath: symbol.filePath,
    });
  }

  for (const routeNode of routeNodes) {
    const score =
      scoreText(routeNode.label, tokens) * 10 +
      scoreText(routeNode.filePath ?? "", tokens) * 4 +
      getModuleBoost(routeNode.filePath ?? "", moduleIntents) +
      (functionalFocus ? 36 : 12);

    if (score <= 0) {
      continue;
    }

    const routeEvidence: ScoredReference = {
      id: routeNode.id,
      label: routeNode.label,
      score,
      reason: "Route-узел выбран через graph как прямая точка входа для функционального сценария.",
    };

    if (routeNode.filePath) {
      routeEvidence.filePath = routeNode.filePath;
    }

    symbolEvidence.push(routeEvidence);
  }

  for (const moduleNode of graphModules) {
    const score = scoreText(moduleNode.label, tokens) * 14;

    if (score <= 0) {
      continue;
    }

    symbolEvidence.push({
      id: moduleNode.id,
      label: moduleNode.label,
      score,
      reason: "Module-узел совпал с задачей и был поднят из graph как доменная зона ответственности.",
    });
  }

  const evidence = [...fileEvidence, ...symbolEvidence].sort((left, right) => right.score - left.score).slice(0, 12);
  const topFiles = evidence.filter((item) => item.filePath).map((item) => item.filePath as string);
  const moduleRelations = dominantModule !== "не определён" ? getModuleRelations(input.graph, dominantModule) : [];
  const dominantModuleNodeId = findModuleNodeId(input.graph, dominantModule);
  const graphRelatedModules = moduleRelations
    .map((edge: GraphState["edges"][number]) =>
      input.graph.nodes.find((node: GraphState["nodes"][number]) =>
        node.id === (edge.sourceId === dominantModuleNodeId ? edge.targetId : edge.sourceId),
      ),
    )
    .filter((node): node is GraphState["nodes"][number] => Boolean(node && node.kind === "module"))
    .map((node) => node.label);
  const entryPoints = detectEntryPoints(input, topFiles, routeNodes, dominantModule);
  const primaryEntities = detectPrimaryEntities(input, topFiles, codeNodes);
  const sideEffects = detectSideEffects(input);
  const dataSources = detectDataSources(input);
  const affectedModules = deriveAffectedModules(input, moduleIntents, dominantModule, graphRelatedModules, topFiles, entryPoints);
  const functionalSummary = buildFunctionalSummary(input, affectedModules, dominantModule, moduleIntents, entryPoints, primaryEntities, sideEffects, dataSources);
  const findings = buildFindings(input, evidence, moduleIntents, dominantModule);
  const unknowns = buildUnknowns(input, evidence, moduleIntents, entryPoints, sideEffects, dataSources);
  const confidence = computeConfidence(input, evidence, unknowns);

  return {
    runId: input.runId,
    task: input.task,
    summary:
      evidence.length > 0
        ? `Исследование нашло ${evidence.length} сильных структурных опор в ${affectedModules.length || 1} зонах проекта.`
        : "Исследование не нашло сильных структурных совпадений и работает в режиме низкой уверенности.",
    functionalSummary,
    dominantModule,
    moduleIntents,
    entryPoints,
    primaryEntities,
    sideEffects,
    dataSources,
    findings,
    evidence,
    affectedModules,
    unknowns,
    confidence,
    references: evidence.map((item) => item.filePath ?? item.label),
  };
}

function buildFunctionalSummary(
  input: ResearchInput,
  affectedModules: string[],
  dominantModule: string,
  moduleIntents: ModuleIntentMatch[],
  entryPoints: string[],
  primaryEntities: string[],
  sideEffects: string[],
  dataSources: string[],
): string {
  const moduleText = affectedModules.length ? affectedModules.join(", ") : "неопределённых зонах";
  const intentText = moduleIntents.length
    ? `Наиболее вероятный функциональный модуль: ${dominantModule}.`
    : "Явный функциональный модуль пока не выделен.";
  const entryPointText = entryPoints.length ? entryPoints.slice(0, 2).join(", ") : "явные точки входа пока не выделены";
  const entityText = primaryEntities.length ? primaryEntities.slice(0, 3).join(", ") : "ключевые сущности пока не выделены";
  const sideEffectText = sideEffects.length ? sideEffects[0] : "критичные побочные эффекты пока не подтверждены";
  const dataSourceText = dataSources.length ? dataSources[0] : "источники данных пока определены слабо";

  return `По текущему исследованию задача "${input.task}" больше всего связана с ${moduleText}. ${intentText} Основные точки входа: ${entryPointText}. Ключевые сущности: ${entityText}. Главный подтверждённый operational signal: ${sideEffectText}. Основной источник данных: ${dataSourceText}.`;
}

function buildFindings(
  input: ResearchInput,
  evidence: ScoredReference[],
  moduleIntents: ModuleIntentMatch[],
  dominantModule: string,
): string[] {
  if (evidence.length === 0) {
    return [
      `Задача "${input.task}" слабо пересекается с текущими индексированными файлами, поэтому отчёт опирается на общий контекст проекта.`,
      "Первый срез всё ещё может быть выполнен, но человеку стоит проверить, соответствует ли формулировка задачи терминологии репозитория.",
    ];
  }

  const topLabels = evidence.slice(0, 3).map((item) => item.label);
  const moduleRelationSummary =
    dominantModule !== "не определён" ? getModuleRelationSummary(input.graph, dominantModule).slice(0, 3) : [];

  return [
    `Самые сильные структурные опоры для задачи: ${topLabels.join(", ")}.`,
    moduleIntents[0]
      ? `Доменные эвристики отдали приоритет модулю "${moduleIntents[0].module}" на основе терминов задачи и профильных файлов.`
      : "Доменные эвристики не смогли уверенно выделить один функциональный модуль.",
    moduleRelationSummary.length > 0
      ? `Graph показал соседние модульные связи для "${dominantModule}": ${moduleRelationSummary
          .map((item) => `${item.direction === "outgoing" ? "зависит от" : "используется модулем"} ${item.targetLabel}`)
          .join(", ")}.`
      : "Graph пока не дал выраженных межмодульных связей для доминирующей зоны.",
    `Сейчас проект даёт для анализа ${input.index.manifest.fileCount} индексированных файлов и ${input.index.manifest.symbolCount} извлечённых символов.`,
    "Отчёт исследования строится из Graph и прямых данных файлов, поэтому остаётся детерминированным и воспроизводимым для одного и того же состояния репозитория.",
  ];
}

function buildUnknowns(
  input: ResearchInput,
  evidence: ScoredReference[],
  moduleIntents: ModuleIntentMatch[],
  entryPoints: string[],
  sideEffects: string[],
  dataSources: string[],
): string[] {
  const unknowns: string[] = [];

  if (evidence.length === 0) {
    unknowns.push("Не найдено прямого совпадения между формулировкой задачи и путями файлов или именами символов.");
  }

  if (input.index.diagnostics.length > 0) {
    unknowns.push(`Indexer сообщил о ${input.index.diagnostics.length} диагностических сообщениях, которые могут снижать полноту структурного покрытия.`);
  }

  if (input.graph.summary.dependencyCount === 0) {
    unknowns.push("Граф зависимостей пока неглубокий, потому что в текущей кодовой базе мало import-связей или в ней преобладают документационные артефакты.");
  }

  if (moduleIntents.length === 0) {
    unknowns.push("Система не смогла уверенно определить доменный модуль задачи, поэтому возможны уходы в соседние функциональные зоны.");
  }

  if (entryPoints.length === 0) {
    unknowns.push("Явные entry points не найдены, поэтому функциональная картина проекта пока частично восстановлена эвристически.");
  }

  if (sideEffects.length === 0) {
    unknowns.push("Побочные эффекты не были подтверждены по сигнатурам импорта или содержимому файлов.");
  }

  if (dataSources.length === 0) {
    unknowns.push("Источники данных не выделены уверенно, поэтому часть функционального понимания остаётся неполной.");
  }

  return unknowns;
}

function detectModuleIntents(input: ResearchInput, tokens: string[]): ModuleIntentMatch[] {
  const symbolHaystacks = new Map<string, string>();

  for (const symbol of input.index.symbols) {
    const current = symbolHaystacks.get(symbol.filePath) ?? "";
    const label = `${symbol.containerName ? `${symbol.containerName}.` : ""}${symbol.name}`.toLowerCase();
    symbolHaystacks.set(symbol.filePath, `${current} ${label}`.trim());
  }

  return INTENT_PROFILES.map((profile) => {
    const taskMentionsDomain = profile.aliases.some((alias) => tokens.some((token) => token.includes(alias) || alias.includes(token)));
    const matchedFiles: Array<{ filePath: string; score: number; reasons: string[] }> = [];
    let totalScore = 0;

    for (const file of input.workspace.files) {
      const pathText = file.relativePath.toLowerCase();
      const symbolText = symbolHaystacks.get(file.relativePath) ?? "";
      const contentText = file.content.slice(0, 2000).toLowerCase();
      const pathMatches = countAliasMatches(pathText, profile.aliases);
      const symbolMatches = countAliasMatches(symbolText, profile.aliases);
      const contentMatches = countAliasMatches(contentText, profile.aliases);
      let fileScore = pathMatches * 8 + symbolMatches * 6 + Math.min(contentMatches, 2);

      if (taskMentionsDomain) {
        fileScore += 20;
      }

      if (pathMatches === 0 && symbolMatches === 0 && contentMatches > 0) {
        fileScore -= 8;
      }

      if (fileScore <= 0) {
        continue;
      }

      totalScore += fileScore;
      const reasons: string[] = [];

      if (pathMatches > 0) {
        reasons.push("совпадение по пути");
      }

      if (symbolMatches > 0) {
        reasons.push("совпадение по символам");
      }

      if (contentMatches > 0) {
        reasons.push("совпадение по содержимому");
      }

      matchedFiles.push({
        filePath: file.relativePath,
        score: fileScore,
        reasons,
      });
    }

    if (totalScore <= 0) {
      return null;
    }

    const strongestFiles = matchedFiles.sort((left, right) => right.score - left.score).slice(0, 4);
    const reasons = [
      taskMentionsDomain
        ? `Термины задачи совпали с доменным профилем "${profile.key}".`
        : `Доменный профиль "${profile.key}" выделен по структуре проекта.`,
      `Самые сильные файлы зоны: ${strongestFiles.map((item) => item.filePath).join(", ")}.`,
    ];

    return {
      module: profile.key,
      score: totalScore,
      reasons,
      matchedFiles: strongestFiles.map((item) => item.filePath),
    } satisfies ModuleIntentMatch;
  })
    .filter((item): item is ModuleIntentMatch => Boolean(item))
    .sort((left, right) => right.score - left.score)
    .slice(0, 5);
}

function detectEntryPoints(
  input: ResearchInput,
  topFiles: string[],
  routeNodes: GraphState["nodes"],
  dominantModule: string,
): string[] {
  const ranked = new Map<string, number>();
  const moduleRoutes = dominantModule !== "не определён" ? getRoutesForModule(input.graph, dominantModule) : [];
  const combinedRoutes = [...routeNodes, ...moduleRoutes].filter(
    (value, index, list) => list.findIndex((candidate) => candidate.id === value.id) === index,
  );

  for (const file of input.workspace.files) {
    const normalized = file.relativePath.toLowerCase();
    let score = 0;

    if (/\/(main|index|app|server|router|routes)\./.test(normalized) || /(^|\/)(main|index|app|server)\./.test(normalized)) {
      score += 3;
    }

    if (normalized.includes("/api/") || normalized.includes("/routes/") || normalized.includes("/controllers/")) {
      score += 2;
    }

    if (topFiles.includes(file.relativePath)) {
      score += 2;
    }

    if (score > 0) {
      ranked.set(file.relativePath, score);
    }
  }

  for (const symbol of input.index.symbols) {
    const name = symbol.name.toLowerCase();

    if (["main", "bootstrap", "createapp", "handler", "app"].includes(name)) {
      ranked.set(`${symbol.filePath}#${symbol.name}`, (ranked.get(`${symbol.filePath}#${symbol.name}`) ?? 0) + 3);
    }

    if (symbol.kind === "route") {
      ranked.set(`${symbol.filePath}#${symbol.name}`, (ranked.get(`${symbol.filePath}#${symbol.name}`) ?? 0) + 6);
    }

    if (symbol.kind === "method" && ["login", "logout", "register", "callbackgoogleauth", "initgoogleauth", "statusgoogleauth"].includes(name)) {
      ranked.set(`${symbol.filePath}#${symbol.name}`, (ranked.get(`${symbol.filePath}#${symbol.name}`) ?? 0) + 4);
    }
  }

  for (const routeNode of combinedRoutes) {
    const routeScore = scoreText(routeNode.label, expandTaskTokens(input.task)) * 6 + 4;

    if (routeScore > 0) {
      const routeTargets = getEntryPointNeighbors(input.graph, routeNode.id)
        .map((neighbor) => neighbor.label)
        .slice(0, 2);
      const label = routeTargets.length > 0 ? `${routeNode.label} -> ${routeTargets.join(", ")}` : routeNode.label;
      ranked.set(label, (ranked.get(label) ?? 0) + routeScore);
    }
  }

  return [...ranked.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 6)
    .map(([label]) => label);
}

function detectPrimaryEntities(input: ResearchInput, topFiles: string[], codeNodes: GraphState["nodes"]): string[] {
  return codeNodes
    .filter((node) => topFiles.includes(node.filePath ?? "") || isPrimaryEntityKind(node.kind))
    .sort((left, right) => {
      const leftRouteWeight = left.kind === "route" ? 2 : left.kind === "method" ? 1 : 0;
      const rightRouteWeight = right.kind === "route" ? 2 : right.kind === "method" ? 1 : 0;
      const leftWeight = topFiles.includes(left.filePath ?? "") ? 1 : 0;
      const rightWeight = topFiles.includes(right.filePath ?? "") ? 1 : 0;
      return rightRouteWeight - leftRouteWeight || rightWeight - leftWeight || left.label.localeCompare(right.label);
    })
    .map((node) => node.label)
    .filter((value, index, list) => list.indexOf(value) === index)
    .slice(0, 8);
}

function detectSideEffects(input: ResearchInput): string[] {
  const effects = new Set<string>();

  for (const file of input.workspace.files) {
    const content = file.content.toLowerCase();

    if (content.includes("fetch(") || content.includes("axios") || content.includes("fastify") || content.includes("express")) {
      effects.add("есть сетевое взаимодействие и обработка HTTP/API запросов");
    }

    if (content.includes("writefile") || content.includes("appendfile") || content.includes("mkdir(") || content.includes("readdir")) {
      effects.add("есть операции чтения или записи в файловую систему");
    }

    if (content.includes("emit(") || content.includes("event") || content.includes("publish(")) {
      effects.add("есть публикация событий или реакция на события");
    }

    if (content.includes("console.") || content.includes("logger")) {
      effects.add("есть логирование и операционные диагностические сообщения");
    }

    if (content.includes("createtoken(") || content.includes("auth::attempt") || content.includes("socialite")) {
      effects.add("есть аутентификационный flow с выдачей токенов, проверкой credentials или внешним OAuth");
    }

    if (content.includes("cache::put") || content.includes("cache::pull") || content.includes("cache::forget")) {
      effects.add("есть временное хранение состояния в cache для сессий, тикетов или OAuth-процесса");
    }
  }

  return [...effects].slice(0, 6);
}

function detectDataSources(input: ResearchInput): string[] {
  const sources = new Set<string>();

  for (const file of input.workspace.files) {
    const content = file.content.toLowerCase();

    if (content.includes("postgres") || content.includes("mysql") || content.includes("sqlite") || content.includes("prisma") || content.includes("typeorm")) {
      sources.add("данные поступают из базы данных или ORM-слоя");
    }

    if (content.includes("redis")) {
      sources.add("используется in-memory или cache storage");
    }

    if (content.includes("process.env") || content.includes("import.meta.env")) {
      sources.add("часть поведения зависит от конфигурации окружения");
    }

    if (content.includes("readfile") || content.includes("json.parse") || file.language === "json") {
      sources.add("используются файлы и конфигурационные артефакты как источник данных");
    }

    if (content.includes("fetch(") || content.includes("axios") || content.includes("graphql")) {
      sources.add("часть данных приходит из внешних HTTP/API источников");
    }

    if (content.includes("socialite") || content.includes("oauth")) {
      sources.add("часть данных и identity-сигналов приходит из внешнего OAuth-провайдера");
    }
  }

  return [...sources].slice(0, 6);
}

function expandTaskTokens(task: string): string[] {
  const baseTokens = tokenize(task);
  const expanded = new Set(baseTokens);

  for (const token of baseTokens) {
    for (const profile of INTENT_PROFILES) {
      if (profile.aliases.some((alias) => token.includes(alias) || alias.includes(token))) {
        expanded.add(profile.key);

        for (const alias of profile.aliases) {
          expanded.add(alias);
        }
      }
    }
  }

  return [...expanded];
}

function countAliasMatches(haystack: string, aliases: string[]): number {
  let matches = 0;

  for (const alias of aliases) {
    if (haystack.includes(alias)) {
      matches += 1;
    }
  }

  return matches;
}

function getModuleBoost(filePath: string, moduleIntents: ModuleIntentMatch[]): number {
  for (const [index, intent] of moduleIntents.entries()) {
    if (intent.matchedFiles.includes(filePath)) {
      return Math.max(32 - index * 8, 8);
    }

    if (filePath.toLowerCase().includes(intent.module.toLowerCase())) {
      return Math.max(18 - index * 4, 4);
    }
  }

  return 0;
}

function buildFileReason(filePath: string, moduleIntents: ModuleIntentMatch[]): string {
  const strongest = moduleIntents.find((intent) => intent.matchedFiles.includes(filePath) || filePath.toLowerCase().includes(intent.module.toLowerCase()));

  if (strongest) {
    return `Файл попал в исследование по лексическим сигналам задачи и усилен доменным профилем "${strongest.module}".`;
  }

  return "Токены задачи пересекаются с путём файла или его содержимым.";
}

function buildSymbolReason(filePath: string, moduleIntents: ModuleIntentMatch[]): string {
  const strongest = moduleIntents.find((intent) => intent.matchedFiles.includes(filePath) || filePath.toLowerCase().includes(intent.module.toLowerCase()));

  if (strongest) {
    return `Символ попал в исследование по имени и файлу объявления, дополнительно усилен модульным профилем "${strongest.module}".`;
  }

  return "Токены задачи пересекаются с именем символа или файлом, в котором он объявлен.";
}

function getSymbolKindBoost(
  kind: IndexSymbol["kind"],
  functionalFocus: boolean,
  tokens: string[],
): number {
  if (kind === "route") {
    return functionalFocus ? 42 : 18;
  }

  if (kind === "method") {
    return functionalFocus ? 24 : 10;
  }

  if (kind === "class") {
    return 12;
  }

  if (kind === "function") {
    return 8;
  }

  if (kind === "variable" && tokens.some((token) => ["config", "конфиг", "env"].includes(token))) {
    return 10;
  }

  return 0;
}

function isFunctionalQuestion(tokens: string[]): boolean {
  return tokens.some((token) =>
    [
      "how",
      "work",
      "works",
      "flow",
      "behavior",
      "behaviour",
      "работает",
      "работа",
      "как",
      "зачем",
      "why",
      "process",
      "модуль",
      "module",
    ].includes(token),
  );
}

function isPrimaryEntityKind(kind: GraphState["nodes"][number]["kind"]): boolean {
  return ["class", "interface", "enum", "function", "route", "method", "middleware"].includes(kind);
}

function findModuleNodeId(graph: GraphState, moduleLabel: string): string | null {
  return graph.nodes.find((node) => node.kind === "module" && node.label === moduleLabel)?.id ?? null;
}

function computeConfidence(input: ResearchInput, evidence: ScoredReference[], unknowns: string[]): number {
  let confidence = 45;
  confidence += Math.min(evidence.length * 4, 30);
  confidence += Math.min(input.graph.summary.symbolCount / 10, 15);
  confidence -= unknowns.length * 8;

  return clamp(Math.round(confidence), 5, 95);
}

function deriveAffectedModules(
  input: ResearchInput,
  moduleIntents: ModuleIntentMatch[],
  dominantModule: string,
  graphRelatedModules: string[],
  topFiles: string[],
  entryPoints: string[],
): string[] {
  const strongestScore = moduleIntents[0]?.score ?? 0;
  const strongIntentThreshold = Math.max(strongestScore * 0.4, 300);
  const strongIntentModules = moduleIntents.filter((item) => item.score >= strongIntentThreshold).map((item) => item.module);
  const entryPointZones = entryPoints.flatMap(extractResearchZonesFromText);
  const topFileZones = topFiles.flatMap(extractResearchZonesFromPath);
  const candidateModules = [
    dominantModule,
    ...strongIntentModules,
    ...graphRelatedModules,
    ...entryPointZones,
    ...topFileZones,
  ].filter(Boolean);

  const uniqueCandidates = candidateModules.filter((value, index, list) => list.indexOf(value) === index);

  return uniqueCandidates.filter((value) => {
    if (value === dominantModule) {
      return true;
    }

    if (strongIntentModules.includes(value)) {
      return true;
    }

    if (entryPointZones.includes(value)) {
      return true;
    }

    const presentInTopFiles = topFileZones.includes(value);
    const presentInReferences = input.research?.references?.some?.((reference) => reference.toLowerCase().includes(value.toLowerCase())) ?? false;

    return presentInTopFiles && presentInReferences;
  }).slice(0, 6);
}

function extractResearchZonesFromText(value: string): string[] {
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

function extractResearchZonesFromPath(filePath: string): string[] {
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
    zones.push("user");
  }

  return zones;
}
