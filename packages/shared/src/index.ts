import { createHash } from "node:crypto";

export type LanguageId =
  | "typescript"
  | "javascript"
  | "json"
  | "markdown"
  | "yaml"
  | "sql"
  | "dockerfile"
  | "php"
  | "vue"
  | "unknown";

export type SymbolKind =
  | "class"
  | "interface"
  | "enum"
  | "function"
  | "method"
  | "route"
  | "middleware"
  | "variable"
  | "type"
  | "heading"
  | "json-key"
  | "dependency";

export type GraphNodeKind =
  | "repository"
  | "project"
  | "module"
  | "folder"
  | "file"
  | "class"
  | "interface"
  | "enum"
  | "function"
  | "method"
  | "route"
  | "middleware"
  | "dependency";

export type GraphRelationType =
  | "DECLARES"
  | "OWNS"
  | "BELONGS_TO"
  | "CONTAINS"
  | "DEPENDS_ON"
  | "IMPORTS"
  | "REFERENCES"
  | "CALLS"
  | "USES"
  | "IMPLEMENTS"
  | "EXTENDS"
  | "READS"
  | "WRITES"
  | "CREATES"
  | "EMITS"
  | "LISTENS"
  | "GENERATES"
  | "LINKS_TO";

export interface ProjectFile {
  id: string;
  absolutePath: string;
  relativePath: string;
  extension: string;
  language: LanguageId;
  size: number;
  modifiedAt: string;
  contentHash: string;
  content: string;
}

export interface WorkspaceSummary {
  totalFiles: number;
  indexedFiles: number;
  languages: Record<string, number>;
}

export interface WorkspaceSnapshot {
  projectId: string;
  projectName: string;
  rootPath: string;
  scannedAt: string;
  files: ProjectFile[];
  ignoredPaths: string[];
  diagnostics: string[];
  summary: WorkspaceSummary;
}

export interface IndexSymbol {
  id: string;
  name: string;
  kind: SymbolKind;
  language: LanguageId;
  fileId: string;
  filePath: string;
  line: number;
  containerName?: string;
  signature?: string;
}

export interface IndexRelation {
  id: string;
  type: GraphRelationType;
  sourceId: string;
  targetId: string;
  metadata?: Record<string, string | number | boolean>;
}

export interface IndexedFile {
  fileId: string;
  filePath: string;
  language: LanguageId;
  symbolIds: string[];
  imports: string[];
}

export interface IndexManifest {
  indexId: string;
  mode: "full";
  startedAt: string;
  completedAt: string;
  projectId: string;
  fileCount: number;
  symbolCount: number;
  relationCount: number;
  diagnosticsCount: number;
}

export interface IndexResult {
  manifest: IndexManifest;
  files: IndexedFile[];
  symbols: IndexSymbol[];
  relations: IndexRelation[];
  diagnostics: string[];
  stats: {
    languages: Record<string, number>;
    unsupportedFiles: number;
  };
}

export interface GraphNode {
  id: string;
  kind: GraphNodeKind;
  label: string;
  filePath?: string;
  metadata?: Record<string, string | number | boolean>;
}

export interface GraphEdge {
  id: string;
  type: GraphRelationType;
  sourceId: string;
  targetId: string;
  metadata?: Record<string, string | number | boolean>;
}

export interface GraphSummary {
  nodeCount: number;
  edgeCount: number;
  fileCount: number;
  symbolCount: number;
  dependencyCount: number;
  repositoryCount?: number;
  moduleCount?: number;
  folderCount?: number;
  routeCount?: number;
}

export interface GraphState {
  graphId: string;
  projectId: string;
  createdAt: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  summary: GraphSummary;
}

export interface ScoredReference {
  id: string;
  label: string;
  score: number;
  reason: string;
  filePath?: string;
}

export interface ModuleIntentMatch {
  module: string;
  score: number;
  reasons: string[];
  matchedFiles: string[];
}

export type ResearchIntentClass =
  | "functional-flow"
  | "infrastructure-storage"
  | "inventory-localization"
  | "inventory-config"
  | "broad-unknown";

export type ResearchStrategyKey =
  | "graph-functional-entrypoints"
  | "graph-storage-structure"
  | "graph-localization-inventory"
  | "graph-config-inventory"
  | "broad-repository-scan";

export type ResearchQueryProfileKey =
  | "entrypoint-traversal"
  | "storage-topology"
  | "localization-inventory"
  | "config-inventory"
  | "broad-scan";

export interface ResearchReport {
  runId: string;
  task: string;
  summary: string;
  intentClass: ResearchIntentClass;
  strategyKey: ResearchStrategyKey;
  queryProfileKey: ResearchQueryProfileKey;
  functionalSummary: string;
  dominantModule: string;
  moduleIntents: ModuleIntentMatch[];
  entryPoints: string[];
  primaryEntities: string[];
  sideEffects: string[];
  dataSources: string[];
  findings: string[];
  evidence: ScoredReference[];
  affectedModules: string[];
  unknowns: string[];
  confidence: number;
  references: string[];
}

export interface ImpactReport {
  runId: string;
  summary: string;
  startingPoints: string[];
  affectedFiles: string[];
  affectedSymbols: string[];
  risks: string[];
  validationScope: string[];
  confidence: number;
}

export interface ContextCandidate {
  id: string;
  type: "file" | "symbol" | "knowledge" | "functional";
  label: string;
  filePath?: string;
  score: number;
  priority: "critical" | "high" | "supporting";
  tokenEstimate: number;
  reason: string;
  excerpt?: string;
}

export interface ContextPackage {
  contextId: string;
  runId: string;
  summary: string;
  functionalHighlights: string[];
  focusZones: string[];
  rankingSummary: string[];
  tokenBudget: number;
  estimatedTokens: number;
  includedFiles: string[];
  selectedChunks: ContextCandidate[];
  omittedCandidates: ContextCandidate[];
  rules: string[];
  confidence: number;
}

export interface PlanStep {
  id: string;
  title: string;
  description: string;
  dependsOn: string[];
  status: "planned";
  executor: "analysis-agent" | "implementation-agent" | "validation-agent";
  parallelizable: boolean;
  scope: string[];
  outputs: string[];
  approvalRequired: boolean;
  validation: string[];
}

export interface PlanDependency {
  from: string;
  to: string;
  reason: string;
}

export interface ExecutionPlan {
  planId: string;
  runId: string;
  summary: string;
  strategy: "sequential" | "hybrid";
  risks: string[];
  targetModules: string[];
  targetFiles: string[];
  entryPoints: string[];
  validationScope: string[];
  planningNotes: string[];
  dependencyChains: PlanDependency[];
  approvalRequired: boolean;
  steps: PlanStep[];
}

export interface ExecutionPreview {
  previewId: string;
  runId: string;
  mode: "safe-preview";
  summary: string;
  allowedActions: string[];
  blockedActions: string[];
  reindexRequired: true;
  graphRefreshRequired: true;
  knowledgeRefreshRequired: true;
}

export interface KnowledgeCatalogEntry {
  runId: string;
  task: string;
  savedAt: string;
  storagePath: string;
  summary: string;
}

export interface KnowledgeSaveResult {
  runId: string;
  savedAt: string;
  storagePath: string;
  catalogPath: string;
  artifactCount: number;
}

export interface PipelineStage {
  key: "workspace" | "index" | "graph" | "research" | "impact" | "context" | "plan" | "preview" | "knowledge";
  label: string;
  status: "completed";
  startedAt: string;
  completedAt: string;
  details: string;
}

export interface PipelineWorkspaceDetails {
  scannedAt: string;
  ignoredPaths: string[];
  diagnostics: string[];
}

export interface ProviderRuntimeConfig {
  baseUrl: string;
  model: string;
  apiKeyMasked: string;
}

export interface PipelineRunResult {
  runId: string;
  project: {
    name: string;
    rootPath: string;
    summary: WorkspaceSummary;
  };
  workspace: PipelineWorkspaceDetails;
  provider: ProviderRuntimeConfig;
  index: {
    manifest: IndexManifest;
    stats: IndexResult["stats"];
    diagnostics: string[];
  };
  graph: {
    summary: GraphSummary;
  };
  stages: PipelineStage[];
  research: ResearchReport;
  impact: ImpactReport;
  context: ContextPackage;
  plan: ExecutionPlan;
  executionPreview: ExecutionPreview;
  knowledge: KnowledgeSaveResult;
}

export function stableId(parts: Array<string | number>): string {
  return createHash("sha1").update(parts.join("::")).digest("hex");
}

export function contentHash(value: string): string {
  return createHash("sha1").update(value).digest("hex");
}

export function normalizePath(value: string): string {
  return value.replace(/\\/g, "/");
}

export function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9а-яё_/-]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

export function scoreText(haystack: string, tokens: string[]): number {
  const normalized = haystack.toLowerCase();
  let score = 0;

  for (const token of tokens) {
    if (normalized.includes(token)) {
      score += 1;
    }
  }

  return score;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
