import type {
  Chat,
  ChatMessage,
  ChatStats,
  CompileResult,
  ModelCatalogItem,
  Project,
  ProjectMemoryEntry,
  Provider,
  ResyncHistoryItem,
  ResyncResult,
  ResyncStatus,
  RunApproval,
  RunItem,
  Team,
} from "./types";

const API_BASE = import.meta.env.VITE_API_URL || "";

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const base = API_BASE ? `${API_BASE}/api` : "/api";
  const response = await fetch(`${base}${url}`, {
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    ...init,
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Request failed");
  }

  return data as T;
}

export const api = {
  health: () => request<{ ok: boolean }>("/health"),
  settings: () =>
    request<{
      env: {
        LOCAL_PROJECTS_ROOT: string;
        CONTAINER_PROJECTS_ROOT: string;
      };
    }>("/settings"),
  // providerId обязателен по смыслу: каталог моделей должен тянуться из
  // modelsUrl ВЫБРАННОГО провайдера (он хранится в БД у каждого провайдера
  // свой). Раньше шлался запрос без providerId → бэкенд возвращал модели
  // активного/дефолтного провайдера, и при смене провайдера у команды список
  // моделей не менялся (сторонние провайдеры «тянули» чужой список).
  models: (providerId?: string) =>
    request<{ items: ModelCatalogItem[] }>(
      `/catalog/models${providerId ? `?providerId=${encodeURIComponent(providerId)}` : ""}`,
    ),
  providers: () => request<{ providers: Provider[] }>("/providers"),
  saveProvider: (provider: Partial<Provider>) =>
    request<{ provider: Provider }>("/providers", {
      method: "POST",
      body: JSON.stringify(provider),
    }),
  deleteProvider: (id: string) =>
    request<{ ok: boolean }>(`/providers/${id}`, {
      method: "DELETE",
    }),
  teams: () => request<{ teams: Team[] }>("/teams"),
  saveTeam: (team: Partial<Team>) =>
    request<{ team: Team }>("/teams", {
      method: "POST",
      body: JSON.stringify(team),
    }),
  deleteTeam: (id: string) =>
    request<{ ok: boolean }>(`/teams/${id}`, {
      method: "DELETE",
    }),
  projects: () => request<{ projects: Project[] }>("/projects"),
  saveProject: (project: Partial<Project>) =>
    request<{ project: Project }>("/projects", {
      method: "POST",
      body: JSON.stringify(project),
    }),
  projectMemory: (projectId: string) =>
    request<{ entries: ProjectMemoryEntry[] }>(`/projects/${projectId}/memory`),
  projectKnowledgeGraph: (projectId: string) =>
    request<{ entry: ProjectMemoryEntry | null }>(`/projects/${projectId}/memory/knowledge-graph`),
  saveProjectMemory: (entry: Partial<ProjectMemoryEntry>) =>
    request<{ entry: ProjectMemoryEntry }>("/projects/memory", {
      method: "POST",
      body: JSON.stringify(entry),
    }),
  resyncProject: (projectId: string) =>
    request<{ result: ResyncResult }>(`/projects/${projectId}/resync`, {
      method: "POST",
    }),
  resyncStatus: (projectId: string) =>
    request<{ status: ResyncStatus }>(`/projects/${projectId}/resync/status`),
  resyncHistory: (projectId: string) =>
    request<{ items: ResyncHistoryItem[] }>(`/projects/${projectId}/resync/history`),
  resyncHistoryEntry: (projectId: string, entryId: string) =>
    request<{ entry: ResyncHistoryItem }>(`/projects/${projectId}/resync/history/${entryId}`),
  deleteProject: (id: string) =>
    request<{ ok: boolean }>(`/projects/${id}`, {
      method: "DELETE",
    }),
  chats: (projectId?: string) =>
    request<{ chats: Chat[] }>(`/chats${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`),
  chatById: (id: string) =>
    request<{ chat: Chat; messages: ChatMessage[]; runs: RunItem[]; stats: ChatStats }>(`/chats/${id}`),
  saveChat: (chat: Partial<Chat>) =>
    request<{ chat: Chat }>("/chats", {
      method: "POST",
      body: JSON.stringify(chat),
    }),
  sendChatMessage: (chatId: string, content: string, teamId?: string, projectId?: string) =>
    request<{ chat: Chat; message: ChatMessage; autoRunId?: string | null }>(`/chats/${chatId}/messages`, {
      method: "POST",
      body: JSON.stringify({ content, teamId, projectId }),
    }),
  deleteChat: (id: string) =>
    request<{ ok: boolean }>(`/chats/${id}`, {
      method: "DELETE",
    }),
  runs: () => request<{ runs: RunItem[] }>("/runs"),
  runById: (id: string) => request<{ run: RunItem; report: unknown }>(`/runs/${id}`),
  startRun: (payload: { chatId: string; projectId: string; task: string; teamId: string; teamName: string; projectPath: string }) =>
    request<{ runId: string }>("/runs", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  job: (id: string) =>
    request<{
      id: string;
      status: string;
      error?: string;
      events: Array<{ at: string; event: string; payload?: unknown }>;
    }>(`/jobs/${id}`),
  resolveRunApproval: (
    runId: string,
    approvalId: string,
    approved: boolean,
    reason?: string,
    resolution?: "approve" | "reject_skip" | "reject_cancel",
  ) =>
    request<{ ok: boolean; reason?: string; cancelled?: boolean }>(`/runs/${runId}/approvals/${approvalId}`, {
      method: "POST",
      body: JSON.stringify({ approved, reason, resolution }),
    }),
  // Управление агентом: остановить / пауза / продолжить / новая задача.
  cancelRun: (runId: string, reason?: string) =>
    request<{ ok: boolean; reason?: string }>(`/runs/${runId}/cancel`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    }),
  pauseRun: (runId: string, reason?: string) =>
    request<{ ok: boolean; reason?: string }>(`/runs/${runId}/pause`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    }),
  resumeRun: (runId: string) =>
    request<{ ok: boolean; started: boolean; reason?: string }>(`/runs/${runId}/resume`, {
      method: "POST",
    }),
  replaceTask: (runId: string, task: string) =>
    request<{ ok: boolean; action: "queued_for_resume" | "redirected" | "unavailable"; reason?: string }>(
      `/runs/${runId}/replace-task`,
      {
        method: "POST",
        body: JSON.stringify({ task }),
      },
    ),
  compile: (payload: { projectId: string; task: string; chatId?: string; teamId?: string; mode?: "auto" | "build" | "ask"; execute?: boolean; maxContextTokens?: number }) =>
    request<{ result: CompileResult }>("/compile", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  compileBuild: (payload: { projectId: string; task: string; chatId?: string; teamId?: string; execute?: boolean; maxContextTokens?: number }) =>
    request<{ result: CompileResult }>("/compile/build", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  compileAsk: (payload: { projectId: string; task: string; chatId?: string; teamId?: string; maxContextTokens?: number }) =>
    request<{ result: CompileResult }>("/compile/ask", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
};
