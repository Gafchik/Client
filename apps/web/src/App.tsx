import { Fragment, startTransition, useEffect, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import type {
  BackgroundProjectState,
  ContextCandidate,
  ConversationTurnsResponse,
  KnowledgeCatalogEntry,
  ProjectCatalogResponse,
  ProjectPathRecord,
  ProjectRecord,
  PipelineRunResult,
  PipelineRunStatus,
  ObserverStatusResponse,
  ProviderCatalogResponse,
  ProviderModelRecord,
  ProviderRecord,
  ProviderUsageSummary,
  RepositorySnapshot,
  TeamCatalogResponse,
  TeamRecord,
} from "@client/shared";

interface ProjectInfo {
  projectRecord?: ProjectRecord | null;
  name: string;
  rootPath: string;
  summary: {
    totalFiles: number;
    indexedFiles: number;
    languages: Record<string, number>;
    profile?: "standard" | "large-repository";
  };
  recentRuns: KnowledgeCatalogEntry[];
  latestRun: PipelineRunResult | null;
  repository?: RepositorySnapshot | null;
  backgroundState?: BackgroundProjectState | null;
  activeBackgroundRun?: PipelineRunStatus | null;
  baselineInfo?: {
    sameHeadRunId?: string;
    sameHeadRunStatus?: PipelineRunStatus["status"];
    baselineRunId?: string;
    latestBackgroundRunId?: string;
    baselineExactForHead: boolean;
    hasLocalOverlay: boolean;
    localOverlayChangeCount: number;
    backgroundSyncRecommended: boolean;
  } | null;
}

interface HealthStatusResponse {
  status: string;
  now: string;
  neo4jConnected: boolean;
  postgresConnected: boolean;
  redisConnected: boolean;
}

type ProviderDraft = {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
};

type TeamDraft = {
  id: string;
  name: string;
  researcherModel: string;
  criticModel: string;
  observerModel: string;
  developerModel: string;
  reviewerModel: string;
};

const TEAM_ROLE_DESCRIPTIONS = {
  researcher: "Исследует кодовую базу и ищет доказательства для ответа.",
  critic: "Проверяет ответ Researcher перед тем как показать его пользователю. Также классифицирует сообщения чата (вопрос/задача) — частые дешёвые вызовы.",
  observer: "Изучает проект в фоне между вопросами, чтобы будущие ответы были быстрее.",
  developer: "Пишет код по задаче из чата в изолированном worktree. Пусто — используется модель Researcher.",
  reviewer: "Независимое ревью diff перед выдачей. Должна быть не слабее Developer по коду — слабый ревьюер шумит неверными замечаниями. Пусто — code-дефолт (Kimi K2.7 Code).",
} as const;

type ProjectDraftPath = {
  id: string;
  name: string;
  rootPath: string;
};

type ProjectDraft = {
  id: string;
  name: string;
  description: string;
  paths: ProjectDraftPath[];
};

type AppView = "chat" | "providers" | "projects" | "teams" | "observers";

const VIEW_TITLES: Record<AppView, string> = {
  chat: "Чат по проекту",
  projects: "Проекты",
  providers: "Провайдеры",
  teams: "Команды",
  observers: "Обсерверы",
};

const VIEW_SUBTITLES: Record<AppView, string> = {
  chat: "Задай вопрос и получи инженерный ответ поверх уже собранной карты проекта.",
  projects: "Редко используемый экран настройки проектов и их путей.",
  providers: "Редко используемый экран настройки AI-провайдеров.",
  teams: "Researcher/Critic/Observer — кто ищет, кто проверяет, кто изучает проект в фоне.",
  observers: "Observer изучает проект в фоне между вопросами. Запускай и следи за ним здесь для любого проекта — не только для открытого в чате.",
};

type InspectorTab = "overview" | "research" | "impact" | "context" | "plan" | "execution" | "knowledge" | "git" | "diagnostics";

const API_BASE_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3001";
const PROVIDER_STORAGE_KEY = "client.provider-config";
const PROJECT_STORAGE_KEY = "client.selected-project";

function readPersistedProjectId(): string {
  try {
    return window.localStorage.getItem(PROJECT_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}
const REQUEST_TIMEOUT_MS = 15000;
const DEFAULT_MODEL_ID = "nvidia/nemotron-3-ultra";
// Circuit breaker для цепочки уточняющих вопросов — после этого числа
// подряд идущих раундов clarification-needed фронт перестаёт показывать
// chips повторно, чтобы не зациклить пользователя.
const MAX_CLARIFICATION_ROUNDS = 2;

function hasRunArtifacts(result: PipelineRunResult | null): result is PipelineRunResult {
  return Boolean(result?.runId && result?.project && result?.research && result?.impact);
}

function safeList<T>(value: T[] | undefined | null): T[] {
  return Array.isArray(value) ? value : [];
}

// Известные слаги поставщиков моделей (см. docs/architecture/009-model-catalog-and-role-profiles.md)
// для человекочитаемых заголовков групп в выпадающем списке. Для незнакомого
// слага — заголовок строится автоматически (title case по дефисам), чтобы
// новый поставщик в каталоге не ломал группировку.
const MODEL_VENDOR_LABELS: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  deepseek: "DeepSeek",
  "x-ai": "xAI",
  "z-ai": "Z-AI",
  moonshotai: "Moonshot AI",
  qwen: "Qwen",
  minimax: "MiniMax",
  meta: "Meta",
  nvidia: "NVIDIA",
  perplexity: "Perplexity",
  sakana: "Sakana AI",
  xiaomi: "Xiaomi",
  baai: "BAAI",
};

function getModelVendorLabel(modelId: string): string {
  const slug = modelId.includes("/") ? modelId.split("/")[0] ?? "" : "";

  if (!slug) {
    return "Другое";
  }

  return (
    MODEL_VENDOR_LABELS[slug]
    ?? slug
      .split("-")
      .map((part) => (part ? part[0]!.toUpperCase() + part.slice(1) : part))
      .join(" ")
  );
}

function groupModelsByVendor(models: ProviderModelRecord[]): Array<{ vendor: string; models: ProviderModelRecord[] }> {
  const groups = new Map<string, ProviderModelRecord[]>();

  for (const model of models) {
    const vendor = getModelVendorLabel(model.id);
    const bucket = groups.get(vendor) ?? [];
    bucket.push(model);
    groups.set(vendor, bucket);
  }

  return Array.from(groups.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([vendor, vendorModels]) => ({ vendor, models: vendorModels }));
}

/** Raw cost multiplier for a model id, as reported by the provider's own /models endpoint - not hardcoded. Null if the model is unknown or the provider didn't report one. */
function findModelMultiplier(models: ProviderModelRecord[], modelId: string): number | null {
  if (!modelId) {
    return null;
  }

  const match = models.find((model) => model.id === modelId);
  return typeof match?.tokenMultiplier === "number" ? match.tokenMultiplier : null;
}

/** Cost multiplier for a model id (e.g. "0.7x", "1.5x"), as reported by the provider's own /models endpoint - not hardcoded. */
function findModelMultiplierLabel(models: ProviderModelRecord[], modelId: string): string | null {
  const multiplier = findModelMultiplier(models, modelId);
  return multiplier === null ? null : `${multiplier}x`;
}

// Человекочитаемые лейблы для сырых module key из INTENT_PROFILES
// (packages/research/src/index.ts) — общий, не привязанный к проекту
// словарь. Value, которое реально уходит в task при уточнении — сырой key,
// не label (лучше матчится алиасами профиля при повторной токенизации).
const MODULE_LABELS: Record<string, string> = {
  auth: "Авторизация",
  billing: "Биллинг",
  user: "Пользователи",
  localization: "Локализация",
  config: "Конфигурация",
  servers: "Серверы",
  vault: "Хранилище секретов",
  notification: "Уведомления",
  "model-schema": "Схема данных",
  "auth-inventory": "Инвентаризация авторизации",
  "websocket-inventory": "WebSocket",
  "redis-inventory": "Redis",
};

function getModuleLabel(key: string): string {
  return MODULE_LABELS[key] ?? key;
}

function safeText(value: string | undefined | null, fallback = "Недоступно"): string {
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

function safeCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Лёгкий markdown-рендерер под формат ответа Answer Engine: `## Заголовок`,
 * абзацы и списки `- пункт`. Без внешней зависимости — формат ответа
 * ограничен и полноценный markdown-парсер не нужен.
 */
// Модельные ответы форматируются как markdown (`**жирный**`, `` `код` ``),
// но раньше рендерились построчно без разбора inline-разметки — звёздочки и
// бэктики просто печатались как есть, из-за чего ответ выглядел как сырой
// текст, а не как ответ ИИ-чата.
function renderInlineMarkdown(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /\*\*(.+?)\*\*|`([^`]+?)`|\*([^*]+?)\*/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }

    if (match[1] !== undefined) {
      nodes.push(<strong key={key++}>{match[1]}</strong>);
    } else if (match[2] !== undefined) {
      nodes.push(<code key={key++}>{match[2]}</code>);
    } else if (match[3] !== undefined) {
      nodes.push(<em key={key++}>{match[3]}</em>);
    }

    lastIndex = pattern.lastIndex;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes;
}

type AnswerMarkdownBlock =
  | { type: "heading"; text: string }
  | { type: "list"; items: string[] }
  | { type: "paragraph"; text: string }
  | { type: "code"; language: string; code: string };

function parseAnswerMarkdownBlocks(trimmed: string): AnswerMarkdownBlock[] {
  const blocks: AnswerMarkdownBlock[] = [];
  let currentList: string[] | null = null;
  const lines = trimmed.split("\n");
  let index = 0;

  while (index < lines.length) {
    const rawLine = lines[index] ?? "";
    const line = rawLine.trim();

    // Fenced code block (```lang ... ```) - the model answers with pure
    // markdown (see synthesizer prompt), including JSON/code snippets, but
    // nothing here ever rendered a fence as anything but plain paragraph
    // text with the backticks left in - unreadable and uncopyable as code.
    const fenceMatch = /^```(\S*)\s*$/.exec(line);
    if (fenceMatch) {
      const language = fenceMatch[1] ?? "";
      const codeLines: string[] = [];
      index += 1;

      while (index < lines.length && !/^```\s*$/.test((lines[index] ?? "").trim())) {
        codeLines.push(lines[index] ?? "");
        index += 1;
      }

      index += 1; // skip closing fence (harmless no-op if the fence was never closed)
      currentList = null;
      blocks.push({ type: "code", language, code: codeLines.join("\n") });
      continue;
    }

    if (!line) {
      currentList = null;
      index += 1;
      continue;
    }

    const headingMatch = /^#{1,6}\s+(.+)/.exec(line);
    if (headingMatch && headingMatch[1]) {
      currentList = null;
      blocks.push({ type: "heading", text: headingMatch[1].trim() });
      index += 1;
      continue;
    }

    const bulletMatch = /^[-*•]\s+(.+)/.exec(line);
    if (bulletMatch && bulletMatch[1]) {
      if (!currentList) {
        currentList = [];
        blocks.push({ type: "list", items: currentList });
      }
      currentList.push(bulletMatch[1].trim());
      index += 1;
      continue;
    }

    currentList = null;
    blocks.push({ type: "paragraph", text: line });
    index += 1;
  }

  return blocks;
}

function CodeBlock({ language, code }: { language: string; code: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API недоступен (например, не-secure context) — тихо игнорируем.
    }
  }

  return (
    <div className="code-block">
      <div className="code-block-head">
        <span>{language || "code"}</span>
        <button type="button" className="code-block-copy" onClick={() => void handleCopy()}>
          {copied ? "Скопировано" : "Копировать"}
        </button>
      </div>
      <pre className="code-block-body">
        <code>{code}</code>
      </pre>
    </div>
  );
}

function AnswerMarkdown({ text }: { text: string }) {
  const trimmed = typeof text === "string" ? text.trim() : "";

  if (!trimmed) {
    return null;
  }

  const blocks = parseAnswerMarkdownBlocks(trimmed);

  return (
    <div className="answer-markdown">
      {blocks.map((block, index) => {
        if (block.type === "heading") {
          return <h4 key={index}>{renderInlineMarkdown(block.text)}</h4>;
        }

        if (block.type === "list") {
          return (
            <ul key={index}>
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex}>{renderInlineMarkdown(item)}</li>
              ))}
            </ul>
          );
        }

        if (block.type === "code") {
          return <CodeBlock key={index} language={block.language} code={block.code} />;
        }

        return <p key={index}>{renderInlineMarkdown(block.text)}</p>;
      })}
    </div>
  );
}

function normalizeProjectInfo(data: ProjectInfo): ProjectInfo {
  return {
    ...data,
    projectRecord: data.projectRecord ?? null,
    recentRuns: safeList(data.recentRuns),
    summary: {
      totalFiles: safeCount(data.summary?.totalFiles),
      indexedFiles: safeCount(data.summary?.indexedFiles),
      languages: data.summary?.languages ?? {},
      ...(data.summary?.profile ? { profile: data.summary.profile } : {}),
    },
    latestRun: data.latestRun ?? null,
    repository: data.repository ?? null,
    backgroundState: data.backgroundState ?? null,
    activeBackgroundRun: data.activeBackgroundRun ?? null,
    baselineInfo: data.baselineInfo ?? null,
  };
}

function normalizeProjectCatalog(data: ProjectCatalogResponse): ProjectCatalogResponse {
  return {
    projects: safeList(data.projects).map((project) => ({
      ...project,
      description: safeText(project.description, ""),
      paths: safeList(project.paths).map((item) => ({
        ...item,
        name: safeText(item.name),
        rootPath: safeText(item.rootPath),
      })),
    })),
  };
}

function worktreeStatusLabel(value: BackgroundProjectState["worktreeStatus"] | undefined): string {
  switch (value) {
    case "clean":
      return "чисто";
    case "overlay":
      return "локальный overlay";
    case "conflict":
      return "конфликт";
    default:
      return "неизвестно";
  }
}

function projectReadinessState(project: ProjectInfo | null): {
  tone: "ready" | "warning" | "overlay";
  title: string;
  description: string;
} {
  if (!project?.backgroundState || !project?.baselineInfo) {
    return {
      tone: "warning",
      title: "Состояние проекта ещё не собрано",
      description: "Нужно получить repository и background state, прежде чем ответы смогут стабильно опираться на baseline проекта.",
    };
  }

  if (project.baselineInfo.backgroundSyncRecommended || project.backgroundState.freshness === "missing") {
    return {
      tone: "warning",
      title: "Нужен background sync",
      description: "Для текущего branch/head ещё нет актуального committed baseline. Отвечать можно, но качество будет ниже до завершения фоновой пересборки.",
    };
  }

  if (project.baselineInfo.hasLocalOverlay || project.backgroundState.worktreeStatus === "overlay") {
    return {
      tone: "overlay",
      title: "Ответ будет с локальным overlay",
      description: `Committed baseline готов, но есть ${safeCount(project.baselineInfo.localOverlayChangeCount)} локальных изменений. Ответ будет объединять baseline проекта и текущий незакоммиченный worktree.`,
    };
  }

  return {
    tone: "ready",
    title: "Фон проекта актуален",
    description: "Для текущего branch/head есть committed baseline, поэтому чат может отвечать поверх уже собранной карты проекта без полного пересбора.",
  };
}

function backgroundSyncState(project: ProjectInfo | null): {
  tone: "running" | "scheduled" | "idle";
  title: string;
  description: string;
} {
  const activeRun = project?.activeBackgroundRun;
  const running = activeRun && (activeRun.status === "queued" || activeRun.status === "running");

  if (running) {
    return {
      tone: "running",
      title: "Фоновый sync уже выполняется",
      description: `${runModeLabel(activeRun.mode)} · ${safeText(activeRun.currentStageLabel, "в очереди")} · статус ${activeRun.status}. Можно ждать завершения или уже задавать вопрос поверх текущего baseline/overlay.`,
    };
  }

  if (project?.baselineInfo?.backgroundSyncRecommended) {
    return {
      tone: "scheduled",
      title: "Фон требует обновления",
      description: "Для текущего branch/head стоит дождаться committed baseline. Авто-sync будет полезен для следующего точного ответа, но вопрос можно задать уже сейчас.",
    };
  }

  return {
    tone: "idle",
    title: "Можно спрашивать сейчас",
    description: "Фоновый sync сейчас не нужен: текущий baseline уже пригоден для question-run, а локальные изменения будут учтены через worktree overlay при необходимости.",
  };
}

function buildChatPreflight(input: {
  health: HealthStatusResponse | null;
  providers: ProviderRecord[];
  selectedProviderId: string;
  teams: TeamRecord[];
  selectedTeamId: string;
  projects: ProjectRecord[];
  selectedProjectId: string;
}) {
  const selectedProvider = input.providers.find((provider) => provider.id === input.selectedProviderId) ?? null;
  const selectedTeam = input.teams.find((team) => team.id === input.selectedTeamId) ?? null;
  const selectedProject = input.projects.find((project) => project.id === input.selectedProjectId) ?? null;
  const hasWorkingProvider = Boolean(selectedProvider?.baseUrl?.trim());
  const hasApiKeyHint = input.providers.some((provider) => provider.baseUrl.trim() && provider.name.trim() && !provider.isCurrent)
    || Boolean(selectedProvider);

  const items = [
    {
      key: "infra",
      ready: Boolean(input.health?.postgresConnected && input.health?.redisConnected),
      label: "Инфраструктура",
      detail: input.health
        ? `Postgres ${input.health.postgresConnected ? "ok" : "off"} · Redis ${input.health.redisConnected ? "ok" : "off"} · Neo4j ${input.health.neo4jConnected ? "ok" : "degraded"}`
        : "Статус инфраструктуры ещё не загружен.",
      action: "Проверь docker compose и /api/health.",
    },
    {
      key: "provider",
      ready: hasWorkingProvider && hasApiKeyHint,
      label: "Провайдер",
      detail: selectedProvider
        ? `${selectedProvider.name} выбран.`
        : "Текущий provider ещё не выбран.",
      action: "Создай или выбери provider на странице «Провайдеры».",
    },
    {
      key: "team",
      ready: Boolean(selectedTeam && selectedTeam.researcherModel && selectedTeam.criticModel && selectedTeam.observerModel),
      label: "Команда",
      detail: selectedTeam
        ? `${selectedTeam.name} выбрана.`
        : "Команда с ролями Researcher/Critic/Observer ещё не выбрана.",
      action: "Выбери team на странице «Команды».",
    },
    {
      key: "project",
      ready: Boolean(selectedProject?.paths.length),
      label: "Проект",
      detail: selectedProject
        ? `${selectedProject.name} · ${selectedProject.paths.length} path`
        : "Проект ещё не добавлен или не выбран.",
      action: "Добавь project и хотя бы один реальный root path на странице «Проекты».",
    },
  ] as const;

  const missing = items.filter((item) => !item.ready);

  return {
    items,
    ready: missing.length === 0,
    title: missing.length === 0 ? "Всё готово к первому вопросу" : "Перед первым вопросом осталось проверить несколько вещей",
    description:
      missing.length === 0
        ? "Инфраструктура поднята, provider/team/project выбраны. Можно сразу спрашивать."
        : missing[0]?.action ?? "Заверши базовую настройку окружения.",
  };
}

function normalizeProviderCatalog(data: ProviderCatalogResponse): ProviderCatalogResponse {
  return {
    providers: safeList(data.providers),
    currentProvider: data.currentProvider ?? null,
    models: safeList(data.models),
    ...(data.recommendedModelId ? { recommendedModelId: data.recommendedModelId } : {}),
  };
}

function normalizeTeamCatalog(data: TeamCatalogResponse): TeamCatalogResponse {
  return {
    teams: safeList(data.teams),
    selectedTeam: data.selectedTeam ?? null,
  };
}

function formatDateTime(value: string | undefined | null): string {
  if (!value) {
    return "Недоступно";
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function runModeLabel(mode: PipelineRunStatus["mode"] | PipelineRunResult["mode"] | undefined): string {
  switch (mode) {
    case "background-sync":
      return "Фоновая пересборка";
    case "hard-resync":
      return "Хард ресинк";
    case "question-run":
      return "Ответ по проекту";
    default:
      return "Run";
  }
}

function PanelFallback({ title, message }: { title: string; message: string }) {
  return (
    <div className="list">
      <div className="list-item fallback-item">
        <strong>{title}</strong>
        <span>{message}</span>
      </div>
    </div>
  );
}

function formatHistoryTime(value: string | undefined): string {
  if (!value) {
    return "Недавно";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "Недавно";
  }

  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function buildHistoryTitle(task: string | undefined): string {
  const normalized = safeText(task, "Новый вопрос");
  return normalized.length > 72 ? `${normalized.slice(0, 69)}...` : normalized;
}

// Раньше строка истории показывала только время (formatHistoryTime) без
// даты — вчерашний и сегодняшний чат выглядели одинаково ("14:32"), и
// список читался как нерасчленённая свалка. Группировка по дню (в духе
// обычных чат-клиентов) даёт списку структуру без добавления шума в саму
// строку.
function formatHistoryDateBucket(value: string): string {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "Ранее";
  }

  const startOfDay = (input: Date) => new Date(input.getFullYear(), input.getMonth(), input.getDate()).getTime();
  const dayDiff = Math.round((startOfDay(new Date()) - startOfDay(date)) / (24 * 60 * 60 * 1000));

  if (dayDiff <= 0) {
    return "Сегодня";
  }

  if (dayDiff === 1) {
    return "Вчера";
  }

  if (dayDiff < 7) {
    return date.toLocaleDateString("ru-RU", { weekday: "long" });
  }

  return date.toLocaleDateString("ru-RU", { day: "numeric", month: "long" });
}

interface HistoryConversationGroup {
  conversationId: string;
  latest: KnowledgeCatalogEntry;
  runIds: string[];
  turnCount: number;
}

// Раньше сайдбар показывал одну строку на каждый run — теперь run'ы одного
// диалога группируются по conversationId в одну строку (одна реплика без
// conversationId в старых записях трактуется как тред из одного хода, см.
// нормализацию conversationId в packages/knowledge). Группа представлена
// самой свежей репликой; удаление/выделение действуют на все run'ы группы.
function groupHistoryByConversation(recentRuns: KnowledgeCatalogEntry[]): HistoryConversationGroup[] {
  const groups = new Map<string, KnowledgeCatalogEntry[]>();

  for (const entry of safeList(recentRuns)) {
    const conversationId = entry.conversationId || entry.runId;
    const bucket = groups.get(conversationId) ?? [];
    bucket.push(entry);
    groups.set(conversationId, bucket);
  }

  return Array.from(groups.entries())
    .map(([conversationId, entries]) => {
      const sorted = [...entries].sort((left, right) => right.savedAt.localeCompare(left.savedAt));
      const latest = sorted[0] as KnowledgeCatalogEntry;

      return {
        conversationId,
        latest,
        runIds: entries.map((entry) => entry.runId),
        turnCount: entries.length,
      };
    })
    .sort((left, right) => right.latest.savedAt.localeCompare(left.latest.savedAt));
}

function RunHistorySidebar({
  recentRuns,
  activeConversationId,
  onSelectConversation,
  onStartNewChat,
  projectName,
  selectedIds,
  onToggleSelect,
  onToggleSelectAll,
  onDeleteSelected,
  onDeleteOne,
  deleting,
}: {
  recentRuns: KnowledgeCatalogEntry[];
  activeConversationId: string | null;
  onSelectConversation: (runId: string) => void;
  onStartNewChat: () => void;
  projectName: string;
  selectedIds: Set<string>;
  onToggleSelect: (conversationId: string) => void;
  onToggleSelectAll: (allIds: string[]) => void;
  onDeleteSelected: () => void;
  onDeleteOne: (conversationId: string) => void;
  deleting: boolean;
}) {
  const items = groupHistoryByConversation(recentRuns).slice(0, 10);
  const allIds = items.map((group) => group.conversationId);
  const allSelected = items.length > 0 && selectedIds.size === items.length;

  return (
    <aside className="chat-history">
      <div className="chat-history-head">
        <button type="button" className="primary-button history-new-button" onClick={onStartNewChat}>
          + Новый чат
        </button>
      </div>

      <div className="chat-history-group">
        <div className="chat-history-toolbar">
          <p className="section-kicker">Чаты</p>
          {items.length ? (
            <label className="history-select-all">
              <input type="checkbox" checked={allSelected} onChange={() => onToggleSelectAll(allIds)} />
              Все
            </label>
          ) : null}
        </div>

        {selectedIds.size > 0 ? (
          <button type="button" className="history-delete-selected" onClick={onDeleteSelected} disabled={deleting}>
            {deleting ? "Удаляю..." : `Удалить (${selectedIds.size})`}
          </button>
        ) : null}

        <div className="chat-history-list">
          {items.length ? (
            items.map((group, index) => {
              const bucket = formatHistoryDateBucket(group.latest.savedAt);
              const previousBucket = index > 0 ? formatHistoryDateBucket(items[index - 1]!.latest.savedAt) : null;

              return (
                <Fragment key={group.conversationId}>
                  {bucket !== previousBucket ? <p className="chat-history-date">{bucket}</p> : null}
                  <div
                    className={`history-item-row ${activeConversationId === group.conversationId ? "history-item-row-active" : ""}`}
                  >
                    <input
                      type="checkbox"
                      className="history-item-checkbox"
                      checked={selectedIds.has(group.conversationId)}
                      onChange={() => onToggleSelect(group.conversationId)}
                      onClick={(event) => event.stopPropagation()}
                      aria-label={`Выбрать чат «${buildHistoryTitle(group.latest.task)}»`}
                    />
                    <button type="button" className="history-item" onClick={() => onSelectConversation(group.latest.runId)}>
                      <strong>{buildHistoryTitle(group.latest.task)}</strong>
                      <span>
                        {formatHistoryTime(group.latest.savedAt)}
                        {group.turnCount > 1 ? ` · ${group.turnCount} реплик` : ""}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="history-item-delete"
                      title="Удалить чат"
                      aria-label={`Удалить чат «${buildHistoryTitle(group.latest.task)}»`}
                      onClick={(event) => {
                        event.stopPropagation();
                        onDeleteOne(group.conversationId);
                      }}
                      disabled={deleting}
                    >
                      ×
                    </button>
                  </div>
                </Fragment>
              );
            })
          ) : (
            <div className="empty-card">
              <strong>История появится после первого вопроса</strong>
              <span>Сейчас здесь будут сохраняться последние запуски.</span>
            </div>
          )}
        </div>
      </div>

      <div className="chat-history-foot">
        <span>{projectName}</span>
      </div>
    </aside>
  );
}

function describeObserverStatus(
  status: ObserverStatusResponse | null,
  projectPath: string,
): { title: string; description: string; running: boolean } | null {
  const entry = status?.observers.find((observer) => observer.projectPath === projectPath);

  if (!entry) {
    return null;
  }

  const progressText = `изучено ${entry.progress.percent}% (${entry.progress.freshUnits}/${entry.progress.totalUnits})`;

  if (entry.status === "running" && entry.activity) {
    return { title: "Observer изучает проект", description: `${entry.activity.unitPath} · ${progressText}`, running: true };
  }

  // "resting" - a full pass found nothing stale, so it's not actually
  // searching right now, just watching for changes (see observer-monitor.ts) -
  // showing "ищет, что ещё не изучено" here would be dishonest at 100%.
  if (entry.status === "running" && entry.resting) {
    return { title: "Observer изучил всё, что нашёл", description: `следит за изменениями · ${progressText}`, running: true };
  }

  if (entry.status === "running") {
    return { title: "Observer запущен", description: `ищет, что ещё не изучено... · ${progressText}`, running: true };
  }

  if (entry.progress.percent >= 100) {
    return { title: "Observer остановлен", description: "карта проекта полная (100%)", running: false };
  }

  return {
    title: "Observer остановлен",
    description: progressText,
    running: false,
  };
}

// Project-level aggregate (2026-07-16, multi-path unification) - a project
// can have several physical repos, each with its own Observer runner; this
// rolls them up into one status so a single button can start/stop all of
// them. "Running" if ANY path is running (matches the "one click covers the
// whole project" intent); the description shows how many of the paths are
// actually active so a partial start/stop is still visible, not hidden.
function describeProjectObserverStatus(
  status: ObserverStatusResponse | null,
  projectRootPaths: string[],
): { title: string; description: string; running: boolean } | null {
  if (projectRootPaths.length === 0) {
    return null;
  }

  // Single-path project (e.g. one repo covering a whole monorepo) - the
  // generic "N/N путей запущено" phrasing below hides the one number that
  // actually matters here (real crawl %), so just show the richer per-path
  // text directly instead of a redundant aggregate wrapper around it.
  if (projectRootPaths.length === 1) {
    return describeObserverStatus(status, projectRootPaths[0]!) ?? { title: "Observer остановлен", description: "ещё не запускался", running: false };
  }

  const perPathStates = projectRootPaths.map((rootPath) => describeObserverStatus(status, rootPath));
  const runningCount = perPathStates.filter((state) => state?.running).length;

  if (runningCount === 0) {
    return { title: "Observer остановлен", description: `0/${projectRootPaths.length} путей`, running: false };
  }

  return {
    title: runningCount === projectRootPaths.length ? "Observer изучает проект" : "Observer изучает частично",
    description: `${runningCount}/${projectRootPaths.length} путей запущено`,
    running: true,
  };
}

// Path-role labels are short and generic (no project-specific naming) - a
// direct display of PathRole values, not a marketing name.
const PATH_ROLE_LABELS: Record<string, string> = {
  backend: "backend",
  "frontend-web": "frontend",
  "frontend-desktop": "desktop",
  cli: "cli",
  unknown: "?",
};

function EnvironmentStrip({
  projects,
  selectedProjectId,
  selectedProviderId,
  providers,
  teams,
  selectedTeamId,
  disabled,
  onProjectChange,
  onProviderChange,
  onTeamChange,
}: {
  projects: ProjectRecord[];
  selectedProjectId: string;
  selectedProviderId: string;
  providers: ProviderRecord[];
  teams: TeamRecord[];
  selectedTeamId: string;
  disabled: boolean;
  onProjectChange: (projectId: string) => void;
  onProviderChange: (providerId: string) => void;
  onTeamChange: (teamId: string) => void;
}) {
  // Multi-path unification (2026-07-16): selecting a project is now enough -
  // no more manually picking "which path" first. Every path of the project
  // is shown as a read-only badge (so the user still sees what's included).
  // Observer start/stop no longer lives here - moved to its own dedicated
  // panel (ObserversPanel) covering every project, not just the one open in
  // chat right now.
  const selectedProject = projects.find((item) => item.id === selectedProjectId) ?? null;
  const projectPaths = selectedProject?.paths ?? [];

  return (
    <section className="environment-strip">
      <select className="environment-pill" value={selectedProjectId} onChange={(event) => onProjectChange(event.target.value)} disabled={disabled}>
        <option value="">Проект</option>
        {safeList(projects).map((projectItem) => (
          <option key={projectItem.id} value={projectItem.id}>
            {projectItem.name}
          </option>
        ))}
      </select>

      {projectPaths.length > 0 ? (
        <span className="environment-pill environment-paths-badge" title="Все эти пути изучаются и видны Researcher'у как один проект">
          {projectPaths.map((pathItem) => `${pathItem.name} (${PATH_ROLE_LABELS[pathItem.role] ?? pathItem.role})`).join(" · ")}
        </span>
      ) : null}

      <select className="environment-pill" value={selectedProviderId} onChange={(event) => onProviderChange(event.target.value)} disabled={disabled}>
        <option value="">Провайдер</option>
        {safeList(providers).map((provider) => (
          <option key={provider.id} value={provider.id}>
            {provider.name}
          </option>
        ))}
      </select>

      <select className="environment-pill" value={selectedTeamId} onChange={(event) => onTeamChange(event.target.value)} disabled={disabled}>
        <option value="">Команда</option>
        {safeList(teams).map((team) => (
          <option key={team.id} value={team.id}>
            {team.name}
          </option>
        ))}
      </select>
    </section>
  );
}

function shortProjectLabel(projectPath: string): string {
  const segments = projectPath.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? projectPath;
}

// Видно на любом чате независимо от того, какой проект сейчас выбран -
// по прямому запросу: "2 обсервера параллельно изучают, и было видно на
// всех чатах, что работают обсерверы по проектам". Плюс быстрый способ
// остановить все разом перед важным вопросом и запустить снова после.
// Раньше сюда же печатался activity.unitPath каждого работающего Observer'а
// (сырой путь файла прямо в топбаре чата) - по прямому запросу убрано:
// сколько проектов изучается и с каким прогрессом видно и без пути, а сам
// путь/деталь смотрят в выделенной панели "Обсерверы" (см. ObserversPanel),
// куда ведёт onOpenPanel.
function ObserverGlobalBar({
  observerStatus,
  pausedCount,
  onStopAll,
  onResume,
  onOpenPanel,
}: {
  observerStatus: ObserverStatusResponse | null;
  pausedCount: number;
  onStopAll: () => void;
  onResume: () => void;
  onOpenPanel: () => void;
}) {
  const running = observerStatus?.observers.filter((observer) => observer.status === "running") ?? [];

  if (running.length === 0 && pausedCount === 0) {
    return null;
  }

  return (
    <div className="observer-global-bar">
      {running.length > 0 ? (
        <>
          <span className="observer-global-bar-label">
            Observer работает: {running.map((observer) => shortProjectLabel(observer.projectPath)).join(", ")}
            {running.length === 1 ? ` · ${running[0]!.progress.percent}%` : ""}
          </span>
          <button type="button" className="ghost-button" onClick={onOpenPanel}>
            Обсерверы
          </button>
          <button type="button" className="ghost-button" onClick={onStopAll}>
            Остановить все
          </button>
        </>
      ) : (
        <button type="button" className="ghost-button" onClick={onResume}>
          Запустить снова ({pausedCount})
        </button>
      )}
    </div>
  );
}

function ObserversPanel({
  projects,
  observerStatus,
  pausedCount,
  onToggleProject,
  onStopAll,
  onResume,
}: {
  projects: ProjectRecord[];
  observerStatus: ObserverStatusResponse | null;
  pausedCount: number;
  onToggleProject: (projectPaths: string[], nextRunning: boolean) => void;
  onStopAll: () => void;
  onResume: () => void;
}) {
  const projectList = safeList(projects);
  const runningCount = observerStatus?.observers.filter((observer) => observer.status === "running").length ?? 0;

  return (
    <section className="settings-layout">
      <article className="settings-card">
        <div className="section-head">
          <div>
            <p className="section-kicker">Обсерверы</p>
            <h2>Все проекты</h2>
          </div>
          {runningCount > 0 ? (
            <button type="button" className="ghost-button" onClick={onStopAll}>
              Остановить все
            </button>
          ) : pausedCount > 0 ? (
            <button type="button" className="ghost-button" onClick={onResume}>
              Запустить снова ({pausedCount})
            </button>
          ) : null}
        </div>

        {projectList.length === 0 ? (
          <div className="empty-card">
            <strong>Пока нет ни одного проекта</strong>
            <span>Добавь проект на странице «Проекты», чтобы запускать по нему Observer.</span>
          </div>
        ) : (
          <div className="list">
            {projectList.map((projectItem) => {
              const projectRootPaths = projectItem.paths.map((pathItem) => pathItem.rootPath);
              const aggregate = describeProjectObserverStatus(observerStatus, projectRootPaths);

              return (
                <div key={projectItem.id} className="observer-project-card">
                  <div className="observer-project-head">
                    <div>
                      <strong>{projectItem.name}</strong>
                      <span>{aggregate?.title ?? "Ещё не запускался"} · {aggregate?.description ?? "нет данных"}</span>
                    </div>
                    <button
                      type="button"
                      className={aggregate?.running ? "ghost-button danger-button" : "primary-button"}
                      onClick={() => onToggleProject(projectRootPaths, !(aggregate?.running ?? false))}
                    >
                      {aggregate?.running ? "Остановить" : "Запустить"}
                    </button>
                  </div>

                  {projectItem.paths.length > 1 ? (
                    <div className="observer-path-list">
                      {projectItem.paths.map((pathItem) => {
                        const pathState = describeObserverStatus(observerStatus, pathItem.rootPath);
                        return (
                          <div key={pathItem.id} className="observer-path-row">
                            <span className="observer-path-name">
                              {pathItem.name} <em>({PATH_ROLE_LABELS[pathItem.role] ?? pathItem.role})</em>
                            </span>
                            <span className={`observer-path-status ${pathState?.running ? "observer-path-status-running" : ""}`}>
                              {pathState ? `${pathState.title} · ${pathState.description}` : "ещё не запускался"}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </article>
    </section>
  );
}

function isTransientPollError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return (
    message.includes("превысил лимит ожидания")
    || message.includes("failed to fetch")
    || message.includes("networkerror")
    || message.includes("load failed")
  );
}

async function fetchJsonWithTimeout<T>(input: string, init?: RequestInit, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(input, {
      ...init,
      signal: controller.signal,
    });

    if (!response.ok) {
      let message = "Ошибка запроса.";

      try {
        const payload = (await response.json()) as { message?: string };
        message = payload.message ?? message;
      } catch {
        // ignore invalid error payload
      }

      throw new Error(message);
    }

    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("Запрос превысил лимит ожидания. Сервер мог зависнуть или быть недоступен.");
    }

    throw error;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

function UserTaskMessage({ task, projectName, projectPath }: { task: string; projectName: string; projectPath: string }) {
  return (
    <div className="message user-message">
      <div className="message-badge">Ты</div>
      <div className="message-card">
        <p className="message-label">Задача · {safeText(projectName, "Проект не выбран")}</p>
        <p>{safeText(task)}</p>
        {projectPath ? null : <p className="message-footnote">Проект не выбран</p>}
      </div>
    </div>
  );
}

/**
 * Компактный индикатор "система думает" вместо развёрнутого списка стадий
 * pipeline и шести карточек partial-артефактов — тот же смысл, но в формате
 * обычного AI-чата. Детальный прогресс по стадиям остаётся доступен через
 * Inspector ("Подробнее"), здесь только текущий шаг.
 */
function formatRunDuration(totalSeconds: number): string {
  if (totalSeconds < 60) {
    return `${totalSeconds} с`;
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds > 0 ? `${minutes} мин ${seconds} с` : `${minutes} мин`;
}

function ThinkingIndicator({ currentStageLabel, startedAt }: { currentStageLabel?: string; startedAt?: string }) {
  // Живой счётчик времени (2026-07-16): пользователю важно видеть, сколько
  // уже идёт ответ (обычный диапазон 40с-3мин в зависимости от сложности),
  // иначе долгий research неотличим от зависшего запроса.
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  useEffect(() => {
    if (!startedAt) {
      return;
    }

    const startedMs = new Date(startedAt).getTime();
    const tick = () => setElapsedSeconds(Math.max(0, Math.floor((Date.now() - startedMs) / 1000)));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);

  return (
    <div className="thinking-indicator">
      <span className="thinking-dots">
        <span />
        <span />
        <span />
      </span>
      <span className="thinking-label">{safeText(currentStageLabel, "Изучаю проект")}</span>
      {startedAt ? <span className="thinking-elapsed">{formatRunDuration(elapsedSeconds)}</span> : null}
    </div>
  );
}

// --- Developer pipeline (docs/architecture/011-developer-pipeline.md) ---
// Чат понимает не только вопросы, но и задачи разработки: сервер сам
// классифицирует сообщение (/api/pipeline/run -> kind: "develop") и ведёт
// Developer-цикл в изолированном worktree. Эти типы зеркалят
// apps/api/src/develop-runner.ts.

interface DevelopSensitiveActionView {
  command: string;
  reason: string;
  status: "pending" | "approved" | "rejected";
  exitCode?: number;
  output?: string;
}

interface DevelopRunResultView {
  summary: string | null;
  clarificationQuestion: string | null;
  pendingApproval: DevelopSensitiveActionView | null;
  sensitiveActions: DevelopSensitiveActionView[];
  diff: string;
  changedFiles: string[];
  verificationLog: Array<{ command: string; exitCode: number; durationMs: number; output: string; turn: number }>;
  reviews: Array<{ verdict: string; findings: string[]; noteFindings?: string[]; raw: string }>;
  reviewVerdict: "approved" | "needs-changes" | "not-run";
  stopped: string;
  error?: string;
  turnsUsed: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
}

interface DevelopMergeOutcomeView {
  label: string;
  applied: boolean;
  changedFiles: string[];
  error?: string;
}

interface DevelopRunStatusView {
  runId: string;
  conversationId: string;
  status: "running" | "completed" | "failed";
  task: string;
  startedAt: string;
  finishedAt?: string;
  progress?: { turn: number; filesChanged: number; phase: string };
  worktrees: Array<{ label: string; rootPath: string; worktreePath: string; branch: string }>;
  result?: DevelopRunResultView;
  errorMessage?: string;
  autoMergeOnCompletion?: boolean;
  autoMergeOutcome?: DevelopMergeOutcomeView[];
}

interface DevelopWorktreeRegistryEntryView {
  runId: string;
  conversationId: string;
  projectPath: string;
  task: string;
  status: "running" | "completed" | "failed";
  startedAt: string;
  finishedAt?: string;
  worktrees: Array<{ label: string; rootPath: string; worktreePath: string; branch: string }>;
  autoMergeOutcome?: DevelopMergeOutcomeView[];
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

interface WorktreeChatGroupView {
  projectPath: string;
  conversationId: string;
  entries: DevelopWorktreeRegistryEntryView[];
  task: string;
  startedAt: string;
  status: "running" | "completed" | "failed";
  worktrees: Array<DevelopWorktreeRegistryEntryView["worktrees"][number] & { runId: string }>;
  autoMergeOutcome: DevelopMergeOutcomeView[];
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  } | null;
}

function worktreeTreeId(runId: string, label: string): string {
  return `${runId}:${label}`;
}

function groupWorktreeEntries(entries: DevelopWorktreeRegistryEntryView[]): Array<{
  projectPath: string;
  chats: WorktreeChatGroupView[];
}> {
  const projectBuckets = new Map<string, Map<string, DevelopWorktreeRegistryEntryView[]>>();

  for (const entry of entries) {
    const projectBucket = projectBuckets.get(entry.projectPath) ?? new Map<string, DevelopWorktreeRegistryEntryView[]>();
    const chatBucket = projectBucket.get(entry.conversationId) ?? [];
    chatBucket.push(entry);
    projectBucket.set(entry.conversationId, chatBucket);
    projectBuckets.set(entry.projectPath, projectBucket);
  }

  return [...projectBuckets.entries()]
    .map(([projectPath, chats]) => ({
      projectPath,
      chats: [...chats.entries()]
        .map(([conversationId, chatEntries]) => {
          const sortedEntries = [...chatEntries].sort((left, right) => right.startedAt.localeCompare(left.startedAt));
          const latestEntry = sortedEntries[0] as DevelopWorktreeRegistryEntryView;
          const usage = sortedEntries.reduce(
            (accumulator, entry) => ({
              promptTokens: accumulator.promptTokens + (entry.usage?.promptTokens ?? 0),
              completionTokens: accumulator.completionTokens + (entry.usage?.completionTokens ?? 0),
              totalTokens: accumulator.totalTokens + (entry.usage?.totalTokens ?? 0),
            }),
            { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          );

          return {
            projectPath,
            conversationId,
            entries: sortedEntries,
            task: latestEntry.task,
            startedAt: latestEntry.startedAt,
            status: latestEntry.status,
            worktrees: sortedEntries.flatMap((entry) => entry.worktrees.map((worktree) => ({ ...worktree, runId: entry.runId }))),
            autoMergeOutcome: sortedEntries.flatMap((entry) => safeList(entry.autoMergeOutcome)),
            usage: usage.totalTokens > 0 ? usage : null,
          };
        })
        .sort((left, right) => right.startedAt.localeCompare(left.startedAt)),
    }))
    .sort((left, right) => {
      const leftLatest = left.chats[0]?.startedAt ?? "";
      const rightLatest = right.chats[0]?.startedAt ?? "";
      return rightLatest.localeCompare(leftLatest);
    });
}

function developPhaseLabel(progress?: { turn: number; filesChanged: number; phase: string }): string {
  if (!progress) {
    return "Готовлю изолированную копию проекта...";
  }

  if (progress.phase === "reviewing") {
    return "Независимое ревью изменений...";
  }

  if (progress.phase === "fixing") {
    return `Правлю по замечаниям ревью (ход ${progress.turn})...`;
  }

  return progress.filesChanged > 0
    ? `Пишу код (ход ${progress.turn}, изменено файлов: ${progress.filesChanged})...`
    : `Разбираюсь в коде (ход ${progress.turn})...`;
}

function developVerdictBadge(result: DevelopRunResultView): { label: string; className: string } {
  if (result.stopped === "needs-approval") {
    return { label: "Требуется апрув", className: "develop-verdict develop-verdict-clarify" };
  }

  if (result.stopped === "needs-clarification") {
    return { label: "Нужно уточнение", className: "develop-verdict develop-verdict-clarify" };
  }

  if (result.reviewVerdict === "approved") {
    return { label: "Ревью: одобрено", className: "develop-verdict develop-verdict-approved" };
  }

  if (result.reviewVerdict === "needs-changes") {
    return { label: "Ревью: есть замечания", className: "develop-verdict develop-verdict-changes" };
  }

  return { label: result.diff.trim() ? "Без ревью" : "Без изменений кода", className: "develop-verdict" };
}

/** Дублирует formatRunDuration - тот же формат "N с"/"N мин M с", тот же расчёт что и в Q&A-реплике ("· за X"). */
function developRunDurationLabel(run: DevelopRunStatusView): string | null {
  if (!run.finishedAt) {
    return null;
  }

  const seconds = Math.round((new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()) / 1000);
  return Number.isFinite(seconds) && seconds >= 0 ? formatRunDuration(Math.max(1, seconds)) : null;
}

function DevelopMergeOutcomeList({ outcomes }: { outcomes: DevelopMergeOutcomeView[] }) {
  return (
    <ul className="develop-merge-outcome">
      {outcomes.map((outcome, index) => (
        <li key={index} className={outcome.applied ? "develop-merge-outcome-ok" : "develop-merge-outcome-fail"}>
          {outcome.applied
            ? `✓ ${outcome.label}: занесено в чекаут (${outcome.changedFiles.length} файл(ов)) — незакоммичено, смотри diff в IDE.`
            : `✗ ${outcome.label}: не удалось занести — ${outcome.error ?? "неизвестная ошибка"}.`}
        </li>
      ))}
    </ul>
  );
}

/**
 * Worktree этой конкретной задачи (2026-07-18, explicit product-owner
 * request): куда она делась, как в неё зайти из терминала (копируемая `cd`
 * команда через CodeBlock), кнопки "занести в чекаут"/"удалить" именно для
 * ЭТОГО run'а - не путать с ObserversPanel-стилем "все сразу", тут заведомо
 * один run = один набор worktree. Локальный state вместо похода в родительский
 * developTurns/activeDevelop - после completion эти записи больше не
 * поллятся (см. pollDevelopStatus), так что действия кнопок обязаны сами
 * обновлять то, что видно на экране.
 */
/**
 * Own action state per physical repo (2026-07-19, live user request: a
 * 4-path run had ONE shared "занести"/"удалить" pair acting on all 4
 * worktrees at once - each needed its own, since merging/removing api's
 * worktree has nothing to do with web/gui/cli's). REST calls now carry
 * `label` so the backend only touches this one.
 */
function DevelopWorktreeRow({
  runId,
  worktree,
  outcome,
  onMerged,
  onRemoved,
}: {
  runId: string;
  worktree: DevelopRunStatusView["worktrees"][number];
  outcome: DevelopMergeOutcomeView | null;
  onMerged: (outcome: DevelopMergeOutcomeView) => void;
  onRemoved: () => void;
}) {
  const [merging, setMerging] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  async function handleMerge() {
    setMerging(true);
    setActionError(null);

    try {
      const response = await fetchJsonWithTimeout<{ outcomes: DevelopMergeOutcomeView[] }>(
        `${API_BASE_URL}/api/develop/merge-to-checkout`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ runId, label: worktree.label }) },
      );
      const own = response.outcomes.find((item) => item.label === worktree.label);

      if (own) {
        onMerged(own);
      }
    } catch (mergeError) {
      setActionError(mergeError instanceof Error ? mergeError.message : "Не удалось занести в чекаут.");
    } finally {
      setMerging(false);
    }
  }

  async function handleCleanup() {
    setCleaning(true);
    setActionError(null);

    try {
      await fetchJsonWithTimeout(
        `${API_BASE_URL}/api/develop/cleanup-worktree`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ runId, label: worktree.label }) },
      );
      onRemoved();
    } catch (cleanupError) {
      setActionError(cleanupError instanceof Error ? cleanupError.message : "Не удалось удалить worktree.");
    } finally {
      setCleaning(false);
    }
  }

  return (
    <div className="develop-worktree-entry">
      <span className="develop-worktree-meta">{worktree.label} · ветка {worktree.branch}</span>
      <CodeBlock language="bash" code={`cd ${worktree.worktreePath}`} />

      {outcome ? <DevelopMergeOutcomeList outcomes={[outcome]} /> : null}

      <div className="action-row">
        <button type="button" className="ghost-button" onClick={() => void handleMerge()} disabled={merging || cleaning}>
          {merging ? "Заношу..." : "Занести в текущий чекаут"}
        </button>
        <button type="button" className="ghost-button danger-button" onClick={() => void handleCleanup()} disabled={merging || cleaning}>
          {cleaning ? "Удаляю..." : "Удалить этот worktree"}
        </button>
      </div>

      {actionError ? <p className="message-footnote">{actionError}</p> : null}
    </div>
  );
}

function DevelopWorktreePanel({ run }: { run: DevelopRunStatusView }) {
  const [worktrees, setWorktrees] = useState(run.worktrees);
  const [outcomes, setOutcomes] = useState<Record<string, DevelopMergeOutcomeView>>(() => {
    const initial: Record<string, DevelopMergeOutcomeView> = {};

    for (const outcome of run.autoMergeOutcome ?? []) {
      initial[outcome.label] = outcome;
    }

    return initial;
  });

  if (worktrees.length === 0) {
    const remaining = Object.values(outcomes);

    if (remaining.length === 0) {
      return null;
    }

    return (
      <div className="develop-worktree-panel">
        <p className="message-label">Занесено в чекаут</p>
        <DevelopMergeOutcomeList outcomes={remaining} />
      </div>
    );
  }

  return (
    <div className="develop-worktree-panel">
      <p className="message-label">Worktree этой задачи</p>
      {worktrees.map((worktree) => (
        <DevelopWorktreeRow
          key={worktree.label}
          runId={run.runId}
          worktree={worktree}
          outcome={outcomes[worktree.label] ?? null}
          onMerged={(outcome) => setOutcomes((current) => ({ ...current, [outcome.label]: outcome }))}
          onRemoved={() => setWorktrees((current) => current.filter((item) => item.label !== worktree.label))}
        />
      ))}
    </div>
  );
}

function DevelopRunMessage({ run }: { run: DevelopRunStatusView }) {
  const result = run.result ?? null;
  const running = run.status === "running";
  const lastReview = result?.reviews.length ? result.reviews[result.reviews.length - 1] : null;
  const durationLabel = !running ? developRunDurationLabel(run) : null;

  return (
    <div className="message assistant-message">
      <div className="message-badge">Dev</div>
      <div className="message-card">
        {running ? (
          <ThinkingIndicator currentStageLabel={developPhaseLabel(run.progress)} startedAt={run.startedAt} />
        ) : null}

        {!running && run.status === "failed" ? (
          <>
            <p className="message-label">Разработка завершилась ошибкой{durationLabel ? ` · за ${durationLabel}` : ""}</p>
            <p>{safeText(run.errorMessage || result?.error, "Неизвестная ошибка — детали в телеметрии developer_runs.")}</p>
          </>
        ) : null}

        {!running && run.status === "completed" && result ? (
          <>
            {durationLabel ? <p className="message-label">Готово · за {durationLabel}</p> : null}

            {result.stopped === "needs-approval" && result.pendingApproval ? (
              <>
                <span className="develop-verdict develop-verdict-clarify">Требуется апрув: чувствительная команда БД</span>
                <p className="message-label">Разработчик хочет выполнить:</p>
                <pre className="develop-pending-command">$ {result.pendingApproval.command}</pre>
                <p>{safeText(result.pendingApproval.reason)}</p>
                <p className="message-footnote">Это изменение схемы/данных, которое git не откатит — подтверди или отклони прямо в чате (например «да» / «нет»).</p>
              </>
            ) : result.stopped === "needs-clarification" ? (
              <>
                <p className="message-label">Уточняющий вопрос перед разработкой</p>
                <h3>{safeText(result.clarificationQuestion, "Нужно уточнение по задаче")}</h3>
                <p className="message-footnote">Ответь прямо в чате — разработка продолжится с учётом ответа.</p>
              </>
            ) : (
              <>
                <span className={developVerdictBadge(result).className}>{developVerdictBadge(result).label}</span>
                {result.summary ? <AnswerMarkdown text={result.summary} /> : null}

                {lastReview && lastReview.findings.length > 0 ? (
                  <div className="develop-findings">
                    <p className="message-label">Замечания ревью (последний раунд)</p>
                    <ul>
                      {lastReview.findings.map((finding, index) => (
                        <li key={index}>{renderInlineMarkdown(finding)}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {lastReview && safeList(lastReview.noteFindings).length > 0 ? (
                  <div className="develop-verification">
                    <p className="message-label">Неблокирующие заметки</p>
                    <ul>
                      {safeList(lastReview.noteFindings).map((finding, index) => (
                        <li key={index}>{renderInlineMarkdown(finding)}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {result.verificationLog.length > 0 ? (
                  <div className="develop-verification">
                    <p className="message-label">Верификация</p>
                    <ul>
                      {result.verificationLog.map((entry, index) => (
                        <li key={index}>
                          <code>$ {entry.command}</code> → exit {entry.exitCode}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {(result.totalPromptTokens > 0 || result.totalCompletionTokens > 0) ? (
                  <div className="develop-verification">
                    <p className="message-label">Токены</p>
                    <ul>
                      <li>Prompt: {result.totalPromptTokens.toLocaleString("ru-RU")}</li>
                      <li>Completion: {result.totalCompletionTokens.toLocaleString("ru-RU")}</li>
                      <li>Итого: {(result.totalPromptTokens + result.totalCompletionTokens).toLocaleString("ru-RU")}</li>
                    </ul>
                  </div>
                ) : null}

                {result.diff.trim() ? (
                  <details className="develop-diff">
                    <summary>Diff ({result.changedFiles.length} файл(ов): {result.changedFiles.join(", ")})</summary>
                    <pre>{result.diff}</pre>
                  </details>
                ) : null}

                <DevelopWorktreePanel run={run} />
              </>
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}

function WorktreeManagerSidebar({
  projectName,
  conversationId,
}: {
  projectName: string;
  conversationId: string | null;
}) {
  const [entries, setEntries] = useState<DevelopWorktreeRegistryEntryView[]>([]);
  const [openProjects, setOpenProjects] = useState<Record<string, boolean>>({});
  const [openChats, setOpenChats] = useState<Record<string, boolean>>({});
  const [selectedTreeIds, setSelectedTreeIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refreshTimerRef = useRef<number | null>(null);

  async function loadWorktrees(signal?: AbortSignal) {
    setError(null);

    try {
      const response = await fetchJsonWithTimeout<{ entries: DevelopWorktreeRegistryEntryView[] }>(
        `${API_BASE_URL}/api/develop/worktrees`,
        signal ? { signal } : undefined,
      );

      setEntries(safeList(response.entries));
      setOpenProjects((current) => {
        const next = { ...current };

        for (const entry of safeList(response.entries)) {
          if (next[entry.projectPath] === undefined) {
            next[entry.projectPath] = entry.conversationId === conversationId;
          }
        }

        return next;
      });
      setOpenChats((current) => {
        const next = { ...current };

        for (const entry of safeList(response.entries)) {
          const chatKey = `${entry.projectPath}::${entry.conversationId}`;
          if (next[chatKey] === undefined) {
            next[chatKey] = entry.conversationId === conversationId;
          }
        }

        return next;
      });
    } catch (loadError) {
      if (!(loadError instanceof Error) || loadError.name !== "AbortError") {
        setError(loadError instanceof Error ? loadError.message : "Не удалось загрузить worktree.");
      }
    }
  }

  function scheduleRefresh(delayMs = 0) {
    if (refreshTimerRef.current !== null) {
      window.clearTimeout(refreshTimerRef.current);
    }

    refreshTimerRef.current = window.setTimeout(() => {
      void loadWorktrees();
      refreshTimerRef.current = null;
    }, delayMs);
  }

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void loadWorktrees(controller.signal).finally(() => setLoading(false));
    const timer = window.setInterval(() => {
      void loadWorktrees();
    }, 1500);

    return () => {
      controller.abort();
      window.clearInterval(timer);
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current);
      }
    };
  }, [conversationId]);

  const groupedProjects = groupWorktreeEntries(entries);
  const allTreeIds = groupedProjects.flatMap((projectGroup) =>
    projectGroup.chats.flatMap((chatGroup) => chatGroup.worktrees.map((worktree) => worktreeTreeId(worktree.runId, worktree.label))),
  );
  const selectedCount = selectedTreeIds.size;
  const allSelected = allTreeIds.length > 0 && selectedTreeIds.size === allTreeIds.length;

  function toggleSelectAll() {
    if (allSelected) {
      setSelectedTreeIds(new Set());
      return;
    }

    setSelectedTreeIds(new Set(allTreeIds));
  }

  function toggleTreeSelection(treeIds: string[], checked: boolean) {
    setSelectedTreeIds((current) => {
      const next = new Set(current);

      for (const treeId of treeIds) {
        if (checked) {
          next.add(treeId);
        } else {
          next.delete(treeId);
        }
      }

      return next;
    });
  }

  function collectSelectedTargets() {
    const targetMap = new Map<string, { runId: string; label?: string }>();

    for (const projectGroup of groupedProjects) {
      for (const chatGroup of projectGroup.chats) {
        for (const worktree of chatGroup.worktrees) {
          const treeId = worktreeTreeId(worktree.runId, worktree.label);
          if (selectedTreeIds.has(treeId)) {
            targetMap.set(treeId, { runId: worktree.runId, label: worktree.label });
          }
        }
      }
    }

    return [...targetMap.values()];
  }

  async function cleanupTargets(targets: Array<{ runId: string; label?: string }>) {
    if (!targets.length) {
      return;
    }

    setCleaning(true);
    setError(null);

    try {
      await Promise.all(
        targets.map((target) =>
          fetchJsonWithTimeout(`${API_BASE_URL}/api/develop/cleanup-worktree`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(target),
          }),
        ),
      );

      setEntries((current) =>
        current
          .map((entry) => {
            const touched = targets.filter((target) => target.runId === entry.runId);

            if (touched.length === 0) {
              return entry;
            }

            const labelsToRemove = new Set(touched.map((target) => target.label).filter(Boolean) as string[]);

            return {
              ...entry,
              worktrees: labelsToRemove.size > 0
                ? entry.worktrees.filter((worktree) => !labelsToRemove.has(worktree.label))
                : [],
            };
          })
          .filter((entry) => entry.worktrees.length > 0),
      );
      setSelectedTreeIds(new Set());
      scheduleRefresh(150);
    } catch (cleanupError) {
      setError(cleanupError instanceof Error ? cleanupError.message : "Не удалось удалить выбранные worktree.");
    } finally {
      setCleaning(false);
    }
  }

  return (
    <aside className="worktree-sidebar">
      <div className="worktree-sidebar-head">
        <p className="section-kicker">Git Worktree</p>
        <h2>Менеджер деревьев</h2>
        <span>{conversationId ? `${projectName} · текущий чат активен` : "Все проекты и чаты"}</span>
      </div>

      {groupedProjects.length > 0 ? (
        <div className="worktree-sidebar-toolbar">
          <label className="history-select-all">
            <input type="checkbox" checked={allSelected} onChange={toggleSelectAll} />
            Все
          </label>
          <span className="worktree-run-meta">
            {groupedProjects.length} проектов · {groupedProjects.reduce((count, projectGroup) => count + projectGroup.chats.length, 0)} чатов · {allTreeIds.length} деревьев
          </span>
        </div>
      ) : null}

      {loading && entries.length === 0 ? <p className="muted">Загружаю worktree...</p> : null}
      {error ? <p className="message-footnote">{error}</p> : null}
      {!loading && entries.length === 0 ? <p className="muted">Активных worktree сейчас нет.</p> : null}

      <div className="worktree-sidebar-list">
        {groupedProjects.map((projectGroup) => {
          const projectPathKey = projectGroup.projectPath;
          const projectOpen = openProjects[projectPathKey] ?? true;
          const projectTargets = projectGroup.chats.flatMap((chat) => chat.worktrees.map((worktree) => ({ runId: worktree.runId, label: worktree.label })));
          const projectTreeIds = projectGroup.chats.flatMap((chatGroup) => chatGroup.worktrees.map((worktree) => worktreeTreeId(worktree.runId, worktree.label)));
          const projectSelected = projectTreeIds.length > 0 && projectTreeIds.every((treeId) => selectedTreeIds.has(treeId));

          return (
            <section key={projectPathKey} className="worktree-run-card">
              <div className="worktree-run-toggle worktree-run-toggle-project">
                <label className="worktree-select-row worktree-select-row-grow">
                  <input
                    type="checkbox"
                    checked={projectSelected}
                    onChange={(event) => toggleTreeSelection(projectTreeIds, event.target.checked)}
                  />
                  <span className="worktree-run-title">{projectPathKey.split("/").filter(Boolean).slice(-1)[0] ?? projectPathKey}</span>
                </label>
                <div className="worktree-run-actions">
                  <span className="worktree-run-meta">{projectGroup.chats.length} чатов · {projectTargets.length} деревьев</span>
                  <button
                    type="button"
                    className="worktree-accordion-button"
                    onClick={() => setOpenProjects((current) => ({ ...current, [projectPathKey]: !projectOpen }))}
                    aria-expanded={projectOpen}
                    aria-label={projectOpen ? "Свернуть проект" : "Развернуть проект"}
                  >
                    {projectOpen ? "▾" : "▸"}
                  </button>
                  <button type="button" className="ghost-button danger-button" onClick={() => void cleanupTargets(projectTargets)} disabled={cleaning}>
                    {cleaning ? "..." : "Удалить"}
                  </button>
                </div>
              </div>

              {projectOpen ? (
                <div className="worktree-run-body">
                  {projectGroup.chats.map((chatGroup) => {
                    const chatKey = `${projectPathKey}::${chatGroup.conversationId}`;
                    const chatTreeIds = chatGroup.worktrees.map((worktree) => worktreeTreeId(worktree.runId, worktree.label));
                    const chatSelected = chatTreeIds.length > 0 && chatTreeIds.every((treeId) => selectedTreeIds.has(treeId));
                    const chatOpen = openChats[chatKey] ?? chatGroup.conversationId === conversationId;
                    const chatTargets = chatGroup.worktrees.map((worktree) => ({ runId: worktree.runId, label: worktree.label }));

                    return (
                      <section key={`${projectPathKey}:${chatGroup.conversationId}`} className="worktree-chat-card">
                        <div className="worktree-run-toggle worktree-run-toggle-chat">
                          <label className="worktree-select-row worktree-select-row-grow">
                            <input
                              type="checkbox"
                              checked={chatSelected}
                              onChange={(event) => toggleTreeSelection(chatTreeIds, event.target.checked)}
                            />
                            <span className="worktree-run-title">{chatGroup.conversationId === conversationId ? "Текущий чат" : `Чат ${chatGroup.conversationId.slice(0, 8)}`}</span>
                          </label>
                          <div className="worktree-run-actions">
                            <span className="worktree-run-meta">
                              {chatGroup.worktrees.length} деревьев · {chatGroup.status === "running" ? "в работе" : chatGroup.status === "completed" ? "готово" : "ошибка"}
                            </span>
                            <button
                              type="button"
                              className="worktree-accordion-button"
                              onClick={() => setOpenChats((current) => ({ ...current, [chatKey]: !chatOpen }))}
                              aria-expanded={chatOpen}
                              aria-label={chatOpen ? "Свернуть чат" : "Развернуть чат"}
                            >
                              {chatOpen ? "▾" : "▸"}
                            </button>
                            <button type="button" className="ghost-button danger-button" onClick={() => void cleanupTargets(chatTargets)} disabled={cleaning}>
                              {cleaning ? "..." : "Удалить"}
                            </button>
                          </div>
                        </div>

                        {chatOpen ? (
                          <div className="worktree-run-body">
                            <p className="worktree-run-task">{chatGroup.task}</p>
                            {chatGroup.entries.length > 1 ? (
                              <p className="worktree-run-meta">Ранов в этом чате: {chatGroup.entries.length}</p>
                            ) : null}
                            {chatGroup.usage ? (
                              <p className="worktree-run-usage">
                                {chatGroup.usage.totalTokens.toLocaleString("ru-RU")} ток. · prompt {chatGroup.usage.promptTokens.toLocaleString("ru-RU")} · completion {chatGroup.usage.completionTokens.toLocaleString("ru-RU")}
                              </p>
                            ) : null}

                            {chatGroup.worktrees.map((worktree) => {
                              const treeId = worktreeTreeId(worktree.runId, worktree.label);
                              return (
                                <div key={treeId} className="worktree-tree-block">
                                  <label className="worktree-select-row worktree-select-row-tree">
                                    <input
                                      type="checkbox"
                                      checked={selectedTreeIds.has(treeId)}
                                      onChange={() => setSelectedTreeIds((current) => {
                                        const next = new Set(current);
                                        if (next.has(treeId)) {
                                          next.delete(treeId);
                                        } else {
                                          next.add(treeId);
                                        }
                                        return next;
                                      })}
                                    />
                                    <span className="worktree-run-meta">{worktree.label}</span>
                                  </label>
                                  <DevelopWorktreeRow
                                    runId={worktree.runId}
                                    worktree={worktree}
                                    outcome={chatGroup.autoMergeOutcome.find((outcome) => outcome.label === worktree.label) ?? null}
                                    onMerged={() => {}}
                                    onRemoved={() => {
                                      setEntries((current) =>
                                        current
                                          .map((candidate) =>
                                            candidate.runId === worktree.runId
                                              ? { ...candidate, worktrees: candidate.worktrees.filter((candidateTree) => candidateTree.label !== worktree.label) }
                                              : candidate,
                                          )
                                          .filter((candidate) => candidate.worktrees.length > 0),
                                      );
                                      setSelectedTreeIds((current) => {
                                        const next = new Set(current);
                                        next.delete(treeId);
                                        return next;
                                      });
                                      scheduleRefresh(150);
                                    }}
                                  />
                                </div>
                              );
                            })}
                          </div>
                        ) : null}
                      </section>
                    );
                  })}
                </div>
              ) : null}
            </section>
          );
        })}
      </div>

      {selectedCount > 0 ? (
        <div className="worktree-bulk-actions">
          <button
            type="button"
            className="history-delete-selected"
            disabled={cleaning}
            onClick={() => {
              void cleanupTargets(collectSelectedTargets());
            }}
          >
            {cleaning ? "Удаляю..." : `Удалить выбранное (${selectedCount})`}
          </button>
        </div>
      ) : null}
    </aside>
  );
}

const USAGE_ROLE_LABELS: Record<string, string> = {
  researcher: "Researcher",
  critic: "Critic",
  other: "Прочее (пайплайн + классификация)",
};

/**
 * Раскладка токенов по ролям (2026-07-18, по прямому запросу: "роль - токены
 * - множитель = столько"). Множитель ищется в уже загруженном каталоге
 * моделей провайдера (providerModels) - бэкенд отдаёт только id модели, не
 * сам множитель, чтобы не дублировать источник истины. Роль без известного
 * множителя (частый случай для "Прочее" - там вперемешку несколько моделей)
 * показывает только сырые токены и честную подпись, а не молчит и не врёт нулём.
 */
function UsageBreakdown({ usage, providerModels }: { usage: ProviderUsageSummary; providerModels: ProviderModelRecord[] }) {
  const rows = usage.byRole?.length
    ? usage.byRole
    : [{ role: "other" as const, model: "", promptTokens: usage.promptTokens, completionTokens: usage.completionTokens, totalTokens: usage.totalTokens, callCount: usage.callCount }];

  return (
    <div className="usage-breakdown">
      {rows.map((row) => {
        const multiplier = findModelMultiplier(providerModels, row.model);
        const adjusted = multiplier !== null ? Math.round(row.totalTokens * multiplier) : null;

        return (
          <div key={row.role} className="usage-breakdown-row">
            <span className="usage-breakdown-role">
              {USAGE_ROLE_LABELS[row.role] ?? row.role}
              {row.model ? <em> · {row.model}</em> : null}
            </span>
            <span className="usage-breakdown-value">
              {row.totalTokens.toLocaleString("ru-RU")} ток.
              {multiplier !== null && adjusted !== null
                ? ` × ${multiplier}x = ${adjusted.toLocaleString("ru-RU")}`
                : " (множитель не найден)"}
              {" · "}{row.callCount} вызов(ов)
            </span>
          </div>
        );
      })}
      <div className="usage-breakdown-row usage-breakdown-total">
        <span className="usage-breakdown-role">Итого</span>
        <span className="usage-breakdown-value">
          {usage.totalTokens.toLocaleString("ru-RU")} ток. · {usage.callCount} вызов(ов)
        </span>
      </div>
    </div>
  );
}

function AssistantRunMessage({
  runStatus,
  result,
  providerModels,
  onOpenInspector,
  clarificationRound,
  onSelectClarification,
  onRetry,
}: {
  runStatus: PipelineRunStatus | null;
  result: PipelineRunResult | null;
  providerModels: ProviderModelRecord[];
  onOpenInspector: (tab?: InspectorTab) => void;
  clarificationRound: number;
  onSelectClarification: (moduleKey: string) => void;
  onRetry: () => void;
}) {
  const running = runStatus && (runStatus.status === "queued" || runStatus.status === "running");
  const completed = hasRunArtifacts(result) && (!runStatus || runStatus.runId === result.runId);
  const failed = runStatus?.status === "failed";
  // Circuit breaker: после MAX_CLARIFICATION_ROUNDS не показываем chips
  // повторно, даже если бэкенд снова вернул clarification-needed — иначе
  // риск бесконечного цикла уточнений. Рендерим как обычный ответ.
  const needsClarification =
    completed && result?.answer?.answerMode === "clarification-needed" && clarificationRound < MAX_CLARIFICATION_ROUNDS;

  // Метрики/лимиты/execution preview раньше всегда были развёрнуты прямо в
  // теле ответа — рядом с текстом ответа одновременно висели проценты
  // уверенности, ограничения и превью плана, из-за чего сообщение не
  // читалось как обычный чат-ответ. Теперь это скрыто за тогглом и
  // сворачивается заново на каждый новый ответ.
  const [showDetails, setShowDetails] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setShowDetails(false);
    setCopied(false);
  }, [result?.runId]);

  async function handleCopyAnswer() {
    const answerText = safeText(
      result?.answer?.explanation,
      result?.research.functionalSummary || "",
    );

    if (!answerText) {
      return;
    }

    try {
      await navigator.clipboard.writeText(answerText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API недоступен (например, не-secure context) — тихо игнорируем.
    }
  }

  if (!running && !completed && !failed) {
    return (
      <div className="message assistant-message">
        <div className="message-badge">Client</div>
        <div className="message-card">
          <h3>Готов ответить по проекту</h3>
          <p>Выбери проект, провайдера и модель, затем задай инженерный вопрос. Client возьмёт уже собранную карту проекта, добавит твой вопрос в контекст и вернёт прикладной ответ.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="message assistant-message">
      <div className="message-badge">Client</div>
      <div className="message-card">
        {running ? (
          <>
            <ThinkingIndicator
              {...(runStatus?.currentStageLabel ? { currentStageLabel: runStatus.currentStageLabel } : {})}
              {...(runStatus?.createdAt ? { startedAt: runStatus.createdAt } : {})}
            />
            <div className="action-row">
              <button type="button" className="ghost-button" onClick={() => onOpenInspector("overview")}>
                Подробнее
              </button>
            </div>
          </>
        ) : null}

        {failed ? (
          <>
            <p className="message-label">Run завершился ошибкой</p>
            <h3>Нужно проверить сервер или пересоздать запуск</h3>
            <p>{safeText(runStatus?.errorMessage, "Причина ошибки недоступна.")}</p>
            {runStatus?.resumeContext?.canResumeFromStart ? (
              <div className="action-row">
                <button type="button" className="primary-button" onClick={onRetry}>
                  Повторить вопрос
                </button>
              </div>
            ) : null}
          </>
        ) : null}

        {completed && needsClarification ? (
          <>
            {/* Суженная ветка: quick-grid/план намеренно не показываем — иначе
                рядом с "уточните вопрос" будет показан уверенный конкретный
                план для одной из отброшенных интерпретаций. */}
            <p className="message-label">Нужно уточнение · {safeText(result.project.name, "Проект неизвестен")}</p>
            <h3>{renderInlineMarkdown(safeText(result?.answer?.summary, "Уточните вопрос"))}</h3>
            <div className="chat-suggestions">
              {safeList(result?.answer?.clarificationOptions).map((moduleKey) => (
                <button key={moduleKey} type="button" className="ghost-button" onClick={() => onSelectClarification(moduleKey)}>
                  {getModuleLabel(moduleKey)}
                </button>
              ))}
            </div>
          </>
        ) : null}

        {completed && !needsClarification ? (
          <>
            <p className="message-label">
              Ответ подготовлен · {safeText(result.project.name, "Проект неизвестен")}
              {runStatus && runStatus.runId === result.runId && runStatus.status === "completed"
                ? ` · за ${formatRunDuration(Math.max(1, Math.round((new Date(runStatus.updatedAt).getTime() - new Date(runStatus.createdAt).getTime()) / 1000)))}`
                : ""}
            </p>
            {/* h3-сводка убрана (2026-07-16): первая фраза ответа и есть прямой
                ответ (так требует промпт синтеза), а жирный дубль сверху делал
                сообщение похожим на сгенерированный отчёт, а не живой чат. */}
            <AnswerMarkdown
              text={safeText(
                result.answer?.explanation,
                result.research.functionalSummary || "Функциональная картина пока не сформирована.",
              )}
            />

            <div className="action-row">
              <button type="button" className="ghost-button" onClick={() => void handleCopyAnswer()}>
                {copied ? "Скопировано" : "Копировать ответ"}
              </button>
              <button type="button" className="ghost-button" onClick={() => setShowDetails((value) => !value)}>
                {showDetails ? "Скрыть детали" : "Подробнее"}
              </button>
              <button type="button" className="ghost-button" onClick={() => onOpenInspector("overview")}>
                Почему я так ответил
              </button>
            </div>

            {showDetails ? (
              <>
                <div className="result-quick-grid">
                  <div className="result-card">
                    <strong>Ответ</strong>
                    <span>{safeCount(result.answer?.confidence)}% уверенность</span>
                  </div>
                  <div className="result-card">
                    <strong>Impact</strong>
                    <span>{safeCount(result.impact.confidence)}% уверенность</span>
                  </div>
                  <div className="result-card">
                    <strong>Context</strong>
                    <span>{safeCount(result.context.estimatedTokens)} токенов</span>
                  </div>
                  <div className="result-card">
                    <strong>Plan</strong>
                    <span>{safeList(result.plan.steps).length} шагов</span>
                  </div>
                </div>

                {result.usage ? <UsageBreakdown usage={result.usage} providerModels={providerModels} /> : null}

                {safeList(result.answer?.warnings).length ? (
                  <div className="execution-preview-card">
                    <div>
                      <p className="message-label">Ограничения</p>
                      <strong>{safeList(result.answer?.warnings).join(" ")}</strong>
                    </div>
                  </div>
                ) : null}

                <div className="execution-preview-card">
                  <div>
                    <p className="message-label">План реализации</p>
                    <strong>{safeText(result.executionPreview.summary)}</strong>
                  </div>
                  <div className="execution-preview-metrics">
                    <span>Файлы: {safeList(result.plan.targetFiles).length || safeList(result.impact.affectedFiles).length}</span>
                    <span>Модули: {safeList(result.plan.targetModules).length || safeList(result.research.affectedModules).length}</span>
                    <span>Шагов: {safeList(result.plan.steps).length}</span>
                  </div>
                </div>
              </>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}

function OverviewPanel({ result }: { result: PipelineRunResult | null }) {
  if (!hasRunArtifacts(result)) {
    return (
      <article className="inspector-panel">
        <div className="panel-header">
          <h2>Обзор run</h2>
          <span>Ожидание</span>
        </div>
        <p className="muted">Inspector наполнится после завершения хотя бы одного run.</p>
      </article>
    );
  }

  return (
    <article className="inspector-panel">
      <div className="panel-header">
        <h2>Обзор run</h2>
        <span>{safeText(result.runId.slice(0, 8))}</span>
      </div>

      <div className="stack">
        <div className="list">
          <div className="list-item">
            <strong>Финальный ответ</strong>
            <span>{safeText(result.answer?.summary, "Недоступно")}</span>
          </div>
          <div className="list-item">
            <strong>Проект</strong>
            <span>{safeText(result.project.name)}</span>
          </div>
          <div className="list-item">
            <strong>Путь</strong>
            <span>{safeText(result.project.rootPath)}</span>
          </div>
          <div className="list-item">
            <strong>Провайдер / модель</strong>
            <span>
              {safeText(result.provider.baseUrl)} / {safeText(result.provider.model)}
            </span>
          </div>
          <div className="list-item">
            <strong>Knowledge saved at</strong>
            <span>{formatDateTime(result.knowledge.savedAt)}</span>
          </div>
          <div className="list-item">
            <strong>Синтез ответа</strong>
            <span>{safeText(result.answer?.synthesis, "Недоступно")}</span>
          </div>
        </div>

        <div className="mini-stats">
          <div className="mini-stat">
            <strong>{safeCount(result.index.manifest.fileCount)}</strong>
            <span>файлов</span>
          </div>
          <div className="mini-stat">
            <strong>{safeCount(result.index.manifest.symbolCount)}</strong>
            <span>символов</span>
          </div>
          <div className="mini-stat">
            <strong>{safeCount(result.graph.summary.nodeCount)}</strong>
            <span>узлов graph</span>
          </div>
        </div>

        <div className="chip-row">
          {Object.entries(result.project.summary.languages ?? {}).map(([language, count]) => (
            <span key={language} className="chip">
              {language}: {count}
            </span>
          ))}
        </div>
      </div>
    </article>
  );
}

function ResearchPanel({ result }: { result: PipelineRunResult | null }) {
  const findings = hasRunArtifacts(result) ? safeList(result.research?.findings) : [];
  const baselineFindings = hasRunArtifacts(result) ? safeList(result.research?.baselineFindings) : [];
  const overlayFindings = hasRunArtifacts(result) ? safeList(result.research?.overlayFindings) : [];
  const evidence = hasRunArtifacts(result) ? safeList(result.research?.evidence).slice(0, 6) : [];
  const moduleIntents = hasRunArtifacts(result) ? safeList(result.research?.moduleIntents).slice(0, 3) : [];
  const entryPoints = hasRunArtifacts(result) ? safeList(result.research?.entryPoints).slice(0, 4) : [];
  const sideEffects = hasRunArtifacts(result) ? safeList(result.research?.sideEffects).slice(0, 4) : [];

  return (
    <article className="inspector-panel">
      <div className="panel-header">
        <h2>Research Report</h2>
        <span>{hasRunArtifacts(result) ? `${safeCount(result.research?.confidence)}%` : "Ожидание"}</span>
      </div>

      {hasRunArtifacts(result) ? (
        <div className="stack">
          <p>{safeText(result.research?.summary)}</p>
          <div className="list">
            <div className="list-item">
              <strong>Происхождение фактов</strong>
              <span>
                baseline {safeCount(result.research?.evidenceSummary?.baselineCount)} · overlay {safeCount(result.research?.evidenceSummary?.overlayCount)} · structural {safeCount(result.research?.evidenceSummary?.structuralCount)}
              </span>
            </div>
          </div>
          <div className="list">
            <div className="list-item">
              <strong>Что делает затронутая зона</strong>
              <span>{safeText(result.research?.functionalSummary)}</span>
            </div>
          </div>
          <div className="list">
            {moduleIntents.length ? (
              moduleIntents.map((intent) => (
                <div key={intent.module} className="list-item">
                  <strong>Выбранный модуль: {intent.module}</strong>
                  <span>{intent.reasons.join(" ")}</span>
                </div>
              ))
            ) : (
              <PanelFallback title="Модульный приоритет" message="Для этого запуска research не смог уверенно выделить функциональный модуль." />
            )}
          </div>
          <div className="list">
            {entryPoints.length ? (
              entryPoints.map((entryPoint) => (
                <div key={entryPoint} className="list-item">
                  <strong>Точка входа</strong>
                  <span>{entryPoint}</span>
                </div>
              ))
            ) : (
              <PanelFallback title="Точки входа" message="Для этого запуска точки входа не выделены." />
            )}
          </div>
          <div className="list">
            {sideEffects.length ? (
              sideEffects.map((effect) => (
                <div key={effect} className="list-item">
                  <strong>Побочный эффект</strong>
                  <span>{effect}</span>
                </div>
              ))
            ) : (
              <PanelFallback title="Побочные эффекты" message="Для этого запуска побочные эффекты не подтверждены." />
            )}
          </div>
          <div className="list">
            {findings.length ? (
              findings.map((finding) => (
                <div key={finding} className="list-item">
                  <strong>Вывод</strong>
                  <span>{finding}</span>
                </div>
              ))
            ) : (
              <PanelFallback title="Выводы" message="Для этого запуска список findings недоступен." />
            )}
          </div>
          <div className="list">
            {baselineFindings.length ? (
              baselineFindings.map((finding) => (
                <div key={finding} className="list-item">
                  <strong>Baseline</strong>
                  <span>{finding}</span>
                </div>
              ))
            ) : (
              <PanelFallback title="Baseline facts" message="Для этого запуска отдельные baseline-backed выводы не выделены." />
            )}
          </div>
          <div className="list">
            {overlayFindings.length ? (
              overlayFindings.map((finding) => (
                <div key={finding} className="list-item">
                  <strong>Overlay</strong>
                  <span>{finding}</span>
                </div>
              ))
            ) : (
              <PanelFallback title="Overlay facts" message="Для этого запуска локальный worktree overlay не повлиял на итоговые выводы." />
            )}
          </div>
          <div className="list">
            {evidence.length ? (
              evidence.map((item) => (
                <div key={item.id} className="list-item">
                  <strong>{item.label}</strong>
                  <span>
                    оценка {item.score} / {item.reason} / источник: {item.origin}
                  </span>
                </div>
              ))
            ) : (
              <PanelFallback title="Опорные данные" message="Для этого запуска опорные данные недоступны." />
            )}
          </div>
        </div>
      ) : (
        <p className="muted">Запусти pipeline, чтобы получить детерминированный research report.</p>
      )}
    </article>
  );
}

function ImpactPanel({ result }: { result: PipelineRunResult | null }) {
  const risks = hasRunArtifacts(result) ? safeList(result.impact?.risks).slice(0, 6) : [];
  const scope = hasRunArtifacts(result) ? safeList(result.impact?.validationScope).slice(0, 6) : [];

  return (
    <article className="inspector-panel">
      <div className="panel-header">
        <h2>Impact Report</h2>
        <span>{hasRunArtifacts(result) ? `${safeCount(result.impact?.confidence)}%` : "Ожидание"}</span>
      </div>

      {hasRunArtifacts(result) ? (
        <div className="stack">
          <p>{safeText(result.impact?.summary)}</p>
          <div className="list">
            <div className="list-item">
              <strong>Затронутые файлы</strong>
              <span>{safeList(result.impact?.affectedFiles).join(", ") || "Не определены"}</span>
            </div>
            <div className="list-item">
              <strong>Затронутые символы</strong>
              <span>{safeList(result.impact?.affectedSymbols).join(", ") || "Не определены"}</span>
            </div>
          </div>
          <div className="list">
            {risks.length ? (
              risks.map((risk) => (
                <div key={risk} className="list-item">
                  <strong>Риск</strong>
                  <span>{risk}</span>
                </div>
              ))
            ) : (
              <PanelFallback title="Риски" message="Для этого запуска риски impact-анализа недоступны." />
            )}
          </div>
          <div className="list">
            {scope.length ? (
              scope.map((item) => (
                <div key={item} className="list-item">
                  <strong>Проверка</strong>
                  <span>{item}</span>
                </div>
              ))
            ) : (
              <PanelFallback title="Проверки" message="Для этого запуска validation scope недоступен." />
            )}
          </div>
        </div>
      ) : (
        <p className="muted">Impact-анализ появится после завершения research.</p>
      )}
    </article>
  );
}

function ContextPanel({ result }: { result: PipelineRunResult | null }) {
  const chunks = hasRunArtifacts(result) ? safeList(result.context?.selectedChunks).slice(0, 6) : [];
  const highlights = hasRunArtifacts(result) ? safeList(result.context?.functionalHighlights).slice(0, 4) : [];
  const focusZones = hasRunArtifacts(result) ? safeList(result.context?.focusZones).slice(0, 6) : [];
  const rankingSummary = hasRunArtifacts(result) ? safeList(result.context?.rankingSummary).slice(0, 4) : [];

  return (
    <article className="inspector-panel">
      <div className="panel-header">
        <h2>Context Package</h2>
        <span>{hasRunArtifacts(result) ? `${safeCount(result.context?.confidence)}%` : "Ожидание"}</span>
      </div>

      {hasRunArtifacts(result) ? (
        <div className="stack">
          <p className="stat">
            <strong>{safeList(result.context?.selectedChunks).length}</strong> фрагментов,{" "}
            <strong>{safeList(result.context?.omittedCandidates).length}</strong> исключено,{" "}
            <strong>{safeCount(result.context?.estimatedTokens)}</strong> оценочных токенов.
          </p>
          <div className="list">
            {highlights.length ? (
              highlights.map((highlight) => (
                <div key={highlight} className="list-item">
                  <strong>Функциональный фокус</strong>
                  <span>{highlight}</span>
                </div>
              ))
            ) : (
              <PanelFallback title="Функциональный фокус" message="Для этого запуска функциональные акценты контекста не выделены." />
            )}
          </div>
          <div className="list">
            {focusZones.length ? (
              focusZones.map((zone) => (
                <div key={zone} className="list-item">
                  <strong>Focus zone</strong>
                  <span>{zone}</span>
                </div>
              ))
            ) : (
              <PanelFallback title="Focus zones" message="Для этого запуска focus zones не были выделены." />
            )}
          </div>
          <div className="list">
            {rankingSummary.length ? (
              rankingSummary.map((item) => (
                <div key={item} className="list-item">
                  <strong>Правило отбора</strong>
                  <span>{item}</span>
                </div>
              ))
            ) : (
              <PanelFallback title="Отбор контекста" message="Для этого запуска объяснение ranking не подготовлено." />
            )}
          </div>
          <div className="list">
            {chunks.length ? (
              chunks.map((chunk: ContextCandidate) => (
                <div key={chunk.id} className="list-item">
                  <strong>{safeText(chunk.label)}</strong>
                  <span>{safeText(chunk.reason)}</span>
                  <span className="subtle">
                    Приоритет: {safeText(chunk.priority)} / score: {safeCount(chunk.score)} / токены: {safeCount(chunk.tokenEstimate)}
                  </span>
                </div>
              ))
            ) : (
              <PanelFallback title="Контекст" message="Для этого запуска выбранные фрагменты недоступны." />
            )}
          </div>
        </div>
      ) : (
        <p className="muted">Context package появится здесь после research и impact.</p>
      )}
    </article>
  );
}

function PlanPanel({ result }: { result: PipelineRunResult | null }) {
  const steps = hasRunArtifacts(result) ? safeList(result.plan?.steps) : [];
  const targetModules = hasRunArtifacts(result) ? safeList(result.plan?.targetModules) : [];
  const targetFiles = hasRunArtifacts(result) ? safeList(result.plan?.targetFiles).slice(0, 8) : [];
  const entryPoints = hasRunArtifacts(result) ? safeList(result.plan?.entryPoints).slice(0, 4) : [];
  const validationScope = hasRunArtifacts(result) ? safeList(result.plan?.validationScope).slice(0, 6) : [];
  const planningNotes = hasRunArtifacts(result) ? safeList(result.plan?.planningNotes).slice(0, 6) : [];
  const dependencyChains = hasRunArtifacts(result) ? safeList(result.plan?.dependencyChains).slice(0, 6) : [];

  return (
    <article className="inspector-panel">
      <div className="panel-header">
        <h2>Execution Plan</h2>
        <span>{hasRunArtifacts(result) ? `${steps.length} шагов` : "Ожидание"}</span>
      </div>

      {hasRunArtifacts(result) ? (
        <div className="stack">
          <p>{safeText(result.plan?.summary)}</p>
          <div className="list">
            <div className="list-item">
              <strong>Стратегия</strong>
              <span>{safeText(result.plan?.strategy)}</span>
            </div>
            <div className="list-item">
              <strong>Целевые модули</strong>
              <span>{targetModules.join(", ") || "Не определены"}</span>
            </div>
            <div className="list-item">
              <strong>Точки входа плана</strong>
              <span>{entryPoints.join(", ") || "Не определены"}</span>
            </div>
          </div>
          <div className="list">
            {planningNotes.length ? (
              planningNotes.map((note) => (
                <div key={note} className="list-item">
                  <strong>Planning note</strong>
                  <span>{note}</span>
                </div>
              ))
            ) : (
              <PanelFallback title="Planning notes" message="Для этого запуска notes планирования недоступны." />
            )}
          </div>
          <div className="list">
            {dependencyChains.length ? (
              dependencyChains.map((chain) => (
                <div key={`${chain.from}-${chain.to}-${chain.reason}`} className="list-item">
                  <strong>
                    {chain.from} → {chain.to}
                  </strong>
                  <span>{chain.reason}</span>
                </div>
              ))
            ) : (
              <PanelFallback title="Dependency chains" message="Для этого запуска жёсткие graph-backed цепочки зависимостей не выделены." />
            )}
          </div>
          <div className="list">
            {steps.length ? (
              steps.map((step) => (
                <div key={step.id} className="list-item">
                  <strong>{safeText(step.title)}</strong>
                  <span>{safeText(step.description)}</span>
                  <span className="subtle">
                    Исполнитель: {safeText(step.executor)} / {step.parallelizable ? "можно параллелить" : "последовательно"}
                  </span>
                  <span className="subtle">Scope: {safeList(step.scope).slice(0, 4).join(", ") || "Не определён"}</span>
                  <span className="subtle">Outputs: {safeList(step.outputs).join(", ") || "Не определены"}</span>
                  <span className="subtle">Approval: {step.approvalRequired ? "нужно" : "не нужно"}</span>
                </div>
              ))
            ) : (
              <PanelFallback title="План" message="Для этого запуска execution plan steps недоступны." />
            )}
          </div>
          <div className="list">
            <div className="list-item">
              <strong>Целевые файлы</strong>
              <span>{targetFiles.join(", ") || "Не определены"}</span>
            </div>
            <div className="list-item">
              <strong>Validation scope</strong>
              <span>{validationScope.join(", ") || "Не определён"}</span>
            </div>
          </div>
        </div>
      ) : (
        <p className="muted">Execution plan появится здесь после завершения pipeline.</p>
      )}
    </article>
  );
}

function ExecutionPanel({ result }: { result: PipelineRunResult | null }) {
  return (
    <article className="inspector-panel">
      <div className="panel-header">
        <h2>Execution Preview</h2>
        <span>{hasRunArtifacts(result) ? "Готово" : "Ожидание"}</span>
      </div>

      {hasRunArtifacts(result) ? (
        <div className="stack">
          <div className="list">
            <div className="list-item">
              <strong>Безопасное превью выполнения</strong>
              <span>{safeText(result.executionPreview?.summary)}</span>
            </div>
            <div className="list-item compact">
              <span>Разрешено: {safeList(result.executionPreview?.allowedActions).join(", ") || "Нет данных"}</span>
            </div>
            <div className="list-item compact">
              <span>Запрещено: {safeList(result.executionPreview?.blockedActions).join(", ") || "Нет данных"}</span>
            </div>
            <div className="list-item compact">
              <span>Переиндексация: да / Обновление graph: да / Обновление knowledge: да</span>
            </div>
          </div>

          <div className="list">
            <div className="list-item">
              <strong>Controlled execution runtime</strong>
              <span>{safeText(result.executionRuntime?.summary)}</span>
            </div>
            <div className="list-item compact">
              <span>Статус: {safeText(result.executionRuntime?.status, "Недоступно")}</span>
            </div>
            <div className="list-item compact">
              <span>Разрешённые файлы: {safeList(result.executionRuntime?.allowedWriteFiles).slice(0, 8).join(", ") || "Нет данных"}</span>
            </div>
            <div className="list-item compact">
              <span>Заблокированные write-зоны: {safeList(result.executionRuntime?.blockedWriteZones).join(", ") || "Нет данных"}</span>
            </div>
            <div className="list-item compact">
              <span>Scope guards: {safeList(result.executionRuntime?.scopeGuards).slice(0, 3).join(" | ") || "Нет данных"}</span>
            </div>
            <div className="list-item compact">
              <span>Approval checks: {safeList(result.executionRuntime?.approvalChecks).slice(0, 3).join(" | ") || "Нет данных"}</span>
            </div>
          </div>
        </div>
      ) : (
        <p className="muted">Execution preview появится после planner и runtime contract layer.</p>
      )}
    </article>
  );
}

function KnowledgePanel({ result }: { result: PipelineRunResult | null }) {
  return (
    <article className="inspector-panel">
      <div className="panel-header">
        <h2>Knowledge</h2>
        <span>{hasRunArtifacts(result) ? "Сохранено" : "Ожидание"}</span>
      </div>

      {hasRunArtifacts(result) ? (
        <div className="stack">
          <div className="list">
            <div className="list-item">
              <strong>Repository Git</strong>
              <span>{result.repository?.isGitRepository ? "Подключён" : "Не обнаружен"}</span>
            </div>
            <div className="list-item">
              <strong>Base URL провайдера</strong>
              <span>{safeText(result.provider?.baseUrl, "Не задан")}</span>
            </div>
            <div className="list-item">
              <strong>Модель</strong>
              <span>{safeText(result.provider?.model, "Не задана")}</span>
            </div>
            <div className="list-item">
              <strong>API ключ</strong>
              <span>{safeText(result.provider?.apiKeyMasked, "Не задан")}</span>
            </div>
            <div className="list-item">
              <strong>Путь хранения</strong>
              <span>{safeText(result.knowledge?.storagePath)}</span>
            </div>
            <div className="list-item">
              <strong>Путь каталога</strong>
              <span>{safeText(result.knowledge?.catalogPath)}</span>
            </div>
            <div className="list-item">
              <strong>Количество артефактов</strong>
              <span>{safeCount(result.knowledge?.artifactCount)}</span>
            </div>
          </div>
        </div>
      ) : (
        <p className="muted">Knowledge layer будет виден после завершения run.</p>
      )}
    </article>
  );
}

function GitPanel({ result }: { result: PipelineRunResult | null }) {
  const repositoryChanges = hasRunArtifacts(result) ? safeList(result.repository?.changedFiles).slice(0, 12) : [];

  return (
    <article className="inspector-panel">
      <div className="panel-header">
        <h2>Git и Graph</h2>
        <span>{hasRunArtifacts(result) ? safeText(result.repository?.branch, "HEAD") : "Ожидание"}</span>
      </div>

      {hasRunArtifacts(result) ? (
        <div className="stack">
          <div className="list">
            <div className="list-item">
              <strong>Git / HEAD</strong>
              <span>{safeText(result.repository?.headCommit, "Недоступно")}</span>
            </div>
            <div className="list-item">
              <strong>Git / working tree</strong>
              <span>
                Всего {safeCount(result.repository?.summary?.changedFileCount)}, staged {safeCount(result.repository?.summary?.stagedCount)}, unstaged {safeCount(result.repository?.summary?.unstagedCount)}, untracked {safeCount(result.repository?.summary?.untrackedCount)}
              </span>
            </div>
            <div className="list-item">
              <strong>Index manifest</strong>
              <span>{safeText(result.index?.manifest?.indexId)}</span>
            </div>
            <div className="list-item">
              <strong>Incremental index</strong>
              <span>
                {result.incrementalIndex
                  ? `${safeText(result.incrementalIndex.mode)} / кандидатов ${safeCount(result.incrementalIndex.candidatePaths?.length)}`
                  : "Недоступно"}
              </span>
            </div>
            <div className="list-item">
              <strong>Graph summary</strong>
              <span>
                Узлы: {safeCount(result.graph?.summary?.nodeCount)}, рёбра: {safeCount(result.graph?.summary?.edgeCount)}
              </span>
            </div>
            <div className="list-item">
              <strong>Graph invalidation</strong>
              <span>
                {result.graphInvalidation
                  ? `${safeText(result.graphInvalidation.mode)} / файлов ${safeCount(result.graphInvalidation.invalidatedFiles?.length)} / модулей ${safeCount(result.graphInvalidation.invalidatedModules?.length)}`
                  : "Недоступно"}
              </span>
            </div>
          </div>

          <div className="list">
            {repositoryChanges.length ? (
              repositoryChanges.map((change) => (
                <div key={`${change.scope}:${change.changeType}:${change.previousPath ?? ""}:${change.path}`} className="list-item">
                  <strong>Git change scope</strong>
                  <span>
                    {change.scope} / {change.changeType} / {change.previousPath ? `${change.previousPath} -> ` : ""}
                    {change.path}
                  </span>
                </div>
              ))
            ) : (
              <PanelFallback title="Git change scope" message="Локальные изменения в репозитории не обнаружены или Git недоступен." />
            )}
          </div>

          <div className="chip-row">
            {Object.entries(result.index?.stats?.languages ?? {}).map(([language, count]) => (
              <span key={language} className="chip">
                {language}: {count}
              </span>
            ))}
          </div>
        </div>
      ) : (
        <p className="muted">Git и graph слой появятся здесь после индексирования.</p>
      )}
    </article>
  );
}

function DiagnosticsPanel({ result }: { result: PipelineRunResult | null }) {
  const ignoredPaths = hasRunArtifacts(result) ? safeList(result.workspace?.ignoredPaths) : [];
  const diagnostics = hasRunArtifacts(result) ? safeList(result.index?.diagnostics) : [];
  const repositoryDiagnostics = hasRunArtifacts(result) ? safeList(result.repository?.diagnostics) : [];
  const diagnosticsCount = ignoredPaths.length + diagnostics.length + repositoryDiagnostics.length;

  return (
    <article className="inspector-panel">
      <div className="panel-header">
        <h2>Diagnostics</h2>
        <span>{hasRunArtifacts(result) ? diagnosticsCount : 0}</span>
      </div>

      {hasRunArtifacts(result) ? (
        <div className="stack">
          <div className="list">
            <div className="list-item">
              <strong>Диагностика repository/git</strong>
              <span>{repositoryDiagnostics.length}</span>
            </div>
            {repositoryDiagnostics.length ? (
              repositoryDiagnostics.slice(0, 10).map((diagnostic) => (
                <div key={diagnostic} className="list-item compact">
                  <span>{diagnostic}</span>
                </div>
              ))
            ) : (
              <p className="muted">Git-диагностика не выявила критичных проблем.</p>
            )}
          </div>

          <div className="list">
            <div className="list-item">
              <strong>Игнорируемые пути</strong>
              <span>{ignoredPaths.length}</span>
            </div>
            {ignoredPaths.slice(0, 10).map((pathValue) => (
              <div key={pathValue} className="list-item compact">
                <span>{pathValue}</span>
              </div>
            ))}
          </div>

          <div className="list">
            <div className="list-item">
              <strong>Диагностика index/workspace</strong>
              <span>{diagnostics.length}</span>
            </div>
            {diagnostics.length ? (
              diagnostics.slice(0, 10).map((diagnostic) => (
                <div key={diagnostic} className="list-item compact">
                  <span>{diagnostic}</span>
                </div>
              ))
            ) : (
              <p className="muted">Критичных диагностических сообщений нет.</p>
            )}
          </div>
        </div>
      ) : (
        <p className="muted">Диагностика будет показана после запуска pipeline.</p>
      )}
    </article>
  );
}

function InspectorDrawer({
  open,
  activeTab,
  onClose,
  onChangeTab,
  result,
}: {
  open: boolean;
  activeTab: InspectorTab;
  onClose: () => void;
  onChangeTab: (tab: InspectorTab) => void;
  result: PipelineRunResult | null;
}) {
  const tabs: Array<{ id: InspectorTab; label: string }> = [
    { id: "overview", label: "Overview" },
    { id: "research", label: "Research" },
    { id: "impact", label: "Impact" },
    { id: "context", label: "Context" },
    { id: "plan", label: "Plan" },
    { id: "execution", label: "Execution" },
    { id: "knowledge", label: "Knowledge" },
    { id: "git", label: "Git" },
    { id: "diagnostics", label: "Diagnostics" },
  ];

  return (
    <>
      {open ? <button type="button" className="inspector-backdrop" aria-label="Закрыть inspector" onClick={onClose} /> : null}
      <aside className={`inspector-drawer ${open ? "inspector-open" : ""}`}>
        <div className="inspector-head">
          <div>
            <p className="section-kicker">Inspector</p>
            <h2>Внутренние артефакты run</h2>
          </div>
          <button type="button" className="ghost-button" onClick={onClose}>
            Закрыть
          </button>
        </div>

        <div className="inspector-tabs">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={`inspector-tab ${activeTab === tab.id ? "inspector-tab-active" : ""}`}
              onClick={() => onChangeTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="inspector-content">
          {activeTab === "overview" ? <OverviewPanel result={result} /> : null}
          {activeTab === "research" ? <ResearchPanel result={result} /> : null}
          {activeTab === "impact" ? <ImpactPanel result={result} /> : null}
          {activeTab === "context" ? <ContextPanel result={result} /> : null}
          {activeTab === "plan" ? <PlanPanel result={result} /> : null}
          {activeTab === "execution" ? <ExecutionPanel result={result} /> : null}
          {activeTab === "knowledge" ? <KnowledgePanel result={result} /> : null}
          {activeTab === "git" ? <GitPanel result={result} /> : null}
          {activeTab === "diagnostics" ? <DiagnosticsPanel result={result} /> : null}
        </div>
      </aside>
    </>
  );
}

export function App() {
  const navigate = useNavigate();
  const location = useLocation();
  const routeParams = useParams<{ runId?: string }>();
  const activeView: AppView = location.pathname.startsWith("/projects")
    ? "projects"
    : location.pathname.startsWith("/providers")
      ? "providers"
      : location.pathname.startsWith("/teams")
        ? "teams"
        : location.pathname.startsWith("/observers")
          ? "observers"
          : "chat";
  const routeRunId = routeParams.runId ?? null;
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [task, setTask] = useState("");
  const [projectPath, setProjectPath] = useState("");
  // Раньше выбор проекта нигде не сохранялся — любой remount (перезагрузка
  // страницы, HMR в деве) стартовал с пустого selectedProjectId, и
  // `initializeApp` безусловно откатывался на `loadedProjects[0]` (первый
  // проект в списке). Отсюда и жалоба "проект сам переключился на первый" —
  // это не гонка во время печати, а потеря состояния при любом remount.
  // Читаем сразу в initial state, а не через useEffect — initializeApp
  // читает `selectedProjectIdRef.current` в своём собственном эффекте,
  // который может сработать раньше отдельного эффекта синхронизации ref.
  const [selectedProjectId, setSelectedProjectId] = useState<string>(readPersistedProjectId);
  const [selectedProjectPathId, setSelectedProjectPathId] = useState<string>("");
  const [providerDraft, setProviderDraft] = useState<ProviderDraft>({
    id: "",
    name: "",
    baseUrl: "",
    apiKey: "",
  });
  const [projectDraft, setProjectDraft] = useState<ProjectDraft>({
    id: "",
    name: "",
    description: "",
    paths: [
      {
        id: "",
        name: "",
        rootPath: "",
      },
    ],
  });
  const [providerModelDraft, setProviderModelDraft] = useState(DEFAULT_MODEL_ID);
  const [providers, setProviders] = useState<ProviderRecord[]>([]);
  const [providerModels, setProviderModels] = useState<ProviderModelRecord[]>([]);
  const [selectedProviderId, setSelectedProviderId] = useState<string>("");
  const [teamDraft, setTeamDraft] = useState<TeamDraft>({
    id: "",
    name: "",
    researcherModel: "",
    criticModel: "",
    observerModel: "",
    developerModel: "",
    reviewerModel: "",
  });
  const [teams, setTeams] = useState<TeamRecord[]>([]);
  const [selectedTeamId, setSelectedTeamId] = useState<string>("");
  const [observerStatus, setObserverStatus] = useState<ObserverStatusResponse | null>(null);
  const [health, setHealth] = useState<HealthStatusResponse | null>(null);
  // Запоминает, какие проекты были активны на момент "Остановить все", чтобы
  // "Запустить снова" перезапускала именно их, а не все проекты подряд.
  const [pausedObserverProjects, setPausedObserverProjects] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [runStatus, setRunStatus] = useState<PipelineRunStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PipelineRunResult | null>(null);
  const [selectedTask, setSelectedTask] = useState<string>("");
  // `turns` — реплики текущего открытого диалога, по порядку, для scrolling
  // транскрипта в chat-body. `result`/`selectedTask` остаются как есть (последняя
  // реплика) — вся логика Inspector-панели читает именно их и не меняется.
  const [turns, setTurns] = useState<PipelineRunResult[]>([]);
  // Develop-реплики текущего диалога (отдельно от turns: другой тип артефакта,
  // другой поллинг). v1: живут в памяти сессии, при перезагрузке страницы
  // восстанавливаются только Q&A-реплики (develop-история — в developer_runs).
  const [developTurns, setDevelopTurns] = useState<DevelopRunStatusView[]>([]);
  const [activeDevelop, setActiveDevelop] = useState<DevelopRunStatusView | null>(null);
  const activeDevelopRunIdRef = useRef<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [clarificationRound, setClarificationRound] = useState(0);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [selectedHistoryIds, setSelectedHistoryIds] = useState<Set<string>>(new Set());
  const [deletingHistory, setDeletingHistory] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [activeInspectorTab, setActiveInspectorTab] = useState<InspectorTab>("overview");
  const activeRunIdRef = useRef<string | null>(null);
  // `activeRunIdRef` обновляется синхронно вместе с state (а не через отдельный
  // useEffect с лагом в один рендер), чтобы `pollPipelineStatus` могла надёжно
  // определить, что запущенный ею run уже брошен (например, пользователь нажал
  // "Новый чат"), и не перезаписать ответ нового чата результатом старого run'а.
  function updateActiveRunId(nextRunId: string | null) {
    activeRunIdRef.current = nextRunId;
    setActiveRunId(nextRunId);
  }
  const selectedProjectIdRef = useRef<string>(readPersistedProjectId());
  const projectPathRef = useRef<string>("");
  const chatEndRef = useRef<HTMLDivElement | null>(null);
  const readiness = projectReadinessState(project);
  const backgroundSyncStatus = backgroundSyncState(project);
  const preflight = buildChatPreflight({
    health,
    providers,
    selectedProviderId,
    teams,
    selectedTeamId,
    projects,
    selectedProjectId,
  });

  useEffect(() => {
    void initializeApp();
  }, []);

  // Композер зафиксирован снизу (position: sticky), а страница — один длинный
  // скролл без внутренней прокрутки у списка сообщений. Без авто-скролла
  // пользователь после ответа остаётся там, где был (часто вверху), и
  // середина ответа визуально прячется под композером, пока не проскроллишь
  // руками — так обычные чаты не ведут себя. Едем к концу только при новом
  // вопросе и при получении финального ответа — раньше сюда же был добавлен
  // `runStatus?.currentStageLabel`, который меняется на каждом тике поллинга
  // (каждые несколько секунд, 10+ раз за один run) и с `behavior: "smooth"`
  // ощущался как страница, которая "постоянно прыгает" — убрано.
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [selectedTask, result]);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(PROVIDER_STORAGE_KEY);

      if (!raw) {
        return;
      }

      const parsed = JSON.parse(raw) as Partial<ProviderDraft> & { model?: string };

      setProviderDraft({
        id: parsed.id ?? "",
        name: parsed.name ?? "",
        baseUrl: parsed.baseUrl ?? "",
        apiKey: parsed.apiKey ?? "",
      });
      setProviderModelDraft(typeof parsed.model === "string" ? parsed.model : DEFAULT_MODEL_ID);
    } catch {
      // ignore broken local storage payload
    }
  }, []);

  useEffect(() => {
    window.localStorage.setItem(
      PROVIDER_STORAGE_KEY,
      JSON.stringify({
        ...providerDraft,
        model: providerModelDraft,
      }),
    );
  }, [providerDraft, providerModelDraft]);

  useEffect(() => {
    selectedProjectIdRef.current = selectedProjectId;

    try {
      if (selectedProjectId) {
        window.localStorage.setItem(PROJECT_STORAGE_KEY, selectedProjectId);
      } else {
        window.localStorage.removeItem(PROJECT_STORAGE_KEY);
      }
    } catch {
      // localStorage недоступен (приватный режим и т.п.) — переживём без персистентности.
    }
  }, [selectedProjectId]);

  useEffect(() => {
    projectPathRef.current = projectPath;
  }, [projectPath]);

  useEffect(() => {
    if (!project?.backgroundState || !selectedProjectId || running) {
      return;
    }

    const needsBackgroundRefresh = Boolean(project.baselineInfo?.backgroundSyncRecommended);
    const hasActiveBackgroundRun =
      project.activeBackgroundRun
      && (project.activeBackgroundRun.status === "queued" || project.activeBackgroundRun.status === "running");

    if (!needsBackgroundRefresh || hasActiveBackgroundRun) {
      return;
    }

    void triggerBackgroundSync(true);
  }, [project?.backgroundState?.stateId, project?.baselineInfo?.backgroundSyncRecommended, project?.activeBackgroundRun?.runId, selectedProjectId, running]);

  useEffect(() => {
    if (activeView !== "chat") {
      return;
    }

    if (!selectedProjectId && !projectPath) {
      return;
    }

    const interval = window.setInterval(() => {
      void loadProject(projectPath, selectedProjectId || undefined, false);
    }, 10_000);

    return () => {
      window.clearInterval(interval);
    };
  }, [activeView, projectPath, selectedProjectId]);

  // Observer работает по-настоящему в фоне (см. apps/api/src/observer-monitor.ts)
  // - без этого пользователь не может отличить "сейчас изучает проект" от
  // "стоит и ничего не делает", по прямому запросу пользователя. Глобальный
  // список (не привязан к текущему projectPath) - должно быть видно на любом
  // чате, какие проекты Observer сейчас изучает, а не только для открытого
  // прямо сейчас. Опрос идёт и на выделенном экране "Обсерверы" (2026-07-18) -
  // иначе процент/текущий unitPath там были бы статичным снимком на момент
  // захода на вкладку, а не живой картиной.
  useEffect(() => {
    if (activeView !== "chat" && activeView !== "observers") {
      return;
    }

    void loadObserverStatus();
    // 4с, не 10 - плашка с процентом изучения должна чувствоваться "живой"
    // (просьба пользователя). Безопасно на бэкенде за счёт TTL-кэша в
    // getObserverProgress (observer-monitor.ts) - без него более частый опрос
    // означал бы более частый обход файлов и хэширование на каждый тик.
    const interval = window.setInterval(() => void loadObserverStatus(), 4_000);

    return () => {
      window.clearInterval(interval);
    };
  }, [activeView]);

  async function loadObserverStatus() {
    try {
      const status = await fetchJsonWithTimeout<ObserverStatusResponse>(`${API_BASE_URL}/api/observer/status`);
      setObserverStatus(status);
    } catch {
      // Тихая деградация - статус Observer'а не критичен для остального UI.
    }
  }

  useEffect(() => {
    if (activeView !== "chat") {
      return;
    }

    if (!routeRunId) {
      return;
    }

    if (routeRunId === activeRunIdRef.current || routeRunId === result?.runId) {
      return;
    }

    if (!projectPath) {
      return;
    }

    void openRunFromUrl(routeRunId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeView, routeRunId, projectPath]);

  // Переход на голый "/chat" (клик по табу, back/forward браузера) должен
  // всегда открывать чистый экран нового чата, а не оставлять содержимое
  // предыдущего run — раньше сброс происходил только через кнопку "Новый чат".
  useEffect(() => {
    if (activeView !== "chat" || routeRunId) {
      return;
    }

    setResult(null);
    setRunStatus(null);
    updateActiveRunId(null);
    setSelectedTask("");
    setClarificationRound(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeView, routeRunId]);

  async function initializeApp() {
    setLoading(true);
    setError(null);

    try {
      // Раньше проекты и провайдеры грузились строго последовательно — два
      // независимых запроса (ни один не зависит от результата другого), но
      // общее время ожидания было суммой обоих вместо максимума. На старте
      // приложения это и ощущалось как "долго не прилетают проекты/провайдеры".
      const [loadedProjects] = await Promise.all([loadProjects(), loadProviders(), loadTeams(), loadHealth()]);
      const preferredProjectId =
        selectedProjectIdRef.current && loadedProjects.some((projectItem) => projectItem.id === selectedProjectIdRef.current)
          ? selectedProjectIdRef.current
          : loadedProjects[0]?.id ?? "";
      const preferredProject = loadedProjects.find((projectItem) => projectItem.id === preferredProjectId) ?? null;
      await loadProject(preferredProject?.paths[0]?.rootPath, preferredProjectId || undefined);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Не удалось инициализировать приложение.");
      setLoading(false);
    }
  }

  async function loadProjects() {
    const projectCatalog = normalizeProjectCatalog(await fetchJsonWithTimeout<ProjectCatalogResponse>(`${API_BASE_URL}/api/projects`));

    startTransition(() => {
      setProjects(projectCatalog.projects);
      setSelectedProjectId((current) => {
        const nextProjectId =
          current && projectCatalog.projects.some((projectItem) => projectItem.id === current)
            ? current
            : projectCatalog.projects[0]?.id ?? "";

        selectedProjectIdRef.current = nextProjectId;
        return nextProjectId;
      });
    });

    return projectCatalog.projects;
  }

  async function loadHealth() {
    const healthData = await fetchJsonWithTimeout<HealthStatusResponse>(`${API_BASE_URL}/api/health`);

    startTransition(() => {
      setHealth(healthData);
    });

    return healthData;
  }

  function resolveSelectedProjectPath(projectItem: ProjectRecord | null | undefined, preferredRootPath?: string): ProjectPathRecord | null {
    if (!projectItem) {
      return null;
    }

    if (preferredRootPath) {
      const matched = projectItem.paths.find((pathItem) => pathItem.rootPath === preferredRootPath);

      if (matched) {
        return matched;
      }
    }

    if (selectedProjectPathId) {
      const matched = projectItem.paths.find((pathItem) => pathItem.id === selectedProjectPathId);

      if (matched) {
        return matched;
      }
    }

    return projectItem.paths[0] ?? null;
  }

  async function loadProviders() {
    const providerResponse = await fetchJsonWithTimeout<ProviderCatalogResponse>(`${API_BASE_URL}/api/providers`);
    const providerData = normalizeProviderCatalog(providerResponse);

    startTransition(() => {
      setProviders(providerData.providers);
      setProviderModels(providerData.models);
      setSelectedProviderId(providerData.currentProvider?.id ?? "");
      setProviderModelDraft(providerData.recommendedModelId ?? DEFAULT_MODEL_ID);
      const currentProvider = providerData.currentProvider;

      if (currentProvider) {
        setProviderDraft((current) => ({
          ...current,
          id: currentProvider.id,
          name: currentProvider.name,
          baseUrl: currentProvider.baseUrl,
          apiKey: "",
        }));
      }
    });

    return providerData;
  }

  async function loadTeams() {
    const teamResponse = await fetchJsonWithTimeout<TeamCatalogResponse>(`${API_BASE_URL}/api/teams`);
    const teamData = normalizeTeamCatalog(teamResponse);

    startTransition(() => {
      setTeams(teamData.teams);
      setSelectedTeamId(teamData.selectedTeam?.id ?? "");
      const selectedTeam = teamData.selectedTeam;

      if (selectedTeam) {
        setTeamDraft({
          id: selectedTeam.id,
          name: selectedTeam.name,
          researcherModel: selectedTeam.researcherModel,
          criticModel: selectedTeam.criticModel,
          observerModel: selectedTeam.observerModel,
          developerModel: selectedTeam.developerModel,
          reviewerModel: selectedTeam.reviewerModel,
        });
      }
    });

    return teamData;
  }

  function openInspector(tab: InspectorTab = "overview") {
    setActiveInspectorTab(tab);
    setInspectorOpen(true);
  }

  async function loadProject(nextProjectPath?: string, nextProjectId?: string, syncResult = true) {
    // `syncResult=false` — тихий фоновый рефреш (10с polling, пост-run
    // синк), не действие пользователя. Раньше `setLoading(true)` вызывался
    // безусловно — Send-кнопка (`disabled={running || loading || ...}`)
    // мигала disabled каждые 10 секунд без всякого объяснения пользователю.
    // Пулинг не должен быть заметен вообще — loading/error видимы только для
    // настоящей навигации (смена проекта, первая загрузка).
    if (syncResult) {
      setLoading(true);
      setError(null);
    }

    try {
      const params = new URLSearchParams();
      const requestedProjectId = nextProjectId?.trim() || selectedProjectId.trim();
      const requestedProjectPath = nextProjectPath?.trim() || projectPath.trim();

      if (requestedProjectId) {
        params.set("projectId", requestedProjectId);
      }

      if (requestedProjectPath) {
        params.set("projectPath", requestedProjectPath);
      }

      const projectResponse = await fetchJsonWithTimeout<ProjectInfo>(`${API_BASE_URL}/api/project${params.size ? `?${params.toString()}` : ""}`);
      const data = normalizeProjectInfo(projectResponse);
      const matchingProject =
        data.projectRecord
        ?? projects.find((projectItem) =>
          safeList(projectItem.paths).some((pathItem) => pathItem.rootPath === data.rootPath),
        )
        ?? null;
      const latestEntry = data.latestRun ? safeList(data.recentRuns).find((entry) => entry.runId === data.latestRun?.runId) ?? null : null;

      startTransition(() => {
        setProject(data);
        const resolvedProjectId = matchingProject?.id ?? requestedProjectId;
        setSelectedProjectId(resolvedProjectId);
        selectedProjectIdRef.current = resolvedProjectId;
        setProjectPath(data.rootPath);
        projectPathRef.current = data.rootPath;
        const activePath = resolveSelectedProjectPath(data.projectRecord, data.rootPath);
        setSelectedProjectPathId(activePath?.id ?? "");

        // `syncResult=false` — это периодический (10с) или пост-run рефреш
        // метаданных проекта, а не переключение проекта/первая загрузка.
        // Раньше это условие проверяло только `activeRunIdRef.current`, из-за
        // чего КАЖДЫЙ фоновый тик перезаписывал уже показанный пользователю
        // ответ на `data.latestRun` — любой чужой/фоновый run (silent
        // background sync, хард ресинк и т.п.), завершившийся где угодно в
        // проекте, "телепортировался" в чат как будто пользователь его
        // получил. Теперь `result`/`selectedTask` синхронизируются с сервером
        // только при явном переключении проекта или первой загрузке страницы.
        if (syncResult) {
          setResult((current) => {
            if (activeRunIdRef.current) {
              return current;
            }

            return data.latestRun ?? null;
          });
          setSelectedTask((current) => {
            if (activeRunIdRef.current) {
              return current;
            }

            return current || latestEntry?.task || "";
          });
          // На холодной загрузке/переключении проекта показываем последнюю
          // реплику ТОЛЬКО для просмотра ("на чём проект остановился") — не
          // для продолжения. `conversationId` НАМЕРЕННО не берём из
          // `data.latestRun`: это последний run проекта вообще, а не обязательно
          // диалог этого пользователя/этой сессии (например, чужой live-тест
          // через API). Раньше conversationId наследовался отсюда — реальный
          // живой баг: сообщение пользователя тихо приклеивалось как
          // "уточнение" к чужому диалогу и утекало не в тот чат. Продолжение
          // треда включается только явным действием — своей отправкой
          // сообщения в этой сессии или открытием конкретного чата из истории
          // (fetchRunArtifact).
          if (!activeRunIdRef.current) {
            setTurns(data.latestRun ? [data.latestRun] : []);

            // Переключение проекта: develop-реплики принадлежали прежнему
            // проекту/диалогу. Не сбрасываем, пока идёт живой develop-ран
            // (его поллинг сам владеет состоянием).
            if (!activeDevelopRunIdRef.current) {
              setDevelopTurns([]);
              setActiveDevelop(null);
            }
          }
        }
      });
    } catch (loadError) {
      if (syncResult) {
        setError(loadError instanceof Error ? loadError.message : "Не удалось загрузить сводку по проекту.");
      } else {
        // Тихий фоновый тик — не показываем ошибку пользователю, следующий
        // тик через 10с попробует снова.
        console.warn("[loadProject] background refresh failed:", loadError);
      }
    } finally {
      if (syncResult) {
        setLoading(false);
      }
    }
  }

  async function runPipeline(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await submitPipelineRun(false);
  }

  async function submitPipelineRun(forceRefresh: boolean, hardResync = false) {
    if (!selectedProjectId && !projectPath.trim()) {
      setError("Нужно выбрать проект перед отправкой вопроса.");
      return;
    }

    setRunning(true);
    setError(null);

    // Уточнение реализовано как склейка строки на клиенте перед pipeline run
    // (продолжающим тот же conversationId). Обязательно требует уже принятого
    // в этой сессии `conversationId` — раньше проверялся только `result`,
    // который на холодной загрузке мог быть чужим/старым run'ом проекта
    // (см. loadProject) — сообщение пользователя тогда приклеивалось как
    // "уточнение" к чужому диалогу. Не применяется к hardResync/background-sync
    // (это системные операции, не продолжение вопроса пользователя).
    const isFollowUpClarification =
      !hardResync
      && Boolean(conversationId)
      && result?.answer?.answerMode === "clarification-needed"
      && clarificationRound < MAX_CLARIFICATION_ROUNDS;
    const composedTask = isFollowUpClarification
      ? `${selectedTask}\n\nУточнение пользователя: ${task.trim()}`
      : task.trim();

    try {
      const accepted = await fetchJsonWithTimeout<PipelineRunStatus & { kind?: string }>(`${API_BASE_URL}/api/pipeline/run`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          task: composedTask || (hardResync
            ? "Выполни полный ручной хард ресинк project intelligence."
            : "Обнови фоновое понимание проекта и подготовь структурный отчёт."),
          projectPath,
          projectId: selectedProjectId || undefined,
          providerId: selectedProviderId || undefined,
          providerBaseUrl: providerDraft.baseUrl,
          providerModel: providerModelDraft,
          providerApiKey: providerDraft.apiKey,
          forceRefresh,
          hardResync,
          // Пусто — новый диалог (сервер возьмёт conversationId = runId первой
          // реплики). Иначе — продолжение уже открытого треда, follow-up-вопрос
          // получит доступ к evidence/контексту предыдущей реплики (см. §7-8
          // в apps/api/src/pipeline-runner.ts).
          conversationId: !hardResync && !forceRefresh ? conversationId ?? undefined : undefined,
        }),
      });

      // Сервер распознал в сообщении задачу разработки (или корректировку
      // предыдущей) и запустил Developer pipeline вместо Q&A — совсем другой
      // артефакт и другой endpoint статуса.
      if (accepted.kind === "develop") {
        const developAccepted = accepted as unknown as DevelopRunStatusView;
        startTransition(() => {
          setActiveDevelop({ ...developAccepted, task: composedTask || developAccepted.task });
          setConversationId(developAccepted.conversationId || developAccepted.runId);
          setRunStatus(null);
          setResult(null);
          setSelectedTask("");
          setTask("");
        });
        activeDevelopRunIdRef.current = developAccepted.runId;
        await pollDevelopStatus(developAccepted.runId, composedTask || developAccepted.task);
        return;
      }

      startTransition(() => {
        setRunStatus(accepted);
        setSelectedTask(composedTask);
        setClarificationRound((round) => (isFollowUpClarification ? round + 1 : 0));
        updateActiveRunId(accepted.runId);
        setResult(null);
        setInspectorOpen(false);
        setTask("");
      });
      navigate(`/chat/${encodeURIComponent(accepted.runId)}`);

      await pollPipelineStatus(accepted.runId);
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : "Не удалось выполнить pipeline.");
    } finally {
      setRunning(false);
    }
  }

  // Бэкенд уже помечает прерванные сервером run'ы `resumeContext.canResumeFromStart:
  // true` (см. markInFlightRunsInterrupted в apps/api/src/pipeline-runner.ts) —
  // раньше фронт этот сигнал вообще не читал, и единственным способом
  // повторить вопрос после сбоя было перепечатать его заново вручную.
  // Повторяет тот же task в том же диалоге (тот же conversationId), не
  // трогая текущий текст в композере.
  async function retryFailedRun() {
    if (!runStatus || runStatus.status !== "failed") {
      return;
    }

    if (!selectedProjectId && !projectPath.trim()) {
      setError("Нужно выбрать проект перед отправкой вопроса.");
      return;
    }

    setRunning(true);
    setError(null);

    try {
      const accepted = await fetchJsonWithTimeout<PipelineRunStatus>(`${API_BASE_URL}/api/pipeline/run`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          task: runStatus.task,
          projectPath,
          projectId: selectedProjectId || undefined,
          providerId: selectedProviderId || undefined,
          providerBaseUrl: providerDraft.baseUrl,
          providerModel: providerModelDraft,
          providerApiKey: providerDraft.apiKey,
          conversationId: runStatus.conversationId || undefined,
        }),
      });

      startTransition(() => {
        setRunStatus(accepted);
        setSelectedTask(runStatus.task);
        updateActiveRunId(accepted.runId);
        setResult(null);
        setInspectorOpen(false);
      });
      navigate(`/chat/${encodeURIComponent(accepted.runId)}`);

      await pollPipelineStatus(accepted.runId);
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : "Не удалось повторить запуск.");
    } finally {
      setRunning(false);
    }
  }

  async function triggerBackgroundSync(silent: boolean) {
    if (!selectedProjectId && !projectPath.trim()) {
      return;
    }

    if (!silent) {
      setRunning(true);
    }

    try {
      const accepted = await fetchJsonWithTimeout<PipelineRunStatus>(`${API_BASE_URL}/api/pipeline/run`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          task: "Фоновая пересборка branch-aware project intelligence.",
          projectPath,
          projectId: selectedProjectId || undefined,
          providerId: selectedProviderId || undefined,
          providerBaseUrl: providerDraft.baseUrl,
          providerModel: providerModelDraft,
          providerApiKey: providerDraft.apiKey,
          forceRefresh: true,
        }),
      });

      startTransition(() => {
        setProject((current) =>
          current
            ? {
                ...current,
                activeBackgroundRun: accepted,
              }
            : current,
        );
      });

      if (!silent) {
        startTransition(() => {
          setRunStatus(accepted);
          updateActiveRunId(accepted.runId);
          setResult(null);
        });
        await pollPipelineStatus(accepted.runId);
      }
    } catch (runError) {
      if (!silent) {
        setError(runError instanceof Error ? runError.message : "Не удалось запустить фоновую пересборку.");
      }
    } finally {
      if (!silent) {
        setRunning(false);
      }
    }
  }

  async function triggerHardResync() {
    await submitPipelineRun(false, true);
  }

  // Поллинг Developer-рана — зеркало pollPipelineStatus, с теми же двумя
  // защитами от "утёкшего" статуса при переключении чата (проверка ref до и
  // после fetch). displayTask сохраняется, потому что сервер для продолжений
  // хранит СКЛЕЕННУЮ задачу (исходная + ответ на уточнение) — в чате
  // показываем то, что пользователь реально напечатал.
  async function pollDevelopStatus(runId: string, displayTask: string) {
    for (;;) {
      if (activeDevelopRunIdRef.current !== runId) {
        return;
      }

      let status: DevelopRunStatusView;
      try {
        status = await fetchJsonWithTimeout<DevelopRunStatusView>(
          `${API_BASE_URL}/api/develop/status?runId=${encodeURIComponent(runId)}`,
          undefined,
          8000,
        );
      } catch (statusError) {
        if (!isTransientPollError(statusError)) {
          throw statusError;
        }

        await new Promise((resolve) => window.setTimeout(resolve, 2000));
        continue;
      }

      if (activeDevelopRunIdRef.current !== runId) {
        return;
      }

      const displayStatus: DevelopRunStatusView = { ...status, task: displayTask };

      if (status.status !== "running") {
        startTransition(() => {
          setDevelopTurns((current) => [...current.filter((turn) => turn.runId !== status.runId), displayStatus]);
          setActiveDevelop(null);
        });
        activeDevelopRunIdRef.current = null;
        return;
      }

      startTransition(() => {
        setActiveDevelop(displayStatus);
      });
      await new Promise((resolve) => window.setTimeout(resolve, 3000));
    }
  }

  async function pollPipelineStatus(runId: string) {
    for (;;) {
      // Раньше здесь стояла проверка `activeRunIdRef.current && ...`, которая
      // не останавливала поллинг, если run был брошен через "Новый чат"
      // (activeRunId сбрасывается в null, а не в id другого run'а). Из-за этого
      // уже отменённый run мог дозавершиться и подменить собой ответ в новом,
      // пустом чате — задача показывалась от старого run'а, а ответ от него же,
      // но пользователь уже успел открыть другой чат/задать другой вопрос.
      if (activeRunIdRef.current !== runId) {
        return;
      }

      let status: PipelineRunStatus;
      try {
        status = await fetchJsonWithTimeout<PipelineRunStatus>(
          `${API_BASE_URL}/api/pipeline/status?runId=${encodeURIComponent(runId)}`,
          undefined,
          8000,
        );
      } catch (statusError) {
        if (!isTransientPollError(statusError)) {
          throw statusError;
        }

        startTransition(() => {
          setRunStatus((current) =>
            current && current.runId === runId
              ? {
                  ...current,
                  currentStageLabel: current.currentStageLabel || "Изучаю проект",
                }
              : current,
          );
        });

        await new Promise((resolve) => window.setTimeout(resolve, 1500));
        continue;
      }

      // Раньше проверка `activeRunIdRef.current !== runId` стояла только в
      // начале цикла (см. выше) — если пользователь переключал чат ПОКА
      // fetch уже летел, между стартом запроса и получением ответа, эта
      // проверка не срабатывала: уже устаревший run всё равно применялся к
      // тому чату, который открыт СЕЙЧАС (`setResult`/`setTurns` ниже читают
      // только `runId`, не привязаны к тому, какой чат был активен в момент
      // запуска поллинга). Живой репродукт: ответ одного чата "утекал" в
      // другой, если переключение произошло в узком окне между тиками.
      // Повторная проверка сразу после получения ответа, перед ЛЮБЫМ
      // применением статуса — не только completed-веткой.
      if (activeRunIdRef.current !== runId) {
        return;
      }

      startTransition(() => {
        setRunStatus(status);
      });

      if (status.status === "completed" && status.result) {
        const resolvedProjectId =
          selectedProjectIdRef.current
          || project?.projectRecord?.id
          || selectedProjectId
          || undefined;
        const resolvedProjectPath =
          status.result.project.rootPath
          || projectPathRef.current
          || project?.rootPath
          || projectPath;

        startTransition(() => {
          setResult(status.result ?? null);
          if (status.result) {
            const completedResult = status.result;
            setConversationId(completedResult.conversationId);
            // dedupe на случай повторного поллинга того же runId (не должно
            // происходить в норме — pollPipelineStatus возвращается сразу после
            // completed — но дешёвая защита от задвоения реплики в транскрипте).
            setTurns((current) => [...current.filter((turn) => turn.runId !== completedResult.runId), completedResult]);
          }
          updateActiveRunId(null);
          setProject((current) =>
            current
              ? {
                  ...current,
                  name: status.result?.project.name ?? current.name,
                  rootPath: status.result?.project.rootPath ?? current.rootPath,
                  summary: status.result?.project.summary ?? current.summary,
                  latestRun: status.result ?? current.latestRun,
                  recentRuns: status.result
                    ? [
                        {
                          runId: status.result.runId,
                          task: status.task,
                          savedAt: status.result.knowledge.savedAt,
                          storagePath: status.result.knowledge.storagePath,
                          summary: status.result.research.summary,
                          mode: status.result.mode,
                          conversationId: status.result.conversationId,
                          turnIndex: status.result.turnIndex,
                        },
                        ...safeList(current.recentRuns).filter((entry) => entry.runId !== status.result?.runId),
                      ].slice(0, 20)
                    : current.recentRuns,
                  repository: status.result?.repository ?? current.repository ?? null,
                  backgroundState: status.result?.backgroundState ?? current.backgroundState ?? null,
                }
              : current,
          );
        });
        await loadProject(resolvedProjectPath, resolvedProjectId, false);
        return;
      }

      if (status.status === "failed") {
        startTransition(() => {
          updateActiveRunId(null);
        });
        throw new Error(status.errorMessage || "Pipeline завершился ошибкой.");
      }

      await new Promise((resolve) => window.setTimeout(resolve, 700));
    }
  }

  function resetStuckRun() {
    startTransition(() => {
      setRunning(false);
      updateActiveRunId(null);
      setRunStatus(null);
    });
  }

  async function saveProvider() {
    setError(null);

    try {
      const saved = await fetchJsonWithTimeout<ProviderRecord>(`${API_BASE_URL}/api/providers`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          id: providerDraft.id,
          name: providerDraft.name,
          baseUrl: providerDraft.baseUrl,
          apiKey: providerDraft.apiKey,
          isCurrent: true,
          isActive: true,
        }),
      });

      const providerData = normalizeProviderCatalog(await fetchJsonWithTimeout<ProviderCatalogResponse>(`${API_BASE_URL}/api/providers`));

      startTransition(() => {
        setProviders(providerData.providers);
        setProviderModels(providerData.models);
        setSelectedProviderId(saved.id);
        setProviderModelDraft(providerData.recommendedModelId ?? providerModelDraft);
        setProviderDraft((current) => ({
          ...current,
          id: saved.id,
          apiKey: "",
        }));
      });
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Не удалось сохранить провайдера.");
    }
  }

  async function selectProvider(providerId: string) {
    if (!providerId) {
      setSelectedProviderId("");
      return;
    }

    setError(null);

    try {
      await fetchJsonWithTimeout<ProviderRecord>(`${API_BASE_URL}/api/providers/${encodeURIComponent(providerId)}/select`, {
        method: "POST",
      });
      const providerData = normalizeProviderCatalog(await fetchJsonWithTimeout<ProviderCatalogResponse>(`${API_BASE_URL}/api/providers`));
      const selected = safeList(providerData.providers).find((provider) => provider.id === providerId) ?? null;

      startTransition(() => {
        setProviders(providerData.providers);
        setProviderModels(providerData.models);
        setSelectedProviderId(providerId);
        setProviderModelDraft(providerData.recommendedModelId ?? providerModelDraft);
        if (selected) {
          setProviderDraft({
            id: selected.id,
            name: selected.name,
            baseUrl: selected.baseUrl,
            apiKey: "",
          });
        }
      });
    } catch (selectError) {
      setError(selectError instanceof Error ? selectError.message : "Не удалось выбрать провайдера.");
    }
  }

  // Раньше выбор модели жил только в providerModelDraft/localStorage — на
  // сервере не сохранялся вообще, поэтому любой не-веб вызывающий (фоновый
  // monitor, другой клиент) всегда падал на CLIENT_PROVIDER_MODEL из .env.
  // Теперь смена модели сразу персистится в БД через providers.default_model
  // (см. setProviderDefaultModel в apps/api/src/provider-store.ts).
  async function changeProviderModel(modelId: string) {
    setProviderModelDraft(modelId);

    if (!selectedProviderId || !modelId) {
      return;
    }

    try {
      await fetchJsonWithTimeout<ProviderRecord>(
        `${API_BASE_URL}/api/providers/${encodeURIComponent(selectedProviderId)}/default-model`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: modelId }),
        },
      );
    } catch {
      // Не блокируем UI на сбое персистентности — draft уже обновлён локально,
      // следующий явный providerModel в запросе всё равно победит.
    }
  }

  async function removeProvider(providerId: string) {
    setError(null);

    try {
      await fetchJsonWithTimeout<{ ok: true }>(`${API_BASE_URL}/api/providers/${encodeURIComponent(providerId)}`, {
        method: "DELETE",
      });
      const providerData = normalizeProviderCatalog(await fetchJsonWithTimeout<ProviderCatalogResponse>(`${API_BASE_URL}/api/providers`));
      const current = providerData.currentProvider;

      startTransition(() => {
        setProviders(providerData.providers);
        setProviderModels(providerData.models);
        setSelectedProviderId(current?.id ?? "");
        setProviderModelDraft(providerData.recommendedModelId ?? DEFAULT_MODEL_ID);
        setProviderDraft({
          id: current?.id ?? "",
          name: current?.name ?? "",
          baseUrl: current?.baseUrl ?? "",
          apiKey: "",
        });
      });
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : "Не удалось удалить провайдера.");
    }
  }

  async function saveTeamDraft() {
    setError(null);

    try {
      const saved = await fetchJsonWithTimeout<TeamRecord>(`${API_BASE_URL}/api/teams`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          id: teamDraft.id,
          name: teamDraft.name,
          researcherModel: teamDraft.researcherModel,
          criticModel: teamDraft.criticModel,
          observerModel: teamDraft.observerModel,
          developerModel: teamDraft.developerModel,
          reviewerModel: teamDraft.reviewerModel,
          isSelected: true,
        }),
      });

      const teamData = normalizeTeamCatalog(await fetchJsonWithTimeout<TeamCatalogResponse>(`${API_BASE_URL}/api/teams`));

      startTransition(() => {
        setTeams(teamData.teams);
        setSelectedTeamId(saved.id);
        setTeamDraft((current) => ({ ...current, id: saved.id }));
      });
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Не удалось сохранить команду.");
    }
  }

  async function selectTeam(teamId: string) {
    if (!teamId) {
      setSelectedTeamId("");
      return;
    }

    setError(null);

    try {
      await fetchJsonWithTimeout<TeamRecord>(`${API_BASE_URL}/api/teams/${encodeURIComponent(teamId)}/select`, {
        method: "POST",
      });
      const teamData = normalizeTeamCatalog(await fetchJsonWithTimeout<TeamCatalogResponse>(`${API_BASE_URL}/api/teams`));
      const selected = safeList(teamData.teams).find((team) => team.id === teamId) ?? null;

      startTransition(() => {
        setTeams(teamData.teams);
        setSelectedTeamId(teamId);
        if (selected) {
          setTeamDraft({
            id: selected.id,
            name: selected.name,
            researcherModel: selected.researcherModel,
            criticModel: selected.criticModel,
            observerModel: selected.observerModel,
            developerModel: selected.developerModel,
            reviewerModel: selected.reviewerModel,
          });
        }
      });
    } catch (selectError) {
      setError(selectError instanceof Error ? selectError.message : "Не удалось выбрать команду.");
    }
  }

  async function removeTeam(teamId: string) {
    setError(null);

    try {
      await fetchJsonWithTimeout<{ ok: true }>(`${API_BASE_URL}/api/teams/${encodeURIComponent(teamId)}`, {
        method: "DELETE",
      });
      const teamData = normalizeTeamCatalog(await fetchJsonWithTimeout<TeamCatalogResponse>(`${API_BASE_URL}/api/teams`));
      const selected = teamData.selectedTeam;

      startTransition(() => {
        setTeams(teamData.teams);
        setSelectedTeamId(selected?.id ?? "");
        setTeamDraft({
          id: selected?.id ?? "",
          name: selected?.name ?? "",
          researcherModel: selected?.researcherModel ?? "",
          criticModel: selected?.criticModel ?? "",
          observerModel: selected?.observerModel ?? "",
          developerModel: selected?.developerModel ?? "",
          reviewerModel: selected?.reviewerModel ?? "",
        });
      });
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : "Не удалось удалить команду.");
    }
  }

  // Project-level toggle (2026-07-16, multi-path unification): one click
  // starts/stops Observer on every physical repo of the selected project -
  // the user no longer has to know or care that a project can have several
  // paths. Reuses the existing per-path start/stop endpoint (each path's
  // Observer runner is still independent - it has its own git history), just
  // loops it client-side, same pattern as resumeObservers already does.
  async function toggleProjectObserver(observerProjectPaths: string[], nextRunning: boolean) {
    try {
      await Promise.all(
        observerProjectPaths.map((observerProjectPath) =>
          fetchJsonWithTimeout<{ ok: true }>(`${API_BASE_URL}/api/observer/${nextRunning ? "start" : "stop"}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ projectPath: observerProjectPath }),
          }),
        ),
      );
      await loadObserverStatus();
    } catch (toggleError) {
      setError(toggleError instanceof Error ? toggleError.message : "Не удалось переключить Observer.");
    }
  }

  async function stopAllObserversNow() {
    try {
      const result = await fetchJsonWithTimeout<{ ok: true; stopped: string[] }>(`${API_BASE_URL}/api/observer/stop-all`, {
        method: "POST",
      });
      setPausedObserverProjects(result.stopped);
      await loadObserverStatus();
    } catch (stopError) {
      setError(stopError instanceof Error ? stopError.message : "Не удалось остановить Observer'ы.");
    }
  }

  async function resumeObservers() {
    try {
      await Promise.all(
        pausedObserverProjects.map((observerProjectPath) =>
          fetchJsonWithTimeout<{ ok: true }>(`${API_BASE_URL}/api/observer/start`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ projectPath: observerProjectPath }),
          }),
        ),
      );
      setPausedObserverProjects([]);
      await loadObserverStatus();
    } catch (resumeError) {
      setError(resumeError instanceof Error ? resumeError.message : "Не удалось запустить Observer'ы заново.");
    }
  }

  function resetProjectDraft() {
    setProjectDraft({
      id: "",
      name: "",
      description: "",
      paths: [
        {
          id: "",
          name: "",
          rootPath: "",
        },
      ],
    });
  }

  function startEditProject(projectItem: ProjectRecord) {
    setProjectDraft({
      id: projectItem.id,
      name: projectItem.name,
      description: projectItem.description ?? "",
      paths: safeList(projectItem.paths).length
        ? projectItem.paths.map((pathItem) => ({
            id: pathItem.id,
            name: pathItem.name,
            rootPath: pathItem.rootPath,
          }))
        : [
            {
              id: "",
              name: "",
              rootPath: "",
            },
          ],
    });
    navigate("/projects");
  }

  function updateProjectDraftPath(index: number, patch: Partial<ProjectDraftPath>) {
    setProjectDraft((current) => ({
      ...current,
      paths: current.paths.map((pathItem, pathIndex) =>
        pathIndex === index
          ? {
              ...pathItem,
              ...patch,
            }
          : pathItem,
      ),
    }));
  }

  function addProjectDraftPath() {
    setProjectDraft((current) => ({
      ...current,
      paths: [
        ...current.paths,
        {
          id: "",
          name: "",
          rootPath: "",
        },
      ],
    }));
  }

  function removeProjectDraftPath(index: number) {
    setProjectDraft((current) => ({
      ...current,
      paths: current.paths.length <= 1 ? current.paths : current.paths.filter((_, pathIndex) => pathIndex !== index),
    }));
  }

  async function saveProjectDraft() {
    setError(null);

    try {
      // Сервер возвращает полную сохранённую запись с её настоящим id — используем
      // именно его, а не гадаем по имени в заново загруженном списке проектов.
      // Раньше при отсутствии точного совпадения по имени (например из-за
      // рассинхрона пробелов/регистра) код тихо откатывался на loadedProjects[0],
      // что могло активировать совершенно другой проект — источник cross-project leak.
      const savedProject = await fetchJsonWithTimeout<ProjectRecord>(`${API_BASE_URL}/api/projects`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          id: projectDraft.id || undefined,
          name: projectDraft.name,
          description: projectDraft.description,
          paths: projectDraft.paths,
        }),
      });

      await loadProjects();
      const activeProjectId = savedProject.id;
      resetProjectDraft();

      if (activeProjectId) {
        await loadProject(undefined, activeProjectId);
      }
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Не удалось сохранить проект.");
    }
  }

  async function removeProject(projectId: string) {
    setError(null);

    try {
      await fetchJsonWithTimeout<{ ok: true }>(`${API_BASE_URL}/api/projects/${encodeURIComponent(projectId)}`, {
        method: "DELETE",
      });

      const loadedProjects = await loadProjects();
      resetProjectDraft();

      if (loadedProjects[0]?.id) {
        await loadProject(undefined, loadedProjects[0].id);
      } else {
        startTransition(() => {
          setProject(null);
          setProjectPath("");
          setSelectedProjectId("");
          setSelectedProjectPathId("");
          setResult(null);
          setSelectedTask("");
        });
      }
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : "Не удалось удалить проект.");
    }
  }

  async function fetchRunArtifact(runId: string): Promise<void> {
    if (!projectPath) {
      return;
    }

    setError(null);

    try {
      const params = new URLSearchParams({
        projectPath,
        runId,
      });
      const artifact = await fetchJsonWithTimeout<PipelineRunResult>(`${API_BASE_URL}/api/runs/selected?${params.toString()}`);

      // Открытие одного run'а из истории/по прямой ссылке теперь подтягивает
      // весь диалог, к которому он принадлежит (для транскрипта в chat-body),
      // а не только этот один run. Inspector-панель по-прежнему показывает
      // именно запрошенный run (result/selectedTask), даже если это не
      // последняя реплика треда — так deep-link на конкретный ответ остаётся точным.
      let conversationTurns: PipelineRunResult[] = [artifact];

      try {
        const conversationParams = new URLSearchParams({
          projectPath,
          conversationId: artifact.conversationId,
        });
        const conversationResponse = await fetchJsonWithTimeout<ConversationTurnsResponse>(
          `${API_BASE_URL}/api/runs/conversation?${conversationParams.toString()}`,
        );
        conversationTurns = conversationResponse.turns;
      } catch {
        // Диалог из одной реплики (старый артефакт без conversationId) или
        // сеть подвела — транскрипт из одного уже загруженного run'а всё
        // равно лучше, чем пустой экран.
      }

      startTransition(() => {
        setResult(artifact);
        setRunStatus(null);
        updateActiveRunId(null);
        setSelectedTask(artifact.knowledge?.runId ? safeText(artifact.research?.summary, selectedTask) : selectedTask);
        setTurns(conversationTurns);
        // Открыт другой (Q&A) диалог из истории — develop-реплики прежней
        // сессии к нему не относятся.
        setDevelopTurns([]);
        setActiveDevelop(null);
        setConversationId(artifact.conversationId);
      });
      activeDevelopRunIdRef.current = null;
    } catch (loadError) {
      // Ссылка на run, которого больше нет (удалённый чат, протухший deep
      // link) — раньше это оставляло пользователя на мёртвом URL с голым
      // текстом ошибки "Запуск не найден", хотя он ничего не делал: просто
      // открыл/перезагрузил страницу на старой ссылке. Откатываемся на
      // чистый новый чат вместо ошибки, которую пользователь не вызывал сам.
      const message = loadError instanceof Error ? loadError.message : "Не удалось открыть запуск из истории.";

      if (message === "Запуск не найден.") {
        startNewChat();
        return;
      }

      setError(message);
    }
  }

  async function openRunFromHistory(runId: string) {
    navigate(`/chat/${encodeURIComponent(runId)}`);
    await fetchRunArtifact(runId);
  }

  async function openRunFromUrl(runId: string) {
    await fetchRunArtifact(runId);
  }

  function startNewChat() {
    startTransition(() => {
      setResult(null);
      setRunStatus(null);
      updateActiveRunId(null);
      setSelectedTask("");
      setTask("");
      setError(null);
      setSelectedHistoryIds(new Set());
      setClarificationRound(0);
      setTurns([]);
      setDevelopTurns([]);
      setActiveDevelop(null);
      setConversationId(null);
    });
    activeDevelopRunIdRef.current = null;
    navigate("/chat");
  }

  function toggleHistorySelection(runId: string) {
    setSelectedHistoryIds((previous) => {
      const next = new Set(previous);

      if (next.has(runId)) {
        next.delete(runId);
      } else {
        next.add(runId);
      }

      return next;
    });
  }

  function toggleSelectAllHistory(allRunIds: string[]) {
    setSelectedHistoryIds((previous) => (previous.size === allRunIds.length ? new Set() : new Set(allRunIds)));
  }

  // Сайдбар выделяет/удаляет по conversationId (одна строка = один диалог),
  // но API удаления (`/api/runs/delete`) работает по runId — разворачиваем
  // выбранные диалоги в полный список их реплик перед вызовом.
  async function deleteHistoryEntries(conversationIds: string[]) {
    if (!conversationIds.length || !projectPath) {
      return;
    }

    const groups = groupHistoryByConversation(project?.recentRuns ?? []);
    const runIds = groups
      .filter((group) => conversationIds.includes(group.conversationId))
      .flatMap((group) => group.runIds);

    if (!runIds.length) {
      return;
    }

    const confirmed = window.confirm(
      conversationIds.length === 1
        ? "Удалить этот чат? Действие необратимо."
        : `Удалить ${conversationIds.length} чатов? Действие необратимо.`,
    );

    if (!confirmed) {
      return;
    }

    setDeletingHistory(true);

    try {
      await fetchJsonWithTimeout<{ ok: boolean }>(`${API_BASE_URL}/api/runs/delete`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ projectPath, runIds }),
      });

      setProject((previous) =>
        previous
          ? { ...previous, recentRuns: previous.recentRuns.filter((entry) => !runIds.includes(entry.runId)) }
          : previous,
      );
      setSelectedHistoryIds(new Set());

      // Раньше проверялся только `conversationId` (state для ПРОДОЛЖЕНИЯ
      // треда) — но после фикса "чаты перемешиваются" отображение (`turns`)
      // намеренно отвязано от него: холодная загрузка показывает последний
      // run проекта в `turns`, не трогая `conversationId`. Из-за этого
      // удаление ИМЕННО показанного сейчас диалога не проходило по условию
      // ниже и переписка оставалась на экране, хотя в истории (и в БД) её
      // уже не было — репродукт пользователя.
      const deletedConversationIsShown =
        (conversationId && conversationIds.includes(conversationId))
        || turns.some((turn) => conversationIds.includes(turn.conversationId));

      if (deletedConversationIsShown) {
        startNewChat();
      }
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Не удалось удалить чат.");
    } finally {
      setDeletingHistory(false);
    }
  }

  return (
    <main className="app-shell app-shell-product">
      <header className="app-topbar">
        <div className="app-topbar-brand">
          <strong>Client</strong>
        </div>
        <div className="app-topbar-actions">
          {/* Просто переключение вкладки (2026-07-18 fix) - раньше висело на
              startNewChat, из-за чего "Чат" в топбаре был не вкладкой, а
              скрытой кнопкой сброса: уйти на "Обсерверы" посмотреть статус и
              вернуться "Чатом" стирало текущий диалог и ЖИВОЙ run с экрана
              (сам run на бэкенде продолжал идти - пропадало только
              отображение). Явный сброс остаётся только у "+ Новый чат" в
              сайдбаре (onStartNewChat={startNewChat} ниже). */}
          <button type="button" className={`top-nav-button ${activeView === "chat" ? "top-nav-button-active" : ""}`} onClick={() => navigate("/chat")} disabled={running}>
            Чат
          </button>
          <button type="button" className={`top-nav-button ${activeView === "projects" ? "top-nav-button-active" : ""}`} onClick={() => navigate("/projects")} disabled={running}>
            Проекты
          </button>
          <button type="button" className={`top-nav-button ${activeView === "providers" ? "top-nav-button-active" : ""}`} onClick={() => navigate("/providers")} disabled={running}>
            Провайдеры
          </button>
          <button type="button" className={`top-nav-button ${activeView === "teams" ? "top-nav-button-active" : ""}`} onClick={() => navigate("/teams")} disabled={running}>
            Команды
          </button>
          <button type="button" className={`top-nav-button ${activeView === "observers" ? "top-nav-button-active" : ""}`} onClick={() => navigate("/observers")} disabled={running}>
            Обсерверы
          </button>
        </div>
      </header>

      <section className={`app-workspace ${activeView === "chat" ? "app-workspace-with-history" : "app-workspace-single"}`}>
        {activeView === "chat" ? (
          <RunHistorySidebar
            recentRuns={safeList(project?.recentRuns)}
            activeConversationId={conversationId}
            onSelectConversation={(runId) => void openRunFromHistory(runId)}
            onStartNewChat={startNewChat}
            projectName={safeText(project?.name, "Проект")}
            selectedIds={selectedHistoryIds}
            onToggleSelect={toggleHistorySelection}
            onToggleSelectAll={toggleSelectAllHistory}
            onDeleteSelected={() => void deleteHistoryEntries([...selectedHistoryIds])}
            onDeleteOne={(conversationIdToDelete) => void deleteHistoryEntries([conversationIdToDelete])}
            deleting={deletingHistory}
          />
        ) : null}

        <section className={`chat-shell ${activeView === "chat" ? "chat-shell-with-worktrees" : "chat-shell-full"}`}>
          <header className="chat-header">
          <div>
            <h1>{VIEW_TITLES[activeView]}</h1>
            <p className="chat-subtitle">{VIEW_SUBTITLES[activeView]}</p>
          </div>

          <div className="header-actions">
            {running ? (
              <button type="button" className="ghost-button danger-button" onClick={resetStuckRun}>
                Сбросить зависший run
              </button>
            ) : null}
          </div>
        </header>

        {activeView === "chat" ? (
          <>
            <EnvironmentStrip
              projects={projects}
              selectedProjectId={selectedProjectId}
              selectedProviderId={selectedProviderId}
              providers={providers}
              teams={teams}
              selectedTeamId={selectedTeamId}
              disabled={running}
              onProjectChange={(nextProjectId) => {
                setSelectedProjectId(nextProjectId);
                const selectedProject = projects.find((item) => item.id === nextProjectId);
                // Multi-path unification (2026-07-16): the primary path is
                // always paths[0] - no more manual "Путь" selection. The
                // backend independently expands to every path of the
                // project for research/Observer purposes.
                const activePath = selectedProject?.paths[0] ?? null;
                setSelectedProjectPathId(activePath?.id ?? "");
                setProjectPath(activePath?.rootPath ?? "");
                void loadProject(activePath?.rootPath, nextProjectId);
              }}
              onProviderChange={(providerId) => void selectProvider(providerId)}
              onTeamChange={(teamId) => void selectTeam(teamId)}
            />

            <ObserverGlobalBar
              observerStatus={observerStatus}
              pausedCount={pausedObserverProjects.length}
              onStopAll={() => void stopAllObserversNow()}
              onResume={() => void resumeObservers()}
              onOpenPanel={() => navigate("/observers")}
            />

            <div className="chat-body">
              {!preflight.ready && !loading ? (
                <div className="chat-hero chat-hero-empty">
                  <p className="section-kicker">Preflight</p>
                  <h2>{preflight.title}</h2>
                  <p>{preflight.description}</p>
                  <div className="preflight-list">
                    {preflight.items.map((item) => (
                      <div key={item.key} className={`preflight-item ${item.ready ? "preflight-item-ready" : "preflight-item-warning"}`}>
                        <strong>{item.ready ? "Готово" : "Нужно действие"} · {item.label}</strong>
                        <span>{item.detail}</span>
                        {!item.ready ? <span>{item.action}</span> : null}
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              {!safeList(projects).length && !loading ? (
                <div className="chat-hero chat-hero-empty">
                  <p className="section-kicker">Начало работы</p>
                  <h2>Сначала добавь проект</h2>
                  <p>
                    Client отвечает на вопросы по уже собранной карте проекта. Чтобы начать, добавь путь к своему проекту на странице «Проекты».
                  </p>
                  <div className="chat-suggestions">
                    <button type="button" className="primary-button" onClick={() => navigate("/projects")}>
                      Добавить проект
                    </button>
                  </div>
                </div>
              ) : !selectedTask && !running && !result && turns.length === 0 ? (
                <div className="chat-hero">
                  <p className="section-kicker">Chat</p>
                  <h2>Понимание проекта за минуты, а не за часы</h2>
                  <p>
                    Выбери проект, задай вопрос и получи инженерный ответ поверх уже собранной карты проекта.
                  </p>
                  <div className="chat-suggestions">
                    <button type="button" className="ghost-button" onClick={() => setTask("Как устроен этот проект и из каких основных модулей состоит?")}>
                      Как устроен проект?
                    </button>
                    <button type="button" className="ghost-button" onClick={() => setTask("Где основные точки входа приложения?")}>
                      Где точки входа?
                    </button>
                    <button type="button" className="ghost-button" onClick={() => setTask("Какие конфигурационные файлы и env-переменные использует проект?")}>
                      Какая конфигурация у проекта?
                    </button>
                  </div>
                </div>
              ) : null}

              {turns.map((turn) => (
                <Fragment key={turn.runId}>
                  <UserTaskMessage task={turn.research.task} projectName={safeText(project?.name, "")} projectPath={projectPath} />
                  <AssistantRunMessage
                    runStatus={null}
                    result={turn}
                    providerModels={providerModels}
                    // Inspector-панель читает состояние `result`, общее для всей
                    // страницы — при открытии инспектора у конкретной (не
                    // обязательно последней) реплики треда сначала переключаем
                    // `result` на неё, иначе панель показала бы последнюю реплику
                    // независимо от того, по какой из них кликнули.
                    onOpenInspector={(tab) => {
                      setResult(turn);
                      openInspector(tab);
                    }}
                    clarificationRound={0}
                    onSelectClarification={(moduleKey) => setTask(moduleKey)}
                    onRetry={() => {}}
                  />
                </Fragment>
              ))}

              {/*
                "Живая" реплика: пока идёт run (running=true) или последний
                целевой result/selectedTask ещё не осел в turns (например run
                упал с ошибкой и не был сохранён как реплика треда) — показываем
                её отдельно поверх уже отрисованного транскрипта, а не через turns,
                чтобы не дублировать одну и ту же реплику дважды после завершения.
              */}
              {selectedTask && !turns.some((turn) => turn.runId === result?.runId) ? (
                <Fragment>
                  <UserTaskMessage task={selectedTask} projectName={safeText(project?.name, "")} projectPath={projectPath} />
                  <AssistantRunMessage
                    runStatus={runStatus}
                    result={result}
                    providerModels={providerModels}
                    onOpenInspector={openInspector}
                    clarificationRound={clarificationRound}
                    onSelectClarification={(moduleKey) => setTask(moduleKey)}
                    onRetry={() => void retryFailedRun()}
                  />
                </Fragment>
              ) : null}

              {/* Develop-реплики диалога (после Q&A-реплик; см. developTurns) */}
              {developTurns.map((turn) => (
                <Fragment key={turn.runId}>
                  <UserTaskMessage task={turn.task} projectName={safeText(project?.name, "")} projectPath={projectPath} />
                  <DevelopRunMessage run={turn} />
                </Fragment>
              ))}
              {activeDevelop ? (
                <Fragment>
                  <UserTaskMessage task={activeDevelop.task} projectName={safeText(project?.name, "")} projectPath={projectPath} />
                  <DevelopRunMessage run={activeDevelop} />
                </Fragment>
              ) : null}
              <div ref={chatEndRef} />
            </div>

            <form className="composer" onSubmit={runPipeline}>
              <div className="composer-box">
                <textarea
                  value={task}
                  onChange={(event) => setTask(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();

                      if (!running && selectedProjectId && task.trim()) {
                        void submitPipelineRun(false);
                      }
                    }
                  }}
                  rows={4}
                  placeholder="Напиши инженерную задачу или вопрос по проекту... (Enter — отправить, Shift+Enter — новая строка)"
                  disabled={running}
                />

                <div className="composer-actions">
                  <div className="composer-meta">
                    <span>
                      {backgroundSyncStatus.title}. Рабочее дерево: {worktreeStatusLabel(project?.backgroundState?.worktreeStatus)}.
                    </span>
                    {runStatus ? <span>{safeText(runStatus.currentStageLabel, "Ожидание")}</span> : null}
                  </div>
                  <button type="submit" className="primary-button" disabled={running || loading || !selectedProjectId}>
                    {running ? "Собираю ответ..." : !selectedProjectId ? "Сначала выбери проект" : "Получить ответ по проекту"}
                  </button>
                </div>
              </div>
            </form>
          </>
        ) : null}

        {activeView === "providers" ? (
          <section className="settings-layout">
            <article className="settings-card">
              <div className="section-head">
                <div>
                  <p className="section-kicker">Провайдеры</p>
                  <h2>Создание и настройка</h2>
                </div>
                <button type="button" className="ghost-button" onClick={() => setProviderDraft({ id: "", name: "", baseUrl: "", apiKey: "" })}>
                  Новый
                </button>
              </div>

              <div className="stack">
                <label className="field">
                  <span>Имя</span>
                  <input value={providerDraft.name} onChange={(event) => setProviderDraft((current) => ({ ...current, name: event.target.value }))} />
                </label>
                <label className="field">
                  <span>Base URL</span>
                  <input value={providerDraft.baseUrl} onChange={(event) => setProviderDraft((current) => ({ ...current, baseUrl: event.target.value }))} />
                </label>
                <label className="field">
                  <span>API Key</span>
                  <input value={providerDraft.apiKey} onChange={(event) => setProviderDraft((current) => ({ ...current, apiKey: event.target.value }))} />
                </label>
                <div className="action-row">
                  <button type="button" className="primary-button" onClick={() => void saveProvider()}>
                    Сохранить провайдера
                  </button>
                </div>
              </div>
            </article>

            <article className="settings-card">
              <div className="section-head">
                <div>
                  <p className="section-kicker">Список</p>
                  <h2>Доступные провайдеры</h2>
                </div>
              </div>
              <div className="list">
                {safeList(providers).map((provider) => (
                  <div key={provider.id} className="list-item">
                    <strong>{provider.name}</strong>
                    <span>{provider.baseUrl}</span>
                    <span>{provider.isCurrent ? "Текущий" : "Не выбран"}</span>
                    <div className="action-row">
                      <button
                        type="button"
                        className="ghost-button"
                        onClick={() =>
                          setProviderDraft({
                            id: provider.id,
                            name: provider.name,
                            baseUrl: provider.baseUrl,
                            apiKey: "",
                          })
                        }
                      >
                        Редактировать
                      </button>
                      <button type="button" className="ghost-button" onClick={() => void selectProvider(provider.id)}>
                        Выбрать
                      </button>
                      <button type="button" className="ghost-button danger-button" onClick={() => void removeProvider(provider.id)}>
                        Удалить
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </article>
          </section>
        ) : null}

        {activeView === "teams" ? (
          <section className="settings-layout">
            <article className="settings-card">
              <div className="section-head">
                <div>
                  <p className="section-kicker">Команды</p>
                  <h2>Создание и настройка</h2>
                </div>
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => setTeamDraft({ id: "", name: "", researcherModel: "", criticModel: "", observerModel: "", developerModel: "", reviewerModel: "" })}
                >
                  Новая
                </button>
              </div>

              <div className="stack">
                <label className="field">
                  <span>Имя команды</span>
                  <input value={teamDraft.name} onChange={(event) => setTeamDraft((current) => ({ ...current, name: event.target.value }))} />
                </label>
                <label className="field">
                  <span>Researcher</span>
                  <span className="field-hint">{TEAM_ROLE_DESCRIPTIONS.researcher}</span>
                  <select
                    value={teamDraft.researcherModel}
                    onChange={(event) => setTeamDraft((current) => ({ ...current, researcherModel: event.target.value }))}
                  >
                    <option value="">Модель не выбрана</option>
                    {/* Модель вне каталога (например ":flex"-вариант) — без этой
                        опции select показывал "Модель не выбрана", и сохранение
                        формы МОЛЧА затирало реальную модель команды пустой строкой. */}
                    {teamDraft.researcherModel && !safeList(providerModels).some((model) => model.id === teamDraft.researcherModel) ? (
                      <option value={teamDraft.researcherModel}>{teamDraft.researcherModel} (вне каталога)</option>
                    ) : null}
                    {groupModelsByVendor(safeList(providerModels)).map((group) => (
                      <optgroup key={group.vendor} label={group.vendor}>
                        {group.models.map((model) => (
                          <option key={model.id} value={model.id}>
                            {model.label}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>Critic</span>
                  <span className="field-hint">{TEAM_ROLE_DESCRIPTIONS.critic}</span>
                  <select
                    value={teamDraft.criticModel}
                    onChange={(event) => setTeamDraft((current) => ({ ...current, criticModel: event.target.value }))}
                  >
                    <option value="">Модель не выбрана</option>
                    {teamDraft.criticModel && !safeList(providerModels).some((model) => model.id === teamDraft.criticModel) ? (
                      <option value={teamDraft.criticModel}>{teamDraft.criticModel} (вне каталога)</option>
                    ) : null}
                    {groupModelsByVendor(safeList(providerModels)).map((group) => (
                      <optgroup key={group.vendor} label={group.vendor}>
                        {group.models.map((model) => (
                          <option key={model.id} value={model.id}>
                            {model.label}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>Developer</span>
                  <span className="field-hint">{TEAM_ROLE_DESCRIPTIONS.developer}</span>
                  <select
                    value={teamDraft.developerModel}
                    onChange={(event) => setTeamDraft((current) => ({ ...current, developerModel: event.target.value }))}
                  >
                    <option value="">Как у Researcher</option>
                    {teamDraft.developerModel && !safeList(providerModels).some((model) => model.id === teamDraft.developerModel) ? (
                      <option value={teamDraft.developerModel}>{teamDraft.developerModel} (вне каталога)</option>
                    ) : null}
                    {groupModelsByVendor(safeList(providerModels)).map((group) => (
                      <optgroup key={group.vendor} label={group.vendor}>
                        {group.models.map((model) => (
                          <option key={model.id} value={model.id}>
                            {model.label}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>Reviewer</span>
                  <span className="field-hint">{TEAM_ROLE_DESCRIPTIONS.reviewer}</span>
                  <select
                    value={teamDraft.reviewerModel}
                    onChange={(event) => setTeamDraft((current) => ({ ...current, reviewerModel: event.target.value }))}
                  >
                    <option value="">Дефолт (Kimi K2.7 Code)</option>
                    {teamDraft.reviewerModel && !safeList(providerModels).some((model) => model.id === teamDraft.reviewerModel) ? (
                      <option value={teamDraft.reviewerModel}>{teamDraft.reviewerModel} (вне каталога)</option>
                    ) : null}
                    {groupModelsByVendor(safeList(providerModels)).map((group) => (
                      <optgroup key={group.vendor} label={group.vendor}>
                        {group.models.map((model) => (
                          <option key={model.id} value={model.id}>
                            {model.label}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>Observer</span>
                  <span className="field-hint">{TEAM_ROLE_DESCRIPTIONS.observer}</span>
                  <select
                    value={teamDraft.observerModel}
                    onChange={(event) => setTeamDraft((current) => ({ ...current, observerModel: event.target.value }))}
                  >
                    <option value="">Модель не выбрана</option>
                    {teamDraft.observerModel && !safeList(providerModels).some((model) => model.id === teamDraft.observerModel) ? (
                      <option value={teamDraft.observerModel}>{teamDraft.observerModel} (вне каталога)</option>
                    ) : null}
                    {groupModelsByVendor(safeList(providerModels)).map((group) => (
                      <optgroup key={group.vendor} label={group.vendor}>
                        {group.models.map((model) => (
                          <option key={model.id} value={model.id}>
                            {model.label}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                </label>
                <div className="action-row">
                  <button type="button" className="primary-button" onClick={() => void saveTeamDraft()}>
                    Сохранить команду
                  </button>
                </div>
              </div>
            </article>

            <article className="settings-card">
              <div className="section-head">
                <div>
                  <p className="section-kicker">Список</p>
                  <h2>Доступные команды</h2>
                </div>
              </div>
              <div className="list">
                {safeList(teams).map((team) => (
                  <div key={team.id} className="list-item">
                    <strong>{team.name}</strong>
                    <span>{team.isSelected ? "Выбрана" : "Не выбрана"}</span>
                    <div className="team-role-cards">
                      <div className="team-role-card">
                        <strong>Researcher</strong>
                        <span>
                          {team.researcherModel || "—"}
                          {findModelMultiplierLabel(providerModels, team.researcherModel) ? (
                            <span className="model-multiplier-badge"> {findModelMultiplierLabel(providerModels, team.researcherModel)}</span>
                          ) : null}
                        </span>
                        <span className="field-hint">{TEAM_ROLE_DESCRIPTIONS.researcher}</span>
                      </div>
                      <div className="team-role-card">
                        <strong>Critic</strong>
                        <span>
                          {team.criticModel || "—"}
                          {findModelMultiplierLabel(providerModels, team.criticModel) ? (
                            <span className="model-multiplier-badge"> {findModelMultiplierLabel(providerModels, team.criticModel)}</span>
                          ) : null}
                        </span>
                        <span className="field-hint">{TEAM_ROLE_DESCRIPTIONS.critic}</span>
                      </div>
                      <div className="team-role-card">
                        <strong>Developer</strong>
                        <span>
                          {team.developerModel || "—"}
                          {findModelMultiplierLabel(providerModels, team.developerModel) ? (
                            <span className="model-multiplier-badge"> {findModelMultiplierLabel(providerModels, team.developerModel)}</span>
                          ) : null}
                        </span>
                        <span className="field-hint">{TEAM_ROLE_DESCRIPTIONS.developer}</span>
                      </div>
                      <div className="team-role-card">
                        <strong>Reviewer</strong>
                        <span>
                          {team.reviewerModel || "—"}
                          {findModelMultiplierLabel(providerModels, team.reviewerModel) ? (
                            <span className="model-multiplier-badge"> {findModelMultiplierLabel(providerModels, team.reviewerModel)}</span>
                          ) : null}
                        </span>
                        <span className="field-hint">{TEAM_ROLE_DESCRIPTIONS.reviewer}</span>
                      </div>
                      <div className="team-role-card">
                        <strong>Observer</strong>
                        <span>
                          {team.observerModel || "—"}
                          {findModelMultiplierLabel(providerModels, team.observerModel) ? (
                            <span className="model-multiplier-badge"> {findModelMultiplierLabel(providerModels, team.observerModel)}</span>
                          ) : null}
                        </span>
                        <span className="field-hint">{TEAM_ROLE_DESCRIPTIONS.observer}</span>
                      </div>
                    </div>
                    <div className="action-row">
                      <button
                        type="button"
                        className="ghost-button"
                        onClick={() =>
                          setTeamDraft({
                            id: team.id,
                            name: team.name,
                            researcherModel: team.researcherModel,
                            criticModel: team.criticModel,
                            observerModel: team.observerModel,
                            developerModel: team.developerModel,
                            reviewerModel: team.reviewerModel,
                          })
                        }
                      >
                        Редактировать
                      </button>
                      <button type="button" className="ghost-button" onClick={() => void selectTeam(team.id)}>
                        Выбрать
                      </button>
                      <button type="button" className="ghost-button danger-button" onClick={() => void removeTeam(team.id)}>
                        Удалить
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </article>
          </section>
        ) : null}

        {activeView === "projects" ? (
          <section className="settings-layout">
            <article className="settings-card">
              <div className="section-head">
                <div>
                  <p className="section-kicker">Проекты</p>
                  <h2>Проект с несколькими путями</h2>
                </div>
                <button type="button" className="ghost-button" onClick={resetProjectDraft}>
                  Новый
                </button>
              </div>

              <div className="stack">
                <label className="field">
                  <span>Имя проекта</span>
                  <input value={projectDraft.name} onChange={(event) => setProjectDraft((current) => ({ ...current, name: event.target.value }))} />
                </label>
                <label className="field">
                  <span>Описание</span>
                  <textarea value={projectDraft.description} onChange={(event) => setProjectDraft((current) => ({ ...current, description: event.target.value }))} rows={3} />
                </label>

                <div className="stack">
                  <p className="form-help-text">
                    Добавь один или несколько абсолютных путей к папкам репозиториев на этой машине. Имя пути необязательно: если оставить пустым, backend подставит название папки сам.
                  </p>
                  {projectDraft.paths.map((pathItem, index) => (
                    <div key={`${pathItem.id || "draft"}-${index}`} className="path-editor">
                      <label className="field">
                        <span>Имя пути</span>
                        <input value={pathItem.name} onChange={(event) => updateProjectDraftPath(index, { name: event.target.value })} placeholder="backend / frontend / billing" />
                      </label>
                      <label className="field">
                        <span>Путь</span>
                        <input value={pathItem.rootPath} onChange={(event) => updateProjectDraftPath(index, { rootPath: event.target.value })} placeholder="/Users/.../project" />
                      </label>
                      <div className="action-row">
                        <button type="button" className="ghost-button danger-button" onClick={() => removeProjectDraftPath(index)}>
                          Удалить путь
                        </button>
                      </div>
                    </div>
                  ))}
                  <div className="action-row">
                    <button type="button" className="ghost-button" onClick={addProjectDraftPath}>
                      Добавить путь
                    </button>
                  </div>
                </div>

                <div className="action-row">
                  <button type="button" className="primary-button" onClick={() => void saveProjectDraft()}>
                    Сохранить проект
                  </button>
                </div>
              </div>
            </article>

            <article className="settings-card">
              <div className="section-head">
                <div>
                  <p className="section-kicker">Список</p>
                  <h2>Сохранённые проекты</h2>
                </div>
              </div>
              <div className="list">
                {safeList(projects).map((projectItem) => (
                  <div key={projectItem.id} className="list-item">
                    <strong>{projectItem.name}</strong>
                    <span>{projectItem.description || "Без описания"}</span>
                    <span>
                      {projectItem.paths
                        .map((pathItem: ProjectPathRecord) => `${pathItem.name} [${PATH_ROLE_LABELS[pathItem.role] ?? pathItem.role}]: ${pathItem.rootPath}`)
                        .join(" · ")}
                    </span>
                    <div className="action-row">
                      <button type="button" className="ghost-button" onClick={() => startEditProject(projectItem)}>
                        Редактировать
                      </button>
                      <button
                        type="button"
                        className="ghost-button"
                        onClick={() => {
                          navigate("/chat");
                          setSelectedProjectId(projectItem.id);
                          setSelectedProjectPathId(projectItem.paths[0]?.id ?? "");
                          setProjectPath(projectItem.paths[0]?.rootPath ?? "");
                          void loadProject(projectItem.paths[0]?.rootPath, projectItem.id);
                        }}
                      >
                        Открыть в чате
                      </button>
                      <button type="button" className="ghost-button danger-button" onClick={() => void removeProject(projectItem.id)}>
                        Удалить
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </article>
          </section>
        ) : null}

        {activeView === "observers" ? (
          <ObserversPanel
            projects={projects}
            observerStatus={observerStatus}
            pausedCount={pausedObserverProjects.length}
            onToggleProject={(observerProjectPaths, nextRunning) => void toggleProjectObserver(observerProjectPaths, nextRunning)}
            onStopAll={() => void stopAllObserversNow()}
            onResume={() => void resumeObservers()}
          />
        ) : null}

        {error ? <p className="error">{error}</p> : null}
        </section>

        {activeView === "chat" ? (
          <WorktreeManagerSidebar
            projectName={safeText(project?.name, "Проект")}
            conversationId={conversationId}
          />
        ) : null}
      </section>

      <InspectorDrawer
        open={inspectorOpen}
        activeTab={activeInspectorTab}
        onClose={() => setInspectorOpen(false)}
        onChangeTab={setActiveInspectorTab}
        result={result}
      />
    </main>
  );
}
