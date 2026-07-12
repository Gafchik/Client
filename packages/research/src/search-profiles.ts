/**
 * Search Profile Registry
 * 
 * Декларативная система профилей поиска.
 * Каждый профиль описывает ЦЕЛИ поиска (goals), а не просто query profile key.
 * Новые профили добавляются через registerSearchProfile().
 */

import { ResearchQueryProfileKey } from "@client/shared";

export type { ResearchQueryProfileKey };

/** Тип цели поиска */
export type SearchGoalType = 
  | "model-file"        // app/Models/*.php
  | "migration"         // database/migrations/*.php
  | "config-file"       // config/*.php
  | "route-definition"  // routes/*.php
  | "controller"        // app/Http/Controllers/**/*.php
  | "service"           // app/Services/**/*.php
  | "provider"          // *ServiceProvider.php
  | "middleware"        // app/Http/Middleware/**/*.php
  | "job"               // app/Jobs/**/*.php
  | "event"             // app/Events/**/*.php
  | "listener"          // app/Listeners/**/*.php
  | "policy"            // app/Policies/**/*.php
  | "request"           // app/Http/Requests/**/*.php
  | "resource"          // app/Http/Resources/**/*.php
  | "test"              // tests/**/*.php
  | "env-example"       // .env.example
  | "composer-json"     // composer.json
  | "graph-nodes"       // Graph nodes by kind
  | "git-history";      // Git commits/log

/** Ограничение поиска */
export interface SearchConstraint {
  type: "include-path" | "exclude-path" | "include-pattern" | "exclude-pattern" | "file-kind" | "max-depth";
  value: string | number;
}

/** Цель поиска — что именно ищем */
export interface SearchGoal {
  id: string;
  description: string;
  goalType: SearchGoalType;
  priority: "critical" | "high" | "medium" | "low";
  /** Паттерны для поиска (поддерживает {entity} placeholder) */
  patterns?: string[];
  /** Пути для прямого поиска */
  paths?: string[];
  /** Ограничения */
  constraints?: SearchConstraint[];
  /** Обязательно ли найти для ответа */
  evidenceRequired: boolean;
  /** Контекстуальные ключи для активации этой цели */
  contextKeys?: string[];
}

/** Конфигурация профиля поиска */
export interface SearchProfileConfig {
  key: ResearchQueryProfileKey;
  label: string;
  description: string;
  /** Цели поиска в порядке приоритета */
  goals: SearchGoal[];
  /** Максимальное количество кандидатов на цель */
  maxCandidatesPerGoal?: number;
  /** Глобальные ограничения для профиля */
  globalConstraints?: SearchConstraint[];
}

/** Реестр профилей поиска */
class SearchProfileRegistry {
  private profiles = new Map<ResearchQueryProfileKey, SearchProfileConfig>();

  /** Регистрация нового профиля поиска */
  register(config: SearchProfileConfig): void {
    this.profiles.set(config.key, config);
  }

  /** Получение профиля по ключу */
  get(key: ResearchQueryProfileKey): SearchProfileConfig | undefined {
    return this.profiles.get(key);
  }

  /** Получение всех профилей */
  getAll(): SearchProfileConfig[] {
    return [...this.profiles.values()];
  }

  /** Получение целей для профиля с учётом контекста */
  getGoalsForContext(profileKey: ResearchQueryProfileKey, contextKeys: string[] = []): SearchGoal[] {
    const profile = this.profiles.get(profileKey);
    if (!profile) return [];

    return profile.goals.filter(goal => {
      if (!goal.contextKeys || goal.contextKeys.length === 0) return true;
      return goal.contextKeys.some(ck => contextKeys.includes(ck));
    });
  }
}

/** Singleton instance */
export const searchProfileRegistry = new SearchProfileRegistry();

/** Регистрация встроенных профилей поиска */
export function registerBuiltinSearchProfiles(): void {
  // STORAGE TOPOLOGY — модели, миграции, схемы БД
  searchProfileRegistry.register({
    key: "storage-topology",
    label: "Storage Topology",
    description: "Поиск моделей, миграций, схем БД, отношений",
    goals: [
      {
        id: "model-file",
        description: "Locate model file",
        goalType: "model-file",
        priority: "critical",
        patterns: ["{entity}"],
        evidenceRequired: true,
      },
      {
        id: "migration",
        description: "Locate migration for table",
        goalType: "migration",
        priority: "high",
        patterns: ["create_{entityLower}", "{entityLower}_table"],
        evidenceRequired: false,
      },
      {
        id: "fillable",
        description: "Inspect fillable attributes",
        goalType: "model-file",
        priority: "critical",
        patterns: ["fillable"],
        constraints: [{ type: "include-pattern", value: "fillable" }],
        evidenceRequired: true,
      },
      {
        id: "hidden",
        description: "Inspect hidden attributes",
        goalType: "model-file",
        priority: "high",
        patterns: ["hidden"],
        constraints: [{ type: "include-pattern", value: "hidden" }],
        evidenceRequired: true,
      },
      {
        id: "casts",
        description: "Inspect attribute casts",
        goalType: "model-file",
        priority: "high",
        patterns: ["casts"],
        constraints: [{ type: "include-pattern", value: "casts" }],
        evidenceRequired: true,
      },
      {
        id: "relations",
        description: "Inspect relationships",
        goalType: "model-file",
        priority: "critical",
        patterns: ["hasOne", "hasMany", "belongsTo", "belongsToMany", "morphOne", "morphMany", "morphTo"],
        constraints: [{ type: "include-pattern", value: "hasOne|hasMany|belongsTo|belongsToMany|morphOne|morphMany|morphTo" }],
        evidenceRequired: true,
      },
    ],
    maxCandidatesPerGoal: 5,
  });

  // CONFIG INVENTORY — конфиги, env, providers
  searchProfileRegistry.register({
    key: "config-inventory",
    label: "Configuration Inventory",
    description: "Поиск конфигурационных файлов, env переменных, сервис-провайдеров",
    goals: [
      {
        id: "config-auth",
        description: "Auth configuration",
        goalType: "config-file",
        priority: "critical",
        paths: ["config/auth.php", "config/services.php", "config/sanctum.php", "config/fortify.php"],
        contextKeys: ["auth", "oauth", "provider", "login", "session", "token", "jwt", "passport", "socialite"],
        evidenceRequired: true,
      },
      {
        id: "config-cache",
        description: "Cache configuration",
        goalType: "config-file",
        priority: "critical",
        paths: ["config/cache.php"],
        contextKeys: ["cache", "redis", "memcached", "caching"],
        evidenceRequired: true,
      },
      {
        id: "config-session",
        description: "Session configuration",
        goalType: "config-file",
        priority: "high",
        paths: ["config/session.php"],
        contextKeys: ["session", "redis", "cookie", "database"],
        evidenceRequired: true,
      },
      {
        id: "config-queue",
        description: "Queue configuration",
        goalType: "config-file",
        priority: "high",
        paths: ["config/queue.php"],
        contextKeys: ["queue", "redis", "jobs", "worker", "horizon"],
        evidenceRequired: true,
      },
      {
        id: "config-database",
        description: "Database configuration",
        goalType: "config-file",
        priority: "medium",
        paths: ["config/database.php"],
        contextKeys: ["database", "db", "redis", "connection"],
        evidenceRequired: false,
      },
      {
        id: "config-broadcasting",
        description: "Broadcasting configuration",
        goalType: "config-file",
        priority: "critical",
        paths: ["config/broadcasting.php"],
        contextKeys: ["websocket", "realtime", "broadcast", "pusher", "laravel-echo", "socket"],
        evidenceRequired: true,
      },
      {
        id: "config-mail",
        description: "Mail configuration",
        goalType: "config-file",
        priority: "critical",
        paths: ["config/mail.php"],
        contextKeys: ["mail", "email", "smtp", "sendmail", "notification"],
        evidenceRequired: true,
      },
      {
        id: "config-filesystem",
        description: "Filesystem configuration",
        goalType: "config-file",
        priority: "high",
        paths: ["config/filesystems.php"],
        contextKeys: ["storage", "s3", "filesystem", "cdn", "asset"],
        evidenceRequired: true,
      },
      {
        id: "config-search",
        description: "Search configuration",
        goalType: "config-file",
        priority: "critical",
        paths: ["config/scout.php", "config/meilisearch.php", "config/algolia.php"],
        contextKeys: ["search", "scout", "meilisearch", "algolia", "elasticsearch"],
        evidenceRequired: true,
      },
      {
        id: "env-vars",
        description: "Environment variables",
        goalType: "env-example",
        priority: "high",
        patterns: ["REDIS", "CACHE", "QUEUE", "SESSION", "DATABASE", "MAIL", "BROADCAST", "FILESYSTEM", "SCOUT"],
        evidenceRequired: true,
      },
      {
        id: "service-providers",
        description: "Service providers registration",
        goalType: "provider",
        priority: "medium",
        patterns: ["ServiceProvider"],
        evidenceRequired: false,
      },
      {
        id: "redis-runtime",
        description: "Redis runtime usage in services and jobs",
        goalType: "service",
        priority: "high",
        patterns: ["Redis::", "Cache::", "Queue::", "RedisManager", "Horizon"],
        paths: ["app/Services/", "app/Jobs/"],
        contextKeys: ["redis", "cache", "queue", "session", "horizon"],
        evidenceRequired: true,
      },
      {
        id: "auth-runtime",
        description: "Auth runtime: providers, gates, socialite",
        goalType: "provider",
        priority: "high",
        patterns: ["AuthServiceProvider", "Gate::", "Auth::", "Socialite::", "SocialiteProviders"],
        paths: ["app/Providers/"],
        contextKeys: ["auth", "oauth", "provider", "socialite", "login", "guard"],
        evidenceRequired: true,
      },
    ],
    maxCandidatesPerGoal: 8,
  });

  // ENTRYPOINT TRAVERSAL — роуты, контроллеры, middleware
  searchProfileRegistry.register({
    key: "entrypoint-traversal",
    label: "Entrypoint Traversal",
    description: "Поиск точек входа: роуты, контроллеры, middleware, команды",
    goals: [
      {
        id: "routes",
        description: "Route definitions",
        goalType: "route-definition",
        priority: "critical",
        paths: ["routes/web.php", "routes/api.php", "routes/channels.php", "routes/console.php"],
        evidenceRequired: true,
      },
      {
        id: "controllers",
        description: "Controller files",
        goalType: "controller",
        priority: "high",
        patterns: ["Controller"],
        evidenceRequired: true,
      },
      {
        id: "middleware",
        description: "Middleware",
        goalType: "middleware",
        priority: "medium",
        patterns: ["Middleware"],
        evidenceRequired: false,
      },
      {
        id: "commands",
        description: "Console commands",
        goalType: "controller",
        priority: "low",
        patterns: ["Command"],
        evidenceRequired: false,
      },
      {
        id: "websocket-channels",
        description: "WebSocket channels and broadcast provider",
        goalType: "route-definition",
        priority: "high",
        paths: ["routes/channels.php"],
        contextKeys: ["websocket", "realtime", "broadcast", "pusher", "laravel-echo", "reverb"],
        evidenceRequired: true,
      },
      {
        id: "broadcast-provider",
        description: "BroadcastServiceProvider registration",
        goalType: "provider",
        priority: "high",
        patterns: ["BroadcastServiceProvider"],
        contextKeys: ["websocket", "realtime", "broadcast", "pusher", "laravel-echo", "reverb"],
        evidenceRequired: true,
      },
      {
        id: "websocket-runtime",
        description: "WebSocket runtime: Broadcast facade, Pusher, Echo, Reverb",
        goalType: "service",
        priority: "high",
        patterns: ["Broadcast::", "Pusher", "LaravelEcho", "Reverb"],
        paths: ["app/Services/", "app/Events/", "app/Broadcasting/"],
        contextKeys: ["websocket", "realtime", "broadcast", "pusher", "laravel-echo", "reverb"],
        evidenceRequired: true,
      },
      {
        id: "websocket-frontend",
        description: "Frontend WebSocket: Laravel Echo, Pusher JS, Reverb client",
        goalType: "service",
        priority: "medium",
        patterns: ["laravel-echo", "pusher-js", "reverb", "Echo(", "new Echo"],
        paths: ["resources/js/", "resources/ts/"],
        contextKeys: ["websocket", "realtime", "broadcast", "pusher", "laravel-echo", "reverb"],
        evidenceRequired: false,
      },
    ],
    maxCandidatesPerGoal: 10,
  });

  // LOCALIZATION INVENTORY — переводы, локали
  searchProfileRegistry.register({
    key: "localization-inventory",
    label: "Localization Inventory",
    description: "Поиск файлов локализации, переводов",
    goals: [
      {
        id: "lang-files",
        description: "Language files",
        goalType: "config-file",
        priority: "critical",
        paths: ["lang/", "resources/lang/"],
        evidenceRequired: true,
      },
      {
        id: "translation-keys",
        description: "Translation usage in code",
        goalType: "graph-nodes",
        priority: "high",
        patterns: ["__(", "trans(", "@lang"],
        evidenceRequired: false,
      },
    ],
    maxCandidatesPerGoal: 10,
  });

  // BROAD SCAN — общий обзор
  searchProfileRegistry.register({
    key: "broad-scan",
    label: "Broad Scan",
    description: "Общий обзор проекта для расплывчатых вопросов",
    goals: [
      {
        id: "entrypoints",
        description: "Main entrypoints",
        goalType: "route-definition",
        priority: "high",
        paths: ["routes/web.php", "routes/api.php"],
        evidenceRequired: true,
      },
      {
        id: "configs",
        description: "Key configs",
        goalType: "config-file",
        priority: "medium",
        paths: ["config/app.php", "config/auth.php", "config/database.php"],
        evidenceRequired: false,
      },
      {
        id: "models",
        description: "Main models",
        goalType: "model-file",
        priority: "medium",
        patterns: ["User", "Model"],
        evidenceRequired: false,
      },
    ],
    maxCandidatesPerGoal: 5,
  });
}
