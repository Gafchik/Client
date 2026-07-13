/**
 * Question Type Registry
 * 
 * Декларативная система классификации вопросов.
 * Новые типы добавляются через registerQuestionType(), без изменения кода.
 */

import { ResearchQueryProfileKey } from "@client/shared";

/** Типы вопросов — семантические категории */
export type QuestionType = 
  | "existence"       // "есть X?", "используется Y?", "is there X?"
  | "schema"          // "что хранит модель X?", "поля Y", "structure of Z"
  | "location"        // "где находится X?", "в каком файле Y?"
  | "flow"            // "как работает X?", "что происходит при Y?", "process of Z"
  | "configuration"   // "как настроен X?", "настройки Y", "config for Z"
  | "inventory"       // "что есть в X?", "список Y", "all Z"
  | "impact"          // "что сломается если X?", "зависит ли Y от Z?"
  | "why"             // "почему X?", "причина Y", "reason for Z"
  | "comparison"      // "разница X и Y", "лучше A или B", "vs"
  | "fix"             // "как исправить X?", "ошибка Y", "debug Z"
  | "history"         // "когда добавили X?", "кто менял Y?", "changelog Z"
  | "unknown";

/** Паттерн для матчинга вопроса */
export interface QuestionTypePattern {
  /** Регулярное выражение (case-insensitive) */
  regex: RegExp;
  /** Вес/приоритет паттерна (больше = важнее) */
  weight: number;
  /** Опционально: требуемые ключевые слова (ALL должны быть) */
  requiredKeywords?: string[];
  /** Опционально: исключающие ключевые слова (ANY исключает) */
  excludeKeywords?: string[];
}

/** Конфигурация типа вопроса */
export interface QuestionTypeConfig {
  type: QuestionType;
  /** Человекочитаемое название */
  label: string;
  /** Описание для отладки */
  description: string;
  /** Паттерны матчинга (порядок важен: первый подходящий с максимальным весом) */
  patterns: QuestionTypePattern[];
  /** Дефолтные search profiles для этого типа вопроса */
  defaultSearchProfiles: ResearchQueryProfileKey[];
  /** Маппинг: уточняющий контекст → конкретный search profile */
  contextualProfiles?: Record<string, ResearchQueryProfileKey>;
}

/** Реестр типов вопросов */
class QuestionTypeRegistry {
  private types = new Map<QuestionType, QuestionTypeConfig>();
  private fallbackType: QuestionType = "unknown";
  private unicodeSafeRegexCache = new Map<RegExp, RegExp>();

  /** Регистрация нового типа вопроса */
  register(config: QuestionTypeConfig): void {
    this.types.set(config.type, config);
  }

  /** Получение конфигурации по типу */
  get(type: QuestionType): QuestionTypeConfig | undefined {
    return this.types.get(type);
  }

  /** Получение всех зарегистрированных типов */
  getAll(): QuestionTypeConfig[] {
    return [...this.types.values()];
  }

  /**
   * JavaScript-регексы считают `\w`/`\b` только для латиницы, цифр и `_` —
   * кириллица в `\w` не входит, поэтому `\b` никогда не срабатывает вокруг
   * русских слов ("где", "почему", "есть ли" и т.д. никогда не матчились).
   * Это транслирует `\b` в explicit unicode-aware lookaround-границу, работающую
   * одинаково для латиницы и кириллицы, без переписывания самих паттернов.
   */
  private toUnicodeSafeRegex(pattern: RegExp): RegExp {
    const cached = this.unicodeSafeRegexCache.get(pattern);

    if (cached) {
      return cached;
    }

    const wordBoundary = "(?:(?<=[\\p{L}\\p{N}_])(?![\\p{L}\\p{N}_])|(?<![\\p{L}\\p{N}_])(?=[\\p{L}\\p{N}_]))";
    const transformedSource = pattern.source.split("\\b").join(wordBoundary);
    const flags = pattern.flags.includes("u") ? pattern.flags : `${pattern.flags}u`;
    const safeRegex = new RegExp(transformedSource, flags);

    this.unicodeSafeRegexCache.set(pattern, safeRegex);
    return safeRegex;
  }

  /** Классификация вопроса */
  classify(question: string): { type: QuestionType; confidence: number; matchedPattern?: QuestionTypePattern } {
    const lower = question.toLowerCase();
    let bestMatch: { type: QuestionType; confidence: number; pattern: QuestionTypePattern } | null = null;

    for (const config of this.types.values()) {
      for (const pattern of config.patterns) {
        const regexMatch = this.toUnicodeSafeRegex(pattern.regex).test(lower);
        if (!regexMatch) continue;

        // Проверка required keywords
        if (pattern.requiredKeywords) {
          const hasAllRequired = pattern.requiredKeywords.every(kw => lower.includes(kw.toLowerCase()));
          if (!hasAllRequired) continue;
        }

        // Проверка exclude keywords
        if (pattern.excludeKeywords) {
          const hasExcluded = pattern.excludeKeywords.some(kw => lower.includes(kw.toLowerCase()));
          if (hasExcluded) continue;
        }

        const confidence = pattern.weight / 100; // нормализация
        if (!bestMatch || confidence > bestMatch.confidence) {
          bestMatch = { type: config.type, confidence, pattern };
        }
      }
    }

    if (bestMatch) {
      return { type: bestMatch.type, confidence: bestMatch.confidence, matchedPattern: bestMatch.pattern };
    }

    return { type: this.fallbackType, confidence: 0.1 };
  }

  /** Установка fallback типа */
  setFallback(type: QuestionType): void {
    this.fallbackType = type;
  }
}

/** Singleton instance */
export const questionTypeRegistry = new QuestionTypeRegistry();

/** Регистрация встроенных типов вопросов */
export function registerBuiltinQuestionTypes(): void {
  // EXISTENCE — "есть X?", "используется Y?"
  questionTypeRegistry.register({
    type: "existence",
    label: "Existence Check",
    description: "Вопросы о наличии/существовании чего-либо в проекте",
    patterns: [
      { regex: /\b(есть|есть ли|существует|is there|does.*exist|using|use)\b/i, weight: 90, excludeKeywords: ["где", "where"] },
      { regex: /\b(используется)\b/i, weight: 82, excludeKeywords: ["где", "where"] },
      { regex: /\b(подключен|подключена|enabled|configured)\b/i, weight: 70 },
    ],
    defaultSearchProfiles: ["config-inventory", "entrypoint-traversal"],
    contextualProfiles: {
      "auth": "entrypoint-traversal",
      "oauth": "config-inventory",
      "provider": "config-inventory",
      "redis": "config-inventory",
      "cache": "config-inventory",
      "queue": "config-inventory",
      "session": "config-inventory",
      "websocket": "config-inventory",
      "realtime": "config-inventory",
      "broadcast": "config-inventory",
      "mail": "config-inventory",
      "notification": "config-inventory",
      "search": "config-inventory",
      "storage": "config-inventory",
    },
  });

  // SCHEMA — "что хранит модель", "поля", "структура"
  questionTypeRegistry.register({
    type: "schema",
    label: "Schema Inspection",
    description: "Вопросы о структуре данных, полях модели, миграциях",
    patterns: [
      { regex: /\b(что хранит|поля|структура|schema|fields|columns|attributes|properties|таблиц[а-яё]*|table|tables|колонк[а-яё]*|column)\b/i, weight: 95 },
      { regex: /\b(модель|model|entity|таблиц[а-яё]*|table)\b.*\b(хранит|содержит|имеет|has|contains)\b/i, weight: 90 },
      { regex: /\b(информаци[а-яё]*|данн[а-яё]*)\b.*\b(хранит[а-яё]*|содержит[а-яё]*)\b/i, weight: 88 },
      { regex: /\b(fillable|hidden|casts|relations?|relationships?)\b/i, weight: 85 },
    ],
    defaultSearchProfiles: ["storage-topology"],
    contextualProfiles: {
      "model": "storage-topology",
      "migration": "storage-topology",
      "database": "storage-topology",
    },
  });

  // LOCATION — "где находится", "в каком файле"
  questionTypeRegistry.register({
    type: "location",
    label: "Location Finding",
    description: "Вопросы о местоположении кода/файлов",
    patterns: [
      { regex: /\b(где)\b.*\b(используется|лежит|находится|обрабатывается|описан|описаны)\b/i, weight: 98 },
      { regex: /\b(где|where|в каком файле|which file|location|путь|path)\b/i, weight: 90 },
      { regex: /\b(найди|find|locate)\b/i, weight: 70 },
    ],
    defaultSearchProfiles: ["entrypoint-traversal", "broad-scan"],
    contextualProfiles: {},
  });

  // FLOW — "как работает", "что происходит", "процесс"
  questionTypeRegistry.register({
    type: "flow",
    label: "Flow Understanding",
    description: "Вопросы о логике работы, процессах, flow",
    patterns: [
      { regex: /\b(как работает|как происходит|что происходит|process|flow|logic|works)\b/i, weight: 90 },
      { regex: /\b(как)\b.*\b(выбирается|определяется|резолвится|устанавливается|обрабатывается)\b/i, weight: 92 },
      { regex: /\b(алгоритм|algorithm|последовательность|sequence|шаги|steps)\b/i, weight: 80 },
      { regex: /\b(в каком случае|в каких случаях|при каких условиях|при каком условии|когда именно|in which case|in what case|under what conditions|when exactly)\b/i, weight: 90 },
      { regex: /\b(нужно|надо|необходимо|должен|должна|должны|required|must|needs? to)\b.*\b(подтвердить|подтверждение|верифицировать|верификация|confirm|verify|validate)\b/i, weight: 85 },
    ],
    defaultSearchProfiles: ["entrypoint-traversal", "broad-scan"],
    contextualProfiles: {},
  });

  // CONFIGURATION — "как настроен", "настройки", "конфиг"
  questionTypeRegistry.register({
    type: "configuration",
    label: "Configuration Inspection",
    description: "Вопросы о конфигурации, настройках, env",
    patterns: [
      { regex: /\b(как настроен[а-яё]*|настройки|конфиг[а-яё]*|config|settings|configuration|env|environment)\b/i, weight: 90 },
      { regex: /\b(параметр|parameter|option|опция)\b/i, weight: 70 },
    ],
    defaultSearchProfiles: ["config-inventory"],
    contextualProfiles: {},
  });

  // INVENTORY — "что есть", "список", "все"
  questionTypeRegistry.register({
    type: "inventory",
    label: "Inventory Listing",
    description: "Вопросы о перечислении сущностей",
    patterns: [
      { regex: /\b(что есть|список|все|all|list|какие есть|inventory)\b/i, weight: 85 },
      { regex: /\b(перечисли|enumerate|show all)\b/i, weight: 75 },
    ],
    defaultSearchProfiles: ["broad-scan", "config-inventory"],
    contextualProfiles: {
      "auth": "entrypoint-traversal",
      "routes": "entrypoint-traversal",
      "models": "storage-topology",
      "controllers": "entrypoint-traversal",
      "middleware": "entrypoint-traversal",
      "jobs": "entrypoint-traversal",
      "events": "entrypoint-traversal",
      "policies": "entrypoint-traversal",
    },
  });

  // IMPACT — "что сломается", "зависит ли", "влияние"
  questionTypeRegistry.register({
    type: "impact",
    label: "Impact Analysis",
    description: "Вопросы об влиянии изменений, зависимостях",
    patterns: [
      { regex: /\b(что сломается|зависит|влияет|impact|depend|affect|break)\b/i, weight: 90 },
      { regex: /\b(побочн|side effect|consequence|ramification)\b/i, weight: 80 },
      { regex: /\b(почему|why)\b.*\b(влияет|зависит|ломает|сломает|affect|depend|break|impact)\b/i, weight: 95 },
      { regex: /\b(почему|why)\b.*\b(удаление|изменение|изменени|change|delet|remov)\b.*\b(влияет|зависит|ломает|сломает|affect|depend|break)\b/i, weight: 95 },
    ],
    defaultSearchProfiles: ["entrypoint-traversal", "broad-scan"],
    contextualProfiles: {},
  });

  // WHY — "почему", "причина", "reason"
  questionTypeRegistry.register({
    type: "why",
    label: "Reasoning",
    description: "Вопросы о причинах, обосновании решений",
    patterns: [
      { regex: /\b(почему|why|причина|reason|зачем|purpose|обоснован)\b/i, weight: 90 },
    ],
    defaultSearchProfiles: ["broad-scan", "entrypoint-traversal"],
    contextualProfiles: {},
  });

  // COMPARISON — "разница", "vs", "лучше"
  questionTypeRegistry.register({
    type: "comparison",
    label: "Comparison",
    description: "Вопросы о сравнении альтернатив",
    patterns: [
      { regex: /\b(разница|difference|diff|vs|versus|лучше|better|compare|comparison)\b/i, weight: 90 },
    ],
    defaultSearchProfiles: ["broad-scan"],
    contextualProfiles: {},
  });

  // FIX — "как исправить", "ошибка", "debug"
  questionTypeRegistry.register({
    type: "fix",
    label: "Troubleshooting",
    description: "Вопросы об исправлении ошибок, отладке",
    patterns: [
      { regex: /\b(как исправить|fix|debug|ошибка|error|issue|problem|broken|не работает)\b/i, weight: 90 },
      { regex: /\b(исправ|resolve|solve|troubleshoot)\b/i, weight: 80 },
    ],
    defaultSearchProfiles: ["entrypoint-traversal", "broad-scan"],
    contextualProfiles: {},
  });

  // HISTORY — "когда", "кто", "changelog"
  questionTypeRegistry.register({
    type: "history",
    label: "History Tracking",
    description: "Вопросы об истории изменений",
    patterns: [
      { regex: /\b(когда|when|кто|who|changelog|history|добавили|added|изменил|changed)\b/i, weight: 85 },
    ],
    defaultSearchProfiles: ["broad-scan"],
    contextualProfiles: {},
  });

  // Fallback
  questionTypeRegistry.setFallback("unknown");
}
