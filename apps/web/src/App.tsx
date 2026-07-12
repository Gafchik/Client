import { startTransition, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import type {
  BackgroundProjectState,
  ContextCandidate,
  KnowledgeCatalogEntry,
  ProjectCatalogResponse,
  ProjectPathRecord,
  ProjectRecord,
  PipelineRunResult,
  PipelineRunStatus,
  ProviderCatalogResponse,
  ProviderModelRecord,
  ProviderRecord,
  RepositorySnapshot,
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

type ProviderDraft = {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
};

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

type AppView = "chat" | "providers" | "projects";

type InspectorTab = "overview" | "research" | "impact" | "context" | "plan" | "execution" | "knowledge" | "git" | "diagnostics";

const API_BASE_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3001";
const PROVIDER_STORAGE_KEY = "client.provider-config";
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
function AnswerMarkdown({ text }: { text: string }) {
  const trimmed = typeof text === "string" ? text.trim() : "";

  if (!trimmed) {
    return null;
  }

  const blocks: Array<{ type: "heading"; text: string } | { type: "list"; items: string[] } | { type: "paragraph"; text: string }> = [];
  let currentList: string[] | null = null;

  for (const rawLine of trimmed.split("\n")) {
    const line = rawLine.trim();

    if (!line) {
      currentList = null;
      continue;
    }

    const headingMatch = /^#{1,6}\s+(.+)/.exec(line);
    if (headingMatch && headingMatch[1]) {
      currentList = null;
      blocks.push({ type: "heading", text: headingMatch[1].trim() });
      continue;
    }

    const bulletMatch = /^[-*•]\s+(.+)/.exec(line);
    if (bulletMatch && bulletMatch[1]) {
      if (!currentList) {
        currentList = [];
        blocks.push({ type: "list", items: currentList });
      }
      currentList.push(bulletMatch[1].trim());
      continue;
    }

    currentList = null;
    blocks.push({ type: "paragraph", text: line });
  }

  return (
    <div className="answer-markdown">
      {blocks.map((block, index) => {
        if (block.type === "heading") {
          return <h4 key={index}>{block.text}</h4>;
        }

        if (block.type === "list") {
          return (
            <ul key={index}>
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex}>{item}</li>
              ))}
            </ul>
          );
        }

        return <p key={index}>{block.text}</p>;
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

function normalizeProviderCatalog(data: ProviderCatalogResponse): ProviderCatalogResponse {
  return {
    providers: safeList(data.providers),
    currentProvider: data.currentProvider ?? null,
    models: safeList(data.models),
    ...(data.recommendedModelId ? { recommendedModelId: data.recommendedModelId } : {}),
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

function RunHistorySidebar({
  recentRuns,
  activeRunId,
  onSelectRun,
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
  activeRunId: string | null;
  onSelectRun: (runId: string) => void;
  onStartNewChat: () => void;
  projectName: string;
  selectedIds: Set<string>;
  onToggleSelect: (runId: string) => void;
  onToggleSelectAll: (allIds: string[]) => void;
  onDeleteSelected: () => void;
  onDeleteOne: (runId: string) => void;
  deleting: boolean;
}) {
  const items = safeList(recentRuns).slice(0, 10);
  const allIds = items.map((entry) => entry.runId);
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
            items.map((entry) => (
              <div key={entry.runId} className={`history-item-row ${activeRunId === entry.runId ? "history-item-row-active" : ""}`}>
                <input
                  type="checkbox"
                  className="history-item-checkbox"
                  checked={selectedIds.has(entry.runId)}
                  onChange={() => onToggleSelect(entry.runId)}
                  onClick={(event) => event.stopPropagation()}
                />
                <button type="button" className="history-item" onClick={() => onSelectRun(entry.runId)}>
                  <strong>{buildHistoryTitle(entry.task)}</strong>
                  <span>{formatHistoryTime(entry.savedAt)}</span>
                </button>
                <button
                  type="button"
                  className="history-item-delete"
                  title="Удалить чат"
                  onClick={(event) => {
                    event.stopPropagation();
                    onDeleteOne(entry.runId);
                  }}
                  disabled={deleting}
                >
                  ×
                </button>
              </div>
            ))
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

function EnvironmentStrip({
  projects,
  selectedProjectId,
  selectedProjectPathId,
  selectedProviderId,
  providerModelDraft,
  providers,
  providerModels,
  project,
  onProjectChange,
  onProjectPathChange,
  onProviderChange,
  onModelChange,
}: {
  projects: ProjectRecord[];
  selectedProjectId: string;
  selectedProjectPathId: string;
  selectedProviderId: string;
  providerModelDraft: string;
  providers: ProviderRecord[];
  providerModels: ProviderModelRecord[];
  project: ProjectInfo | null;
  onProjectChange: (projectId: string) => void;
  onProjectPathChange: (pathId: string) => void;
  onProviderChange: (providerId: string) => void;
  onModelChange: (modelId: string) => void;
}) {
  return (
    <section className="environment-strip">
      <select className="environment-pill" value={selectedProjectId} onChange={(event) => onProjectChange(event.target.value)}>
        <option value="">Проект</option>
        {safeList(projects).map((projectItem) => (
          <option key={projectItem.id} value={projectItem.id}>
            {projectItem.name}
          </option>
        ))}
      </select>

      <select className="environment-pill" value={selectedProjectPathId} onChange={(event) => onProjectPathChange(event.target.value)}>
        <option value="">Путь</option>
        {safeList(projects.find((item) => item.id === selectedProjectId)?.paths).map((pathItem) => (
          <option key={pathItem.id} value={pathItem.id}>
            {pathItem.name}
          </option>
        ))}
      </select>

      <select className="environment-pill" value={selectedProviderId} onChange={(event) => onProviderChange(event.target.value)}>
        <option value="">Провайдер</option>
        {safeList(providers).map((provider) => (
          <option key={provider.id} value={provider.id}>
            {provider.name}
          </option>
        ))}
      </select>

      <select className="environment-pill" value={providerModelDraft} onChange={(event) => onModelChange(event.target.value)}>
        {groupModelsByVendor(safeList(providerModels)).map((group) => (
          <optgroup key={group.vendor} label={group.vendor}>
            {group.models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.label}
              </option>
            ))}
          </optgroup>
        ))}
        {!providerModels.length ? <option value={DEFAULT_MODEL_ID}>{DEFAULT_MODEL_ID}</option> : null}
      </select>

      <div className="environment-status-pill">
        <strong>{backgroundSyncState(project).title}</strong>
        <span>{projectReadinessState(project).title}</span>
      </div>
    </section>
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
        <p className="message-footnote">Путь: {safeText(projectPath)}</p>
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
function ThinkingIndicator({ currentStageLabel }: { currentStageLabel?: string }) {
  return (
    <div className="thinking-indicator">
      <span className="thinking-dots">
        <span />
        <span />
        <span />
      </span>
      <span className="thinking-label">{safeText(currentStageLabel, "Изучаю проект")}</span>
    </div>
  );
}

function AssistantRunMessage({
  runStatus,
  result,
  onOpenInspector,
  clarificationRound,
  onSelectClarification,
}: {
  runStatus: PipelineRunStatus | null;
  result: PipelineRunResult | null;
  onOpenInspector: (tab?: InspectorTab) => void;
  clarificationRound: number;
  onSelectClarification: (moduleKey: string) => void;
}) {
  const running = runStatus && (runStatus.status === "queued" || runStatus.status === "running");
  const completed = hasRunArtifacts(result) && (!runStatus || runStatus.runId === result.runId);
  const failed = runStatus?.status === "failed";
  // Circuit breaker: после MAX_CLARIFICATION_ROUNDS не показываем chips
  // повторно, даже если бэкенд снова вернул clarification-needed — иначе
  // риск бесконечного цикла уточнений. Рендерим как обычный ответ.
  const needsClarification =
    completed && result?.answer?.answerMode === "clarification-needed" && clarificationRound < MAX_CLARIFICATION_ROUNDS;

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
            <ThinkingIndicator {...(runStatus?.currentStageLabel ? { currentStageLabel: runStatus.currentStageLabel } : {})} />
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
          </>
        ) : null}

        {completed && needsClarification ? (
          <>
            {/* Суженная ветка: quick-grid/план намеренно не показываем — иначе
                рядом с "уточните вопрос" будет показан уверенный конкретный
                план для одной из отброшенных интерпретаций. */}
            <p className="message-label">Нужно уточнение · {safeText(result.project.name, "Проект неизвестен")}</p>
            <h3>{safeText(result?.answer?.summary, "Уточните вопрос")}</h3>
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
            <p className="message-label">Ответ подготовлен · {safeText(result.project.name, "Проект неизвестен")}</p>
            <h3>{safeText(result.answer?.summary, result.research.summary)}</h3>
            <AnswerMarkdown
              text={safeText(
                result.answer?.explanation,
                result.research.functionalSummary || "Функциональная картина пока не сформирована.",
              )}
            />

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

            <div className="action-row">
              <button type="button" className="ghost-button" onClick={() => onOpenInspector("overview")}>
                Почему я так ответил
              </button>
              <button type="button" className="ghost-button" onClick={() => onOpenInspector("research")}>
                Открыть исследование
              </button>
              <button type="button" className="ghost-button" onClick={() => onOpenInspector("plan")}>
                Посмотреть план
              </button>
              <button type="button" className="ghost-button" onClick={() => onOpenInspector("execution")}>
                Execution preview
              </button>
            </div>
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
      : "chat";
  const routeRunId = routeParams.runId ?? null;
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [task, setTask] = useState("");
  const [projectPath, setProjectPath] = useState("");
  const [selectedProjectId, setSelectedProjectId] = useState<string>("");
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
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [runStatus, setRunStatus] = useState<PipelineRunStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PipelineRunResult | null>(null);
  const [selectedTask, setSelectedTask] = useState<string>("");
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
  const selectedProjectIdRef = useRef<string>("");
  const projectPathRef = useRef<string>("");
  const readiness = projectReadinessState(project);
  const backgroundSyncStatus = backgroundSyncState(project);

  useEffect(() => {
    void initializeApp();
  }, []);

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
      void loadProject(projectPath, selectedProjectId || undefined);
    }, 10_000);

    return () => {
      window.clearInterval(interval);
    };
  }, [activeView, projectPath, selectedProjectId]);

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
      const loadedProjects = await loadProjects();
      await loadProviders();
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

  function openInspector(tab: InspectorTab = "overview") {
    setActiveInspectorTab(tab);
    setInspectorOpen(true);
  }

  async function loadProject(nextProjectPath?: string, nextProjectId?: string) {
    setLoading(true);
    setError(null);

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
      });
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Не удалось загрузить сводку по проекту.");
    } finally {
      setLoading(false);
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

    // Нет backend-модели "продолжения диалога" — уточнение реализовано как
    // склейка строки на клиенте перед независимым pipeline run. Не
    // применяется к hardResync/background-sync (это системные операции, не
    // продолжение вопроса пользователя).
    const isFollowUpClarification =
      !hardResync
      && result?.answer?.answerMode === "clarification-needed"
      && clarificationRound < MAX_CLARIFICATION_ROUNDS;
    const composedTask = isFollowUpClarification
      ? `${selectedTask}\n\nУточнение пользователя: ${task.trim()}`
      : task.trim();

    try {
      const accepted = await fetchJsonWithTimeout<PipelineRunStatus>(`${API_BASE_URL}/api/pipeline/run`, {
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
        }),
      });

      startTransition(() => {
        setRunStatus(accepted);
        setSelectedTask(composedTask);
        setClarificationRound((round) => (isFollowUpClarification ? round + 1 : 0));
        updateActiveRunId(accepted.runId);
        setResult(null);
        setInspectorOpen(false);
      });
      navigate(`/chat/${encodeURIComponent(accepted.runId)}`);

      await pollPipelineStatus(accepted.runId);
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : "Не удалось выполнить pipeline.");
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

      const status = await fetchJsonWithTimeout<PipelineRunStatus>(
        `${API_BASE_URL}/api/pipeline/status?runId=${encodeURIComponent(runId)}`,
        undefined,
        8000,
      );

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
        await loadProject(resolvedProjectPath, resolvedProjectId);
        return;
      }

      if (status.status === "failed") {
        startTransition(() => {
          updateActiveRunId(null);
        });
        throw new Error(status.errorMessage || "Pipeline завершился ошибкой.");
      }

      await new Promise((resolve) => window.setTimeout(resolve, 1000));
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

      startTransition(() => {
        setResult(artifact);
        setRunStatus(null);
        updateActiveRunId(null);
        setSelectedTask(artifact.knowledge?.runId ? safeText(artifact.research?.summary, selectedTask) : selectedTask);
      });
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Не удалось открыть запуск из истории.");
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
    });
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

  async function deleteHistoryEntries(runIds: string[]) {
    if (!runIds.length || !projectPath) {
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

      if (activeRunId && runIds.includes(activeRunId)) {
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
          <button type="button" className={`top-nav-button ${activeView === "chat" ? "top-nav-button-active" : ""}`} onClick={startNewChat}>
            Чат
          </button>
          <button type="button" className={`top-nav-button ${activeView === "projects" ? "top-nav-button-active" : ""}`} onClick={() => navigate("/projects")}>
            Проекты
          </button>
          <button type="button" className={`top-nav-button ${activeView === "providers" ? "top-nav-button-active" : ""}`} onClick={() => navigate("/providers")}>
            Провайдеры
          </button>
        </div>
      </header>

      <section className={`app-workspace ${activeView === "chat" ? "app-workspace-with-history" : "app-workspace-single"}`}>
        {activeView === "chat" ? (
          <RunHistorySidebar
            recentRuns={safeList(project?.recentRuns)}
            activeRunId={routeRunId ?? activeRunId ?? result?.runId ?? null}
            onSelectRun={(runId) => void openRunFromHistory(runId)}
            onStartNewChat={startNewChat}
            projectName={safeText(project?.name, "Проект")}
            selectedIds={selectedHistoryIds}
            onToggleSelect={toggleHistorySelection}
            onToggleSelectAll={toggleSelectAllHistory}
            onDeleteSelected={() => void deleteHistoryEntries([...selectedHistoryIds])}
            onDeleteOne={(runId) => void deleteHistoryEntries([runId])}
            deleting={deletingHistory}
          />
        ) : null}

        <section className="chat-shell chat-shell-full">
          <header className="chat-header">
          <div>
            <h1>{activeView === "chat" ? "Чат по проекту" : activeView === "projects" ? "Проекты" : "Провайдеры"}</h1>
            <p className="chat-subtitle">
              {activeView === "chat"
                ? "Задай вопрос и получи инженерный ответ поверх уже собранной карты проекта."
                : activeView === "projects"
                  ? "Редко используемый экран настройки проектов и их путей."
                  : "Редко используемый экран настройки AI-провайдеров."}
            </p>
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
              selectedProjectPathId={selectedProjectPathId}
              selectedProviderId={selectedProviderId}
              providerModelDraft={providerModelDraft}
              providers={providers}
              providerModels={providerModels}
              project={project}
              onProjectChange={(nextProjectId) => {
                setSelectedProjectId(nextProjectId);
                const selectedProject = projects.find((item) => item.id === nextProjectId);
                const activePath = selectedProject?.paths[0] ?? null;
                setSelectedProjectPathId(activePath?.id ?? "");
                setProjectPath(activePath?.rootPath ?? "");
                void loadProject(activePath?.rootPath, nextProjectId);
              }}
              onProjectPathChange={(nextPathId) => {
                setSelectedProjectPathId(nextPathId);
                const selectedProject = projects.find((item) => item.id === selectedProjectId) ?? null;
                const selectedPath = selectedProject?.paths.find((pathItem) => pathItem.id === nextPathId) ?? null;
                setProjectPath(selectedPath?.rootPath ?? "");
                void loadProject(selectedPath?.rootPath, selectedProjectId || undefined);
              }}
              onProviderChange={(providerId) => void selectProvider(providerId)}
              onModelChange={setProviderModelDraft}
            />

            <div className="chat-body">
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
              ) : !selectedTask && !running && !result ? (
                <div className="chat-hero">
                  <p className="section-kicker">Chat</p>
                  <h2>Понимание проекта за минуты, а не за часы</h2>
                  <p>
                    Выбери проект, задай вопрос и получи инженерный ответ поверх уже собранной карты проекта.
                  </p>
                  <div className="chat-suggestions">
                    <button type="button" className="ghost-button" onClick={() => setTask("Где начинается авторизация в проекте?")}>
                      Где начинается авторизация?
                    </button>
                    <button type="button" className="ghost-button" onClick={() => setTask("Что затронет изменение billing flow?")}>
                      Что затронет изменение billing?
                    </button>
                    <button type="button" className="ghost-button" onClick={() => setTask("Можно ли авторизоваться через Google?")}>
                      Можно ли войти через Google?
                    </button>
                  </div>
                </div>
              ) : null}

              {selectedTask ? <UserTaskMessage task={selectedTask} projectName={safeText(project?.name, "")} projectPath={projectPath} /> : null}

              <AssistantRunMessage
                runStatus={runStatus}
                result={result}
                onOpenInspector={openInspector}
                clarificationRound={clarificationRound}
                onSelectClarification={(moduleKey) => setTask(moduleKey)}
              />
            </div>

            <form className="composer" onSubmit={runPipeline}>
              <div className="composer-box">
                <textarea
                  value={task}
                  onChange={(event) => setTask(event.target.value)}
                  rows={4}
                  placeholder="Напиши инженерную задачу или вопрос по проекту..."
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
                  <h2>CRUD провайдеров</h2>
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
                    <span>{projectItem.paths.map((pathItem: ProjectPathRecord) => `${pathItem.name}: ${pathItem.rootPath}`).join(" · ")}</span>
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

        {error ? <p className="error">{error}</p> : null}
        </section>
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
