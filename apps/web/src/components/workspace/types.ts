import type { CompileResult } from "../../types";

export type MissionStageId =
  | "intent"
  | "ir"
  | "knowledge"
  | "impact"
  | "context"
  | "planning"
  | "development"
  | "review"
  | "testing"
  | "memory"
  | "completed";

export type MissionHistoryItem = {
  id: string;
  title: string;
  mode: "build" | "ask";
  status: string;
  createdAt: string;
  updatedAt: string;
  runId?: string;
  durationSec: number;
  changedFiles: number;
  tokens: number;
  cost: number;
  models: string[];
  resultSummary: string;
  compile: CompileResult | null;
  runEvents: Array<{ at: string; event: string; payload?: unknown }>;
  finalReport?: unknown;
  askAnswer?: string;
};

export type PipelineStage = {
  id: MissionStageId;
  title: string;
  description: string;
  status: "pending" | "active" | "done" | "error";
  duration: string;
  model: string;
  expandableText?: string;
};

export type TimelineEvent = {
  at: string;
  title: string;
  details: string;
};

export type LiveActivityItem = {
  id: string;
  at: string;
  role: string;
  action: string;
  target: string;
};

export type InspectorTab = "knowledge" | "sources" | "ir" | "plan";
