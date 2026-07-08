<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { io, Socket } from "socket.io-client";
import { api } from "../api";
import type {
  Chat,
  CompileResult,
  Project,
  ProjectMemoryEntry,
  Provider,
  ResyncHistoryItem,
  ResyncResult,
  ResyncStage,
  ResyncStatus,
  RunItem,
  Team,
} from "../types";
import MissionCard from "../components/workspace/MissionCard.vue";
import MissionComposer from "../components/workspace/MissionComposer.vue";
import KnowledgeGraphModal from "../components/workspace/KnowledgeGraphModal.vue";
import WorkspaceInspector from "../components/workspace/WorkspaceInspector.vue";
import WorkspaceSidebar from "../components/workspace/WorkspaceSidebar.vue";
import type { InspectorTab, LiveActivityItem, MissionHistoryItem, PipelineStage, TimelineEvent } from "../components/workspace/types";

type GlobalData = {
  providers: { value: Provider[] };
  teams: { value: Team[] };
  projects: { value: Project[] };
  loading: { value: boolean };
};

const API_BASE = (import.meta.env.VITE_API_URL || "").replace(/\/$/, "");
const globalData = inject<GlobalData>("globalData", {
  providers: { value: [] },
  teams: { value: [] },
  projects: { value: [] },
  loading: { value: true },
});

const state = reactive({
  providers: [] as Provider[],
  teams: [] as Team[],
  projects: [] as Project[],
  projectMemory: [] as ProjectMemoryEntry[],
  chats: [] as Chat[],
  runs: [] as RunItem[],
  selectedProviderId: "",
  selectedTeamId: "",
  selectedProjectId: "",
  selectedChatId: "",
  selectedMissionId: "",
  missionMode: "build" as "build" | "ask",
  inspectorTab: "knowledge" as InspectorTab,
  search: "",
  composer: "",
  attachedContext: [] as string[],
  compileBusy: false,
  loading: false,
  previewOpen: false,
  previewResult: null as CompileResult | null,
  previewTask: "",
  composerError: "",
  resyncBusy: false,
  resyncRunningModalOpen: false,
  resyncSummaryModalOpen: false,
  resyncHistoryModalOpen: false,
  resyncStatus: null as ResyncStatus | null,
  resyncHistory: [] as ResyncHistoryItem[],
  resyncResult: null as ResyncResult | null,
  resyncStages: [] as ResyncStage[],
  resyncError: "",
  graphModalOpen: false,
  graphLoading: false,
  graphError: "",
  graphEntry: null as ProjectMemoryEntry | null,
  activeResyncRunId: "",
  selectedResyncHistoryId: "",
  missions: [] as MissionHistoryItem[],
});

const quickTemplates = [
  "Исправить баг в сервисе с сохранением обратной совместимости",
  "Добавить фичу с тестами и кратким ADR",
  "Провести архитектурный разбор модуля и дать рекомендации",
  "Оптимизировать производительность узкого места и описать изменения",
];

const composerRef = ref<HTMLTextAreaElement | null>(null);
let ws: Socket | null = null;
let pollTimer: number | null = null;

const selectedMission = computed(() => state.missions.find((m) => m.id === state.selectedMissionId) ?? null);
const filteredMissions = computed(() => {
  const q = state.search.trim().toLowerCase();
  const rows = [...state.missions].sort((a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt));
  if (!q) return rows;
  return rows.filter((m) => [m.title, m.status, m.mode, m.resultSummary, ...m.models].join(" ").toLowerCase().includes(q));
});

const suggestedContext = computed(() => {
  const uniq = new Set<string>();
  for (const memory of state.projectMemory) {
    for (const file of memory.relatedFiles || []) {
      if (file) uniq.add(file);
      if (uniq.size >= 24) break;
    }
    if (uniq.size >= 24) break;
  }
  return Array.from(uniq);
});

const missionTimeline = computed<TimelineEvent[]>(() => {
  const mission = selectedMission.value;
  if (!mission) return [];
  return mission.runEvents
    .map((e) => ({ at: e.at, title: normalizeEventTitle(e.event), details: formatPayloadSummary(e.payload) }))
    .sort((a, b) => +new Date(a.at) - +new Date(b.at));
});

const liveActivity = computed<LiveActivityItem[]>(() => {
  const mission = selectedMission.value;
  if (!mission) return [];
  return mission.runEvents
    .map((event) => {
      const payload = (event.payload && typeof event.payload === "object" ? event.payload : {}) as Record<string, unknown>;
      const roleRaw = String(payload.agentRole || payload.role || "").toLowerCase();
      const role = roleRaw.includes("pm")
        ? "Проектный менеджер"
        : roleRaw.includes("review")
          ? "Ревьюер"
          : roleRaw.includes("test")
            ? "Тестировщик"
            : roleRaw.includes("knowledge")
              ? "Система знаний"
              : roleRaw.includes("dev")
                ? "Разработчик"
                : "Оркестратор";
      return {
        id: `${event.at}-${event.event}`,
        at: event.at,
        role,
        action: payload.action ? String(payload.action) : normalizeEventTitle(event.event),
        target: payload.target ? String(payload.target) : formatPayloadSummary(event.payload),
      };
    })
    .filter((x) => x.action || x.target)
    .slice(-18)
    .reverse();
});

const missionPipeline = computed<PipelineStage[]>(() => {
  const mission = selectedMission.value;
  if (!mission) return [];
  const runStatus = mission.status.toLowerCase();
  const runDone = ["completed", "done"].includes(runStatus);
  const runErrored = ["failed", "cancelled"].includes(runStatus);
  const runActive = ["running", "queued", "awaiting_approval", "waiting_approval", "paused"].includes(runStatus);
  const hasRun = Boolean(mission.runId);

  return [
    { id: "intent", title: "Анализ намерения", description: "Классификация задачи", status: "done", duration: "~1s", model: inferModel(mission, "orchestrator") },
    { id: "ir", title: "IR компилятора", description: "Построение структуры задачи", status: "done", duration: "~1s", model: inferModel(mission, "orchestrator") },
    { id: "knowledge", title: "Поиск знаний", description: "Поиск знаний проекта", status: "done", duration: "~1s", model: inferModel(mission, "pm") },
    { id: "impact", title: "Анализ влияния", description: "Анализ влияния изменений", status: "done", duration: "~1s", model: inferModel(mission, "pm") },
    { id: "context", title: "Сбор контекста", description: "Сбор контекст-пакета", status: "done", duration: "~1s", model: inferModel(mission, "orchestrator") },
    { id: "planning", title: "Планирование выполнения", description: "План выполнения", status: "done", duration: "~1s", model: inferModel(mission, "pm") },
    {
      id: "development",
      title: "Разработка",
      description: "Выполнение изменений",
      status: mission.mode === "ask" ? "done" : runErrored ? "error" : runDone ? "done" : runActive || hasRun ? "active" : "pending",
      duration: hasRun ? formatDuration(mission.durationSec) : "—",
      model: inferModel(mission, "developer"),
      expandableText: mission.compile?.plan?.executionTask || "",
    },
    {
      id: "review",
      title: "Ревью",
      description: "Проверка архитектуры",
      status: mission.mode === "ask" ? "pending" : runDone ? "done" : runErrored ? "error" : runActive ? "active" : "pending",
      duration: hasRun ? formatDuration(Math.round(mission.durationSec * 0.3)) : "—",
      model: inferModel(mission, "reviewer"),
    },
    {
      id: "testing",
      title: "Тестирование",
      description: "Запуск тестов",
      status: mission.mode === "ask" ? "pending" : runDone ? "done" : runErrored ? "error" : runActive ? "active" : "pending",
      duration: hasRun ? formatDuration(Math.round(mission.durationSec * 0.2)) : "—",
      model: inferModel(mission, "tester"),
      expandableText: (mission.compile?.plan?.testsToRun || []).join("\n") || "Тесты не указаны",
    },
    {
      id: "memory",
      title: "Обновление памяти",
      description: "Обновление Knowledge Graph",
      status: runDone ? "done" : runErrored ? "error" : runActive ? "active" : "pending",
      duration: hasRun ? formatDuration(Math.max(1, Math.round(mission.durationSec * 0.1))) : "—",
      model: inferModel(mission, "knowledge"),
    },
    {
      id: "completed",
      title: "Завершено",
      description: "Финализация миссии",
      status: runDone || mission.mode === "ask" ? "done" : runErrored ? "error" : "pending",
      duration: formatDuration(mission.durationSec),
      model: inferModel(mission, "orchestrator"),
    },
  ];
});

const askArticleSections = computed(() => {
  const mission = selectedMission.value;
  if (!mission || mission.mode !== "ask") return [];
  const compile = mission.compile;
  return [
    { title: "Обзор", body: mission.askAnswer || compile?.answer || mission.resultSummary || "—" },
    { title: "Архитектура", body: compile?.impact?.reasons?.join("\n") || "Архитектурные пояснения отсутствуют." },
    { title: "Зависимости", body: (compile?.impact?.impactedServices || []).join("\n") || "Нет выявленных зависимостей." },
    { title: "Файлы", body: (compile?.impact?.impactedFiles || []).join("\n") || "Файлы не затрагиваются." },
    { title: "API", body: (compile?.impact?.impactedApi || []).join("\n") || "Изменений API не обнаружено." },
    { title: "Связанные фичи", body: (compile?.impact?.impactedPages || []).join("\n") || "Нет связанных фич." },
    { title: "Тесты", body: (compile?.impact?.testsToRun || []).join("\n") || "Рекомендованные тесты не указаны." },
    { title: "История Git", body: "Использованы текущие артефакты проекта и история запусков." },
    { title: "Источники знаний", body: "Граф знаний\nПамять проекта\nДокументация\nПамять опыта" },
  ];
});

function formatDateTime(value?: string): string {
  if (!value) return "—";
  const dt = new Date(value);
  return Number.isNaN(+dt) ? "—" : dt.toLocaleString();
}
function formatTime(value?: string): string {
  if (!value) return "—";
  const dt = new Date(value);
  return Number.isNaN(+dt) ? "—" : dt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
function formatDuration(sec?: number): string {
  const value = Number(sec || 0);
  if (!value) return "—";
  const m = Math.floor(value / 60);
  const s = Math.max(0, value % 60);
  return m ? `${m}м ${s}с` : `${s}с`;
}
function formatTokens(value?: number): string {
  return new Intl.NumberFormat().format(Number(value || 0));
}
function formatMoney(value?: number): string {
  return `$${Number(value || 0).toFixed(4)}`;
}
function formatMs(ms?: number): string {
  const value = Number(ms || 0);
  if (!value) return "0мс";
  if (value < 1000) return `${value}мс`;
  const sec = Math.round((value / 1000) * 10) / 10;
  return `${sec}с`;
}
function priorityLabel(weight: number): string {
  if (weight >= 0.85) return "Критично";
  if (weight >= 0.65) return "Высокий";
  if (weight >= 0.45) return "Средний";
  return "Низкий";
}
function priorityClass(weight: number): string {
  if (weight >= 0.85) return "critical";
  if (weight >= 0.65) return "high";
  if (weight >= 0.45) return "medium";
  return "low";
}

function normalizeEvents(events: Array<{ at: string; event: string; payload?: unknown }>) {
  return [...events].sort((a, b) => +new Date(a.at) - +new Date(b.at));
}
function normalizeEventTitle(event: string): string {
  const map: Record<string, string> = {
    "run:created": "Задача создана",
    "intent:ready": "Намерение определено",
    "compiler:ir": "IR компилятора готов",
    "context:built": "Контекст собран",
    "developer:started": "Разработка начата",
    "review:started": "Ревью начато",
    "testing:started": "Тестирование начато",
    "knowledge:updated": "Знания обновлены",
    completed: "Завершено",
  };
  return map[event] || event.replace(/[._]/g, ":").split(":").map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(" ");
}
function formatPayloadSummary(payload: unknown): string {
  if (!payload) return "";
  if (typeof payload === "string") return payload;
  if (typeof payload !== "object") return String(payload);
  const p = payload as Record<string, unknown>;
  return String(p.target || p.action || p.message || p.stage || "");
}
function inferModel(mission: MissionHistoryItem, role: string): string {
  const byRole = mission.models.find((m) => m.toLowerCase().includes(role));
  return byRole || mission.models[0] || "авто";
}
function summarizeFinal(report: unknown, error?: string): string {
  if (error) return `Ошибка: ${error}`;
  if (!report) return "Миссия завершена.";
  if (typeof report === "string") return report.slice(0, 240);
  if (typeof report === "object") {
    const summary = (report as Record<string, unknown>).summary;
    if (typeof summary === "string") return summary.slice(0, 240);
  }
  return "Миссия завершена.";
}

function autoResizeComposer() {
  const el = composerRef.value;
  if (!el) return;
  el.style.height = "0px";
  el.style.height = `${Math.min(260, Math.max(96, el.scrollHeight))}px`;
}

function upsertMission(entry: MissionHistoryItem) {
  const idx = state.missions.findIndex((m) => m.id === entry.id);
  if (idx >= 0) state.missions[idx] = { ...state.missions[idx], ...entry };
  else state.missions.unshift(entry);
}

function mergeRunIntoMission(run: RunItem) {
  const existing = state.missions.find((m) => m.runId === run.id);
  const started = run.startedAt || new Date().toISOString();
  const finished = run.finishedAt || new Date().toISOString();
  const durationSec = Math.max(0, Math.round((+new Date(finished) - +new Date(started)) / 1000));
  const patch: MissionHistoryItem = {
    id: existing?.id || `run:${run.id}`,
    title: run.task,
    mode: existing?.mode || "build",
    status: run.status,
    createdAt: started,
    updatedAt: finished,
    runId: run.id,
    durationSec,
    changedFiles: existing?.compile?.impact?.impactedFiles?.length || 0,
    tokens: existing?.compile?.contextPack?.totalEstimatedTokens || 0,
    cost: ((existing?.compile?.contextPack?.totalEstimatedTokens || 0) / 1000) * 0.004,
    models: existing?.models || ["auto"],
    resultSummary: summarizeFinal(run.finalReport, run.error),
    compile: existing?.compile || null,
    runEvents: normalizeEvents(run.events || []),
    finalReport: run.finalReport,
    askAnswer: existing?.askAnswer,
  };
  upsertMission(patch);
  if (!state.selectedMissionId) state.selectedMissionId = patch.id;
}

async function loadChats() {
  if (!state.selectedProjectId) {
    state.chats = [];
    state.selectedChatId = "";
    return;
  }
  state.chats = (await api.chats(state.selectedProjectId)).chats;
  if (!state.chats.some((chat) => chat.id === state.selectedChatId)) {
    state.selectedChatId = state.chats[0]?.id || "";
  }
}

async function ensureChatId() {
  await loadChats();
  if (state.selectedChatId) return state.selectedChatId;
  if (!state.selectedProjectId || !state.selectedTeamId) return "";
  const chat = await api.saveChat({
    projectId: state.selectedProjectId,
    teamId: state.selectedTeamId,
    title: `Миссия ${new Date().toLocaleString()}`,
    summary: "Сессия центра миссий",
    isActive: true,
  });
  state.selectedChatId = chat.chat.id;
  state.chats.unshift(chat.chat);
  return state.selectedChatId;
}

async function loadProjectMemory() {
  if (!state.selectedProjectId) {
    state.projectMemory = [];
    return;
  }
  state.projectMemory = (await api.projectMemory(state.selectedProjectId)).entries;
}

async function loadKnowledgeGraph() {
  if (!state.selectedProjectId) {
    state.graphEntry = null;
    return;
  }
  state.graphLoading = true;
  state.graphError = "";
  try {
    const response = await api.projectKnowledgeGraph(state.selectedProjectId);
    state.graphEntry = response.entry || null;
  } catch (error) {
    state.graphError = error instanceof Error ? error.message : "Не удалось загрузить граф проекта";
  } finally {
    state.graphLoading = false;
  }
}

async function openProjectMap() {
  state.graphModalOpen = true;
  await loadKnowledgeGraph();
}

function closeProjectMap() {
  state.graphModalOpen = false;
}

async function refreshProjectMap() {
  await loadKnowledgeGraph();
}

async function loadRuns() {
  const response = await api.runs();
  state.runs = state.selectedProjectId
    ? response.runs.filter((run) => run.projectId === state.selectedProjectId)
    : response.runs;

  state.missions = state.missions.filter((mission) => {
    if (!mission.runId) return false;
    return state.runs.some((run) => run.id === mission.runId);
  });

  if (state.selectedMissionId && !state.missions.some((m) => m.id === state.selectedMissionId)) {
    state.selectedMissionId = "";
  }

  for (const run of response.runs) {
    if (state.selectedProjectId && run.projectId && run.projectId !== state.selectedProjectId) continue;
    mergeRunIntoMission(run);
  }
}

async function loadResyncStatus() {
  if (!state.selectedProjectId) {
    state.resyncStatus = null;
    return;
  }
  const response = await api.resyncStatus(state.selectedProjectId);
  state.resyncStatus = response.status;
}

async function loadResyncHistory() {
  if (!state.selectedProjectId) {
    state.resyncHistory = [];
    state.selectedResyncHistoryId = "";
    return;
  }
  const response = await api.resyncHistory(state.selectedProjectId);
  state.resyncHistory = response.items;
  if (!state.selectedResyncHistoryId && response.items.length) {
    state.selectedResyncHistoryId = response.items[0].id;
  }
}

function openResyncHistory() {
  if (!state.resyncHistory.length) return;
  state.resyncHistoryModalOpen = true;
}

async function runProjectResync() {
  if (!state.selectedProjectId || state.resyncBusy) return;

  const projectId = state.selectedProjectId;
  state.resyncBusy = true;
  state.resyncRunningModalOpen = true;
  state.resyncSummaryModalOpen = false;
  state.resyncError = "";
  state.resyncResult = null;
  state.activeResyncRunId = "";
  state.resyncStages = [
    { key: "scan", title: "Сканирование проекта...", status: "active", durationMs: 0 },
    { key: "detect", title: "Определение изменений...", status: "pending", durationMs: 0 },
    { key: "knowledge_graph", title: "Обновление графа знаний...", status: "pending", durationMs: 0 },
    { key: "relationships", title: "Перестроение связей...", status: "pending", durationMs: 0 },
    { key: "documentation", title: "Обновление документации...", status: "pending", durationMs: 0 },
    { key: "memory", title: "Оптимизация памяти...", status: "pending", durationMs: 0 },
    { key: "coverage", title: "Пересчёт покрытия...", status: "pending", durationMs: 0 },
    { key: "validation", title: "Финальная валидация...", status: "pending", durationMs: 0 },
    { key: "optimize", title: "Оптимизация индексов...", status: "pending", durationMs: 0 },
  ];

  try {
    const response = await api.resyncProject(projectId);
    state.resyncResult = response.result;
    state.activeResyncRunId = response.result.runId;
    state.resyncStages = response.result.stages;

    await Promise.all([
      loadProjectMemory(),
      loadKnowledgeGraph(),
      loadRuns(),
      loadChats(),
      loadResyncStatus(),
      loadResyncHistory(),
      refreshActiveMission(),
    ]);

    state.resyncSummaryModalOpen = true;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Синхронизация не удалась";
    state.resyncError = message;
    state.resyncStages = state.resyncStages.map((stage, index) =>
      index === state.resyncStages.findIndex((x) => x.status === "active")
        ? { ...stage, status: "error", message }
        : stage,
    );
  } finally {
    state.resyncBusy = false;
    state.resyncRunningModalOpen = false;
    state.activeResyncRunId = "";
  }
}

const selectedResyncHistoryEntry = computed(() =>
  state.resyncHistory.find((item) => item.id === state.selectedResyncHistoryId) || state.resyncHistory[0] || null,
);

async function refreshActiveMission() {
  const mission = selectedMission.value;
  if (!mission?.runId) return;
  const data = await api.runById(mission.runId);
  const run = state.runs.find((r) => r.id === mission.runId);
  if (!run) return;
  run.status = data.run.status;
  run.events = data.run.events;
  run.finalReport = data.report;
  run.error = data.run.error;
  run.finishedAt = data.run.finishedAt;
  mergeRunIntoMission(run);
}

function startPolling() {
  stopPolling();
  pollTimer = window.setInterval(async () => {
    try {
      await loadRuns();
      await refreshActiveMission();
    } catch {
      // silent
    }
  }, 4000);
}
function stopPolling() {
  if (pollTimer) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
}

function startSocket() {
  const target = API_BASE || window.location.origin;
  ws = io(target, { transports: ["websocket"], path: "/ws/socket.io" });

  ws.on("connect", () => {
    if (state.selectedProjectId) ws?.emit("join:project", { projectId: state.selectedProjectId });
    if (state.selectedChatId) ws?.emit("join:chat", { chatId: state.selectedChatId });
  });

  ws.onAny((eventName: string, payload: any) => {
    if (!payload || typeof payload !== "object") return;

    if (eventName === "project:resync:stage") {
      const stage = payload.stage as ResyncStage | undefined;
      const runId = String(payload.runId || "");
      if (!stage || !runId) return;
      if (state.activeResyncRunId && state.activeResyncRunId !== runId) return;
      state.activeResyncRunId = runId;

      const idx = state.resyncStages.findIndex((item) => item.key === stage.key);
      if (idx >= 0) {
        state.resyncStages[idx] = { ...state.resyncStages[idx], ...stage };
      } else {
        state.resyncStages.push(stage);
      }
      return;
    }

    if (eventName === "project:resync:completed") {
      const runId = String(payload.runId || "");
      if (state.activeResyncRunId && runId && state.activeResyncRunId !== runId) return;
      if (payload.stages && Array.isArray(payload.stages)) {
        state.resyncStages = payload.stages;
      }
      if (payload.summary) {
        state.resyncResult = payload as ResyncResult;
      }
      return;
    }

    const runId = payload.runId || payload.id;
    if (!runId) return;
    const mission = state.missions.find((m) => m.runId === runId);
    if (!mission) return;
    mission.updatedAt = new Date().toISOString();
    mission.runEvents = normalizeEvents([
      ...mission.runEvents,
      { at: new Date().toISOString(), event: eventName, payload },
    ]);
    if (payload.status) mission.status = String(payload.status);
  });
}
function stopSocket() {
  if (!ws) return;
  ws.disconnect();
  ws = null;
}

function handleComposerKeydown(event: KeyboardEvent) {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    event.preventDefault();
    void submitChatMessage("build");
    return;
  }
  if (event.shiftKey && event.key === "Enter") {
    event.preventDefault();
    void submitChatMessage("ask");
  }
}
function useTemplate(tpl: string) {
  state.composer = tpl;
  autoResizeComposer();
}
function toggleAttach(file: string) {
  if (state.attachedContext.includes(file)) state.attachedContext = state.attachedContext.filter((x) => x !== file);
  else state.attachedContext.push(file);
}

function composedTask() {
  const task = state.composer.trim();
  if (!task) return "";
  if (!state.attachedContext.length) return task;
  return `${task}\n\nПриложенный контекст:\n${state.attachedContext.map((f) => `- ${f}`).join("\n")}`;
}

async function handlePreview() {
  const task = composedTask();
  if (!task || !state.selectedProjectId) return;
  state.composerError = "";
  state.compileBusy = true;
  try {
    const chatId = await ensureChatId();
    const compiled = await api.compile({
      projectId: state.selectedProjectId,
      task,
      chatId: chatId || undefined,
      teamId: state.selectedTeamId || undefined,
      mode: state.missionMode,
      execute: false,
    });
    state.previewResult = compiled.result;
    state.previewTask = task;
    state.previewOpen = true;
  } finally {
    state.compileBusy = false;
  }
}

async function handleCompileFromPreview() {
  if (!state.previewResult || !state.selectedProjectId) return;
  const task = state.previewTask.trim();
  if (!task) return;
  state.composerError = "";
  state.compileBusy = true;
  try {
    const chatId = await ensureChatId();
    if (state.missionMode === "build") {
      const started = await api.compileBuild({
        projectId: state.selectedProjectId,
        task,
        chatId: chatId || undefined,
        teamId: state.selectedTeamId || undefined,
        execute: true,
      });
      const runId = started.result.run?.runId;
      const missionId = runId ? `run:${runId}` : `mission:${Date.now()}`;
      upsertMission({
        id: missionId,
        title: state.composer.trim() || task,
        mode: "build",
        status: "queued",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        runId,
        durationSec: 0,
        changedFiles: started.result.impact?.impactedFiles?.length || 0,
        tokens: started.result.contextPack?.totalEstimatedTokens || 0,
        cost: ((started.result.contextPack?.totalEstimatedTokens || 0) / 1000) * 0.004,
        models: ["orchestrator", "pm", "developer", "reviewer", "tester", "knowledge"],
        resultSummary: "Сборка запущена.",
        compile: started.result,
        runEvents: [{ at: new Date().toISOString(), event: "run:created", payload: { task } }],
      });
      state.selectedMissionId = missionId;
    } else {
      const asked = await api.compileAsk({
        projectId: state.selectedProjectId,
        task,
        chatId: chatId || undefined,
        teamId: state.selectedTeamId || undefined,
      });
      const id = `ask:${Date.now()}`;
      upsertMission({
        id,
        title: state.composer.trim() || task,
        mode: "ask",
        status: "completed",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        durationSec: 1,
        changedFiles: asked.result.impact?.impactedFiles?.length || 0,
        tokens: asked.result.contextPack?.totalEstimatedTokens || 0,
        cost: ((asked.result.contextPack?.totalEstimatedTokens || 0) / 1000) * 0.004,
        models: ["orchestrator", "pm", "knowledge"],
        resultSummary: (asked.result.answer || "Готово").slice(0, 240),
        compile: asked.result,
        runEvents: [{ at: new Date().toISOString(), event: "completed", payload: { mode: "ask" } }],
        askAnswer: asked.result.answer,
      });
      state.selectedMissionId = id;
    }

    state.previewOpen = false;
    state.previewResult = null;
    state.previewTask = "";
    state.composer = "";
    state.attachedContext = [];
  } finally {
    state.compileBusy = false;
  }
}

async function quickBuild() {
  await submitChatMessage("build");
}
async function quickAsk() {
  await submitChatMessage("ask");
}

async function submitChatMessage(mode: "build" | "ask") {
  const content = composedTask().trim();
  if (!content || !state.selectedProjectId) return;

  state.missionMode = mode;
  state.composerError = "";
  state.compileBusy = true;

  try {
    const chatId = await ensureChatId();
    if (!chatId) throw new Error("Не удалось создать чат для выбранного проекта");

    const response = await api.sendChatMessage(
      chatId,
      content,
      state.selectedTeamId || undefined,
      state.selectedProjectId || undefined,
    );

    await Promise.all([loadChats(), loadRuns(), loadProjectMemory()]);

    if (response.autoRunId) {
      const run = state.runs.find((item) => item.id === response.autoRunId);
      if (run) {
        mergeRunIntoMission(run);
        state.selectedMissionId = `run:${run.id}`;
      }
    }

    state.previewOpen = false;
    state.previewResult = null;
    state.previewTask = "";
    state.composer = "";
    state.attachedContext = [];
  } catch (error) {
    state.composerError = error instanceof Error ? error.message : "Не удалось отправить сообщение в чат";
  } finally {
    state.compileBusy = false;
  }
}

onMounted(async () => {
  state.providers = globalData.providers.value;
  state.teams = globalData.teams.value;
  state.projects = globalData.projects.value;

  state.selectedProviderId = state.providers.find((p) => p.isCurrent)?.id || state.providers[0]?.id || "";
  state.selectedTeamId = state.teams[0]?.id || "";
  state.selectedProjectId = state.projects.find((p) => p.isActive)?.id || state.projects[0]?.id || "";

  state.loading = true;
  try {
    await Promise.all([loadChats(), loadProjectMemory(), loadRuns(), loadResyncStatus(), loadResyncHistory()]);
  } finally {
    state.loading = false;
  }

  startSocket();
  startPolling();
  autoResizeComposer();
});

onBeforeUnmount(() => {
  stopSocket();
  stopPolling();
});

watch(
  () => globalData.projects.value,
  (next) => {
    state.projects = next;
    if (!state.selectedProjectId && next.length) state.selectedProjectId = next[0].id;
  },
);

watch(
  () => globalData.teams.value,
  (next) => {
    state.teams = next;
    if (!state.selectedTeamId && next.length) state.selectedTeamId = next[0].id;
  },
);

watch(
  () => state.selectedProjectId,
  async (next, prev) => {
    if (ws && prev) ws.emit("leave:project", { projectId: prev });
    if (ws && next) ws.emit("join:project", { projectId: next });
    state.resyncBusy = false;
    state.resyncRunningModalOpen = false;
    state.selectedChatId = "";
    state.selectedMissionId = "";
    state.missions = [];
    state.composerError = "";
    state.resyncError = "";
    state.graphModalOpen = false;
    state.graphEntry = null;
    state.graphError = "";
    state.resyncResult = null;
    state.resyncStages = [];
    state.activeResyncRunId = "";
    state.resyncSummaryModalOpen = false;
    state.resyncHistoryModalOpen = false;
    await Promise.all([loadChats(), loadProjectMemory(), loadRuns(), loadResyncStatus(), loadResyncHistory()]);
  },
);

watch(
  () => state.selectedTeamId,
  () => {
    state.selectedChatId = "";
    state.selectedMissionId = "";
    state.missions = [];
    state.composerError = "";
    state.graphModalOpen = false;
    state.graphEntry = null;
    state.graphError = "";
  },
);

watch(
  () => state.selectedChatId,
  (next, prev) => {
    if (!ws || !ws.connected) return;
    if (prev) ws.emit("leave:chat", { chatId: prev });
    if (next) ws.emit("join:chat", { chatId: next });
  },
);

watch(
  () => state.composer,
  () => autoResizeComposer(),
);
</script>

<template>
  <div class="workspace-layout">
    <WorkspaceSidebar
      :projects="state.projects"
      :teams="state.teams"
      :selected-project-id="state.selectedProjectId"
      :selected-team-id="state.selectedTeamId"
      :mission-mode="state.missionMode"
      :search="state.search"
      :missions="filteredMissions"
      :selected-mission-id="state.selectedMissionId"
      :resync-status="state.resyncStatus"
      :resync-history="state.resyncHistory"
      :resync-busy="state.resyncBusy"
      :resync-error="state.resyncError"
      :format-date-time="formatDateTime"
      :format-duration="formatDuration"
      @update:selected-project-id="state.selectedProjectId = $event"
      @update:selected-team-id="state.selectedTeamId = $event"
      @update:mission-mode="state.missionMode = $event"
      @update:search="state.search = $event"
      @select-mission="state.selectedMissionId = $event"
      @open-project-map="openProjectMap"
      @resync-project="runProjectResync"
      @open-resync-history="openResyncHistory"
    />

    <main class="center-panel">
      <MissionComposer
        :composer="state.composer"
        :compile-busy="state.compileBusy"
        :error="state.composerError"
        :quick-templates="quickTemplates"
        :suggested-context="suggestedContext"
        :attached-context="state.attachedContext"
        @update:composer="state.composer = $event"
        @keydown="handleComposerKeydown"
        @use-template="useTemplate"
        @toggle-attach="toggleAttach"
        @preview="handlePreview"
        @build="quickBuild"
        @ask="quickAsk"
        @composer-ref="composerRef = $event"
      />

      <MissionCard
        :mission="selectedMission"
        :mission-pipeline="missionPipeline"
        :live-activity="liveActivity"
        :mission-timeline="missionTimeline"
        :ask-article-sections="askArticleSections"
        :format-date-time="formatDateTime"
        :format-time="formatTime"
        :format-duration="formatDuration"
        :format-tokens="formatTokens"
        :format-money="formatMoney"
        :priority-label="priorityLabel"
        :priority-class="priorityClass"
      />
    </main>

    <WorkspaceInspector :mission="selectedMission" :tab="state.inspectorTab" @update:tab="state.inspectorTab = $event" />

    <KnowledgeGraphModal
      :open="state.graphModalOpen"
      :loading="state.graphLoading"
      :error="state.graphError"
      :entry="state.graphEntry"
      @close="closeProjectMap"
      @refresh="refreshProjectMap"
      @resync="runProjectResync"
    />

    <div v-if="state.previewOpen && state.previewResult" class="preview-backdrop">
      <div class="preview-modal">
        <header>
          <h3>Предпросмотр перед компиляцией</h3>
          <button @click="state.previewOpen = false">✕</button>
        </header>
        <div class="preview-grid">
          <section>
            <h4>IR компилятора</h4>
            <pre>{{ JSON.stringify(state.previewResult.intent, null, 2) }}</pre>
          </section>
          <section>
            <h4>План выполнения</h4>
            <pre>{{ state.previewResult.plan.executionTask }}</pre>
          </section>
          <section>
            <h4>Анализ влияния</h4>
            <pre>{{ JSON.stringify(state.previewResult.impact, null, 2) }}</pre>
          </section>
          <section>
            <h4>Контекст-пакет</h4>
            <pre>{{ JSON.stringify(state.previewResult.contextPack, null, 2) }}</pre>
          </section>
          <div class="estimate">
            <span>Оценка стоимости: {{ formatMoney(((state.previewResult.contextPack?.totalEstimatedTokens || 0) / 1000) * 0.004) }}</span>
            <span>Оценка токенов: {{ formatTokens(state.previewResult.contextPack?.totalEstimatedTokens || 0) }}</span>
            <span>Оценка времени: 1-10м</span>
          </div>
        </div>
        <footer class="actions">
          <button class="btn ghost" @click="state.previewOpen = false">Отмена</button>
          <button class="btn primary" :disabled="state.compileBusy" @click="handleCompileFromPreview">Компилировать</button>
        </footer>
      </div>
    </div>

    <div v-if="state.resyncRunningModalOpen" class="preview-backdrop">
      <div class="preview-modal resync-modal">
        <header>
          <h3>🔄 Resync Project</h3>
        </header>
        <p class="resync-subtitle">Выполняется пайплайн синхронизации...</p>
        <div class="resync-stages">
          <div v-for="stage in state.resyncStages" :key="stage.key" class="resync-stage" :class="stage.status">
            <div class="resync-stage-dot" />
            <div>
              <div class="row between">
                <strong>{{ stage.title }}</strong>
                <span class="resync-time">{{ formatMs(stage.durationMs) }}</span>
              </div>
              <div class="resync-stage-meta">Статус: {{ stage.status }}<span v-if="stage.message"> · {{ stage.message }}</span></div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div v-if="state.resyncSummaryModalOpen && state.resyncResult" class="preview-backdrop">
      <div class="preview-modal resync-modal">
        <header>
          <h3>{{ state.resyncResult.summary.alreadySynchronized ? "Проект уже синхронизирован." : "Синхронизация проекта успешно завершена." }}</h3>
          <button @click="state.resyncSummaryModalOpen = false">✕</button>
        </header>
        <p v-if="state.resyncResult.summary.alreadySynchronized" class="resync-subtitle">
          Граф знаний актуален. Изменений в коде не обнаружено.
        </p>
        <div class="resync-summary-grid">
          <div class="metric"><span>Просканировано файлов</span><strong>{{ state.resyncResult.summary.scannedFiles }}</strong></div>
          <div class="metric"><span>Изменено файлов</span><strong>{{ state.resyncResult.summary.changedFiles }}</strong></div>
          <div class="metric"><span>Новых файлов</span><strong>{{ state.resyncResult.summary.newFiles }}</strong></div>
          <div class="metric"><span>Удалено файлов</span><strong>{{ state.resyncResult.summary.deletedFiles }}</strong></div>
          <div class="metric"><span>Новых сущностей</span><strong>{{ state.resyncResult.summary.newEntities }}</strong></div>
          <div class="metric"><span>Новых связей</span><strong>{{ state.resyncResult.summary.newRelations }}</strong></div>
          <div class="metric"><span>Обновлено сервисов</span><strong>{{ state.resyncResult.summary.updatedServices }}</strong></div>
          <div class="metric"><span>Обновлено компонентов</span><strong>{{ state.resyncResult.summary.updatedComponents }}</strong></div>
          <div class="metric"><span>Обновлено API</span><strong>{{ state.resyncResult.summary.updatedApi }}</strong></div>
          <div class="metric"><span>Обновлено документации</span><strong>{{ state.resyncResult.summary.updatedDocumentation }}</strong></div>
          <div class="metric"><span>Обновлено решений</span><strong>{{ state.resyncResult.summary.updatedArchitecturalDecisions }}</strong></div>
          <div class="metric"><span>Обновлено записей памяти</span><strong>{{ state.resyncResult.summary.updatedMemoryEntries }}</strong></div>
          <div class="metric"><span>Покрытие до</span><strong>{{ Math.round(state.resyncResult.summary.coverageBefore) }}%</strong></div>
          <div class="metric"><span>Покрытие после</span><strong>{{ Math.round(state.resyncResult.summary.coverageAfter) }}%</strong></div>
          <div class="metric"><span>Время выполнения</span><strong>{{ formatMs(state.resyncResult.summary.durationMs) }}</strong></div>
          <div class="metric"><span>Целостность памяти</span><strong>{{ state.resyncResult.summary.memoryIntegrity }}</strong></div>
        </div>
      </div>
    </div>

    <div v-if="state.resyncHistoryModalOpen" class="preview-backdrop">
      <div class="preview-modal resync-modal">
        <header>
          <h3>История синхронизаций</h3>
          <button @click="state.resyncHistoryModalOpen = false">✕</button>
        </header>
        <div class="resync-history-layout">
          <aside class="resync-history-list">
            <button
              v-for="item in state.resyncHistory"
              :key="item.id"
              class="history-run"
              :class="{ active: state.selectedResyncHistoryId === item.id }"
              @click="state.selectedResyncHistoryId = item.id"
            >
              <strong>{{ item.title }}</strong>
              <span>{{ formatDateTime(item.date) }}</span>
              <span>Длительность: {{ formatMs(item.durationMs) }}</span>
            </button>
          </aside>
          <section v-if="selectedResyncHistoryEntry" class="resync-history-details">
            <h4>{{ selectedResyncHistoryEntry.title }}</h4>
            <p>{{ selectedResyncHistoryEntry.summary }}</p>
            <ul>
              <li>Изменено файлов: {{ selectedResyncHistoryEntry.changedFiles }}</li>
              <li>Обновлено сущностей: {{ selectedResyncHistoryEntry.updatedEntities }}</li>
              <li>Покрытие: {{ Math.round(selectedResyncHistoryEntry.coverageBefore) }}% → {{ Math.round(selectedResyncHistoryEntry.coverageAfter) }}%</li>
              <li>Целостность памяти: {{ selectedResyncHistoryEntry.memoryIntegrity }}</li>
            </ul>
          </section>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.workspace-layout {
  height: calc(100vh - 56px);
  display: grid;
  grid-template-columns: 320px minmax(600px, 1fr) 360px;
  background: #090b10;
  color: #e2e8f0;
}

.center-panel {
  padding: 16px;
  overflow: auto;
}

.preview-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(2, 6, 23, 0.75);
  display: grid;
  place-items: center;
  z-index: 40;
}

.preview-modal {
  width: min(1200px, calc(100vw - 40px));
  max-height: calc(100vh - 60px);
  overflow: auto;
  background: #11151b;
  border: 1px solid rgba(148, 163, 184, 0.2);
  border-radius: 16px;
  padding: 14px;
}

.preview-modal header,
.preview-modal footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.preview-grid {
  margin-top: 12px;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}

.preview-grid section,
.estimate {
  border: 1px solid rgba(148, 163, 184, 0.2);
  border-radius: 12px;
  padding: 10px;
}

.preview-grid h4 {
  margin: 0 0 8px;
}

.preview-grid pre {
  white-space: pre-wrap;
  max-height: 240px;
  overflow: auto;
  padding: 10px;
  background: #0f1319;
  border-radius: 10px;
  border: 1px solid rgba(148, 163, 184, 0.18);
  font-size: 12px;
}

.estimate {
  display: grid;
  gap: 6px;
}

.actions {
  margin-top: 10px;
}

.btn {
  border-radius: 10px;
  padding: 10px 14px;
  font-weight: 600;
  border: 1px solid transparent;
}

.btn.ghost {
  background: #0f1319;
  border-color: rgba(148, 163, 184, 0.24);
  color: #cbd5e1;
}

.btn.primary {
  background: rgba(16, 185, 129, 0.2);
  border-color: rgba(52, 211, 153, 0.45);
  color: #6ee7b7;
}

.resync-modal {
  width: min(980px, calc(100vw - 40px));
}

.resync-subtitle {
  margin: 8px 0 12px;
  color: #94a3b8;
}

.resync-stages {
  display: grid;
  gap: 8px;
}

.resync-stage {
  display: grid;
  grid-template-columns: 14px 1fr;
  gap: 10px;
  border: 1px solid rgba(148, 163, 184, 0.2);
  border-radius: 10px;
  padding: 10px;
}

.resync-stage-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  margin-top: 4px;
  background: #64748b;
}

.resync-stage.active .resync-stage-dot {
  background: #f59e0b;
  box-shadow: 0 0 0 6px rgba(245, 158, 11, 0.18);
}

.resync-stage.done .resync-stage-dot {
  background: #10b981;
}

.resync-stage.error .resync-stage-dot {
  background: #ef4444;
}

.resync-stage-meta {
  margin-top: 4px;
  color: #94a3b8;
  font-size: 12px;
}

.resync-time {
  color: #93c5fd;
  font-size: 12px;
}

.resync-summary-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  margin-top: 10px;
}

.metric {
  border: 1px solid rgba(148, 163, 184, 0.2);
  border-radius: 10px;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.metric span {
  color: #94a3b8;
  font-size: 12px;
}

.resync-history-layout {
  display: grid;
  grid-template-columns: 280px 1fr;
  gap: 12px;
}

.resync-history-list {
  display: grid;
  gap: 8px;
}

.history-run {
  text-align: left;
  border: 1px solid rgba(148, 163, 184, 0.24);
  border-radius: 10px;
  padding: 10px;
  background: #0f1319;
  color: #e2e8f0;
  display: grid;
  gap: 4px;
}

.history-run.active {
  border-color: rgba(52, 211, 153, 0.5);
}

.history-run span {
  color: #94a3b8;
  font-size: 12px;
}

.resync-history-details {
  border: 1px solid rgba(148, 163, 184, 0.2);
  border-radius: 10px;
  padding: 12px;
}

.resync-history-details p {
  color: #cbd5e1;
}

@media (max-width: 1440px) {
  .workspace-layout {
    grid-template-columns: 300px minmax(520px, 1fr) 320px;
  }
}

@media (max-width: 1220px) {
  .workspace-layout {
    grid-template-columns: 280px 1fr;
  }
  .workspace-layout > :last-child {
    grid-column: 1 / -1;
    border-top: 1px solid rgba(148, 163, 184, 0.16);
    border-left: 0;
  }
  .preview-grid {
    grid-template-columns: 1fr;
  }
}
</style>
