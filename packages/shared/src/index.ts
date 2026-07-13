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
  // "recalled" — переиспользовано из Fact Store (см. ProjectFact): подтверждено
  // не текущим git-состоянием, а накопленным ранее знанием о проекте.
  origin: "baseline" | "overlay" | "structural" | "recalled";
  originDetails?: string;
  reinforcedByFactIds?: string[];
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
  | "model-schema"
  | "auth-inventory"
  | "websocket-inventory"
  | "redis-inventory"
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
    recalledCount: number;
    overlayInfluenced: boolean;
  };
  affectedModules: string[];
  unknowns: string[];
  confidence: number;
  references: string[];
}

/**
 * Сигнал "вопрос реально бьёт в несколько равносильных доменных зон", а не
 * просто "мало данных" (intentClass === "broad-unknown" — другой случай,
 * туда не лезем) и не "что попутно будет затронуто" (affectedModules в
 * deriveAffectedModules — тот сигнал подмешивает graph-related модули через
 * соседей по графу, это другая семантика: "что заденет", а не "что вы
 * имели в виду"). Двойной порог: лидер должен быть реально сильным сигналом
 * (ABSOLUTE_MIN_LEADER_SCORE), иначе на слабых/расплывчатых вопросах
 * (low top.score) почти любой второй модуль ложно считался бы "конкурентом".
 * Пороги — эвристика, не откалиброванная на реальных данных (тестов/логов
 * в проекте нет) — тюнить по мере накопления опыта использования.
 */
export interface ResearchAmbiguity {
  ambiguous: boolean;
  competingModules: string[];
}

export function detectResearchAmbiguity(research: ResearchReport): ResearchAmbiguity {
  if (research.intentClass === "broad-unknown") {
    return { ambiguous: false, competingModules: [] };
  }

  const ABSOLUTE_MIN_LEADER_SCORE = 500;
  const RELATIVE_THRESHOLD_RATIO = 0.65;
  const MAX_COMPETING_MODULES = 4;
  const strongEvidenceCount = research.evidence.filter((item) => item.score >= 80).length;
  const fileBackedEvidence = research.evidence.filter((item) => Boolean(item.filePath)).length;
  const uniqueEvidenceFiles = new Set(
    research.evidence.map((item) => item.filePath).filter((item): item is string => Boolean(item)),
  ).size;
  const hasFunctionalChain = research.intentClass === "functional-flow" && research.entryPoints.length >= 2;
  const hasDominantModule = research.dominantModule !== "не определён";

  const sorted = [...research.moduleIntents].sort((left, right) => right.score - left.score);
  const top = sorted[0];

  if (!top || top.score < ABSOLUTE_MIN_LEADER_SCORE) {
    return { ambiguous: false, competingModules: [] };
  }

  const threshold = top.score * RELATIVE_THRESHOLD_RATIO;
  const competing = sorted
    .filter((item) => item.score >= threshold)
    .map((item) => item.module)
    .slice(0, MAX_COMPETING_MODULES + 1);

  if (
    hasFunctionalChain
    && hasDominantModule
    && strongEvidenceCount >= 2
    && fileBackedEvidence >= 3
    && uniqueEvidenceFiles <= 6
  ) {
    return { ambiguous: false, competingModules: [] };
  }

  return {
    ambiguous: competing.length >= 2 && competing.length <= MAX_COMPETING_MODULES,
    competingModules: competing.slice(0, MAX_COMPETING_MODULES),
  };
}

/**
 * Fact Store — durable память проекта между research-запросами (см.
 * docs/architecture/010-senior-developer-capability-roadmap.md, пункт 1).
 * В отличие от Knowledge (архив run-артефактов целиком), ProjectFact —
 * атомарный, переиспользуемый вывод, привязанный к конкретным файлам через
 * их content hash на момент подтверждения.
 */
export type FactStatus = "fresh" | "potentially_stale" | "deprecated";
export type FactSource = "research" | "user-confirmed" | "execution";

export interface ProjectFact {
  id: string;
  projectRootPath: string;
  /** Совпадает с ResearchReport.dominantModule на момент создания факта. */
  category: string;
  statement: string;
  filePaths: string[];
  confidence: number;
  status: FactStatus;
  source: FactSource;
  /** filePath -> IndexedFile.contentHash на момент последнего подтверждения. */
  contentHashes: Record<string, string>;
  createdAt: string;
  lastConfirmedAt: string;
  lastConfirmedHeadCommit?: string;
  supersededByFactId?: string;
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

export type ValidationStatus =
  | "ready-for-answer"
  | "partial-answer-allowed"
  | "needs-focused-research"
  | "contradictory-evidence"
  | "insufficient-evidence"
  | "validator-unavailable";

export type DirectAnswerFeasibility =
  | "strong"
  | "partial"
  | "blocked";

export type EvidenceSufficiencyLevel =
  | "sufficient"
  | "partial"
  | "insufficient";

export type ContradictionLevel =
  | "none"
  | "minor"
  | "major";

export type ValidationRecommendedAction =
  | "run-entrypoint-traversal"
  | "run-reverse-dependency-check"
  | "run-call-chain-expansion"
  | "run-inheritance-expansion"
  | "run-interface-implementation-check"
  | "check-middleware-chain"
  | "check-route-controller-binding"
  | "check-oauth-provider-binding"
  | "check-runtime-locale-resolution"
  | "check-history-guard-flow"
  | "check-config-file"
  | "check-env-fallback"
  | "check-service-provider-registration"
  | "check-framework-binding"
  | "check-model-relation"
  | "check-schema-touchpoints"
  | "check-repository-usage"
  | "check-db-storage-location"
  | "narrow-to-entrypoint"
  | "narrow-to-module"
  | "narrow-to-runtime-path"
  | "drop-noisy-neighbor-zone"
  | "allow-partial-answer"
  | "stop-with-insufficient-evidence"
  | "request-background-refresh"
  | "request-runtime-logs";

export type ValidationRecommendedResearchProfile =
  | "entrypoint-traversal"
  | "storage-topology"
  | "localization-inventory"
  | "config-inventory"
  | "broad-scan"
  | "focused-entrypoint-traversal"
  | "focused-config-check"
  | "focused-runtime-check"
  | "focused-dependency-check"
  | "focused-entity-check";

export interface ValidationGap {
  id: string;
  label: string;
  severity: "low" | "medium" | "high";
  reason: string;
}

export interface ValidationContradiction {
  id: string;
  label: string;
  severity: "low" | "medium" | "high";
  reason: string;
}

export interface ValidationPacket {
  packetId: string;
  runId: string;
  iteration: number;
  task: string;
  questionType: string;
  researchSummary: string;
  functionalSummary: string;
  researchConfidence: number;
  impactSummary: string;
  impactConfidence: number;
  contextSummary: string;
  contextConfidence: number;
  structuralAnchors: string[];
  evidenceHighlights: Array<{
    label: string;
    filePath?: string;
    reason: string;
    score: number;
    origin: ScoredReference["origin"];
  }>;
  graphCoverage: {
    nodeCount: number;
    edgeCount: number;
    relevantAnchorCount: number;
    entryPointCount: number;
  };
  diagnostics: string[];
  backgroundState?: {
    freshness: BackgroundProjectState["freshness"];
    baselineSource: BackgroundProjectState["baselineSource"];
    hasLocalChanges: boolean;
    changedFileCount: number;
  };
  priorActions: ValidationRecommendedAction[];
  remainingIterationBudget: number;
}

export interface ValidationResult {
  validationId: string;
  runId: string;
  iteration: number;
  status: ValidationStatus;
  readinessScore: number;
  directAnswerFeasibility: DirectAnswerFeasibility;
  evidenceSufficiency: EvidenceSufficiencyLevel;
  contradictionLevel: ContradictionLevel;
  gaps: ValidationGap[];
  contradictions: ValidationContradiction[];
  missingConfirmations: string[];
  recommendedActions: ValidationRecommendedAction[];
  // Свободный текст — конкретные сущности/имена/концепты, которых, по мнению
  // валидатора, не хватает в evidence, чтобы отвечать на РЕАЛЬНЫЙ вопрос
  // пользователя. В отличие от recommendedActions (закрытый словарь общих
  // сценариев), это не ограничено фиксированным списком — модель называет то,
  // что она сама понимает как недостающее, исходя из смысла вопроса, а не из
  // заранее заданного меню действий. Используется как targetTokens в
  // FocusedResearchRequest для действительно open-ended re-search.
  missingEntityHints: string[];
  // Ретрив (какие файлы вообще рассматривать) — работа алгоритма. Финальный
  // выбор "какой из НАЙДЕННЫХ кандидатов — реально ответ" — там, где
  // структурный score нескольких файлов близок, а победитель очевиден только
  // по смыслу вопроса, это работа для суждения, не для scoring-эвристики.
  // Значение — точный label одного из evidenceHighlights (пусто, если
  // порядок research-скоринга и так адекватен). Deterministic fallback
  // (без LLM) это поле не трогает — алгоритмический порядок остаётся как есть.
  primaryEvidenceLabel?: string;
  recommendedResearchProfile?: ValidationRecommendedResearchProfile;
  recommendedStopReason?: string;
  rationale: string;
}

export interface FocusedResearchRequest {
  requestId: string;
  runId: string;
  iteration: number;
  profile: ValidationRecommendedResearchProfile;
  actions: ValidationRecommendedAction[];
  focusPaths: string[];
  targetTokens: string[];
  reason: string;
  maxAdditionalFiles: number;
}

export interface FocusedResearchResult {
  requestId: string;
  runId: string;
  iteration: number;
  profile: ValidationRecommendedResearchProfile;
  actions: ValidationRecommendedAction[];
  additionalEvidence: ScoredReference[];
  additionalFindings: string[];
  resolvedContradictions: string[];
  remainingGaps: string[];
  diagnostics: string[];
  deltaSummary: string;
}

export interface ValidatedAnswerPacket {
  packetId: string;
  runId: string;
  questionType: string;
  validationStatus: ValidationStatus;
  readinessScore: number;
  confidenceCeiling: number;
  directAnswerAllowed: boolean;
  mandatoryCaveats: string[];
  validatedEvidence: Array<{
    label: string;
    filePath?: string;
    reason: string;
    origin: ScoredReference["origin"];
  }>;
  validatorRationale: string;
}

export type AnswerMode =
  | "direct-answer"
  | "diagnostic-answer"
  | "plan-summary-answer"
  | "insufficient-data-answer"
  | "fallback-answer"
  | "clarification-needed";

export interface AnswerEvidenceHighlight {
  label: string;
  detail: string;
}

export interface AnswerPackage {
  answerId: string;
  runId: string;
  answerMode: AnswerMode;
  questionType?: string;
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
  validation?: ValidationResult;
  validatedAnswerPacket?: ValidatedAnswerPacket;
  /** Заполнено только при answerMode === "clarification-needed" — см. detectResearchAmbiguity. */
  clarificationOptions?: string[];
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
  validation?: ValidationResult;
  validationHistory?: ValidationResult[];
  validationPacket?: ValidationPacket;
  focusedResearchRequests?: FocusedResearchRequest[];
  focusedResearchResults?: FocusedResearchResult[];
  validatedAnswerPacket?: ValidatedAnswerPacket;
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
  validation?: ValidationResult;
  validationHistory?: ValidationResult[];
  validationPacket?: ValidationPacket;
  focusedResearchRequests?: FocusedResearchRequest[];
  focusedResearchResults?: FocusedResearchResult[];
  validatedAnswerPacket?: ValidatedAnswerPacket;
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

// Много русской разработческой лексики — это не перевод, а фонетическая
// транслитерация английского термина ("алиас", не "псевдоним"; "консоль",
// не "пульт управления"). Идентификаторы/пути в коде почти всегда на
// латинице, поэтому вопрос "как работает сохранение консольного алиаса"
// без этого шага не находит вообще ничего похожего на `ConsoleAlias.php` —
// не потому что скоринг слабый, а потому что "алиас" и "alias" для
// substring-матчинга это два совершенно разных слова в разных алфавитах.
// Список — общая dev-лексика, не привязан ни к одному конкретному проекту.
const RUSSIAN_TECH_TRANSLIT_STEMS: Array<[stem: string, latin: string]> = [
  ["алиас", "alias"],
  ["консол", "console"],
  ["контроллер", "controller"],
  ["роут", "route"],
  ["сервис", "service"],
  ["компонент", "component"],
  ["интерфейс", "interface"],
  ["экшен", "action"],
  ["экшн", "action"],
  ["ивент", "event"],
  ["хендлер", "handler"],
  ["хэндлер", "handler"],
  ["миграц", "migration"],
  ["репозитор", "repository"],
  ["валидатор", "validator"],
  ["провайдер", "provider"],
  ["мидлвар", "middleware"],
  ["мидлвэр", "middleware"],
  ["воркер", "worker"],
  ["джоб", "job"],
  ["токен", "token"],
  ["сессия", "session"],
  ["кэш", "cache"],
  ["кеш", "cache"],
  ["юзер", "user"],
  ["профил", "profile"],
];

export function expandRussianTechTransliteration(tokens: string[]): string[] {
  const expanded = new Set(tokens);

  for (const token of tokens) {
    for (const [stem, latin] of RUSSIAN_TECH_TRANSLIT_STEMS) {
      if (token.startsWith(stem)) {
        expanded.add(latin);
      }
    }
  }

  return [...expanded];
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

// Как scoreText, но токены сгруппированы: группа засчитывается только если
// совпали ВСЕ её элементы. Нужно для составных PascalCase-имён вроде
// "DataEntry" — если считать "data" и "entry" независимо, короткий общий
// фрагмент ("data") совпадает почти с любым файлом в типовой Laravel-структуре
// (Containers/*/Data/...) и топит реальное совпадение шумом. Группа "все
// фрагменты сразу" восстанавливает исходную специфичность составного имени;
// одиночные слова — это группа из одного элемента, ведут себя как раньше.
export function scoreTextGroups(haystack: string, tokenGroups: string[][]): number {
  const normalized = haystack.toLowerCase();
  let score = 0;

  for (const group of tokenGroups) {
    if (group.length > 0 && group.every((token) => normalized.includes(token))) {
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
