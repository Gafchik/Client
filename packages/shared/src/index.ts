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
  profile?: "standard" | "large-repository";
  selectionMode?: "full" | "selective";
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
  mode: "full" | "selective";
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

export interface RepositoryChangedFile {
  path: string;
  previousPath?: string;
  changeType: "added" | "modified" | "deleted" | "renamed" | "copied" | "untracked" | "type-changed" | "unknown";
  scope: "staged" | "unstaged" | "untracked";
}

export interface RepositorySnapshot {
  repositoryId: string;
  projectId: string;
  rootPath: string;
  branch: string;
  headCommit: string;
  mergeBase: string;
  upstream: string;
  isGitRepository: boolean;
  isDirty: boolean;
  isDetachedHead: boolean;
  hasUnmergedPaths: boolean;
  hasUntrackedFiles: boolean;
  changedFiles: RepositoryChangedFile[];
  diagnostics: string[];
  summary: {
    changedFileCount: number;
    stagedCount: number;
    unstagedCount: number;
    untrackedCount: number;
    deletedCount: number;
    renamedCount: number;
  };
  scannedAt: string;
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

export interface ControlledExecutionRuntime {
  runtimeId: string;
  runId: string;
  mode: "controlled-runtime";
  status: "ready-for-approval" | "blocked";
  summary: string;
  allowedWriteFiles: string[];
  blockedWriteZones: string[];
  scopeGuards: string[];
  approvalChecks: string[];
  refreshPlan: string[];
  executionAllowed: false;
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
  key: "workspace" | "repository" | "index" | "graph" | "research" | "impact" | "context" | "plan" | "preview" | "runtime" | "knowledge";
  label: string;
  status: "pending" | "running" | "completed" | "failed";
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
  repository: RepositorySnapshot;
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
  executionRuntime: ControlledExecutionRuntime;
  knowledge: KnowledgeSaveResult;
}

export interface PipelineRunStatus {
  runId: string;
  task: string;
  projectPath: string;
  status: "queued" | "running" | "completed" | "failed";
  createdAt: string;
  updatedAt: string;
  currentStageKey?: PipelineStage["key"];
  currentStageLabel?: string;
  stages: PipelineStage[];
  result?: PipelineRunResult;
  errorMessage?: string;
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

export function isLocalizationPath(filePath: string): boolean {
  const normalized = normalizePath(filePath).toLowerCase();

  return (
    normalized.startsWith("lang/")
    || normalized.includes("/lang/")
    || normalized.startsWith("locales/")
    || normalized.includes("/locales/")
    || normalized.includes("/i18n/")
    || normalized.includes("/translations/")
  );
}

export function isConfigPath(filePath: string): boolean {
  const normalized = normalizePath(filePath).toLowerCase();

  return (
    normalized.startsWith("config/")
    || normalized.includes("/config/")
    || normalized.endsWith(".env")
    || normalized.includes(".env.")
  );
}

export function deriveStructuralModuleLabel(filePath: string): string {
  const normalized = normalizePath(filePath);
  const parts = normalized.split("/").filter(Boolean);

  if (parts.length === 0) {
    return "root";
  }

  if (parts[0] === "app" && parts[1] === "src" && parts[2] === "Containers" && parts[3]) {
    return `container:${parts[3]}`;
  }

  if (parts[0] === "app" && parts[1] === "src" && parts[2] === "Ship") {
    return "ship";
  }

  if (parts[0] === "resources" && parts[1] === "lang" && parts[2]) {
    return `localization:${parts[2]}`;
  }

  if (parts[0] === "resources" && parts[1] === "views" && parts[2]) {
    return `views:${parts[2]}`;
  }

  if (parts[0] === "database" && parts[1]) {
    return `database:${parts[1]}`;
  }

  if (parts[0] === "routes" && parts[1]) {
    return `routes:${parts[1]}`;
  }

  return parts[0] || "root";
}

export function deriveLocalizationBucket(filePath: string): string | null {
  const normalized = normalizePath(filePath);
  const parts = normalized.split("/").filter(Boolean);

  if (parts[0] === "lang" && parts[1]) {
    return parts[1];
  }

  const langIndex = parts.findIndex((part) => part.toLowerCase() === "lang");

  if (langIndex >= 0 && parts[langIndex + 1]) {
    return parts[langIndex + 1] ?? null;
  }

  const localesIndex = parts.findIndex((part) => part.toLowerCase() === "locales");

  if (localesIndex >= 0 && parts[localesIndex + 1]) {
    return parts[localesIndex + 1] ?? null;
  }

  return null;
}
