/**
 * Question Classifier
 * 
 * Объединяет QuestionTypeRegistry и SearchProfileRegistry.
 * Определяет Question Type → выбирает Search Profile(s) → возвращает Search Plan.
 * 
 * Это ЗАМЕНАет старую classifyIntent() + buildInitialSearchPlan()
 */

import { 
  questionTypeRegistry, 
  registerBuiltinQuestionTypes,
  QuestionType,
  QuestionTypeConfig 
} from "./question-types.js";

import { 
  searchProfileRegistry, 
  registerBuiltinSearchProfiles,
  SearchProfileConfig,
  SearchGoal,
  ResearchQueryProfileKey 
} from "./search-profiles.js";

import { 
  WorkspaceSnapshot, 
  IndexResult, 
  GraphState, 
  RepositorySnapshot, 
  BackgroundProjectState 
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

/** Результат классификации */
export interface ClassificationResult {
  questionType: QuestionType;
  confidence: number;
  searchProfiles: ResearchQueryProfileKey[];
  searchGoals: SearchGoal[];
  reasoning: string;
  contextKeys: string[];
}

/** Классификатор вопросов */
export class QuestionClassifier {
  private initialized = false;

  /** Инициализация реестров */
  private ensureInitialized(): void {
    if (!this.initialized) {
      registerBuiltinQuestionTypes();
      registerBuiltinSearchProfiles();
      this.initialized = true;
    }
  }

  /** Основной метод: классификация вопроса и построение плана поиска */
  classify(question: string, input?: ResearchInput): ClassificationResult {
    this.ensureInitialized();

    // 1. Определяем Question Type
    const { type: questionType, confidence, matchedPattern } = questionTypeRegistry.classify(question);
    const typeConfig = questionTypeRegistry.get(questionType);

    // 2. Извлекаем контекстуальные ключи из вопроса
    const contextKeys = this.extractContextKeys(question, typeConfig);

    // 3. Определяем Search Profiles
    const searchProfiles = this.resolveSearchProfiles(questionType, contextKeys, typeConfig);

    // 4. Собираем Search Goals из профилей
    const searchGoals = this.collectSearchGoals(searchProfiles, contextKeys);

    // 5. Формируем reasoning
    const reasoning = this.buildReasoning(question, questionType, confidence, searchProfiles, contextKeys, matchedPattern);

    return {
      questionType,
      confidence,
      searchProfiles,
      searchGoals,
      reasoning,
      contextKeys,
    };
  }

  /** Извлечение контекстуальных ключей из вопроса */
  private extractContextKeys(question: string, typeConfig?: QuestionTypeConfig): string[] {
    const lower = question.toLowerCase();
    const keys = new Set<string>();

    // Ключи из contextualProfiles зарегистрированного типа
    if (typeConfig?.contextualProfiles) {
      for (const [key] of Object.entries(typeConfig.contextualProfiles)) {
        if (lower.includes(key.toLowerCase())) {
          keys.add(key);
        }
      }
    }

    // Общие доменные ключи
    const domainKeys = [
      "auth", "oauth", "provider", "login", "session", "token", "jwt", "passport", "socialite",
      "авторизация", "аутентификация", "логин", "вход", "токен", "сессия",
      "google", "github", "facebook", "microsoft",
      "redis", "cache", "caching", "session", "queue", "jobs", "horizon",
      "редис", "кэш", "очередь", "джоб", "воркер",
      "websocket", "realtime", "broadcast", "pusher", "laravel-echo", "socket",
      "вебсокет", "реалтайм", "бродкаст", "сокет",
      "mail", "email", "smtp", "notification",
      "search", "scout", "meilisearch", "algolia", "elasticsearch",
      "storage", "s3", "filesystem", "cdn",
      "хранилище", "файловая", "файловой",
      "model", "migration", "database", "db", "модель", "миграция", "база", "бд", "схема",
      "billing", "bill", "payment", "invoice",
      "биллинг", "платеж", "инвойс",
      "localization", "locale", "translation", "i18n", "lang", "локаль", "локализация", "перевод", "язык",
      "vault", "credential", "secret", "password", "секрет", "пароль", "креды", "ключ",
      "server", "ssh", "sftp", "host", "port", "username", "connection",
      "сервер", "серверу", "подключение", "подключения", "соединение", "соединения", "хост", "порт",
    ];

    for (const key of domainKeys) {
      if (lower.includes(key)) {
        keys.add(key);
      }
    }

    return [...keys];
  }

  /** Резолвинг Search Profiles на основе Question Type и контекста */
  private resolveSearchProfiles(
    questionType: QuestionType, 
    contextKeys: string[], 
    typeConfig?: QuestionTypeConfig
  ): ResearchQueryProfileKey[] {
    const profiles = new Set<ResearchQueryProfileKey>();

    // 1. Дефолтные профили для типа вопроса
    if (typeConfig?.defaultSearchProfiles) {
      for (const p of typeConfig.defaultSearchProfiles) {
        profiles.add(p);
      }
    }

    // 2. Контекстуальные профили (переопределяют/дополняют дефолтные)
    if (typeConfig?.contextualProfiles) {
      for (const [contextKey, profileKey] of Object.entries(typeConfig.contextualProfiles)) {
        if (contextKeys.includes(contextKey)) {
          profiles.add(profileKey);
        }
      }
    }

    // 3. Специфичные правила для известных комбинаций
    this.applySpecificRules(questionType, contextKeys, profiles);

    return [...profiles];
  }

  /** Специфичные правила для известных кейсов */
  private applySpecificRules(
    questionType: QuestionType, 
    contextKeys: string[], 
    profiles: Set<ResearchQueryProfileKey>
  ): void {
    // Google OAuth → config-inventory + entrypoint-traversal
    if (contextKeys.includes("google") && contextKeys.includes("oauth")) {
      profiles.add("config-inventory");
      profiles.add("entrypoint-traversal");
    }

    // Redis → config-inventory (cache, session, queue, database)
    if (contextKeys.includes("redis")) {
      profiles.add("config-inventory");
    }

    // WebSocket → config-inventory (broadcasting) + entrypoint-traversal (channels)
    if (contextKeys.includes("websocket") || contextKeys.includes("realtime") || contextKeys.includes("broadcast")) {
      profiles.add("config-inventory");
      profiles.add("entrypoint-traversal");
    }

    // Model schema → storage-topology
    if (questionType === "schema" && contextKeys.includes("model")) {
      profiles.add("storage-topology");
    }

    // Auth existence → entrypoint-traversal + config-inventory
    if (questionType === "existence" && contextKeys.includes("auth")) {
      profiles.add("entrypoint-traversal");
      profiles.add("config-inventory");
    }

    const storageContext =
      contextKeys.includes("server")
      || contextKeys.includes("ssh")
      || contextKeys.includes("vault")
      || contextKeys.includes("credential")
      || contextKeys.includes("host")
      || contextKeys.includes("port")
      || contextKeys.includes("connection");
    if (storageContext) {
      profiles.add("storage-topology");
    }
  }

  /** Сбор целей поиска из профилей */
  private collectSearchGoals(profiles: ResearchQueryProfileKey[], contextKeys: string[]): SearchGoal[] {
    const goals: SearchGoal[] = [];

    for (const profileKey of profiles) {
      const profileGoals = searchProfileRegistry.getGoalsForContext(profileKey, contextKeys);
      goals.push(...profileGoals);
    }

    // Дедупликация по id
    const seen = new Set<string>();
    return goals.filter(g => {
      if (seen.has(g.id)) return false;
      seen.add(g.id);
      return true;
    });
  }

  /** Построение reasoning для отладки */
  private buildReasoning(
    question: string,
    questionType: QuestionType,
    confidence: number,
    profiles: ResearchQueryProfileKey[],
    contextKeys: string[],
    matchedPattern?: any
  ): string {
    const parts = [
      `Question: "${question}"`,
      `Type: ${questionType} (confidence: ${(confidence * 100).toFixed(0)}%)`,
      `Context keys: ${contextKeys.join(", ") || "none"}`,
      `Search profiles: ${profiles.join(", ")}`,
    ];

    if (matchedPattern) {
      parts.push(`Matched pattern: ${matchedPattern.regex.source}`);
    }

    return parts.join(" | ");
  }
}

/** Singleton instance */
export const questionClassifier = new QuestionClassifier();
