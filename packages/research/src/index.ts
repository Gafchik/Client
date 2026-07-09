import {
  getBillingRuntimeNodes,
  getCodeNodes,
  getEntryPointNeighbors,
  getLocalizationRuntimeNodes,
  getModuleRelationSummary,
  getModuleRelations,
  getNodesForQueryProfile,
  getNodesByKind,
  getRouteNodes,
  getRoutesForModule,
  getRuntimeSemanticEdges,
} from "@client/graph";
import {
  type BackgroundProjectState,
  clamp,
  deriveLocalizationBucket,
  deriveStructuralModuleLabel,
  isConfigPath,
  isLocalizationPath,
  type RepositorySnapshot,
  scoreText,
  tokenize,
  type GraphState,
  type IndexSymbol,
  type IndexResult,
  type ModuleIntentMatch,
  type ResearchIntentClass,
  type ResearchQueryProfileKey,
  type ResearchReport,
  type ResearchStrategyKey,
  type ScoredReference,
  type WorkspaceSnapshot,
} from "@client/shared";

interface ResearchInput {
  runId: string;
  task: string;
  workspace: WorkspaceSnapshot;
  index: IndexResult;
  graph: GraphState;
  repository?: RepositorySnapshot;
  backgroundState?: BackgroundProjectState;
}

interface IntentProfile {
  key: string;
  aliases: string[];
}

interface ResearchRoutingDecision {
  intentClass: ResearchIntentClass;
  strategyKey: ResearchStrategyKey;
  queryProfileKey: ResearchQueryProfileKey;
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
    key: "localization",
    aliases: [
      "localization",
      "locale",
      "locales",
      "translation",
      "translations",
      "translate",
      "i18n",
      "lang",
      "language",
      "languages",
      "локализация",
      "локализации",
      "перевод",
      "переводы",
      "язык",
      "языки",
      "языков",
      "локаль",
      "локали",
      "локалей",
    ],
  },
  {
    key: "config",
    aliases: [
      "config",
      "configs",
      "configuration",
      "settings",
      "setting",
      "env",
      "environment",
      "variable",
      "variables",
      "dotenv",
      "конфиг",
      "конфиги",
      "конфигурация",
      "настройка",
      "настройки",
      "переменная",
      "переменные",
      "окружение",
      "env-переменные",
    ],
  },
  {
    key: "servers",
    aliases: [
      "server",
      "servers",
      "ssh",
      "sftp",
      "ftp",
      "host",
      "hostname",
      "port",
      "username",
      "private_key",
      "private-key",
      "passphrase",
      "forwarding",
      "tunnel",
      "connection",
      "connections",
      "соединение",
      "соединения",
      "подключение",
      "подключения",
      "сервер",
      "серверы",
      "ssh-соединение",
      "ssh-соединения",
      "хост",
      "порт",
      "логин",
      "приватный",
      "ключ",
      "туннель",
    ],
  },
  {
    key: "vault",
    aliases: [
      "vault",
      "credential",
      "credentials",
      "password_uuid",
      "passphrase_uuid",
      "passwords",
      "private_key",
      "encrypted_private_key",
      "пароль",
      "пароли",
      "креды",
      "учетные",
      "учётные",
      "секрет",
      "секреты",
      "ключ",
      "ключи",
    ],
  },
  {
    key: "notification",
    aliases: ["notification", "notifications", "email", "mail", "sms", "уведомление", "уведомления", "письмо"],
  },
];

export function runResearch(input: ResearchInput): ResearchReport {
  const tokens = expandTaskTokens(input.task);
  const routing = routeResearch(tokens);
  const broadFocus = routing.intentClass === "broad-unknown";
  const infrastructureFocus = isInfrastructureQuestion(tokens);
  const localizationInventoryFocus = isLocalizationInventoryQuestion(tokens);
  const localizationBehaviorFocus = isLocalizationBehaviorQuestion(tokens);
  const billingRollbackFocus = isBillingRollbackQuestion(tokens);
  const configFocus = isConfigQuestion(tokens);
  const fileEvidence: ScoredReference[] = [];
  const symbolEvidence: ScoredReference[] = [];
  const moduleIntents = detectModuleIntents(input, tokens);
  const dominantModule = broadFocus ? "не определён" : moduleIntents[0]?.module ?? "не определён";
  const functionalFocus = isFunctionalQuestion(tokens);
  const routeNodes = getRouteNodes(input.graph);
  const codeNodes = getCodeNodes(input.graph);
  const graphModules = getNodesByKind(input.graph, "module");
  const graphSeedNodes = getNodesForQueryProfile(
    input.graph,
    routing.queryProfileKey,
    dominantModule !== "не определён" ? { moduleLabel: dominantModule } : undefined,
  );
  const runtimeLocaleNodes = localizationBehaviorFocus ? getLocalizationRuntimeNodes(input.graph) : [];
  const runtimeLocaleNodeIds = new Set(runtimeLocaleNodes.map((node) => node.id));
  const runtimeLocaleFilePaths = new Set(runtimeLocaleNodes.map((node) => node.filePath).filter((value): value is string => Boolean(value)));
  const runtimeLocaleEdges = localizationBehaviorFocus
    ? [
        ...getRuntimeSemanticEdges(input.graph, "locale-set"),
        ...getRuntimeSemanticEdges(input.graph, "request-header"),
        ...getRuntimeSemanticEdges(input.graph, "locale-config"),
      ]
    : [];
  const runtimeBillingNodes = billingRollbackFocus ? getBillingRuntimeNodes(input.graph) : [];
  const runtimeBillingNodeIds = new Set(runtimeBillingNodes.map((node) => node.id));
  const runtimeBillingFilePaths = new Set(runtimeBillingNodes.map((node) => node.filePath).filter((value): value is string => Boolean(value)));
  const runtimeBillingEdges = billingRollbackFocus
    ? [
        ...getRuntimeSemanticEdges(input.graph, "bill-history-read"),
        ...getRuntimeSemanticEdges(input.graph, "bill-history-write"),
        ...getRuntimeSemanticEdges(input.graph, "bill-rollback-guard"),
      ]
    : [];
  const graphSeedFilePaths = new Set(graphSeedNodes.map((node) => node.filePath).filter((value): value is string => Boolean(value)));
  const graphSeedNodeIds = new Set(graphSeedNodes.map((node) => node.id));
  const graphSeedLabels = graphSeedNodes.map((node) => node.label.toLowerCase());
  const strongGraphSeed = graphSeedNodes.length >= 4;

  for (const file of input.workspace.files) {
    const score =
      scoreText(file.relativePath, tokens) * 6 +
      scoreText(file.content.slice(0, 4000), tokens) +
      getModuleBoost(file.relativePath, moduleIntents) +
      getGraphProfileFileBoost(file.relativePath, graphSeedFilePaths, graphSeedLabels, routing.queryProfileKey) +
      getRuntimeLocaleGraphFileBoost(file.relativePath, runtimeLocaleFilePaths, runtimeLocaleEdges) +
      getRuntimeBillingGraphFileBoost(file.relativePath, runtimeBillingFilePaths, runtimeBillingEdges) +
      getInfrastructureFileBoost(file, infrastructureFocus, tokens) +
      getLocalizationFileBoost(file, localizationInventoryFocus, tokens) +
      getLocaleRuntimeFileBoost(file, localizationBehaviorFocus, tokens) +
      getBillingRollbackFileBoost(file, billingRollbackFocus, tokens) +
      getConfigFileBoost(file, configFocus, tokens);

    if (score <= 0) {
      continue;
    }

    fileEvidence.push({
      id: file.id,
      label: file.relativePath,
      score,
      reason: buildFileReason(file.relativePath, moduleIntents),
      filePath: file.relativePath,
      origin: "structural",
    });
  }

  for (const symbol of input.index.symbols) {
    const label = symbol.containerName ? `${symbol.containerName}.${symbol.name}` : symbol.name;
    const score =
      scoreText(label, tokens) * 8 +
      scoreText(symbol.filePath, tokens) * 3 +
      getModuleBoost(symbol.filePath, moduleIntents) +
      getGraphProfileSymbolBoost(symbol, graphSeedFilePaths, graphSeedNodeIds, graphSeedLabels, routing.queryProfileKey) +
      getRuntimeLocaleGraphSymbolBoost(symbol, runtimeLocaleNodeIds, runtimeLocaleFilePaths, runtimeLocaleEdges) +
      getRuntimeBillingGraphSymbolBoost(symbol, runtimeBillingNodeIds, runtimeBillingFilePaths, runtimeBillingEdges) +
      getSymbolKindBoost(symbol.kind, functionalFocus, tokens) +
      getInfrastructureSymbolBoost(symbol, infrastructureFocus, tokens) +
      getLocalizationSymbolBoost(symbol, localizationInventoryFocus, tokens) +
      getLocaleRuntimeSymbolBoost(symbol, localizationBehaviorFocus, tokens) +
      getBillingRollbackSymbolBoost(symbol, billingRollbackFocus, tokens) +
      getConfigSymbolBoost(symbol, configFocus, tokens);

    if (score <= 0) {
      continue;
    }

    symbolEvidence.push({
      id: symbol.id,
      label,
      score,
      reason: buildSymbolReason(symbol.filePath, moduleIntents),
      filePath: symbol.filePath,
      origin: "structural",
    });
  }

  for (const routeNode of routeNodes) {
    const score =
      scoreText(routeNode.label, tokens) * 10 +
      scoreText(routeNode.filePath ?? "", tokens) * 4 +
      getModuleBoost(routeNode.filePath ?? "", moduleIntents) +
      (graphSeedNodeIds.has(routeNode.id) ? 30 : 0) +
      (functionalFocus ? 36 : 12) +
      getInfrastructureRoutePenalty(routeNode.filePath ?? "", infrastructureFocus) +
      getLocalizationRoutePenalty(routeNode.filePath ?? "", localizationInventoryFocus) +
      getLocaleRuntimeRouteBoost(routeNode.filePath ?? "", localizationBehaviorFocus) +
      getBillingRollbackRouteBoost(routeNode.filePath ?? "", billingRollbackFocus) +
      getConfigRoutePenalty(routeNode.filePath ?? "", configFocus);

    if (score <= 0) {
      continue;
    }

    const routeEvidence: ScoredReference = {
      id: routeNode.id,
      label: routeNode.label,
      score,
      reason: "Route-узел выбран через graph как прямая точка входа для функционального сценария.",
      origin: "structural",
    };

    if (routeNode.filePath) {
      routeEvidence.filePath = routeNode.filePath;
    }

    symbolEvidence.push(routeEvidence);
  }

  for (const moduleNode of graphModules) {
    const score = scoreText(moduleNode.label, tokens) * 14 + (graphSeedNodeIds.has(moduleNode.id) ? 16 : 0);

    if (score <= 0) {
      continue;
    }

    symbolEvidence.push({
      id: moduleNode.id,
      label: moduleNode.label,
      score,
      reason: "Module-узел совпал с задачей и был поднят из graph как доменная зона ответственности.",
      origin: "structural",
    });
  }

  const evidence = [...fileEvidence, ...symbolEvidence]
    .sort((left, right) => right.score - left.score)
    .slice(0, 12)
    .map((item) => classifyReferenceOrigin(item, input));
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
  const affectedModules = deriveAffectedModules(moduleIntents, dominantModule, graphRelatedModules, topFiles, entryPoints);
  const functionalSummary = buildFunctionalSummary(input, affectedModules, dominantModule, moduleIntents, entryPoints, primaryEntities, sideEffects, dataSources);
  const findings = buildFindings(input, evidence, moduleIntents, dominantModule, strongGraphSeed);
  const baselineFindings = buildBaselineFindings(input, evidence, strongGraphSeed);
  const overlayFindings = buildOverlayFindings(input, evidence);
  const unknowns = buildUnknowns(input, evidence, moduleIntents, entryPoints, sideEffects, dataSources, strongGraphSeed);
  const confidence = computeConfidence(input, evidence, unknowns);
  const evidenceSummary = buildEvidenceSummary(evidence);

  return {
    runId: input.runId,
    task: input.task,
    summary:
      evidence.length > 0
        ? `Исследование нашло ${evidence.length} сильных структурных опор в ${affectedModules.length || 1} зонах проекта.`
        : "Исследование не нашло сильных структурных совпадений и работает в режиме низкой уверенности.",
    intentClass: routing.intentClass,
    strategyKey: routing.strategyKey,
    queryProfileKey: routing.queryProfileKey,
    functionalSummary,
    dominantModule,
    moduleIntents,
    entryPoints,
    primaryEntities,
    sideEffects,
    dataSources,
    findings,
    baselineFindings,
    overlayFindings,
    evidence,
    evidenceSummary,
    affectedModules,
    unknowns,
    confidence,
    references: evidence.map((item) => item.filePath ?? item.label),
  };
}

function classifyReferenceOrigin(item: ScoredReference, input: ResearchInput): ScoredReference {
  if (!item.filePath) {
    return {
      ...item,
      origin: "structural",
      originDetails: "Узел получен из graph/symbol слоя без прямой привязки к изменённому файлу.",
    };
  }

  const normalizedPath = item.filePath.replaceAll("\\", "/");
  const changedFiles = input.repository?.changedFiles ?? [];
  const changedEntry = changedFiles.find((entry) =>
    entry.path.replaceAll("\\", "/") === normalizedPath || entry.previousPath?.replaceAll("\\", "/") === normalizedPath,
  );

  if (changedEntry) {
    return {
      ...item,
      origin: "overlay",
      originDetails: `Факт подтверждён локальным worktree overlay: файл изменён (${changedEntry.changeType}, ${changedEntry.scope}).`,
    };
  }

  return {
    ...item,
    origin: "baseline",
    originDetails: input.backgroundState?.baselineExactForHead
      ? "Факт подтверждён committed baseline для текущего HEAD."
      : "Факт подтверждён доступным committed baseline ветки/merge-base.",
  };
}

function buildEvidenceSummary(evidence: ScoredReference[]): ResearchReport["evidenceSummary"] {
  const baselineCount = evidence.filter((item) => item.origin === "baseline").length;
  const overlayCount = evidence.filter((item) => item.origin === "overlay").length;
  const structuralCount = evidence.filter((item) => item.origin === "structural").length;

  return {
    baselineCount,
    overlayCount,
    structuralCount,
    overlayInfluenced: overlayCount > 0,
  };
}

function buildBaselineFindings(
  input: ResearchInput,
  evidence: ScoredReference[],
  strongGraphSeed: boolean,
): string[] {
  const baselineEvidence = evidence.filter((item) => item.origin === "baseline");

  if (baselineEvidence.length === 0) {
    return input.backgroundState?.freshness === "missing"
      ? ["Для текущего branch/head ещё нет готового committed baseline, поэтому baseline-backed факты пока отсутствуют."]
      : ["Committed baseline не дал прямых file-backed подтверждений по этому вопросу."]
  }

  const topBaseline = baselineEvidence.slice(0, 3).map((item) => item.filePath ?? item.label);
  const findings = [
    `Committed baseline подтвердил ключевые опоры: ${topBaseline.join(", ")}.`,
  ];

  findings.push(
    strongGraphSeed
      ? "Основная часть ответа опирается на уже собранный graph-first baseline, а не на широкий question-time обход."
      : "Baseline использован частично: graph seed был недостаточно плотным, поэтому понадобилось дополнительное structural narrowing.",
  );

  return findings;
}

function buildOverlayFindings(input: ResearchInput, evidence: ScoredReference[]): string[] {
  const overlayEvidence = evidence.filter((item) => item.origin === "overlay");

  if (overlayEvidence.length === 0) {
    return input.backgroundState?.hasLocalChanges
      ? ["Локальные изменения есть, но они не попали в top evidence текущего ответа."]
      : [];
  }

  return [
    `Локальный worktree overlay повлиял на ответ: подтверждения найдены в ${overlayEvidence
      .slice(0, 4)
      .map((item) => item.filePath ?? item.label)
      .join(", ")}.`,
    "Эти факты существуют только в текущем незакоммиченном состоянии рабочей директории и не входят в committed baseline.",
  ];
}

function routeResearch(tokens: string[]): ResearchRoutingDecision {
  if (isLocalizationBehaviorQuestion(tokens)) {
    return {
      intentClass: "functional-flow",
      strategyKey: "graph-functional-entrypoints",
      queryProfileKey: "entrypoint-traversal",
    };
  }

  if (isLocalizationInventoryQuestion(tokens)) {
    return {
      intentClass: "inventory-localization",
      strategyKey: "graph-localization-inventory",
      queryProfileKey: "localization-inventory",
    };
  }

  if (isConfigQuestion(tokens)) {
    return {
      intentClass: "inventory-config",
      strategyKey: "graph-config-inventory",
      queryProfileKey: "config-inventory",
    };
  }

  if (isInfrastructureQuestion(tokens)) {
    return {
      intentClass: "infrastructure-storage",
      strategyKey: "graph-storage-structure",
      queryProfileKey: "storage-topology",
    };
  }

  if (!hasSpecificIntentSignal(tokens)) {
    return {
      intentClass: "broad-unknown",
      strategyKey: "broad-repository-scan",
      queryProfileKey: "broad-scan",
    };
  }

  if (isFunctionalQuestion(tokens)) {
    return {
      intentClass: "functional-flow",
      strategyKey: "graph-functional-entrypoints",
      queryProfileKey: "entrypoint-traversal",
    };
  }

  return {
    intentClass: "broad-unknown",
    strategyKey: "broad-repository-scan",
    queryProfileKey: "broad-scan",
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
  const infrastructureFocus = isInfrastructureQuestion(expandTaskTokens(input.task));
  const localizationInventoryFocus = isLocalizationInventoryQuestion(expandTaskTokens(input.task));
  const localizationBehaviorFocus = isLocalizationBehaviorQuestion(expandTaskTokens(input.task));
  const billingRollbackFocus = isBillingRollbackQuestion(expandTaskTokens(input.task));
  const configFocus = isConfigQuestion(expandTaskTokens(input.task));
  const broadFocus = routeResearch(expandTaskTokens(input.task)).intentClass === "broad-unknown";
  const moduleText = affectedModules.length ? affectedModules.join(", ") : "неопределённых зонах";
  const intentText = moduleIntents.length
    ? `Наиболее вероятный функциональный модуль: ${dominantModule}.`
    : "Явный функциональный модуль пока не выделен.";
  const entryPointText = entryPoints.length ? entryPoints.slice(0, 2).join(", ") : "явные точки входа пока не выделены";
  const entityText = primaryEntities.length ? primaryEntities.slice(0, 3).join(", ") : "ключевые сущности пока не выделены";
  const sideEffectText = sideEffects.length ? sideEffects[0] : "критичные побочные эффекты пока не подтверждены";
  const dataSourceText = dataSources.length ? dataSources[0] : "источники данных пока определены слабо";

  if (broadFocus) {
    return `По текущему исследованию задача "${input.task}" сформулирована слишком широко, поэтому система перешла в broad repository scan вместо узкого доменного обхода. Обнаружены наиболее заметные зоны проекта: ${moduleText}. Стартовые structural anchors: ${entryPointText}. Первичные сущности верхнего уровня: ${entityText}. Подтверждённый общий signal: ${sideEffectText}. Основной источник сведений: ${dataSourceText}. Для точного ответа желательно сузить вопрос до конкретного модуля, потока или подсистемы.`;
  }

  if (localizationBehaviorFocus) {
    return `По текущему исследованию задача "${input.task}" относится к runtime-поведению локализации, а не к inventory переводов. Основные точки входа: ${entryPointText}. Вероятные сущности, влияющие на выбор локали: ${entityText}. Главный подтверждённый operational signal: ${sideEffectText}. Основной источник данных для выбора локали: ${dataSourceText}. Система должна проверять middleware, request headers, config fallback и места, где locale устанавливается в жизненном цикле запроса.`;
  }

  if (billingRollbackFocus) {
    return `По текущему исследованию задача "${input.task}" относится к runtime-поведению rollback bill и проверкам истории статусов. Основные точки входа: ${entryPointText}. Ключевые сущности перехода: ${entityText}. Главный подтверждённый operational signal: ${sideEffectText}. Основной источник данных для решения о rollback: ${dataSourceText}. Система должна проверять controller/action flow, bill history relations, вычисляемые rollback guards и создание новых BillHistory при смене статуса.`;
  }

  if (localizationInventoryFocus) {
    const localeCodes = detectLocalizationCodes(input);
    return `По текущему исследованию задача "${input.task}" больше всего связана с ${moduleText}. В проекте обнаружено ${localeCodes.length} языков локализации: ${localeCodes.join(", ") || "не удалось определить"}. Основные точки хранения: ${entryPointText}. Ключевые сущности локализации: ${entityText}. Главный подтверждённый i18n signal: ${sideEffectText}. Основной источник локализационных данных: ${dataSourceText}.`;
  }

  if (configFocus) {
    const configFiles = detectConfigFiles(input);
    const envKeys = detectEnvKeys(input);
    return `По текущему исследованию задача "${input.task}" больше всего связана с ${moduleText}. Основные точки хранения конфигурации: ${entryPointText}. Найдено ${configFiles.length} ключевых config-файлов и ${envKeys.length} env-сигналов. Ключевые конфигурационные сущности: ${entityText}. Главный подтверждённый config signal: ${sideEffectText}. Основной источник конфигурационных данных: ${dataSourceText}.`;
  }

  if (infrastructureFocus) {
    return `По текущему исследованию задача "${input.task}" больше всего связана с ${moduleText}. Наиболее вероятная зона хранения: ${dominantModule}. Основные точки входа и операции: ${entryPointText}. Ключевые сущности хранения: ${entityText}. Главный подтверждённый infrastructure signal: ${sideEffectText}. Основной источник данных и секретов: ${dataSourceText}.`;
  }

  return `По текущему исследованию задача "${input.task}" больше всего связана с ${moduleText}. ${intentText} Основные точки входа: ${entryPointText}. Ключевые сущности: ${entityText}. Главный подтверждённый operational signal: ${sideEffectText}. Основной источник данных: ${dataSourceText}.`;
}

function buildFindings(
  input: ResearchInput,
  evidence: ScoredReference[],
  moduleIntents: ModuleIntentMatch[],
  dominantModule: string,
  strongGraphSeed: boolean,
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
  const infrastructureFocus = isInfrastructureQuestion(expandTaskTokens(input.task));
  const localizationInventoryFocus = isLocalizationInventoryQuestion(expandTaskTokens(input.task));
  const localizationBehaviorFocus = isLocalizationBehaviorQuestion(expandTaskTokens(input.task));
  const billingRollbackFocus = isBillingRollbackQuestion(expandTaskTokens(input.task));
  const configFocus = isConfigQuestion(expandTaskTokens(input.task));
  const broadFocus = routeResearch(expandTaskTokens(input.task)).intentClass === "broad-unknown";

  if (broadFocus) {
    return [
      `Вопрос слишком широкий, поэтому система выполнила broad repository scan и нашла такие structural anchors: ${topLabels.join(", ")}.`,
      moduleIntents.length > 0
        ? `На верхнем уровне проявились несколько зон сразу: ${moduleIntents.slice(0, 4).map((item) => item.module).join(", ")}.`
        : "Система не смогла уверенно выделить один домен без дополнительного уточнения вопроса.",
      "Для более точного ответа нужен narrower intent: конкретный модуль, поток, хранилище, интеграция или конфигурационная зона.",
      `Сейчас проект даёт для анализа ${input.index.manifest.fileCount} индексированных файлов и ${input.index.manifest.symbolCount} извлечённых символов.`,
    ];
  }

  if (localizationBehaviorFocus) {
    return [
      `Самые сильные structural anchors для runtime-вопроса о локали: ${topLabels.join(", ")}.`,
      "Вопрос распознан как поведение запроса, поэтому research ищет не только translation-файлы, а middleware, request lifecycle, headers и config fallback.",
      moduleIntents[0]
        ? `Доменные эвристики отдали приоритет модулю "${moduleIntents[0].module}", но ответ должен подтверждаться runtime-цепочкой выбора locale.`
        : "Доменные эвристики не смогли уверенно выделить одну runtime-зону выбора locale.",
      moduleRelationSummary.length > 0
        ? `Graph показал соседние модульные связи для "${dominantModule}": ${moduleRelationSummary
            .map((item) => `${item.direction === "outgoing" ? "зависит от" : "используется модулем"} ${item.targetLabel}`)
            .join(", ")}.`
        : "Graph пока не дал выраженных межмодульных связей для runtime-зоны локализации.",
    ];
  }

  if (billingRollbackFocus) {
    return [
      `Самые сильные structural anchors для rollback/history вопроса: ${topLabels.join(", ")}.`,
      "Вопрос распознан как runtime-поведение billing rollback, поэтому research ищет не только status enum, но и controller endpoints, rollback actions, bill history relations и guards по истории.",
      moduleIntents[0]
        ? `Доменные эвристики отдали приоритет модулю "${moduleIntents[0].module}", но ответ должен подтверждаться реальной цепочкой rollbackGenerated/rollbackDraft и BillHistory.`
        : "Доменные эвристики не смогли уверенно выделить billing-зону rollback без дополнительных сигналов.",
      moduleRelationSummary.length > 0
        ? `Graph показал соседние модульные связи для "${dominantModule}": ${moduleRelationSummary
            .map((item) => `${item.direction === "outgoing" ? "зависит от" : "используется модулем"} ${item.targetLabel}`)
            .join(", ")}.`
        : "Graph пока не дал выраженных межмодульных связей для runtime-зоны billing rollback.",
    ];
  }

  if (localizationInventoryFocus) {
    const localeCodes = detectLocalizationCodes(input);
    return [
      `Самые сильные структурные опоры для локализационного вопроса: ${topLabels.join(", ")}.`,
      localeCodes.length > 0
        ? `По структуре проекта обнаружено ${localeCodes.length} языков локализации: ${localeCodes.join(", ")}.`
        : "По структуре проекта не удалось надёжно определить языки локализации.",
      moduleIntents[0]
        ? `Inventory/i18n эвристики отдали приоритет модулю "${moduleIntents[0].module}" на основе lang/locale/translation сигналов.`
        : "Inventory/i18n эвристики не смогли уверенно выделить локализационную зону.",
      `Сейчас проект даёт для анализа ${input.index.manifest.fileCount} индексированных файлов и ${input.index.manifest.symbolCount} извлечённых символов.`,
      "Отчёт исследования строится из Graph и прямых данных файлов, поэтому остаётся детерминированным и воспроизводимым для одного и того же состояния репозитория.",
    ];
  }

  if (configFocus) {
    const configFiles = detectConfigFiles(input);
    const envKeys = detectEnvKeys(input);
    return [
      `Самые сильные структурные опоры для config/env вопроса: ${topLabels.join(", ")}.`,
      configFiles.length > 0
        ? `По структуре проекта обнаружены ключевые config-файлы: ${configFiles.slice(0, 6).join(", ")}.`
        : "По структуре проекта не удалось надёжно выделить config-файлы.",
      envKeys.length > 0
        ? `Найдены env-сигналы: ${envKeys.slice(0, 8).join(", ")}.`
        : "Явные env-сигналы пока не извлечены.",
      moduleIntents[0]
        ? `Inventory/config эвристики отдали приоритет модулю "${moduleIntents[0].module}" на основе config/env/settings сигналов.`
        : "Inventory/config эвристики не смогли уверенно выделить конфигурационную зону.",
    ];
  }

  if (infrastructureFocus) {
    return [
      `Самые сильные структурные опоры для инфраструктурного вопроса: ${topLabels.join(", ")}.`,
      moduleIntents[0]
        ? `Инфраструктурные эвристики отдали приоритет модулю "${moduleIntents[0].module}" на основе host/port/credential/server/vault сигналов.`
        : "Инфраструктурные эвристики не смогли уверенно выделить одну зону хранения подключений.",
      moduleRelationSummary.length > 0
        ? `Graph показал соседние модульные связи для "${dominantModule}": ${moduleRelationSummary
            .map((item) => `${item.direction === "outgoing" ? "зависит от" : "используется модулем"} ${item.targetLabel}`)
            .join(", ")}.`
        : "Graph пока не дал выраженных межмодульных связей для доминирующей инфраструктурной зоны.",
      `Сейчас проект даёт для анализа ${input.index.manifest.fileCount} индексированных файлов и ${input.index.manifest.symbolCount} извлечённых символов.`,
      "Отчёт исследования строится из Graph и прямых данных файлов, поэтому остаётся детерминированным и воспроизводимым для одного и того же состояния репозитория.",
    ];
  }

  return [
    `Самые сильные структурные опоры для задачи: ${topLabels.join(", ")}.`,
    moduleIntents[0]
      ? `Доменные эвристики отдали приоритет модулю "${moduleIntents[0].module}" на основе терминов задачи и профильных файлов.`
      : "Доменные эвристики не смогли уверенно выделить один функциональный модуль.",
    strongGraphSeed
      ? "Question-time research стартовал от уже подтверждённого graph seed и сузил рабочую зону без широкого fallback-сканирования."
      : "Question-time research частично использовал structural fallback, потому что graph seed оказался недостаточно плотным.",
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
  strongGraphSeed: boolean,
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

  if (!strongGraphSeed) {
    unknowns.push("Graph seed для вопроса оказался недостаточно плотным, поэтому часть рабочей зоны была добрана через structural fallback.");
  }

  return unknowns;
}

function detectModuleIntents(input: ResearchInput, tokens: string[]): ModuleIntentMatch[] {
  const infrastructureFocus = isInfrastructureQuestion(tokens);
  const localizationInventoryFocus = isLocalizationInventoryQuestion(tokens);
  const localizationBehaviorFocus = isLocalizationBehaviorQuestion(tokens);
  const configFocus = isConfigQuestion(tokens);
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

      if (infrastructureFocus && profile.key === "auth" && !pathText.includes("/auth/") && !pathText.includes("authcontroller")) {
        fileScore -= 18;
      }

      if (infrastructureFocus && ["servers", "vault"].includes(profile.key) && (pathMatches > 0 || symbolMatches > 0)) {
        fileScore += 24;
      }

      if (infrastructureFocus && profile.key === "servers" && contentText.includes("password_uuid")) {
        fileScore += 18;
      }

      if (infrastructureFocus && profile.key === "servers" && contentText.includes("path_to_private_key")) {
        fileScore += 16;
      }

      if (infrastructureFocus && profile.key === "vault" && (contentText.includes("credential") || contentText.includes("passwords,uuid"))) {
        fileScore += 16;
      }

      if (localizationInventoryFocus && profile.key === "localization" && isLocalizationPath(pathText)) {
        fileScore += 48;
      }

      if (localizationInventoryFocus && profile.key === "localization" && (pathMatches > 0 || symbolMatches > 0)) {
        fileScore += 24;
      }

      if (localizationInventoryFocus && profile.key !== "localization" && (pathText.includes("/routes/") || pathText.includes("/controllers/") || pathText.includes("/auth/"))) {
        fileScore -= 30;
      }

      if (localizationBehaviorFocus && profile.key === "localization" && (pathMatches > 0 || symbolMatches > 0)) {
        fileScore += 12;
      }

      if (
        localizationBehaviorFocus
        && (pathText.includes("/middleware/") || pathText.includes("/http/") || pathText.includes("/requests/") || pathText.includes("/config/"))
      ) {
        fileScore += 20;
      }

      if (configFocus && profile.key === "config" && isConfigPath(pathText)) {
        fileScore += 52;
      }

      if (configFocus && profile.key === "config" && (contentText.includes("env(") || contentText.includes("process.env") || contentText.includes("import.meta.env"))) {
        fileScore += 24;
      }

      if (configFocus && profile.key !== "config" && (pathText.includes("/routes/") || pathText.includes("/controllers/") || pathText.includes("/auth/"))) {
        fileScore -= 28;
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
  if (routeResearch(expandTaskTokens(input.task)).intentClass === "broad-unknown") {
    return deriveBroadEntryPoints(input, topFiles).slice(0, 6);
  }

  if (isLocalizationBehaviorQuestion(expandTaskTokens(input.task))) {
    return detectLocalizationRuntimeEntryPoints(input).slice(0, 6);
  }

  if (isLocalizationInventoryQuestion(expandTaskTokens(input.task))) {
    return detectLocalizationEntryPoints(input).slice(0, 6);
  }

  if (isConfigQuestion(expandTaskTokens(input.task))) {
    return detectConfigEntryPoints(input).slice(0, 6);
  }

  if (isBillingRollbackQuestion(expandTaskTokens(input.task))) {
    return detectBillingEntryPoints(input).slice(0, 6);
  }

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

    if (isInfrastructureQuestion(expandTaskTokens(input.task)) && normalized.includes("/servers/")) {
      score += 6;
    }

    if (isInfrastructureQuestion(expandTaskTokens(input.task)) && normalized.includes("/vault/")) {
      score += 4;
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

    if (
      isInfrastructureQuestion(expandTaskTokens(input.task))
      && ["store", "update", "delete", "createserver", "updateserver"].includes(name)
      && symbol.filePath.toLowerCase().includes("server")
    ) {
      ranked.set(`${symbol.filePath}#${symbol.name}`, (ranked.get(`${symbol.filePath}#${symbol.name}`) ?? 0) + 8);
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
  const infrastructureFocus = isInfrastructureQuestion(expandTaskTokens(input.task));
  const localizationInventoryFocus = isLocalizationInventoryQuestion(expandTaskTokens(input.task));
  const localizationBehaviorFocus = isLocalizationBehaviorQuestion(expandTaskTokens(input.task));
  const billingRollbackFocus = isBillingRollbackQuestion(expandTaskTokens(input.task));
  const configFocus = isConfigQuestion(expandTaskTokens(input.task));
  const broadFocus = routeResearch(expandTaskTokens(input.task)).intentClass === "broad-unknown";

  if (localizationInventoryFocus) {
    const localeCodes = detectLocalizationCodes(input);
    const localizationFiles = input.workspace.files
      .filter((file) => isLocalizationPath(file.relativePath.toLowerCase()))
      .map((file) => file.relativePath)
      .slice(0, 4);

    return [...localeCodes, ...localizationFiles].slice(0, 8);
  }

  if (localizationBehaviorFocus) {
    return codeNodes
      .map((node) => {
        const label = node.label.toLowerCase();
        const filePath = (node.filePath ?? "").toLowerCase();
        let score = 0;

        if (topFiles.includes(node.filePath ?? "")) {
          score += 30;
        }

        if (filePath.includes("/middleware/") || filePath.includes("/http/")) {
          score += 28;
        }

        if (filePath.includes("/config/")) {
          score += 18;
        }

        if (label.includes("locale") || label.includes("language")) {
          score += 24;
        }

        if (label.includes("middleware") || label.includes("header") || label.includes("request")) {
          score += 20;
        }

        if (node.kind === "middleware") {
          score += 22;
        }

        if (node.kind === "method") {
          score += 10;
        }

        if (filePath.includes("/lang/") || filePath.includes("/translations/") || filePath.includes("/localization/")) {
          score -= 30;
        }

        if (label === "locale" || label.endsWith(".locale")) {
          score += 12;
        }

        return { label: node.label, score };
      })
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score || left.label.localeCompare(right.label))
      .map((item) => item.label)
      .filter((value, index, list) => list.indexOf(value) === index)
      .slice(0, 8);
  }

  if (billingRollbackFocus) {
    return codeNodes
      .map((node) => {
        const label = node.label.toLowerCase();
        const filePath = (node.filePath ?? "").toLowerCase();
        let score = 0;

        if (topFiles.includes(node.filePath ?? "")) {
          score += 28;
        }

        if (filePath.includes("/containers/billing/bill/") || filePath.includes("/billing/")) {
          score += 24;
        }

        if (label.includes("billcontroller")) {
          score += 36;
        }

        if (label.includes("rollbackgenerated") || label.includes("rollbackdraft")) {
          score += 34;
        }

        if (label.includes("togeneratedbillaction") || label.includes("todraftbillaction")) {
          score += 38;
        }

        if (label.includes("billhistory") || label.includes("createbillhistoryaction")) {
          score += 30;
        }

        if (label.includes("latestbillhistory") || label.includes("billspecifichistories")) {
          score += 26;
        }

        if (label.includes("generated") || label.includes("rollback") || label.includes("history")) {
          score += 16;
        }

        if (node.kind === "method" || node.kind === "class" || node.kind === "route") {
          score += 8;
        }

        if (filePath.includes("/biller/")) {
          score -= 36;
        }

        if (label.includes("export") || label.includes("analytics") || label.includes("collection")) {
          score -= 30;
        }

        return { label: node.label, score };
      })
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score || left.label.localeCompare(right.label))
      .map((item) => item.label)
      .filter((value, index, list) => list.indexOf(value) === index)
      .slice(0, 8);
  }

  if (configFocus) {
    const configFiles = detectConfigFiles(input);
    const envKeys = detectEnvKeys(input);
    return [...configFiles.slice(0, 4), ...envKeys.slice(0, 4)].slice(0, 8);
  }

  if (broadFocus) {
    return topFiles.slice(0, 8);
  }

  return codeNodes
    .filter((node) => {
      if (topFiles.includes(node.filePath ?? "")) {
        return true;
      }

      if (infrastructureFocus && isInfrastructureEntity(node)) {
        return true;
      }

      return isPrimaryEntityKind(node.kind);
    })
    .sort((left, right) => {
      const leftRouteWeight = infrastructureFocus
        ? getInfrastructureEntityWeight(left)
        : left.kind === "route" ? 2 : left.kind === "method" ? 1 : 0;
      const rightRouteWeight = infrastructureFocus
        ? getInfrastructureEntityWeight(right)
        : right.kind === "route" ? 2 : right.kind === "method" ? 1 : 0;
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
  const infrastructureFocus = isInfrastructureQuestion(expandTaskTokens(input.task));
  const localizationInventoryFocus = isLocalizationInventoryQuestion(expandTaskTokens(input.task));
  const localizationBehaviorFocus = isLocalizationBehaviorQuestion(expandTaskTokens(input.task));
  const billingRollbackFocus = isBillingRollbackQuestion(expandTaskTokens(input.task));
  const configFocus = isConfigQuestion(expandTaskTokens(input.task));

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

    if (
      infrastructureFocus
      && (
        content.includes("password_uuid")
        || content.includes("passphrase_uuid")
        || content.includes("encrypted_private_key")
        || content.includes("path_to_private_key")
      )
    ) {
      effects.add("есть работа с чувствительными credential-ссылками, приватными ключами или passphrase для серверных подключений");
    }

    if (infrastructureFocus && (content.includes("forwarding_ports") || content.includes("local_port") || content.includes("remote_port"))) {
      effects.add("есть настройка SSH port forwarding или tunnel-конфигурации");
    }

    if (localizationInventoryFocus && isLocalizationPath(file.relativePath.toLowerCase())) {
      effects.add("локализация хранится как набор translation-файлов, сгруппированных по языковым директориям");
    }

    if (localizationInventoryFocus && (content.includes("__(") || content.includes("trans(") || content.includes("validation") || content.includes("passwords"))) {
      effects.add("приложение использует translation keys и словари сообщений для UI, валидации и системных текстов");
    }

    if (localizationBehaviorFocus && (content.includes("setlocale") || content.includes("app()->setlocale") || content.includes("set_locale") || content.includes("setlanguage"))) {
      effects.add("есть runtime-логика явной установки locale внутри запроса или middleware");
    }

    if (localizationBehaviorFocus && (content.includes("x-lang") || content.includes("accept-language") || content.includes("request->header") || content.includes("headers->get"))) {
      effects.add("локаль может определяться через входящий header запроса или middleware, читающее язык из request");
    }

    if (localizationBehaviorFocus && (content.includes("fallback_locale") || content.includes("default_locale") || content.includes("config('app.locale") || content.includes("config(\"app.locale"))) {
      effects.add("при отсутствии явного language signal используется config-driven fallback locale");
    }

    if (localizationBehaviorFocus && (content.includes("middleware") || file.relativePath.toLowerCase().includes("/middleware/"))) {
      effects.add("часть поведения локализации, вероятно, находится в middleware или раннем HTTP-пайплайне");
    }

    if (billingRollbackFocus && (content.includes("createbillhistoryaction") || content.includes("billhistories()->create") || content.includes("billhistorycreated::dispatch"))) {
      effects.add("rollback и смена bill статуса сопровождаются созданием или обновлением записей BillHistory");
    }

    if (billingRollbackFocus && (content.includes("was_been_rollback_to_generated") || content.includes("billspecifichistories") || content.includes("latestbillhistory"))) {
      effects.add("решение о rollback и связанных ограничениях опирается на историю статусов bill");
    }

    if (billingRollbackFocus && (content.includes("rollbackgenerated") || content.includes("rollbackdraft") || content.includes("togeneratedbillaction") || content.includes("todraftbillaction"))) {
      effects.add("в billing есть явный rollback flow через controller/action слой для draft и generated статусов");
    }

    if (configFocus && isConfigPath(file.relativePath.toLowerCase())) {
      effects.add("конфигурация хранится в статических config-файлах и собирается через env/settings helpers");
    }

    if (configFocus && (content.includes("env(") || content.includes("process.env") || content.includes("import.meta.env"))) {
      effects.add("часть поведения приложения параметризуется через env-переменные окружения");
    }
  }

  if (localizationBehaviorFocus) {
    return prioritizeLocalizationRuntimeEffects([...effects]).slice(0, 6);
  }

  if (localizationInventoryFocus) {
    return prioritizeLocalizationEffects([...effects]).slice(0, 6);
  }

  if (billingRollbackFocus) {
    return prioritizeBillingEffects([...effects]).slice(0, 6);
  }

  if (configFocus) {
    return prioritizeConfigEffects([...effects]).slice(0, 6);
  }

  if (infrastructureFocus) {
    return prioritizeInfrastructureEffects([...effects]).slice(0, 6);
  }

  return [...effects].slice(0, 6);
}

function detectDataSources(input: ResearchInput): string[] {
  const sources = new Set<string>();
  const infrastructureFocus = isInfrastructureQuestion(expandTaskTokens(input.task));
  const localizationInventoryFocus = isLocalizationInventoryQuestion(expandTaskTokens(input.task));
  const localizationBehaviorFocus = isLocalizationBehaviorQuestion(expandTaskTokens(input.task));
  const billingRollbackFocus = isBillingRollbackQuestion(expandTaskTokens(input.task));
  const configFocus = isConfigQuestion(expandTaskTokens(input.task));

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

    if (
      infrastructureFocus
      && (
        content.includes("exists:passwords,uuid")
        || content.includes("servercredentiallink")
        || content.includes("credentiallinks")
        || content.includes("belongsto(password::class)")
      )
    ) {
      sources.add("секреты и credential-ссылки берутся из vault/password storage и связываются с сервером через отдельные сущности");
    }

    if (
      infrastructureFocus
      && (
        content.includes("protected $fillable")
        || content.includes("hasmany(servercredentiallink::class)")
        || content.includes("hasmany(forwardingport::class)")
      )
      && file.relativePath.toLowerCase().includes("server")
    ) {
      sources.add("структура серверного подключения хранится в модельном и табличном слое приложения");
    }

    if (localizationInventoryFocus && isLocalizationPath(file.relativePath.toLowerCase())) {
      sources.add("локализационные данные определяются по каталогам и translation-файлам внутри lang/locales/i18n-структуры");
    }

    if (localizationInventoryFocus && (content.includes("__(") || content.includes("trans("))) {
      sources.add("часть локализационных ключей используется через translation helper-функции приложения");
    }

    if (localizationBehaviorFocus && (content.includes("env(") || content.includes("config(") || file.relativePath.toLowerCase().includes("/config/"))) {
      sources.add("fallback locale и языковые правила могут подтягиваться из config/env-слоя приложения");
    }

    if (localizationBehaviorFocus && (content.includes("request->header") || content.includes("x-lang") || content.includes("accept-language"))) {
      sources.add("часть выбора локали может зависеть от данных входящего HTTP-запроса");
    }

    if (billingRollbackFocus && (content.includes("billhistory") || content.includes("billspecifichistories") || content.includes("latesteffectivebillstatushistory"))) {
      sources.add("решение о rollback bill и текущем статусе опирается на BillHistory и связанные model relations");
    }

    if (billingRollbackFocus && (content.includes("bill_status_id") || content.includes("billstatusenum::generated_status") || content.includes("billstatus::getstatusbyname"))) {
      sources.add("смена rollback статуса использует BillStatus и status enum/lookup слой");
    }

    if (billingRollbackFocus && (content.includes("hasmany(billhistory::class)") || content.includes("morphmany(billhistory::class)") || content.includes("billhistories()->create"))) {
      sources.add("история статусов хранится и обновляется через ORM-связи Bill/BillModel -> BillHistory");
    }

    if (configFocus && isConfigPath(file.relativePath.toLowerCase())) {
      sources.add("конфигурационные данные определяются через config-файлы проекта");
    }

    if (configFocus && (content.includes("env(") || content.includes("process.env") || content.includes("import.meta.env"))) {
      sources.add("часть конфигурации подтягивается из env-переменных окружения");
    }
  }

  if (localizationBehaviorFocus) {
    return prioritizeLocalizationRuntimeSources([...sources]).slice(0, 6);
  }

  if (localizationInventoryFocus) {
    return prioritizeLocalizationSources([...sources]).slice(0, 6);
  }

  if (billingRollbackFocus) {
    return prioritizeBillingSources([...sources]).slice(0, 6);
  }

  if (configFocus) {
    return prioritizeConfigSources([...sources]).slice(0, 6);
  }

  if (infrastructureFocus) {
    return prioritizeInfrastructureSources([...sources]).slice(0, 6);
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

function isInfrastructureQuestion(tokens: string[]): boolean {
  return tokens.some((token) =>
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
      "серверу",
      "сервером",
      "подключение",
      "подключения",
      "соединение",
      "соединения",
      "ssh-соединения",
      "хост",
      "порт",
      "пароль",
      "пароли",
      "ключ",
      "ключи",
    ].includes(token),
  );
}

function isLocalizationInventoryQuestion(tokens: string[]): boolean {
  return tokens.some((token) =>
    [
      "localization",
      "locale",
      "locales",
      "translation",
      "translations",
      "translate",
      "i18n",
      "lang",
      "language",
      "languages",
      "локализация",
      "локализации",
      "перевод",
      "переводы",
      "язык",
      "языки",
      "языков",
      "локаль",
      "локали",
      "локалей",
    ].includes(token),
  );
}

function isLocalizationBehaviorQuestion(tokens: string[]): boolean {
  const hasLocalizationSignal = isLocalizationInventoryQuestion(tokens);
  const hasBehaviorSignal = tokens.some((token) =>
    [
      "how",
      "work",
      "works",
      "flow",
      "behavior",
      "behaviour",
      "request",
      "response",
      "header",
      "headers",
      "middleware",
      "default",
      "fallback",
      "выбирается",
      "выбора",
      "определяется",
      "определение",
      "работает",
      "как",
      "почему",
      "ответ",
      "ответа",
      "заголовок",
      "заголовки",
      "мидлвар",
      "middleware",
      "дефолт",
    ].includes(token),
  );

  return hasLocalizationSignal && hasBehaviorSignal;
}

function isBillingRollbackQuestion(tokens: string[]): boolean {
  const hasBillingSignal = tokens.some((token) =>
    [
      "bill",
      "billing",
      "generated",
      "draft",
      "status",
      "history",
      "rollback",
      "rollbackgenerated",
      "rollbackdraft",
      "billhistory",
      "билл",
      "билинг",
      "статус",
      "история",
      "откат",
      "ролбек",
    ].includes(token),
  );
  const hasBehaviorSignal = tokens.some((token) =>
    [
      "how",
      "work",
      "works",
      "flow",
      "behavior",
      "why",
      "check",
      "guard",
      "работает",
      "как",
      "почему",
      "проверяется",
      "проверка",
      "нельзя",
      "можно",
      "откат",
      "ролбек",
    ].includes(token),
  );

  return hasBillingSignal && hasBehaviorSignal;
}

function isConfigQuestion(tokens: string[]): boolean {
  return tokens.some((token) =>
    [
      "config",
      "configs",
      "configuration",
      "settings",
      "setting",
      "env",
      "environment",
      "variable",
      "variables",
      "dotenv",
      "конфиг",
      "конфиги",
      "конфигурация",
      "настройка",
      "настройки",
      "переменная",
      "переменные",
      "окружение",
      "env-переменные",
    ].includes(token),
  );
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

function getGraphProfileFileBoost(
  filePath: string,
  graphSeedFilePaths: Set<string>,
  graphSeedLabels: string[],
  queryProfileKey: ResearchQueryProfileKey,
): number {
  const normalized = filePath.toLowerCase();

  if (graphSeedFilePaths.has(filePath)) {
    return 40;
  }

  if (graphSeedLabels.some((label) => normalized.includes(label))) {
    return 12;
  }

  if (queryProfileKey === "broad-scan") {
    if (normalized.includes("/routes/") || normalized.includes("/controllers/") || normalized.includes("/services/")) {
      return 6;
    }

    if (normalized.startsWith("app/") || normalized.startsWith("src/") || normalized.startsWith("config/")) {
      return 4;
    }
  }

  return 0;
}

function getGraphProfileSymbolBoost(
  symbol: IndexSymbol,
  graphSeedFilePaths: Set<string>,
  graphSeedNodeIds: Set<string>,
  graphSeedLabels: string[],
  queryProfileKey: ResearchQueryProfileKey,
): number {
  const label = `${symbol.containerName ? `${symbol.containerName}.` : ""}${symbol.name}`.toLowerCase();

  if (graphSeedNodeIds.has(symbol.id)) {
    return 32;
  }

  if (graphSeedFilePaths.has(symbol.filePath)) {
    return 18;
  }

  if (graphSeedLabels.some((candidate) => label.includes(candidate) || candidate.includes(label))) {
    return 8;
  }

  if (queryProfileKey === "entrypoint-traversal" && symbol.kind === "route") {
    return 12;
  }

  if (queryProfileKey === "storage-topology" && ["class", "method"].includes(symbol.kind)) {
    return 10;
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
  if (isInfrastructureQuestion(tokens)) {
    if (kind === "class") {
      return 24;
    }

    if (kind === "method") {
      return 16;
    }

    if (kind === "route") {
      return 14;
    }

    if (kind === "function") {
      return 10;
    }
  }

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

function isInfrastructureEntity(node: GraphState["nodes"][number]): boolean {
  const label = node.label.toLowerCase();
  const filePath = node.filePath?.toLowerCase() ?? "";

  return (
    label.includes("server")
    || label.includes("credential")
    || label.includes("vault")
    || label.includes("password_uuid")
    || label.includes("passphrase_uuid")
    || label.includes("private_key")
    || filePath.includes("/servers/")
    || filePath.includes("servercredential")
    || filePath.includes("/vault/")
  );
}

function getInfrastructureEntityWeight(node: GraphState["nodes"][number]): number {
  const label = node.label.toLowerCase();
  const filePath = node.filePath?.toLowerCase() ?? "";

  if (filePath.includes("servercredential") || label.includes("servercredential")) {
    return 8;
  }

  if (filePath.includes("/models/server") || label === "server") {
    return 7;
  }

  if (filePath.includes("forwardingport") || label.includes("forwardingport")) {
    return 6;
  }

  if (filePath.includes("/servers/") || label.includes("servers")) {
    return 5;
  }

  if (filePath.includes("/vault/") || label.includes("vault") || label.includes("password")) {
    return 4;
  }

  if (node.kind === "class") {
    return 3;
  }

  if (node.kind === "method") {
    return 2;
  }

  if (node.kind === "route") {
    return 1;
  }

  return 0;
}

function getInfrastructureFileBoost(
  file: WorkspaceSnapshot["files"][number],
  infrastructureFocus: boolean,
  tokens: string[],
): number {
  if (!infrastructureFocus) {
    return 0;
  }

  const pathText = file.relativePath.toLowerCase();
  const contentText = file.content.slice(0, 4000).toLowerCase();
  let score = 0;

  if (pathText.includes("/servers/") || pathText.includes("servercredential") || pathText.includes("/models/server")) {
    score += 40;
  }

  if (pathText.includes("/vault/") || pathText.includes("/models/password")) {
    score += 24;
  }

  if (pathText.includes("migration") && (contentText.includes("schema::create('servers'") || contentText.includes("server_credential_links"))) {
    score += 36;
  }

  if (contentText.includes("password_uuid") || contentText.includes("passphrase_uuid")) {
    score += 26;
  }

  if (contentText.includes("path_to_private_key") || contentText.includes("forwarding_ports")) {
    score += 22;
  }

  if (contentText.includes("host") && contentText.includes("port") && contentText.includes("username")) {
    score += 18;
  }

  if ((pathText.includes("/auth/") || pathText.includes("web-login")) && !tokens.some((token) => ["auth", "login", "oauth", "token"].includes(token))) {
    score -= 30;
  }

  return score;
}

function getInfrastructureSymbolBoost(
  symbol: IndexSymbol,
  infrastructureFocus: boolean,
  tokens: string[],
): number {
  if (!infrastructureFocus) {
    return 0;
  }

  const label = `${symbol.containerName ? `${symbol.containerName}.` : ""}${symbol.name}`.toLowerCase();
  const filePath = symbol.filePath.toLowerCase();
  let score = 0;

  if (label.includes("server") || label.includes("credential") || label.includes("forwarding") || label.includes("privatekey")) {
    score += 24;
  }

  if (label.includes("password_uuid") || label.includes("passphrase_uuid")) {
    score += 28;
  }

  if (filePath.includes("/servers/") || filePath.includes("servercredential") || filePath.includes("/models/server")) {
    score += 24;
  }

  if ((filePath.includes("/auth/") || filePath.includes("web-login")) && !tokens.some((token) => ["auth", "login", "oauth", "token"].includes(token))) {
    score -= 24;
  }

  return score;
}

function getInfrastructureRoutePenalty(filePath: string, infrastructureFocus: boolean): number {
  if (!infrastructureFocus) {
    return 0;
  }

  const normalized = filePath.toLowerCase();

  if (normalized.includes("/servers/")) {
    return 16;
  }

  if (normalized.includes("/auth/") || normalized.includes("web-login")) {
    return -22;
  }

  return -4;
}

function getLocalizationFileBoost(
  file: WorkspaceSnapshot["files"][number],
  localizationFocus: boolean,
  tokens: string[],
): number {
  if (!localizationFocus) {
    return 0;
  }

  const pathText = file.relativePath.toLowerCase();
  const contentText = file.content.slice(0, 4000).toLowerCase();
  let score = 0;

  if (isLocalizationPath(pathText)) {
    score += 60;
  }

  if (pathText.includes("/lang/") || pathText.startsWith("lang/") || pathText.includes("/translations/")) {
    score += 24;
  }

  if (contentText.includes("__(") || contentText.includes("trans(")) {
    score += 10;
  }

  if (pathText.includes("/routes/") || pathText.includes("/controllers/") || pathText.includes("/auth/")) {
    score -= 36;
  }

  if (tokens.some((token) => pathText.includes(token))) {
    score += 6;
  }

  return score;
}

function getLocalizationSymbolBoost(
  symbol: IndexSymbol,
  localizationFocus: boolean,
  tokens: string[],
): number {
  if (!localizationFocus) {
    return 0;
  }

  const label = `${symbol.containerName ? `${symbol.containerName}.` : ""}${symbol.name}`.toLowerCase();
  const filePath = symbol.filePath.toLowerCase();
  let score = 0;

  if (isLocalizationPath(filePath)) {
    score += 20;
  }

  if (label.includes("lang") || label.includes("locale") || label.includes("translation")) {
    score += 12;
  }

  if (symbol.kind === "route" || symbol.kind === "method") {
    score -= 28;
  }

  if (tokens.some((token) => label.includes(token))) {
    score += 4;
  }

  return score;
}

function getLocalizationRoutePenalty(filePath: string, localizationFocus: boolean): number {
  if (!localizationFocus) {
    return 0;
  }

  return isLocalizationPath(filePath.toLowerCase()) ? 8 : -42;
}

function getLocaleRuntimeFileBoost(
  file: WorkspaceSnapshot["files"][number],
  localizationBehaviorFocus: boolean,
  tokens: string[],
): number {
  if (!localizationBehaviorFocus) {
    return 0;
  }

  const pathText = file.relativePath.toLowerCase();
  const contentText = file.content.slice(0, 4000).toLowerCase();
  let score = 0;

  if (pathText.includes("/middleware/") || pathText.includes("/http/") || pathText.includes("/requests/")) {
    score += 34;
  }

  if (pathText.includes("/config/")) {
    score += 26;
  }

  if (pathText.includes("/lang/") || pathText.includes("/translations/")) {
    score -= 18;
  }

  if (contentText.includes("x-lang") || contentText.includes("accept-language")) {
    score += 42;
  }

  if (contentText.includes("request->header") || contentText.includes("header(") || contentText.includes("headers->get")) {
    score += 28;
  }

  if (contentText.includes("setlocale") || contentText.includes("app()->setlocale") || contentText.includes("set_locale")) {
    score += 36;
  }

  if (contentText.includes("config(") || contentText.includes("env(") || contentText.includes("fallback_locale") || contentText.includes("default_locale")) {
    score += 18;
  }

  if (tokens.some((token) => pathText.includes(token) || contentText.includes(token))) {
    score += 6;
  }

  return score;
}

function getLocaleRuntimeSymbolBoost(
  symbol: IndexSymbol,
  localizationBehaviorFocus: boolean,
  tokens: string[],
): number {
  if (!localizationBehaviorFocus) {
    return 0;
  }

  const label = `${symbol.containerName ? `${symbol.containerName}.` : ""}${symbol.name}`.toLowerCase();
  const filePath = symbol.filePath.toLowerCase();
  let score = 0;

  if (filePath.includes("/middleware/") || filePath.includes("/http/") || filePath.includes("/config/")) {
    score += 18;
  }

  if (label.includes("locale") || label.includes("lang") || label.includes("language")) {
    score += 18;
  }

  if (label.includes("middleware") || label.includes("header") || label.includes("request")) {
    score += 16;
  }

  if (symbol.kind === "middleware" || symbol.kind === "method") {
    score += 12;
  }

  if (isLocalizationPath(filePath)) {
    score -= 14;
  }

  if (tokens.some((token) => label.includes(token))) {
    score += 6;
  }

  return score;
}

function getLocaleRuntimeRouteBoost(filePath: string, localizationBehaviorFocus: boolean): number {
  if (!localizationBehaviorFocus) {
    return 0;
  }

  const normalized = filePath.toLowerCase();

  if (normalized.includes("/middleware/") || normalized.includes("/http/")) {
    return 12;
  }

  if (isLocalizationPath(normalized)) {
    return -24;
  }

  return 0;
}

function getRuntimeLocaleGraphFileBoost(
  filePath: string,
  runtimeLocaleFilePaths: Set<string>,
  runtimeLocaleEdges: GraphState["edges"],
): number {
  const normalized = filePath.toLowerCase();
  let score = 0;

  if (runtimeLocaleFilePaths.has(filePath)) {
    score += 28;
  }

  for (const edge of runtimeLocaleEdges) {
    const semantic = String(edge.metadata?.semantic ?? "").toLowerCase();
    const header = String(edge.metadata?.header ?? "").toLowerCase();
    const configKey = String(edge.metadata?.configKey ?? "").toLowerCase();
    const sourceFilePath = String(edge.metadata?.sourceFilePath ?? "");

    if (sourceFilePath !== filePath) {
      continue;
    }

    if (semantic === "locale-set") {
      score += 42;
    }

    if (semantic === "request-header" && (header.includes("locale") || header.includes("lang"))) {
      score += 38;
    }

    if (semantic === "locale-config" || configKey.includes("locale")) {
      score += 26;
    }
  }

  if (normalized.includes("localemiddleware")) {
    score += 50;
  }

  if (normalized.endsWith("config/app.php")) {
    score += 36;
  }

  return score;
}

function getRuntimeLocaleGraphSymbolBoost(
  symbol: IndexSymbol,
  runtimeLocaleNodeIds: Set<string>,
  runtimeLocaleFilePaths: Set<string>,
  runtimeLocaleEdges: GraphState["edges"],
): number {
  const label = `${symbol.containerName ? `${symbol.containerName}.` : ""}${symbol.name}`.toLowerCase();
  let score = 0;

  if (runtimeLocaleNodeIds.has(symbol.id)) {
    score += 32;
  }

  if (runtimeLocaleFilePaths.has(symbol.filePath)) {
    score += 20;
  }

  if (label.includes("locale") || label.includes("language")) {
    score += 18;
  }

  for (const edge of runtimeLocaleEdges) {
    if (edge.sourceId !== symbol.id) {
      continue;
    }

    const semantic = String(edge.metadata?.semantic ?? "").toLowerCase();

    if (semantic === "locale-set") {
      score += 36;
    }

    if (semantic === "request-header") {
      score += 24;
    }

    if (semantic === "locale-config") {
      score += 18;
    }
  }

  return score;
}

function getBillingRollbackFileBoost(
  file: WorkspaceSnapshot["files"][number],
  billingRollbackFocus: boolean,
  tokens: string[],
): number {
  if (!billingRollbackFocus) {
    return 0;
  }

  const pathText = file.relativePath.toLowerCase();
  const contentText = file.content.slice(0, 4000).toLowerCase();
  let score = 0;

  if (pathText.includes("/billing/")) {
    score += 28;
  }

  if (pathText.includes("/containers/billing/bill/")) {
    score += 48;
  }

  if (pathText.includes("billhistory") || pathText.includes("togeneratedbillaction") || pathText.includes("todraftbillaction")) {
    score += 34;
  }

  if (pathText.includes("billcontroller.php")) {
    score += 56;
  }

  if (pathText.includes("/ui/api/routes/routeprovider.php")) {
    score += 34;
  }

  if (pathText.includes("/biller/")) {
    score -= 42;
  }

  if (pathText.includes("export") || pathText.includes("analytics") || pathText.includes("collection")) {
    score -= 36;
  }

  if (contentText.includes("was_been_rollback_to_generated")) {
    score += 54;
  }

  if (contentText.includes("billspecifichistories") || contentText.includes("latestbillhistory") || contentText.includes("latesteffectivebillstatushistory")) {
    score += 30;
  }

  if (contentText.includes("createbillhistoryaction") || contentText.includes("billhistories()->create")) {
    score += 32;
  }

  if (contentText.includes("rollbackgenerated") || contentText.includes("rollbackdraft")) {
    score += 24;
  }

  if (contentText.includes("togeneratedbillaction") || contentText.includes("todraftbillaction")) {
    score += 52;
  }

  if (contentText.includes("createbillhistoryaction")) {
    score += 32;
  }

  if (contentText.includes("v1/billing/bill") || contentText.includes("/rollback/generated")) {
    score += 44;
  }

  if (tokens.some((token) => pathText.includes(token) || contentText.includes(token))) {
    score += 6;
  }

  return score;
}

function getBillingRollbackSymbolBoost(
  symbol: IndexSymbol,
  billingRollbackFocus: boolean,
  tokens: string[],
): number {
  if (!billingRollbackFocus) {
    return 0;
  }

  const label = `${symbol.containerName ? `${symbol.containerName}.` : ""}${symbol.name}`.toLowerCase();
  const filePath = symbol.filePath.toLowerCase();
  let score = 0;

  if (filePath.includes("/billing/")) {
    score += 18;
  }

  if (filePath.includes("/containers/billing/bill/")) {
    score += 28;
  }

  if (label.includes("bill") || label.includes("history") || label.includes("rollback") || label.includes("generated")) {
    score += 18;
  }

  if (label.includes("rollbackgenerated") || label.includes("rollbackdraft")) {
    score += 30;
  }

  if (label.includes("billcontroller")) {
    score += 44;
  }

  if (label.includes("togeneratedbillaction") || label.includes("todraftbillaction")) {
    score += 52;
  }

  if (label.includes("createbillhistoryaction") || label.includes("latestbillhistory") || label.includes("billspecifichistories")) {
    score += 36;
  }

  if (filePath.includes("/biller/")) {
    score -= 38;
  }

  if (label.includes("export") || label.includes("analytics") || label.includes("collection")) {
    score -= 34;
  }

  if (symbol.kind === "method" || symbol.kind === "class") {
    score += 12;
  }

  if (tokens.some((token) => label.includes(token))) {
    score += 6;
  }

  return score;
}

function getBillingRollbackRouteBoost(filePath: string, billingRollbackFocus: boolean): number {
  if (!billingRollbackFocus) {
    return 0;
  }

  const normalized = filePath.toLowerCase();
  return normalized.includes("/billing/") || normalized.includes("/routes/") ? 16 : 0;
}

function getRuntimeBillingGraphFileBoost(
  filePath: string,
  runtimeBillingFilePaths: Set<string>,
  runtimeBillingEdges: GraphState["edges"],
): number {
  const normalized = filePath.toLowerCase();
  let score = 0;

  if (runtimeBillingFilePaths.has(filePath)) {
    score += 28;
  }

  if (normalized.includes("/containers/billing/bill/")) {
    score += 34;
  }

  for (const edge of runtimeBillingEdges) {
    const semantic = String(edge.metadata?.semantic ?? "").toLowerCase();
    const relation = String(edge.metadata?.relation ?? "").toLowerCase();
    const guard = String(edge.metadata?.guard ?? "").toLowerCase();
    const operation = String(edge.metadata?.operation ?? "").toLowerCase();
    const sourceFilePath = String(edge.metadata?.sourceFilePath ?? "");

    if (sourceFilePath !== filePath) {
      continue;
    }

    if (semantic === "bill-history-read") {
      score += 34;
    }

    if (semantic === "bill-history-write") {
      score += 40;
    }

    if (semantic === "bill-rollback-guard") {
      score += 42;
    }

    if (relation.includes("history")) {
      score += 16;
    }

    if (guard.includes("rollback") || guard.includes("generated")) {
      score += 18;
    }

    if (operation.includes("history")) {
      score += 14;
    }
  }

  if (normalized.includes("billcontroller.php")) {
    score += 30;
  }

  if (normalized.includes("togeneratedbillaction") || normalized.includes("todraftbillaction")) {
    score += 42;
  }

  if (normalized.includes("billmodel.php") || normalized.endsWith("/bill.php")) {
    score += 20;
  }

  if (normalized.includes("/biller/")) {
    score -= 44;
  }

  if (normalized.includes("export") || normalized.includes("analytics") || normalized.includes("collection")) {
    score -= 38;
  }

  return score;
}

function getRuntimeBillingGraphSymbolBoost(
  symbol: IndexSymbol,
  runtimeBillingNodeIds: Set<string>,
  runtimeBillingFilePaths: Set<string>,
  runtimeBillingEdges: GraphState["edges"],
): number {
  const label = `${symbol.containerName ? `${symbol.containerName}.` : ""}${symbol.name}`.toLowerCase();
  let score = 0;

  if (runtimeBillingNodeIds.has(symbol.id)) {
    score += 32;
  }

  if (runtimeBillingFilePaths.has(symbol.filePath)) {
    score += 20;
  }

  if (symbol.filePath.toLowerCase().includes("/containers/billing/bill/")) {
    score += 28;
  }

  if (label.includes("bill") || label.includes("rollback") || label.includes("history") || label.includes("generated")) {
    score += 18;
  }

  if (label.includes("billcontroller")) {
    score += 40;
  }

  if (label.includes("togeneratedbillaction") || label.includes("todraftbillaction")) {
    score += 46;
  }

  if (label.includes("createbillhistoryaction") || label.includes("latestbillhistory") || label.includes("billspecifichistories")) {
    score += 34;
  }

  if (symbol.filePath.toLowerCase().includes("/biller/")) {
    score -= 40;
  }

  if (label.includes("export") || label.includes("analytics") || label.includes("collection")) {
    score -= 30;
  }

  for (const edge of runtimeBillingEdges) {
    if (edge.sourceId !== symbol.id) {
      continue;
    }

    const semantic = String(edge.metadata?.semantic ?? "").toLowerCase();

    if (semantic === "bill-history-read") {
      score += 24;
    }

    if (semantic === "bill-history-write") {
      score += 28;
    }

    if (semantic === "bill-rollback-guard") {
      score += 30;
    }
  }

  return score;
}

function getConfigFileBoost(
  file: WorkspaceSnapshot["files"][number],
  configFocus: boolean,
  tokens: string[],
): number {
  if (!configFocus) {
    return 0;
  }

  const pathText = file.relativePath.toLowerCase();
  const contentText = file.content.slice(0, 4000).toLowerCase();
  let score = 0;

  if (isConfigPath(pathText)) {
    score += 58;
  }

  if (contentText.includes("env(") || contentText.includes("process.env") || contentText.includes("import.meta.env")) {
    score += 26;
  }

  if (pathText.includes("/routes/") || pathText.includes("/controllers/") || pathText.includes("/auth/")) {
    score -= 36;
  }

  if (tokens.some((token) => pathText.includes(token))) {
    score += 6;
  }

  return score;
}

function getConfigSymbolBoost(
  symbol: IndexSymbol,
  configFocus: boolean,
  tokens: string[],
): number {
  if (!configFocus) {
    return 0;
  }

  const label = `${symbol.containerName ? `${symbol.containerName}.` : ""}${symbol.name}`.toLowerCase();
  const filePath = symbol.filePath.toLowerCase();
  let score = 0;

  if (isConfigPath(filePath)) {
    score += 20;
  }

  if (label.includes("config") || label.includes("env") || label.includes("settings")) {
    score += 10;
  }

  if (symbol.kind === "route" || symbol.kind === "method") {
    score -= 28;
  }

  if (tokens.some((token) => label.includes(token))) {
    score += 4;
  }

  return score;
}

function getConfigRoutePenalty(filePath: string, configFocus: boolean): number {
  if (!configFocus) {
    return 0;
  }

  return isConfigPath(filePath.toLowerCase()) ? 8 : -42;
}

function prioritizeInfrastructureEffects(effects: string[]): string[] {
  const preferred = [
    "есть работа с чувствительными credential-ссылками, приватными ключами или passphrase для серверных подключений",
    "есть настройка SSH port forwarding или tunnel-конфигурации",
  ];

  return [...effects].sort((left, right) => getPreferredOrder(left, preferred) - getPreferredOrder(right, preferred));
}

function prioritizeInfrastructureSources(sources: string[]): string[] {
  const preferred = [
    "секреты и credential-ссылки берутся из vault/password storage и связываются с сервером через отдельные сущности",
    "структура серверного подключения хранится в модельном и табличном слое приложения",
    "данные поступают из базы данных или ORM-слоя",
  ];

  return [...sources].sort((left, right) => getPreferredOrder(left, preferred) - getPreferredOrder(right, preferred));
}

function prioritizeLocalizationEffects(effects: string[]): string[] {
  const preferred = [
    "локализация хранится как набор translation-файлов, сгруппированных по языковым директориям",
    "приложение использует translation keys и словари сообщений для UI, валидации и системных текстов",
  ];

  return [...effects].sort((left, right) => getPreferredOrder(left, preferred) - getPreferredOrder(right, preferred));
}

function prioritizeLocalizationRuntimeEffects(effects: string[]): string[] {
  const preferred = [
    "локаль может определяться через входящий header запроса или middleware, читающее язык из request",
    "есть runtime-логика явной установки locale внутри запроса или middleware",
    "при отсутствии явного language signal используется config-driven fallback locale",
    "часть поведения локализации, вероятно, находится в middleware или раннем HTTP-пайплайне",
  ];

  return [...effects].sort((left, right) => getPreferredOrder(left, preferred) - getPreferredOrder(right, preferred));
}

function prioritizeLocalizationSources(sources: string[]): string[] {
  const preferred = [
    "локализационные данные определяются по каталогам и translation-файлам внутри lang/locales/i18n-структуры",
    "часть локализационных ключей используется через translation helper-функции приложения",
  ];

  return [...sources].sort((left, right) => getPreferredOrder(left, preferred) - getPreferredOrder(right, preferred));
}

function prioritizeLocalizationRuntimeSources(sources: string[]): string[] {
  const preferred = [
    "часть выбора локали может зависеть от данных входящего HTTP-запроса",
    "fallback locale и языковые правила могут подтягиваться из config/env-слоя приложения",
    "данные поступают из базы данных или ORM-слоя",
    "используются файлы и конфигурационные артефакты как источник данных",
  ];

  return [...sources].sort((left, right) => getPreferredOrder(left, preferred) - getPreferredOrder(right, preferred));
}

function prioritizeBillingEffects(effects: string[]): string[] {
  const preferred = [
    "решение о rollback и связанных ограничениях опирается на историю статусов bill",
    "rollback и смена bill статуса сопровождаются созданием или обновлением записей BillHistory",
    "в billing есть явный rollback flow через controller/action слой для draft и generated статусов",
  ];

  return [...effects].sort((left, right) => getPreferredOrder(left, preferred) - getPreferredOrder(right, preferred));
}

function prioritizeBillingSources(sources: string[]): string[] {
  const preferred = [
    "решение о rollback bill и текущем статусе опирается на BillHistory и связанные model relations",
    "история статусов хранится и обновляется через ORM-связи Bill/BillModel -> BillHistory",
    "смена rollback статуса использует BillStatus и status enum/lookup слой",
  ];

  return [...sources].sort((left, right) => getPreferredOrder(left, preferred) - getPreferredOrder(right, preferred));
}

function prioritizeConfigEffects(effects: string[]): string[] {
  const preferred = [
    "конфигурация хранится в статических config-файлах и собирается через env/settings helpers",
    "часть поведения приложения параметризуется через env-переменные окружения",
  ];

  return [...effects].sort((left, right) => getPreferredOrder(left, preferred) - getPreferredOrder(right, preferred));
}

function prioritizeConfigSources(sources: string[]): string[] {
  const preferred = [
    "конфигурационные данные определяются через config-файлы проекта",
    "часть конфигурации подтягивается из env-переменных окружения",
  ];

  return [...sources].sort((left, right) => getPreferredOrder(left, preferred) - getPreferredOrder(right, preferred));
}

function getPreferredOrder(value: string, preferred: string[]): number {
  const index = preferred.indexOf(value);
  return index === -1 ? preferred.length + 1 : index;
}

function findModuleNodeId(graph: GraphState, moduleLabel: string): string | null {
  return graph.nodes.find((node) => node.kind === "module" && node.label === moduleLabel)?.id ?? null;
}

function computeConfidence(input: ResearchInput, evidence: ScoredReference[], unknowns: string[]): number {
  let confidence = 45;
  confidence += Math.min(evidence.length * 4, 30);
  confidence += Math.min(input.graph.summary.symbolCount / 10, 15);
  confidence -= unknowns.length * 8;

  if (routeResearch(expandTaskTokens(input.task)).intentClass === "broad-unknown") {
    confidence -= 28;
  }

  return clamp(Math.round(confidence), 5, 95);
}

function deriveAffectedModules(
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
    dominantModule !== "не определён" ? dominantModule : "",
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

    return presentInTopFiles;
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

  if (normalized.includes("server") || normalized.includes("ssh") || normalized.includes("host") || normalized.includes("port")) {
    zones.push("servers");
  }

  if (normalized.includes("vault") || normalized.includes("credential") || normalized.includes("password_uuid") || normalized.includes("private_key")) {
    zones.push("vault");
  }

  if (normalized.includes("lang") || normalized.includes("locale") || normalized.includes("translation") || normalized.includes("локал")) {
    zones.push("localization");
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

  if (
    normalized.includes("/servers/")
    || normalized.includes("servercredential")
    || normalized.includes("/models/server")
    || normalized.includes("serverscontroller")
    || normalized.includes("serversservice")
  ) {
    zones.push("servers");
  }

  if (
    normalized.includes("/vault/")
    || normalized.includes("/models/password")
    || normalized.includes("credential")
    || normalized.includes("private_key")
  ) {
    zones.push("vault");
  }

  if (isLocalizationPath(normalized)) {
    const localeBucket = deriveLocalizationBucket(filePath);
    zones.push(localeBucket ? `localization:${localeBucket}` : "localization");
  }

  if (isConfigPath(normalized)) {
    zones.push("config");
  }

  const structuralModule = deriveStructuralModuleLabel(filePath);

  if (structuralModule.startsWith("container:")) {
    zones.push(structuralModule);
  }

  return zones;
}

function detectLocalizationEntryPoints(input: ResearchInput): string[] {
  const directories = new Set<string>();
  const files: string[] = [];

  for (const file of input.workspace.files) {
    const normalized = file.relativePath.toLowerCase();

    if (!isLocalizationPath(normalized)) {
      continue;
    }

    const localeBucket = deriveLocalizationBucket(file.relativePath);

    if (localeBucket) {
      directories.add(`localization/${localeBucket}`);
    }

    files.push(file.relativePath);
  }

  return [...directories, ...files].slice(0, 8);
}

function detectLocalizationRuntimeEntryPoints(input: ResearchInput): string[] {
  const ranked = new Map<string, number>();
  const runtimeNodes = getLocalizationRuntimeNodes(input.graph);
  const runtimeEdges = [
    ...getRuntimeSemanticEdges(input.graph, "locale-set"),
    ...getRuntimeSemanticEdges(input.graph, "request-header"),
    ...getRuntimeSemanticEdges(input.graph, "locale-config"),
  ];

  for (const file of input.workspace.files) {
    const normalized = file.relativePath.toLowerCase();
    const content = file.content.toLowerCase();
    let score = 0;

    if (normalized.includes("/middleware/") || normalized.includes("/http/")) {
      score += 18;
    }

    if (normalized.includes("/config/")) {
      score += 14;
    }

    if (normalized.includes("/lang/") || normalized.includes("/translations/") || normalized.includes("/localization/")) {
      score -= 20;
    }

    if (content.includes("x-lang") || content.includes("accept-language")) {
      score += 28;
    }

    if (content.includes("request->header") || content.includes("headers->get") || content.includes("header(")) {
      score += 18;
    }

    if (content.includes("setlocale") || content.includes("app()->setlocale") || content.includes("set_locale")) {
      score += 22;
    }

    if (content.includes("fallback_locale") || content.includes("default_locale") || content.includes("config('app.locale") || content.includes("config(\"app.locale")) {
      score += 18;
    }

    if (score > 0) {
      ranked.set(file.relativePath, score);
    }
  }

  for (const node of runtimeNodes) {
    const key = node.filePath ? `${node.filePath}#${node.label}` : node.label;
    let score = 20;
    const label = node.label.toLowerCase();
    const filePath = (node.filePath ?? "").toLowerCase();

    if (label.includes("locale") || label.includes("language")) {
      score += 16;
    }

    if (label.includes("middleware") || filePath.includes("/middleware/")) {
      score += 14;
    }

    if (filePath.includes("/config/")) {
      score += 10;
    }

    ranked.set(key, (ranked.get(key) ?? 0) + score);
  }

  for (const edge of runtimeEdges) {
    const sourceFilePath = String(edge.metadata?.sourceFilePath ?? "");
    const semantic = String(edge.metadata?.semantic ?? "").toLowerCase();
    const header = String(edge.metadata?.header ?? "").toLowerCase();
    const configKey = String(edge.metadata?.configKey ?? "").toLowerCase();

    if (!sourceFilePath) {
      continue;
    }

    let score = 18;

    if (semantic === "request-header") {
      score += header.includes("lang") || header.includes("locale") ? 18 : 10;
    }

    if (semantic === "locale-set") {
      score += 20;
    }

    if (semantic === "locale-config") {
      score += configKey.includes("locale") ? 16 : 8;
    }

    ranked.set(sourceFilePath, (ranked.get(sourceFilePath) ?? 0) + score);
  }

  return [...ranked.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 8)
    .map(([label]) => label);
}

function detectBillingEntryPoints(input: ResearchInput): string[] {
  const ranked = new Map<string, number>();

  for (const file of input.workspace.files) {
    const normalized = file.relativePath.toLowerCase();
    let score = 0;

    if (normalized.includes("/billing/")) {
      score += 8;
    }

    if (
      normalized.includes("billcontroller")
      || normalized.includes("routeprovider")
      || normalized.includes("togeneratedbillaction")
      || normalized.includes("todraftbillaction")
    ) {
      score += 14;
    }

    if (normalized.includes("billhistory") || normalized.includes("billmodel") || normalized.endsWith("/bill.php")) {
      score += 10;
    }

    if (score > 0) {
      ranked.set(file.relativePath, score);
    }
  }

  for (const routeNode of getRouteNodes(input.graph)) {
    const label = routeNode.label.toLowerCase();

    if (label.includes("rollback") || label.includes("bill")) {
      const routeTargets = getEntryPointNeighbors(input.graph, routeNode.id)
        .map((neighbor) => neighbor.label)
        .slice(0, 2);
      const routeLabel = routeTargets.length > 0 ? `${routeNode.label} -> ${routeTargets.join(", ")}` : routeNode.label;
      ranked.set(routeLabel, (ranked.get(routeLabel) ?? 0) + 24);
    }
  }

  return [...ranked.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 6)
    .map(([label]) => label);
}

function detectLocalizationCodes(input: ResearchInput): string[] {
  const codes = new Set<string>();

  for (const file of input.workspace.files) {
    const normalized = file.relativePath.toLowerCase();

    if (!isLocalizationPath(normalized)) {
      continue;
    }

    const localeBucket = deriveLocalizationBucket(file.relativePath);

    if (localeBucket) {
      codes.add(localeBucket);
    }
  }

  return [...codes].sort();
}

function detectConfigEntryPoints(input: ResearchInput): string[] {
  const files = input.workspace.files
    .filter((file) => isConfigPath(file.relativePath.toLowerCase()))
    .map((file) => file.relativePath);

  return files.slice(0, 8);
}

function detectConfigFiles(input: ResearchInput): string[] {
  return input.workspace.files
    .filter((file) => isConfigPath(file.relativePath.toLowerCase()))
    .map((file) => file.relativePath)
    .slice(0, 12);
}

function detectEnvKeys(input: ResearchInput): string[] {
  const keys = new Set<string>();
  const envPattern = /env\(\s*['"]([A-Z0-9_]+)['"]/g;

  for (const file of input.workspace.files) {
    const content = file.content;
    let match: RegExpExecArray | null;

    while ((match = envPattern.exec(content)) !== null) {
      if (match[1]) {
        keys.add(match[1]);
      }
    }
  }

  return [...keys].sort();
}


function hasSpecificIntentSignal(tokens: string[]): boolean {
  return INTENT_PROFILES.some((profile) =>
    profile.aliases.some((alias) => tokens.some((token) => token.includes(alias) || alias.includes(token))),
  );
}

function deriveBroadEntryPoints(input: ResearchInput, topFiles: string[]): string[] {
  const candidates = [
    ...topFiles,
    ...input.workspace.files
      .filter((file) =>
        file.relativePath.startsWith("routes/")
        || file.relativePath.startsWith("config/")
        || file.relativePath.startsWith("lang/")
      )
      .map((file) => file.relativePath),
  ];

  return candidates.filter((value, index, list) => list.indexOf(value) === index).slice(0, 8);
}
