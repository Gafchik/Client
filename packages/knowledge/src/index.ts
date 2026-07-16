import { runSql } from "./postgres-client.js";
import { getRedisClient } from "./redis-client.js";
import { deleteFactsForPath } from "./facts.js";
import { deleteBusinessGraphEntriesForPath } from "./graph-entries.js";
import { pruneCodeEmbeddings } from "./code-embeddings.js";
import { deleteGlossaryEntriesForPath } from "./glossary.js";

// Read-through cache over knowledge_artifacts (2026-07-15, user's explicit
// request): Postgres stays the durable source of truth - Redis here has no
// persistence enabled (docker-compose.yml, deliberately, to keep it a safe
// disposable cache) so losing it costs nothing but a cache-repopulate, never
// history. Note this honestly does not move the needle on perceived speed -
// a single indexed Postgres row read is already low-single-digit
// milliseconds; the real time in a question-run is LLM calls (60-200s+).
// This exists for the "reads should come from RAM, not disk" principle, not
// because DB reads were ever the bottleneck.
const KNOWLEDGE_ARTIFACT_CACHE_TTL_SECONDS = 60 * 60 * 6;

function knowledgeArtifactCacheKey(runId: string): string {
  return `knowledge-artifact:${runId}`;
}

export { deleteFactsForPath, promoteFactsFromResearch, queryFactsAcrossPaths, queryRelevantFacts } from "./facts.js";
export {
  deleteBusinessGraphEntriesForPath,
  hashFiles,
  queryBusinessGraphEntries,
  queryBusinessGraphEntriesAcrossPaths,
  upsertBusinessGraphEntry,
  type BusinessGraphEntry,
  type UpsertBusinessGraphEntryInput,
} from "./graph-entries.js";
export {
  deleteGlossaryEntriesForPath,
  queryGlossaryAcrossPaths,
  upsertGlossaryEntry,
  type DomainGlossaryEntry,
  type UpsertGlossaryEntryInput,
} from "./glossary.js";
export {
  findSemanticMatches,
  findSemanticMatchesAcrossPaths,
  getCodeEmbeddingContentHashes,
  pruneCodeEmbeddings,
  upsertCodeEmbedding,
  type CodeEmbeddingMatch,
  type CrossPathCodeEmbeddingMatch,
  type UpsertCodeEmbeddingInput,
} from "./code-embeddings.js";
import type { PipelineRunMode } from "@client/shared";
import {
  type AnswerPackage,
  type BackgroundProjectState,
  type ControlledExecutionRuntime,
  type ContextPackage,
  type ExecutionPlan,
  type ExecutionPreview,
  type FocusedResearchRequest,
  type FocusedResearchResult,
  type GraphState,
  type ImpactReport,
  type IndexResult,
  type KnowledgeCatalogEntry,
  type KnowledgeSaveResult,
  type PipelineWorkspaceDetails,
  type PipelineRunResult,
  type ProviderRuntimeConfig,
  type ProviderUsageSummary,
  type RepositorySnapshot,
  type ResearchReport,
  stableId,
  type ValidatedAnswerPacket,
  type ValidationPacket,
  type ValidationResult,
  type WorkspaceSnapshot,
} from "@client/shared";

interface SaveKnowledgeInput {
  runId: string;
  mode: PipelineRunResult["mode"];
  conversationId: string;
  turnIndex: number;
  task: string;
  appRootPath: string;
  workspace: WorkspaceSnapshot;
  repository: RepositorySnapshot;
  backgroundState?: BackgroundProjectState;
  provider: ProviderRuntimeConfig;
  index: IndexResult;
  incrementalIndex: PipelineRunResult["incrementalIndex"];
  graph: GraphState;
  graphInvalidation: PipelineRunResult["graphInvalidation"];
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
  usage?: ProviderUsageSummary;
}

interface PersistedWorkspaceSummary {
  projectName: string;
  rootPath: string;
  summary: WorkspaceSnapshot["summary"];
}

interface PersistedPipelineRunArtifact {
  runId?: string;
  mode?: PipelineRunResult["mode"];
  conversationId?: string;
  turnIndex?: number;
  task?: string;
  savedAt?: string;
  project?: PipelineRunResult["project"];
  workspace?: PersistedWorkspaceSummary;
  repository?: RepositorySnapshot;
  backgroundState?: BackgroundProjectState;
  provider?: ProviderRuntimeConfig;
  index?: PipelineRunResult["index"];
  incrementalIndex?: PipelineRunResult["incrementalIndex"];
  graph?: PipelineRunResult["graph"];
  graphInvalidation?: PipelineRunResult["graphInvalidation"];
  stages?: PipelineRunResult["stages"];
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
  knowledge?: KnowledgeSaveResult;
  runtimeCache?: PipelineRunResult["runtimeCache"];
  usage?: ProviderUsageSummary;
}

export async function saveKnowledgeArtifacts(input: SaveKnowledgeInput): Promise<KnowledgeSaveResult> {
  const savedAt = new Date().toISOString();

  const knowledge: KnowledgeSaveResult = {
    runId: input.runId,
    savedAt,
    storagePath: "postgres:knowledge_artifacts",
    catalogPath: "postgres:knowledge_catalog",
    artifactCount: 5,
  };

  const artifact = {
    runId: input.runId,
    mode: input.mode,
    conversationId: input.conversationId,
    turnIndex: input.turnIndex,
    task: input.task,
    savedAt,
    project: {
      name: input.workspace.projectName,
      rootPath: input.workspace.rootPath,
      summary: input.workspace.summary,
    },
    workspace: {
      projectName: input.workspace.projectName,
      rootPath: input.workspace.rootPath,
      summary: input.workspace.summary,
    },
    repository: input.repository,
    ...(input.backgroundState
      ? {
          backgroundState: input.backgroundState,
        }
      : {}),
    provider: input.provider,
    index: {
      manifest: input.index.manifest,
      stats: input.index.stats,
      diagnostics: input.index.diagnostics,
    },
    incrementalIndex: input.incrementalIndex,
    graph: {
      graphId: input.graph.graphId,
      summary: input.graph.summary,
    },
    graphInvalidation: input.graphInvalidation,
    research: input.research,
    impact: input.impact,
    context: input.context,
    plan: input.plan,
    executionPreview: input.executionPreview,
    executionRuntime: input.executionRuntime,
    ...(input.validation
      ? {
          validation: input.validation,
        }
      : {}),
    ...(input.validationHistory
      ? {
          validationHistory: input.validationHistory,
        }
      : {}),
    ...(input.validationPacket
      ? {
          validationPacket: input.validationPacket,
        }
      : {}),
    ...(input.focusedResearchRequests
      ? {
          focusedResearchRequests: input.focusedResearchRequests,
        }
      : {}),
    ...(input.focusedResearchResults
      ? {
          focusedResearchResults: input.focusedResearchResults,
        }
      : {}),
    ...(input.validatedAnswerPacket
      ? {
          validatedAnswerPacket: input.validatedAnswerPacket,
        }
      : {}),
    answer: input.answer,
    knowledge,
    // Live evidence (2026-07-15): runtimeCache (the full project index+graph)
    // had bloated individual question-run artifacts to 128-150MB each -
    // confirmed by reading loadBestBaselineRunArtifact just above: it only
    // ever selects among mode === "background-sync" entries, so a
    // question-run's own runtimeCache is never read back by anything. Only
    // background-sync (the run whose whole purpose is refreshing the
    // reusable baseline) needs to carry it.
    ...(input.mode === "background-sync"
      ? {
          runtimeCache: {
            index: input.index,
            graph: input.graph,
          },
        }
      : {}),
    ...(input.usage ? { usage: input.usage } : {}),
  };

  // upsert по run_id — атомарный, никакого read-modify-write и гонок между
  // параллельными run'ами (см. историю в git blame: раньше catalog.json
  // обновлялся через read-modify-write целого файла, и параллельный
  // background-sync мог затереть свежесохранённый вопрос пользователя).
  // Тот же upsert-приём теперь и для тела артефакта (knowledge_artifacts) -
  // было файлом на диске, требование пользователя (2026-07-15): ничего в
  // файлах, всё в Postgres.
  await runSql(
    `
      insert into knowledge_artifacts (run_id, body, saved_at)
      values ($1, $2::jsonb, $3)
      on conflict (run_id) do update set
        body = $2::jsonb,
        saved_at = $3
    `,
    [input.runId, JSON.stringify(artifact), savedAt],
  );

  await runSql(
    `
      insert into knowledge_catalog
        (run_id, project_root_path, task, saved_at, storage_path, summary, mode, repository_id, branch, head_commit, head_fingerprint, conversation_id, turn_index, prompt_tokens, completion_tokens, total_tokens, provider_call_count, file_count)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
      on conflict (run_id) do update set
        project_root_path = $2,
        task = $3,
        saved_at = $4,
        storage_path = $5,
        summary = $6,
        mode = $7,
        repository_id = $8,
        branch = $9,
        head_commit = $10,
        head_fingerprint = $11,
        conversation_id = $12,
        turn_index = $13,
        prompt_tokens = $14,
        completion_tokens = $15,
        total_tokens = $16,
        provider_call_count = $17,
        file_count = $18
    `,
    [
      input.runId,
      input.workspace.rootPath,
      input.task,
      savedAt,
      knowledge.storagePath,
      input.research.summary,
      input.mode,
      input.repository.repositoryId ?? null,
      input.repository.branch ?? null,
      input.repository.headCommit ?? null,
      input.repository.headFingerprint ?? null,
      input.conversationId,
      input.turnIndex,
      input.usage?.promptTokens ?? 0,
      input.usage?.completionTokens ?? 0,
      input.usage?.totalTokens ?? 0,
      input.usage?.callCount ?? 0,
      input.index.manifest.fileCount,
    ],
  );

  return knowledge;
}

interface KnowledgeCatalogRow {
  run_id: string;
  task: string;
  saved_at: Date;
  storage_path: string;
  summary: string;
  mode: string;
  repository_id: string | null;
  branch: string | null;
  head_commit: string | null;
  head_fingerprint: string | null;
  conversation_id: string | null;
  turn_index: number | null;
  file_count: number | null;
}

function mapKnowledgeCatalogRow(row: KnowledgeCatalogRow): KnowledgeCatalogEntry {
  return {
    runId: row.run_id,
    task: row.task,
    savedAt: new Date(row.saved_at).toISOString(),
    storagePath: row.storage_path,
    summary: row.summary,
    mode: row.mode as PipelineRunMode,
    ...(row.repository_id ? { repositoryId: row.repository_id } : {}),
    ...(row.branch ? { branch: row.branch } : {}),
    ...(row.head_commit ? { headCommit: row.head_commit } : {}),
    ...(row.head_fingerprint ? { headFingerprint: row.head_fingerprint } : {}),
    // Старые строки, сохранённые до появления диалогов, conversation_id не
    // имеют — считаем такую реплику началом своего собственного треда из
    // одного хода (тем же способом, что normalizePipelineRunArtifact
    // делает для полного артефакта).
    conversationId: row.conversation_id ?? row.run_id,
    turnIndex: row.turn_index ?? 0,
    ...(row.file_count ? { fileCount: row.file_count } : {}),
  };
}

export async function loadKnowledgeCatalog(_appRootPath: string, projectRootPath: string): Promise<KnowledgeCatalogEntry[]> {
  const rows = await runSql<KnowledgeCatalogRow>(
    `
      select * from knowledge_catalog
      where project_root_path = $1
      order by saved_at desc
      limit 20
    `,
    [projectRootPath],
  );

  return rows.map(mapKnowledgeCatalogRow);
}

/**
 * Все реплики одного диалога, по порядку от первой к последней. В отличие от
 * loadKnowledgeCatalog (лимит 20, любые mode вперемешку по всему проекту),
 * здесь фильтр по conversation_id и без общего лимита — диалог может быть
 * длиннее 20 последних действий проекта (background-sync и другие чаты не
 * должны вытеснять реплики этого же треда).
 */
export async function loadConversationTurns(
  appRootPath: string,
  projectRootPath: string,
  conversationId: string,
): Promise<PipelineRunResult[]> {
  const rows = await runSql<KnowledgeCatalogRow>(
    `
      select * from knowledge_catalog
      where project_root_path = $1 and conversation_id = $2
      order by turn_index asc
    `,
    [projectRootPath, conversationId],
  );

  const results = await Promise.all(
    rows.map((row) => loadPipelineRunArtifact(appRootPath, projectRootPath, row.run_id)),
  );

  return results.filter((item): item is PipelineRunResult => Boolean(item));
}

/** Последняя (по turn_index) уже сохранённая реплика диалога — используется как prior-turn контекст для следующей. */
export async function loadLatestConversationTurn(
  appRootPath: string,
  projectRootPath: string,
  conversationId: string,
): Promise<PipelineRunResult | null> {
  const rows = await runSql<KnowledgeCatalogRow>(
    `
      select * from knowledge_catalog
      where project_root_path = $1 and conversation_id = $2
      order by turn_index desc
      limit 1
    `,
    [projectRootPath, conversationId],
  );
  const row = rows[0];

  if (!row) {
    return null;
  }

  return loadPipelineRunArtifact(appRootPath, projectRootPath, row.run_id);
}

/**
 * Удаляет один или несколько run/чатов проекта: файл артефакта `runs/<runId>.json`
 * и запись в knowledge_catalog (источник списка чатов в сайдбаре фронта).
 * Отсутствующий файл артефакта не считается ошибкой — каталог всё равно
 * очищается от "битой" ссылки.
 */
export async function deleteKnowledgeRuns(
  _appRootPath: string,
  projectRootPath: string,
  runIds: string[],
): Promise<{ deleted: string[]; notFound: string[] }> {
  const idsToDelete = [...new Set(runIds)];

  const existingRows = await runSql<{ run_id: string }>(
    `select run_id from knowledge_artifacts where run_id = any($1::text[])`,
    [idsToDelete],
  );
  const existingIds = new Set(existingRows.map((row) => row.run_id));
  const deleted = idsToDelete.filter((runId) => existingIds.has(runId));
  const notFound = idsToDelete.filter((runId) => !existingIds.has(runId));

  await runSql(`delete from knowledge_artifacts where run_id = any($1::text[])`, [idsToDelete]);
  await runSql(
    `delete from knowledge_catalog where project_root_path = $1 and run_id = any($2::text[])`,
    [projectRootPath, idsToDelete],
  );

  if (idsToDelete.length > 0) {
    try {
      await getRedisClient().del(...idsToDelete.map(knowledgeArtifactCacheKey));
    } catch (error) {
      console.warn("[knowledge] redis cache invalidation failed (stale entries self-heal via TTL):", error);
    }
  }

  return { deleted, notFound };
}

/**
 * Forgets EVERYTHING ever learned about one physical repository (2026-07-16,
 * live bug found during verification: deleting a project or removing one
 * path from it left knowledge_catalog/knowledge_artifacts/project_facts/
 * business_graph_entries/code_embeddings rows behind forever - none of them
 * has a foreign key to projects/project_paths, only a plain project_root_path
 * string match, so ON DELETE CASCADE never reached them). Called from
 * apps/api's deleteProject (for every path of the deleted project) and from
 * saveProject (for any path removed from an existing project's path list).
 * Never throws - a project delete/edit must succeed even if cleanup of one
 * table degrades.
 */
export async function forgetProjectPath(projectRootPath: string): Promise<void> {
  try {
    const runRows = await runSql<{ run_id: string }>(
      `select run_id from knowledge_catalog where project_root_path = $1`,
      [projectRootPath],
    );
    await deleteKnowledgeRuns("", projectRootPath, runRows.map((row) => row.run_id));
  } catch (error) {
    console.warn("[knowledge] forgetProjectPath: run/artifact cleanup failed:", error);
  }

  await deleteFactsForPath(projectRootPath);
  await deleteBusinessGraphEntriesForPath(projectRootPath);
  await deleteGlossaryEntriesForPath(projectRootPath);
  await pruneCodeEmbeddings(projectRootPath, []);
}

export async function loadPipelineRunArtifact(
  _appRootPath: string,
  _projectRootPath: string,
  runId: string,
): Promise<PipelineRunResult | null> {
  const cacheKey = knowledgeArtifactCacheKey(runId);

  try {
    const cached = await getRedisClient().get(cacheKey);

    if (cached) {
      return JSON.parse(cached) as PipelineRunResult;
    }
  } catch (error) {
    console.warn("[knowledge] redis cache read failed, falling back to Postgres:", error);
  }

  const rows = await runSql<{ body: PersistedPipelineRunArtifact }>(
    `select body from knowledge_artifacts where run_id = $1`,
    [runId],
  );
  const row = rows[0];

  if (!row) {
    return null;
  }

  const result = normalizePipelineRunArtifact(row.body, runId, "postgres:knowledge_artifacts");

  if (result) {
    try {
      await getRedisClient().set(cacheKey, JSON.stringify(result), "EX", KNOWLEDGE_ARTIFACT_CACHE_TTL_SECONDS);
    } catch (error) {
      console.warn("[knowledge] redis cache write failed (Postgres remains source of truth):", error);
    }
  }

  return result;
}

/**
 * "Последний run" в смысле чата — это последний реальный вопрос пользователя,
 * а не последняя запись каталога вообще. background-sync — служебная фоновая
 * пересборка project intelligence, у неё своя семантика (см.
 * `loadLatestBackgroundRunCatalogEntry`) и она не должна попадать сюда: иначе
 * задача/ответ на экране чата могут относиться к двум разным run'ам, если
 * background-sync завершился позже, чем реальный вопрос пользователя.
 */
export async function loadLatestPipelineRunArtifact(
  appRootPath: string,
  projectRootPath: string,
): Promise<PipelineRunResult | null> {
  const catalog = await loadKnowledgeCatalog(appRootPath, projectRootPath);
  const latestRun = catalog.find((entry) => entry.mode !== "background-sync");

  if (!latestRun) {
    return null;
  }

  return loadPipelineRunArtifact(appRootPath, projectRootPath, latestRun.runId);
}

export async function loadLatestBackgroundRunArtifact(
  appRootPath: string,
  projectRootPath: string,
): Promise<PipelineRunResult | null> {
  const catalog = await loadKnowledgeCatalog(appRootPath, projectRootPath);
  const latestBackground = catalog.find((entry) => entry.mode === "background-sync");

  if (!latestBackground) {
    return null;
  }

  return loadPipelineRunArtifact(appRootPath, projectRootPath, latestBackground.runId);
}

export async function loadLatestBackgroundRunCatalogEntry(
  appRootPath: string,
  projectRootPath: string,
): Promise<KnowledgeCatalogEntry | null> {
  const catalog = await loadKnowledgeCatalog(appRootPath, projectRootPath);
  return catalog.find((entry) => entry.mode === "background-sync") ?? null;
}

export async function loadAllPipelineRunArtifacts(
  appRootPath: string,
  projectRootPath: string,
): Promise<PipelineRunResult[]> {
  const catalog = await loadKnowledgeCatalog(appRootPath, projectRootPath);
  const results = await Promise.all(
    catalog.map((entry) => loadPipelineRunArtifact(appRootPath, projectRootPath, entry.runId)),
  );

  return results.filter((item): item is PipelineRunResult => Boolean(item));
}

/**
 * Выбор лучшей baseline-записи ПО КАТАЛОГУ, без загрузки самого артефакта.
 * Выделено из loadBestBaselineRunArtifact (2026-07-16): живой замер показал,
 * что background-sync артефакт реального проекта — ~120MB сырого JSON
 * (44MB сжатого в TOAST), а project-state-monitor и GET-статус проекта
 * загружали и парсили его целиком каждые 15 секунд на каждый project path
 * ради runId/headCommit/headFingerprint/fileCount — всё это уже есть в
 * лёгких строках knowledge_catalog. Полный артефакт остался нужен только
 * самому pipeline-runner'у (runtimeCache для reuse графа/индекса).
 */
export async function loadBestBaselineCatalogEntry(
  appRootPath: string,
  projectRootPath: string,
  repository: RepositorySnapshot,
): Promise<{
  entry: KnowledgeCatalogEntry | null;
  source: BackgroundProjectState["baselineSource"];
}> {
  const catalog = (await loadKnowledgeCatalog(appRootPath, projectRootPath))
    .filter((entry) => entry.mode === "background-sync");

  if (catalog.length === 0) {
    return { entry: null, source: "none" };
  }

  const exactHead = catalog.find((entry) =>
    entry.repositoryId === repository.repositoryId
    && entry.headCommit === repository.headCommit,
  );

  if (exactHead) {
    return { entry: exactHead, source: "exact-head" };
  }

  const mergeBase = catalog.find((entry) =>
    entry.repositoryId === repository.repositoryId
    && entry.headCommit === repository.mergeBase,
  );

  if (mergeBase) {
    return { entry: mergeBase, source: "merge-base" };
  }

  const recentBranch = catalog.find((entry) =>
    entry.repositoryId === repository.repositoryId
    && entry.branch === repository.branch,
  );

  if (recentBranch) {
    return { entry: recentBranch, source: "recent-branch" };
  }

  return { entry: catalog[0] ?? null, source: catalog[0] ? "recent-branch" : "none" };
}

/** Метаданные baseline, достаточные для buildBackgroundProjectState — структурное подмножество PipelineRunResult (полный run подходит без преобразований). */
export interface BaselineRunMetadata {
  runId: string;
  repository: { headCommit: string; headFingerprint: string };
  index: { manifest: { reusedFileCount?: number; fileCount?: number } };
}

/** Каталожная запись → метаданные baseline (без загрузки артефакта). null, если запись без fingerprint'ов (артефакт до их появления). */
export function catalogEntryToBaselineMetadata(entry: KnowledgeCatalogEntry | null): BaselineRunMetadata | null {
  if (!entry?.headCommit || !entry.headFingerprint) {
    return null;
  }

  return {
    runId: entry.runId,
    repository: { headCommit: entry.headCommit, headFingerprint: entry.headFingerprint },
    index: { manifest: entry.fileCount ? { fileCount: entry.fileCount } : {} },
  };
}

export async function loadBestBaselineRunArtifact(
  appRootPath: string,
  projectRootPath: string,
  repository: RepositorySnapshot,
): Promise<{
  run: PipelineRunResult | null;
  source: BackgroundProjectState["baselineSource"];
}> {
  const selection = await loadBestBaselineCatalogEntry(appRootPath, projectRootPath, repository);

  if (!selection.entry) {
    return { run: null, source: "none" };
  }

  return {
    run: await loadPipelineRunArtifact(appRootPath, projectRootPath, selection.entry.runId),
    source: selection.source,
  };
}

export function buildBackgroundProjectState(input: {
  projectId: string;
  projectRootPath: string;
  repository: RepositorySnapshot;
  latestRunId?: string | null;
  // BaselineRunMetadata, а не PipelineRunResult (2026-07-16): функция всегда
  // читала из baseline только runId/headCommit/headFingerprint/manifest-счётчики.
  // Полный PipelineRunResult подходит структурно — pipeline-runner передаёт
  // его как раньше; монитор и статус-эндпоинт передают лёгкие метаданные
  // из каталога (catalogEntryToBaselineMetadata) вместо 120MB артефакта.
  baselineRun: BaselineRunMetadata | null;
  baselineSource: BackgroundProjectState["baselineSource"];
}): BackgroundProjectState {
  const latestRunId = input.latestRunId ?? undefined;
  const baselineRunId = input.baselineRun?.runId;
  const baselineHeadCommit = input.baselineRun?.repository.headCommit;
  const exactHeadMatch = input.baselineRun?.repository.headFingerprint === input.repository.headFingerprint;
  const freshness: BackgroundProjectState["freshness"] =
    !input.baselineRun
      ? "missing"
      : exactHeadMatch
        ? "fresh"
        : "stale";
  const syncStatus: BackgroundProjectState["syncStatus"] =
    !input.repository.isGitRepository
      ? "degraded"
      : freshness === "fresh"
        ? "ready"
        : "syncing";
  const reusableFileCount = input.baselineRun?.index.manifest.reusedFileCount
    ?? input.baselineRun?.index.manifest.fileCount
    ?? 0;
  const invalidatedFileCount = input.repository.summary.changedFileCount;
  const worktreeStatus: BackgroundProjectState["worktreeStatus"] =
    input.repository.hasUnmergedPaths
      ? "conflict"
      : input.repository.isDirty
        ? "overlay"
        : "clean";

  return {
    stateId: stableId([
      "background-project-state",
      input.projectId,
      input.repository.headFingerprint,
      input.repository.stateFingerprint,
      latestRunId ?? "none",
      baselineRunId ?? "none",
    ]),
    projectId: input.projectId,
    projectRootPath: input.projectRootPath,
    repositoryId: input.repository.repositoryId,
    branch: input.repository.branch,
    headCommit: input.repository.headCommit,
    headFingerprint: input.repository.headFingerprint,
    mergeBase: input.repository.mergeBase,
    branchFingerprint: input.repository.branchFingerprint,
    worktreeFingerprint: input.repository.worktreeFingerprint,
    stateFingerprint: input.repository.stateFingerprint,
    ...(latestRunId ? { latestRunId } : {}),
    ...(baselineRunId ? { baselineRunId } : {}),
    ...(baselineHeadCommit ? { baselineHeadCommit } : {}),
    baselineSource: input.baselineSource,
    baselineExactForHead: exactHeadMatch,
    freshness,
    syncStatus,
    worktreeStatus,
    hasLocalChanges: input.repository.isDirty,
    changedFileCount: input.repository.summary.changedFileCount,
    reusableFileCount,
    invalidatedFileCount,
    refreshedAt: new Date().toISOString(),
    diagnostics: [
      ...input.repository.diagnostics,
      ...(input.repository.isDirty
        ? ["Есть локальные незакоммиченные изменения. Они учитываются через worktree overlay и не должны автоматически становиться committed baseline."]
        : []),
      ...(freshness === "stale"
        ? ["Фоновое понимание проекта устарело относительно текущего branch/head состояния репозитория."]
        : []),
      ...(freshness === "missing"
        ? ["Для текущего branch/head состояния ещё нет сохранённого background baseline run."]
        : []),
    ].slice(0, 8),
  };
}

function normalizePipelineRunArtifact(
  artifact: PersistedPipelineRunArtifact,
  runId: string,
  storagePath: string,
): PipelineRunResult | null {
  if (
    !artifact.runId ||
    !artifact.workspace ||
    !artifact.repository ||
    !artifact.provider ||
    !artifact.index ||
    !artifact.graph ||
    !artifact.research ||
    !artifact.impact
  ) {
    return null;
  }

  const project = artifact.project ?? {
    name: artifact.workspace.projectName,
    rootPath: artifact.workspace.rootPath,
    summary: artifact.workspace.summary,
  };
  const workspace: PipelineWorkspaceDetails = "scannedAt" in artifact.workspace
    ? artifact.workspace as unknown as PipelineWorkspaceDetails
    : {
        scannedAt: artifact.savedAt ?? new Date(0).toISOString(),
        ignoredPaths: [],
        diagnostics: [],
      };

  const knowledge: KnowledgeSaveResult = artifact.knowledge ?? {
    runId: artifact.runId,
    savedAt: artifact.savedAt ?? new Date(0).toISOString(),
    storagePath,
    catalogPath: "postgres:knowledge_catalog",
    artifactCount: 8,
  };

  const context: ContextPackage = artifact.context ?? {
    contextId: stableId(["context", artifact.runId]),
    runId: artifact.runId,
    summary: "Контекстный пакет отсутствовал в старом артефакте и был восстановлен в режиме совместимости.",
    functionalHighlights: artifact.research.functionalSummary ? [artifact.research.functionalSummary] : [],
    focusZones: artifact.research.affectedModules ?? [],
    rankingSummary: ["Старый артефакт не содержал ranking summary; данные восстановлены в режиме совместимости."],
    tokenBudget: 0,
    estimatedTokens: 0,
    includedFiles: [],
    selectedChunks: [],
    omittedCandidates: [],
    rules: ["Совместимость со старым run-артефактом без модуля сборки контекста."],
    confidence: artifact.research.confidence ?? 0,
  };

  const plan: ExecutionPlan = artifact.plan ?? {
    planId: stableId(["plan", artifact.runId]),
    runId: artifact.runId,
    summary: "План выполнения отсутствовал в старом артефакте и был восстановлен в режиме совместимости.",
    strategy: "sequential",
    risks: artifact.impact.risks ?? [],
    targetModules: artifact.research.affectedModules ?? [],
    targetFiles: artifact.impact.affectedFiles ?? [],
    entryPoints: artifact.research.entryPoints ?? [],
    validationScope: artifact.impact.validationScope ?? [],
    planningNotes: ["Старый артефакт не содержал planning notes; данные восстановлены в режиме совместимости."],
    dependencyChains: [],
    approvalRequired: true,
    steps: [],
  };

  const executionPreview: ExecutionPreview = artifact.executionPreview ?? {
    previewId: stableId(["execution-preview", artifact.runId]),
    runId: artifact.runId,
    mode: "safe-preview",
    summary: "Превью выполнения отсутствовало в старом артефакте и было восстановлено в режиме совместимости.",
    allowedActions: [],
    blockedActions: [],
    reindexRequired: true,
    graphRefreshRequired: true,
    knowledgeRefreshRequired: true,
  };

  const executionRuntime: ControlledExecutionRuntime = artifact.executionRuntime ?? {
    runtimeId: stableId(["controlled-runtime", artifact.runId]),
    runId: artifact.runId,
    mode: "controlled-runtime",
    status: "blocked",
    summary: "Controlled runtime отсутствовал в старом артефакте и был восстановлен в режиме совместимости.",
    allowedWriteFiles: [],
    blockedWriteZones: [".git", ".client/knowledge"],
    scopeGuards: ["Старый артефакт не содержал execution runtime contract."],
    approvalChecks: ["Перед execution требуется повторный запуск pipeline на новом формате артефакта."],
    refreshPlan: ["После изменений обязательны reindex, graph refresh и knowledge refresh."],
    executionAllowed: false,
  };

  const stages = artifact.stages ?? [];

  return {
    runId: artifact.runId,
    mode: artifact.mode ?? "question-run",
    // Старые артефакты (до появления диалогов) не имеют conversationId —
    // трактуем такую реплику как начало собственного треда из одного хода.
    conversationId: artifact.conversationId ?? artifact.runId,
    turnIndex: artifact.turnIndex ?? 0,
    project,
    workspace,
    repository: artifact.repository,
    provider: artifact.provider,
    index: artifact.index,
    ...(artifact.incrementalIndex ? { incrementalIndex: artifact.incrementalIndex } : {}),
    graph: artifact.graph,
    ...(artifact.graphInvalidation ? { graphInvalidation: artifact.graphInvalidation } : {}),
    stages,
    research: {
      ...artifact.research,
      intentClass: artifact.research.intentClass ?? "broad-unknown",
      strategyKey: artifact.research.strategyKey ?? "broad-repository-scan",
      queryProfileKey: artifact.research.queryProfileKey ?? "broad-scan",
      functionalSummary: artifact.research.functionalSummary ?? "Функциональная сводка отсутствовала в старом артефакте.",
      dominantModule: artifact.research.dominantModule ?? "не определён",
      moduleIntents: artifact.research.moduleIntents ?? [],
      entryPoints: artifact.research.entryPoints ?? [],
      primaryEntities: artifact.research.primaryEntities ?? [],
      sideEffects: artifact.research.sideEffects ?? [],
      dataSources: artifact.research.dataSources ?? [],
    },
    impact: artifact.impact,
    context,
    plan,
    executionPreview,
    executionRuntime,
    ...(artifact.validation
      ? {
          validation: artifact.validation,
        }
      : {}),
    ...(artifact.validationHistory
      ? {
          validationHistory: artifact.validationHistory,
        }
      : {}),
    ...(artifact.validationPacket
      ? {
          validationPacket: artifact.validationPacket,
        }
      : {}),
    ...(artifact.focusedResearchRequests
      ? {
          focusedResearchRequests: artifact.focusedResearchRequests,
        }
      : {}),
    ...(artifact.focusedResearchResults
      ? {
          focusedResearchResults: artifact.focusedResearchResults,
        }
      : {}),
    ...(artifact.validatedAnswerPacket
      ? {
          validatedAnswerPacket: artifact.validatedAnswerPacket,
        }
      : {}),
    answer:
      artifact.answer
      ?? {
        answerId: stableId(["answer", artifact.runId]),
        runId: artifact.runId,
        answerMode: "fallback-answer",
        summary: artifact.research.summary,
        explanation: artifact.research.functionalSummary ?? artifact.research.summary,
        evidenceHighlights: safeEvidenceHighlights(artifact.research.findings ?? []),
        confirmedFacts: [],
        unconfirmedFacts: artifact.research.unknowns ?? [],
        manualChecks: ["Для полноценного answer synthesis требуется повторный запуск pipeline на новом формате."],
        confidence: artifact.research.confidence ?? 0,
        unknowns: artifact.research.unknowns ?? [],
        warnings: ["Старый артефакт не содержал Answer Package и был восстановлен в режиме совместимости."],
        nextActions: ["Для полноценного answer synthesis требуется повторный запуск pipeline на новом формате."],
        inspectorHints: ["Открыть Research и Plan для деталей."],
        generatedAt: knowledge.savedAt,
        synthesis: "deterministic-fallback",
      },
    knowledge: {
      ...knowledge,
      artifactCount: knowledge.artifactCount ?? 8,
    },
    ...(artifact.backgroundState
      ? {
          backgroundState: artifact.backgroundState as BackgroundProjectState,
        }
      : {}),
    ...(artifact.runtimeCache && artifact.runtimeCache.index && artifact.runtimeCache.graph
      ? {
          runtimeCache: {
            index: artifact.runtimeCache.index as IndexResult,
            graph: artifact.runtimeCache.graph as GraphState,
          },
        }
      : {}),
    ...(artifact.usage ? { usage: artifact.usage } : {}),
  };
}

function safeEvidenceHighlights(findings: string[]): Array<{ label: string; detail: string }> {
  return findings.slice(0, 3).map((finding, index) => ({
    label: `Finding ${index + 1}`,
    detail: finding,
  }));
}
