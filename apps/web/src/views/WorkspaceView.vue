<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { api } from "../api";
import type { Chat, ChatMessage, ChatStats, ModelCatalogItem, Project, ProjectMemoryEntry, Provider, RunItem, Team } from "../types";

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
  toasts: [] as Array<{ id: number; type: 'success' | 'error' | 'info'; message: string }>,
  deleteConfirm: null as null | { type: 'project' | 'chat'; id: string; name: string; onConfirm: () => Promise<void> },
  streamingMessage: null as null | { id: string; content: string; role: string; isRunExecution: boolean },
  currentStep: 'orchestrator' as 'orchestrator' | 'analyst' | 'developer' | 'tester' | 'analyst2' | 'orchestrator2' | '',
  currentStepDetail: '',
});

const chatDraft = ref("");
const messagesListRef = ref<HTMLElement | null>(null);
const agentLogsRef = ref<HTMLElement | null>(null);
let isMounted = false;
let pollTimer: number | null = null;
let toastId = 0;
let ws: any = null;
let wsReconnectTimer: number | null = null;
let shouldAutoScroll = true;
let isLoadingChat = false;
let lastStreamLength = 0;
let userHasScrolled = false;

const selectedProvider = computed(() => state.providers.find((item) => item.id === state.selectedProviderId) ?? null);
const selectedTeam = computed(() => state.teams.find((item) => item.id === state.selectedTeamId) ?? null);
const selectedProject = computed(() => state.projects.find((item) => item.id === state.selectedProjectId) ?? null);
const selectedChat = computed(() => state.chats.find((item) => item.id === state.selectedChatId) ?? null);
const selectedProjectTeam = computed(() => {
  const project = selectedProject.value;
  if (!project?.teamId) {
    return { name: "", providerId: "", agents: { orchestrator: { name: "", label: "", model: "", multiplier: 1, temperature: 0.2 }, developer: { name: "", label: "", model: "", multiplier: 1, temperature: 0.15 }, tester: { name: "", label: "", model: "", multiplier: 1, temperature: 0.1 }, analyst: { name: "", label: "", model: "", multiplier: 1, temperature: 0.2 } } } as Team;
  }
  return state.teams.find((item) => item.id === project.teamId) ?? { name: "", providerId: "", agents: { orchestrator: { name: "", label: "", model: "", multiplier: 1, temperature: 0.2 }, developer: { name: "", label: "", model: "", multiplier: 1, temperature: 0.15 }, tester: { name: "", label: "", model: "", multiplier: 1, temperature: 0.1 }, analyst: { name: "", label: "", model: "", multiplier: 1, temperature: 0.2 } } } as Team;
});

const modelGroups = computed(() => state.models.reduce<Record<string, ModelCatalogItem[]>>((groups, model) => { if (!groups[model.provider]) groups[model.provider] = []; groups[model.provider].push(model); return groups; }, {}));

const displayedMessages = computed(() => {
  return state.messages;
});

const progressSteps = [
  { key: 'orchestrator', label: 'Планирование', icon: '📋', color: '#6366f1' },
  { key: 'analyst', label: 'Анализ', icon: '🔍', color: '#10b981' },
  { key: 'developer', label: 'Разработка', icon: '💻', color: '#f59e0b' },
  { key: 'tester', label: 'Тестирование', icon: '🧪', color: '#ef4444' },
  { key: 'analyst2', label: 'Документация', icon: '📝', color: '#10b981' },
  { key: 'orchestrator2', label: 'Отчёт', icon: '📊', color: '#6366f1' },
];

const currentStepObj = computed(() => progressSteps.find(s => s.key === state.currentStep) || progressSteps[0]);

const currentAgentName = computed(() => {
  const team = selectedProjectTeam.value;
  const agents = team?.agents || {};
  switch (state.currentStep) {
    case 'orchestrator': return agents.orchestrator?.name || agents.pm?.name || 'Alex';
    case 'analyst': return agents.analyst?.name || 'Mira';
    case 'developer': return agents.developer?.name || 'Kai';
    case 'tester': return agents.tester?.name || 'Nova';
    case 'analyst2': return agents.analyst?.name || 'Mira';
    case 'orchestrator2': return agents.orchestrator?.name || agents.pm?.name || 'Alex';
    default: return '';
  }
});

const unifiedChatStream = computed(() => {
  const stream: Array<{ id: string; type: 'user' | 'assistant' | 'system' | 'agent-status' | 'run-summary' | 'token-summary'; role?: string; name?: string; label?: string; content: string; createdAt: string; meta?: any; status?: 'working' | 'idle' | 'done' | 'error'; agentRole?: string }> = [];
  
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
      const displayContent = orchPayload?.message || msg.content;
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
function formatMessageContent(item: any): string { if (!item.content) return ''; let content = String(item.content); content = content.replace(/\\n/g, '\n'); const escaped = content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>'); if (item.type === 'agent-status') return `<span class="agent-status-text">${escaped}</span>`; if (item.type === 'system') return `<span class="system-text">${escaped}</span>`; if (item.type === 'run-summary') return `<div class="run-summary-text">${escaped}</div>`; return escaped; }
function formatTime(iso: string): string { return new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }

function logTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    thinking: '💭 Мысль',
    tool: '🔧 Инструмент',
    file_read: '📖 Чтение',
    file_write: '📝 Запись',
    terminal: '💻 Терминал',
    error: '❌ Ошибка',
    status: '📌 Статус',
  };
  return labels[type] || type;
}

function formatLogContent(log: AgentLogEntry): string {
  const escaped = log.content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
  if (log.type === 'thinking') return `<span class="thinking-text">${escaped}</span>`;
  if (log.type === 'file_write' || log.type === 'file_read') return `<span class="file-text">${escaped}</span>`;
  if (log.type === 'terminal') return `<span class="terminal-text">${escaped}</span>`;
  if (log.type === 'error') return `<span class="error-text">${escaped}</span>`;
  return `<span class="status-text">${escaped}</span>`;
}

function formatLogDetails(log: AgentLogEntry): string {
  if (!log.details) return '';
  if (log.type === 'terminal' && log.details.output) {
    const escaped = String(log.details.output).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
    return `<pre class="terminal-output">${escaped}</pre>`;
  }
  if (log.type === 'error' && log.details.output) {
    const escaped = String(log.details.output).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
    return `<pre class="error-output">${escaped}</pre>`;
  }
  return '';
}

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
  
  const [runsResponse, modelsResponse, settingsResponse] = await Promise.all([api.runs(), api.models(), api.settings()]);
  state.runs = runsResponse.runs;
  state.models = modelsResponse.items;
  state.settings = settingsResponse;
  
  state.selectedProviderId = state.providers[0]?.id || "";
  state.selectedTeamId = state.teams[0]?.id || "";
  state.selectedProjectId = state.projects[0]?.id || "";
  
  if (state.selectedProjectId) { await refreshChats(state.selectedProjectId); }
  if (state.runs[0]) await openRun(state.runs[0].id);
}

async function refreshChats(projectId?: string) { if (!projectId) { state.chats = []; state.selectedChatId = ""; state.messages = []; state.chatRuns = []; state.chatStats = { requestCount: 0, runCount: 0, totalActualTokens: 0, totalWeightedTokens: 0, byRole: {} }; return; } const response = await api.chats(projectId); state.chats = response.chats; state.selectedChatId = state.chats[0]?.id || ""; if (state.selectedChatId) await openChat(state.selectedChatId); else { state.messages = []; state.chatRuns = []; state.chatStats = { requestCount: 0, runCount: 0, totalActualTokens: 0, totalWeightedTokens: 0, byRole: {} }; } }
async function openChat(id: string) { state.selectedChatId = id; isLoadingChat = true; const response = await api.chatById(id); state.messages = response.messages; state.chatRuns = response.runs; state.chatStats = response.stats; state.runEvents = []; state.runError = ""; state.report = null; state.runStatus = ""; clearAgentLogs(); await nextTick(); isLoadingChat = false; scrollMessagesToBottom("auto"); }
async function openRun(id: string) { state.selectedRunId = id; const response = await api.runById(id); state.report = response.report; state.runStatus = response.run.status; state.runEvents = response.run.events ?? []; state.runError = response.run.error ?? ""; }

function showToast(type: 'success' | 'error' | 'info', message: string) { const id = ++toastId; state.toasts.push({ id, type, message }); setTimeout(() => { const idx = state.toasts.findIndex(t => t.id === id); if (idx !== -1) state.toasts.splice(idx, 1); }, 4000); }
function confirmDelete(type: 'project' | 'chat', id: string, name: string, onConfirm: () => Promise<void>) { state.deleteConfirm = { type, id, name, onConfirm }; }
async function executeDelete() { if (!state.deleteConfirm) return; const { onConfirm } = state.deleteConfirm; state.deleteConfirm = null; try { await onConfirm(); showToast('success', 'Удалено'); } catch (e) { showToast('error', e instanceof Error ? e.message : 'Ошибка удаления'); } }
async function createChat() { if (!selectedProject.value || !(selectedProject.value.teamId || state.selectedTeamId)) return; state.busy = true; try { const response = await api.saveChat({ projectId: selectedProject.value.id, teamId: selectedProject.value.teamId || state.selectedTeamId, title: `Чат ${state.chats.length + 1}`, summary: "" }); state.chats.unshift(response.chat); state.selectedChatId = response.chat.id; await openChat(response.chat.id); showToast('success', 'Чат создан'); } catch (e) { showToast('error', e instanceof Error ? e.message : 'Ошибка'); } finally { state.busy = false; } }
async function deleteChat(id: string) { const chat = state.chats.find(c => c.id === id); if (!chat) return; confirmDelete('chat', id, chat.title, async () => { state.busy = true; try { await api.deleteChat(id); state.chats = state.chats.filter(c => c.id !== id); if (state.selectedChatId === id) { const fallback = state.chats[0] || null; state.selectedChatId = fallback?.id || ""; if (fallback) await openChat(fallback.id); else { state.messages = []; state.chatRuns = []; state.chatStats = { requestCount: 0, runCount: 0, totalActualTokens: 0, totalWeightedTokens: 0, byRole: {} }; } } showToast('success', 'Чат удалён'); } finally { state.busy = false; } }); }
async function sendChatMessage() { if (!selectedChat.value || !chatDraft.value.trim()) return; const draft = chatDraft.value.trim(); state.busy = true; chatDraft.value = ""; try { const response = await api.sendChatMessage(selectedChat.value.id, draft); await openChat(selectedChat.value.id); if (response.autoRunId) { state.selectedRunId = response.autoRunId; state.runStatus = "queued"; state.runEvents = []; state.runError = ""; state.report = null; state.currentStep = 'orchestrator'; state.currentStepDetail = 'Анализирую задачу и планирую работу команды'; clearAgentLogs(); startPolling(response.autoRunId); /* busy stays true: polling resets it when run completes */ } else { state.busy = false; } } catch (e) { chatDraft.value = draft; showToast('error', e instanceof Error ? e.message : 'Ошибка'); state.busy = false; } }
async function runTask() { if (!selectedChat.value || !chatDraft.value.trim()) return; const draft = chatDraft.value.trim(); const project = selectedProject.value; const team = selectedProjectTeam.value; if (!project || !team) return; state.busy = true; chatDraft.value = ""; try { const response = await api.startRun({ chatId: selectedChat.value.id, task: draft, teamId: team.id, teamName: team.name, projectPath: project.localPath || '' }); state.selectedRunId = response.runId; state.runStatus = "queued"; state.runEvents = []; state.runError = ""; state.report = null; state.currentStep = 'orchestrator'; state.currentStepDetail = 'Анализирую задачу и планирую работу команды'; clearAgentLogs(); startPolling(response.runId); showToast('success', 'Работа запущена'); /* busy stays true until run completes via polling */ } catch (e) { chatDraft.value = draft; showToast('error', e instanceof Error ? e.message : 'Ошибка'); state.busy = false; } }
function startPolling(runId: string) { if (pollTimer) window.clearInterval(pollTimer); const tick = async () => { try { const response = await api.job(runId); state.runStatus = response.status; state.runEvents = response.events ?? []; state.runError = response.error ?? ""; updateCurrentStep(response.events ?? []); const runsResponse = await api.runs(); state.runs = runsResponse.runs; await nextTick(); scrollMessagesToBottom("smooth"); if (response.status === "completed" || response.status === "done" || response.status === "failed") { if (pollTimer) window.clearInterval(pollTimer); state.currentStep = ''; state.currentStepDetail = ''; state.streamingMessage = null; state.busy = false; await openRun(runId); if (state.selectedChatId) await openChat(state.selectedChatId); } } catch (e) { console.error('Poll error:', e); } }; void tick(); pollTimer = window.setInterval(() => void tick(), 2000); }

function updateCurrentStep(events: Array<{ at: string; event: string; payload?: unknown }>) {
  const agentEvents = events.filter(e => e.event === 'agent:activity' && e.payload);
  if (!agentEvents.length) return;
  const lastEvent = agentEvents[agentEvents.length - 1];
  const payload = lastEvent.payload as any;
  const role = payload?.role;
  const detail = payload?.detail || '';
  state.currentStepDetail = detail;
  switch (role) {
    case 'orchestrator':
      state.currentStep = detail.includes('планирую') || detail.includes('план') ? 'orchestrator' : 'orchestrator2';
      break;
    case 'analyst':
      state.currentStep = detail.includes('ТЗ') || detail.includes('техническое') ? 'analyst' : 'analyst2';
      break;
    case 'developer':
      state.currentStep = 'developer';
      break;
    case 'tester':
      state.currentStep = 'tester';
      break;
  }
}

function clearAgentLogs() {
  // no-op, kept for compatibility
}
function scrollMessagesToBottom(behavior: ScrollBehavior = "smooth") { 
  const container = messagesListRef.value; 
  if (!container) return; 
  try { 
    container.scrollTo({ top: container.scrollHeight, behavior }); 
  } catch {} 
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
  console.log('[Scroll] User scrolled, atBottom:', atBottom, 'shouldAutoScroll:', shouldAutoScroll, 'userHasScrolled:', userHasScrolled);
}
function copyMessage(text: string) { if (!text) return; navigator.clipboard.writeText(text).then(() => showToast('success', 'Скопировано')).catch(() => showToast('error', 'Не удалось скопировать')); }
function reportText(): string { if (!state.report) return "Пока нет отчёта."; const r = state.report as any; return [`Task: ${r.task}`, `Project: ${r.projectPath}`, `Reviewer approved: ${r.approvals?.reviewerApproved ? "yes" : "no"}`, `Tester status: ${r.approvals?.testerStatus ?? "-"}`, "", r.spec?.summary ? `Spec: ${r.spec.summary}` : "", r.reviewer?.summary ? `Review: ${r.reviewer.summary}` : "", r.tester?.summary ? `Test: ${r.tester.summary}` : "", r.usageSummary ? `Tokens: actual ${r.usageSummary.totalActualTokens}, weighted ${r.usageSummary.totalWeightedTokens}` : ""].filter(Boolean).join("\n"); }

function connectWebSocket() { if (ws) { ws.disconnect(); ws = null; } console.log('[WS] Connecting...'); import('socket.io-client').then(({ io }) => { const wsUrl = import.meta.env.DEV ? `${window.location.protocol}//${window.location.hostname}:5173` : window.location.origin; console.log('[WS] wsUrl:', wsUrl); try { ws = io(wsUrl, { path: '/ws/socket.io', transports: ['websocket', 'polling'], autoConnect: true }); ws.on('connect', () => { console.log("[WS] Connected, socket.id:", ws.id); if (state.selectedChatId) ws.emit("join:chat", { chatId: state.selectedChatId }); if (state.selectedProjectId) ws.emit("join:project", { projectId: state.selectedProjectId }); }); ws.on('token:stream', (msg: any) => { console.log('[WS] token:stream', msg); handleWsMessage({ event: "token:stream", data: msg }); }); ws.on('run:event', (msg: any) => { console.log('[WS] run:event', msg); handleWsMessage({ event: "run:event", data: msg }); }); ws.on('agent:activity', (msg: any) => { console.log('[WS] agent:activity', msg); handleWsMessage({ event: "agent:activity", data: msg }); }); ws.on('disconnect', (reason: string) => { console.log("[WS] Disconnected:", reason); wsReconnectTimer = window.setTimeout(connectWebSocket, 3000); }); ws.on('connect_error', (err: any) => { console.error("[WS] Connection error:", err); }); } catch (err) { console.error("[WS] Failed to create socket.io connection:", err); ws = null; } }).catch(err => { console.error("[WS] Failed to load socket.io-client:", err); ws = null; }); }
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
      console.log('[WS] run:event added to runEvents:', runEvent, 'total:', state.runEvents.length);
      // Trigger scroll for new run events
      nextTick(() => {
        if (shouldAutoScroll && !userHasScrolled) {
          scrollMessagesToBottom('smooth');
        }
      });
    } 
  } else if (msg.event === "agent:activity") { 
    const data = msg.data; 
    state.runEvents.push({ at: msg.timestamp, event: "agent:activity", payload: data }); 
    console.log('[WS] agent:activity added:', data.role, data.detail);
    // Trigger scroll for new agent activity
    nextTick(() => {
      if (shouldAutoScroll && !userHasScrolled) {
        scrollMessagesToBottom('smooth');
      }
    });
  } 
}
function disconnectWebSocket() { if (wsReconnectTimer) window.clearTimeout(wsReconnectTimer); if (ws) { ws.disconnect(); ws = null; } }

watch(() => state.selectedChatId, async (v) => { if (v) { await openChat(v); if (ws && ws.connected) ws.emit("join:chat", { chatId: v }); } });
watch(() => state.selectedProjectId, async (v) => { await refreshChats(v); const p = state.projects.find(i => i.id === v); if (p?.teamId) state.selectedTeamId = p.teamId; if (ws && ws.connected && v) ws.emit("join:project", { projectId: v }); });
watch(() => state.messages.length, async (curr, prev) => { if (curr === prev) return; if (!isMounted) return; await nextTick(); if (prev === 0 || shouldAutoScroll) scrollMessagesToBottom(prev === 0 ? "auto" : "smooth"); });

onMounted(() => { isMounted = true; void loadInitialData(); connectWebSocket(); });
onBeforeUnmount(() => { isMounted = false; if (pollTimer) window.clearInterval(pollTimer); disconnectWebSocket(); });
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
      <div v-if="state.runEvents.length && state.runStatus === 'running'" class="run-progress-bar">
        <div class="progress-steps">
          <div v-for="(step, idx) in progressSteps" :key="step.key" :class="['progress-step', { active: step.key === state.currentStep, done: progressSteps.indexOf(step) < progressSteps.indexOf(currentStepObj) }]">

            <div class="step-icon" :style="{ background: step.color }">{{ step.icon }}</div>
            <div class="step-label">{{ step.label }}</div>
            <div v-if="idx < progressSteps.length - 1" class="step-connector"></div>
          </div>
        </div>
        <div class="progress-detail">
          <span class="current-agent">{{ currentAgentName }}</span>
          <span class="current-detail">{{ state.currentStepDetail }}</span>

        </div>
      </div>
      <div ref="messagesListRef" class="chat-messages" @scroll="onUserScroll">
        <div v-if="unifiedChatStream.length === 0 && !state.streamingMessage" class="chat-empty">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
          <p>Выбери проект, создай чат и отправь первую задачу оркестратору.</p>
        </div>
        <div v-else>
          <div v-for="item in unifiedChatStream" :key="item.id" class="message" :class="[item.type, item.status]">
            <div class="message-avatar" :class="item.agentRole || item.role" :style="{ background: 'var(--accent)' }">{{ item.type === 'user' ? '👤' : item.type === 'system' ? '⚙' : item.type === 'token-summary' ? '📊' : agentInitial(item) }}</div>
            <div class="message-bubble">
              <div class="message-header"><span class="message-name">{{ messageName(item) }}</span><span class="message-time">{{ formatTime(item.createdAt) }}</span><span v-if="item.status" class="message-status" :class="item.status"><span class="status-dot" :class="item.status"></span>{{ item.status === 'working' ? 'Работает' : item.status === 'done' ? 'Готово' : item.status === 'idle' ? 'Пропущен' : 'Ошибка' }}</span></div>
              <div class="message-content" v-html="formatMessageContent(item)"></div>
              <div v-if="item.meta?.usage" class="message-actions"><button class="action-btn" @click="copyMessage(item.content)" title="Копировать"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button></div>
            </div>
          </div>
          <div v-if="state.streamingMessage" class="message assistant working">
            <div class="message-avatar" :class="streamingAvatarClass">{{ streamingAvatarLetter }}</div>
            <div class="message-bubble">
              <div class="message-header"><span class="message-name">{{ streamingDisplayName }}</span><span class="message-time">{{ formatTime(new Date().toISOString()) }}</span><span class="message-status working"><span class="status-dot working"></span>Печатает...</span></div>
              <div class="message-content" v-html="formatMessageContent({ content: streamingDisplayContent })"></div>
            </div>
          </div>

          <div v-if="state.busy && state.runEvents.length" class="typing-indicator"><span class="typing-dots"><span></span><span></span><span></span></span>Агенты работают...</div>
        </div>
      </div>

      <footer class="chat-composer">
        <div class="composer-input"><textarea class="composer-textarea" v-model="chatDraft" rows="1" placeholder="Например: кто в команде, что сейчас в работе, добавь задачу на экспорт CSV" @keydown.enter.exact.shift="sendChatMessage" @keydown.enter.prevent="sendChatMessage" style="height:56px"></textarea></div>
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
.chat-messages { flex:1; overflow:auto; padding:20px; display:flex; flex-direction:column; gap:16px; }
.chat-empty { flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center; color:var(--muted); text-align:center; gap:12px; }
.chat-empty svg { width:48px; height:48px; opacity:.5; }
.message { display:flex; gap:12px; max-width:900px; margin:0 auto; width:100%; }
.message-avatar { width:32px; height:32px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:14px; font-weight:600; color:#fff; flex-shrink:0; }
.message-avatar.orchestrator { background:#6366f1; }
.message-avatar.developer { background:#f59e0b; }
.message-avatar.tester { background:#ef4444; }
.message-avatar.analyst { background:#10b981; }
.message-avatar.system { background:#6b7280; }
.message-bubble { flex:1; min-width:0; }
.message-header { display:flex; align-items:center; gap:12px; margin-bottom:4px; flex-wrap:wrap; }
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
.message-content { font-size:14px; line-height:1.6; white-space:pre-wrap; word-break:break-word; }
.message-content pre { background:var(--bg); padding:12px; border-radius:var(--radius); overflow:auto; font-size:12px; margin:8px 0; }
.message-content code { background:var(--bg); padding:2px 6px; border-radius:4px; font-size:13px; }
.message-actions { display:flex; gap:8px; margin-top:8px; opacity:0; transition:opacity .2s; }
.message-bubble:hover .message-actions { opacity:1; }
.action-btn { padding:6px; border-radius:var(--radius-sm); background:var(--bg); border:1px solid var(--line); color:var(--muted); cursor:pointer; display:flex; align-items:center; justify-content:center; }
.action-btn:hover { color:var(--text); border-color:var(--accent); }
.typing-indicator { padding:12px 20px; color:var(--muted); font-size:13px; display:flex; align-items:center; gap:8px; }
.typing-dots { display:flex; gap:3px; }
.typing-dots span { width:6px; height:6px; border-radius:50%; background:var(--accent); animation:bounce 1.4s infinite ease-in-out both; }
.typing-dots span:nth-child(1) { animation-delay:-.32s; }
.typing-dots span:nth-child(2) { animation-delay:-.16s; }
@keyframes bounce { 0%,80%,100%{transform:scale(0)} 40%{transform:scale(1)} }

.run-progress-bar { padding: 12px 20px; border-bottom: 1px solid var(--line); background: var(--panel); }
.progress-steps { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; overflow-x: auto; padding-bottom: 4px; }
.progress-step { display: flex; flex-direction: column; align-items: center; gap: 4px; min-width: 70px; opacity: 0.4; transition: opacity 0.3s; }
.progress-step.active { opacity: 1; }
.progress-step.done { opacity: 0.7; }
.progress-step.done .step-icon { background: #10b981 !important; }
.step-icon { width: 28px; height: 28px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 12px; color: white; }
.step-label { font-size: 10px; text-align: center; white-space: nowrap; color: var(--muted); }
.progress-step.active .step-label { color: var(--text); font-weight: 500; }
.step-connector { width: 24px; height: 2px; background: var(--line); margin-bottom: 14px; }
.progress-step.done + .step-connector { background: #10b981; }
.progress-detail { display: flex; align-items: center; gap: 12px; font-size: 12px; color: var(--muted); }
.current-agent { font-weight: 600; color: var(--accent); text-transform: capitalize; }
.current-detail { max-width: 400px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.chat-composer { padding:16px 20px; border-top:1px solid var(--line); background:var(--panel); }
.composer-input { flex:1; }
.composer-textarea { width:100%; padding:12px 16px; border-radius:var(--radius); border:1px solid var(--line); background:var(--bg); color:var(--text); font:inherit; resize:none; line-height:1.5; }
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