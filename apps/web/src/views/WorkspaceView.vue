<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { api } from "../api";
import type { Chat, ChatMessage, ChatStats, ModelCatalogItem, Project, ProjectMemoryEntry, Provider, RunItem, TaskCommentItem, TaskItem, Team } from "../types";

const router = useRouter();
const route = useRoute();

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
  tasks: [] as TaskItem[],
  taskComments: {} as Record<string, TaskCommentItem[]>,
  taskCommentDrafts: {} as Record<string, string>,
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
  sidebarOpen: false,
  toasts: [] as Array<{ id: number; type: 'success' | 'error' | 'info'; message: string }>,
  deleteConfirm: null as null | { type: 'project' | 'chat' | 'task'; id: string; name: string; onConfirm: () => Promise<void> },
  streamingMessage: null as null | { id: string; content: string; role: string },
});

const activeTab = ref<"workspace" | "projects" | "teams" | "providers">("workspace");
const chatDraft = ref("");
const messagesListRef = ref<HTMLElement | null>(null);
let isMounted = false;
let pollTimer: number | null = null;
let toastId = 0;
let ws: any = null;
let wsReconnectTimer: number | null = null;

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
  if (!state.runEvents.length) return state.messages;
  const merged = [...state.messages];
  const existingIds = new Set(merged.map((m) => m.id));
  for (const live of liveTeamMessages.value) if (!existingIds.has(live.id)) merged.push(live);
  return merged.sort((a, b) => new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime());
});

const unifiedChatStream = computed(() => {
  const stream: Array<{ id: string; type: 'user' | 'assistant' | 'system' | 'agent-status' | 'run-summary' | 'token-summary'; role?: string; name?: string; label?: string; content: string; createdAt: string; meta?: any; status?: 'working' | 'idle' | 'done' | 'error'; agentRole?: string }> = [];
  for (const msg of displayedMessages.value) {
    if (msg.role === 'user') stream.push({ id: msg.id, type: 'user', content: msg.content, createdAt: msg.createdAt, meta: msg.meta });
    else stream.push({ id: msg.id, type: 'assistant', role: msg.meta?.usage?.role || 'assistant', name: msg.meta?.usage?.name || 'Alex', label: msg.meta?.usage?.label || 'Оркестратор', content: msg.content, createdAt: msg.createdAt, meta: msg.meta });
  }
  if (state.runEvents.length) {
    for (const entry of state.runEvents) {
      if (entry.event === 'agent:activity' && entry.payload) { const p = entry.payload as any; stream.push({ id: `activity-${entry.at}-${p.role}`, type: 'agent-status', agentRole: p.role, name: p.agentName, label: p.label, content: p.detail, createdAt: entry.at, status: p.status }); }
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
      else if (entry.event === 'test:started') { const p = entry.payload as any; stream.push({ id: `test-start-${entry.at}-${p.command}`, type: 'agent-status', agentRole: 'tester', name: 'Nova', label: 'Тестировщик', content: `🧪 Запускает тест: ${p.command}`, createdAt: entry.at, status: 'working' }); }
      else if (entry.event === 'test:finished') { const p = entry.payload as any; stream.push({ id: `test-finish-${entry.at}-${p.command}`, type: 'agent-status', agentRole: 'tester', name: 'Nova', label: 'Тестировщик', content: `${p.success ? '✓' : '✗'} Тест ${p.success ? 'пройден' : 'упал'}: ${p.command} (code ${p.code ?? '-'})`, createdAt: entry.at, status: p.success ? 'done' : 'error' }); }
      else if (entry.event === 'memory:loaded') { const p = entry.payload as any; stream.push({ id: `mem-load-${entry.at}`, type: 'system', content: `📚 Загружена память проекта: ${p.entries} записей`, createdAt: entry.at }); }
      else if (entry.event === 'memory:saved-from-analyst-final') { const p = entry.payload as any; stream.push({ id: `mem-save-${entry.at}`, type: 'system', content: `💾 Аналитик сохранил в память: ${p.entriesSaved} записей`, createdAt: entry.at }); }
      else if (entry.event === 'memory:updated') stream.push({ id: `mem-upd-${entry.at}`, type: 'system', content: `🔄 Память проекта обновлена`, createdAt: entry.at });
      else if (entry.event === 'run:context') { const p = entry.payload as any; stream.push({ id: `ctx-${entry.at}`, type: 'system', content: `📂 Контекст: ${p.fileCount} файлов, БД: ${p.hasDatabase ? 'да' : 'нет'}`, createdAt: entry.at }); }
    }
  }
  if (state.report) { const r = state.report as any; stream.push({ id: `summary-${state.selectedRunId}`, type: 'run-summary', name: 'Alex', label: 'Оркестратор', content: r.orchestratorResponse?.message || 'Запуск завершен', createdAt: r.generatedAt || new Date().toISOString(), meta: { usageSummary: r.usageSummary } }); if (r.usageSummary) stream.push({ id: `tokens-${state.selectedRunId}`, type: 'token-summary', content: '', createdAt: r.generatedAt || new Date().toISOString(), meta: { usageSummary: r.usageSummary } }); }
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
function formatActivityEntry(entry: { at: string; event: string; payload?: unknown }) { const actor = eventActor(entry.payload); if (entry.event === "agent:activity") return `${actor.agentName} (${actor.label}): ${actor.detail}`; if (entry.event === "agent:retry") return `${actor.agentName} (${actor.label}): ответ не распарсился, автоповтор ${actor.attempt || "?"}/3`; if (entry.event === "agent:retry-success") return `${actor.agentName} (${actor.label}): прислал валидный JSON, выполнение продолжено`; if (entry.event === "agent:note") return `${actor.agentName} (${actor.label}): ${actor.detail}`; if (entry.event === "agent:done") return `${actor.agentName} (${actor.label}): завершил этап`; if (entry.event === "agent:skipped") return `${actor.agentName} (${actor.label}): сейчас не задействован`; if (entry.event === "developer:empty-operations") return `${actor.agentName} (${actor.label}): не вернул правки, получает повторную задачу`; if (entry.event === "run:blocked") return `${actor.agentName} (${actor.label}): прогон остановлен, нет реальных правок`; if (entry.event === "file:processing") { const p = entry.payload as { path?: string; action?: string }; return `Разработчик: ${p?.action === "create" ? "создаёт" : "обновляет"} файл ${p?.path || "-"}`; } if (entry.event === "file:applied") { const p = entry.payload as { path?: string; action?: string }; return `Разработчик: ${p?.action === "create" ? "создал" : "обновил"} файл ${p?.path || "-"}`; } if (entry.event === "file:skipped") { const p = entry.payload as { path?: string; reason?: string }; return `Разработчик: пропустил файл ${p?.path || "-"} (${p?.reason || "без причины"})`; } if (entry.event === "files:applied") return "Разработчик применил изменения к файлам"; if (entry.event === "test:started") { const p = entry.payload as { command?: string }; return `Тестировщик: запускает "${p?.command || ""}"`; } if (entry.event === "test:finished") { const p = entry.payload as { command?: string; success?: boolean; code?: number }; return `Тестировщик: ${p?.success ? "успешно завершил" : "завершил с ошибкой"} "${p?.command || ""}" (code ${p.code ?? "-"})`; } if (entry.event === "tests:done") return "Тестировщик завершил проверку"; if (entry.event === "tests:skipped") return "Проверка тестировщиком была пропущена"; return `Событие: ${entry.event}`; }
function avatarColor(role: string): string { const colors: Record<string, string> = { orchestrator: '#6366f1', pm: '#6366f1', analyst: '#10b981', researcher: '#10b981', developer: '#f59e0b', coder: '#f59e0b', tester: '#ef4444', system: '#6b7280', user: '#3b82f6' }; return colors[role] || colors.system; }
function agentInitial(item: any): string { const name = item.name || item.label || '?'; return name.charAt(0).toUpperCase(); }
function messageName(item: any): string { if (item.type === 'user') return 'Вы'; if (item.type === 'assistant' || item.type === 'run-summary') return `${item.name || 'Alex'} (${item.label || 'Оркестратор'})`; if (item.type === 'agent-status') return `${item.name || 'Agent'} (${item.label || item.agentRole})`; if (item.type === 'system') return 'Система'; if (item.type === 'token-summary') return 'Токены'; return 'Неизвестно'; }
function formatMessageContent(item: any): string { if (!item.content) return ''; const escaped = item.content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>'); if (item.type === 'agent-status') return `<span class="agent-status-text">${escaped}</span>`; if (item.type === 'system') return `<span class="system-text">${escaped}</span>`; if (item.type === 'run-summary') return `<div class="run-summary-text">${escaped}</div>`; return escaped; }
function formatTime(iso: string): string { return new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }); }

async function loadInitialData() {
  const [providersResponse, teamsResponse, projectsResponse, runsResponse, modelsResponse, settingsResponse] = await Promise.all([api.providers(), api.teams(), api.projects(), api.runs(), api.models(), api.settings()]);
  state.providers = providersResponse.providers;
  state.models = modelsResponse.items;
  state.teams = teamsResponse.teams;
  state.projects = projectsResponse.projects;
  state.runs = runsResponse.runs;
  state.settings = settingsResponse;
  state.selectedProviderId = state.providers[0]?.id || "";
  state.selectedTeamId = state.teams[0]?.id || "";
  state.selectedProjectId = state.projects[0]?.id || "";
  if (state.selectedProjectId) { await refreshChats(state.selectedProjectId); await refreshTasks(state.selectedProjectId); }
  if (state.runs[0]) await openRun(state.runs[0].id);
}

async function refreshChats(projectId?: string) { if (!projectId) { state.chats = []; state.selectedChatId = ""; state.messages = []; state.chatRuns = []; state.chatStats = { requestCount: 0, runCount: 0, totalActualTokens: 0, totalWeightedTokens: 0, byRole: {} }; return; } const response = await api.chats(projectId); state.chats = response.chats; state.selectedChatId = state.chats[0]?.id || ""; if (state.selectedChatId) await openChat(state.selectedChatId); else { state.messages = []; state.chatRuns = []; state.chatStats = { requestCount: 0, runCount: 0, totalActualTokens: 0, totalWeightedTokens: 0, byRole: {} }; } }
async function refreshTasks(projectId?: string) { if (!projectId) { state.tasks = []; state.projectMemory = []; state.taskComments = {}; return; } const [response, memoryResponse] = await Promise.all([api.tasks(projectId), api.projectMemory(projectId)]); state.tasks = response.tasks; state.projectMemory = memoryResponse.entries; await Promise.all(state.tasks.map((task) => loadTaskComments(task.id))); }
async function loadTaskComments(taskId: string) { const response = await api.taskComments(taskId); state.taskComments[taskId] = response.comments; }
async function openChat(id: string) { state.selectedChatId = id; const response = await api.chatById(id); state.messages = response.messages; state.chatRuns = response.runs; state.chatStats = response.stats; await nextTick(); scrollMessagesToBottom("auto"); }
async function openRun(id: string) { state.selectedRunId = id; const response = await api.runById(id); state.report = response.report; state.runStatus = response.run.status; state.runEvents = response.run.events ?? []; state.runError = response.run.error ?? ""; }
function showToast(type: 'success' | 'error' | 'info', message: string) { const id = ++toastId; state.toasts.push({ id, type, message }); setTimeout(() => { const idx = state.toasts.findIndex(t => t.id === id); if (idx !== -1) state.toasts.splice(idx, 1); }, 4000); }
function confirmDelete(type: 'project' | 'chat' | 'task', id: string, name: string, onConfirm: () => Promise<void>) { state.deleteConfirm = { type, id, name, onConfirm }; }
async function executeDelete() { if (!state.deleteConfirm) return; const { onConfirm } = state.deleteConfirm; state.deleteConfirm = null; try { await onConfirm(); showToast('success', 'Удалено'); } catch (e) { showToast('error', e instanceof Error ? e.message : 'Ошибка удаления'); } }
async function createChat() { if (!selectedProject.value || !(selectedProject.value.teamId || state.selectedTeamId)) return; state.busy = true; try { const response = await api.saveChat({ projectId: selectedProject.value.id, teamId: selectedProject.value.teamId || state.selectedTeamId, title: `Чат ${state.chats.length + 1}`, summary: "" }); state.chats.unshift(response.chat); state.selectedChatId = response.chat.id; await openChat(response.chat.id); showToast('success', 'Чат создан'); } catch (e) { showToast('error', e instanceof Error ? e.message : 'Ошибка'); } finally { state.busy = false; } }
async function deleteChat(id: string) { const chat = state.chats.find(c => c.id === id); if (!chat) return; confirmDelete('chat', id, chat.title, async () => { state.busy = true; try { await api.deleteChat(id); state.chats = state.chats.filter(c => c.id !== id); if (state.selectedChatId === id) { const fallback = state.chats[0] || null; state.selectedChatId = fallback?.id || ""; if (fallback) await openChat(fallback.id); else { state.messages = []; state.chatRuns = []; state.chatStats = { requestCount: 0, runCount: 0, totalActualTokens: 0, totalWeightedTokens: 0, byRole: {} }; } } showToast('success', 'Чат удалён'); } finally { state.busy = false; } }); }
async function sendChatMessage() { if (!selectedChat.value || !chatDraft.value.trim()) return; const draft = chatDraft.value.trim(); state.busy = true; chatDraft.value = ""; try { await saveProject(); const response = await api.sendChatMessage(selectedChat.value.id, draft); await openChat(selectedChat.value.id); if (selectedProject.value) await refreshTasks(selectedProject.value.id); if (response.createdTasks.length) state.runStatus = `orchestrator_created_${response.createdTasks.length}_tasks`; if (response.autoRunId) { state.selectedRunId = response.autoRunId; state.runStatus = "queued"; state.runEvents = []; state.runError = ""; state.report = null; startPolling(response.autoRunId); } } catch (e) { chatDraft.value = draft; showToast('error', e instanceof Error ? e.message : 'Ошибка'); } finally { state.busy = false; } }
async function runTask() { if (!selectedChat.value || !chatDraft.value.trim()) return; const draft = chatDraft.value.trim(); state.busy = true; chatDraft.value = ""; try { await saveProject(); const response = await api.startRun({ chatId: selectedChat.value.id, task: draft }); state.selectedRunId = response.runId; state.runStatus = "queued"; state.runEvents = []; state.runError = ""; state.report = null; startPolling(response.runId); showToast('success', 'Работа запущена'); } catch (e) { chatDraft.value = draft; showToast('error', e instanceof Error ? e.message : 'Ошибка'); } finally { state.busy = false; } }
async function saveProject() { if (!selectedProject.value) return; state.busy = true; try { const response = await api.saveProject(selectedProject.value); const idx = state.projects.findIndex((i) => i.id === response.project.id); if (idx === -1) state.projects.unshift(response.project); else state.projects[idx] = response.project; state.selectedProjectId = response.project.id; showToast('success', 'Проект сохранён'); } catch (e) { showToast('error', e instanceof Error ? e.message : 'Ошибка'); } finally { state.busy = false; } }
function startPolling(runId: string) { if (pollTimer) window.clearInterval(pollTimer); const tick = async () => { try { const response = await api.job(runId); state.runStatus = response.status; state.runEvents = response.events ?? []; state.runError = response.error ?? ""; const runsResponse = await api.runs(); state.runs = runsResponse.runs; await nextTick(); scrollMessagesToBottom("smooth"); if (response.status === "done" || response.status === "failed") { if (pollTimer) window.clearInterval(pollTimer); await openRun(runId); if (state.selectedChatId) await openChat(state.selectedChatId); } } catch (e) { console.error('Poll error:', e); } }; void tick(); pollTimer = window.setInterval(() => void tick(), 2000); }
function scrollMessagesToBottom(behavior: ScrollBehavior = "smooth") { const container = messagesListRef.value; if (!container) return; try { container.scrollTo({ top: container.scrollHeight, behavior }); } catch {} }
function copyMessage(text: string) { if (!text) return; navigator.clipboard.writeText(text).then(() => showToast('success', 'Скопировано')).catch(() => showToast('error', 'Не удалось скопировать')); }
function reportText(): string { if (!state.report) return "Пока нет отчёта."; const r = state.report as any; return [`Task: ${r.task}`, `Project: ${r.projectPath}`, `Reviewer approved: ${r.approvals?.reviewerApproved ? "yes" : "no"}`, `Tester status: ${r.approvals?.testerStatus ?? "-"}`, "", r.spec?.summary ? `Spec: ${r.spec.summary}` : "", r.reviewer?.summary ? `Review: ${r.reviewer.summary}` : "", r.tester?.summary ? `Test: ${r.tester.summary}` : "", r.usageSummary ? `Tokens: actual ${r.usageSummary.totalActualTokens}, weighted ${r.usageSummary.totalWeightedTokens}` : ""].filter(Boolean).join("\n"); }

function connectWebSocket() { if (ws) { ws.disconnect(); ws = null; } import('socket.io-client').then(({ io }) => { const wsUrl = import.meta.env.DEV ? `${window.location.protocol}//${window.location.hostname}:5173` : undefined; try { ws = io(wsUrl, { path: '/ws/socket.io', transports: ['websocket', 'polling'], autoConnect: true }); ws.on('connect', () => { console.log("WS connected"); if (state.selectedChatId) ws.emit("join:chat", { chatId: state.selectedChatId }); if (state.selectedProjectId) ws.emit("join:project", { projectId: state.selectedProjectId }); }); ws.on('token:stream', (msg: any) => handleWsMessage({ event: "token:stream", data: msg })); ws.on('run:event', (msg: any) => handleWsMessage({ event: "run:event", data: msg })); ws.on('agent:activity', (msg: any) => handleWsMessage({ event: "agent:activity", data: msg })); ws.on('disconnect', () => { console.log("WS disconnected, reconnecting..."); wsReconnectTimer = window.setTimeout(connectWebSocket, 3000); }); ws.on('connect_error', (err: any) => { console.error("WS connection error:", err); }); } catch (err) { console.error("Failed to create socket.io connection:", err); ws = null; } }).catch(err => { console.error("Failed to load socket.io-client:", err); ws = null; }); }
function handleWsMessage(msg: any) { if (msg.event === "token:stream") { const { role, content, done } = msg.data; if (done) state.streamingMessage = null; else { if (!state.streamingMessage || state.streamingMessage.role !== role) state.streamingMessage = { id: `stream-${Date.now()}`, content, role }; else state.streamingMessage.content += content; } } else if (msg.event === "run:event") { const { runId, event: runEvent, data } = msg.data; if (runId === state.selectedRunId) state.runEvents.push({ at: msg.timestamp, event: runEvent, payload: data }); } else if (msg.event === "agent:activity") { const data = msg.data; state.runEvents.push({ at: msg.timestamp, event: "agent:activity", payload: data }); } }
function disconnectWebSocket() { if (wsReconnectTimer) window.clearTimeout(wsReconnectTimer); if (ws) { ws.disconnect(); ws = null; } }

watch(() => state.selectedChatId, async (v) => { if (v) { await openChat(v); if (ws && ws.connected) ws.emit("join:chat", { chatId: v }); } });
watch(() => state.selectedProjectId, async (v) => { await refreshChats(v); await refreshTasks(v); const p = state.projects.find(i => i.id === v); if (p?.teamId) state.selectedTeamId = p.teamId; if (ws && ws.connected && v) ws.emit("join:project", { projectId: v }); });
watch(() => displayedMessages.value.length, async (curr, prev) => { if (curr === prev) return; if (!isMounted) return; await nextTick(); scrollMessagesToBottom(prev === 0 ? "auto" : "smooth"); });

onMounted(() => { isMounted = true; void loadInitialData(); connectWebSocket(); });
onBeforeUnmount(() => { isMounted = false; if (pollTimer) window.clearInterval(pollTimer); disconnectWebSocket(); });
</script>

<template>
  <div class="workspace-view">
    <header class="workspace-header">
      <div class="context-bar">
        <div class="context-select">
          <label>Проект</label>
          <select class="form-select" v-model="state.selectedProjectId" @change="onProjectChange">
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
          <select class="form-select" v-model="state.selectedChatId">
            <option value="">Создай чат</option>
            <option v-for="c in state.chats" :key="c.id" :value="c.id">{{ c.title }}</option>
          </select>
        </div>
        <div class="context-actions">
          <button class="btn btn-primary" @click="createChat" :disabled="state.busy || !selectedProject || !(selectedProject.teamId || state.selectedTeamId)">Новый чат</button>
          <button class="btn btn-ghost" @click="saveProject" :disabled="state.busy || !selectedProject">Сохранить проект</button>
        </div>
      </div>
    </header>

    <main class="chat-area">
      <div ref="messagesListRef" class="chat-messages">
        <div v-if="unifiedChatStream.length === 0" class="chat-empty">
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
            <div class="message-avatar orchestrator">A</div>
            <div class="message-bubble">
              <div class="message-header"><span class="message-name">Alex (Оркестратор)</span><span class="message-time">{{ formatTime(new Date().toISOString()) }}</span><span class="message-status working"><span class="status-dot working"></span>Печатает...</span></div>
              <div class="message-content" v-html="formatMessageContent({ content: state.streamingMessage.content })"></div>
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
      <div class="modal"><div class="modal-header"><h3 class="modal-title">Подтвердить удаление</h3></div><div class="modal-body"><div class="delete-confirm"><div class="delete-confirm-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg></div><h3 class="delete-confirm-title">Удалить {{ state.deleteConfirm.type === 'project' ? 'проект' : state.deleteConfirm.type === 'chat' ? 'чат' : 'задачу' }}?</h3><p class="delete-confirm-text"><strong>{{ state.deleteConfirm.name }}</strong> будет удалён{{ state.deleteConfirm.type === 'project' ? ' вместе со всеми чатами, задачами, запусками и памятью' : '' }}. Это действие нельзя отменить.</p></div></div><div class="modal-footer"><button class="btn btn-ghost" @click="state.deleteConfirm = null">Отмена</button><button class="btn btn-danger" :disabled="state.busy" @click="executeDelete">Удалить</button></div></div>
    </div>

    <div v-for="toast in state.toasts" :key="toast.id" class="toast" :class="toast.type"><span class="toast-icon"><svg v-if="toast.type === 'success'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg><svg v-else-if="toast.type === 'error'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg><svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg></span><span class="toast-message">{{ toast.message }}</span></div>
  </div>
</template>

<style scoped>
.workspace-view { display:flex; flex-direction:column; height:100vh; }
.workspace-header { padding:12px 20px; border-bottom:1px solid var(--line); background:var(--panel); }
.context-bar { display:flex; flex-wrap:wrap; gap:12px; align-items:flex-end; max-width:1400px; margin:0 auto; }
.context-select { display:flex; flex-direction:column; gap:4px; min-width:160px; flex:1; }
.context-select label { font-size:11px; color:var(--muted); text-transform:uppercase; letter-spacing:.5px; }
.context-select .form-select { padding:8px 12px; border-radius:var(--radius-sm); border:1px solid var(--line); background:var(--bg); color:var(--text); font:inherit; min-height:38px; }
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