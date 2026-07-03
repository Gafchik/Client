import type { Chat, ChatMessage, ChatStats, ModelCatalogItem, Project, Provider, RunItem, TaskItem, Team } from "./types";

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
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
  health: () => request<{ ok: boolean }>("/api/health"),
  settings: () =>
    request<{
      env: {
        LOCAL_PROJECTS_ROOT: string;
        CONTAINER_PROJECTS_ROOT: string;
      };
    }>("/api/settings"),
  models: () => request<{ items: ModelCatalogItem[] }>("/api/catalog/models"),
  providers: () => request<{ providers: Provider[] }>("/api/providers"),
  saveProvider: (provider: Partial<Provider>) =>
    request<{ provider: Provider }>("/api/providers", {
      method: "POST",
      body: JSON.stringify(provider),
    }),
  deleteProvider: (id: string) =>
    request<{ ok: boolean }>(`/api/providers/${id}`, {
      method: "DELETE",
    }),
  teams: () => request<{ teams: Team[] }>("/api/teams"),
  saveTeam: (team: Partial<Team>) =>
    request<{ team: Team }>("/api/teams", {
      method: "POST",
      body: JSON.stringify(team),
    }),
  deleteTeam: (id: string) =>
    request<{ ok: boolean }>(`/api/teams/${id}`, {
      method: "DELETE",
    }),
  projects: () => request<{ projects: Project[] }>("/api/projects"),
  saveProject: (project: Partial<Project>) =>
    request<{ project: Project }>("/api/projects", {
      method: "POST",
      body: JSON.stringify(project),
    }),
  deleteProject: (id: string) =>
    request<{ ok: boolean }>(`/api/projects/${id}`, {
      method: "DELETE",
    }),
  chats: (projectId?: string) =>
    request<{ chats: Chat[] }>(`/api/chats${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`),
  chatById: (id: string) =>
    request<{ chat: Chat; messages: ChatMessage[]; runs: RunItem[]; stats: ChatStats }>(`/api/chats/${id}`),
  saveChat: (chat: Partial<Chat>) =>
    request<{ chat: Chat }>("/api/chats", {
      method: "POST",
      body: JSON.stringify(chat),
    }),
  sendChatMessage: (chatId: string, content: string) =>
    request<{ chat: Chat; message: ChatMessage; createdTasks: TaskItem[]; autoRunId?: string | null }>(`/api/chats/${chatId}/messages`, {
      method: "POST",
      body: JSON.stringify({ content }),
    }),
  deleteChat: (id: string) =>
    request<{ ok: boolean }>(`/api/chats/${id}`, {
      method: "DELETE",
    }),
  tasks: (projectId?: string) =>
    request<{ tasks: TaskItem[] }>(`/api/tasks${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`),
  saveTask: (task: Partial<TaskItem>) =>
    request<{ task: TaskItem }>("/api/tasks", {
      method: "POST",
      body: JSON.stringify(task),
    }),
  deleteTask: (id: string) =>
    request<{ ok: boolean }>(`/api/tasks/${id}`, {
      method: "DELETE",
    }),
  runs: () => request<{ runs: RunItem[] }>("/api/runs"),
  runById: (id: string) => request<{ run: RunItem; report: unknown }>(`/api/runs/${id}`),
  startRun: (payload: { chatId: string; task: string }) =>
    request<{ runId: string }>("/api/runs", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  job: (id: string) =>
    request<{
      id: string;
      status: string;
      error?: string;
      events: Array<{ at: string; event: string; payload?: unknown }>;
    }>(`/api/jobs/${id}`),
};
