<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { api } from "../api";
import type { Chat, ChatMessage, ChatStats, ModelCatalogItem, Project, ProjectMemoryEntry, Provider, RunApproval, RunItem, Team } from "../types";

type StreamItem = {
  id: string;
  type: 'user' | 'assistant' | 'system' | 'agent-status' | 'run-summary' | 'token-summary';
  role?: string;
  name?: string;
  label?: string;
  content: string;
  createdAt?: string;
  meta?: any;
  status?: 'working' | 'idle' | 'done' | 'error';
  agentRole?: string;
};

type InlinePart = {
  type: "text" | "code";
  content: string;
};

type MessageBlock = {
  type: "text" | "code";
  content: string;
  lang?: string;
  inlineParts?: InlinePart[];
};

const router = useRouter();
const route = useRoute();

// Inject global data
const { providers: globalProviders, teams: globalTeams, projects: globalProjects, loading: globalLoading } = inject("globalData", {
  providers: ref<Provider[]>([]),
  teams: ref<Team[]>([]),
  projects: ref<Project[]>([]),
  loading: ref(true),
});

const state = reactive({
  providers: [] as Provider[],
  teams: [] as Team[],
  projects: [] as Project[],
  chats: [] as Chat[],
  messages: [] as ChatMessage[],
  chatRuns: [] as RunItem[],
  chatStats: {
    requestCount: 0, runCount: 0, totalActualTokens: 0, totalWeightedTokens: 0, byRole: {},
  } as ChatStats,
  projectMemory: [] as ProjectMemoryEntry[],
  runs: [] as RunItem[],
  models: [] as ModelCatalogItem[],
  settings: null as null | { env: { LOCAL_PROJECTS_ROOT: string; CONTAINER_PROJECTS_ROOT: string } },
  selectedProviderId: "",
  selectedTeamId: "",
  selectedProjectId: "",
  selectedChatId: "",
  selectedRunId: "",
  report: null as any,
  runStatus: "",
  runEvents: [] as Array<{ at: string; event: string; payload?: unknown }>,
  runError: "",
  busy: false,
  resolvingApprovalId: "" as string,
  toasts: [] as Array<{ id: number; type: 'success' | 'error' | 'info'; message: string }>,
  deleteConfirm: null as null | { type: 'project' | 'chat'; id: string; name: string; onConfirm: () => Promise<void> },
  streamingMessage: null as null | { id: string; content: string; role: string; isRunExecution: boolean },
});

const chatDraft = ref("");
const messagesListRef = ref<HTMLElement | null>(null);
const composerTextareaRef = ref<HTMLTextAreaElement | null>(null);
let isMounted = false;
let pollTimer: number | null = null;
let toastId = 0;
let ws: any = null;
let wsReconnectTimer: number | null = null;
let scrollFrame: number | null = null;
let shouldAutoScroll = true;
let isLoadingChat = false;
let lastStreamLength = 0;
let userHasScrolled = false;

const selectedProvider = computed(() => state.providers.find((item) => item.id === state.selectedProviderId) ?? null);
const selectedTeam = computed(() => state.teams.find((item) => item.id === state.selectedTeamId) ?? null);
const selectedProject = computed(() => state.projects.find((item) => item.id === state.selectedProjectId) ?? null);
const selectedChat = computed(() => state.chats.find((item) => item.id === state.selectedChatId) ?? null);
const EMPTY_AGENTS = {
  orchestrator: { name: "", label: "", model: "", multiplier: 1, temperature: 0.2 },
  developer: { name: "", label: "", model: "", multiplier: 1, temperature: 0.15 },
  tester: { name: "", label: "", model: "", multiplier: 1, temperature: 0.1 },
  analyst: { name: "", label: "", model: "", multiplier: 1, temperature: 0.2 },
};
function emptyTeam(): Team {
  return {
    id: "",
    name: "",
    description: "",
    providerId: "",
    language: "ru",
    budget: { dailyWeightedTokens: 0, timezone: "UTC" },
    workspace: { maxFiles: 0, maxCharsPerFile: 0, includeExtensions: [], ignoreDirs: [] },
    run: { maxReviewRounds: 0, applyChanges: false },
    testing: { commands: [] },
    agents: EMPTY_AGENTS,
  } as unknown as Team;
}
const selectedProjectTeam = computed(() => {
  const project = selectedProject.value;
  if (!project?.teamId) return emptyTeam();
  return state.teams.find((item) => item.id === project.teamId) ?? emptyTeam();
});

const modelGroups = computed(() => state.models.reduce<Record<string, ModelCatalogItem[]>>((groups, model) => { if (!groups[model.provider]) groups[model.provider] = []; groups[model.provider].push(model); return groups; }, {}));
const pendingApprovals = computed(() => {
  const approvals: RunApproval[] = [];
  for (const entry of state.runEvents) {
    if (entry.event !== "approval:requested" || !entry.payload || typeof entry.payload !== "object") continue;
    const payload = entry.payload as RunApproval;
    if (payload.status === "pending") approvals.push(payload);
  }
  return approvals;
});

const displayedMessages = computed(() => {
  return state.messages;
});

const unifiedChatStream = computed(() => {
  const stream: StreamItem[] = [];
  
  // Track seen activity IDs to avoid duplicates between runEvents and saved messages
  const seenActivityIds = new Set<string>();
  
  for (const msg of displayedMessages.value) {
    if (msg.role === 'user') {
      stream.push({ id: msg.id, type: 'user', content: msg.content, createdAt: msg.createdAt, meta: msg.meta });
    } else if (msg.meta?.type === 'agent-status') {
      // Agent status messages saved from runs.service.ts
      const meta = msg.meta as any;
      const activityId = `activity-${meta.runId}-${meta.agentRole}-${meta.timestamp}`;
      if (!seenActivityIds.has(activityId)) {
        seenActivityIds.add(activityId);
        stream.push({ 
          id: msg.id, 
          type: 'agent-status', 
          agentRole: meta.agentRole, 
          name: meta.agentName, 
          label: meta.agentLabel, 
          content: msg.content, 
          createdAt: msg.createdAt, 
          status: meta.status,
          meta: msg.meta 
        });
      }
    } else {
      const orchPayload = msg.meta?.orchestratorPayload;
      const usage = msg.meta?.usage;
      // Финальный отчёт (meta.finalReport=true) хранит настоящий итог работы
      // агентов в msg.content (диагноз/summary). orchestratorPayload.message —
      // это план "Понял задачу...", который НЕ должен затирать финалку.
      // Раньше приоритет orchPayload.message рисовал перепечатку плана в конце.
      const isFinalReport = msg.meta?.finalReport === true || msg.meta?.finalReport === 'true';
      const displayContent = isFinalReport
        ? String(msg.content ?? "")
        : String(orchPayload?.message ?? msg.content ?? "");
      stream.push({ 
        id: msg.id, 
        type: 'assistant', 
        role: usage?.role || 'assistant', 
        name: usage?.name || 'Alex', 
        label: usage?.label || 'Оркестратор', 
        content: displayContent, 
        createdAt: msg.createdAt, 
        meta: msg.meta 
      });
    }

  }
  
  if (state.runEvents.length) {
    for (const entry of state.runEvents) {
      if (entry.event === 'agent:activity' && entry.payload) { 
        const p = entry.payload as any; 
        const activityId = `activity-${entry.at}-${p.role}`;
        if (!seenActivityIds.has(activityId)) {
          seenActivityIds.add(activityId);
          stream.push({ id: `activity-${entry.at}-${p.role}`, type: 'agent-status', agentRole: p.role, name: p.agentName, label: p.label, content: p.detail, createdAt: entry.at, status: p.status }); 
        }
      }
      else if (entry.event === 'agent:done' && entry.payload) { const p = entry.payload as any; stream.push({ id: `done-${entry.at}-${p.role}`, type: 'agent-status', agentRole: p.role, name: p.agentName, label: p.label, content: `✓ Завершил: ${p.detail || 'этап'}`, createdAt: entry.at, status: 'done' }); }
      else if (entry.event === 'agent:skipped' && entry.payload) { const p = entry.payload as any; stream.push({ id: `skipped-${entry.at}-${p.role}`, type: 'agent-status', agentRole: p.role, name: p.agentName, label: p.label, content: `⊘ Пропущен: ${p.reason || 'не требуется'}`, createdAt: entry.at, status: 'idle' }); }
      else if (entry.event === 'run:blocked') stream.push({ id: `blocked-${entry.at}`, type: 'system', content: `⚠ Запуск остановлен: ${(entry.payload as any)?.detail}`, createdAt: entry.at });
      else if (entry.event === 'files:applied') { const p = entry.payload as any; stream.push({ id: `applied-${entry.at}`, type: 'system', content: `📝 Применено: ${p.applied?.length || 0}, пропущено: ${p.skipped?.length || 0}`, createdAt: entry.at }); }
      else if (entry.event === 'tests:done') { const p = entry.payload as any; const passed = p?.filter((t: any) => t.success).length || 0; const failed = p?.filter((t: any) => !t.success).length || 0; stream.push({ id: `tests-${entry.at}`, type: 'system', content: `🧪 Тесты: ${passed} пройдено, ${failed} упало`, createdAt: entry.at }); }
      else if (entry.event === 'agent:note') { const p = entry.payload as any; stream.push({ id: `note-${entry.at}-${p.role}`, type: 'agent-status', agentRole: p.role, name: p.agentName, label: p.label, content: p.detail, createdAt: entry.at, status: 'working' }); }
      else if (entry.event === 'agent:retry') { const p = entry.payload as any; stream.push({ id: `retry-${entry.at}-${p.role}`, type: 'agent-status', agentRole: p.role, name: p.agentName, label: p.label, content: `↻ Ответ не распарсился, автоповтор ${p.attempt || '?'}/3`, createdAt: entry.at, status: 'working' }); }
      else if (entry.event === 'agent:retry-success') { const p = entry.payload as any; stream.push({ id: `retry-success-${entry.at}-${p.role}`, type: 'agent-status', agentRole: p.role, name: p.agentName, label: p.label, content: `✓ Прислал валидный JSON, выполнение продолжено`, createdAt: entry.at, status: 'done' }); }
      else if (entry.event === 'developer:empty-operations') { const p = entry.payload as any; stream.push({ id: `empty-ops-${entry.at}-${p.role}`, type: 'agent-status', agentRole: p.role, name: p.agentName, label: p.label, content: `⚠ Не вернул правки, получает повторную задачу`, createdAt: entry.at, status: 'working' }); }
      else if (entry.event === 'file:processing') { const p = entry.payload as any; stream.push({ id: `file-proc-${entry.at}-${p.path}`, type: 'agent-status', agentRole: 'developer', name: 'Kai', label: 'Разработчик', content: `📝 ${p.action === 'create' ? 'Создаёт' : 'Обновляет'} файл: ${p.path}`, createdAt: entry.at, status: 'working' }); }
      else if (entry.event === 'file:applied') { const p = entry.payload as any; stream.push({ id: `file-applied-${entry.at}-${p.path}`, type: 'agent-status', agentRole: 'developer', name: 'Kai', label: 'Разработчик', content: `✓ ${p.action === 'create' ? 'Создал' : 'Обновил'} файл: ${p.path}`, createdAt: entry.at, status: 'done' }); }
      else if (entry.event === 'file:skipped') { const p = entry.payload as any; stream.push({ id: `file-skipped-${entry.at}-${p.path}`, type: 'agent-status', agentRole: 'developer', name: 'Kai', label: 'Разработчик', content: `⊘ Пропустил файл: ${p.path} (${p.reason})`, createdAt: entry.at, status: 'idle' }); }
    }
  }
  return stream.sort((a, b) => new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime());
});

const liveTeamMessages = computed(() => {
  const events = ["agent:activity", "agent:retry", "agent:retry-success", "agent:note", "agent:done", "agent:skipped", "developer:empty-operations", "run:blocked", "file:processing", "file:applied", "file:skipped", "files:applied", "test:started", "test:finished", "tests:done", "tests:skipped"];
  return state.runEvents
    .filter((entry) => events.includes(entry.event))
    .map((entry) => {
      const payload = eventActor(entry.payload);
      return {
        id: `live-${entry.at}-${payload.role}-${entry.event}`,
        role: "assistant",
        content: formatActivityEntry(entry),
        createdAt: entry.at,
        meta: { usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, weightedTokens: 0, multiplier: 1, model: payload.role, role: payload.role, name: payload.agentName, label: payload.label } }
      } as ChatMessage;
    });
});

function eventActor(payload: unknown) { if (!payload || typeof payload !== "object") return { agentName: "Команда", label: "Система", role: "system", detail: "", attempt: undefined as number | undefined }; const meta = payload as { agentName?: string; label?: string; role?: string; detail?: string; attempt?: number }; return { agentName: meta.agentName || "Команда", label: meta.label || "Система", role: meta.role || "system", detail: meta.detail || "", attempt: meta.attempt }; }

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function parseInlineParts(text: string): InlinePart[] {
  const parts: InlinePart[] = [];
  const regex = /`([^`]+)`/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ type: "text", content: text.slice(lastIndex, match.index) });
    }
    parts.push({ type: "code", content: match[1] });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    parts.push({ type: "text", content: text.slice(lastIndex) });
  }

  return parts.length ? parts : [{ type: "text", content: text }];
}

function parseMessageBlocks(content: string): MessageBlock[] {
  const normalized = String(content || "").replace(/\r\n/g, "\n");
  const regex = /```([\w-]*)\n([\s\S]*?)```/g;
  const blocks: MessageBlock[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(normalized)) !== null) {
    const plain = normalized.slice(lastIndex, match.index).trim();
    if (plain) {
      for (const chunk of plain.split(/\n{2,}/).map((item) => item.trim()).filter(Boolean)) {
        blocks.push({ type: "text", content: chunk, inlineParts: parseInlineParts(chunk) });
      }
    }
    blocks.push({ type: "code", lang: match[1] || "", content: match[2].replace(/\n$/, "") });
    lastIndex = match.index + match[0].length;
  }

  const tail = normalized.slice(lastIndex).trim();
  if (tail) {
    for (const chunk of tail.split(/\n{2,}/).map((item) => item.trim()).filter(Boolean)) {
      blocks.push({ type: "text", content: chunk, inlineParts: parseInlineParts(chunk) });
    }
  }

  return blocks.length ? blocks : [{ type: "text", content: normalized, inlineParts: parseInlineParts(normalized) }];
}

function renderInlineParts(parts: InlinePart[] = []): string {
  return parts.map((part) => (
    part.type === "code"
      ? `<code>${escapeHtml(part.content)}</code>`
      : escapeHtml(part.content).replace(/\n/g, "<br>")
  )).join("");
}

function messageBlocks(item: StreamItem): MessageBlock[] {
  return parseMessageBlocks(item.content || "");
}

function canCopyMessage(item: StreamItem): boolean {
  return item.type === "user" || item.type === "assistant" || item.type === "run-summary";
}

function canShowAgentMeta(item: StreamItem): boolean {
  return item.type === "assistant" || item.type === "run-summary";
}

// ---- Читаемый стрим агентов -------------------------------------------------
// Агенты отвечают JSON-скелетом ({"message":"...","shouldExecute":...}) или
// маркерами (SUMMARY:...). Показывать сырой скелет в чате — некрасиво. Эти
// функции на лету вытягивают человекочитаемое поле из ЧАСТИЧНОГО стрима и
// прячут JSON-обёртку. Так в чате виден обычный текст «думаю… делаю…», как
// в привычных AI-чатах.
const AGENT_DISPLAY: Record<string, { name: string; letter: string; cls: string; placeholder: string }> = {
  orchestrator: { name: 'Alex (Оркестратор)', letter: 'A', cls: 'orchestrator', placeholder: 'Анализирую задачу и планирую работу команды…' },
  analyst: { name: 'Mira (Аналитик)', letter: 'M', cls: 'analyst', placeholder: 'Изучаю код и составляю техническое задание…' },
  developer: { name: 'Kai (Разработчик)', letter: 'K', cls: 'developer', placeholder: 'Пишу код и применяю изменения…' },
  tester: { name: 'Nova (Тестировщик)', letter: 'N', cls: 'tester', placeholder: 'Проверяю изменения…' },
};
function agentDisplay(role: string) { return AGENT_DISPLAY[role] || AGENT_DISPLAY.orchestrator; }

function decodeJsonString(s: string): string {
  return s.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}
// Вытягивает строковое поле из частичного JSON (строка может быть ещё не закрыта).
function extractJsonField(raw: string, field: string): string | null {
  const re = new RegExp(`"${field}"\\s*:\\s*"`);
  const m = re.exec(raw);
  if (!m) return null;
  let i = m.index + m[0].length;
  let out = '';
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === '\\' && i + 1 < raw.length) { out += ch + raw[i + 1]; i += 2; continue; }
    if (ch === '"') break; // закрывающая кавыка строки
    out += ch; i++;
  }
  return out ? decodeJsonString(out) : null;
}
// Извлекает читаемый текст из сырого стрима агента по его роли.
function extractReadableText(role: string, raw: string): string {
  if (!raw) return '';
  if (role === 'developer') {
    const m = raw.match(/^[ \t]*SUMMARY:[ \t]*(.+?)$/m);
    return m ? m[1].trim() : '';
  }
  if (role === 'orchestrator') {
    return extractJsonField(raw, 'message') || '';
  }
  if (role === 'analyst') {
    return extractJsonField(raw, 'description') || extractJsonField(raw, 'feature') || '';
  }
  if (role === 'tester') {
    const pm = raw.match(/"passed"\s*:\s*(true|false)/);
    if (pm) return pm[1] === 'true' ? 'Проверяю изменения — явных ошибок пока не вижу.' : 'Нашёл замечания, формирую отчёт…';
    return '';
  }
  return '';
}
const streamingDisplayName = computed(() => state.streamingMessage ? agentDisplay(state.streamingMessage.role).name : '');
const streamingAvatarLetter = computed(() => state.streamingMessage ? agentDisplay(state.streamingMessage.role).letter : '');
const streamingAvatarClass = computed(() => state.streamingMessage ? agentDisplay(state.streamingMessage.role).cls : 'orchestrator');
const streamingDisplayContent = computed(() => {
  if (!state.streamingMessage) return '';
  const text = extractReadableText(state.streamingMessage.role, state.streamingMessage.content);
  return text || agentDisplay(state.streamingMessage.role).placeholder;
});

function formatActivityEntry(entry: { at: string; event: string; payload?: unknown }) { const actor = eventActor(entry.payload); if (entry.event === "agent:activity") return `${actor.agentName} (${actor.label}): ${actor.detail}`; if (entry.event === "agent:retry") return `${actor.agentName} (${actor.label}): ответ не распарсился, автоповтор ${actor.attempt || "?"}/3`; if (entry.event === "agent:retry-success") return `${actor.agentName} (${actor.label}): прислал валидный JSON, выполнение продолжено`; if (entry.event === "agent:note") return `${actor.agentName} (${actor.label}): ${actor.detail}`; if (entry.event === "agent:done") return `${actor.agentName} (${actor.label}): завершил этап`; if (entry.event === "agent:skipped") return `${actor.agentName} (${actor.label}): сейчас не задействован`; if (entry.event === "developer:empty-operations") return `${actor.agentName} (${actor.label}): не вернул правки, получает повторную задачу`; if (entry.event === "run:blocked") return `${actor.agentName} (${actor.label}): прогон остановлен, нет реальных правок`; if (entry.event === "file:processing") { const p = entry.payload as { path?: string; action?: string }; return `Разработчик: ${p?.action === "create" ? "создаёт" : "обновляет"} файл ${p?.path || "-"}`; } if (entry.event === "file:applied") { const p = entry.payload as { path?: string; action?: string }; return `Разработчик: ${p?.action === "create" ? "создал" : "обновил"} файл ${p?.path || "-"}`; } if (entry.event === "file:skipped") { const p = entry.payload as { path?: string; reason?: string }; return `Разработчик: пропустил файл ${p?.path || "-"} (${p?.reason || "без причины"})`; } if (entry.event === "files:applied") return "Разработчик применил изменения к файлам"; if (entry.event === "test:started") { const p = entry.payload as { command?: string }; return `Тестировщик: запускает "${p?.command || ""}"`; } if (entry.event === "test:finished") { const p = entry.payload as { command?: string; success?: boolean; code?: number }; return `Тестировщик: ${p?.success ? "успешно завершил" : "завершил с ошибкой"} "${p?.command || ""}" (code ${p.code ?? "-"})`; } if (entry.event === "tests:done") return "Тестировщик завершил проверку"; if (entry.event === "tests:skipped") return "Проверка тестировщиком была пропущена"; return `Событие: ${entry.event}`; }
function avatarColor(role: string): string { const colors: Record<string, string> = { orchestrator: '#6366f1', pm: '#6366f1', analyst: '#10b981', researcher: '#10b981', developer: '#f59e0b', coder: '#f59e0b', tester: '#ef4444', system: '#6b7280', user: '#3b82f6' }; return colors[role] || colors.system; }
function agentInitial(item: any): string { const name = item.name || item.label || '?'; return name.charAt(0).toUpperCase(); }
function messageName(item: any): string { if (item.type === 'user') return 'Вы'; if (item.type === 'assistant' || item.type === 'run-summary') return `${item.name || 'Alex'} (${item.label || 'Оркестратор'})`; if (item.type === 'agent-status') return `${item.name || 'Agent'} (${item.label || item.agentRole})`; if (item.type === 'system') return 'Система'; if (item.type === 'token-summary') return 'Токены'; return 'Неизвестно'; }
function formatMessageContent(item: any): string {
  if (!item.content) return '';
  const content = String(item.content).replace(/\\n/g, '\n');
  const escaped = escapeHtml(content).replace(/\n/g, '<br>');
  if (item.type === 'agent-status') return `<span class="agent-status-text">${escaped}</span>`;
  if (item.type === 'system') return `<span class="system-text">${escaped}</span>`;
  if (item.type === 'run-summary') return `<div class="run-summary-text">${escaped}</div>`;
  return escaped;
}
function formatTime(iso?: string): string { if (!iso) return ''; return new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }

async function loadInitialData() {
  if (globalProviders.value.length) {
    state.providers = globalProviders.value;
    state.teams = globalTeams.value;
    state.projects = globalProjects.value;
  } else {
    const [providersResponse, teamsResponse, projectsResponse] = await Promise.all([api.providers(), api.teams(), api.projects()]);
    state.providers = providersResponse.providers;
    state.teams = teamsResponse.teams;
    state.projects = projectsResponse.projects;
  }
  
  const [runsResponse, settingsResponse] = await Promise.all([api.runs(), api.settings()]);
  state.runs = runsResponse.runs;
  state.settings = settingsResponse;

  // Модели тянем по провайдеру первого проекта/команды (у каждого провайдера
  // свой modelsUrl в БД). Раньше грузили без providerId → всегда дефолтный
  // провайдер, и сторонние провайдеры «подтягивали» чужие модели + множитель
  // не совпадал с реальным у выбранной модели.
  const initialProviderId = (() => {
    const proj = state.projects[0];
    const team = proj ? state.teams.find(t => t.id === proj.teamId) : state.teams[0];
    return team?.providerId || state.providers[0]?.id || "";
  })();
  if (initialProviderId) {
    const modelsResponse = await api.models(initialProviderId);
    state.models = modelsResponse.items;
  } else {
    state.models = [];
  }
  
  state.selectedProviderId = state.providers[0]?.id || "";
  state.selectedTeamId = state.teams[0]?.id || "";
  state.selectedProjectId = state.projects[0]?.id || "";
  
  if (state.selectedProjectId) { await refreshChats(state.selectedProjectId); }
  if (state.runs[0]) await openRun(state.runs[0].id);
}

async function refreshChats(projectId?: string) { if (!projectId) { state.chats = []; state.selectedChatId = ""; state.messages = []; state.chatRuns = []; state.chatStats = { requestCount: 0, runCount: 0, totalActualTokens: 0, totalWeightedTokens: 0, byRole: {} }; return; } const response = await api.chats(projectId); state.chats = response.chats; state.selectedChatId = state.chats[0]?.id || ""; if (state.selectedChatId) await openChat(state.selectedChatId); else { state.messages = []; state.chatRuns = []; state.chatStats = { requestCount: 0, runCount: 0, totalActualTokens: 0, totalWeightedTokens: 0, byRole: {} }; } }
async function openChat(id: string) { state.selectedChatId = id; isLoadingChat = true; const response = await api.chatById(id); state.messages = response.messages; state.chatRuns = response.runs; state.chatStats = response.stats; state.runEvents = []; state.runError = ""; state.report = null; state.runStatus = ""; clearAgentLogs(); await nextTick(); isLoadingChat = false; shouldAutoScroll = true; userHasScrolled = false; scheduleScrollToBottom("auto"); }
async function openRun(id: string) { state.selectedRunId = id; const response = await api.runById(id); state.report = response.report; state.runStatus = response.run.status; state.runEvents = response.run.events ?? []; state.runError = response.run.error ?? ""; }

function showToast(type: 'success' | 'error' | 'info', message: string) { const id = ++toastId; state.toasts.push({ id, type, message }); setTimeout(() => { const idx = state.toasts.findIndex(t => t.id === id); if (idx !== -1) state.toasts.splice(idx, 1); }, 4000); }
function confirmDelete(type: 'project' | 'chat', id: string, name: string, onConfirm: () => Promise<void>) { state.deleteConfirm = { type, id, name, onConfirm }; }
async function executeDelete() { if (!state.deleteConfirm) return; const { onConfirm } = state.deleteConfirm; state.deleteConfirm = null; try { await onConfirm(); showToast('success', 'Удалено'); } catch (e) { showToast('error', e instanceof Error ? e.message : 'Ошибка удаления'); } }
async function createChat() { if (!selectedProject.value || !(selectedProject.value.teamId || state.selectedTeamId)) return; state.busy = true; try { const response = await api.saveChat({ projectId: selectedProject.value.id, teamId: selectedProject.value.teamId || state.selectedTeamId, title: `Чат ${state.chats.length + 1}`, summary: "" }); state.chats.unshift(response.chat); state.selectedChatId = response.chat.id; await openChat(response.chat.id); showToast('success', 'Чат создан'); } catch (e) { showToast('error', e instanceof Error ? e.message : 'Ошибка'); } finally { state.busy = false; } }
async function deleteChat(id: string) { const chat = state.chats.find(c => c.id === id); if (!chat) return; confirmDelete('chat', id, chat.title, async () => { state.busy = true; try { await api.deleteChat(id); state.chats = state.chats.filter(c => c.id !== id); if (state.selectedChatId === id) { const fallback = state.chats[0] || null; state.selectedChatId = fallback?.id || ""; if (fallback) await openChat(fallback.id); else { state.messages = []; state.chatRuns = []; state.chatStats = { requestCount: 0, runCount: 0, totalActualTokens: 0, totalWeightedTokens: 0, byRole: {} }; } } showToast('success', 'Чат удалён'); } finally { state.busy = false; } }); }
async function sendChatMessage() { if (!selectedChat.value || !chatDraft.value.trim()) return; const draft = chatDraft.value.trim(); state.busy = true; chatDraft.value = ""; try { const response = await api.sendChatMessage(selectedChat.value.id, draft); await openChat(selectedChat.value.id); if (response.autoRunId) { state.selectedRunId = response.autoRunId; state.runStatus = "queued"; state.runEvents = []; state.runError = ""; state.report = null; clearAgentLogs(); startPolling(response.autoRunId); /* busy stays true: polling resets it when run completes */ } else { state.busy = false; } } catch (e) { chatDraft.value = draft; showToast('error', e instanceof Error ? e.message : 'Ошибка'); state.busy = false; } }
async function runTask() { if (!selectedChat.value || !chatDraft.value.trim()) return; const draft = chatDraft.value.trim(); const project = selectedProject.value; const team = selectedProjectTeam.value; if (!project || !team) return; state.busy = true; chatDraft.value = ""; try { const response = await api.startRun({ chatId: selectedChat.value.id, task: draft, teamId: team.id, teamName: team.name, projectPath: project.localPath || '' }); state.selectedRunId = response.runId; state.runStatus = "queued"; state.runEvents = []; state.runError = ""; state.report = null; clearAgentLogs(); startPolling(response.runId); showToast('success', 'Работа запущена'); /* busy stays true until run completes via polling */ } catch (e) { chatDraft.value = draft; showToast('error', e instanceof Error ? e.message : 'Ошибка'); state.busy = false; } }
function startPolling(runId: string) {
  if (pollTimer) window.clearInterval(pollTimer);
  const tick = async () => {
    try {
      const response = await api.job(runId);
      state.runStatus = response.status;
      state.runError = response.error ?? "";
      // Мерджим события вместо полной замены. WS уже складывает токены и
      // agent:activity в реальном времени, а поллинг каждые 2с затирал массив
      // → мельтешение и «скачки» чата. Дедуп по at|event|payload.
      const incoming = response.events ?? [];
      const keyOf = (e: { at: string; event: string; payload?: unknown }) =>
        `${e.at}|${e.event}|${JSON.stringify(e.payload ?? "")}`;
      const existing = new Set(state.runEvents.map(keyOf));
      for (const e of incoming) {
        if (!existing.has(keyOf(e))) state.runEvents.push(e);
      }
      const runsResponse = await api.runs();
      state.runs = runsResponse.runs;
      await nextTick();
      // Скроллим вниз ТОЛЬКО если пользователь сам не ушёл вверх. Раньше
      // поллинг дёргал скролл на каждом тике — чат «прыгал» при чтении истории.
      if (shouldAutoScroll && !userHasScrolled) scheduleScrollToBottom("smooth");
      if (response.status === "completed" || response.status === "done" || response.status === "failed") {
        if (pollTimer) window.clearInterval(pollTimer);
        state.streamingMessage = null;
        state.busy = false;
        await openRun(runId);
        if (state.selectedChatId) await openChat(state.selectedChatId);
      }
    } catch (e) { console.error('Poll error:', e); }
  };
  void tick();
  pollTimer = window.setInterval(() => void tick(), 2000);
}

function clearAgentLogs() {
  // no-op, kept for compatibility
}
function scheduleScrollToBottom(behavior: ScrollBehavior = "smooth") {
  if (scrollFrame) cancelAnimationFrame(scrollFrame);
  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = null;
    scrollMessagesToBottom(behavior);
  });
}
function scrollMessagesToBottom(behavior: ScrollBehavior = "smooth") { 
  const container = messagesListRef.value; 
  if (!container) return; 
  try { 
    container.scrollTo({ top: container.scrollHeight, behavior }); 
  } catch {} 
}

function autoResizeComposer() {
  const el = composerTextareaRef.value;
  if (!el) return;
  el.style.height = "0px";
  el.style.height = `${Math.min(Math.max(el.scrollHeight, 56), 220)}px`;
}

function isUserAtBottom(): boolean { 
  const container = messagesListRef.value; 
  if (!container) return true; 
  const { scrollTop, scrollHeight, clientHeight } = container; 
  return scrollHeight - scrollTop - clientHeight < 100;
}

function onUserScroll() { 
  const atBottom = isUserAtBottom();
  shouldAutoScroll = atBottom;
  userHasScrolled = !atBottom;
}
function copyMessage(text: string) { if (!text) return; navigator.clipboard.writeText(text).then(() => showToast('success', 'Скопировано')).catch(() => showToast('error', 'Не удалось скопировать')); }
async function resolveApproval(approval: RunApproval, approved: boolean) {
  if (!state.selectedRunId || state.resolvingApprovalId) return;
  state.resolvingApprovalId = approval.id;
  try {
    const response = await api.resolveRunApproval(state.selectedRunId, approval.id, approved);
    if (!response.ok) throw new Error(response.reason || "Не удалось обработать разрешение");
    showToast('success', approved ? 'Разрешение выдано' : 'Действие отклонено');
    const job = await api.job(state.selectedRunId);
    state.runStatus = job.status;
    state.runEvents = job.events ?? [];
  } catch (e) {
    showToast('error', e instanceof Error ? e.message : 'Ошибка подтверждения');
  } finally {
    state.resolvingApprovalId = "";
  }
}
function reportText(): string { if (!state.report) return "Пока нет отчёта."; const r = state.report as any; return [`Task: ${r.task || "-"}`, `Project: ${r.projectPath || "-"}`, r.summary ? `Summary: ${r.summary}` : "", r.testResult ? `Test result: ${r.testResult}` : "", Array.isArray(r.filesChanged) && r.filesChanged.length ? `Files: ${r.filesChanged.join(", ")}` : "", r.usageSummary ? `Tokens: actual ${r.usageSummary.totalActualTokens}, weighted ${r.usageSummary.totalWeightedTokens}` : ""].filter(Boolean).join("\n"); }

function connectWebSocket() { if (ws) { ws.disconnect(); ws = null; } import('socket.io-client').then(({ io }) => { const wsUrl = import.meta.env.DEV ? `${window.location.protocol}//${window.location.hostname}:5173` : window.location.origin; try { ws = io(wsUrl, { path: '/ws/socket.io', transports: ['websocket', 'polling'], autoConnect: true }); ws.on('connect', () => { if (state.selectedChatId) ws.emit("join:chat", { chatId: state.selectedChatId }); if (state.selectedProjectId) ws.emit("join:project", { projectId: state.selectedProjectId }); }); ws.on('token:stream', (msg: any) => { handleWsMessage({ event: "token:stream", data: msg }); }); ws.on('run:event', (msg: any) => { handleWsMessage({ event: "run:event", data: msg }); }); ws.on('agent:activity', (msg: any) => { handleWsMessage({ event: "agent:activity", data: msg }); }); ws.on('disconnect', () => { wsReconnectTimer = window.setTimeout(connectWebSocket, 3000); }); ws.on('connect_error', () => {}); } catch { ws = null; } }).catch(() => { ws = null; }); }
function handleWsMessage(msg: any) { 
  if (msg.event === "token:stream") { 
    const { role, content, done, usage } = msg.data; 
    // Only show streaming for conversation mode (orchestrator), not for run execution agents
    const isRunExecution = state.runStatus === 'running' && ['orchestrator', 'analyst', 'developer', 'tester'].includes(role);
    if (done) { 
      state.streamingMessage = null; 
      // If this was a conversation response (not run execution), the final message will be loaded via openChat
    } else { 
      if (!state.streamingMessage || state.streamingMessage.role !== role) { 
        state.streamingMessage = { id: `stream-${Date.now()}`, content, role, isRunExecution }; 
      } else { 
        state.streamingMessage.content += content; 
      }
    } 
  } else if (msg.event === "run:event") { 
    const { runId, event: runEvent, data } = msg.data; 
    if (runId === state.selectedRunId) { 
      state.runEvents.push({ at: msg.timestamp, event: runEvent, payload: data }); 
      nextTick(() => { if (shouldAutoScroll && !userHasScrolled) scheduleScrollToBottom('smooth'); });
    } 
  } else if (msg.event === "agent:activity") { 
    const data = msg.data; 
    state.runEvents.push({ at: msg.timestamp, event: "agent:activity", payload: data }); 
    nextTick(() => { if (shouldAutoScroll && !userHasScrolled) scheduleScrollToBottom('smooth'); });
  } 
}
function disconnectWebSocket() { if (wsReconnectTimer) window.clearTimeout(wsReconnectTimer); if (ws) { ws.disconnect(); ws = null; } }

watch(() => state.selectedChatId, async (v) => { if (v) { await openChat(v); if (ws && ws.connected) ws.emit("join:chat", { chatId: v }); } });
watch(() => state.selectedProjectId, async (v) => { await refreshChats(v); const p = state.projects.find(i => i.id === v); if (p?.teamId) state.selectedTeamId = p.teamId; if (ws && ws.connected && v) ws.emit("join:project", { projectId: v }); });
watch(() => state.messages.length, async (curr, prev) => { if (curr === prev) return; if (!isMounted) return; await nextTick(); if (prev === 0 || shouldAutoScroll) scheduleScrollToBottom(prev === 0 ? "auto" : "smooth"); });
watch(chatDraft, async () => { await nextTick(); autoResizeComposer(); });

onMounted(() => { isMounted = true; void loadInitialData(); connectWebSocket(); void nextTick(() => autoResizeComposer()); });
onBeforeUnmount(() => { isMounted = false; if (pollTimer) window.clearInterval(pollTimer); if (scrollFrame) cancelAnimationFrame(scrollFrame); disconnectWebSocket(); });
</script>

<template>
  <div class="workspace-view">
    <div class="context-bar">
      <div class="context-select">
        <label>Проект</label>
        <select class="form-select" v-model="state.selectedProjectId">
          <option v-for="p in state.projects" :key="p.id" :value="p.id">{{ p.name }}</option>
        </select>
      </div>
      <div class="context-select" v-if="selectedProject">
        <label>Команда</label>
        <select class="form-select" v-model="selectedProject.teamId">
          <option value="">Не назначена</option>
          <option v-for="t in state.teams" :key="t.id" :value="t.id">{{ t.name }}</option>
        </select>
      </div>
      <div class="context-select">
        <label>Провайдер</label>
        <select class="form-select" v-model="state.selectedProviderId">
          <option v-for="p in state.providers" :key="p.id" :value="p.id">{{ p.name }}</option>
        </select>
      </div>
      <div class="context-select">
        <label>Чат</label>
        <div class="chat-select-wrapper">
          <select class="form-select" v-model="state.selectedChatId">
            <option value="">Создай чат</option>
            <option v-for="c in state.chats" :key="c.id" :value="c.id">{{ c.title }}</option>
          </select>
          <button v-if="selectedChat" class="btn btn-ghost btn-sm delete-chat-btn" @click="deleteChat(selectedChat.id)" title="Удалить чат">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>
        </div>
      </div>
      <div class="context-actions">
        <button class="btn btn-primary" @click="createChat" :disabled="state.busy || !selectedProject || !(selectedProject.teamId || state.selectedTeamId)">Новый чат</button>
      </div>
    </div>

    <main class="chat-area">
      <div ref="messagesListRef" class="chat-messages" @scroll="onUserScroll">
        <div v-if="unifiedChatStream.length === 0 && !state.streamingMessage" class="chat-empty">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
          <p>Выбери проект, создай чат и отправь первую задачу оркестратору.</p>
        </div>
        <div v-else class="chat-stream-inner">
          <template v-for="item in unifiedChatStream" :key="item.id">
            <div v-if="item.type === 'agent-status' || item.type === 'system'" class="agent-line" :class="item.status || ''">
              <span class="agent-line-dot" :class="(item.status as string) || 'working'"></span>
              <span class="agent-line-text">
                <span v-if="item.name || item.agentRole" class="agent-line-name">{{ item.name || item.agentRole }}</span>
                <span v-html="formatMessageContent(item)"></span>
              </span>
            </div>
            <div v-else class="message" :class="[item.type, item.status, item.type === 'user' ? 'is-user' : 'is-assistant']">
              <div class="message-avatar" :class="item.agentRole || item.role">{{ item.type === 'user' ? '👤' : agentInitial(item) }}</div>
              <div class="message-bubble">
                <div class="message-header">
                  <span class="message-name">{{ messageName(item) }}</span>
                  <span class="message-time">{{ formatTime(item.createdAt) }}</span>
                  <span v-if="item.status" class="message-status" :class="item.status"><span class="status-dot" :class="item.status"></span>{{ item.status === 'working' ? 'Работает' : item.status === 'done' ? 'Готово' : item.status === 'idle' ? 'Пропущен' : 'Ошибка' }}</span>
                </div>
                <div class="message-body">
                  <template v-for="(block, index) in messageBlocks(item)" :key="`${item.id}-block-${index}`">
                    <div v-if="block.type === 'text'" class="message-text-block" v-html="renderInlineParts(block.inlineParts)"></div>
                    <div v-else class="code-block">
                      <div class="code-block-toolbar">
                        <span class="code-block-lang">{{ block.lang || 'code' }}</span>
                        <button class="action-btn action-btn-inline" @click="copyMessage(block.content)" title="Копировать код">
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                        </button>
                      </div>
                      <pre class="code-block-pre"><code>{{ block.content }}</code></pre>
                    </div>
                  </template>
                </div>
                <div class="message-actions">
                  <button v-if="canCopyMessage(item)" class="action-btn" @click="copyMessage(item.content)" title="Копировать сообщение">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                  </button>
                  <span v-if="canShowAgentMeta(item) && item.meta?.usage?.model" class="message-meta-chip">{{ item.meta.usage.model }}</span>
                </div>
              </div>
            </div>
          </template>
          <div v-if="state.streamingMessage" class="message assistant working">
            <div class="message-avatar" :class="streamingAvatarClass">{{ streamingAvatarLetter }}</div>
            <div class="message-bubble">
              <div class="message-header"><span class="message-name">{{ streamingDisplayName }}</span><span class="message-time">{{ formatTime(new Date().toISOString()) }}</span><span class="message-status working"><span class="status-dot working"></span>Печатает...</span></div>
              <div class="message-body">
                <div class="message-text-block" v-html="renderInlineParts(parseInlineParts(streamingDisplayContent))"></div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div v-if="pendingApprovals.length" class="approval-stack">
        <div v-for="approval in pendingApprovals" :key="approval.id" class="approval-card">
          <div class="approval-card-header">
            <div>
              <div class="approval-card-title">{{ approval.title }}</div>
              <div class="approval-card-subtitle">{{ approval.role }} хочет выполнить действие</div>
            </div>
            <span class="approval-badge">Ждёт разрешения</span>
          </div>
          <div class="approval-card-body">
            <p class="approval-description">{{ approval.description }}</p>
            <pre class="approval-command"><code>{{ approval.command }}</code></pre>
            <div v-if="approval.cwd" class="approval-cwd">Папка: {{ approval.cwd }}</div>
          </div>
          <div class="approval-actions">
            <button class="btn btn-ghost" :disabled="state.resolvingApprovalId === approval.id" @click="resolveApproval(approval, false)">
              {{ state.resolvingApprovalId === approval.id ? "Обрабатываю..." : "Отклонить" }}
            </button>
            <button class="btn btn-primary" :disabled="state.resolvingApprovalId === approval.id" @click="resolveApproval(approval, true)">
              {{ state.resolvingApprovalId === approval.id ? "Обрабатываю..." : "Разрешить" }}
            </button>
          </div>
        </div>
      </div>

      <footer class="chat-composer">
        <div class="composer-input"><textarea ref="composerTextareaRef" class="composer-textarea" v-model="chatDraft" rows="1" placeholder="Например: кто в команде, что сейчас в работе, добавь задачу на экспорт CSV" @keydown.enter.exact.shift="sendChatMessage" @keydown.enter.prevent="sendChatMessage"></textarea></div>
        <div class="composer-actions"><span class="composer-hint">Enter — отправить · Shift+Enter — новая строка</span><button class="composer-send" :disabled="state.busy || !selectedChat || !chatDraft.trim()" @click="sendChatMessage"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 2L11 13"/><path d="M22 2L15 22L11 13L2 9L22 2Z"/></svg></button></div>
      </footer>
    </main>

    <div v-if="state.deleteConfirm" class="modal-overlay" @click.self="state.deleteConfirm = null">
      <div class="modal"><div class="modal-header"><h3 class="modal-title">Подтвердить удаление</h3></div><div class="modal-body"><div class="delete-confirm"><div class="delete-confirm-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg></div><h3 class="delete-confirm-title">Удалить {{ state.deleteConfirm.type === 'project' ? 'проект' : 'чат' }}?</h3><p class="delete-confirm-text"><strong>{{ state.deleteConfirm.name }}</strong> будет удалён{{ state.deleteConfirm.type === 'project' ? ' вместе со всеми чатами, запусками и памятью' : '' }}. Это действие нельзя отменить.</p></div></div><div class="modal-footer"><button class="btn btn-ghost" @click="state.deleteConfirm = null">Отмена</button><button class="btn btn-danger" :disabled="state.busy" @click="executeDelete">Удалить</button></div></div>
    </div>

    <div v-for="toast in state.toasts" :key="toast.id" class="toast" :class="toast.type"><span class="toast-icon"><svg v-if="toast.type === 'success'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg><svg v-else-if="toast.type === 'error'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg><svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg></span><span class="toast-message">{{ toast.message }}</span></div>
  </div>
</template>

<style scoped>
.workspace-view { display:flex; flex-direction:column; height:100vh; }
.context-bar { display:flex; flex-wrap:wrap; gap:12px; align-items:flex-end; padding:12px 20px; border-bottom:1px solid var(--line); background:var(--panel); }
.context-select { display:flex; flex-direction:column; gap:4px; min-width:160px; flex:1; }
.context-select label { font-size:11px; color:var(--muted); text-transform:uppercase; letter-spacing:.5px; }
.context-select .form-select { padding:8px 12px; border-radius:var(--radius-sm); border:1px solid var(--line); background:var(--bg); color:var(--text); font:inherit; min-height:38px; }
.chat-select-wrapper { display: flex; gap: 8px; align-items: center; }
.chat-select-wrapper .form-select { flex: 1; }
.delete-chat-btn { padding: 8px; border-radius: var(--radius-sm); background: transparent; border: 1px solid var(--line); color: var(--muted); cursor: pointer; display: flex; align-items: center; justify-content: center; transition: all 0.15s; }
.delete-chat-btn:hover { background: rgba(239, 68, 68, 0.1); border-color: #ef4444; color: #ef4444; }
.delete-chat-btn svg { width: 18px; height: 18px; }
.context-actions { display:flex; gap:8px; margin-left:auto; }

.chat-area { flex:1; display:flex; flex-direction:column; min-height:0; }
.chat-messages { flex:1; overflow:auto; padding:24px 20px 32px; display:flex; flex-direction:column; gap:14px; scroll-behavior:smooth; overscroll-behavior:contain; }
.chat-stream-inner { display:flex; flex-direction:column; gap:14px; width:100%; max-width:980px; margin:0 auto; }
.chat-empty { flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center; color:var(--muted); text-align:center; gap:12px; }
.chat-empty svg { width:48px; height:48px; opacity:.5; }

/* Компактные строки телеметрии агентов (вместо пузырей для каждого статуса).
   Раньше каждый agent:activity рисовался как полноценный пузырь с аватаром —
   чат превращался в лог, «прыгал» и не был похож на чат. Теперь статус —
   короткая однострочная метка слева, как в мессенджерах («N набирает…»). */
.agent-line { display:flex; align-items:center; gap:8px; max-width:900px; margin:0 auto; width:100%; padding:2px 4px; font-size:12px; color:var(--muted); line-height:1.4; }
.agent-line-dot { width:7px; height:7px; border-radius:50%; flex-shrink:0; background:#6b7280; }
.agent-line-dot.working { background:#f59e0b; animation:pulse 1.5s infinite; }
.agent-line-dot.done { background:#10b981; }
.agent-line-dot.idle { background:#6b7280; }
.agent-line-dot.error { background:#ef4444; }
.agent-line-text { display:flex; align-items:baseline; gap:6px; flex-wrap:wrap; min-width:0; }
.agent-line-name { font-weight:600; color:var(--text); font-size:12px; }
.agent-line .agent-status-text, .agent-line .system-text { font-size:12px; color:var(--muted); }
.agent-line.error .agent-status-text, .agent-line.error .system-text { color:#ef4444; }
.message { display:flex; gap:12px; width:100%; align-items:flex-start; }
.message.is-user { flex-direction: row-reverse; }
.message-avatar { width:34px; height:34px; border-radius:10px; display:flex; align-items:center; justify-content:center; font-size:14px; font-weight:600; color:#fff; flex-shrink:0; box-shadow:0 10px 24px rgba(0,0,0,.18); }
.message-avatar.orchestrator { background:#6366f1; }
.message-avatar.developer { background:#f59e0b; }
.message-avatar.tester { background:#ef4444; }
.message-avatar.analyst { background:#10b981; }
.message-avatar.system { background:#6b7280; }
.message-avatar.user { background:#3b82f6; }
.message-bubble { flex:1; min-width:0; max-width:min(760px, calc(100% - 56px)); padding:14px 16px 12px; border-radius:18px; border:1px solid var(--line); background:rgba(255,255,255,.02); box-shadow:0 1px 0 rgba(255,255,255,.02) inset; }
.message.is-user .message-bubble { margin-left:auto; background:rgba(59,130,246,.10); border-color:rgba(59,130,246,.24); }
.message.assistant .message-bubble, .message.run-summary .message-bubble { background:rgba(16,185,129,.06); border-color:rgba(16,185,129,.18); }
.message-header { display:flex; align-items:center; gap:12px; margin-bottom:10px; flex-wrap:wrap; }
.message-name { font-weight:600; font-size:13px; }
.message-time { font-size:11px; color:var(--muted); }
.message-status { display:flex; align-items:center; gap:6px; font-size:11px; padding:2px 8px; border-radius:999px; background:var(--bg); }
.message-status.working { color:#f59e0b; }
.message-status.done { color:#10b981; }
.message-status.idle { color:#6b7280; }
.message-status.error { color:#ef4444; }
.status-dot { width:6px; height:6px; border-radius:50%; background:currentColor; }
.status-dot.working { animation:pulse 1.5s infinite; }
@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.4} }
.message-body { display:flex; flex-direction:column; gap:10px; min-width:0; }
.message-text-block { font-size:14px; line-height:1.7; color:var(--text); white-space:normal; word-break:break-word; }
.message-text-block code { background:rgba(255,255,255,.07); padding:2px 6px; border-radius:6px; font-size:13px; font-family:var(--font-mono); color:var(--text); }
.code-block { border:1px solid rgba(255,255,255,.08); background:rgba(0,0,0,.22); border-radius:14px; overflow:hidden; }
.code-block-toolbar { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:8px 10px; border-bottom:1px solid rgba(255,255,255,.06); background:rgba(255,255,255,.03); }
.code-block-lang { font-size:11px; text-transform:uppercase; letter-spacing:.08em; color:var(--muted); font-family:var(--font-mono); }
.code-block-pre { margin:0; padding:14px 16px; overflow:auto; font-size:12px; line-height:1.65; font-family:var(--font-mono); color:var(--text); }
.code-block-pre code { background:none; padding:0; color:inherit; }
.message-actions { display:flex; align-items:center; gap:8px; margin-top:12px; padding-top:10px; border-top:1px solid rgba(255,255,255,.06); opacity:0; transition:opacity .2s; }
.message:hover .message-actions, .message:focus-within .message-actions { opacity:1; }
.message-meta-chip { display:inline-flex; align-items:center; padding:5px 9px; border-radius:999px; background:rgba(255,255,255,.05); border:1px solid rgba(255,255,255,.07); color:var(--muted); font-size:11px; font-family:var(--font-mono); }
.action-btn { padding:6px; border-radius:var(--radius-sm); background:var(--bg); border:1px solid var(--line); color:var(--muted); cursor:pointer; display:flex; align-items:center; justify-content:center; }
.action-btn:hover { color:var(--text); border-color:var(--accent); }
.action-btn-inline { width:28px; height:28px; padding:0; border-radius:8px; }
.typing-indicator { padding:12px 20px; color:var(--muted); font-size:13px; display:flex; align-items:center; gap:8px; }
.typing-dots { display:flex; gap:3px; }
.typing-dots span { width:6px; height:6px; border-radius:50%; background:var(--accent); animation:bounce 1.4s infinite ease-in-out both; }
.typing-dots span:nth-child(1) { animation-delay:-.32s; }
.typing-dots span:nth-child(2) { animation-delay:-.16s; }
@keyframes bounce { 0%,80%,100%{transform:scale(0)} 40%{transform:scale(1)} }

.chat-composer { padding:16px 20px; border-top:1px solid var(--line); background:var(--panel); }
.approval-stack { max-width:980px; margin:0 auto 12px; display:flex; flex-direction:column; gap:10px; width:100%; }
.approval-card { border:1px solid rgba(245, 158, 11, 0.28); background:rgba(245, 158, 11, 0.08); border-radius:12px; padding:14px; }
.approval-card-header { display:flex; justify-content:space-between; gap:12px; align-items:flex-start; margin-bottom:10px; }
.approval-card-title { font-size:14px; font-weight:600; color:var(--text); }
.approval-card-subtitle { font-size:12px; color:var(--muted); margin-top:4px; }
.approval-badge { font-size:11px; color:#f59e0b; border:1px solid rgba(245, 158, 11, 0.32); background:rgba(245, 158, 11, 0.12); border-radius:999px; padding:5px 8px; white-space:nowrap; }
.approval-description { margin:0 0 10px; font-size:13px; color:var(--text); line-height:1.5; }
.approval-command { margin:0; padding:12px; border-radius:10px; background:rgba(0,0,0,.24); border:1px solid rgba(255,255,255,.08); overflow:auto; font-size:12px; }
.approval-cwd { margin-top:8px; font-size:12px; color:var(--muted); font-family:var(--font-mono); }
.approval-actions { display:flex; justify-content:flex-end; gap:8px; margin-top:12px; }
.composer-input { flex:1; }
.composer-textarea { width:100%; min-height:56px; max-height:220px; padding:14px 16px; border-radius:16px; border:1px solid var(--line); background:rgba(255,255,255,.02); color:var(--text); font:inherit; resize:none; line-height:1.5; overflow:auto; }
.composer-textarea:focus { outline:none; border-color:var(--accent); }
.composer-actions { display:flex; align-items:center; justify-content:space-between; margin-top:8px; }
.composer-hint { font-size:12px; color:var(--muted); }
.composer-send { width:44px; height:44px; border-radius:50%; background:var(--accent); border:none; color:#fff; display:flex; align-items:center; justify-content:center; cursor:pointer; transition:transform .15s, opacity .15s; }
.composer-send:hover:not(:disabled) { transform:scale(1.05); }
.composer-send:disabled { opacity:.4; cursor:not-allowed; }

.modal-overlay { position:fixed; inset:0; background:rgba(0,0,0,.5); display:flex; align-items:center; justify-content:center; z-index:100; }
.modal { background:var(--panel); border:1px solid var(--line); border-radius:var(--radius); padding:24px; min-width:360px; max-width:90vw; }
.modal-header { margin-bottom:16px; }
.modal-title { margin:0; font-size:18px; }
.delete-confirm { display:flex; flex-direction:column; gap:12px; }
.delete-confirm-icon { width:48px; height:48px; border-radius:50%; background:rgba(239,68,68,.1); color:#ef4444; display:flex; align-items:center; justify-content:center; margin:0 auto; }
.delete-confirm-title { margin:0; font-size:16px; text-align:center; }
.delete-confirm-text { margin:0; font-size:13px; color:var(--muted); text-align:center; }
.modal-footer { display:flex; justify-content:flex-end; gap:8px; margin-top:20px; }
.toast { position:fixed; bottom:20px; right:20px; display:flex; align-items:center; gap:12px; padding:12px 16px; border-radius:var(--radius); background:var(--panel); border:1px solid var(--line); box-shadow:0 10px 30px rgba(0,0,0,.2); z-index:200; animation:slideIn .3s ease; }
@keyframes slideIn { from{opacity:0;transform:translateY(20px)} to{opacity:1;transform:translateY(0)} }
.toast.success { border-color:#10b981; }
.toast.error { border-color:#ef4444; }
.toast.info { border-color:#3b82f6; }
.toast-icon { flex-shrink:0; width:20px; height:20px; }
.toast.success .toast-icon { color:#10b981; }
.toast.error .toast-icon { color:#ef4444; }
.toast.info .toast-icon { color:#3b82f6; }
</style>
