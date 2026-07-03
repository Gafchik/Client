<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { api } from "./api";
import type { Chat, ChatMessage, ChatStats, ModelCatalogItem, Project, ProjectMemoryEntry, Provider, RunItem, TaskCommentItem, TaskItem, Team } from "./types";

const state = reactive({
  providers: [] as Provider[],
  teams: [] as Team[],
  projects: [] as Project[],
  chats: [] as Chat[],
  messages: [] as ChatMessage[],
  chatRuns: [] as RunItem[],
  chatStats: {
    requestCount: 0,
    runCount: 0,
    totalActualTokens: 0,
    totalWeightedTokens: 0,
    byRole: {},
  } as ChatStats,
  tasks: [] as TaskItem[],
  taskComments: {} as Record<string, TaskCommentItem[]>,
  taskCommentDrafts: {} as Record<string, string>,
  projectMemory: [] as ProjectMemoryEntry[],
  runs: [] as RunItem[],
  models: [] as ModelCatalogItem[],
  settings: null as null | {
    env: {
      LOCAL_PROJECTS_ROOT: string;
      CONTAINER_PROJECTS_ROOT: string;
    };
  },
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
});

const router = useRouter();
const route = useRoute();
const activeTab = ref<"workspace" | "projects" | "teams" | "providers">("workspace");
const chatDraft = ref("");
const TASK_COLUMNS = [
  { status: "backlog", title: "Backlog", hint: "Идеи и задачи, которые еще не взяты в работу." },
  { status: "in_progress", title: "In Progress", hint: "То, над чем команда работает прямо сейчас." },
  { status: "done", title: "Done", hint: "Завершенные задачи и готовые результаты." },
] as const;
const TEAM_LANGUAGES = [
  { value: "en", label: "English" },
  { value: "ru", label: "Русский" },
  { value: "uk", label: "Українська" },
  { value: "ar", label: "العربية" },
  { value: "hi", label: "हिन्दी" },
  { value: "de", label: "Deutsch" },
  { value: "fr", label: "Français" },
  { value: "es", label: "Español" },
  { value: "it", label: "Italiano" },
  { value: "pt", label: "Português" },
  { value: "pl", label: "Polski" },
  { value: "tr", label: "Türkçe" },
  { value: "zh", label: "中文" },
  { value: "ja", label: "日本語" },
  { value: "ko", label: "한국어" },
] as const;
const taskDrafts = reactive<Record<"backlog" | "in_progress" | "done", { title: string; description: string }>>({
  backlog: { title: "", description: "" },
  in_progress: { title: "", description: "" },
  done: { title: "", description: "" },
});
const folderPickerSupported =
  typeof window !== "undefined" && "showDirectoryPicker" in window;
const messagesListRef = ref<HTMLElement | null>(null);
let pollTimer: number | null = null;

const selectedProvider = computed(() => state.providers.find((item) => item.id === state.selectedProviderId) ?? null);
const selectedTeam = computed(() => state.teams.find((item) => item.id === state.selectedTeamId) ?? null);
const selectedProject = computed(() => state.projects.find((item) => item.id === state.selectedProjectId) ?? null);
const selectedChat = computed(() => state.chats.find((item) => item.id === state.selectedChatId) ?? null);
const selectedProjectTeam = computed(
  () => state.teams.find((item) => item.id === selectedProject.value?.teamId) ?? null,
);
const activeTabLabel = computed(() =>
  activeTab.value === "providers"
    ? "Провайдеры"
    : activeTab.value === "teams"
      ? "Команды"
      : activeTab.value === "projects"
        ? "Проекты"
        : "Работа",
);

const routeToTab = (path: string): "workspace" | "projects" | "teams" | "providers" => {
  if (path.startsWith("/providers")) return "providers";
  if (path.startsWith("/teams")) return "teams";
  if (path.startsWith("/projects")) return "projects";
  return "workspace";
};
const modelGroups = computed(() =>
  state.models.reduce<Record<string, ModelCatalogItem[]>>((groups, model) => {
    if (!groups[model.provider]) groups[model.provider] = [];
    groups[model.provider].push(model);
    return groups;
  }, {}),
);
const tasksByColumn = computed(() => ({
  backlog: state.tasks
    .filter((task) => task.status === "backlog")
    .sort((a, b) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime()),
  in_progress: state.tasks
    .filter((task) => task.status === "in_progress")
    .sort((a, b) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime()),
  done: state.tasks
    .filter((task) => task.status === "done")
    .sort((a, b) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime()),
}));
const latestAssistantMessage = computed(
  () => [...state.messages].reverse().find((message) => message.role === "assistant") ?? null,
);
const progressSummary = computed(() => {
  const currentTask = tasksByColumn.value.in_progress[0] ?? null;
  const doneCount = tasksByColumn.value.done.length;
  const backlogCount = tasksByColumn.value.backlog.length;
  const inProgressCount = tasksByColumn.value.in_progress.length;
  const lastReply = latestAssistantMessage.value?.content?.trim() || "";

  return {
    currentTask,
    doneCount,
    backlogCount,
    inProgressCount,
    lastReplyPreview: lastReply ? `${lastReply.slice(0, 180)}${lastReply.length > 180 ? "..." : ""}` : "",
  };
});
const latestRun = computed(() => state.chatRuns[0] ?? null);
const latestRunEvents = computed(() => (state.runEvents.length ? state.runEvents : latestRun.value?.events ?? []));
const teamActivity = computed(() => {
  const byRole = new Map<
    string,
    {
      at: string;
      agentName: string;
      role: string;
      label: string;
      status: "idle" | "working";
      detail: string;
    }
  >();

  for (const entry of latestRunEvents.value) {
    if (entry.event !== "agent:activity" || !entry.payload || typeof entry.payload !== "object") continue;
    const payload = entry.payload as {
      agentName: string;
      role: string;
      label: string;
      status: "idle" | "working";
      detail: string;
    };
    byRole.set(payload.role, {
      at: entry.at,
      ...payload,
    });
  }

  return byRole;
});
const teamRosterStatus = computed(() =>
  Object.entries(selectedProjectTeam.value?.agents || {}).map(([role, agent]) => {
    const activity = teamActivity.value.get(role);
    const usage = state.chatStats.byRole[role] || state.chatStats.byRole[
      role === "orchestrator" ? "orchestrator" : role === "developer" ? "developer" : role === "analyst" ? "analyst" : "tester"
    ];
    return {
      role,
      name: agent.name || agent.label,
      label: agent.label,
      model: agent.model,
      isWorking: activity?.status === "working",
      detail: activity?.detail || "Ожидает новую задачу.",
      actualTokens: usage?.actualTokens ?? 0,
      weightedTokens: usage?.weightedTokens ?? 0,
      calls: usage?.calls ?? 0,
    };
  }),
);
function eventActor(payload: unknown) {
  if (!payload || typeof payload !== "object") {
    return {
      agentName: "Команда",
      label: "Система",
      role: "system",
      detail: "",
      attempt: undefined as number | undefined,
    };
  }

  const meta = payload as {
    agentName?: string;
    label?: string;
    role?: string;
    detail?: string;
    attempt?: number;
  };

  return {
    agentName: meta.agentName || "Команда",
    label: meta.label || "Система",
    role: meta.role || "system",
    detail: meta.detail || "",
    attempt: meta.attempt,
  };
}

function formatActivityEntry(entry: { at: string; event: string; payload?: unknown }) {
  const actor = eventActor(entry.payload);

  if (entry.event === "agent:activity") {
    return `${actor.agentName} (${actor.label}): ${actor.detail}`;
  }
  if (entry.event === "agent:retry") {
    return `${actor.agentName} (${actor.label}): ответ не распарсился, автоповтор ${actor.attempt || "?"}/3`;
  }
  if (entry.event === "agent:retry-success") {
    return `${actor.agentName} (${actor.label}): прислал валидный JSON, выполнение продолжено`;
  }
  if (entry.event === "agent:note") {
    return `${actor.agentName} (${actor.label}): ${actor.detail}`;
  }
  if (entry.event === "agent:done") {
    return `${actor.agentName} (${actor.label}): завершил этап`;
  }
  if (entry.event === "agent:skipped") {
    return `${actor.agentName} (${actor.label}): сейчас не задействован`;
  }
  if (entry.event === "developer:empty-operations") {
    return `${actor.agentName} (${actor.label}): не вернул правки, получает повторную задачу на конкретные изменения`;
  }
  if (entry.event === "run:blocked") {
    return `${actor.agentName} (${actor.label}): прогон остановлен, потому что по кодовой задаче не было реальных правок`;
  }
  if (entry.event === "file:processing") {
    const payload = entry.payload as { path?: string; action?: string };
    return `Разработчик: ${payload?.action === "create" ? "создает" : "обновляет"} файл ${payload?.path || "-"}`;
  }
  if (entry.event === "file:applied") {
    const payload = entry.payload as { path?: string; action?: string };
    return `Разработчик: ${payload?.action === "create" ? "создал" : "обновил"} файл ${payload?.path || "-"}`;
  }
  if (entry.event === "file:skipped") {
    const payload = entry.payload as { path?: string; reason?: string };
    return `Разработчик: пропустил файл ${payload?.path || "-"} (${payload?.reason || "без причины"})`;
  }
  if (entry.event === "files:applied") {
    return "Разработчик применил изменения к файлам";
  }
  if (entry.event === "test:started") {
    const payload = entry.payload as { command?: string };
    return `Тестировщик: запускает "${payload?.command || ""}"`;
  }
  if (entry.event === "test:finished") {
    const payload = entry.payload as { command?: string; success?: boolean; code?: number };
    return `Тестировщик: ${payload?.success ? "успешно завершил" : "завершил с ошибкой"} "${payload?.command || ""}" (code ${payload?.code ?? "-"})`;
  }
  if (entry.event === "tests:done") {
    return "Тестировщик завершил проверку";
  }
  if (entry.event === "tests:skipped") {
    return "Проверка тестировщиком была пропущена";
  }

  return `Событие: ${entry.event}`;
}

function avatarColor(item: any): string {
  const colors: Record<string, string> = {
    orchestrator: '#6366f1',
    pm: '#6366f1',
    analyst: '#10b981',
    researcher: '#10b981',
    developer: '#f59e0b',
    coder: '#f59e0b',
    tester: '#ef4444',
    system: '#6b7280',
    user: '#3b82f6',
  };
  const role = item.agentRole || item.role || 'system';
  return colors[role] || colors.system;
}

function agentInitial(item: any): string {
  const name = item.name || item.label || '?';
  return name.charAt(0).toUpperCase();
}

function messageName(item: any): string {
  if (item.type === 'user') return 'Вы';
  if (item.type === 'assistant' || item.type === 'run-summary') return `${item.name || 'Alex'} (${item.label || 'Оркестратор'})`;
  if (item.type === 'agent-status') return `${item.name || 'Agent'} (${item.label || item.agentRole})`;
  if (item.type === 'system') return 'Система';
  if (item.type === 'token-summary') return 'Токены';
  return 'Неизвестно';
}

function formatMessageContent(item: any): string {
  if (!item.content) return '';
  const escaped = item.content
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');
  if (item.type === 'agent-status') {
    return `<span class="agent-status-text">${escaped}</span>`;
  }
  if (item.type === 'system') {
    return `<span class="system-text">${escaped}</span>`;
  }
  if (item.type === 'run-summary') {
    return `<div class="run-summary-text">${escaped}</div>`;
  }
  return escaped;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

const activityFeed = computed(() =>
  latestRunEvents.value
    .filter((entry) =>
      [
        "agent:activity",
        "agent:retry",
        "agent:retry-success",
        "agent:note",
        "agent:done",
        "agent:skipped",
        "developer:empty-operations",
        "run:blocked",
        "file:processing",
        "file:applied",
        "file:skipped",
        "files:applied",
        "test:started",
        "test:finished",
        "tests:done",
        "tests:skipped",
      ].includes(entry.event),
    )
    .slice(-24)
    .reverse(),
);
const liveTeamMessages = computed(() =>
  latestRunEvents.value
    .filter((entry) =>
      [
        "agent:activity",
        "agent:retry",
        "agent:retry-success",
        "agent:note",
        "agent:done",
        "agent:skipped",
        "developer:empty-operations",
        "run:blocked",
        "file:processing",
        "file:applied",
        "file:skipped",
        "test:started",
        "test:finished",
        "tests:done",
        "tests:skipped",
      ].includes(entry.event),
    )
    .map((entry) => {
      const payload = eventActor(entry.payload);
      return {
        id: `live-${entry.at}-${payload.role}-${entry.event}`,
        role: "assistant",
        content: formatActivityEntry(entry),
        createdAt: entry.at,
        meta: {
          usage: {
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
            weightedTokens: 0,
            multiplier: 1,
            model: payload.role,
            role: payload.role,
            name: payload.agentName,
            label: payload.label,
          },
        },
      } as ChatMessage;
    }),
);
const displayedMessages = computed(() => {
  if (!state.runEvents.length) return state.messages;
  const merged = [...state.messages];
  const existingIds = new Set(merged.map((message) => message.id));
  for (const liveMessage of liveTeamMessages.value) {
    if (!existingIds.has(liveMessage.id)) {
      merged.push(liveMessage);
    }
  }
  return merged.sort((a, b) => new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime());
});

const unifiedChatStream = computed(() => {
  const stream: Array<{
    id: string;
    type: 'user' | 'assistant' | 'system' | 'agent-status' | 'run-summary' | 'token-summary';
    role?: string;
    name?: string;
    label?: string;
    content: string;
    createdAt: string;
    meta?: any;
    status?: 'working' | 'idle' | 'done' | 'error';
    agentRole?: string;
  }> = [];

  for (const msg of displayedMessages.value) {
    if (msg.role === 'user') {
      stream.push({
        id: msg.id,
        type: 'user',
        content: msg.content,
        createdAt: msg.createdAt,
        meta: msg.meta,
      });
    } else {
      stream.push({
        id: msg.id,
        type: 'assistant',
        role: msg.meta?.usage?.role || 'assistant',
        name: msg.meta?.usage?.name || 'Alex',
        label: msg.meta?.usage?.label || 'Оркестратор',
        content: msg.content,
        createdAt: msg.createdAt,
        meta: msg.meta,
      });
    }
  }

  if (state.runEvents.length) {
    for (const entry of state.runEvents) {
      if (entry.event === 'agent:activity' && entry.payload) {
        const payload = entry.payload as any;
        stream.push({
          id: `activity-${entry.at}-${payload.role}`,
          type: 'agent-status',
          agentRole: payload.role,
          name: payload.agentName,
          label: payload.label,
          content: payload.detail,
          createdAt: entry.at,
          status: payload.status,
        });
      } else if (entry.event === 'agent:done' && entry.payload) {
        const payload = entry.payload as any;
        stream.push({
          id: `done-${entry.at}-${payload.role}`,
          type: 'agent-status',
          agentRole: payload.role,
          name: payload.agentName,
          label: payload.label,
          content: `✓ Завершил: ${payload.detail || 'этап'}`,
          createdAt: entry.at,
          status: 'done',
        });
      } else if (entry.event === 'agent:skipped' && entry.payload) {
        const payload = entry.payload as any;
        stream.push({
          id: `skipped-${entry.at}-${payload.role}`,
          type: 'agent-status',
          agentRole: payload.role,
          name: payload.agentName,
          label: payload.label,
          content: `⊘ Пропущен: ${payload.reason || 'не требуется'}`,
          createdAt: entry.at,
          status: 'idle',
        });
      } else if (entry.event === 'run:blocked') {
        stream.push({
          id: `blocked-${entry.at}`,
          type: 'system',
          content: `⚠ Запуск остановлен: ${(entry.payload as any)?.detail}`,
          createdAt: entry.at,
        });
      } else if (entry.event === 'files:applied') {
        const payload = entry.payload as any;
        stream.push({
          id: `applied-${entry.at}`,
          type: 'system',
          content: `📝 Применено изменений: ${payload.applied?.length || 0}, пропущено: ${payload.skipped?.length || 0}`,
          createdAt: entry.at,
        });
      } else if (entry.event === 'tests:done') {
        const payload = entry.payload as any;
        const passed = payload?.filter((t: any) => t.success).length || 0;
        const failed = payload?.filter((t: any) => !t.success).length || 0;
        stream.push({
          id: `tests-${entry.at}`,
          type: 'system',
          content: `🧪 Тесты: ${passed} пройдено, ${failed} упало`,
          createdAt: entry.at,
        });
      } else if (entry.event === 'agent:note') {
        const payload = entry.payload as any;
        stream.push({
          id: `note-${entry.at}-${payload.role}`,
          type: 'agent-status',
          agentRole: payload.role,
          name: payload.agentName,
          label: payload.label,
          content: payload.detail,
          createdAt: entry.at,
          status: 'working',
        });
      } else if (entry.event === 'agent:retry') {
        const payload = entry.payload as any;
        stream.push({
          id: `retry-${entry.at}-${payload.role}`,
          type: 'agent-status',
          agentRole: payload.role,
          name: payload.agentName,
          label: payload.label,
          content: `↻ Ответ не распарсился, автоповтор ${payload.attempt || '?'}/3`,
          createdAt: entry.at,
          status: 'working',
        });
      } else if (entry.event === 'agent:retry-success') {
        const payload = entry.payload as any;
        stream.push({
          id: `retry-success-${entry.at}-${payload.role}`,
          type: 'agent-status',
          agentRole: payload.role,
          name: payload.agentName,
          label: payload.label,
          content: `✓ Прислал валидный JSON, выполнение продолжено`,
          createdAt: entry.at,
          status: 'done',
        });
      } else if (entry.event === 'developer:empty-operations') {
        const payload = entry.payload as any;
        stream.push({
          id: `empty-ops-${entry.at}-${payload.role}`,
          type: 'agent-status',
          agentRole: payload.role,
          name: payload.agentName,
          label: payload.label,
          content: `⚠ Не вернул правки, получает повторную задачу на конкретные изменения`,
          createdAt: entry.at,
          status: 'working',
        });
      } else if (entry.event === 'file:processing') {
        const payload = entry.payload as any;
        stream.push({
          id: `file-proc-${entry.at}-${payload.path}`,
          type: 'agent-status',
          agentRole: 'developer',
          name: 'Kai',
          label: 'Разработчик',
          content: `📝 ${payload.action === 'create' ? 'Создает' : 'Обновляет'} файл: ${payload.path}`,
          createdAt: entry.at,
          status: 'working',
        });
      } else if (entry.event === 'file:applied') {
        const payload = entry.payload as any;
        stream.push({
          id: `file-applied-${entry.at}-${payload.path}`,
          type: 'agent-status',
          agentRole: 'developer',
          name: 'Kai',
          label: 'Разработчик',
          content: `✓ ${payload.action === 'create' ? 'Создал' : 'Обновил'} файл: ${payload.path}`,
          createdAt: entry.at,
          status: 'done',
        });
      } else if (entry.event === 'file:skipped') {
        const payload = entry.payload as any;
        stream.push({
          id: `file-skipped-${entry.at}-${payload.path}`,
          type: 'agent-status',
          agentRole: 'developer',
          name: 'Kai',
          label: 'Разработчик',
          content: `⊘ Пропустил файл: ${payload.path} (${payload.reason})`,
          createdAt: entry.at,
          status: 'idle',
        });
      } else if (entry.event === 'test:started') {
        const payload = entry.payload as any;
        stream.push({
          id: `test-start-${entry.at}-${payload.command}`,
          type: 'agent-status',
          agentRole: 'tester',
          name: 'Nova',
          label: 'Тестировщик',
          content: `🧪 Запускает тест: ${payload.command}`,
          createdAt: entry.at,
          status: 'working',
        });
      } else if (entry.event === 'test:finished') {
        const payload = entry.payload as any;
        stream.push({
          id: `test-finish-${entry.at}-${payload.command}`,
          type: 'agent-status',
          agentRole: 'tester',
          name: 'Nova',
          label: 'Тестировщик',
          content: `${payload.success ? '✓' : '✗'} Тест ${payload.success ? 'пройден' : 'упал'}: ${payload.command} (code ${payload.code ?? '-'})`,
          createdAt: entry.at,
          status: payload.success ? 'done' : 'error',
        });
      } else if (entry.event === 'memory:loaded') {
        const payload = entry.payload as any;
        stream.push({
          id: `mem-load-${entry.at}`,
          type: 'system',
          content: `📚 Загружена память проекта: ${payload.entries} записей`,
          createdAt: entry.at,
        });
      } else if (entry.event === 'memory:saved-from-analyst-final') {
        const payload = entry.payload as any;
        stream.push({
          id: `mem-save-${entry.at}`,
          type: 'system',
          content: `💾 Аналитик сохранил в память: ${payload.entriesSaved} записей`,
          createdAt: entry.at,
        });
      } else if (entry.event === 'memory:updated') {
        stream.push({
          id: `mem-upd-${entry.at}`,
          type: 'system',
          content: `🔄 Память проекта обновлена`,
          createdAt: entry.at,
        });
      } else if (entry.event === 'run:context') {
        const payload = entry.payload as any;
        stream.push({
          id: `ctx-${entry.at}`,
          type: 'system',
          content: `📂 Контекст: ${payload.fileCount} файлов, БД: ${payload.hasDatabase ? 'да' : 'нет'}`,
          createdAt: entry.at,
        });
      }
    }
  }

  if (state.report) {
    const report = state.report as any;
    stream.push({
      id: `summary-${state.selectedRunId}`,
      type: 'run-summary',
      name: 'Alex',
      label: 'Оркестратор',
      content: report.orchestratorResponse?.message || 'Запуск завершен',
      createdAt: report.generatedAt || new Date().toISOString(),
      meta: { usageSummary: report.usageSummary },
    });

    if (report.usageSummary) {
      stream.push({
        id: `tokens-${state.selectedRunId}`,
        type: 'token-summary',
        content: '',
        createdAt: report.generatedAt || new Date().toISOString(),
        meta: { usageSummary: report.usageSummary },
      });
    }
  }

  return stream.sort((a, b) => new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime());
});

const tokenRoleStats = computed(() =>
  Object.entries(state.chatStats.byRole)
    .map(([role, usage]) => ({ role, ...usage }))
    .sort((a, b) => b.weightedTokens - a.weightedTokens),
);

const ROLE_TEMPLATES = {
  orchestrator: { name: "Alex", label: "Оркестратор", temperature: 0.2 },
  developer: { name: "Kai", label: "Разработчик", temperature: 0.15 },
  tester: { name: "Nova", label: "Тестировщик", temperature: 0.1 },
  analyst: { name: "Mira", label: "Бизнес-аналитик", temperature: 0.2 },
} as const;

function createDefaultAgents() {
  const firstModel = state.models[0]?.id || "";
  const firstMultiplier = state.models[0]?.multiplier || 1;
  return {
    orchestrator: { name: ROLE_TEMPLATES.orchestrator.name, label: ROLE_TEMPLATES.orchestrator.label, model: firstModel, multiplier: firstMultiplier, temperature: ROLE_TEMPLATES.orchestrator.temperature },
    developer: { name: ROLE_TEMPLATES.developer.name, label: ROLE_TEMPLATES.developer.label, model: firstModel, multiplier: firstMultiplier, temperature: ROLE_TEMPLATES.developer.temperature },
    tester: { name: ROLE_TEMPLATES.tester.name, label: ROLE_TEMPLATES.tester.label, model: firstModel, multiplier: firstMultiplier, temperature: ROLE_TEMPLATES.tester.temperature },
    analyst: { name: ROLE_TEMPLATES.analyst.name, label: ROLE_TEMPLATES.analyst.label, model: firstModel, multiplier: firstMultiplier, temperature: ROLE_TEMPLATES.analyst.temperature },
  };
}

function createDefaultTeamLanguage() {
  return TEAM_LANGUAGES[0].value;
}

function openTab(tab: "workspace" | "projects" | "teams" | "providers") {
  activeTab.value = tab;
  void router.push(
    tab === "workspace"
      ? "/workspace"
      : tab === "providers"
        ? "/providers"
        : tab === "teams"
          ? "/teams"
          : "/projects",
  );
}

function normalizeTeam(team: Team): Team {
  const firstModel = state.models[0]?.id || "";
  const firstMultiplier = state.models[0]?.multiplier || 1;
  const agents = team.agents || {};

  return {
    ...team,
    language: team.language || createDefaultTeamLanguage(),
    agents: {
      orchestrator: {
        name: agents.orchestrator?.name || agents.pm?.name || ROLE_TEMPLATES.orchestrator.name,
        label: agents.orchestrator?.label || agents.pm?.label || ROLE_TEMPLATES.orchestrator.label,
        model: agents.orchestrator?.model || agents.pm?.model || firstModel,
        multiplier: agents.orchestrator?.multiplier || agents.pm?.multiplier || firstMultiplier,
        temperature: agents.orchestrator?.temperature || agents.pm?.temperature || ROLE_TEMPLATES.orchestrator.temperature,
      },
      developer: {
        name: agents.developer?.name || agents.coder?.name || ROLE_TEMPLATES.developer.name,
        label: agents.developer?.label || agents.coder?.label || ROLE_TEMPLATES.developer.label,
        model: agents.developer?.model || agents.coder?.model || firstModel,
        multiplier: agents.developer?.multiplier || agents.coder?.multiplier || firstMultiplier,
        temperature: agents.developer?.temperature || agents.coder?.temperature || ROLE_TEMPLATES.developer.temperature,
      },
      tester: {
        name: agents.tester?.name || ROLE_TEMPLATES.tester.name,
        label: agents.tester?.label || ROLE_TEMPLATES.tester.label,
        model: agents.tester?.model || firstModel,
        multiplier: agents.tester?.multiplier || firstMultiplier,
        temperature: agents.tester?.temperature || ROLE_TEMPLATES.tester.temperature,
      },
      analyst: {
        name: agents.analyst?.name || agents.specWriter?.name || agents.researcher?.name || ROLE_TEMPLATES.analyst.name,
        label: agents.analyst?.label || agents.specWriter?.label || agents.researcher?.label || ROLE_TEMPLATES.analyst.label,
        model: agents.analyst?.model || agents.specWriter?.model || agents.researcher?.model || firstModel,
        multiplier: agents.analyst?.multiplier || agents.specWriter?.multiplier || agents.researcher?.multiplier || firstMultiplier,
        temperature:
          agents.analyst?.temperature ||
          agents.specWriter?.temperature ||
          agents.researcher?.temperature ||
          ROLE_TEMPLATES.analyst.temperature,
      },
    },
  };
}

async function loadInitialData() {
  const [providersResponse, teamsResponse, projectsResponse, runsResponse, modelsResponse, settingsResponse] =
    await Promise.all([api.providers(), api.teams(), api.projects(), api.runs(), api.models(), api.settings()]);

  state.providers = providersResponse.providers;
  state.models = modelsResponse.items;
  state.teams = teamsResponse.teams.map(normalizeTeam);
  state.projects = projectsResponse.projects;
  state.runs = runsResponse.runs;
  state.settings = settingsResponse;

  state.selectedProviderId = state.providers[0]?.id || "";
  state.selectedTeamId = state.teams[0]?.id || "";
  state.selectedProjectId = state.projects[0]?.id || "";

  if (state.selectedProjectId) {
    await refreshChats(state.selectedProjectId);
    await refreshTasks(state.selectedProjectId);
  }
  if (state.runs[0]) {
    await openRun(state.runs[0].id);
  }
}

async function refreshChats(projectId?: string) {
  if (!projectId) {
    state.chats = [];
    state.selectedChatId = "";
    state.messages = [];
    state.chatRuns = [];
    state.chatStats = {
      requestCount: 0,
      runCount: 0,
      totalActualTokens: 0,
      totalWeightedTokens: 0,
      byRole: {},
    };
    return;
  }

  const response = await api.chats(projectId);
  state.chats = response.chats;
  state.selectedChatId = state.chats[0]?.id || "";
  if (state.selectedChatId) {
    await openChat(state.selectedChatId);
  } else {
    state.messages = [];
    state.chatRuns = [];
    state.chatStats = {
      requestCount: 0,
      runCount: 0,
      totalActualTokens: 0,
      totalWeightedTokens: 0,
      byRole: {},
    };
  }
}

async function refreshTasks(projectId?: string) {
  if (!projectId) {
    state.tasks = [];
    state.projectMemory = [];
    state.taskComments = {};
    return;
  }

  const [response, memoryResponse] = await Promise.all([api.tasks(projectId), api.projectMemory(projectId)]);
  state.tasks = response.tasks;
  state.projectMemory = memoryResponse.entries;
  await Promise.all(state.tasks.map((task) => loadTaskComments(task.id)));
}

async function loadTaskComments(taskId: string) {
  const response = await api.taskComments(taskId);
  state.taskComments[taskId] = response.comments;
}

async function openChat(id: string) {
  state.selectedChatId = id;
  const response = await api.chatById(id);
  state.messages = response.messages;
  state.chatRuns = response.runs;
  state.chatStats = response.stats;
  await nextTick();
  scrollMessagesToBottom("auto");
}

async function openRun(id: string) {
  state.selectedRunId = id;
  const response = await api.runById(id);
  state.report = response.report;
  state.runStatus = response.run.status;
  state.runEvents = response.run.events ?? [];
  state.runError = response.run.error ?? "";
}

async function createProvider() {
  state.busy = true;
  try {
    const response = await api.saveProvider({
      name: `Provider ${state.providers.length + 1}`,
      baseUrl: "https://api.rout.my/v1",
      apiKey: "",
      modelsUrl: "https://api.rout.my/v1/models",
      isCurrent: state.providers.length === 0,
    });
    state.providers.unshift(response.provider);
    state.selectedProviderId = response.provider.id;
  } finally {
    state.busy = false;
  }
}

async function saveProvider() {
  if (!selectedProvider.value) return;
  state.busy = true;
  try {
    const response = await api.saveProvider(selectedProvider.value);
    const index = state.providers.findIndex((item) => item.id === response.provider.id);
    if (index === -1) state.providers.unshift(response.provider);
    else state.providers[index] = response.provider;
    state.selectedProviderId = response.provider.id;
    const modelsResponse = await api.models();
    state.models = modelsResponse.items;
  } finally {
    state.busy = false;
  }
}

async function createTeam() {
  state.busy = true;
  try {
    const response = await api.saveTeam({
      name: `Команда ${state.teams.length + 1}`,
      description: "Команда с дефолтными ролями",
      providerId: state.selectedProviderId || null,
      language: createDefaultTeamLanguage(),
      budget: { dailyWeightedTokens: 50000000, timezone: "Europe/Kiev" },
       workspace: {
         maxFiles: 12,
         maxCharsPerFile: 12000,
         includeExtensions: [".ts", ".tsx", ".js", ".jsx", ".json", ".md", ".css", ".html", ".py", ".php", ".vue"],
         ignoreDirs: [".git", "node_modules", "dist", "build"],
       },
      run: { maxReviewRounds: 1, applyChanges: true },
      testing: { commands: [] },
      agents: createDefaultAgents(),
    });
    const normalized = normalizeTeam(response.team);
    state.teams.unshift(normalized);
    state.selectedTeamId = normalized.id;
  } finally {
    state.busy = false;
  }
}

async function saveTeam() {
  if (!selectedTeam.value) return;
  state.busy = true;
  try {
    const response = await api.saveTeam(selectedTeam.value);
    const index = state.teams.findIndex((item) => item.id === response.team.id);
    const normalized = normalizeTeam(response.team);
    if (index === -1) state.teams.unshift(normalized);
    else state.teams[index] = normalized;
    state.selectedTeamId = normalized.id;
  } finally {
    state.busy = false;
  }
}

async function createProject() {
  state.busy = true;
  try {
    const root = state.settings?.env.LOCAL_PROJECTS_ROOT || "/Users/evgenii";
    const response = await api.saveProject({
      name: `Проект ${state.projects.length + 1}`,
      description: "",
      localPath: root,
      teamId: state.selectedTeamId || null,
    });
    state.projects.unshift(response.project);
    state.selectedProjectId = response.project.id;
    await refreshChats(response.project.id);
  } finally {
    state.busy = false;
  }
}

async function saveProject() {
  if (!selectedProject.value) return;
  state.busy = true;
  try {
    const response = await api.saveProject(selectedProject.value);
    const index = state.projects.findIndex((item) => item.id === response.project.id);
    if (index === -1) state.projects.unshift(response.project);
    else state.projects[index] = response.project;
    state.selectedProjectId = response.project.id;
  } finally {
    state.busy = false;
  }
}

async function createChat() {
  if (!selectedProject.value || !(selectedProject.value.teamId || state.selectedTeamId)) return;
  state.busy = true;
  try {
    const response = await api.saveChat({
      projectId: selectedProject.value.id,
      teamId: selectedProject.value.teamId || state.selectedTeamId,
      title: `Чат ${state.chats.length + 1}`,
      summary: "",
    });
    state.chats.unshift(response.chat);
    state.selectedChatId = response.chat.id;
    await openChat(response.chat.id);
  } finally {
    state.busy = false;
  }
}

async function deleteChat(chatId: string) {
  const chatIndex = state.chats.findIndex((item) => item.id === chatId);
  if (chatIndex === -1) return;

  state.busy = true;
  try {
    await api.deleteChat(chatId);
    const remainingChats = state.chats.filter((item) => item.id !== chatId);
    state.chats = remainingChats;

    if (state.selectedChatId === chatId) {
      const fallbackChat = remainingChats[Math.max(0, chatIndex - 1)] || remainingChats[0] || null;
      state.selectedChatId = fallbackChat?.id || "";
      if (fallbackChat) {
        await openChat(fallbackChat.id);
      } else {
        state.messages = [];
      }
    }
  } finally {
    state.busy = false;
  }
}

async function createTask(status: "backlog" | "in_progress" | "done" = "backlog") {
  if (!selectedProject.value) return;
  const draft = taskDrafts[status];
  state.busy = true;
  try {
    const response = await api.saveTask({
      projectId: selectedProject.value.id,
      title: draft.title.trim() || `Задача ${state.tasks.length + 1}`,
      description: draft.description.trim(),
      status,
    });
    state.tasks.unshift(response.task);
    draft.title = "";
    draft.description = "";
  } finally {
    state.busy = false;
  }
}

async function saveTask(task: TaskItem) {
  state.busy = true;
  try {
    const response = await api.saveTask(task);
    const index = state.tasks.findIndex((item) => item.id === response.task.id);
    if (index === -1) state.tasks.unshift(response.task);
    else state.tasks[index] = response.task;
    await loadTaskComments(response.task.id);
  } finally {
    state.busy = false;
  }
}

async function removeTask(taskId: string) {
  state.busy = true;
  try {
    await api.deleteTask(taskId);
    state.tasks = state.tasks.filter((item) => item.id !== taskId);
  } finally {
    state.busy = false;
  }
}

async function moveTask(task: TaskItem, direction: "left" | "right") {
  const order: TaskItem["status"][] = ["backlog", "in_progress", "done"];
  const currentIndex = order.indexOf(task.status);
  const nextIndex = direction === "left" ? currentIndex - 1 : currentIndex + 1;
  const nextStatus = order[nextIndex];
  if (!nextStatus) return;
  state.busy = true;
  try {
    const response = await api.updateTaskStatus(task.id, {
      status: nextStatus,
      author: selectedProjectTeam.value?.agents?.orchestrator?.name || "Alex",
      comment: `${selectedProjectTeam.value?.agents?.orchestrator?.name || "Alex"} перевел задачу в ${nextStatus}`,
    });
    const index = state.tasks.findIndex((item) => item.id === response.task.id);
    if (index === -1) state.tasks.unshift(response.task);
    else state.tasks[index] = response.task;
    await loadTaskComments(task.id);
  } finally {
    state.busy = false;
  }
}

async function addTaskComment(taskId: string) {
  const draft = (state.taskCommentDrafts[taskId] || "").trim();
  if (!draft) return;
  state.busy = true;
  try {
    await api.addTaskResultComment(taskId, {
      content: draft,
      author: selectedProjectTeam.value?.agents?.orchestrator?.name || "Alex",
    });
    state.taskCommentDrafts[taskId] = "";
    await loadTaskComments(taskId);
  } finally {
    state.busy = false;
  }
}

async function sendChatMessage() {
  if (!selectedChat.value || !chatDraft.value.trim()) return;
  const draft = chatDraft.value.trim();
  state.busy = true;
  chatDraft.value = "";
  try {
    await saveProject();
    const response = await api.sendChatMessage(selectedChat.value.id, draft);
    await openChat(selectedChat.value.id);
    if (selectedProject.value) {
      await refreshTasks(selectedProject.value.id);
    }
    if (response.createdTasks.length) {
      state.runStatus = `orchestrator_created_${response.createdTasks.length}_tasks`;
    }
    if (response.autoRunId) {
      state.selectedRunId = response.autoRunId;
      state.runStatus = "queued";
      state.runEvents = [];
      state.runError = "";
      state.report = null;
      startPolling(response.autoRunId);
    }
  } catch (error) {
    chatDraft.value = draft;
    throw error;
  } finally {
    state.busy = false;
  }
}

function applyModel(role: string, modelId: string) {
  if (!selectedTeam.value) return;
  const model = state.models.find((item) => item.id === modelId);
  if (!model) return;
  selectedTeam.value.agents[role].model = model.id;
  selectedTeam.value.agents[role].multiplier = model.multiplier;
}

async function runTask() {
  if (!selectedChat.value || !chatDraft.value.trim()) return;
  state.busy = true;
  try {
    await saveProject();
    await saveTeam();
    const response = await api.startRun({
      chatId: selectedChat.value.id,
      task: chatDraft.value,
    });
    state.selectedRunId = response.runId;
    state.runStatus = "queued";
    state.runEvents = [];
    state.runError = "";
    state.report = null;
    startPolling(response.runId);
  } finally {
    state.busy = false;
  }
}

function startPolling(runId: string) {
  if (pollTimer) window.clearInterval(pollTimer);
  const tick = async () => {
    const response = await api.job(runId);
    state.runStatus = response.status;
    state.runEvents = response.events ?? [];
    state.runError = response.error ?? "";
    const runsResponse = await api.runs();
    state.runs = runsResponse.runs;
    await nextTick();
    scrollMessagesToBottom("smooth");
    if (response.status === "done" || response.status === "failed") {
      if (pollTimer) window.clearInterval(pollTimer);
      await openRun(runId);
      if (state.selectedChatId) await openChat(state.selectedChatId);
    }
  };
  void tick();
  pollTimer = window.setInterval(() => void tick(), 2000);
}

function scrollMessagesToBottom(behavior: ScrollBehavior = "smooth") {
  const container = messagesListRef.value;
  if (!container) return;
  container.scrollTo({
    top: container.scrollHeight,
    behavior,
  });
}

async function pickProjectFolder() {
  if (!selectedProject.value) return;

  if (!folderPickerSupported) {
    window.alert("Браузер не дает получить абсолютный путь к системной папке. Вставь локальный путь вручную в поле 'Локальная папка'.");
    return;
  }

  try {
    const handle = await (window as any).showDirectoryPicker();
    const root = state.settings?.env.LOCAL_PROJECTS_ROOT || "";
    if (root) {
      selectedProject.value.localPath = `${root}/${handle.name}`;
    }
  } catch {
    // user cancelled
  }
}

function reportText() {
  if (!state.report) return "Пока нет отчета.";
  const report = state.report as any;
  return [
    `Task: ${report.task}`,
    `Project: ${report.projectPath}`,
    `Reviewer approved: ${report.approvals?.reviewerApproved ? "yes" : "no"}`,
    `Tester status: ${report.approvals?.testerStatus ?? "-"}`,
    "",
    report.spec?.summary ? `Spec: ${report.spec.summary}` : "",
    report.reviewer?.summary ? `Review: ${report.reviewer.summary}` : "",
    report.tester?.summary ? `Test: ${report.tester.summary}` : "",
    report.usageSummary
      ? `Tokens: actual ${report.usageSummary.totalActualTokens}, weighted ${report.usageSummary.totalWeightedTokens}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

watch(
  () => state.selectedProjectId,
  async (value) => {
    await refreshChats(value);
    await refreshTasks(value);
    const project = state.projects.find((item) => item.id === value);
    if (project?.teamId) {
      state.selectedTeamId = project.teamId;
    }
  },
);

watch(
  () => displayedMessages.value.length,
  async (currentLength, previousLength) => {
    if (currentLength === previousLength) return;
    await nextTick();
    scrollMessagesToBottom(previousLength === 0 ? "auto" : "smooth");
  },
);

watch(
  () => route.path,
  (path) => {
    activeTab.value = routeToTab(path);
  },
  { immediate: true },
);

onMounted(() => {
  void loadInitialData();
});

onBeforeUnmount(() => {
  if (pollTimer) window.clearInterval(pollTimer);
});
</script>

<template>
  <div class="app-shell dark-shell">
    <aside class="sidebar">
      <div class="brand">
        <div class="brand-mark">AT</div>
        <div>
          <h1>AI Agent Team</h1>
          <p>Провайдеры, команды, проекты и рабочие чаты в одном месте.</p>
        </div>
      </div>

      <nav class="nav-stack">
        <button class="nav-button" :class="{ active: activeTab === 'workspace' }" @click="openTab('workspace')">
          <strong>Работа</strong>
          <span>Команда проекта, чат и запуск</span>
        </button>
        <button class="nav-button" :class="{ active: activeTab === 'providers' }" @click="openTab('providers')">
          <strong>Провайдеры</strong>
          <span>CRUD и текущий API provider</span>
        </button>
        <button class="nav-button" :class="{ active: activeTab === 'teams' }" @click="openTab('teams')">
          <strong>Команды</strong>
          <span>CRUD, роли и модели агентов</span>
        </button>
        <button class="nav-button" :class="{ active: activeTab === 'projects' }" @click="openTab('projects')">
          <strong>Проекты</strong>
          <span>CRUD локальных проектов</span>
        </button>
      </nav>

      <section v-if="activeTab === 'projects'" class="sidebar-section">
        <div class="section-heading list-header">
          <h2>Проекты</h2>
          <button class="primary-button mini" :disabled="state.busy" @click="createProject">Новый</button>
        </div>
        <button
          v-for="project in state.projects"
          :key="project.id"
          class="team-item"
          :class="{ active: project.id === state.selectedProjectId }"
          @click="state.selectedProjectId = project.id"
        >
          <strong>{{ project.name }}</strong>
          <p>{{ project.localPath }}</p>
        </button>
        <div v-if="!state.projects.length" class="empty-block">
          Создай проект, выбери папку и закрепи за ним команду.
        </div>
      </section>

      <section v-if="activeTab === 'teams'" class="sidebar-section">
        <div class="section-heading list-header">
          <h2>Команды</h2>
          <button class="primary-button mini" :disabled="state.busy" @click="createTeam">Новая</button>
        </div>
        <button
          v-for="team in state.teams"
          :key="team.id"
          class="team-item"
          :class="{ active: team.id === state.selectedTeamId }"
          @click="state.selectedTeamId = team.id"
        >
          <strong>{{ team.name }}</strong>
          <p>{{ team.description }}</p>
        </button>
        <div v-if="!state.teams.length" class="empty-block">
          Создай первую команду и назначь модели по ролям.
        </div>
      </section>

      <section v-if="activeTab === 'providers'" class="sidebar-section">
        <div class="section-heading list-header">
          <h2>Провайдеры</h2>
          <button class="primary-button mini" :disabled="state.busy" @click="createProvider">Новый</button>
        </div>
        <button
          v-for="provider in state.providers"
          :key="provider.id"
          class="team-item"
          :class="{ active: provider.id === state.selectedProviderId }"
          @click="state.selectedProviderId = provider.id"
        >
          <strong>{{ provider.name }}</strong>
          <p>{{ provider.baseUrl }}<span v-if="provider.isCurrent"> · current</span></p>
        </button>
        <div v-if="!state.providers.length" class="empty-block">
          Добавь провайдера, чтобы подтягивать модели и запускать агентов.
        </div>
      </section>

      <section v-if="activeTab === 'workspace'" class="sidebar-section">
        <div class="section-heading list-header">
          <h2>Чаты проекта</h2>
          <button class="primary-button mini" :disabled="!selectedProject || !(selectedProject?.teamId || selectedTeam) || state.busy" @click="createChat">Новый</button>
        </div>
        <div
          v-for="chat in state.chats"
          :key="chat.id"
          class="chat-list-item"
          :class="{ active: chat.id === state.selectedChatId }"
        >
          <button
            class="run-item chat-select-button"
            :class="{ active: chat.id === state.selectedChatId }"
            @click="openChat(chat.id)"
          >
            <strong>{{ chat.title }}</strong>
            <p>{{ chat.summary || "Без summary" }}</p>
          </button>
          <button class="ghost-button mini danger-button chat-delete-button" :disabled="state.busy" @click="deleteChat(chat.id)">
            ×
          </button>
        </div>
        <div v-if="!state.chats.length" class="empty-block">
          У проекта еще нет чатов. Создай чат и отправь первую задачу команде.
        </div>
      </section>
    </aside>

    <main class="main-panel">
      <header class="topbar">
        <div>
          <p class="eyebrow">Рабочая зона · {{ activeTabLabel }}</p>
          <h2>{{ selectedChat?.title || selectedProject?.name || selectedTeam?.name || selectedProvider?.name || "AI Agent Team" }}</h2>
          <p class="topbar-copy">
            {{
              activeTab === "providers"
                ? "Настрой базовый URL, ключ и каталог моделей."
                : activeTab === "teams"
                  ? "Собери команду агентов и распредели роли."
                  : activeTab === "projects"
                    ? "Создай проект и закрепи локальную папку."
                    : "Выбери проект, назначь команду и работай через чат с оркестратором."
            }}
          </p>
        </div>
        <div class="settings-banner">
          <div><span>Local root</span> <strong>{{ state.settings?.env.LOCAL_PROJECTS_ROOT || "-" }}</strong></div>
          <div><span>Container root</span> <strong>{{ state.settings?.env.CONTAINER_PROJECTS_ROOT || "-" }}</strong></div>
        </div>
      </header>

      <section class="context-grid">
        <article class="context-card">
          <span class="context-kicker">Current provider</span>
          <strong>{{ selectedProjectTeam?.providerId ? (state.providers.find((item) => item.id === selectedProjectTeam?.providerId)?.name || selectedProvider?.name || "Не выбран") : (selectedProvider?.name || "Не выбран") }}</strong>
          <p>{{ selectedProjectTeam?.providerId ? (state.providers.find((item) => item.id === selectedProjectTeam?.providerId)?.baseUrl || "Не найден") : (selectedProvider?.baseUrl || "Добавь или выбери провайдера") }}</p>
        </article>
        <article class="context-card">
          <span class="context-kicker">Работа с проектом</span>
          <strong>{{ selectedProject?.name || "Не выбран" }}</strong>
          <p>{{ selectedProjectTeam?.name || "Назначь команду для проекта" }}</p>
        </article>
        <article class="context-card">
          <span class="context-kicker">Папка проекта</span>
          <strong>{{ selectedProject?.localPath || "Не привязана" }}</strong>
          <p>{{ selectedProject?.containerPath || "Контейнерный путь еще не определен" }}</p>
        </article>
        <article class="context-card">
          <span class="context-kicker">Токены чата</span>
          <strong>{{ state.chatStats.totalWeightedTokens.toLocaleString() }} weighted</strong>
          <p>{{ state.chatStats.totalActualTokens.toLocaleString() }} actual · {{ state.chatStats.requestCount }} запросов · {{ state.chatStats.runCount }} запусков</p>
        </article>
      </section>

      <section v-if="activeTab === 'workspace'" class="workspace-layout">
        <div class="workspace-sidebar panel panel-stack">
          <div class="section-heading">
            <div>
              <h3>Работа с проектом</h3>
              <p>Выбери проект, назначь команду и открой рабочий чат с оркестратором.</p>
            </div>
          </div>
          <label class="full-block">
            <span>Проект</span>
            <select v-model="state.selectedProjectId">
              <option v-for="project in state.projects" :key="project.id" :value="project.id">
                {{ project.name }}
              </option>
            </select>
          </label>
          <label v-if="selectedProject" class="full-block">
            <span>Команда проекта</span>
            <select v-model="selectedProject.teamId">
              <option v-for="team in state.teams" :key="team.id" :value="team.id">
                {{ team.name }}
              </option>
            </select>
          </label>
          <div class="inline-actions">
            <button class="primary-button" :disabled="state.busy || !selectedProject" @click="saveProject">Сохранить выбор команды</button>
            <button class="ghost-button" :disabled="!selectedProject || state.busy" @click="createChat">Новый чат</button>
          </div>
          <div class="info-stack workspace-meta">
            <div class="report-view small">
              Оркестратор: {{ selectedProjectTeam?.agents?.orchestrator?.name || selectedProjectTeam?.agents?.orchestrator?.label || "Не настроен" }}
            </div>
            <div class="report-view small">
              Команда: {{ selectedProjectTeam?.name || "-" }}
            </div>
            <div class="report-view small">
              Папка проекта: {{ selectedProject?.localPath || "-" }}
            </div>
          </div>
        </div>

        <div class="workspace-chat panel panel-stack">
          <div class="chat-header">
            <div class="chat-header-left">
              <h3>{{ selectedChat?.title || "Новый чат" }}</h3>
              <span v-if="state.runStatus" class="run-status-badge" :class="state.runStatus">{{ state.runStatus }}</span>
            </div>
            <div class="chat-header-right">
              <div class="chat-stats-mini">
                <span class="stat" title="Actual tokens">{{ state.chatStats.totalActualTokens.toLocaleString() }} act</span>
                <span class="stat" title="Weighted tokens">{{ state.chatStats.totalWeightedTokens.toLocaleString() }} wgt</span>
                <span class="stat" title="Runs">{{ state.chatStats.runCount }} runs</span>
              </div>
              <button class="ghost-button mini danger-button" :disabled="state.busy || !selectedChat" @click="selectedChat && deleteChat(selectedChat.id)" title="Удалить чат">
                ×
              </button>
            </div>
          </div>

          <div ref="messagesListRef" class="chat-messages">
            <div v-if="unifiedChatStream.length === 0" class="chat-empty">
              <svg class="empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
              </svg>
              <p>Выбери проект, создай чат и отправь первую задачу оркестратору.</p>
            </div>

            <div v-else class="message-stream">
              <div 
                v-for="item in unifiedChatStream" 
                :key="item.id" 
                class="message-row"
                :class="[item.type, item.status]"
              >
                <div class="message-avatar" :style="{ backgroundColor: avatarColor(item) }">
                  <span v-if="item.type === 'user'">👤</span>
                  <span v-else-if="item.type === 'assistant' || item.type === 'run-summary'">{{ agentInitial(item) }}</span>
                  <span v-else-if="item.type === 'agent-status'">{{ agentInitial(item) }}</span>
                  <span v-else-if="item.type === 'system'">⚙</span>
                  <span v-else-if="item.type === 'token-summary'">📊</span>
                </div>
                <div class="message-bubble">
                    <div class="message-header">
                      <span class="message-name">{{ messageName(item) }}</span>
                      <span class="message-time">{{ formatTime(item.createdAt) }}</span>
                      <span v-if="item.status === 'working'" class="status-indicator working" title="Работает...">●</span>
                      <span v-else-if="item.status === 'done'" class="status-indicator done" title="Завершено">✓</span>
                      <span v-else-if="item.status === 'idle'" class="status-indicator idle" title="Пропущен">⊘</span>
                      <span v-else-if="item.status === 'error'" class="status-indicator error" title="Ошибка">✗</span>
                    </div>
                  <div class="message-content" v-html="formatMessageContent(item)"></div>
                  <div v-if="item.meta?.usage" class="message-usage">
                    <span>{{ item.meta.usage.totalTokens.toLocaleString() }} actual</span>
                    <span>·</span>
                    <span>{{ item.meta.usage.weightedTokens.toLocaleString() }} weighted</span>
                    <span>·</span>
                    <span>{{ item.meta.usage.model }}</span>
                    <span v-if="item.meta.usage.multiplier">(×{{ item.meta.usage.multiplier }})</span>
                  </div>
                  <div v-if="item.type === 'token-summary' && item.meta?.usageSummary" class="token-summary-detail">
                    <div class="token-total">
                      <span>Всего: {{ item.meta.usageSummary.totalActualTokens.toLocaleString() }} actual</span>
                      <span>·</span>
                      <span>{{ item.meta.usageSummary.totalWeightedTokens.toLocaleString() }} weighted</span>
                    </div>
                    <div class="token-by-role">
                      <div v-for="(usage, role) in item.meta.usageSummary.byAgent" :key="role" class="token-role-row">
                        <span class="role-name">{{ role }}</span>
                        <span>{{ usage.actualTokens.toLocaleString() }} act</span>
                        <span>{{ usage.weightedTokens.toLocaleString() }} wgt</span>
                        <span>(×{{ usage.multiplier }})</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div v-if="state.busy && state.runEvents.length" class="typing-indicator">
              <span class="dot"></span>
              <span class="dot"></span>
              <span class="dot"></span>
              <span>Агенты работают...</span>
            </div>
          </div>

          <div class="chat-composer">
            <div class="composer-input-wrapper">
              <textarea 
                v-model="chatDraft" 
                rows="3" 
                placeholder="Например: кто в команде, что сейчас в работе, добавь задачу на экспорт CSV"
                @keydown.enter.exact.shift="sendChatMessage"
                @keydown.enter.prevent="runTask"
              ></textarea>
              <div class="composer-hint">Enter — отправить сообщение, Shift+Enter — запустить выполнение</div>
            </div>
            <div class="composer-actions">
              <button class="primary-button" :disabled="state.busy || !selectedChat || !chatDraft.trim()" @click="sendChatMessage">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M22 2L11 13"></path>
                  <path d="M22 2L15 22L11 13L2 9L22 2Z"></path>
                </svg>
                Отправить
              </button>
              <button class="secondary-button" :disabled="state.busy || !selectedChat || !chatDraft.trim()" @click="runTask">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polygon points="5 3 19 12 5 21 5 3"></polygon>
                </svg>
                Запуск
              </button>
            </div>
          </div>
        </div>

        <div class="workspace-board panel panel-stack">
          <div class="section-heading">
            <div>
              <h3>Доска задач</h3>
              <p>Нормальный kanban-поток проекта: добавляй сколько угодно карточек, двигай их по статусам и редактируй прямо на доске.</p>
            </div>
            <div class="pill">{{ state.tasks.length }} задач</div>
          </div>
          <div class="tasks-board">
            <section
              v-for="column in TASK_COLUMNS"
              :key="column.status"
              class="task-column"
              :data-status="column.status"
            >
              <div class="task-column-header">
                <div>
                  <h4>{{ column.title }}</h4>
                  <p>{{ column.hint }}</p>
                </div>
                <span>{{ tasksByColumn[column.status].length }}</span>
              </div>

              <div class="task-composer-card">
                <input
                  v-model="taskDrafts[column.status].title"
                  type="text"
                  :placeholder="`Новая задача в ${column.title}`"
                  @keydown.enter.prevent="createTask(column.status)"
                />
                <textarea
                  v-model="taskDrafts[column.status].description"
                  rows="3"
                  placeholder="Описание, критерии, детали"
                />
                <button class="primary-button" :disabled="!selectedProject || state.busy" @click="createTask(column.status)">
                  Добавить карточку
                </button>
              </div>

              <div class="task-column-list">
                <article v-for="taskItem in tasksByColumn[column.status]" :key="taskItem.id" class="task-card">
                  <div class="task-card-head">
                    <input v-model="taskItem.title" type="text" @change="saveTask(taskItem)" />
                    <button class="ghost-button mini danger-button" :disabled="state.busy" @click="removeTask(taskItem.id)">
                      Удалить
                    </button>
                  </div>
                  <textarea
                    v-model="taskItem.description"
                    rows="4"
                    placeholder="Добавь описание задачи"
                    @change="saveTask(taskItem)"
                  />
                  <div class="task-card-footer">
                    <select v-model="taskItem.status" @change="saveTask(taskItem)">
                      <option value="backlog">backlog</option>
                      <option value="in_progress">in progress</option>
                      <option value="done">done</option>
                    </select>
                    <div class="task-card-actions">
                      <button
                        class="ghost-button mini"
                        :disabled="state.busy || taskItem.status === 'backlog'"
                        @click="moveTask(taskItem, 'left')"
                      >
                        ←
                      </button>
                      <button
                        class="ghost-button mini"
                        :disabled="state.busy || taskItem.status === 'done'"
                        @click="moveTask(taskItem, 'right')"
                      >
                        →
                      </button>
                    </div>
                  </div>
                  <div class="task-comments-block">
                    <strong>Комментарии оркестратора</strong>
                    <div v-if="state.taskComments[taskItem.id]?.length" class="task-comments-list">
                      <article v-for="comment in state.taskComments[taskItem.id]" :key="comment.id" class="task-comment-item">
                        <div class="task-comment-head">
                          <span>{{ comment.author || "system" }}</span>
                          <small>{{ comment.type }}</small>
                        </div>
                        <p>{{ comment.content }}</p>
                      </article>
                    </div>
                    <div v-else class="empty-block">Комментариев пока нет.</div>
                    <textarea
                      v-model="state.taskCommentDrafts[taskItem.id]"
                      rows="3"
                      placeholder="Оркестратор фиксирует промежуточный результат, причину смены статуса или итог"
                    />
                    <button class="ghost-button" :disabled="state.busy" @click="addTaskComment(taskItem.id)">
                      Добавить комментарий
                    </button>
                  </div>
                </article>
              </div>
            </section>
          </div>
        </div>
      </section>

      <section v-if="activeTab === 'providers' && selectedProvider" class="panel-grid">
        <div class="panel span-2 panel-stack">
          <div class="section-heading">
            <div>
              <h3>Провайдер</h3>
              <p>Здесь живет весь реальный рантайм-конфиг подключения.</p>
            </div>
            <button class="primary-button" :disabled="state.busy" @click="saveProvider">Сохранить</button>
          </div>
          <div class="form-grid">
            <label>
              <span>Имя</span>
              <input v-model="selectedProvider.name" type="text" />
            </label>
            <label>
              <span>Base URL</span>
              <input v-model="selectedProvider.baseUrl" type="text" />
            </label>
            <label class="span-all">
              <span>API Key</span>
              <input
                v-model="selectedProvider.apiKey"
                type="password"
                :placeholder="selectedProvider.hasApiKey ? selectedProvider.apiKeyMasked || 'Ключ rout.my уже сохранен' : 'Вставь API ключ rout.my'"
              />
            </label>
            <label class="span-all">
              <span>Models URL</span>
              <input v-model="selectedProvider.modelsUrl" type="text" />
            </label>
            <div class="report-view small span-all">
              Для rout.my используй `Base URL = https://api.rout.my/v1`, `Models URL = https://api.rout.my/v1/models` и API key от rout.my.
            </div>
            <label class="checkbox-row span-all">
              <input v-model="selectedProvider.isCurrent" type="checkbox" />
              <span>Current provider</span>
            </label>
          </div>
        </div>
        <div class="panel panel-stack">
          <div class="section-heading">
            <h3>Что важно</h3>
          </div>
          <div class="info-stack">
            <div class="report-view small">
              Провайдер используется командой через `providerId`, поэтому после смены провайдера лучше сохранить и саму команду.
            </div>
            <div class="report-view small">
              Если ключ уже сохранен, поле API key можно не трогать: старое значение сохранится.
            </div>
            <div class="report-view small">
              Список моделей подтягивается из `Models URL`, а не из захардкоженного списка, если эндпоинт доступен.
            </div>
          </div>
        </div>
      </section>

      <section v-else-if="activeTab === 'teams' && selectedTeam" class="panel-grid">
        <div class="panel panel-stack">
          <div class="section-heading">
            <div>
              <h3>Команда</h3>
              <p>Базовая конфигурация, которую потом используют проекты и чаты.</p>
            </div>
            <button class="primary-button" :disabled="state.busy" @click="saveTeam">Сохранить</button>
          </div>
          <label class="full-block">
            <span>Название</span>
            <input v-model="selectedTeam.name" type="text" />
          </label>
          <label class="full-block">
            <span>Описание</span>
            <textarea v-model="selectedTeam.description" rows="4" />
          </label>
          <label class="full-block">
            <span>Провайдер</span>
            <select v-model="selectedTeam.providerId">
              <option v-for="provider in state.providers" :key="provider.id" :value="provider.id">
                {{ provider.name }}
              </option>
            </select>
          </label>
          <label class="full-block">
            <span>Язык ответов команды</span>
            <select v-model="selectedTeam.language">
              <option v-for="language in TEAM_LANGUAGES" :key="language.value" :value="language.value">
                {{ language.label }}
              </option>
            </select>
          </label>
        </div>

        <div class="panel">
          <div class="section-heading">
            <h3>Контекст</h3>
          </div>
          <div class="info-stack">
            <div class="report-view small">Лимит файлов: {{ selectedTeam.workspace.maxFiles }}</div>
            <div class="report-view small">Символов на файл: {{ selectedTeam.workspace.maxCharsPerFile }}</div>
            <div class="report-view small">Review rounds: {{ selectedTeam.run.maxReviewRounds }}</div>
            <div class="report-view small">Язык команды: {{ TEAM_LANGUAGES.find((item) => item.value === selectedTeam.language)?.label || selectedTeam.language }}</div>
            <div class="report-view small">
              Дневной weighted budget: {{ selectedTeam.budget.dailyWeightedTokens.toLocaleString() }}
            </div>
          </div>
        </div>

        <div class="panel span-3">
          <div class="section-heading">
            <div>
              <h3>Роли команды</h3>
              <p>Каждая роль выбирает модель и свой множитель токенов.</p>
            </div>
            <p>Дефолтные: оркестратор, разработчик, тестировщик, бизнес-аналитик.</p>
          </div>
          <div class="agents-grid">
            <article v-for="(agent, role) in selectedTeam.agents" :key="role" class="agent-card">
              <header>
                <h4>{{ agent.name || agent.label }}</h4>
                <div class="agent-meta">{{ role }}</div>
              </header>
              <label>
                <span>Имя агента</span>
                <input v-model="agent.name" type="text" :placeholder="ROLE_TEMPLATES[String(role) as keyof typeof ROLE_TEMPLATES]?.name || 'Имя агента'" />
              </label>
              <label>
                <span>Название</span>
                <input v-model="agent.label" type="text" />
              </label>
              <label>
                <span>Модель</span>
                <select :value="agent.model" @change="applyModel(String(role), ($event.target as HTMLSelectElement).value)">
                  <optgroup v-for="(items, provider) in modelGroups" :key="provider" :label="provider">
                    <option v-for="model in items" :key="model.id" :value="model.id">
                      {{ model.label }} ({{ model.multiplier }}x)
                    </option>
                  </optgroup>
                </select>
              </label>
              <label>
                <span>Множитель</span>
                <input v-model.number="agent.multiplier" type="number" step="0.1" />
              </label>
              <label>
                <span>Temperature</span>
                <input v-model.number="agent.temperature" type="number" step="0.05" />
              </label>
            </article>
          </div>
        </div>
      </section>

      <section v-else-if="activeTab === 'projects'" class="panel-grid">
        <div class="panel panel-stack span-2">
          <div class="section-heading">
            <div>
              <h3>Проект</h3>
              <p>Название, локальная папка и команда, которая отвечает за этот проект.</p>
            </div>
            <div class="inline-actions">
              <button class="primary-button" :disabled="state.busy || !selectedProject" @click="saveProject">Сохранить</button>
              <button class="ghost-button" :disabled="!selectedProject" @click="pickProjectFolder">
                Выбрать папку
              </button>
            </div>
          </div>
          <template v-if="selectedProject">
            <label class="full-block">
              <span>Имя</span>
              <input v-model="selectedProject.name" type="text" />
            </label>
            <label class="full-block">
              <span>Локальная папка</span>
              <input v-model="selectedProject.localPath" type="text" />
            </label>
            <label class="full-block">
              <span>Описание</span>
              <textarea v-model="selectedProject.description" rows="4" />
            </label>
            <label class="full-block">
              <span>Команда проекта</span>
              <select v-model="selectedProject.teamId">
                <option v-for="team in state.teams" :key="team.id" :value="team.id">
                  {{ team.name }}
                </option>
              </select>
            </label>
            <div class="report-view small">В контейнере: {{ selectedProject.containerPath }}</div>
            <div v-if="!folderPickerSupported" class="report-view small">
              В вебе системную папку надежно выбрать нельзя, поэтому здесь нужен абсолютный путь, вставленный вручную.
            </div>
          </template>
          <div v-else class="empty-block">
            Сначала создай проект, чтобы закрепить за ним локальную папку и команду.
          </div>
        </div>

        <div class="panel panel-stack">
          <div class="section-heading">
            <div>
              <h3>Запуск</h3>
              <p>Постановка задачи оркестратору и статус текущего прогона.</p>
            </div>
          </div>
          <label class="full-block">
            <span>Задача</span>
            <textarea v-model="chatDraft" rows="8" placeholder="Опиши задачу для команды" />
          </label>
          <button class="primary-button full-width" :disabled="state.busy || !selectedChat || !chatDraft.trim()" @click="runTask">
            Запустить
          </button>
          <div class="status-card" :class="{ hidden: !state.runStatus }">
            <strong>Статус: {{ state.runStatus || "-" }}</strong>
            <p v-if="state.runError">{{ state.runError }}</p>
            <pre>{{ state.runEvents.map((item) => `• ${item.event}`).join("\n") }}</pre>
          </div>
        </div>

        <div class="panel span-3 panel-stack">
          <div class="section-heading">
            <div>
              <h3>Чат команды</h3>
              <p>История постановок задач, ошибок и итоговых ответов команды.</p>
            </div>
            <span class="pill">{{ selectedProjectTeam?.name || selectedTeam?.name || "Без команды" }}</span>
          </div>
          <div class="messages-list">
            <article v-for="message in state.messages" :key="message.id" class="message-card" :class="message.role">
              <strong>{{ message.role }}</strong>
              <pre>{{ message.content }}</pre>
            </article>
          </div>
          <div v-if="!state.messages.length" class="empty-block">
            В этом чате пока пусто. Создай чат слева и отправь первую задачу.
          </div>
        </div>

        <div class="panel span-3 panel-stack">
          <div class="section-heading">
            <div>
              <h3>Отчет запуска</h3>
              <p>Итог, ревью, тесты и расход токенов по команде.</p>
            </div>
          </div>
          <div class="report-view">{{ reportText() }}</div>
        </div>

        <div class="panel span-3 panel-stack">
          <div class="section-heading">
            <div>
              <h3>Память проекта</h3>
              <p>Накопленный контекст по фичам, исследованиям и прошлым решениям команды.</p>
            </div>
            <span class="pill">{{ state.projectMemory.length }} записей</span>
          </div>
          <div v-if="state.projectMemory.length" class="token-role-list">
            <article v-for="entry in state.projectMemory" :key="entry.id" class="token-role-card">
              <strong>{{ entry.title }}</strong>
              <span>{{ entry.kind }}</span>
              <p>{{ entry.summary }}</p>
              <small v-if="entry.relatedFiles?.length">Файлы: {{ entry.relatedFiles.join(", ") }}</small>
            </article>
          </div>
          <div v-else class="empty-block">
            Память проекта пока пуста. После исследований и завершенных задач команда начнет автоматически ее пополнять.
          </div>
        </div>
      </section>
    </main>
  </div>
</template>
