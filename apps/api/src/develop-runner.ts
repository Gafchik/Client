import path from "node:path";
import { promises as fs } from "node:fs";
import { runDevelopmentTask, runShellCommand, type DevelopRunResult, type DevelopSensitiveAction, type WorkspaceRoot } from "@client/agentic-research";
import { classifyFactConflict, embedTexts, extractCodePatternFacts } from "@client/ai";
import { getFileDependents } from "@client/graph";
import { loadChatAttachmentsByIds, promoteFactsFromDevelopment, queryFactsAcrossPaths, queryGlossaryAcrossPaths } from "@client/knowledge";
import { collectWorktreeChanges, createTaskSession, type TaskWorktree } from "@client/repository-git";
import { normalizePath, stableId, type GraphState, type ProjectPathRecord } from "@client/shared";
import { buildReadOtherBranchTool } from "./branch-inspect-tool.js";
import { buildDbQueryTool, checkDockerComposeHealth } from "./db-query-tool.js";
import { loadGraphSnapshot, refreshGraphForChangedFiles } from "./graph-store.js";
import { buildAttachmentContextHint, buildGlossaryHint, buildGraphNavigationTool, buildKnownFactsHint, buildObserverHintSuffix, buildSemanticSearchTool, buildSemanticSeedLookup } from "./pipeline-runner.js";
import { runSql } from "./postgres-client.js";

/**
 * Developer pipeline orchestration (docs/architecture/011-developer-pipeline.md).
 * Deliberately thin: isolation (worktrees) + memory injection + telemetry.
 * All reasoning lives in packages/agentic-research's develop-loop - this file
 * must never grow decision-making of its own.
 */

export interface DevelopWorktreeInfo {
  label: string;
  rootPath: string;
  worktreePath: string;
  branch: string;
  /** Diff baseline - carried so a correction run can keep diffing against the ORIGINAL start, not its own. */
  startCommit: string;
}

export interface DevelopRunStatusRecord {
  runId: string;
  /** Chat thread this run belongs to - corrections in the same thread continue this run's worktree. */
  conversationId: string;
  status: "running" | "completed" | "failed";
  task: string;
  projectPath: string;
  developerModel: string;
  reviewerModel: string;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  progress?: { turn: number; filesChanged: number; phase: string };
  /** Kept (with the task branch) when a diff was delivered - the human merges by hand in v1. Empty when cleaned up. */
  worktrees: DevelopWorktreeInfo[];
  result?: DevelopRunResult;
  errorMessage?: string;
  /** Task-decomposition chain (2026-07-18) - which link in the planned sequence this run is. */
  chainInfo?: { subtaskIndex: number; totalSubtasks: number };
  /**
   * Set once this link's success auto-starts the next one - lets a caller
   * that only has THIS runId follow the chain without re-deriving it from
   * conversationId. Absent means either not chained, or this was the last link.
   */
  chainNextRunId?: string;
  /**
   * Tests-as-separate-step (2026-07-18, docs/architecture/011 §4.12): set
   * once (never again for this record) when the "покрыть тестами?" question
   * has been appended to this run's summary - the chat routing in app.ts
   * checks this to know whether the conversation's NEXT message should be
   * classified as an answer to that question before falling through to
   * normal chat-intent routing.
   */
  testsOffered?: boolean;
  /**
   * "И сразу занеси это в ветку" said inside the ORIGINAL task message
   * (2026-07-18, see classifyAutoMergeIntent in packages/ai) - carried
   * across every link of a decomposed chain (maybeAdvanceChain re-passes it
   * to each next startDevelopRun call) so it still fires on the link that
   * actually finishes the whole task, not just the first one.
   */
  autoMergeOnCompletion?: boolean;
  /** Set once autoMergeOnCompletion has actually fired (or a manual merge-to-checkout button/command ran) - lets the frontend show the outcome without the user having to ask again. */
  autoMergeOutcome?: MergeToBranchOutcome[];
}

export interface DevelopWorktreeRegistryEntry {
  runId: string;
  conversationId: string;
  projectPath: string;
  task: string;
  status: DevelopRunStatusRecord["status"];
  startedAt: string;
  finishedAt?: string;
  worktrees: DevelopWorktreeInfo[];
  autoMergeOutcome?: MergeToBranchOutcome[];
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface StartDevelopRunInput {
  task: string;
  projectPath: string;
  projectPaths?: ProjectPathRecord[];
  providerBaseUrl: string;
  providerApiKey: string;
  developerModel: string;
  reviewerModel: string;
  attachmentIds?: string[];
  conversationId?: string;
  /**
   * Review-feedback continuation ("он сделал, я проверил, сказал переделать"):
   * the new run re-enters the PREVIOUS run's worktrees (which still hold the
   * delivered changes) instead of starting from a clean baseline, and the
   * loop is told what the previous iteration did. When the previous run's
   * worktrees were already cleaned up (empty array), this degrades to a fresh
   * worktree with the prior context still injected.
   */
  continueFrom?: {
    worktrees: DevelopWorktreeInfo[];
    priorTask: string;
    priorSummary: string;
    /** Sensitive DB commands already resolved (approved+executed or rejected) earlier in this conversation - see DevelopRunOptions.priorSensitiveActions. */
    priorSensitiveActions?: DevelopSensitiveAction[];
  };
  /**
   * Task decomposition (2026-07-18, docs/architecture/011 §4.11): a large,
   * multi-layer task planned upfront as an ordered sequence of small,
   * independently reviewable steps (planDevelopSubtasks in packages/ai).
   * `task` above is always the CURRENT step; chainRemaining holds the
   * standalone descriptions of the steps still to come. Only ever set
   * internally (by startDevelopRun advancing its own chain) - never by an
   * external caller directly.
   */
  chainRemaining?: string[];
  chainInfo?: { subtaskIndex: number; totalSubtasks: number };
  /** See DevelopRunStatusRecord.autoMergeOnCompletion. */
  autoMergeOnCompletion?: boolean;
}

const MAX_TRACKED_RUNS = 100;
const developRunStatuses = new Map<string, DevelopRunStatusRecord>();

export function getDevelopRunStatus(runId: string): DevelopRunStatusRecord | null {
  return developRunStatuses.get(runId) ?? null;
}

export function listDevelopWorktreeEntries(filters?: { projectPath?: string; conversationId?: string }): DevelopWorktreeRegistryEntry[] {
  const projectPath = filters?.projectPath?.trim();
  const conversationId = filters?.conversationId?.trim();

  return [...developRunStatuses.values()]
    .filter((record) => record.worktrees.length > 0)
    .filter((record) => !projectPath || record.projectPath === projectPath)
    .filter((record) => !conversationId || record.conversationId === conversationId)
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
    .map((record) => ({
      runId: record.runId,
      conversationId: record.conversationId,
      projectPath: record.projectPath,
      task: record.task,
      status: record.status,
      startedAt: record.startedAt,
      ...(record.finishedAt ? { finishedAt: record.finishedAt } : {}),
      worktrees: record.worktrees,
      ...(record.autoMergeOutcome?.length ? { autoMergeOutcome: record.autoMergeOutcome } : {}),
      ...(record.result
        ? {
            usage: {
              promptTokens: record.result.totalPromptTokens,
              completionTokens: record.result.totalCompletionTokens,
              totalTokens: record.result.totalPromptTokens + record.result.totalCompletionTokens,
            },
          }
        : {}),
    }));
}

export async function listDevelopWorktreeEntriesFromTelemetry(filters?: { projectPath?: string; conversationId?: string }): Promise<DevelopWorktreeRegistryEntry[]> {
  const where: string[] = ["jsonb_array_length(worktrees) > 0"];
  const params: unknown[] = [];

  if (filters?.projectPath?.trim()) {
    params.push(filters.projectPath.trim());
    where.push(`project_path = $${params.length}`);
  }

  if (filters?.conversationId?.trim()) {
    params.push(filters.conversationId.trim());
    where.push(`conversation_id = $${params.length}`);
  }

  const rows = await runSql<{
    run_id: string;
    conversation_id: string;
    project_path: string;
    task: string;
    status: "running" | "completed" | "failed";
    started_at: string;
    finished_at?: string | null;
    worktrees: DevelopWorktreeInfo[];
    prompt_tokens: number;
    completion_tokens: number;
  }>(
    `
      select
        run_id,
        conversation_id,
        project_path,
        task,
        status,
        started_at,
        finished_at,
        worktrees,
        prompt_tokens,
        completion_tokens
      from developer_runs
      where ${where.join(" and ")}
      order by started_at desc
    `,
    params,
  );

  return rows.map((row) => ({
    runId: row.run_id,
    conversationId: row.conversation_id,
    projectPath: row.project_path,
    task: row.task,
    status: row.status,
    startedAt: new Date(row.started_at).toISOString(),
    ...(row.finished_at ? { finishedAt: new Date(row.finished_at).toISOString() } : {}),
    worktrees: Array.isArray(row.worktrees) ? row.worktrees : [],
    usage: {
      promptTokens: Number(row.prompt_tokens ?? 0),
      completionTokens: Number(row.completion_tokens ?? 0),
      totalTokens: Number(row.prompt_tokens ?? 0) + Number(row.completion_tokens ?? 0),
    },
  }));
}

export async function loadDevelopRunWorktreesFromTelemetry(runId: string): Promise<DevelopWorktreeInfo[] | null> {
  const rows = await runSql<{ worktrees: DevelopWorktreeInfo[] }>(
    `
      select worktrees
      from developer_runs
      where run_id = $1
      limit 1
    `,
    [runId],
  );

  if (rows.length === 0) {
    return null;
  }

  const worktrees = rows[0]?.worktrees;
  return Array.isArray(worktrees) ? worktrees : [];
}

async function persistTelemetryWorktrees(runId: string, worktrees: DevelopWorktreeInfo[]): Promise<void> {
  await runSql(
    `
      update developer_runs
      set worktrees = $2::jsonb
      where run_id = $1
    `,
    [runId, JSON.stringify(worktrees)],
  );
}

/**
 * The latest develop run of a chat thread - what a review-feedback message
 * continues. In-memory only: after a server restart old threads honestly
 * start a fresh development instead of guessing at a lost worktree.
 */
export function findLatestDevelopRunForConversation(conversationId: string): DevelopRunStatusRecord | null {
  let latest: DevelopRunStatusRecord | null = null;

  for (const record of developRunStatuses.values()) {
    if (record.conversationId === conversationId && (!latest || record.startedAt > latest.startedAt)) {
      latest = record;
    }
  }

  return latest;
}

// Serialization (2026-07-28, explicit product-owner decision alongside
// dropping worktree isolation - see createTaskSession's docstring): with no
// separate worktree, two runs against the SAME project would write the same
// real files concurrently. Rather than reject a second request outright,
// queue it - a per-project-root promise chain, same pattern a single mutex
// would use.
//
// Bug fix (2026-07-29, live incident): this used to be keyed by the joined,
// SORTED SET of a run's own root paths (e.g. "backend|billing|frontend") -
// two real runs against the SAME magendamd project ran fully concurrently
// anyway, because a scope-directive classifier (see startDevelopRun below)
// restricted one of them to just ["backend"] while the other kept all
// three roots, producing two DIFFERENT keys for projects that plainly
// overlap. Caught live: both wrote to the real magendamd_backend checkout
// at the same time - no data was actually lost that time (their edits
// happened not to collide), but the failure mode is real file corruption,
// not a near-miss to shrug off. Now keyed per INDIVIDUAL root path instead
// of the joined set - a new run waits on every root it touches that
// ANY currently active run also touches, transitively (if run B shares a
// root with running A, and run C later shares a different root with B,
// C correctly waits for B, which already waited for A) - not just on an
// exact match of the whole set.
const activeRootQueues = new Map<string, Promise<void>>();

function resolveOriginalRoots(input: StartDevelopRunInput): WorkspaceRoot[] {
  return input.projectPaths?.length
    ? input.projectPaths.map((pathRecord) => ({
        label: pathRecord.name,
        absolutePath: normalizePath(path.resolve(pathRecord.rootPath)),
        role: pathRecord.role,
      }))
    : [{ label: "root", absolutePath: normalizePath(path.resolve(input.projectPath)), role: "unknown" }];
}

export function startDevelopRun(input: StartDevelopRunInput): DevelopRunStatusRecord {
  const startedAt = new Date().toISOString();
  const runId = stableId(["develop-run", input.projectPath, input.task, Date.now()]);
  const record: DevelopRunStatusRecord = {
    runId,
    // Same convention as pipeline runs: the first message's runId becomes the
    // thread id when the caller has no thread yet.
    conversationId: input.conversationId?.trim() || runId,
    status: "running",
    task: input.task,
    projectPath: input.projectPath,
    developerModel: input.developerModel,
    reviewerModel: input.reviewerModel,
    startedAt,
    updatedAt: startedAt,
    worktrees: [],
    ...(input.chainInfo ? { chainInfo: input.chainInfo } : {}),
    ...(input.autoMergeOnCompletion ? { autoMergeOnCompletion: true } : {}),
  };

  pruneTrackedRuns();
  developRunStatuses.set(runId, record);

  void insertTelemetryRow(record).catch(() => {
    // Telemetry must never block or fail a run - same graceful-degradation
    // stance every other Postgres consumer in this app takes.
  });

  const originalRoots = resolveOriginalRoots(input);
  // Wait for every CURRENTLY ACTIVE run that shares ANY of this run's roots
  // - not just an exact-set match (see activeRootQueues' own comment above).
  const overlappingTails = originalRoots
    .map((root) => activeRootQueues.get(root.absolutePath))
    .filter((tail): tail is Promise<void> => Boolean(tail));
  const previousTail = overlappingTails.length ? Promise.all(overlappingTails).then(() => {}) : Promise.resolve();
  record.progress = { turn: 0, filesChanged: 0, phase: "queued" };

  const currentTail = previousTail.then(() => {
    record.progress = { turn: 0, filesChanged: 0, phase: "starting" };
    record.updatedAt = new Date().toISOString();
    return executeDevelopRun(record, input, originalRoots);
  });
  // Swallow so one failed run never poisons the queue for the NEXT task on
  // this project - each run's own success/failure is already recorded on
  // its own `record`, this chain only exists to serialize execution order.
  const settledTail = currentTail.catch(() => {});

  // Registered against EVERY root this run touches, so a LATER run sharing
  // any one of them (even a different subset) correctly waits for this one.
  for (const root of originalRoots) {
    activeRootQueues.set(root.absolutePath, settledTail);
  }

  void currentTail
    .then(() => maybeAdvanceChain(record, input))
    .catch((error) => {
      record.status = "failed";
      record.errorMessage = error instanceof Error ? error.message : String(error);
    })
    .finally(() => {
      record.finishedAt = new Date().toISOString();
      record.updatedAt = record.finishedAt;
      void finishTelemetryRow(record).catch(() => {});
    });

  return record;
}

/**
 * Task-decomposition chain advance (2026-07-18, docs/architecture/011
 * §4.11): only continues past a CLEAN Reviewer approval - anything else
 * (contested review, a pause for clarification/DB approval, an error, a
 * budget exhaustion) must surface to the human before more automated work
 * stacks on top of an unresolved link, same bar a non-chained run already
 * holds. Fires the next link via startDevelopRun itself, reusing this
 * link's worktrees (still populated - executeDevelopRun only clears them
 * on an empty, non-paused diff) so the chain is one continuous worktree,
 * not N independent throwaway ones.
 */
async function maybeAdvanceChain(record: DevelopRunStatusRecord, input: StartDevelopRunInput): Promise<void> {
  const result = record.result;
  const cleanApproval = result?.stopped === "task_complete" && result.reviewVerdict === "approved";
  const wholeTaskDone = cleanApproval && !input.chainRemaining?.length && result;

  // Tests-as-separate-step (2026-07-18, docs/architecture/011 §4.12,
  // explicit product-owner directive): real projects, including this one's
  // own primary test target, are commonly NOT test-covered by convention -
  // the Reviewer no longer blocks on missing tests (see REVIEWER_SYSTEM_PROMPT),
  // and the Developer no longer writes test files unprompted (see
  // buildDevelopSystemPrompt instruction 8). Coverage is offered as an
  // explicit question ONLY once the whole task/chain is genuinely done -
  // not per intermediate chain link, matching "в конце разработки".
  if (wholeTaskDone) {
    record.testsOffered = true;
    result.summary = `${result.summary ?? ""}\n\nПокрыть это тестами? (да / нет / свой вариант — какие именно)`;
  }

  // "И сразу занеси это в ветку" said in the ORIGINAL task message
  // (2026-07-18, see classifyAutoMergeIntent) - made MOOT 2026-07-28 by
  // dropping worktree isolation (see createTaskSession's docstring):
  // whatever the Developer wrote is already sitting in the real checkout as
  // uncommitted changes, there is nothing left to bring in. Only surfaces a
  // confirming note now, matching what mergeDevelopRunToRealCheckout itself
  // degraded to - no longer calls it (nothing for it to actually do).
  if (wholeTaskDone && record.autoMergeOnCompletion && record.worktrees.length > 0) {
    record.autoMergeOutcome = record.worktrees.map((worktree) => ({ label: worktree.label, applied: true, changedFiles: result.changedFiles }));
    result.summary = [result.summary ?? "", "", "Правки уже в проекте, как просил — отдельно заносить некуда, worktree больше нет (пишу прямо в реальный чекаут)."].join("\n");
  }

  if (!input.chainRemaining?.length) {
    return;
  }

  if (!cleanApproval) {
    return;
  }

  const [nextTask, ...rest] = input.chainRemaining;

  if (!nextTask || !record.chainInfo) {
    return;
  }

  const nextRecord = startDevelopRun({
    task: nextTask,
    projectPath: input.projectPath,
    ...(input.projectPaths ? { projectPaths: input.projectPaths } : {}),
    providerBaseUrl: input.providerBaseUrl,
    providerApiKey: input.providerApiKey,
    developerModel: input.developerModel,
    reviewerModel: input.reviewerModel,
    ...(input.attachmentIds?.length ? { attachmentIds: input.attachmentIds } : {}),
    conversationId: record.conversationId,
    ...(record.autoMergeOnCompletion ? { autoMergeOnCompletion: true } : {}),
    continueFrom: {
      worktrees: record.worktrees,
      priorTask: record.task,
      priorSummary: result.summary ?? "",
    },
    chainRemaining: rest,
    chainInfo: { subtaskIndex: record.chainInfo.subtaskIndex + 1, totalSubtasks: record.chainInfo.totalSubtasks },
  });

  record.chainNextRunId = nextRecord.runId;
}

async function executeDevelopRun(record: DevelopRunStatusRecord, input: StartDevelopRunInput, originalRoots: WorkspaceRoot[]): Promise<void> {
  // No worktree isolation (2026-07-28, see createTaskSession's docstring) -
  // a correction run reuses the previous run's session info as-is (same
  // startCommit, so the diff still shows everything since the task began,
  // across however many correction rounds); a fresh run opens a new session
  // pointed at the SAME real directory. Either way "worktreePath" below
  // equals the real project root - callers that resolve tools from it
  // (dbQuery, run_command's cwd, etc.) get the real thing, not a copy.
  const reusedSession = input.continueFrom?.worktrees.length === originalRoots.length
    ? input.continueFrom.worktrees.map((info): TaskWorktree => ({
        rootPath: info.rootPath,
        worktreePath: info.worktreePath,
        branch: info.branch,
        startCommit: info.startCommit,
      }))
    : null;
  const worktrees: TaskWorktree[] = reusedSession ?? [];

  if (!reusedSession) {
    for (const root of originalRoots) {
      worktrees.push(await createTaskSession(root.absolutePath));
    }
  }

  record.worktrees = worktrees.map((worktree, index) => ({
    label: (originalRoots[index] as WorkspaceRoot).label,
    rootPath: worktree.rootPath,
    worktreePath: worktree.worktreePath,
    branch: worktree.branch,
    startCommit: worktree.startCommit,
  }));
  record.updatedAt = new Date().toISOString();

  const worktreeRoots: WorkspaceRoot[] = originalRoots.map((root, index) => ({
    label: root.label,
    absolutePath: (worktrees[index] as TaskWorktree).worktreePath,
    role: root.role,
  }));

  // Memory injection queries run against the ORIGINAL project paths (facts/
  // glossary/observer entries are keyed by them), while the loop itself works
  // only inside the worktrees. All hints are best-effort: Postgres being down
  // degrades to a memory-less (but still correct) run.
  let knownFactsHint = "";
  let observerHint = "";
  let attachmentHint = "";

  try {
    const originalPaths = originalRoots.map((root) => root.absolutePath);
    const [facts, glossary, verificationHint, environmentHealthNotes] = await Promise.all([
      queryFactsAcrossPaths(originalPaths),
      queryGlossaryAcrossPaths(originalPaths),
      buildVerificationCommandsHint(input.projectPath),
      // Read-only "are this project's own docker services actually up"
      // check (2026-07-28) - surfaced here so a stopped stack is known
      // BEFORE the loop starts, not discovered blind after several failed
      // db_query/http_request/run_command attempts (the exact failure mode
      // hit live this session against two different projects' stacks).
      Promise.all(originalPaths.map((rootPath) => checkDockerComposeHealth(rootPath))),
    ]);
    knownFactsHint = [buildKnownFactsHint(originalRoots, facts), buildGlossaryHint(glossary), verificationHint, ...environmentHealthNotes.filter((note): note is string => Boolean(note))]
      .filter(Boolean)
      .join("\n\n");
  } catch {
    // no memory, still a valid run
  }

  try {
    observerHint = (await buildObserverHintSuffix(originalRoots, input.task)).text;
  } catch {
    // same
  }

  if (input.attachmentIds?.length) {
    try {
      attachmentHint = await buildAttachmentContextHint(input.attachmentIds);
    } catch {
      // same graceful degradation as other memory channels
    }
  }

  // Reuse-discovery tools (2026-07-18, explicit user request after the
  // MD-1332/1474/1498 benchmark: "должен переиспользовать существующий
  // функционал" + "не сломать существующий функционал"). These are the SAME
  // tools the Q&A Researcher has always had (buildSemanticSearchTool/
  // buildGraphNavigationTool, pipeline-runner.ts) - they were declared in
  // DevelopRunOptions from day one (develop-loop.ts) but never actually
  // wired here, so every Developer run so far (including today's benchmark)
  // only ever had list_dir/grep_content/read_file for discovery. This is
  // exactly why MD-1498 cold-grepped for a convention instead of finding it:
  // grep only matches literal words from the TASK text, semantic_search
  // matches by MEANING, and find_references shows REAL structural callers -
  // "who else calls the thing I'm about to change" is precisely the
  // regression-safety question, not just a nice-to-have for style.
  //
  // semanticSearch needs no pre-built index (queries Postgres embeddings +
  // live grep against the ORIGINAL, real checkout - not the worktree, which
  // has no embeddings of its own and starts identical anyway). findReferences
  // needs a persisted graph snapshot for the PRIMARY root, keyed the exact
  // same way the Q&A pipeline keys it (packages/workspace's
  // stableId(["project", normalizedRoot])) - loaded best-effort: a project
  // that has never been asked a question through Q&A (no prior sync) simply
  // has no snapshot yet, and find_references degrades to "not available"
  // (the loop already omits the tool from the model's protocol entirely when
  // undefined - honest, not a silent failure).
  const semanticSearchTool = buildSemanticSearchTool(originalRoots, input.providerBaseUrl, input.providerApiKey);
  // Efficiency parity with the Q&A path (2026-07-18, explicit product-owner
  // request: "мы оптимизировали ресерчера, а не бюджетировали" - apply the
  // SAME lesson here instead of raising turn/token ceilings). Same
  // mechanism, same "single biggest latency lever measured" as research.
  const semanticSeedFilesTool = buildSemanticSeedLookup(originalRoots, input.providerBaseUrl, input.providerApiKey);
  let findReferencesTool: ((symbolOrFileName: string) => Promise<string>) | undefined;
  let impactPreviewTool: ((editedFiles: string[]) => string) | undefined;
  const primaryRoot = originalRoots[0] as WorkspaceRoot;
  const isMultiRoot = originalRoots.length > 1;

  try {
    const primaryProjectId = stableId(["project", primaryRoot.absolutePath]);
    const graph = await loadGraphSnapshot(primaryProjectId);

    if (graph) {
      findReferencesTool = buildGraphNavigationTool(graph);
      impactPreviewTool = buildImpactPreviewTool(graph, primaryRoot.label, isMultiRoot);
    }
  } catch {
    // no persisted graph, find_references/impact preview simply unavailable this run
  }

  // Read-only DB inspection (2026-07-18, docs/architecture/011 §4.19):
  // resolved against the ORIGINAL project roots, deliberately NOT the
  // worktree - a docker-compose service is only reachable/discoverable
  // from the directory the user's own containers are actually running
  // under (see db-query-tool.ts's findRunningContainer docstring).
  const dbQueryTool = await buildDbQueryTool(originalRoots.map((root) => root.absolutePath)).catch(() => null);
  // Read-other-branch-without-checkout (2026-07-28) - operates on
  // worktreeRoots, which now EQUALS originalRoots (see createTaskSession) -
  // git ops run wherever the Developer is actually working.
  const readOtherBranchTool = buildReadOtherBranchTool(worktreeRoots);

  const collectDiff = async (): Promise<{ diff: string; changedFiles: string[] }> => {
    const parts = await Promise.all(
      worktrees.map(async (worktree, index) => ({
        label: (originalRoots[index] as WorkspaceRoot).label,
        ...(await collectWorktreeChanges(worktree)),
      })),
    );

    return {
      diff: parts
        .filter((part) => part.diff.trim())
        .map((part) => (isMultiRoot ? `# part: ${part.label}\n${part.diff}` : part.diff))
        .join("\n"),
      changedFiles: parts.flatMap((part) => part.changedFiles.map((file) => (isMultiRoot ? `${part.label}/${file}` : file))),
    };
  };

  const result = await runDevelopmentTask({
    task: input.task,
    projectRoots: worktreeRoots,
    developerModel: input.developerModel,
    reviewerModel: input.reviewerModel,
    providerBaseUrl: input.providerBaseUrl,
    providerApiKey: input.providerApiKey,
    ...(knownFactsHint ? { knownFactsHint } : {}),
    ...(observerHint ? { observerHint } : {}),
    ...(attachmentHint ? { attachmentHint } : {}),
    semanticSearch: semanticSearchTool,
    semanticSeedFiles: semanticSeedFilesTool,
    ...(findReferencesTool ? { findReferences: findReferencesTool } : {}),
    ...(impactPreviewTool ? { computeImpactPreview: impactPreviewTool } : {}),
    ...(dbQueryTool ? { dbQuery: dbQueryTool } : {}),
    readOtherBranch: readOtherBranchTool,
    computeFindingSimilarity: buildFindingSimilarityTool(input.providerBaseUrl, input.providerApiKey),
    ...(input.continueFrom
      ? {
          priorIteration: {
            task: input.continueFrom.priorTask,
            summary: input.continueFrom.priorSummary,
            worktreeCarriesChanges: Boolean(reusedSession),
          },
          ...(input.continueFrom.priorSensitiveActions?.length
            ? { priorSensitiveActions: input.continueFrom.priorSensitiveActions }
            : {}),
        }
      : {}),
    collectDiff,
    onProgress: (info) => {
      record.progress = info;
      record.updatedAt = new Date().toISOString();
    },
  });

  record.result = result;
  record.status = result.stopped === "error" ? "failed" : "completed";

  if (result.error) {
    record.errorMessage = result.error;
  }

  // Cross-task pattern memory (2026-07-18, docs/architecture/011 §4.2
  // follow-up): only from Reviewer-APPROVED runs (the same "verify, then
  // rely" trust bar the rest of the Fact Store uses) - never blocks or fails
  // the run itself. Reads related files from the ORIGINAL project paths, not
  // the worktree (which is about to be deleted for an empty diff, and even
  // when kept is a throwaway - a pattern fact must anchor to code that
  // outlives this run).
  if (result.reviewVerdict === "approved" && result.touchedFiles.length > 0) {
    void promoteDevelopmentPatternFacts(input, originalRoots, worktrees, result).catch(() => {
      // best-effort, see promoteDevelopmentPatternFacts's own try/catch too
    });
  }

  // Graph refresh (2026-07-28): used to run only on "занеси в ветку" (the
  // one moment code actually landed in the real checkout). Now that every
  // run already writes directly to the real checkout (see createTaskSession),
  // this is the only place left that should do it - moved here so the
  // persisted graph still reflects what a Q&A/develop run just wrote,
  // instead of going stale until the next background sync.
  if (result.changedFiles.length > 0) {
    for (const root of originalRoots) {
      const ownRelativePaths = isMultiRoot
        ? result.changedFiles.filter((file) => file.startsWith(`${root.label}/`)).map((file) => file.slice(root.label.length + 1))
        : result.changedFiles;

      if (ownRelativePaths.length > 0) {
        await refreshGraphForChangedFiles(root.absolutePath, ownRelativePaths).catch((error) => {
          console.warn(`[develop-runner] graph refresh failed for ${root.absolutePath}:`, error);
        });
      }
    }
  }

  // No empty-diff cleanup anymore (2026-07-28): this used to delete the
  // worktree+branch when a round produced no changes, which is exactly what
  // caused a real live incident (2026-07-27) - a CONTINUATION round with a
  // legitimately empty diff (e.g. correctly disputing a stale reviewer
  // finding) wiped every prior round's accumulated, uncommitted work,
  // because there was nothing to distinguish "empty because nothing to
  // merge" from "empty because this round added nothing to an
  // already-in-progress task." With no separate worktree/branch to delete
  // (see createTaskSession), that whole class of bug is gone by
  // construction - an empty diff now just means empty, nothing to clean up
  // or lose either way.
}

/**
 * Executes an approved sensitive DB command DIRECTLY in the preserved
 * worktree (2026-07-18 DB safety) - not by asking the model to re-issue it,
 * so the exact command shown to the human for approval is the exact command
 * that runs. Runs through the SAME runShellCommand the Developer loop itself
 * uses (same timeout/output-bounding behavior), called here outside the LLM
 * loop entirely since approval already happened.
 */
export async function resolvePendingApproval(
  pendingApproval: DevelopSensitiveAction,
  worktrees: DevelopWorktreeInfo[],
  decision: "approved" | "rejected",
): Promise<DevelopSensitiveAction> {
  if (decision === "rejected") {
    return { ...pendingApproval, status: "rejected" };
  }

  const roots: WorkspaceRoot[] = worktrees.map((info) => ({ label: info.label, absolutePath: info.worktreePath, role: "unknown" }));

  try {
    const result = await runShellCommand(roots, pendingApproval.command);
    return {
      ...pendingApproval,
      status: "approved",
      exitCode: result.exitCode,
      output: result.output.slice(0, 3000),
      executedAt: new Date().toISOString(),
    };
  } catch (error) {
    return {
      ...pendingApproval,
      status: "approved",
      exitCode: 1,
      output: error instanceof Error ? error.message : String(error),
      executedAt: new Date().toISOString(),
    };
  }
}

export interface MergeToBranchOutcome {
  label: string;
  applied: boolean;
  changedFiles: string[];
  error?: string;
}

/**
 * "Занеси в текущую ветку" (2026-07-18 feature, made MOOT 2026-07-28 by
 * dropping worktree isolation - see createTaskSession's docstring): with no
 * separate worktree, `worktree.worktreePath` already IS the real checkout -
 * changes have been sitting there, uncommitted, since the moment the
 * Developer made them. There is nothing left to apply. Kept as a function
 * (not deleted) purely so the existing button/chat-command endpoints in
 * app.ts keep working without a caller-side special case - it now just
 * confirms this fact instead of running `git apply` (which would fail or,
 * worse, double-apply a patch against the very files it came from).
 */
export async function mergeDevelopRunToRealCheckout(worktrees: DevelopWorktreeInfo[]): Promise<MergeToBranchOutcome[]> {
  return worktrees.map((worktree) => ({
    label: worktree.label,
    applied: true,
    changedFiles: [],
  }));
}

/**
 * "Почисти ворктри" (2026-07-18 feature, made MOOT 2026-07-28 - see
 * mergeDevelopRunToRealCheckout above): there is no separate worktree
 * directory or task branch to remove anymore (createTaskSession works
 * directly in the real checkout, on whatever branch was already checked
 * out). This only clears this run's OWN bookkeeping (`record.worktrees`,
 * the telemetry column) - no git operation, nothing on disk changes. Kept
 * as a function for the same reason as mergeDevelopRunToRealCheckout above.
 */
export async function cleanupDevelopRunWorktrees(record: DevelopRunStatusRecord, label?: string): Promise<void> {
  record.worktrees = label ? record.worktrees.filter((worktree) => worktree.label !== label) : [];
  await persistTelemetryWorktrees(record.runId, record.worktrees);
}

export async function cleanupTelemetryDevelopRunWorktrees(runId: string, label?: string): Promise<boolean> {
  const worktrees = await loadDevelopRunWorktreesFromTelemetry(runId);

  if (!worktrees) {
    return false;
  }

  const remaining = label ? worktrees.filter((worktree) => worktree.label !== label) : [];
  await persistTelemetryWorktrees(runId, remaining);
  return true;
}

/**
 * Telemetry-fallback counterpart of mergeDevelopRunToRealCheckout
 * (2026-07-19 bug fix): cleanup-worktree already had this fallback
 * (cleanupTelemetryDevelopRunWorktrees above), merge did not - the Worktree
 * Manager sidebar surfaces BOTH live and telemetry-sourced entries (see
 * listDevelopWorktreeEntriesFromTelemetry), so a worktree from before a
 * server restart showed a working "Удалить" button next to a "Занести в
 * текущий чекаут" button that only ever 404'd. Returns null (not an empty
 * array) when the run isn't in telemetry either, so the caller can tell
 * "genuinely not found" apart from "found, nothing to merge".
 */
export async function mergeTelemetryDevelopRunWorktrees(runId: string, label?: string): Promise<MergeToBranchOutcome[] | null> {
  const worktrees = await loadDevelopRunWorktreesFromTelemetry(runId);

  if (!worktrees) {
    return null;
  }

  const targets = label ? worktrees.filter((worktree) => worktree.label === label) : worktrees;
  return mergeDevelopRunToRealCheckout(targets);
}

/**
 * Impact analysis (2026-07-18, docs/architecture/011 §4.13): deterministic
 * "who depends on the files I just edited" lookup against the SAME
 * persisted graph find_references already uses (buildGraphNavigationTool,
 * pipeline-runner.ts) - reused here as a per-run tool instead of a new
 * role/handoff (see §1). The graph only covers the PRIMARY root (documented
 * limitation, same one buildCrossRepoStructuralData works around for
 * find_references) - edited files outside it are silently skipped, same
 * honest degradation the rest of this file already uses for a missing graph.
 */
function buildImpactPreviewTool(graph: GraphState, primaryLabel: string, isMultiRoot: boolean): (editedFiles: string[]) => string {
  const fileNodeIdByPath = new Map(
    graph.nodes.filter((node) => node.kind === "file" && node.filePath).map((node) => [node.filePath as string, node.id]),
  );

  return (editedFiles: string[]): string => {
    const lines: string[] = [];

    for (const rawPath of editedFiles) {
      const relativePath = isMultiRoot
        ? (rawPath.startsWith(`${primaryLabel}/`) ? rawPath.slice(primaryLabel.length + 1) : null)
        : rawPath;

      if (!relativePath) {
        continue;
      }

      const nodeId = fileNodeIdByPath.get(relativePath);

      if (!nodeId) {
        continue;
      }

      const dependents = getFileDependents(graph, nodeId);

      if (dependents.length > 0) {
        const dependentLabels = [...new Set(dependents.map((node) => node.filePath ?? node.label))].slice(0, 8);
        lines.push(`${relativePath}: called/used by ${dependentLabels.join(", ")}`);
      }
    }

    return lines.length > 0
      ? lines.join("\n")
      : "(no statically-resolved dependents found for the edited files - either genuinely none, or they are outside the graph's coverage)";
  };
}

// Same embedding model already used for semantic code search
// (pipeline-runner.ts's SEMANTIC_SEARCH_EMBEDDING_MODEL) - one already-proven
// model instead of introducing a second embedding provider choice.
const FINDING_SIMILARITY_EMBEDDING_MODEL = "qwen/qwen3-embedding-8b";

function cosineSimilarity(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < length; i += 1) {
    const valueA = a[i] ?? 0;
    const valueB = b[i] ?? 0;
    dot += valueA * valueB;
    normA += valueA * valueA;
    normB += valueB * valueB;
  }

  if (normA === 0 || normB === 0) {
    return 0;
  }

  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Semantic repeat detection (2026-07-18, docs/architecture/011 §4.16
 * follow-up) - see DevelopRunOptions.computeFindingSimilarity's docstring
 * for why the string-only repeat check in develop-loop.ts isn't enough.
 * Embeds the candidate finding together with the comparison texts in ONE
 * batch call (cheap - short strings, one round-trip) and returns the
 * highest cosine similarity against any of them. Best-effort by design:
 * the caller already degrades to string-only matching on any error.
 */
function buildFindingSimilarityTool(providerBaseUrl: string, providerApiKey: string): (candidateFinding: string, comparisonTexts: string[]) => Promise<number> {
  return async (candidateFinding: string, comparisonTexts: string[]): Promise<number> => {
    if (comparisonTexts.length === 0) {
      return 0;
    }

    const embeddings = await embedTexts({
      providerBaseUrl,
      providerApiKey,
      embeddingModel: FINDING_SIMILARITY_EMBEDDING_MODEL,
      texts: [candidateFinding, ...comparisonTexts],
    });
    const [candidateEmbedding, ...comparisonEmbeddings] = embeddings;

    if (!candidateEmbedding) {
      return 0;
    }

    return Math.max(0, ...comparisonEmbeddings.map((embedding) => cosineSimilarity(candidateEmbedding, embedding)));
  };
}

/**
 * Resolves a workspace-relative touched-file path (loop.ts's
 * toWorkspaceRelativePath convention - bare path for single-root,
 * `label/rest` for multi-root) back to an absolute path in the ORIGINAL
 * project checkout, so extracted pattern facts anchor to real, durable
 * files rather than the throwaway worktree.
 */
function resolveTouchedFileAbsolutePath(originalRoots: WorkspaceRoot[], touchedFile: string): string | null {
  if (originalRoots.length === 1) {
    return path.join((originalRoots[0] as WorkspaceRoot).absolutePath, touchedFile);
  }

  const slashIndex = touchedFile.indexOf("/");

  if (slashIndex === -1) {
    return null;
  }

  const label = touchedFile.slice(0, slashIndex);
  const rest = touchedFile.slice(slashIndex + 1);
  const root = originalRoots.find((candidate) => candidate.label === label);
  return root ? path.join(root.absolutePath, rest) : null;
}

async function promoteDevelopmentPatternFacts(
  input: StartDevelopRunInput,
  originalRoots: WorkspaceRoot[],
  worktrees: TaskWorktree[],
  result: DevelopRunResult,
): Promise<void> {
  const startCommitByRoot = new Map(originalRoots.map((root, index) => [root.absolutePath, (worktrees[index] as TaskWorktree | undefined)?.startCommit ?? ""]));
  const candidates = await extractCodePatternFacts({
    task: input.task,
    summary: result.summary ?? "",
    touchedFiles: result.touchedFiles,
    providerBaseUrl: input.providerBaseUrl,
    providerModel: input.reviewerModel,
    providerApiKey: input.providerApiKey,
  });

  if (candidates.length === 0) {
    return;
  }

  // One project can span multiple physical roots (multi-repo) - group
  // candidates by which root their files actually resolve into, since
  // project_facts.project_root_path is per-root, same as the rest of the
  // Fact Store.
  const byRoot = new Map<string, Array<{ statement: string; filePaths: string[] }>>();

  for (const candidate of candidates) {
    const filesByRoot = new Map<string, string[]>();

    for (const touchedFile of candidate.relatedFiles) {
      const absolutePath = resolveTouchedFileAbsolutePath(originalRoots, touchedFile);

      if (!absolutePath) {
        continue;
      }

      const root = originalRoots.find((candidateRoot) => absolutePath.startsWith(`${candidateRoot.absolutePath}/`) || absolutePath === candidateRoot.absolutePath);

      if (!root) {
        continue;
      }

      const relativePath = path.relative(root.absolutePath, absolutePath);
      const existing = filesByRoot.get(root.absolutePath) ?? [];
      existing.push(relativePath);
      filesByRoot.set(root.absolutePath, existing);
    }

    for (const [rootPath, relativePaths] of filesByRoot) {
      const existing = byRoot.get(rootPath) ?? [];
      existing.push({ statement: candidate.statement, filePaths: relativePaths });
      byRoot.set(rootPath, existing);
    }
  }

  const checkConflict: (existingStatement: string, candidateStatement: string) => Promise<boolean> = (existingStatement, candidateStatement) =>
    classifyFactConflict({
      existingStatement,
      candidateStatement,
      providerBaseUrl: input.providerBaseUrl,
      providerModel: input.reviewerModel,
      providerApiKey: input.providerApiKey,
    });

  for (const [rootPath, patterns] of byRoot) {
    await promoteFactsFromDevelopment(
      rootPath,
      patterns,
      startCommitByRoot.get(rootPath) ?? "",
      async (relativePath) => {
        try {
          return await fs.readFile(path.join(rootPath, relativePath), "utf8");
        } catch {
          return null;
        }
      },
      checkConflict,
    );
  }
}

function pruneTrackedRuns(): void {
  if (developRunStatuses.size < MAX_TRACKED_RUNS) {
    return;
  }

  for (const [runId, tracked] of developRunStatuses) {
    if (tracked.status !== "running") {
      developRunStatuses.delete(runId);
    }

    if (developRunStatuses.size < MAX_TRACKED_RUNS) {
      break;
    }
  }
}

/**
 * Bootstrap memory (011, раздел 6): "how does this project verify itself" is
 * learned from what actually WORKED in previous develop runs - straight from
 * the telemetry table, no separate fact-store ceremony. The single biggest
 * per-run time sink for the Developer on a familiar project is re-discovering
 * the right test/build command.
 */
async function buildVerificationCommandsHint(projectPath: string): Promise<string> {
  const rows = await runSql<{ verification_log: Array<{ command?: string; exitCode?: number }> }>(
    `
      select verification_log from developer_runs
      where project_path = $1 and status = 'completed'
      order by started_at desc
      limit 5
    `,
    [projectPath],
  );

  const commands: string[] = [];

  for (const row of rows) {
    for (const entry of row.verification_log ?? []) {
      if (entry.exitCode === 0 && entry.command && !commands.includes(entry.command)) {
        commands.push(entry.command);
      }
    }
  }

  if (commands.length === 0) {
    return "";
  }

  return [
    "Verification commands that have WORKED on this project in previous development runs (use them via run_command to verify your change; still sanity-check they apply to what you touched):",
    ...commands.slice(0, 3).map((command) => `- ${command}`),
  ].join("\n");
}

async function insertTelemetryRow(record: DevelopRunStatusRecord): Promise<void> {
  await runSql(
    `
      insert into developer_runs (run_id, conversation_id, project_path, task, status, developer_model, reviewer_model, started_at)
      values ($1, $2, $3, $4, $5, $6, $7, $8)
      on conflict (run_id) do nothing
    `,
    [record.runId, record.conversationId, record.projectPath, record.task, record.status, record.developerModel, record.reviewerModel, record.startedAt],
  );
}

async function finishTelemetryRow(record: DevelopRunStatusRecord): Promise<void> {
  const result = record.result;
  await runSql(
    `
      update developer_runs set
        status = $2,
        stopped = $3,
        review_verdict = $4,
        summary = $5,
        clarification_question = $6,
        diff = $7,
        changed_files = $8::jsonb,
        verification_log = $9::jsonb,
        reviews = $10::jsonb,
        worktrees = $11::jsonb,
        turns_used = $12,
        prompt_tokens = $13,
        completion_tokens = $14,
        error = $15,
        finished_at = $16,
        pending_approval = $17::jsonb,
        sensitive_actions = $18::jsonb
      where run_id = $1
    `,
    [
      record.runId,
      record.status,
      result?.stopped ?? "",
      result?.reviewVerdict ?? "",
      result?.summary ?? "",
      result?.clarificationQuestion ?? "",
      result?.diff ?? "",
      JSON.stringify(result?.changedFiles ?? []),
      JSON.stringify(result?.verificationLog ?? []),
      JSON.stringify(result?.reviews ?? []),
      JSON.stringify(record.worktrees),
      result?.turnsUsed ?? 0,
      result?.totalPromptTokens ?? 0,
      result?.totalCompletionTokens ?? 0,
      record.errorMessage ?? result?.error ?? "",
      record.finishedAt ?? new Date().toISOString(),
      JSON.stringify(result?.pendingApproval ?? null),
      JSON.stringify(result?.sensitiveActions ?? []),
    ],
  );
}
