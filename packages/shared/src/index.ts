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
  stableSymbolId: string;
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
  contentHash: string;
  modifiedAt: string;
  parseCacheKey: string;
  astFingerprint: string;
  symbolIds: string[];
  imports: string[];
}

export interface ParseCacheSummary {
  eligibleFiles: number;
  reusedFiles: number;
  reparsedFiles: number;
  invalidatedFiles: number;
  reason: string;
}

export interface AstCacheSummary {
  eligibleFiles: number;
  reusedAstCount: number;
  rebuiltAstCount: number;
  invalidatedFiles: number;
  reason: string;
}

export interface SymbolDiffSummary {
  changedFiles: number;
  renamedFiles: number;
  deletedFiles: number;
  addedSymbols: number;
  removedSymbols: number;
  updatedSymbols: number;
  unchangedSymbols: number;
  reusedSymbols: number;
}

export interface IndexManifest {
  indexId: string;
  mode: "full" | "selective";
  baseIndexId?: string;
  startedAt: string;
  completedAt: string;
  projectId: string;
  fileCount: number;
  symbolCount: number;
  relationCount: number;
  diagnosticsCount: number;
  reusedFileCount: number;
  reusedSymbolCount: number;
  reusedRelationCount: number;
  reindexedFileCount: number;
  deletedFileCount: number;
  parseCache: ParseCacheSummary;
  astCache: AstCacheSummary;
  symbolDiff: SymbolDiffSummary;
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
  headFingerprint: string;
  mergeBase: string;
  upstream: string;
  stateFingerprint: string;
  worktreeFingerprint: string;
  branchFingerprint: string;
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

export interface BackgroundProjectState {
  stateId: string;
  projectId: string;
  projectRootPath: string;
  repositoryId: string;
  branch: string;
  headCommit: string;
  headFingerprint: string;
  mergeBase: string;
  branchFingerprint: string;
  worktreeFingerprint: string;
  stateFingerprint: string;
  latestRunId?: string;
  baselineRunId?: string;
  baselineHeadCommit?: string;
  baselineSource: "exact-head" | "merge-base" | "recent-branch" | "none";
  baselineExactForHead: boolean;
  freshness: "fresh" | "stale" | "missing";
  syncStatus: "ready" | "syncing" | "degraded";
  worktreeStatus: "clean" | "overlay" | "conflict";
  hasLocalChanges: boolean;
  changedFileCount: number;
  reusableFileCount: number;
  invalidatedFileCount: number;
  refreshedAt: string;
  diagnostics: string[];
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

export interface GraphInvalidationPlan {
  mode: "full-refresh" | "partial-invalidation";
  previousRunId?: string;
  changedPaths: string[];
  invalidatedFiles: string[];
  invalidatedModules: string[];
  invalidatedSymbolIds: string[];
  reusedNodeCount?: number;
  reusedEdgeCount?: number;
  reason: string;
}

export interface IncrementalIndexPlan {
  mode: "full-index" | "incremental-index";
  previousRunId?: string;
  candidatePaths: string[];
  changedPaths: string[];
  deletedPaths: string[];
  renamedPaths: Array<{
    from: string;
    to: string;
  }>;
  reusablePaths: string[];
  reusedSignals: string[];
  reason: string;
}

export interface ScoredReference {
  id: string;
  label: string;
  score: number;
  reason: string;
  filePath?: string;
  origin: "baseline" | "overlay" | "structural";
  originDetails?: string;
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
  baselineFindings: string[];
  overlayFindings: string[];
  evidence: ScoredReference[];
  evidenceSummary: {
    baselineCount: number;
    overlayCount: number;
    structuralCount: number;
    overlayInfluenced: boolean;
  };
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

export type AnswerMode =
  | "direct-answer"
  | "diagnostic-answer"
  | "plan-summary-answer"
  | "insufficient-data-answer"
  | "fallback-answer";

export interface AnswerEvidenceHighlight {
  label: string;
  detail: string;
}

export interface AnswerPackage {
  answerId: string;
  runId: string;
  answerMode: AnswerMode;
  summary: string;
  explanation: string;
  evidenceHighlights: AnswerEvidenceHighlight[];
  confirmedFacts: string[];
  unconfirmedFacts: string[];
  manualChecks: string[];
  confidence: number;
  unknowns: string[];
  warnings: string[];
  nextActions: string[];
  inspectorHints: string[];
  generatedAt: string;
  providerUsed?: {
    baseUrl: string;
    model: string;
  };
  synthesis: "llm" | "deterministic-fallback";
}

export interface KnowledgeCatalogEntry {
  runId: string;
  task: string;
  savedAt: string;
  storagePath: string;
  summary: string;
  mode?: PipelineRunMode;
  repositoryId?: string;
  branch?: string;
  headCommit?: string;
  headFingerprint?: string;
}

export interface KnowledgeSaveResult {
  runId: string;
  savedAt: string;
  storagePath: string;
  catalogPath: string;
  artifactCount: number;
}

export interface PipelineStage {
  key: "workspace" | "repository" | "index" | "graph" | "research" | "impact" | "context" | "plan" | "preview" | "runtime" | "answer" | "knowledge";
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

export interface ProviderRecord {
  id: string;
  name: string;
  baseUrl: string;
  apiKeyMasked: string;
  hasApiKey: boolean;
  isActive: boolean;
  isCurrent: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderModelRecord {
  id: string;
  label: string;
  providerId: string;
  isDefault?: boolean;
}

export interface ProviderCatalogResponse {
  providers: ProviderRecord[];
  currentProvider: ProviderRecord | null;
  models: ProviderModelRecord[];
  recommendedModelId?: string;
}

export interface ProjectPathRecord {
  id: string;
  projectId: string;
  name: string;
  rootPath: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectRecord {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  paths: ProjectPathRecord[];
}

export interface ProjectCatalogResponse {
  projects: ProjectRecord[];
}

export type PipelineRunMode = "background-sync" | "question-run" | "hard-resync";

export interface PipelineRunResult {
  runId: string;
  mode: PipelineRunMode;
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
  incrementalIndex?: IncrementalIndexPlan;
  graphInvalidation?: GraphInvalidationPlan;
  stages: PipelineStage[];
  research: ResearchReport;
  impact: ImpactReport;
  context: ContextPackage;
  plan: ExecutionPlan;
  executionPreview: ExecutionPreview;
  executionRuntime: ControlledExecutionRuntime;
  answer: AnswerPackage;
  knowledge: KnowledgeSaveResult;
  backgroundState?: BackgroundProjectState;
  runtimeCache?: PipelineRuntimeCache;
}

export interface PipelineRuntimeCache {
  index: IndexResult;
  graph: GraphState;
}

export interface PipelinePartialArtifacts {
  workspace?: PipelineRunResult["workspace"];
  repository?: RepositorySnapshot;
  index?: PipelineRunResult["index"];
  graph?: PipelineRunResult["graph"];
  backgroundState?: BackgroundProjectState;
  incrementalIndex?: IncrementalIndexPlan;
  graphInvalidation?: GraphInvalidationPlan;
  research?: ResearchReport;
  impact?: ImpactReport;
  context?: ContextPackage;
  plan?: ExecutionPlan;
  executionPreview?: ExecutionPreview;
  executionRuntime?: ControlledExecutionRuntime;
  answer?: AnswerPackage;
}

export interface PipelineRunStatus {
  runId: string;
  mode: PipelineRunMode;
  task: string;
  projectPath: string;
  status: "queued" | "running" | "completed" | "failed";
  createdAt: string;
  updatedAt: string;
  currentStageKey?: PipelineStage["key"];
  currentStageLabel?: string;
  resumeContext?: {
    providerBaseUrl: string;
    providerModel: string;
    canResumeFromStart: boolean;
    resumeAttempts: number;
  };
  stages: PipelineStage[];
  partialArtifacts?: PipelinePartialArtifacts;
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
