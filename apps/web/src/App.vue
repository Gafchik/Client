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
          <div class="workspace-chat-header">
            <div>
              <h3>Чат с оркестратором</h3>
              <p>Большой рабочий чат. Здесь можно обсуждать проект, ставить задачи и просить оркестратора создать новые задачи.</p>
            </div>
            <div class="workspace-chat-actions">
              <div class="pill">{{ selectedChat?.title || "Без чата" }}</div>
              <button class="ghost-button mini danger-button" :disabled="state.busy || !selectedChat" @click="selectedChat && deleteChat(selectedChat.id)">
                Удалить чат
              </button>
            </div>
          </div>
          <div class="chat-progress-strip">
            <article class="progress-chip">
              <span>Текущий фокус</span>
              <strong>{{ progressSummary.currentTask?.title || (progressSummary.inProgressCount ? `${progressSummary.inProgressCount} задач в работе` : "Нет активной задачи") }}</strong>
            </article>
            <article class="progress-chip">
              <span>Сделано</span>
              <strong>{{ progressSummary.doneCount }}</strong>
            </article>
            <article class="progress-chip">
              <span>Бэклог</span>
              <strong>{{ progressSummary.backlogCount }}</strong>
            </article>
          </div>
          <div class="activity-panel">
            <div class="section-heading compact-heading">
              <div>
                <h3>Что делает команда</h3>
                <p>Живой лог работы оркестратора и агентов.</p>
              </div>
            </div>
            <div class="activity-feed">
              <article v-for="entry in activityFeed" :key="`${entry.at}-${entry.event}`" class="activity-item">
                <strong>{{ formatActivityEntry(entry) }}</strong>
                <span>{{ new Date(entry.at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) }}</span>
              </article>
              <div v-if="!activityFeed.length" class="empty-block activity-empty">
                Пока нет живых событий. Запусти задачу или дай оркестратору поручение на выполнение.
              </div>
            </div>
          </div>
          <div ref="messagesListRef" class="messages-list">
            <article v-for="message in displayedMessages" :key="message.id" class="message-card" :class="[message.role, { 'team-live-message': String(message.id).startsWith('live-') }]">
              <strong>
                {{
                  message.role === 'assistant'
                    ? `${message.meta?.usage?.name || 'Alex'} (${message.meta?.usage?.label || 'Оркестратор'})`
                    : 'user'
                }}
              </strong>
              <pre>{{ message.content }}</pre>
              <div v-if="message.meta?.usage" class="message-usage">
                {{ message.meta.usage.totalTokens.toLocaleString() }} actual ·
                {{ message.meta.usage.weightedTokens.toLocaleString() }} weighted ·
                {{ message.meta.usage.model }}
              </div>
            </article>
          </div>
          <div v-if="!state.messages.length" class="empty-block">
            Выбери проект, создай чат и отправь первую задачу оркестратору.
          </div>
          <div class="workspace-composer">
            <textarea v-model="chatDraft" rows="5" placeholder="Например: кто в команде, что сейчас в работе, добавь задачу на экспорт CSV" />
            <div class="inline-actions">
              <button class="primary-button full-width" :disabled="state.busy || !selectedChat || !chatDraft.trim()" @click="sendChatMessage">
                Написать оркестратору
              </button>
              <button class="ghost-button full-width" :disabled="state.busy || !selectedChat || !chatDraft.trim()" @click="runTask">
                Запустить выполнение
              </button>
            </div>
          </div>
        </div>

        <div class="workspace-rail">
          <div class="panel panel-stack rail-panel">
            <div class="section-heading">
              <div>
                <h3>Состав команды</h3>
                <p>Кто сейчас в команде проекта и чем занят.</p>
              </div>
            </div>
            <div class="team-roster">
              <article
                v-for="agent in teamRosterStatus"
                :key="agent.role"
                class="roster-card"
              >
                <div class="roster-head">
                  <span class="agent-lamp" :class="{ working: agent.isWorking }"></span>
                  <strong>{{ agent.name }}</strong>
                </div>
                <span>{{ agent.label }}</span>
                <small>{{ agent.role }} · {{ agent.model }}</small>
                <p>{{ agent.detail }}</p>
                <div class="roster-usage">
                  <span>{{ agent.actualTokens.toLocaleString() }} actual</span>
                  <span>{{ agent.weightedTokens.toLocaleString() }} weighted</span>
                </div>
              </article>
            </div>
          </div>

          <div class="panel panel-stack rail-panel">
            <div class="section-heading">
              <div>
                <h3>Токены</h3>
                <p>Статистика по чату и участникам команды.</p>
              </div>
            </div>
            <div class="token-summary-grid">
              <article class="token-summary-card">
                <span>Всего actual</span>
                <strong>{{ state.chatStats.totalActualTokens.toLocaleString() }}</strong>
              </article>
              <article class="token-summary-card">
                <span>Всего weighted</span>
                <strong>{{ state.chatStats.totalWeightedTokens.toLocaleString() }}</strong>
              </article>
            </div>
            <div class="token-role-list">
              <article v-for="item in tokenRoleStats" :key="item.role" class="token-role-card">
                <strong>{{ item.name || item.label || item.role }}</strong>
                <span>{{ item.model || item.role }}</span>
                <small>{{ item.calls }} вызовов</small>
                <div class="roster-usage">
                  <span>{{ item.actualTokens.toLocaleString() }} actual</span>
                  <span>{{ item.weightedTokens.toLocaleString() }} weighted</span>
                </div>
              </article>
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
