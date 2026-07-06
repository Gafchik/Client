export interface AgentConfig {
  name?: string;
  label: string;
  model: string;
  multiplier: number;
  temperature: number;
}

export interface Provider {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  apiKeyMasked?: string;
  hasApiKey?: boolean;
  modelsUrl: string;
  isActive: boolean;
  isCurrent: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface TeamConfig {
  language: string;
  budget: {
    dailyWeightedTokens: number;
    timezone: string;
  };
  workspace: {
    maxFiles: number;
    maxCharsPerFile: number;
    includeExtensions: string[];
    ignoreDirs: string[];
  };
  run: {
    maxReviewRounds: number;
    applyChanges: boolean;
  };
  testing: {
    commands: string[];
  };
  agents: Record<string, AgentConfig>;
}

export interface Team extends TeamConfig {
  id: string;
  name: string;
  description: string;
  providerId?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  localPath: string;
  containerPath: string;
  teamId?: string | null;
  isActive: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface ProjectMemoryEntry {
  id: string;
  projectId: string;
  title: string;
  summary: string;
  details: string;
  graph?: Record<string, unknown>;
  kind: string;
  tags: string[];
  relatedFiles: string[];
  sourceRunId?: string | null;
  sourceChatId?: string | null;
  relevanceScore?: number | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface Chat {
  id: string;
  projectId: string;
  teamId: string;
  title: string;
  summary: string;
  isActive: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface ChatMessage {
  id: string;
  chatId: string;
  role: string;
  content: string;
  meta?: {
    type?: string;
    runId?: string;
    autoRunId?: string;
    requestId?: string;
    usage?: {
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
      weightedTokens: number;
      multiplier: number;
      model: string;
      role: string;
      name?: string;
      label?: string;
    };
    orchestratorPayload?: Record<string, unknown>;
    [key: string]: unknown;
  } | null;
  createdAt?: string;
}

export interface RunItem {
  id: string;
  teamId: string;
  projectId?: string | null;
  chatId?: string | null;
  teamName: string;
  task: string;
  projectPath: string;
  status: string;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  events?: Array<{ at: string; event: string; payload?: unknown }>;
  finalReport?: unknown;
  // Управление агентом: пауза/возобновление/перенаправление задачи.
  pendingTask?: string | null;
  cancelReason?: string | null;
  pausedAt?: string | null;
}

export interface RunApproval {
  id: string;
  kind: "command" | "migration" | "clarification";
  role: string;
  title: string;
  description: string;
  questions?: string[];
  command?: string;
  cwd?: string;
  // Для миграций: какая миграция и что делает.
  migrationId?: string;
  migrationName?: string;
  migrationDescription?: string;
  status: "pending" | "approved" | "rejected";
  createdAt: string;
  resolvedAt?: string | null;
  reason?: string | null;
  resolution?: "approve" | "reject_skip" | "reject_cancel" | null;
}


export interface ChatStats {
  requestCount: number;
  runCount: number;
  totalActualTokens: number;
  totalWeightedTokens: number;
  byRole: Record<
    string,
    {
      actualTokens: number;
      weightedTokens: number;
      promptTokens: number;
      completionTokens: number;
      calls: number;
      model?: string;
      label?: string;
      name?: string;
    }
  >;
}

export interface ModelCatalogItem {
  provider: string;
  label: string;
  id: string;
  multiplier: number;
  notes?: string;
}
