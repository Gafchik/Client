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
import { questionClassifier, ClassificationResult } from "./question-classifier.js";
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
  type ProjectFact,
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
  /** Факты, накопленные Fact Store для этого проекта (см. packages/knowledge/src/facts.ts). */
  knownFacts?: ProjectFact[];
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
  {
    key: "model-schema",
    aliases: [
      "model",
      "models",
      "schema",
      "schemas",
      "entity",
      "entities",
      "field",
      "fields",
      "column",
      "columns",
      "attribute",
      "attributes",
      "property",
      "properties",
      "relation",
      "relations",
      "relationship",
      "relationships",
      "belongsTo",
      "hasMany",
      "hasOne",
      "morphMany",
      "morphOne",
      "модель",
      "модели",
      "схема",
      "схемы",
      "сущность",
      "сущности",
      "поле",
      "поля",
      "колонка",
      "колонки",
      "атрибут",
      "атрибуты",
      "свойство",
      "свойства",
      "отношение",
      "отношения",
    ],
  },
  {
    key: "auth-inventory",
    aliases: [
      "google",
      "oauth",
      "socialite",
      "provider",
      "providers",
      "google-auth",
      "googleauth",
      "google-authentication",
      "google-авторизация",
      "google-аутентификация",
      "гугл",
      "гугл-авторизация",
      "гугл-аутентификация",
      "google-логин",
      "google-вход",
    ],
  },
  {
    key: "websocket-inventory",
    aliases: [
      "websocket",
      "websockets",
      "ws",
      "socket",
      "sockets",
      "realtime",
      "real-time",
      "pusher",
      "laravel-echo",
      "echo",
      "broadcast",
      "broadcasting",
      "channel",
      "channels",
      "вебсокет",
      "вебсокеты",
      "сокет",
      "сокеты",
      "реалтайм",
      "реал-тайм",
      "пушер",
      "эхо",
      " бродкаст",
      " бродкастинг",
      "канал",
      "каналы",
    ],
  },
  {
    key: "redis-inventory",
    aliases: [
      "redis",
      "cache",
      "caching",
      "session",
      "sessions",
      "queue",
      "queues",
      "job",
      "jobs",
      "worker",
      "workers",
      "редис",
      "кэш",
      "кэширование",
      "сессия",
      "сессии",
      "очередь",
      "очереди",
      "джоб",
      "джобы",
      "воркер",
      "воркеры",
    ],
  },
];

interface ResearchContext {
  tokens: string[];
  classification: ClassificationResult;
  routing: ResearchRoutingDecision;
  broadFocus: boolean;
  infrastructureFocus: boolean;
  localizationInventoryFocus: boolean;
  localizationBehaviorFocus: boolean;
  billingRollbackFocus: boolean;
  configFocus: boolean;
  modelSchemaFocus: boolean;
  authInventoryFocus: boolean;
  websocketInventoryFocus: boolean;
  redisInventoryFocus: boolean;
}

export function runResearch(input: ResearchInput): ResearchReport {
  const tokens = expandTaskTokens(input.task);
  const task = tokens.join(" ");
  const classification = questionClassifier.classify(task);
  const routing = mapClassificationToRouting(classification);
  const broadFocus = routing.intentClass === "broad-unknown";
  const infrastructureFocus = isInfrastructureQuestion(tokens);
  const localizationInventoryFocus = isLocalizationInventoryQuestion(tokens);
  const localizationBehaviorFocus = isLocalizationBehaviorQuestion(tokens);
  const billingRollbackFocus = isBillingRollbackQuestion(tokens);
  const configFocus = isConfigQuestion(tokens);
  const modelSchemaFocus = isModelSchemaQuestion(tokens);
  const authInventoryFocus = isAuthInventoryQuestion(tokens);
  const websocketInventoryFocus = isWebsocketInventoryQuestion(tokens);
  const redisInventoryFocus = isRedisInventoryQuestion(tokens);

  const ctx: ResearchContext = {
    tokens,
    classification,
    routing,
    broadFocus,
    infrastructureFocus,
    localizationInventoryFocus,
    localizationBehaviorFocus,
    billingRollbackFocus,
    configFocus,
    modelSchemaFocus,
    authInventoryFocus,
    websocketInventoryFocus,
    redisInventoryFocus,
  };

  const fileEvidence: ScoredReference[] = [];
  const symbolEvidence: ScoredReference[] = [];
  const moduleIntents = detectModuleIntents(input, ctx);
  const dominantModule = ctx.broadFocus ? "не определён" : moduleIntents[0]?.module ?? "не определён";
  const functionalFocus = isFunctionalQuestion(ctx.tokens);
  const routeNodes = getRouteNodes(input.graph);
  const codeNodes = getCodeNodes(input.graph);
  const graphModules = getNodesByKind(input.graph, "module");
  const graphSeedNodes = getNodesForQueryProfile(
    input.graph,
    ctx.routing.queryProfileKey,
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
      getConfigFileBoost(file, configFocus, tokens) +
      getModelSchemaFileBoost(file, modelSchemaFocus, tokens) +
      getAuthInventoryFileBoost(file, authInventoryFocus, tokens) +
      getWebsocketInventoryFileBoost(file, websocketInventoryFocus, tokens) +
      getRedisInventoryFileBoost(file, redisInventoryFocus, tokens);

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
      getConfigSymbolBoost(symbol, configFocus, tokens) +
      getModelSchemaSymbolBoost(symbol, modelSchemaFocus, tokens) +
      getAuthInventorySymbolBoost(symbol, authInventoryFocus, tokens) +
      getWebsocketInventorySymbolBoost(symbol, websocketInventoryFocus, tokens) +
      getRedisInventorySymbolBoost(symbol, redisInventoryFocus, tokens);

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
      getConfigRoutePenalty(routeNode.filePath ?? "", configFocus) +
      getModelSchemaRoutePenalty(routeNode.filePath ?? "", modelSchemaFocus) +
      getAuthInventoryRoutePenalty(routeNode.filePath ?? "", authInventoryFocus) +
      getWebsocketInventoryRoutePenalty(routeNode.filePath ?? "", websocketInventoryFocus) +
      getRedisInventoryRoutePenalty(routeNode.filePath ?? "", redisInventoryFocus);

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

  let evidence = [...fileEvidence, ...symbolEvidence]
    .sort((left, right) => right.score - left.score)
    .slice(0, 12)
    .map((item) => classifyReferenceOrigin(item, input));

  // Bolt-on Fact Store стадия — строго после classifyReferenceOrigin (иначе
  // backfill-элементы получили бы origin "baseline" вместо "recalled") и до
  // любых нижестоящих вычислений (findings/confidence/evidenceSummary их
  // автоматически подхватывают, т.к. читают `evidence` дальше по функции).
  const factApplication = applyKnownFacts(evidence, input.knownFacts, dominantModule);
  evidence = factApplication.evidence;

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
  const entryPoints = detectEntryPoints(input, topFiles, routeNodes, dominantModule, ctx);
  const primaryEntities = detectPrimaryEntities(input, topFiles, codeNodes, ctx);
  const sideEffects = detectSideEffects(input, ctx);
  const dataSources = detectDataSources(input, ctx);
  const affectedModules = deriveAffectedModules(moduleIntents, dominantModule, graphRelatedModules, topFiles, entryPoints);
  const functionalSummary = buildFunctionalSummary(input, affectedModules, dominantModule, moduleIntents, entryPoints, primaryEntities, sideEffects, dataSources, ctx);
  const findings = buildFindings(input, evidence, moduleIntents, dominantModule, strongGraphSeed, ctx);
  const baselineFindings = buildBaselineFindings(input, evidence, strongGraphSeed);
  const overlayFindings = buildOverlayFindings(input, evidence);
  const unknowns = buildUnknowns(input, evidence, moduleIntents, entryPoints, sideEffects, dataSources, strongGraphSeed);
  const confidence = computeConfidence(input, evidence, unknowns, ctx, factApplication.reinforcedCount);
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

/**
 * Bolt-on интеграция Fact Store в уже собранный evidence-список (после
 * classifyReferenceOrigin). Две независимые операции:
 *  - reinforcement: если уже найденный evidence-элемент подтверждён известным
 *    фактом (совпадение по filePath) — небольшой score-бонус + пометка.
 *  - backfill: если сканирование этого прохода дало мало evidence (< 4) и
 *    есть релевантные (той же категории, ещё валидные) факты — добавить их
 *    как evidence с origin "recalled", т.е. явно "не подтверждено текущим
 *    git-состоянием, а вспомнено из предыдущего исследования".
 * Объединённый список пересортирован по score — downstream-срезы (top-8/6 в
 * packages/ai) читают его дальше без знания об источнике элементов.
 */
function applyKnownFacts(
  evidence: ScoredReference[],
  knownFacts: ProjectFact[] | undefined,
  dominantModule: string,
): { evidence: ScoredReference[]; reinforcedCount: number } {
  if (!knownFacts || knownFacts.length === 0) {
    return { evidence, reinforcedCount: 0 };
  }

  const factsByFilePath = new Map<string, ProjectFact[]>();

  for (const fact of knownFacts) {
    for (const filePath of fact.filePaths) {
      const bucket = factsByFilePath.get(filePath) ?? [];
      bucket.push(fact);
      factsByFilePath.set(filePath, bucket);
    }
  }

  let reinforcedCount = 0;
  const reinforced = evidence.map((item) => {
    const matchingFacts = item.filePath ? factsByFilePath.get(item.filePath) : undefined;

    if (!matchingFacts || matchingFacts.length === 0) {
      return item;
    }

    reinforcedCount += 1;

    return {
      ...item,
      score: item.score + 6,
      reinforcedByFactIds: matchingFacts.map((fact) => fact.id),
    };
  });

  const matchedFilePaths = new Set(
    reinforced.filter((item) => item.filePath).map((item) => item.filePath as string),
  );
  const backfill: ScoredReference[] = [];

  if (reinforced.length < 4) {
    const relevantFacts = knownFacts.filter(
      (fact) =>
        fact.category === dominantModule
        && fact.status !== "deprecated"
        && fact.filePaths.some((filePath) => !matchedFilePaths.has(filePath)),
    );

    for (const fact of relevantFacts) {
      if (backfill.length >= 3) {
        break;
      }

      const filePath = fact.filePaths.find((path) => !matchedFilePaths.has(path));

      if (!filePath) {
        continue;
      }

      matchedFilePaths.add(filePath);
      backfill.push({
        id: fact.id,
        label: fact.category,
        score: Math.max(20, Math.min(fact.confidence, 60)),
        reason: `Известно из предыдущего исследования: ${fact.statement}`,
        filePath,
        origin: "recalled",
        reinforcedByFactIds: [fact.id],
      });
    }
  }

  return {
    evidence: [...reinforced, ...backfill].sort((left, right) => right.score - left.score),
    reinforcedCount,
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
  const recalledCount = evidence.filter((item) => item.origin === "recalled").length;

  return {
    baselineCount,
    overlayCount,
    structuralCount,
    recalledCount,
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

function mapClassificationToRouting(classification: ClassificationResult): ResearchRoutingDecision {
  const { questionType, searchProfiles, contextKeys } = classification;
  
  // Primary profile is the first one
  const primaryProfile = searchProfiles[0] ?? "broad-scan";
  
  // Map question type to intentClass
  const intentClassMap: Record<string, ResearchIntentClass> = {
    "existence": "inventory-config",
    "schema": "model-schema",
    "location": "broad-unknown",
    "flow": "functional-flow",
    "configuration": "inventory-config",
    "inventory": "inventory-config",
    "impact": "functional-flow",
    "why": "broad-unknown",
    "comparison": "broad-unknown",
    "fix": "functional-flow",
    "history": "broad-unknown",
    "unknown": "broad-unknown",
  };
  
  // Map question type to strategyKey
  const strategyKeyMap: Record<string, ResearchStrategyKey> = {
    "existence": "graph-config-inventory",
    "schema": "graph-storage-structure",
    "location": "broad-repository-scan",
    "flow": "graph-functional-entrypoints",
    "configuration": "graph-config-inventory",
    "inventory": "graph-config-inventory",
    "impact": "graph-functional-entrypoints",
    "why": "broad-repository-scan",
    "comparison": "broad-repository-scan",
    "fix": "graph-functional-entrypoints",
    "history": "broad-repository-scan",
    "unknown": "broad-repository-scan",
  };
  
  // Special handling for specific context keys - SPECIFIC intents first (priority order)
  
  // model-schema: check for model/schema/entity context keys
  if (contextKeys.includes("model") || contextKeys.includes("schema") || contextKeys.includes("entity") || contextKeys.includes("field") || contextKeys.includes("column") || contextKeys.includes("attribute") || contextKeys.includes("property") || contextKeys.includes("relation")) {
    if (questionType === "schema" || questionType === "existence" || questionType === "inventory") {
      return {
        intentClass: "model-schema",
        strategyKey: "graph-storage-structure",
        queryProfileKey: "storage-topology",
      };
    }
  }
  
  // auth-inventory: check for google/oauth/socialite/provider context keys
  if (contextKeys.includes("google") || contextKeys.includes("oauth") || contextKeys.includes("socialite") || contextKeys.includes("provider")) {
    if (questionType === "inventory" || questionType === "existence" || questionType === "configuration") {
      return {
        intentClass: "auth-inventory",
        strategyKey: "graph-config-inventory",
        queryProfileKey: "config-inventory",
      };
    }
  }
  
  // websocket-inventory: check for websocket/realtime/broadcast context keys
  if (contextKeys.includes("websocket") || contextKeys.includes("realtime") || contextKeys.includes("broadcast") || contextKeys.includes("pusher") || contextKeys.includes("echo") || contextKeys.includes("channel")) {
    if (questionType === "inventory" || questionType === "existence" || questionType === "configuration") {
      return {
        intentClass: "websocket-inventory",
        strategyKey: "graph-config-inventory",
        queryProfileKey: "config-inventory",
      };
    }
    if (questionType === "flow" || questionType === "why") {
      return {
        intentClass: "functional-flow",
        strategyKey: "graph-functional-entrypoints",
        queryProfileKey: "entrypoint-traversal",
      };
    }
  }
  
  // redis-inventory: check for redis/cache/queue/session context keys
  if (contextKeys.includes("redis") || contextKeys.includes("cache") || contextKeys.includes("queue") || contextKeys.includes("session") || contextKeys.includes("job") || contextKeys.includes("worker")) {
    if (questionType === "inventory" || questionType === "existence" || questionType === "configuration") {
      return {
        intentClass: "redis-inventory",
        strategyKey: "graph-storage-structure",
        queryProfileKey: "storage-topology",
      };
    }
    if (questionType === "flow" || questionType === "why") {
      return {
        intentClass: "functional-flow",
        strategyKey: "graph-functional-entrypoints",
        queryProfileKey: "entrypoint-traversal",
      };
    }
  }
  
  // localization: existing logic
  if (contextKeys.includes("localization") || contextKeys.includes("locale") || contextKeys.includes("translation") || contextKeys.includes("i18n")) {
    if (questionType === "inventory") {
      return {
        intentClass: "inventory-localization",
        strategyKey: "graph-localization-inventory",
        queryProfileKey: "localization-inventory",
      };
    }
    if (questionType === "flow" || questionType === "why") {
      return {
        intentClass: "functional-flow",
        strategyKey: "graph-functional-entrypoints",
        queryProfileKey: "entrypoint-traversal",
      };
    }
  }
  
  // billing: existing logic
  if (contextKeys.includes("billing") || contextKeys.includes("bill") || contextKeys.includes("payment")) {
    if (questionType === "flow" || questionType === "fix") {
      return {
        intentClass: "functional-flow",
        strategyKey: "graph-functional-entrypoints",
        queryProfileKey: "entrypoint-traversal",
      };
    }
  }
  
  // why + domain context → functional-flow
  if (questionType === "why") {
    if (contextKeys.includes("auth") || contextKeys.includes("oauth") || contextKeys.includes("login") || contextKeys.includes("provider") || contextKeys.includes("socialite")) {
      return {
        intentClass: "functional-flow",
        strategyKey: "graph-functional-entrypoints",
        queryProfileKey: "entrypoint-traversal",
      };
    }
    if (contextKeys.includes("redis") || contextKeys.includes("cache") || contextKeys.includes("queue") || contextKeys.includes("session")) {
      return {
        intentClass: "functional-flow",
        strategyKey: "graph-functional-entrypoints",
        queryProfileKey: "entrypoint-traversal",
      };
    }
    if (contextKeys.includes("websocket") || contextKeys.includes("broadcast") || contextKeys.includes("realtime")) {
      return {
        intentClass: "functional-flow",
        strategyKey: "graph-functional-entrypoints",
        queryProfileKey: "entrypoint-traversal",
      };
    }
    if (contextKeys.includes("database") || contextKeys.includes("model") || contextKeys.includes("storage") || contextKeys.includes("db")) {
      return {
        intentClass: "functional-flow",
        strategyKey: "graph-functional-entrypoints",
        queryProfileKey: "entrypoint-traversal",
      };
    }
  }
  
  return {
    intentClass: intentClassMap[questionType] ?? "broad-unknown",
    strategyKey: strategyKeyMap[questionType] ?? "broad-repository-scan",
    queryProfileKey: primaryProfile,
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
  ctx: ResearchContext,
): string {
  const broadFocus = ctx.routing.intentClass === "broad-unknown";
  const isWhyQuestion = ctx.classification.questionType === "why";
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

  if (ctx.localizationBehaviorFocus) {
    return `По текущему исследованию задача "${input.task}" относится к runtime-поведению локализации, а не к inventory переводов. Основные точки входа: ${entryPointText}. Вероятные сущности, влияющие на выбор локали: ${entityText}. Главный подтверждённый operational signal: ${sideEffectText}. Основной источник данных для выбора локали: ${dataSourceText}. Система должна проверять middleware, request headers, config fallback и места, где locale устанавливается в жизненном цикле запроса.`;
  }

  if (ctx.billingRollbackFocus) {
    return `По текущему исследованию задача "${input.task}" относится к runtime-поведению rollback bill и проверкам истории статусов. Основные точки входа: ${entryPointText}. Ключевые сущности перехода: ${entityText}. Главный подтверждённый operational signal: ${sideEffectText}. Основной источник данных для решения о rollback: ${dataSourceText}. Система должна проверять controller/action flow, bill history relations, вычисляемые rollback guards и создание новых BillHistory при смене статуса.`;
  }

  if (ctx.localizationInventoryFocus) {
    const localeCodes = detectLocalizationCodes(input);
    return `По текущему исследованию задача "${input.task}" больше всего связана с ${moduleText}. В проекте обнаружено ${localeCodes.length} языков локализации: ${localeCodes.join(", ") || "не удалось определить"}. Основные точки хранения: ${entryPointText}. Ключевые сущности локализации: ${entityText}. Главный подтверждённый i18n signal: ${sideEffectText}. Основной источник локализационных данных: ${dataSourceText}.`;
  }

  if (ctx.configFocus) {
    const configFiles = detectConfigFiles(input);
    const envKeys = detectEnvKeys(input);
    if (isWhyQuestion) {
      return `По текущему исследованию вопрос "${input.task}" требует объяснения причин конфигурации. Обнаружены ${configFiles.length} конфигурационных файлов и ${envKeys.length} env-сигналов в зоне ${moduleText}. Ключевые конфигурационные сущности: ${entityText}. Найденные настройки: ${configFiles.slice(0, 3).join(", ")}. Основной источник конфигурационных данных: ${dataSourceText}. Анализ показывает выбранные параметры и их значения в конфигурации.`;
    }
    return `По текущему исследованию задача "${input.task}" больше всего связана с ${moduleText}. Основные точки хранения конфигурации: ${entryPointText}. Найдено ${configFiles.length} ключевых config-файлов и ${envKeys.length} env-сигналов. Ключевые конфигурационные сущности: ${entityText}. Главный подтверждённый config signal: ${sideEffectText}. Основной источник конфигурационных данных: ${dataSourceText}.`;
  }

  if (ctx.infrastructureFocus) {
    if (isWhyQuestion) {
      return `По текущему исследованию вопрос "${input.task}" требует объяснения причин выбора инфраструктуры. Обнаружена зона ${moduleText} (${dominantModule}). Основные точки входа: ${entryPointText}. Ключевые сущности: ${entityText}. Найденные инфраструктурные решения: ${sideEffectText}. Основной источник данных: ${dataSourceText}. Анализ показывает выбранные технологии и их конфигурацию.`;
    }
    return `По текущему исследованию задача "${input.task}" больше всего связана с ${moduleText}. Наиболее вероятная зона хранения: ${dominantModule}. Основные точки входа и операции: ${entryPointText}. Ключевые сущности хранения: ${entityText}. Главный подтверждённый infrastructure signal: ${sideEffectText}. Основной источник данных и секретов: ${dataSourceText}.`;
  }

  if (isWhyQuestion) {
    return `По текущему исследованию вопрос "${input.task}" требует объяснения причин архитектурного выбора. Задача связана с ${moduleText}. ${intentText} Основные точки входа: ${entryPointText}. Ключевые сущности: ${entityText}. Найденные архитектурные решения: ${sideEffectText}. Основной источник данных: ${dataSourceText}. Анализ показывает зависимости, ограничения и выбранные паттерны в коде.`;
  }

  return `По текущему исследованию задача "${input.task}" больше всего связана с ${moduleText}. ${intentText} Основные точки входа: ${entryPointText}. Ключевые сущности: ${entityText}. Главный подтверждённый operational signal: ${sideEffectText}. Основной источник данных: ${dataSourceText}.`;
}

function buildFindings(
  input: ResearchInput,
  evidence: ScoredReference[],
  moduleIntents: ModuleIntentMatch[],
  dominantModule: string,
  strongGraphSeed: boolean,
  ctx: ResearchContext,
): string[] {
  if (evidence.length === 0) {
    return [
      `Задача "${input.task}" слабо пересекается с текущими индексированными файлами, поэтому отчёт опирается на общий контекст проекта.`,
      "Первый срез всё ещё может быть выполнен, но человеку стоит проверить, соответствует ли формулировка задачи терминологии репозитория.",
    ];
  }

  const isWhyQuestion = ctx.classification.questionType === "why";
  const topLabels = evidence.slice(0, 3).map((item) => item.label);
  const moduleRelationSummary =
    dominantModule !== "не определён" ? getModuleRelationSummary(input.graph, dominantModule).slice(0, 3) : [];
  const broadFocus = ctx.routing.intentClass === "broad-unknown";

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

  if (ctx.localizationBehaviorFocus) {
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

  if (ctx.billingRollbackFocus) {
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

  if (ctx.localizationInventoryFocus) {
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

  if (ctx.configFocus) {
    const configFiles = detectConfigFiles(input);
    const envKeys = detectEnvKeys(input);
    const findings = [
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
    if (isWhyQuestion) {
      findings.push("Для why-вопроса приоритет отдан конфигурационным значениям, провайдерам и документации, объясняющим выбор параметров.");
    }
    return findings;
  }

  if (ctx.infrastructureFocus) {
    const findings = [
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
    if (isWhyQuestion) {
      findings.push("Для why-вопроса приоритет отдан сервис-провайдерам, архитектурным границам и зависимостям, объясняющим выбор технологии.");
    }
    return findings;
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

function detectModuleIntents(input: ResearchInput, ctx: ResearchContext): ModuleIntentMatch[] {
  const tokens = ctx.tokens;
  const infrastructureFocus = ctx.infrastructureFocus;
  const localizationInventoryFocus = ctx.localizationInventoryFocus;
  const localizationBehaviorFocus = ctx.localizationBehaviorFocus;
  const configFocus = ctx.configFocus;
  const symbolHaystacks = new Map<string, string>();

  for (const symbol of input.index.symbols) {
    const current = symbolHaystacks.get(symbol.filePath) ?? "";
    const label = `${symbol.containerName ? `${symbol.containerName}.` : ""}${symbol.name}`.toLowerCase();
    symbolHaystacks.set(symbol.filePath, `${current} ${label}`.trim());
  }

  return INTENT_PROFILES.map((profile) => {
    const taskMentionsDomain = profile.aliases.some((alias) => tokens.some((token) => isMeaningfulAliasMatch(token, alias)));
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
  ctx: ResearchContext,
): string[] {
  const isWhyQuestion = ctx.classification.questionType === "why";

  if (ctx.localizationBehaviorFocus) {
    return detectLocalizationRuntimeEntryPoints(input).slice(0, 6);
  }

  if (ctx.billingRollbackFocus) {
    return detectBillingEntryPoints(input).slice(0, 6);
  }

  if (ctx.routing.intentClass === "broad-unknown") {
    return deriveBroadEntryPoints(input, topFiles).slice(0, 6);
  }

  if (ctx.localizationInventoryFocus) {
    return detectLocalizationEntryPoints(input).slice(0, 6);
  }

  if (ctx.configFocus) {
    return detectConfigEntryPoints(input).slice(0, 6);
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

    if (ctx.infrastructureFocus && normalized.includes("/servers/")) {
      score += 6;
    }

    if (ctx.infrastructureFocus && normalized.includes("/vault/")) {
      score += 4;
    }

    // Why-question: boost providers, services, config, events
    if (isWhyQuestion) {
      if (normalized.includes("/providers/") || normalized.includes("provider")) {
        score += 8;
      }
      if (normalized.includes("/services/") || normalized.includes("/service")) {
        score += 8;
      }
      if (normalized.includes("/config/") || normalized.includes("config")) {
        score += 6;
      }
      if (normalized.includes("/events/") || normalized.includes("/listeners/") || normalized.includes("event")) {
        score += 6;
      }
      if (normalized.includes("/bootstrap/") || normalized.includes("bootstrap")) {
        score += 5;
      }
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
      ctx.infrastructureFocus
      && ["store", "update", "delete", "createserver", "updateserver"].includes(name)
      && symbol.filePath.toLowerCase().includes("server")
    ) {
      ranked.set(`${symbol.filePath}#${symbol.name}`, (ranked.get(`${symbol.filePath}#${symbol.name}`) ?? 0) + 8);
    }

    // Why-question: boost providers, services, config, events symbols
    if (isWhyQuestion) {
      if (name.includes("provider") || name.includes("service") || name.includes("config") || name.includes("event") || name.includes("listener")) {
        ranked.set(`${symbol.filePath}#${symbol.name}`, (ranked.get(`${symbol.filePath}#${symbol.name}`) ?? 0) + 5);
      }
    }
  }

  for (const routeNode of combinedRoutes) {
    const routeScore = scoreText(routeNode.label, ctx.tokens) * 6 + 4;

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

function detectPrimaryEntities(input: ResearchInput, topFiles: string[], codeNodes: GraphState["nodes"], ctx: ResearchContext): string[] {
  const broadFocus = ctx.routing.intentClass === "broad-unknown";
  const localizationInventoryFocus = ctx.localizationInventoryFocus;
  const localizationBehaviorFocus = ctx.localizationBehaviorFocus;
  const billingRollbackFocus = ctx.billingRollbackFocus;
  const configFocus = ctx.configFocus;
  const infrastructureFocus = ctx.infrastructureFocus;

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

      if (ctx.infrastructureFocus && isInfrastructureEntity(node)) {
        return true;
      }

      return isPrimaryEntityKind(node.kind);
    })
    .sort((left, right) => {
      const leftRouteWeight = ctx.infrastructureFocus
        ? getInfrastructureEntityWeight(left)
        : left.kind === "route" ? 2 : left.kind === "method" ? 1 : 0;
      const rightRouteWeight = ctx.infrastructureFocus
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

function detectSideEffects(input: ResearchInput, ctx: ResearchContext): string[] {
  const effects = new Set<string>();
  const infrastructureFocus = ctx.infrastructureFocus;
  const localizationInventoryFocus = ctx.localizationInventoryFocus;
  const localizationBehaviorFocus = ctx.localizationBehaviorFocus;
  const billingRollbackFocus = ctx.billingRollbackFocus;
  const configFocus = ctx.configFocus;

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

function detectDataSources(input: ResearchInput, ctx: ResearchContext): string[] {
  const sources = new Set<string>();
  const infrastructureFocus = ctx.infrastructureFocus;
  const localizationInventoryFocus = ctx.localizationInventoryFocus;
  const localizationBehaviorFocus = ctx.localizationBehaviorFocus;
  const billingRollbackFocus = ctx.billingRollbackFocus;
  const configFocus = ctx.configFocus;

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

/**
 * Короткие служебные слова (предлоги, союзы, местоимения), которые ни при
 * каких обстоятельствах не должны сами по себе матчиться как alias профиля.
 * Без этого фильтра, например, "при" (как в "При каких условиях...")
 * является substring'ом алиаса "приватный" (servers/vault профиль) и ложно
 * триггерит весь инфраструктурный профиль на вопросах, вообще не про
 * серверы/vault.
 */
const TOKEN_MATCH_STOPWORDS = new Set([
  "при", "из-за", "из", "за", "для", "под", "над", "про", "на", "по",
  "как", "что", "это", "эта", "эти", "этот", "эту", "если", "или", "либо",
  "так", "уже", "все", "всех", "всей", "всем", "всей", "куда", "когда",
  "чем", "чему", "чтобы", "то", "тот", "которая", "который", "которые",
  "the", "and", "for", "are", "but", "not", "you", "all", "can", "her",
  "was", "one", "our", "out", "his", "has", "had",
]);

/** Минимальная длина токена/alias'а для substring-матчинга (защита от false positive на коротких словах). */
const TOKEN_MATCH_MIN_SUBSTRING_LENGTH = 4;

function isMeaningfulAliasMatch(token: string, alias: string): boolean {
  if (TOKEN_MATCH_STOPWORDS.has(token) || TOKEN_MATCH_STOPWORDS.has(alias)) {
    return false;
  }

  if (token === alias) {
    return true;
  }

  if (token.length >= TOKEN_MATCH_MIN_SUBSTRING_LENGTH && alias.includes(token)) {
    return true;
  }

  if (alias.length >= TOKEN_MATCH_MIN_SUBSTRING_LENGTH && token.includes(alias)) {
    return true;
  }

  return false;
}

function expandTaskTokens(task: string): string[] {
  const baseTokens = tokenize(task);
  const expanded = new Set(baseTokens);

  for (const rawToken of task.split(/[^A-Za-z0-9_/-]+/).filter(Boolean)) {
    const splitTokens = rawToken
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .split(/[^A-Za-z0-9а-яё]+/i)
      .map((token) => token.trim().toLowerCase())
      .filter((token) => token.length >= 2);

    for (const token of splitTokens) {
      expanded.add(token);
    }
  }

  for (const token of baseTokens) {
    for (const profile of INTENT_PROFILES) {
      if (profile.aliases.some((alias) => isMeaningfulAliasMatch(token, alias))) {
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
      "where",
      "set",
      "sets",
      "выбирается",
      "выбора",
      "где",
      "задается",
      "задаётся",
      "устанавливается",
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

function isModelSchemaQuestion(tokens: string[]): boolean {
  return tokens.some((token) =>
    [
      "model",
      "models",
      "schema",
      "schemas",
      "entity",
      "entities",
      "field",
      "fields",
      "column",
      "columns",
      "attribute",
      "attributes",
      "property",
      "properties",
      "relation",
      "relations",
      "relationship",
      "relationships",
      "belongsTo",
      "hasMany",
      "hasOne",
      "morphMany",
      "morphOne",
      "модель",
      "модели",
      "схема",
      "схемы",
      "сущность",
      "сущности",
      "поле",
      "поля",
      "колонка",
      "колонки",
      "атрибут",
      "атрибуты",
      "свойство",
      "свойства",
      "отношение",
      "отношения",
    ].includes(token),
  );
}

function isAuthInventoryQuestion(tokens: string[]): boolean {
  return tokens.some((token) =>
    [
      "google",
      "oauth",
      "socialite",
      "provider",
      "providers",
      "google-auth",
      "googleauth",
      "google-authentication",
      "google-авторизация",
      "google-аутентификация",
      "гугл",
      "гугл-авторизация",
      "гугл-аутентификация",
      "google-логин",
      "google-вход",
    ].includes(token),
  );
}

function isWebsocketInventoryQuestion(tokens: string[]): boolean {
  return tokens.some((token) =>
    [
      "websocket",
      "websockets",
      "ws",
      "socket",
      "sockets",
      "realtime",
      "real-time",
      "pusher",
      "laravel-echo",
      "echo",
      "broadcast",
      "broadcasting",
      "channel",
      "channels",
      "вебсокет",
      "вебсокеты",
      "сокет",
      "сокеты",
      "реалтайм",
      "реал-тайм",
      "пушер",
      "эхо",
      " бродкаст",
      " бродкастинг",
      "канал",
      "каналы",
    ].includes(token),
  );
}

function isRedisInventoryQuestion(tokens: string[]): boolean {
  return tokens.some((token) =>
    [
      "redis",
      "cache",
      "caching",
      "session",
      "sessions",
      "queue",
      "queues",
      "job",
      "jobs",
      "worker",
      "workers",
      "редис",
      "кэш",
      "кэширование",
      "сессия",
      "сессии",
      "очередь",
      "очереди",
      "джоб",
      "джобы",
      "воркер",
      "воркеры",
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

  if (pathText.includes("/billing/bill/ui/api/controllers/") || pathText.includes("/billing/bill/ui/api/routes/")) {
    score += 52;
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

  if (pathText.includes("/acunotes/") || pathText.includes("/appointmenthistory/")) {
    score -= 48;
  }

  if (pathText.includes("/data/migrations/") || pathText.includes("migration")) {
    score -= 56;
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

  if (filePath.includes("/billing/bill/ui/api/controllers/") || filePath.includes("/billing/bill/ui/api/routes/")) {
    score += 34;
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

  if (filePath.includes("/acunotes/") || filePath.includes("/appointmenthistory/")) {
    score -= 44;
  }

  if (filePath.includes("/data/migrations/") || filePath.includes("migration")) {
    score -= 54;
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
  if (normalized.includes("/billing/bill/ui/api/routes/")) {
    return 42;
  }

  if (normalized.includes("/biller/") || normalized.includes("/acunotes/")) {
    return -36;
  }

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

  if (normalized.includes("/billing/bill/ui/api/controllers/") || normalized.includes("/billing/bill/ui/api/routes/")) {
    score += 44;
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

  if (normalized.includes("/acunotes/") || normalized.includes("/appointmenthistory/")) {
    score -= 48;
  }

  if (normalized.includes("/data/migrations/") || normalized.includes("migration")) {
    score -= 60;
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

  if (symbol.filePath.toLowerCase().includes("/billing/bill/ui/api/controllers/") || symbol.filePath.toLowerCase().includes("/billing/bill/ui/api/routes/")) {
    score += 32;
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

  if (symbol.filePath.toLowerCase().includes("/acunotes/") || symbol.filePath.toLowerCase().includes("/appointmenthistory/")) {
    score -= 44;
  }

  if (symbol.filePath.toLowerCase().includes("/data/migrations/") || symbol.filePath.toLowerCase().includes("migration")) {
    score -= 56;
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

function getModelSchemaFileBoost(
  file: WorkspaceSnapshot["files"][number],
  modelSchemaFocus: boolean,
  tokens: string[],
): number {
  if (!modelSchemaFocus) {
    return 0;
  }

  const pathText = file.relativePath.toLowerCase();
  const contentText = file.content.slice(0, 4000).toLowerCase();
  let score = 0;

  if (pathText.includes("/models/") || pathText.includes("/entities/") || pathText.includes("/schemas/")) {
    score += 50;
  }

  if (contentText.includes("belongsTo") || contentText.includes("hasMany") || contentText.includes("hasOne") || contentText.includes("morphMany") || contentText.includes("morphOne")) {
    score += 30;
  }

  if (contentText.includes("protected $fillable") || contentText.includes("protected $casts") || contentText.includes("protected $dates")) {
    score += 20;
  }

  if (pathText.includes("/migrations/")) {
    score -= 20;
  }

  if (tokens.some((token) => pathText.includes(token) || contentText.includes(token))) {
    score += 6;
  }

  return score;
}

function getModelSchemaSymbolBoost(
  symbol: IndexSymbol,
  modelSchemaFocus: boolean,
  tokens: string[],
): number {
  if (!modelSchemaFocus) {
    return 0;
  }

  const label = `${symbol.containerName ? `${symbol.containerName}.` : ""}${symbol.name}`.toLowerCase();
  const filePath = symbol.filePath.toLowerCase();
  let score = 0;

  if (filePath.includes("/models/") || filePath.includes("/entities/") || filePath.includes("/schemas/")) {
    score += 25;
  }

  if (label.includes("model") || label.includes("entity") || label.includes("schema") || label.includes("field") || label.includes("column") || label.includes("attribute") || label.includes("property") || label.includes("relation")) {
    score += 15;
  }

  if (label.includes("belongsto") || label.includes("hasmany") || label.includes("hasone") || label.includes("morphmany") || label.includes("morphone")) {
    score += 20;
  }

  if (symbol.kind === "class" || symbol.kind === "interface") {
    score += 10;
  }

  if (symbol.kind === "route" || symbol.kind === "method") {
    score -= 15;
  }

  if (tokens.some((token) => label.includes(token))) {
    score += 4;
  }

  return score;
}

function getModelSchemaRoutePenalty(filePath: string, modelSchemaFocus: boolean): number {
  if (!modelSchemaFocus) {
    return 0;
  }

  const normalized = filePath.toLowerCase();

  if (normalized.includes("/models/") || normalized.includes("/entities/") || normalized.includes("/schemas/")) {
    return 10;
  }

  if (normalized.includes("/routes/") || normalized.includes("/controllers/") || normalized.includes("/auth/")) {
    return -30;
  }

  return -5;
}

function getAuthInventoryFileBoost(
  file: WorkspaceSnapshot["files"][number],
  authInventoryFocus: boolean,
  tokens: string[],
): number {
  if (!authInventoryFocus) {
    return 0;
  }

  const pathText = file.relativePath.toLowerCase();
  const contentText = file.content.slice(0, 4000).toLowerCase();
  let score = 0;

  if (pathText.includes("/auth/") || pathText.includes("socialite") || pathText.includes("google")) {
    score += 50;
  }

  if (contentText.includes("socialite") || contentText.includes("google") || contentText.includes("oauth")) {
    score += 30;
  }

  if (contentText.includes("provider") || contentText.includes("providers")) {
    score += 20;
  }

  if (pathText.includes("/routes/") || pathText.includes("/controllers/")) {
    score -= 10;
  }

  if (tokens.some((token) => pathText.includes(token) || contentText.includes(token))) {
    score += 6;
  }

  return score;
}

function getAuthInventorySymbolBoost(
  symbol: IndexSymbol,
  authInventoryFocus: boolean,
  tokens: string[],
): number {
  if (!authInventoryFocus) {
    return 0;
  }

  const label = `${symbol.containerName ? `${symbol.containerName}.` : ""}${symbol.name}`.toLowerCase();
  const filePath = symbol.filePath.toLowerCase();
  let score = 0;

  if (filePath.includes("/auth/") || filePath.includes("socialite") || filePath.includes("google")) {
    score += 25;
  }

  if (label.includes("google") || label.includes("oauth") || label.includes("socialite") || label.includes("provider")) {
    score += 20;
  }

  if (symbol.kind === "route" || symbol.kind === "method") {
    score -= 10;
  }

  if (tokens.some((token) => label.includes(token))) {
    score += 4;
  }

  return score;
}

function getAuthInventoryRoutePenalty(filePath: string, authInventoryFocus: boolean): number {
  if (!authInventoryFocus) {
    return 0;
  }

  const normalized = filePath.toLowerCase();

  if (normalized.includes("/auth/") || normalized.includes("socialite") || normalized.includes("google")) {
    return 15;
  }

  if (normalized.includes("/billing/") || normalized.includes("/servers/") || normalized.includes("/vault/")) {
    return -20;
  }

  return -5;
}

function getWebsocketInventoryFileBoost(
  file: WorkspaceSnapshot["files"][number],
  websocketInventoryFocus: boolean,
  tokens: string[],
): number {
  if (!websocketInventoryFocus) {
    return 0;
  }

  const pathText = file.relativePath.toLowerCase();
  const contentText = file.content.slice(0, 4000).toLowerCase();
  let score = 0;

  if (pathText.includes("/websocket/") || pathText.includes("/websockets/") || pathText.includes("/broadcast/") || pathText.includes("/channels/") || pathText.includes("/echo/")) {
    score += 50;
  }

  if (contentText.includes("pusher") || contentText.includes("laravel-echo") || contentText.includes("broadcast") || contentText.includes("channel")) {
    score += 30;
  }

  if (contentText.includes("realtime") || contentText.includes("real-time") || contentText.includes("websocket")) {
    score += 20;
  }

  if (pathText.includes("/routes/") || pathText.includes("/controllers/")) {
    score -= 10;
  }

  if (tokens.some((token) => pathText.includes(token) || contentText.includes(token))) {
    score += 6;
  }

  return score;
}

function getWebsocketInventorySymbolBoost(
  symbol: IndexSymbol,
  websocketInventoryFocus: boolean,
  tokens: string[],
): number {
  if (!websocketInventoryFocus) {
    return 0;
  }

  const label = `${symbol.containerName ? `${symbol.containerName}.` : ""}${symbol.name}`.toLowerCase();
  const filePath = symbol.filePath.toLowerCase();
  let score = 0;

  if (filePath.includes("/websocket/") || filePath.includes("/websockets/") || filePath.includes("/broadcast/") || filePath.includes("/channels/") || filePath.includes("/echo/")) {
    score += 25;
  }

  if (label.includes("websocket") || label.includes("socket") || label.includes("pusher") || label.includes("echo") || label.includes("broadcast") || label.includes("channel")) {
    score += 20;
  }

  if (symbol.kind === "route" || symbol.kind === "method") {
    score -= 10;
  }

  if (tokens.some((token) => label.includes(token))) {
    score += 4;
  }

  return score;
}

function getWebsocketInventoryRoutePenalty(filePath: string, websocketInventoryFocus: boolean): number {
  if (!websocketInventoryFocus) {
    return 0;
  }

  const normalized = filePath.toLowerCase();

  if (normalized.includes("/websocket/") || normalized.includes("/websockets/") || normalized.includes("/broadcast/") || normalized.includes("/channels/") || normalized.includes("/echo/")) {
    return 15;
  }

  if (normalized.includes("/billing/") || normalized.includes("/servers/") || normalized.includes("/vault/")) {
    return -20;
  }

  return -5;
}

function getRedisInventoryFileBoost(
  file: WorkspaceSnapshot["files"][number],
  redisInventoryFocus: boolean,
  tokens: string[],
): number {
  if (!redisInventoryFocus) {
    return 0;
  }

  const pathText = file.relativePath.toLowerCase();
  const contentText = file.content.slice(0, 4000).toLowerCase();
  let score = 0;

  if (pathText.includes("/redis/") || pathText.includes("/cache/") || pathText.includes("/queue/") || pathText.includes("/jobs/") || pathText.includes("/workers/")) {
    score += 50;
  }

  if (contentText.includes("redis") || contentText.includes("cache") || contentText.includes("queue") || contentText.includes("job") || contentText.includes("worker")) {
    score += 30;
  }

  if (contentText.includes("session") || contentText.includes("sessions")) {
    score += 20;
  }

  if (pathText.includes("/routes/") || pathText.includes("/controllers/")) {
    score -= 10;
  }

  if (tokens.some((token) => pathText.includes(token) || contentText.includes(token))) {
    score += 6;
  }

  return score;
}

function getRedisInventorySymbolBoost(
  symbol: IndexSymbol,
  redisInventoryFocus: boolean,
  tokens: string[],
): number {
  if (!redisInventoryFocus) {
    return 0;
  }

  const label = `${symbol.containerName ? `${symbol.containerName}.` : ""}${symbol.name}`.toLowerCase();
  const filePath = symbol.filePath.toLowerCase();
  let score = 0;

  if (filePath.includes("/redis/") || filePath.includes("/cache/") || filePath.includes("/queue/") || filePath.includes("/jobs/") || filePath.includes("/workers/")) {
    score += 25;
  }

  if (label.includes("redis") || label.includes("cache") || label.includes("queue") || label.includes("job") || label.includes("worker") || label.includes("session")) {
    score += 20;
  }

  if (symbol.kind === "route" || symbol.kind === "method") {
    score -= 10;
  }

  if (tokens.some((token) => label.includes(token))) {
    score += 4;
  }

  return score;
}

function getRedisInventoryRoutePenalty(filePath: string, redisInventoryFocus: boolean): number {
  if (!redisInventoryFocus) {
    return 0;
  }

  const normalized = filePath.toLowerCase();

  if (normalized.includes("/redis/") || normalized.includes("/cache/") || normalized.includes("/queue/") || normalized.includes("/jobs/") || normalized.includes("/workers/")) {
    return 15;
  }

  if (normalized.includes("/billing/") || normalized.includes("/servers/") || normalized.includes("/vault/")) {
    return -20;
  }

  return -5;
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

function computeConfidence(
  input: ResearchInput,
  evidence: ScoredReference[],
  unknowns: string[],
  ctx: ResearchContext,
  reinforcedCount = 0,
): number {
  let confidence = 45;
  confidence += Math.min(evidence.length * 4, 30);
  confidence += Math.min(input.graph.summary.symbolCount / 10, 15);
  confidence -= unknowns.length * 8;
  confidence += Math.min(reinforcedCount * 3, 10);

  if (ctx.routing.intentClass === "broad-unknown") {
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

    if (content.includes("x-locale") || content.includes("x-lang") || content.includes("accept-language")) {
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

    if (normalized.includes("routeprovider")) {
      score += normalized.includes("/billing/bill/ui/api/routes/") ? 24 : 10;
    }

    if (normalized.includes("billcontroller")) {
      score += 28;
    }

    if (
      normalized.includes("togeneratedbillaction")
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

