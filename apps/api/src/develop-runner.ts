import path from "node:path";
import { promises as fs } from "node:fs";
import { runDevelopmentTask, runShellCommand, type DevelopRunResult, type DevelopSensitiveAction, type WorkspaceRoot } from "@client/agentic-research";
import { classifyFactConflict, extractCodePatternFacts } from "@client/ai";
import { getFileDependents } from "@client/graph";
import { promoteFactsFromDevelopment, queryFactsAcrossPaths, queryGlossaryAcrossPaths } from "@client/knowledge";
import { collectWorktreeChanges, createTaskWorktree, removeTaskWorktree, type TaskWorktree } from "@client/repository-git";
import { normalizePath, stableId, type GraphState, type ProjectPathRecord } from "@client/shared";
import { loadGraphSnapshot } from "./graph-store.js";
import { buildGlossaryHint, buildGraphNavigationTool, buildKnownFactsHint, buildObserverHintSuffix, buildSemanticSearchTool, buildSemanticSeedLookup } from "./pipeline-runner.js";
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
}

export interface StartDevelopRunInput {
  task: string;
  projectPath: string;
  projectPaths?: ProjectPathRecord[];
  providerBaseUrl: string;
  providerApiKey: string;
  developerModel: string;
  reviewerModel: string;
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
}

const MAX_TRACKED_RUNS = 100;
const developRunStatuses = new Map<string, DevelopRunStatusRecord>();

export function getDevelopRunStatus(runId: string): DevelopRunStatusRecord | null {
  return developRunStatuses.get(runId) ?? null;
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
  };

  pruneTrackedRuns();
  developRunStatuses.set(runId, record);

  void insertTelemetryRow(record).catch(() => {
    // Telemetry must never block or fail a run - same graceful-degradation
    // stance every other Postgres consumer in this app takes.
  });

  void executeDevelopRun(record, input)
    .then(() => {
      maybeAdvanceChain(record, input);
    })
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
function maybeAdvanceChain(record: DevelopRunStatusRecord, input: StartDevelopRunInput): void {
  const result = record.result;
  const cleanApproval = result?.stopped === "task_complete" && result.reviewVerdict === "approved";

  // Tests-as-separate-step (2026-07-18, docs/architecture/011 §4.12,
  // explicit product-owner directive): real projects, including this one's
  // own primary test target, are commonly NOT test-covered by convention -
  // the Reviewer no longer blocks on missing tests (see REVIEWER_SYSTEM_PROMPT),
  // and the Developer no longer writes test files unprompted (see
  // buildDevelopSystemPrompt instruction 8). Coverage is offered as an
  // explicit question ONLY once the whole task/chain is genuinely done -
  // not per intermediate chain link, matching "в конце разработки".
  if (cleanApproval && !input.chainRemaining?.length && result) {
    record.testsOffered = true;
    result.summary = `${result.summary ?? ""}\n\nПокрыть это тестами? (да / нет / свой вариант — какие именно)`;
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
    conversationId: record.conversationId,
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

async function executeDevelopRun(record: DevelopRunStatusRecord, input: StartDevelopRunInput): Promise<void> {
  const originalRoots: WorkspaceRoot[] = input.projectPaths?.length
    ? input.projectPaths.map((pathRecord) => ({
        label: pathRecord.name,
        absolutePath: normalizePath(path.resolve(pathRecord.rootPath)),
        role: pathRecord.role,
      }))
    : [{ label: "root", absolutePath: normalizePath(path.resolve(input.projectPath)), role: "unknown" }];

  // Worktree per physical repo - all-or-nothing: a task that can only be
  // isolated in HALF the project must not run at all (the un-isolated half
  // would be mutated in the user's own checkout). A correction run re-enters
  // the previous run's worktrees instead (they still hold the delivered
  // changes the user is giving feedback on).
  const reusedWorktrees = input.continueFrom?.worktrees.length === originalRoots.length
    ? input.continueFrom.worktrees.map((info): TaskWorktree => ({
        rootPath: info.rootPath,
        worktreePath: info.worktreePath,
        branch: info.branch,
        startCommit: info.startCommit,
      }))
    : null;
  const worktrees: TaskWorktree[] = reusedWorktrees ?? [];

  if (!reusedWorktrees) {
    try {
      for (const root of originalRoots) {
        worktrees.push(await createTaskWorktree(root.absolutePath, record.runId.slice(0, 12), root.label));
      }
    } catch (error) {
      await Promise.all(worktrees.map((worktree) => removeTaskWorktree(worktree, { deleteBranch: true }).catch(() => {})));
      throw error;
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

  try {
    const originalPaths = originalRoots.map((root) => root.absolutePath);
    const [facts, glossary, verificationHint] = await Promise.all([
      queryFactsAcrossPaths(originalPaths),
      queryGlossaryAcrossPaths(originalPaths),
      buildVerificationCommandsHint(input.projectPath),
    ]);
    knownFactsHint = [buildKnownFactsHint(originalRoots, facts), buildGlossaryHint(glossary), verificationHint]
      .filter(Boolean)
      .join("\n\n");
  } catch {
    // no memory, still a valid run
  }

  try {
    observerHint = await buildObserverHintSuffix(originalRoots, input.task);
  } catch {
    // same
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
    semanticSearch: semanticSearchTool,
    semanticSeedFiles: semanticSeedFilesTool,
    ...(findReferencesTool ? { findReferences: findReferencesTool } : {}),
    ...(impactPreviewTool ? { computeImpactPreview: impactPreviewTool } : {}),
    ...(input.continueFrom
      ? {
          priorIteration: {
            task: input.continueFrom.priorTask,
            summary: input.continueFrom.priorSummary,
            worktreeCarriesChanges: Boolean(reusedWorktrees),
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

  // Never clean up while the run is PAUSED waiting for the human (2026-07-18
  // fix): both needs-clarification and needs-approval can legitimately have
  // an empty diff at the pause point (e.g. ask_user/a migration request
  // fired before any edit), and the SAME check below (diff.trim() empty ->
  // delete) was unconditionally wiping the worktree the continuation
  // (continueFrom) needs to re-enter. Previously this silently degraded
  // every needs-clarification continuation into a fresh worktree instead of
  // a real one - harmless there (nothing had been written yet in practice),
  // but would have discarded real in-progress edits for needs-approval.
  const isPausedForHuman = result.stopped === "needs-clarification" || result.stopped === "needs-approval";

  if (!result.diff.trim() && !isPausedForHuman) {
    // Nothing to merge - the branch and worktree would just be litter.
    await Promise.all(worktrees.map((worktree) => removeTaskWorktree(worktree, { deleteBranch: true }).catch(() => {})));
    record.worktrees = [];
  }
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
