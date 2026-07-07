<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { api } from "../api";
import type { Chat, ChatMessage, ChatStats, ModelCatalogItem, Project, ProjectMemoryEntry, Provider, RunApproval, RunItem, Team } from "../types";

type StreamItem = {
  id: string;
  type: 'user' | 'assistant' | 'system' | 'agent-status' | 'agent-brief' | 'run-summary' | 'token-summary';
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

type KnowledgeGraphRecord = Record<string, any>;

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
  // Управление агентом и запросами разрешений.
  agentControlBusy: false,
  // Текст комментария «как сделать надо» для каждого ожидающего разрешения.
  approvalDrafts: {} as Record<string, string>,
  showReplaceTask: false,
  replaceTaskText: "",
  replaceTaskBusy: false,
  confirmStop: false,
  // Knowledge Graph Dialog
  showKnowledgeGraph: false,
});


const chatDraft = ref("");
const isSendDisabled = computed(() => !chatDraft.value.trim() || isSending.value || state.busy || state.streamingMessage);
const isSending = ref(false);
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
let loadModelsTimer: number | null = null;
function handleTextareaKeydown(event: KeyboardEvent) {
  if (event.key === 'Enter' && !event.shiftKey) {
    if (isSendDisabled.value) return;
    event.preventDefault();
    sendMessage();
  }
}

function loadModelsForProvider() {
  if (loadModelsTimer) window.clearTimeout(loadModelsTimer);
  loadModelsTimer = window.setTimeout(async () => {
    if (state.selectedProviderId) {
      const res = await api.models(state.selectedProviderId);
      state.models = res.items;
    }
  }, 300);
}

const selectedProvider = computed(() => state.providers.find((item) => item.id === state.selectedProviderId) ?? null);
const selectedTeam = computed(() => state.teams.find((item) => item.id === state.selectedTeamId) ?? null);
const selectedProject = computed(() => state.projects.find((item) => item.id === state.selectedProjectId) ?? null);
const selectedChat = computed(() => state.chats.find((item) => item.id === state.selectedChatId) ?? null);
const EMPTY_AGENTS = {
  orchestrator: { name: "", label: "", model: "", multiplier: 1, temperature: 0.2 },
  developer: { name: "", label: "", model: "", multiplier: 1, temperature: 0.15 },
  tester: { name: "", label: "", model: "", multiplier: 1, temperature: 0.1 },
  pm: { name: "", label: "", model: "", multiplier: 1, temperature: 0.2 },
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
const pendingClarifications = computed(() => pendingApprovals.value.filter((item) => item.kind === "clarification"));
const pendingActionApprovals = computed(() => pendingApprovals.value.filter((item) => item.kind !== "clarification"));

// Активный прогон — тот, что сейчас крутится агентами (running) или стоит на
// паузе (paused) и ждёт resume. Раньше «стоп/продолжить» были невозможны:
// прогон запускался в фоне и пользователь мог только ждать. Теперь по этому
// computed мы показываем панель управления агентом.
const activeRun = computed<RunItem | null>(() => {
  if (!state.selectedRunId) return null;
  const run = state.runs.find((r) => r.id === state.selectedRunId);
  if (!run) return null;
  if (["queued", "running", "paused", "awaiting_approval", "waiting_approval"].includes(run.status)) return run;
  return null;
});
const isRunActive = computed(() => activeRun.value?.status === "running" || activeRun.value?.status === "queued");
const isRunPaused = computed(() => activeRun.value?.status === "paused");
const isRunAwaiting = computed(() => activeRun.value?.status === "awaiting_approval" || activeRun.value?.status === "waiting_approval" || pendingApprovals.value.length > 0);

// Человекочитаемый бейдж статуса агента для панели управления.
const runStatusLabel = computed(() => {
  const s = activeRun.value?.status || state.runStatus;
  if (s === "running") return "Работает";
  if (s === "queued") return "В очереди";
  if (s === "paused") return "На паузе";
  if (s === "awaiting_approval" || s === "waiting_approval") return "Ждёт ответа";
  if (s === "completed" || s === "done") return "Завершено";
  if (s === "failed") return "Ошибка";
  if (s === "cancelled") return "Остановлено";
  return s || "—";
});

const knowledgeGraphIndexEntry = computed<ProjectMemoryEntry | null>(() => {
  return state.projectMemory.find((entry) => entry.kind === "knowledge-graph-index" || entry.tags?.includes("source-of-truth")) ?? null;
});

const knowledgeGraph = computed<KnowledgeGraphRecord | null>(() => {
  const graph = knowledgeGraphIndexEntry.value?.graph;
  return graph && typeof graph === "object" ? graph as KnowledgeGraphRecord : null;
});

const graphCoverageEntries = computed(() => {
  const coverage = knowledgeGraph.value?.coverage;
  if (!coverage || typeof coverage !== "object") return [];
  return Object.entries(coverage)
    .map(([key, value]) => ({ key, value: Number(value) || 0 }))
    .sort((a, b) => b.value - a.value);
});

const graphUnknowns = computed(() => {
  const unknowns = knowledgeGraph.value?.unknowns;
  return Array.isArray(unknowns) ? unknowns.map((item) => String(item || "").trim()).filter(Boolean) : [];
});

const graphFeatures = computed(() => {
  const features = knowledgeGraph.value?.features;
  return Array.isArray(features) ? features.slice(0, 8) : [];
});

const graphEntityIndex = computed(() => {
  const entityIndex = knowledgeGraph.value?.entityIndex;
  return Array.isArray(entityIndex) ? entityIndex.slice(0, 14) : [];
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
    } else if (msg.meta?.type === 'agent-brief') {
      const usage = msg.meta?.usage;
      const meta = msg.meta as any;
      stream.push({
        id: msg.id,
        type: 'agent-brief',
        role: usage?.role || meta.agentRole || 'assistant',
        agentRole: meta.agentRole,
        name: meta.agentName || usage?.name || 'Alex',
        label: meta.agentLabel || usage?.label || 'Оркестратор',
        content: String(msg.content ?? ''),
        createdAt: msg.createdAt,
        meta: msg.meta,
        status: meta.status,
      });
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
  pm: { name: 'Mira (PM)', letter: 'M', cls: 'pm', placeholder: 'Изучаю код и составляю техническое задание…' },
  developer: { name: 'Kai (Разработчик)', letter: 'K', cls: 'developer', placeholder: 'Пишу код и применяю изменения…' },
  tester: { name: 'Nova (Верификатор)', letter: 'N', cls: 'tester', placeholder: 'Проверяю изменения…' },
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
  if (role === 'pm') {
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

function formatActivityEntry(entry: { at: string; event: string; payload?: unknown }) { const actor = eventActor(entry.payload); if (entry.event === "agent:activity") return `${actor.agentName} (${actor.label}): ${actor.detail}`; if (entry.event === "agent:retry") return `${actor.agentName} (${actor.label}): ответ не распарсился, автоповтор ${actor.attempt || "?"}/3`; if (entry.event === "agent:retry-success") return `${actor.agentName} (${actor.label}): прислал валидный JSON, выполнение продолжено`; if (entry.event === "agent:note") return `${actor.agentName} (${actor.label}): ${actor.detail}`; if (entry.event === "agent:done") return `${actor.agentName} (${actor.label}): завершил этап`; if (entry.event === "agent:skipped") return `${actor.agentName} (${actor.label}): сейчас не задействован`; if (entry.event === "developer:empty-operations") return `${actor.agentName} (${actor.label}): не вернул правки, получает повторную задачу`; if (entry.event === "run:blocked") return `${actor.agentName} (${actor.label}): прогон остановлен, нет реальных правок`; if (entry.event === "file:processing") { const p = entry.payload as { path?: string; action?: string }; return `Разработчик: ${p?.action === "create" ? "создаёт" : "обновляет"} файл ${p?.path || "-"}`; } if (entry.event === "file:applied") { const p = entry.payload as { path?: string; action?: string }; return `Разработчик: ${p?.action === "create" ? "создал" : "обновил"} файл ${p?.path || "-"}`; } if (entry.event === "file:skipped") { const p = entry.payload as { path?: string; reason?: string }; return `Разработчик: пропустил файл ${p?.path || "-"} (${p?.reason || "без причины"})`; } if (entry.event === "files:applied") return "Разработчик применил изменения к файлам"; if (entry.event === "test:started") { const p = entry.payload as { command?: string }; return `Верификатор: запускает "${p?.command || ""}"`; } if (entry.event === "test:finished") { const p = entry.payload as { command?: string; success?: boolean; code?: number }; return `Верификатор: ${p?.success ? "успешно завершил" : "завершил с ошибкой"} "${p?.command || ""}" (code ${p.code ?? "-"})`; } if (entry.event === "tests:done") return "Верификатор завершил проверку"; if (entry.event === "tests:skipped") return "Проверка верификатором была пропущена"; return `Событие: ${entry.event}`; }
function avatarColor(role: string): string { const colors: Record<string, string> = { orchestrator: '#6366f1', pm: '#6366f1', analyst: '#10b981', researcher: '#10b981', developer: '#f59e0b', coder: '#f59e0b', tester: '#ef4444', reviewer: '#8b5cf6', system: '#6b7280', user: '#3b82f6' }; return colors[role] || colors.system; }
function agentInitial(item: any): string { const name = item.name || item.label || '?'; return name.charAt(0).toUpperCase(); }
function messageName(item: any): string { if (item.type === 'user') return 'Вы'; if (item.type === 'assistant' || item.type === 'agent-brief' || item.type === 'run-summary') return `${item.name || 'Alex'} (${item.label || 'Оркестратор'})`; if (item.type === 'agent-status') return `${item.name || 'Agent'} (${item.label || item.agentRole})`; if (item.type === 'system') return 'Система'; if (item.type === 'token-summary') return 'Токены'; return 'Неизвестно'; }
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
  
  // Восстанавливаем выбор из localStorage, если есть
  const savedProjectId = localStorage.getItem("ws_selectedProjectId");
  const savedTeamId = localStorage.getItem("ws_selectedTeamId");
  const savedChatId = localStorage.getItem("ws_selectedChatId");

  state.selectedProjectId = (savedProjectId && state.projects.some(p => p.id === savedProjectId)) ? savedProjectId : state.projects[0]?.id || "";
  state.selectedTeamId = (savedTeamId && state.teams.some(t => t.id === savedTeamId)) ? savedTeamId : state.teams[0]?.id || "";
  state.selectedProviderId = (() => {
    const team = state.teams.find(t => t.id === state.selectedTeamId);
    return team?.providerId || state.providers[0]?.id || "";
  })();
  
  if (state.selectedProjectId) { await refreshChats(state.selectedProjectId, savedChatId || undefined); }
  if (!state.selectedChatId && state.runs[0]) {
    await openRun(state.runs[0].id);
  }
}

async function refreshProjectMemory(projectId?: string) {
  if (!projectId) {
    state.projectMemory = [];
    return;
  }
  try {
    const response = await api.projectMemory(projectId);
    state.projectMemory = response.entries;
  } catch (e) {
    console.error("Failed to load project memory:", e);
    state.projectMemory = [];
  }
}

async function refreshChats(projectId?: string, preferredChatId?: string) { if (!projectId) { state.chats = []; state.selectedChatId = ""; state.messages = []; state.chatRuns = []; state.chatStats = { requestCount: 0, runCount: 0, totalActualTokens: 0, totalWeightedTokens: 0, byRole: {} }; state.projectMemory = []; return; } await refreshProjectMemory(projectId); const response = await api.chats(projectId); state.chats = response.chats; const targetChatId = (preferredChatId && state.chats.some(c => c.id === preferredChatId)) ? preferredChatId : state.chats[0]?.id || ""; state.selectedChatId = targetChatId; if (state.selectedChatId) await openChat(state.selectedChatId); else { state.messages = []; state.chatRuns = []; state.chatStats = { requestCount: 0, runCount: 0, totalActualTokens: 0, totalWeightedTokens: 0, byRole: {} }; } }
async function openChat(id: string) { state.selectedChatId = id; isLoadingChat = true; const response = await api.chatById(id); state.messages = response.messages; state.chatRuns = response.runs; state.chatStats = response.stats; const persistedActiveRun = response.runs.find((run) => ["queued", "running", "paused", "awaiting_approval", "waiting_approval"].includes(run.status)); if (persistedActiveRun) { state.selectedRunId = persistedActiveRun.id; await openRun(persistedActiveRun.id); if (["queued", "running", "awaiting_approval", "waiting_approval"].includes(persistedActiveRun.status)) startPolling(persistedActiveRun.id); } else { state.runEvents = []; state.runError = ""; state.report = null; state.runStatus = ""; } clearAgentLogs(); await nextTick(); isLoadingChat = false; shouldAutoScroll = true; userHasScrolled = false; scheduleScrollToBottom("auto"); }
async function openRun(id: string) { state.selectedRunId = id; const response = await api.runById(id); state.report = response.report; state.runStatus = response.run.status; state.runEvents = response.run.events ?? []; state.runError = response.run.error ?? ""; }

function showToast(type: 'success' | 'error' | 'info', message: string) { const id = ++toastId; state.toasts.push({ id, type, message }); setTimeout(() => { const idx = state.toasts.findIndex(t => t.id === id); if (idx !== -1) state.toasts.splice(idx, 1); }, 4000); }
function confirmDelete(type: 'project' | 'chat', id: string, name: string, onConfirm: () => Promise<void>) { state.deleteConfirm = { type, id, name, onConfirm }; }
async function executeDelete() { if (!state.deleteConfirm) return; const { onConfirm } = state.deleteConfirm; state.deleteConfirm = null; try { await onConfirm(); showToast('success', 'Удалено'); } catch (e) { showToast('error', e instanceof Error ? e.message : 'Ошибка удаления'); } }
async function createChat() { if (!selectedProject.value || !(selectedProject.value.teamId || state.selectedTeamId)) return; state.busy = true; try { const response = await api.saveChat({ projectId: selectedProject.value.id, teamId: selectedProject.value.teamId || state.selectedTeamId, title: `Чат ${state.chats.length + 1}`, summary: "" }); state.chats.unshift(response.chat); state.selectedChatId = response.chat.id; await openChat(response.chat.id); showToast('success', 'Чат создан'); } catch (e) { showToast('error', e instanceof Error ? e.message : 'Ошибка'); } finally { state.busy = false; } }
async function deleteChat(id: string) { const chat = state.chats.find(c => c.id === id); if (!chat) return; confirmDelete('chat', id, chat.title, async () => { state.busy = true; try { await api.deleteChat(id); state.chats = state.chats.filter(c => c.id !== id); if (state.selectedChatId === id) { const fallback = state.chats[0] || null; state.selectedChatId = fallback?.id || ""; if (fallback) await openChat(fallback.id); else { state.messages = []; state.chatRuns = []; state.chatStats = { requestCount: 0, runCount: 0, totalActualTokens: 0, totalWeightedTokens: 0, byRole: {} }; } } showToast('success', 'Чат удалён'); } finally { state.busy = false; } }); }
function onComposerKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendChatMessage();
  }
  // Shift+Enter — стандартное поведение браузера (перенос строки), не трогаем
  // Escape — убрать фокус (опционально)
  if (e.key === 'Escape') {
    composerTextareaRef.value?.blur();
  }
}
async function sendChatMessage() {
  if (!selectedChat.value || !chatDraft.value.trim() || isSending.value) return;
  const draft = chatDraft.value.trim();
  const project = selectedProject.value;
  if (!project) return;
  isSending.value = true;
  state.busy = true;
  chatDraft.value = "";
  try {
    const response = await api.sendChatMessage(
      selectedChat.value.id,
      draft,
      state.selectedTeamId || undefined,
      project.id,
    );
    await openChat(selectedChat.value.id);
    if (response.autoRunId) {
      state.selectedRunId = response.autoRunId;
      state.runStatus = "queued";
      state.runEvents = [];
      state.runError = "";
      state.report = null;
      clearAgentLogs();
      startPolling(response.autoRunId);
    } else {
      state.busy = false;
    }
  } catch (e) {
    chatDraft.value = draft;
    showToast('error', e instanceof Error ? e.message : 'Ошибка');
    state.busy = false;
  } finally {
    isSending.value = false;
    // Возвращаем фокус в поле ввода
    await nextTick();
    composerTextareaRef.value?.focus();
  }
}
async function runTask() { if (!selectedChat.value || !chatDraft.value.trim()) return; const draft = chatDraft.value.trim(); const project = selectedProject.value; const team = selectedProjectTeam.value; if (!project || !team) return; state.busy = true; chatDraft.value = ""; try { const response = await api.startRun({ chatId: selectedChat.value.id, projectId: project.id, task: draft, teamId: team.id, teamName: team.name, projectPath: project.localPath || '' }); state.selectedRunId = response.runId; state.runStatus = "queued"; state.runEvents = []; state.runError = ""; state.report = null; clearAgentLogs(); startPolling(response.runId); showToast('success', 'Работа запущена'); /* busy stays true until run completes via polling */ } catch (e) { chatDraft.value = draft; showToast('error', e instanceof Error ? e.message : 'Ошибка'); state.busy = false; } }
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
// Запрос разрешения от агента. Три варианта ответа вместо старых «да/нет»:
//   approve       — разрешаю действие (с необязательным комментарием);
//   reject_skip   — нет, пропустить шаг, но работу продолжить;
//   reject_cancel — отмена работы целиком (прогон завершится как cancelled).
// Плюс поле комментария «как сделать надо» — оно уйдёт агенту как reason.
async function resolveApproval(approval: RunApproval, resolution: "approve" | "reject_skip" | "reject_cancel") {
  if (!state.selectedRunId || state.resolvingApprovalId) return;
  state.resolvingApprovalId = approval.id;
  let reason = (state.approvalDrafts[approval.id] || "").trim();
  let effectiveResolution = resolution;
  let approved = resolution === "approve";
  if (approval.kind === "clarification") {
    if (!reason || reason === "+") {
      approved = true;
      effectiveResolution = "approve";
      reason = "";
    } else if (reason === "-") {
      approved = false;
      effectiveResolution = "reject_skip";
      reason = "";
    } else {
      approved = true;
      effectiveResolution = "approve";
    }
  }
  try {
    const response = await api.resolveRunApproval(state.selectedRunId, approval.id, approved, reason, effectiveResolution);
    if (!response.ok) throw new Error(response.reason || "Не удалось обработать разрешение");
    // Очищаем черновик комментария для этого запроса.
    delete state.approvalDrafts[approval.id];
    if (effectiveResolution === "reject_cancel") {
      showToast('info', 'Работа отменена');
      // Поллинг сам подхватит завершение; на всякий случай снимаем busy.
      state.busy = false;
    } else if (effectiveResolution === "approve") {
      showToast('success', approval.kind === "clarification" ? (reason ? 'Ответ отправлен' : 'Подтверждено без уточнений') : (reason ? 'Разрешение выдано с указанием' : 'Разрешение выдано'));
    } else {
      showToast('success', approval.kind === "clarification" ? 'Уточнение отклонено, работа продолжится без него' : 'Шаг пропущен, работа продолжается');
    }
    const job = await api.job(state.selectedRunId);
    state.runStatus = job.status;
    state.runEvents = job.events ?? [];
    const runsResponse = await api.runs();
    state.runs = runsResponse.runs;
  } catch (e) {
    showToast('error', e instanceof Error ? e.message : 'Ошибка подтверждения');
  } finally {
    state.resolvingApprovalId = "";
  }
}

// ---- Управление агентом: стоп / пауза / продолжить / новая задача ----------
// Раньше запущенный прогон нельзя было ни остановить, ни поставить на паузу —
// пользователь был заперт до завершения. Теперь эти функции дают полный
// контроль, как в привычных AI-агентах (Cursor/Cline и т.п.).
function approvalDraft(approvalId: string): string {
  return state.approvalDrafts[approvalId] || "";
}
function setApprovalDraft(approvalId: string, value: string) {
  state.approvalDrafts[approvalId] = value;
}
async function refreshRunStatus(runId: string) {
  try {
    const job = await api.job(runId);
    state.runStatus = job.status;
    state.runError = job.error ?? "";
    const incoming = job.events ?? [];
    const keyOf = (e: { at: string; event: string; payload?: unknown }) => `${e.at}|${e.event}|${JSON.stringify(e.payload ?? "")}`;
    const existing = new Set(state.runEvents.map(keyOf));
    for (const e of incoming) if (!existing.has(keyOf(e))) state.runEvents.push(e);
    const runsResponse = await api.runs();
    state.runs = runsResponse.runs;
  } catch (e) {
    console.error('refreshRunStatus error:', e);
  }
}
async function cancelAgent() {
  if (!state.selectedRunId || state.agentControlBusy) return;
  state.agentControlBusy = true;
  state.confirmStop = false;
  try {
    const response = await api.cancelRun(state.selectedRunId);
    if (!response.ok) throw new Error(response.reason || "Не удалось остановить работу");
    showToast('info', 'Работа остановлена');
    await refreshRunStatus(state.selectedRunId);
    state.busy = false;
  } catch (e) {
    showToast('error', e instanceof Error ? e.message : 'Ошибка остановки');
  } finally {
    state.agentControlBusy = false;
  }
}
async function pauseAgent() {
  if (!state.selectedRunId || state.agentControlBusy) return;
  state.agentControlBusy = true;
  try {
    const response = await api.pauseRun(state.selectedRunId);
    if (!response.ok) throw new Error(response.reason || "Не удалось поставить на паузу");
    showToast('info', 'Работа на паузе');
    await refreshRunStatus(state.selectedRunId);
  } catch (e) {
    showToast('error', e instanceof Error ? e.message : 'Ошибка паузы');
  } finally {
    state.agentControlBusy = false;
  }
}
async function resumeAgent() {
  if (!state.selectedRunId || state.agentControlBusy) return;
  state.agentControlBusy = true;
  try {
    const response = await api.resumeRun(state.selectedRunId);
    if (!response.ok) throw new Error(response.reason || "Не удалось продолжить работу");
    showToast('success', 'Работа продолжена');
    state.busy = true;
    await refreshRunStatus(state.selectedRunId);
    // Поднимаем поллинг заново, чтобы следить за продолженным прогоном.
    startPolling(state.selectedRunId);
  } catch (e) {
    showToast('error', e instanceof Error ? e.message : 'Ошибка возобновления');
  } finally {
    state.agentControlBusy = false;
  }
}
function openReplaceTask() {
  state.replaceTaskText = "";
  state.showReplaceTask = true;
}
async function submitReplaceTask() {
  if (!state.selectedRunId || state.replaceTaskBusy) return;
  const task = state.replaceTaskText.trim();
  if (!task) return;
  state.replaceTaskBusy = true;
  try {
    const response = await api.replaceTask(state.selectedRunId, task);
    if (!response.ok) throw new Error(response.reason || "Не удалось сменить задачу");
    state.showReplaceTask = false;
    if (response.action === "queued_for_resume") {
      showToast('info', 'Задача записана — нажмите «Продолжить», чтобы агент взялся за неё');
    } else if (response.action === "redirected") {
      showToast('success', 'Агент переключился на новую задачу');
      state.busy = true;
      startPolling(state.selectedRunId);
    } else {
      showToast('info', 'Задача передана агенту');
    }
    await refreshRunStatus(state.selectedRunId);
  } catch (e) {
    showToast('error', e instanceof Error ? e.message : 'Ошибка смены задачи');
  } finally {
    state.replaceTaskBusy = false;
  }
}

function reportText(): string { if (!state.report) return "Пока нет отчёта."; const r = state.report as any; return [`Task: ${r.task || "-"}`, `Project: ${r.projectPath || "-"}`, r.summary ? `Summary: ${r.summary}` : "", r.testResult ? `Test result: ${r.testResult}` : "", Array.isArray(r.filesChanged) && r.filesChanged.length ? `Files: ${r.filesChanged.join(", ")}` : "", r.usageSummary ? `Tokens: actual ${r.usageSummary.totalActualTokens}, weighted ${r.usageSummary.totalWeightedTokens}` : ""].filter(Boolean).join("\n"); }

function connectWebSocket() { if (ws) { ws.disconnect(); ws = null; } import('socket.io-client').then(({ io }) => { const wsUrl = window.location.origin; try { ws = io(wsUrl, { path: '/ws/socket.io', transports: ['websocket', 'polling'], autoConnect: true }); ws.on('connect', () => { if (state.selectedChatId) ws.emit("join:chat", { chatId: state.selectedChatId }); if (state.selectedProjectId) ws.emit("join:project", { projectId: state.selectedProjectId }); }); ws.on('token:stream', (msg: any) => { handleWsMessage({ event: "token:stream", data: msg }); }); ws.on('run:event', (msg: any) => { handleWsMessage({ event: "run:event", data: msg }); }); ws.on('agent:activity', (msg: any) => { handleWsMessage({ event: "agent:activity", data: msg }); }); ws.on('disconnect', () => { wsReconnectTimer = window.setTimeout(connectWebSocket, 3000); }); ws.on('connect_error', () => {}); } catch { ws = null; } }).catch(() => { ws = null; }); }
function handleWsMessage(msg: any) { 
  if (msg.event === "token:stream") { 
    const { role, content, done, usage } = msg.data; 
    // Only show streaming for conversation mode (orchestrator), not for run execution agents
    const isRunExecution = state.runStatus === 'running' && ['orchestrator', 'pm', 'developer', 'tester'].includes(role);
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

watch(() => state.selectedChatId, async (v) => { if (v) { localStorage.setItem("ws_selectedChatId", v); await openChat(v); if (ws && ws.connected) ws.emit("join:chat", { chatId: v }); } });
watch(() => state.selectedProjectId, async (v: string) => { if (v) localStorage.setItem("ws_selectedProjectId", v); await refreshChats(v || ""); const p = state.projects.find(i => i.id === v); if (p?.teamId) state.selectedTeamId = p.teamId; if (ws && ws.connected && v) ws.emit("join:project", { projectId: v }); });
async function onTeamChange(event: Event) {
  const newTeamId = (event.target as HTMLSelectElement).value;
  state.selectedTeamId = newTeamId;
  localStorage.setItem("ws_selectedTeamId", newTeamId);
  // Сохраняем teamId в проекте на бэкенде
  const proj = selectedProject.value;
  if (proj) {
    proj.teamId = newTeamId;
    try { await api.saveProject(proj); } catch (e) { console.error("Failed to save project teamId:", e); }
  }
  // Обновляем провайдер и модели
  const t = state.teams.find(i => i.id === newTeamId);
  if (t) { state.selectedProviderId = t.providerId || ""; loadModelsForProvider(); }
}

watch(() => state.selectedTeamId, (v) => { if (v) localStorage.setItem("ws_selectedTeamId", v); });
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
        <select class="form-select" :value="state.selectedTeamId" @change="onTeamChange($event)" :disabled="state.busy || !!activeRun">
          <option value="">Не назначена</option>
          <option v-for="t in state.teams" :key="t.id" :value="t.id">{{ t.name }}</option>
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
        <button
          v-if="selectedProject && (knowledgeGraph || state.projectMemory.length)"
          class="btn btn-ghost"
          @click="state.showKnowledgeGraph = true"
          :disabled="state.busy"
          title="Открыть граф знаний"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="btn-icon"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
          <span>Граф знаний</span>
        </button>
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

      <!-- Панель управления агентом: стоп / пауза / продолжить / новая задача.
           Появляется только когда есть активный прогон. Раньше пользователь
           был заперт до конца работы — теперь контролирует процесс. -->
      <div v-if="activeRun" class="agent-control-bar" :class="activeRun.status">
        <div class="agent-control-status">
          <span class="agent-control-dot" :class="activeRun.status"></span>
          <span class="agent-control-label">{{ runStatusLabel }}</span>
          <span v-if="isRunPaused && activeRun.pendingTask" class="agent-control-hint">Есть новая задача — нажмите «Продолжить»</span>
        </div>
        <div class="agent-control-actions">
          <button v-if="isRunActive" class="btn btn-ghost btn-sm" :disabled="state.agentControlBusy" @click="pauseAgent">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>Пауза
          </button>
          <button v-if="isRunPaused" class="btn btn-primary btn-sm" :disabled="state.agentControlBusy" @click="resumeAgent">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>Продолжить
          </button>
          <button class="btn btn-ghost btn-sm" :disabled="state.agentControlBusy" @click="openReplaceTask">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>Новая задача
          </button>
          <button class="btn btn-danger btn-sm" :disabled="state.agentControlBusy" @click="cancelAgent">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>Стоп
          </button>
        </div>
      </div>

      <div v-if="pendingClarifications.length" class="approval-stack">
        <div v-for="approval in pendingClarifications" :key="approval.id" class="approval-card clarification-card">
          <div class="approval-card-header">
            <div>
              <div class="approval-card-title">{{ approval.title }}</div>
              <div class="approval-card-subtitle">{{ approval.role }} ждёт ответ пользователя, чтобы продолжить работу</div>
            </div>
            <span class="approval-badge">Уточнение · Ждёт ответа</span>
          </div>
          <div class="approval-card-body">
            <p class="approval-description">{{ approval.description }}</p>
            <div class="approval-meta">
              <div v-for="(question, index) in approval.questions || []" :key="`${approval.id}-q-${index}`" class="clarification-question">
                <span class="clarification-index">{{ index + 1 }}.</span>
                <span>{{ question }}</span>
              </div>
            </div>
          </div>
          <div class="approval-comment">
            <textarea class="approval-comment-input" :value="approvalDraft(approval.id)" @input="setApprovalDraft(approval.id, ($event.target as HTMLTextAreaElement).value)" rows="3" placeholder="Ответ пользователю. Пусто или «+» = да, «-» = нет…"></textarea>
          </div>
          <div class="approval-actions">
            <button class="btn btn-danger" :disabled="state.resolvingApprovalId === approval.id" @click="resolveApproval(approval, 'reject_cancel')">
              {{ state.resolvingApprovalId === approval.id ? "Обрабатываю..." : "Отменить работу" }}
            </button>
            <button class="btn btn-ghost" :disabled="state.resolvingApprovalId === approval.id" @click="resolveApproval(approval, 'reject_skip')">
              {{ state.resolvingApprovalId === approval.id ? "Обрабатываю..." : "Нет" }}
            </button>
            <button class="btn btn-primary" :disabled="state.resolvingApprovalId === approval.id" @click="resolveApproval(approval, 'approve')">
              {{ state.resolvingApprovalId === approval.id ? "Обрабатываю..." : "Ответить" }}
            </button>
          </div>
        </div>
      </div>

      <div v-if="pendingActionApprovals.length" class="approval-stack">
        <div v-for="approval in pendingActionApprovals" :key="approval.id" class="approval-card">
          <div class="approval-card-header">
            <div>
              <div class="approval-card-title">{{ approval.title }}</div>
              <div class="approval-card-subtitle">
                {{ approval.role }} хочет {{ approval.kind === 'migration' ? 'применить миграцию' : 'выполнить команду' }}
              </div>
            </div>
            <span class="approval-badge">{{ approval.kind === 'migration' ? 'Миграция' : 'Команда' }} · Ждёт разрешения</span>
          </div>
          <div class="approval-card-body">
            <!-- Подробное описание зачем нужно действие. Раньше агент кидал
                 сырую команду без объяснений — пользователь не понимал, что
                 approves. Теперь всегда есть описание + зачем. -->
            <p class="approval-description">{{ approval.description }}</p>
            <div v-if="approval.kind === 'migration'" class="approval-meta">
              <div class="approval-meta-row"><span class="approval-meta-key">Миграция:</span><code>{{ approval.migrationId || approval.migrationName }}</code></div>
              <div v-if="approval.migrationName" class="approval-meta-row"><span class="approval-meta-key">Название:</span><span>{{ approval.migrationName }}</span></div>
              <p v-if="approval.migrationDescription" class="approval-meta-desc">{{ approval.migrationDescription }}</p>
            </div>
            <div v-else class="approval-meta">
              <div class="approval-meta-row"><span class="approval-meta-key">Команда:</span><code class="approval-command-code">{{ approval.command }}</code></div>
              <p class="approval-why">{{ approval.description }}</p>
              <div v-if="approval.cwd" class="approval-cwd">Папка: {{ approval.cwd }}</div>
            </div>
          </div>
          <!-- Поле «как сделать надо» — уйдёт агенту как reason. -->
          <div class="approval-comment">
            <textarea class="approval-comment-input" :value="approvalDraft(approval.id)" @input="setApprovalDraft(approval.id, ($event.target as HTMLTextAreaElement).value)" rows="2" placeholder="Подсказка агенту, как сделать правильно (необязательно)…"></textarea>
          </div>
          <div class="approval-actions">
            <button class="btn btn-danger" :disabled="state.resolvingApprovalId === approval.id" @click="resolveApproval(approval, 'reject_cancel')">
              {{ state.resolvingApprovalId === approval.id ? "Обрабатываю..." : "Отменить работу" }}
            </button>
            <button class="btn btn-ghost" :disabled="state.resolvingApprovalId === approval.id" @click="resolveApproval(approval, 'reject_skip')">
              {{ state.resolvingApprovalId === approval.id ? "Обрабатываю..." : "Нет, пропустить" }}
            </button>
            <button class="btn btn-primary" :disabled="state.resolvingApprovalId === approval.id" @click="resolveApproval(approval, 'approve')">
              {{ state.resolvingApprovalId === approval.id ? "Обрабатываю..." : "Да, разрешаю" }}
            </button>
          </div>
        </div>
      </div>

      <footer class="chat-composer">
        <div class="composer-input"><textarea ref="composerTextareaRef" class="composer-textarea" v-model="chatDraft" rows="1" placeholder="Например: кто в команде, что сейчас в работе, добавь задачу на экспорт CSV" @keydown="onComposerKeydown"></textarea></div>
        <div class="composer-actions"><span class="composer-hint">Enter — отправить · Shift+Enter — новая строка</span><button class="composer-send" :disabled="isSending || state.busy || !selectedChat || !chatDraft.trim()" @click="sendChatMessage"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 2L11 13"/><path d="M22 2L15 22L11 13L2 9L22 2Z"/></svg></button></div>
      </footer>

    <!-- Модалка «Дать агенту новую задачу». На паузе — отложится до resume,
         в активном состоянии — перенаправит агента. -->
    <div v-if="state.showReplaceTask" class="modal-overlay" @click.self="state.showReplaceTask = false">
      <div class="modal">
        <div class="modal-header"><h3 class="modal-title">Новая задача агенту</h3></div>
        <div class="modal-body">
          <p class="replace-task-hint" v-if="isRunPaused">Агент на паузе — задача запишется и запустится после нажатия «Продолжить».</p>
          <p class="replace-task-hint" v-else>Агент работает — будет перенаправлен на новую задачу.</p>
          <textarea class="replace-task-textarea" v-model="state.replaceTaskText" rows="4" placeholder="Опишите, что должен сделать агент…" :disabled="state.replaceTaskBusy"></textarea>
        </div>
        <div class="modal-footer">
          <button class="btn btn-ghost" :disabled="state.replaceTaskBusy" @click="state.showReplaceTask = false">Отмена</button>
          <button class="btn btn-primary" :disabled="state.replaceTaskBusy || !state.replaceTaskText.trim()" @click="submitReplaceTask">
            {{ state.replaceTaskBusy ? "Отправляю..." : "Поставить задачу" }}
          </button>
        </div>
      </div>
    </div>

    <!-- Knowledge Graph Dialog -->
    <Teleport to="body">
      <div v-if="state.showKnowledgeGraph" class="modal-overlay" @click.self="state.showKnowledgeGraph = false">
        <div class="modal modal-lg">
          <div class="modal-header">
            <h3 class="modal-title">Knowledge Graph — {{ selectedProject?.name }}</h3>
            <button class="btn btn-ghost btn-sm" @click="state.showKnowledgeGraph = false">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
          <div class="modal-body knowledge-dialog-body">
            <div v-if="knowledgeGraph" class="knowledge-grid">
              <section class="knowledge-card">
                <div class="knowledge-card-title">Покрытие знаний</div>
                <div class="coverage-list">
                  <div v-for="entry in graphCoverageEntries" :key="entry.key" class="coverage-item">
                    <div class="coverage-row">
                      <span class="coverage-label">{{ entry.key }}</span>
                      <span class="coverage-value">{{ entry.value }}%</span>
                    </div>
                    <div class="coverage-bar"><span class="coverage-fill" :style="{ width: `${entry.value}%` }"></span></div>
                  </div>
                </div>
              </section>

              <section class="knowledge-card">
                <div class="knowledge-card-title">Неизвестные участки</div>
                <div v-if="graphUnknowns.length" class="knowledge-list">
                  <div v-for="(item, index) in graphUnknowns" :key="`unknown-${index}`" class="knowledge-list-item">{{ item }}</div>
                </div>
                <div v-else class="knowledge-empty">Явных пробелов не отмечено.</div>
              </section>

              <section class="knowledge-card">
                <div class="knowledge-card-title">Features</div>
                <div v-if="graphFeatures.length" class="knowledge-list">
                  <div v-for="feature in graphFeatures" :key="feature.id || feature.name" class="feature-item">
                    <div class="feature-name">{{ feature.name || feature.id }}</div>
                    <div class="feature-desc">{{ feature.description || feature.purpose || "Описание не заполнено" }}</div>
                  </div>
                </div>
                <div v-else class="knowledge-empty">Фичи пока не выделены.</div>
              </section>

              <section class="knowledge-card knowledge-card-wide">
                <div class="knowledge-card-title">Индекс сущностей</div>
                <div v-if="graphEntityIndex.length" class="entity-list">
                  <div v-for="entity in graphEntityIndex" :key="entity.id || `${entity.kind}-${entity.name}`" class="entity-item">
                    <div class="entity-head">
                      <span class="entity-name">{{ entity.name || entity.id }}</span>
                      <span class="entity-kind">{{ entity.kind || "unknown" }}</span>
                    </div>
                    <div class="entity-meta">{{ entity.location || "Местоположение неизвестно" }}</div>
                    <div class="entity-meta" v-if="entity.feature">Feature: {{ entity.feature }}</div>
                  </div>
                </div>
                <div v-else class="knowledge-empty">Индекс сущностей пока пуст.</div>
              </section>
            </div>

            <div v-else class="knowledge-empty">Граф знаний для проекта пока не построен.</div>
          </div>
        </div>
      </div>
    </Teleport>

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
.message-avatar.pm { background:#10b981; }
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
.clarification-card { border-color: rgba(99, 102, 241, 0.28); background: rgba(99, 102, 241, 0.08); }
.approval-card-header { display:flex; justify-content:space-between; gap:12px; align-items:flex-start; margin-bottom:10px; }
.approval-card-title { font-size:14px; font-weight:600; color:var(--text); }
.approval-card-subtitle { font-size:12px; color:var(--muted); margin-top:4px; }
.approval-badge { font-size:11px; color:#f59e0b; border:1px solid rgba(245, 158, 11, 0.32); background:rgba(245, 158, 11, 0.12); border-radius:999px; padding:5px 8px; white-space:nowrap; }
.approval-description { margin:0 0 10px; font-size:13px; color:var(--text); line-height:1.5; }
.approval-command { margin:0; padding:12px; border-radius:10px; background:rgba(0,0,0,.24); border:1px solid rgba(255,255,255,.08); overflow:auto; font-size:12px; }
.approval-cwd { margin-top:8px; font-size:12px; color:var(--muted); font-family:var(--font-mono); }
.approval-actions { display:flex; justify-content:flex-end; gap:8px; margin-top:12px; flex-wrap:wrap; }

/* Мета запроса разрешения: какая миграция/команда + зачем. */
.approval-meta { display:flex; flex-direction:column; gap:8px; padding:10px 12px; border-radius:10px; background:rgba(0,0,0,.18); border:1px solid rgba(255,255,255,.06); margin-bottom:10px; }
.approval-meta-row { display:flex; align-items:baseline; gap:8px; font-size:12px; color:var(--muted); flex-wrap:wrap; }
.approval-meta-key { font-size:11px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); }
.approval-meta-row code, .approval-command-code { font-family:var(--font-mono); font-size:12px; color:var(--text); background:rgba(255,255,255,.06); padding:2px 6px; border-radius:6px; word-break:break-all; }
.approval-meta-desc { margin:0; font-size:12px; color:var(--text); line-height:1.5; }
.approval-why { margin:0; font-size:12px; color:var(--muted); line-height:1.5; font-style:italic; }
.approval-comment { margin-top:10px; }
.approval-comment-input { width:100%; min-height:44px; max-height:120px; padding:10px 12px; border-radius:10px; border:1px solid rgba(245,158,11,.22); background:rgba(0,0,0,.18); color:var(--text); font:inherit; font-size:13px; resize:vertical; line-height:1.5; }
.approval-comment-input:focus { outline:none; border-color:#f59e0b; }
.approval-comment-input::placeholder { color:var(--muted); }
.clarification-question { display:flex; gap:8px; align-items:flex-start; font-size:13px; color:var(--text); line-height:1.5; }
.clarification-index { color:var(--muted); min-width:18px; }

/* Панель управления агентом: статус + кнопки Стоп/Пауза/Продолжить/Новая задача. */
.agent-control-bar { display:flex; align-items:center; justify-content:space-between; gap:12px; max-width:980px; margin:0 auto 8px; width:100%; padding:8px 14px; border-radius:12px; border:1px solid var(--line); background:var(--panel); flex-wrap:wrap; }
.agent-control-bar.running, .agent-control-bar.queued { border-color:rgba(245,158,11,.32); background:rgba(245,158,11,.06); }
.agent-control-bar.paused { border-color:rgba(99,102,241,.32); background:rgba(99,102,241,.06); }
.agent-control-bar.awaiting_approval, .agent-control-bar.waiting_approval { border-color:rgba(245,158,11,.32); background:rgba(245,158,11,.06); }
.agent-control-status { display:flex; align-items:center; gap:8px; font-size:13px; color:var(--text); flex-wrap:wrap; }
.agent-control-dot { width:9px; height:9px; border-radius:50%; background:#6b7280; flex-shrink:0; }
.agent-control-dot.running, .agent-control-dot.queued, .agent-control-dot.awaiting_approval, .agent-control-dot.waiting_approval { background:#f59e0b; animation:pulse 1.5s infinite; }
.agent-control-dot.paused { background:#6366f1; }
.agent-control-label { font-weight:600; }
.agent-control-hint { font-size:12px; color:var(--muted); }
.agent-control-actions { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
.agent-control-actions .btn { display:inline-flex; align-items:center; gap:6px; font-size:12px; padding:6px 10px; }
.agent-control-actions .btn svg { width:14px; height:14px; }
.btn-danger { background:#ef4444; border-color:#ef4444; color:#fff; }
.btn-danger:hover:not(:disabled) { background:#dc2626; border-color:#dc2626; }
.btn-danger:disabled { opacity:.5; cursor:not-allowed; }

/* Модалка «Новая задача агенту». */
.replace-task-hint { margin:0 0 12px; font-size:13px; color:var(--muted); }
.replace-task-textarea { width:100%; min-width:420px; padding:12px; border-radius:10px; border:1px solid var(--line); background:var(--bg); color:var(--text); font:inherit; font-size:14px; line-height:1.5; resize:vertical; }
.replace-task-textarea:focus { outline:none; border-color:var(--accent); }
.composer-input { flex:1; }

.composer-textarea { width:100%; min-height:56px; max-height:220px; padding:14px 16px; border-radius:16px; border:1px solid var(--line); background:rgba(255,255,255,.02); color:var(--text); font:inherit; resize:none; line-height:1.5; overflow:auto; }
.composer-textarea:focus { outline:none; border-color:var(--accent); }
.composer-actions { display:flex; align-items:center; justify-content:space-between; margin-top:8px; }
.composer-hint { font-size:12px; color:var(--muted); }
.composer-send { width:44px; height:44px; border-radius:50%; background:var(--accent); border:none; color:#fff; display:flex; align-items:center; justify-content:center; cursor:pointer; transition:transform .15s, opacity .15s; }
.composer-send:hover:not(:disabled) { transform:scale(1.05); }
.composer-send:disabled { opacity:.4; cursor:not-allowed; }

.knowledge-panel { max-width:980px; width:100%; margin:0 auto 20px; padding:16px; border:1px solid var(--line); border-radius:14px; background:rgba(255,255,255,.02); }
.knowledge-panel-header { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; margin-bottom:14px; }
.knowledge-panel-title { margin:0; font-size:16px; color:var(--text); }
.knowledge-panel-subtitle { margin:4px 0 0; font-size:12px; color:var(--muted); }
.knowledge-panel-badge { display:inline-flex; align-items:center; padding:5px 9px; border-radius:999px; background:rgba(99,102,241,.12); border:1px solid rgba(99,102,241,.24); color:#a5b4fc; font-size:11px; font-family:var(--font-mono); }
.knowledge-grid { display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); gap:12px; }
.knowledge-card { display:flex; flex-direction:column; gap:10px; padding:14px; border-radius:12px; background:var(--panel); border:1px solid var(--line); min-width:0; }
.knowledge-card-wide { grid-column:1 / -1; }
.knowledge-card-title { font-size:13px; font-weight:600; color:var(--text); }
.coverage-list, .knowledge-list, .entity-list { display:flex; flex-direction:column; gap:10px; }
.coverage-item, .knowledge-list-item, .feature-item, .entity-item { min-width:0; }
.coverage-row { display:flex; justify-content:space-between; gap:8px; font-size:12px; color:var(--text); }
.coverage-label { text-transform:capitalize; color:var(--muted); }
.coverage-value { font-family:var(--font-mono); color:var(--text); }
.coverage-bar { height:8px; border-radius:999px; background:rgba(255,255,255,.06); overflow:hidden; }
.coverage-fill { display:block; height:100%; border-radius:999px; background:linear-gradient(90deg, #6366f1, #10b981); }
.knowledge-list-item, .feature-item, .entity-item { padding:10px 12px; border-radius:10px; background:rgba(255,255,255,.03); border:1px solid rgba(255,255,255,.05); font-size:12px; color:var(--text-dim); line-height:1.5; }
.feature-name, .entity-name { font-size:13px; font-weight:600; color:var(--text); }
.feature-desc { margin-top:4px; color:var(--text-dim); }
.entity-head { display:flex; align-items:center; justify-content:space-between; gap:8px; }
.entity-kind { padding:2px 8px; border-radius:999px; background:rgba(16,185,129,.12); border:1px solid rgba(16,185,129,.24); color:#6ee7b7; font-size:10px; text-transform:uppercase; }
.entity-meta { margin-top:4px; color:var(--muted); font-family:var(--font-mono); font-size:11px; word-break:break-word; }
.knowledge-empty { font-size:12px; color:var(--muted); padding:10px 0; }

.modal-overlay { position:fixed; inset:0; background:rgba(0,0,0,.5); display:flex; align-items:center; justify-content:center; z-index:100; }
.modal { background:var(--panel); border:1px solid var(--line); border-radius:var(--radius); padding:24px; min-width:360px; max-width:90vw; }
.modal-lg { max-width:1100px; width:95vw; max-height:90vh; }
.modal-header { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:16px; }
.modal-title { margin:0; font-size:18px; }
.delete-confirm { display:flex; flex-direction:column; gap:12px; }
.delete-confirm-icon { width:48px; height:48px; border-radius:50%; background:rgba(239,68,68,.1); color:#ef4444; display:flex; align-items:center; justify-content:center; margin:0 auto; }
.delete-confirm-title { margin:0; font-size:16px; text-align:center; }
.delete-confirm-text { margin:0; font-size:13px; color:var(--muted); text-align:center; }
.modal-footer { display:flex; justify-content:flex-end; gap:8px; margin-top:20px; }
.knowledge-dialog-body { max-height:65vh; overflow:auto; padding-right:8px; }
.toast { position:fixed; bottom:20px; right:20px; display:flex; align-items:center; gap:12px; padding:12px 16px; border-radius:var(--radius); background:var(--panel); border:1px solid var(--line); box-shadow:0 10px 30px rgba(0,0,0,.2); z-index:200; animation:slideIn .3s ease; }
@keyframes slideIn { from{opacity:0;transform:translateY(20px)} to{opacity:1;transform:translateY(0)} }
.toast.success { border-color:#10b981; }
.toast.error { border-color:#ef4444; }
.toast.info { border-color:#3b82f6; }
.toast-icon { flex-shrink:0; width:20px; height:20px; }
.toast.success .toast-icon { color:#10b981; }
.toast.error .toast-icon { color:#ef4444; }
.toast.info .toast-icon { color:#3b82f6; }

@media (max-width: 900px) {
  .knowledge-grid { grid-template-columns:1fr; }
  .knowledge-card-wide { grid-column:auto; }
}
</style>
