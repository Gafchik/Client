export type CompilerDetectedMode = "build" | "ask";

export type IntentType =
  | "implementation"
  | "diagnostics"
  | "research"
  | "impact_question"
  | "dependency_question"
  | "test_question"
  | "status_question";

export interface IntentAnalysis {
  mode: CompilerDetectedMode;
  intentType: IntentType;
  confidence: number;
  reasons: string[];
  entities: string[];
}

export interface ProjectKnowledgeSnapshot {
  coverage: Record<string, number>;
  unknowns: string[];
  topEntities: Array<{ id: string; name: string; kind: string; location: string }>;
  topMemory: Array<{ id: string; title: string; summary: string; kind: string; relatedFiles: string[] }>;
  relationTypes?: Array<{ type: string; count: number }>;
  hotFiles?: Array<{ file: string; incomingCalls: number; outgoingCalls: number; score: number }>;
}

export interface ImpactSnapshot {
  changed: string[];
  impactedNodes: string[];
  impactedFiles: string[];
  impactedServices: string[];
  impactedApi: string[];
  impactedPages: string[];
  testsToRun: string[];
  riskScore: number;
  riskLevel: "low" | "medium" | "high";
  reasons: string[];
}

export interface ContextPackItem {
  type: "memory" | "file" | "entity" | "impact" | "test";
  id: string;
  title: string;
  content: string;
  weight: number;
  estimatedTokens: number;
}

export interface ContextPack {
  items: ContextPackItem[];
  totalEstimatedTokens: number;
  droppedItems: number;
}

export interface SimilarSolution {
  id: string;
  title: string;
  summary: string;
  kind: string;
  relatedFiles: string[];
  score: number;
}

export interface CodeConstraints {
  allowedFiles: string[];
  forbiddenPaths: string[];
  immutableFiles: string[];
  notes: string[];
}

export interface CompilerIR {
  task: string;
  normalizedTask: string;
  intentType: IntentType;
  entities: string[];
  relatedEntities: string[];
  impact: {
    riskLevel: "low" | "medium" | "high";
    riskScore: number;
    impactedFiles: string[];
    impactedServices: string[];
    impactedApi: string[];
    testsToRun: string[];
  };
  context: {
    maxTokens: number;
    usedTokens: number;
    droppedItems: number;
    selectedItems: Array<{ type: ContextPackItem["type"]; id: string; title: string; estimatedTokens: number; weight: number }>;
  };
  constraints: CodeConstraints;
  architectureRules: string[];
  acceptanceCriteria: string[];
  similarSolutions: SimilarSolution[];
}

export interface ExecutionPlan {
  mode: CompilerDetectedMode;
  stages: Array<{
    id: string;
    title: string;
    deterministic: boolean;
    enabled: boolean;
    reason: string;
  }>;
  roles: {
    pm: boolean;
    developer: boolean;
    reviewer: boolean;
    tester: boolean;
  };
  runMode: "implementation" | "diagnostics" | "research";
  executionTask: string;
  testsToRun: string[];
  compilerIR?: CompilerIR;
  constraints?: CodeConstraints;
  architectureRules?: string[];
  acceptanceCriteria?: string[];
  relatedEntities?: string[];
  similarSolutions?: SimilarSolution[];
}
