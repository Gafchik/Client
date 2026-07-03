import type { Chat, ChatMessage, ChatStats, ModelCatalogItem, Project, ProjectMemoryEntry, Provider, RunItem, Team } from "./types";

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
  models: () => request<{ items: ModelCatalogItem[] }>("/catalog/models"),
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
  saveProjectMemory: (entry: Partial<ProjectMemoryEntry>) =>
    request<{ entry: ProjectMemoryEntry }>("/projects/memory", {
      method: "POST",
      body: JSON.stringify(entry),
    }),
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
  sendChatMessage: (chatId: string, content: string) =>
    request<{ chat: Chat; message: ChatMessage; autoRunId?: string | null }>(`/chats/${chatId}/messages`, {
      method: "POST",
      body: JSON.stringify({ content }),
    }),
  deleteChat: (id: string) =>
    request<{ ok: boolean }>(`/chats/${id}`, {
      method: "DELETE",
    }),
  runs: () => request<{ runs: RunItem[] }>("/runs"),
  runById: (id: string) => request<{ run: RunItem; report: unknown }>(`/runs/${id}`),
  startRun: (payload: { chatId: string; task: string; teamId: string; teamName: string; projectPath: string }) =>
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
};