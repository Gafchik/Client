import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { crawlUnit, listUnitFilePaths, listWorkUnits } from "@client/agentic-research";
import { hashFiles, queryBusinessGraphEntries, upsertBusinessGraphEntry } from "@client/knowledge";
import { computeFileChurnSignals, type FileChurnSignal } from "@client/repository-git";
import type { ObserverActivityInfo, ObserverProgressInfo } from "@client/shared";
import { hasAnyActiveQuestionRun } from "./pipeline-runner.js";
import { getCurrentProvider } from "./provider-store.js";
import { getSelectedTeam } from "./team-store.js";

const execFileAsync = promisify(execFile);

// Per-user request (2026-07-15): Observer moved from one automatic global
// timer to per-project runners the user explicitly starts/stops, like a
// runner - open project A, start it; open project B, start it too, both
// crawl in parallel; stop-all before an important interactive question,
// start again after. No auto-start on server boot - runners begin stopped.
const CRAWL_MAX_TURNS = 40;
// How long a running-but-currently-idle runner waits before rechecking
// (nothing stale right now, or waiting out the interactive-contention gate)
// rather than busy-looping.
const IDLE_RECHECK_MS = 20_000;
// Once a full pass finds nothing stale, the expensive check (directory walk
// + per-file content hashing, confirmed live to run on every tick regardless
// of project size) backs off to this instead of repeating every 20s forever
// - the user's own point: git HEAD gets checked every IDLE_RECHECK_MS
// regardless (cheap, ~10ms), so switching to an old branch is still caught
// within ~20s even while the expensive re-hash pass itself is resting.
const RESTING_RECHECK_MS = 90_000;

interface ObserverRunner {
  projectRootPath: string;
  stopRequested: boolean;
  activity: ObserverActivityInfo | null;
  /** HEAD at the last full stale-check pass - a change forces an immediate re-check even while resting. */
  lastCheckedHead: string | null;
  /** Set once a full pass finds nothing stale; cleared the moment HEAD moves. */
  resting: boolean;
  /**
   * Per-unit backoff state (2026-07-19 full-project review fix): a unit that
   * hits max_turns/error/an empty-content final_answer used to be treated
   * identically to a real success - no idle sleep, and since unit selection
   * always picks the FIRST non-fresh unit in worklist order, the exact same
   * hard-to-crawl unit got re-selected and re-crawled (a fresh 40-turn LLM
   * run) on literally the next loop iteration, forever - permanently
   * starving every other unit in the worklist while burning budget. Tracked
   * per runner (per project), not globally, and cleared the moment a unit
   * genuinely completes with real content.
   */
  retryState: Map<string, { failureCount: number; nextRetryAt: number }>;
  /**
   * Resolves once THIS runner's own loop has actually stopped iterating -
   * not merely when stopRequested was set (2026-07-19 fix). A stop can take
   * up to one full crawlUnit turn to actually take effect (shouldAbort is
   * only polled once per turn), so a stop-then-immediately-start sequence
   * used to leave the OLD loop invisibly still running (overwritten in the
   * `runners` map, so listObserverRunners could no longer see it) while a
   * NEW loop started fresh over the SAME project path - since the DB write
   * for whatever unit the old loop was mid-crawling only lands after ITS
   * crawlUnit call finishes, the new loop could legitimately pick that same
   * still-stale unit and run a second, concurrent LLM crawl of it.
   * startObserver chains off the previous runner's copy of this instead of
   * racing it.
   */
  loopExited: Promise<void>;
}

// Backoff for a unit that failed/didn't complete (2026-07-19 fix) - doubles
// per consecutive failure, capped at RESTING_RECHECK_MS so a permanently
// broken unit still gets rechecked eventually (e.g. after a fix lands)
// without hammering it every idle tick in the meantime.
const UNIT_RETRY_BASE_MS = 30_000;
const UNIT_RETRY_MAX_MS = RESTING_RECHECK_MS;

async function getCurrentHead(projectRootPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: projectRootPath });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

const runners = new Map<string, ObserverRunner>();

export function startObserver(projectRootPath: string): void {
  const existing = runners.get(projectRootPath);

  if (existing && !existing.stopRequested) {
    return;
  }

  // Chain off the previous runner's own exit instead of racing it (see
  // ObserverRunner.loopExited) - non-blocking for the caller (the new
  // runner is registered in `runners` immediately, so status/stop calls
  // against it work right away), it only delays this runner's OWN first
  // loop iteration until the old one is confirmed gone.
  const readyPromise = existing ? existing.loopExited : Promise.resolve();
  const runner: ObserverRunner = {
    projectRootPath,
    stopRequested: false,
    activity: null,
    lastCheckedHead: null,
    resting: false,
    retryState: new Map(),
    loopExited: Promise.resolve(),
  };
  runners.set(projectRootPath, runner);
  runner.loopExited = readyPromise.then(() => runnerLoop(runner));
}

export function stopObserver(projectRootPath: string): void {
  const runner = runners.get(projectRootPath);

  if (runner) {
    runner.stopRequested = true;
  }
}

/** Returns the project paths that were actually running (so the caller/UI can offer to resume exactly those). */
export function stopAllObservers(): string[] {
  const stopped: string[] = [];

  for (const runner of runners.values()) {
    if (!runner.stopRequested) {
      runner.stopRequested = true;
      stopped.push(runner.projectRootPath);
    }
  }

  return stopped;
}

export function listObserverRunners(): Array<{ projectPath: string; status: "running" | "stopped"; activity: ObserverActivityInfo | null; resting: boolean }> {
  return Array.from(runners.values()).map((runner) => ({
    projectPath: runner.projectRootPath,
    status: runner.stopRequested ? "stopped" : "running",
    activity: runner.activity,
    resting: runner.resting,
  }));
}

// No LLM call, but listWorkUnits (directory walk) + queryBusinessGraphEntries
// (per-file content hashing for staleness) both do real disk I/O - too
// pricey to redo unconditionally on every frontend poll of every project
// (including stopped runners) once the poll interval got tightened for a
// snappier UI. A few seconds of staleness is invisible next to how long a
// single crawl unit actually takes (well over a minute), so a short TTL
// cache is free correctness-wise.
const PROGRESS_CACHE_TTL_MS = 4_000;
const progressCache = new Map<string, { expiresAt: number; value: ObserverProgressInfo }>();

export async function getObserverProgress(projectRootPath: string): Promise<ObserverProgressInfo> {
  const cached = progressCache.get(projectRootPath);

  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const [units, entries] = await Promise.all([
    listWorkUnits(projectRootPath),
    queryBusinessGraphEntries(projectRootPath),
  ]);
  const freshUnitPaths = new Set(entries.filter((entry) => !entry.isStale).map((entry) => entry.unitPath));
  const freshUnits = units.filter((unit) => freshUnitPaths.has(unit)).length;

  const value: ObserverProgressInfo = {
    totalUnits: units.length,
    freshUnits,
    percent: units.length === 0 ? 100 : Math.round((freshUnits / units.length) * 100),
  };

  progressCache.set(projectRootPath, { expiresAt: Date.now() + PROGRESS_CACHE_TTL_MS, value });
  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runnerLoop(runner: ObserverRunner): Promise<void> {
  let lastFullCheckAt = 0;

  while (!runner.stopRequested) {
    // A background crawl shares the same provider/API key as live
    // interactive requests - live testing showed message-sending degrading
    // exactly when a crawl was in flight. Wait out any active question-run
    // rather than starting a new unit while one is in progress; shouldAbort
    // (passed to crawlUnit below) covers one starting mid-crawl.
    if (hasAnyActiveQuestionRun()) {
      await sleep(IDLE_RECHECK_MS);
      continue;
    }

    // Resolved fresh every loop iteration, never cached - an operator can
    // change the selected team/provider while a runner is active.
    const selectedTeam = await getSelectedTeam();

    if (!selectedTeam?.observerModel.trim()) {
      await sleep(IDLE_RECHECK_MS);
      continue;
    }

    const provider = await getCurrentProvider();

    if (!provider?.baseUrl || !provider.apiKey) {
      await sleep(IDLE_RECHECK_MS);
      continue;
    }

    // Once fully caught up, the expensive check (directory walk + per-file
    // content hashing) backs off to RESTING_RECHECK_MS instead of repeating
    // every IDLE_RECHECK_MS forever - but a plain `git rev-parse HEAD`
    // (~10ms) is cheap enough to still poll at the short interval, so
    // switching to a branch with different content is still caught within
    // ~IDLE_RECHECK_MS even while the expensive pass itself is resting.
    if (runner.resting) {
      const currentHead = await getCurrentHead(runner.projectRootPath);
      const headChanged = currentHead !== null && currentHead !== runner.lastCheckedHead;
      const restIntervalElapsed = Date.now() - lastFullCheckAt >= RESTING_RECHECK_MS;

      if (!headChanged && !restIntervalElapsed) {
        await sleep(IDLE_RECHECK_MS);
        continue;
      }
    }

    const crawled = await crawlOneStaleUnit(runner, {
      observerModel: selectedTeam.observerModel,
      criticModel: selectedTeam.criticModel,
      providerBaseUrl: provider.baseUrl,
      providerApiKey: provider.apiKey,
    });
    lastFullCheckAt = Date.now();
    runner.lastCheckedHead = await getCurrentHead(runner.projectRootPath);

    if (!crawled) {
      // Nothing stale right now (or a transient issue) - don't busy-loop
      // re-checking the same, already-fresh worklist.
      await sleep(IDLE_RECHECK_MS);
    }
  }
}

// Bug fix (2026-07-19, architecture review #11/#16): unit selection used to
// just take the first stale, non-backoff unit in whatever order
// listWorkUnits happened to return - no notion of "cover the whole project
// before re-deepening" or "this area is under active development, refresh
// it sooner." Two deterministic, already-available signals now drive
// order instead of an LLM guess: (1) a unit with NO entry at all yet
// (never crawled) always goes before one that's merely stale - full first-
// pass coverage beats repeatedly refreshing what's already at least
// partially known; (2) among already-crawled-but-stale units, higher git
// churn (commits touching files under that unit, last 6 months - same
// signal impact-analysis's buildRisks already uses, not a new one) goes
// first, on the theory that a unit under active development is more likely
// to already be stale again by the time anyone reads its summary. Fix
// commits count double, mirroring impact-analysis's own established
// "fixCommitCount is a stronger risk signal than raw commitCount" weighting.
function scoreUnitChurn(unit: string, churnByFile: Map<string, FileChurnSignal>): number {
  let score = 0;

  for (const [filePath, signal] of churnByFile) {
    if (filePath === unit || filePath.startsWith(`${unit}/`)) {
      score += signal.commitCount + signal.fixCommitCount * 2;
    }
  }

  return score;
}

function prioritizeStaleUnits(
  staleUnits: string[],
  everCrawledUnitPaths: Set<string>,
  churnByFile: Map<string, FileChurnSignal>,
): string[] {
  return [...staleUnits].sort((left, right) => {
    const leftNeverCrawled = !everCrawledUnitPaths.has(left);
    const rightNeverCrawled = !everCrawledUnitPaths.has(right);

    if (leftNeverCrawled !== rightNeverCrawled) {
      return leftNeverCrawled ? -1 : 1;
    }

    if (leftNeverCrawled && rightNeverCrawled) {
      // Both never crawled - no churn signal is more meaningful than
      // "hasn't been looked at yet" here, keep listWorkUnits' own order
      // (Array.sort is stable in Node, so returning 0 preserves it).
      return 0;
    }

    return scoreUnitChurn(right, churnByFile) - scoreUnitChurn(left, churnByFile);
  });
}

async function crawlOneStaleUnit(
  runner: ObserverRunner,
  models: { observerModel: string; criticModel: string; providerBaseUrl: string; providerApiKey: string },
): Promise<boolean> {
  const projectRootPath = runner.projectRootPath;

  try {
    const [units, entries, churnByFile] = await Promise.all([
      listWorkUnits(projectRootPath),
      queryBusinessGraphEntries(projectRootPath),
      // Best-effort: no git history (fresh repo, git unavailable, timeout)
      // just means every unit scores 0 churn - falls back to listWorkUnits'
      // own order among already-crawled-but-stale units, exactly today's
      // pre-fix behavior for that subset.
      computeFileChurnSignals(projectRootPath).catch(() => new Map<string, FileChurnSignal>()),
    ]);
    const freshUnitPaths = new Set(entries.filter((entry) => !entry.isStale).map((entry) => entry.unitPath));
    const everCrawledUnitPaths = new Set(entries.map((entry) => entry.unitPath));
    const staleUnits = units.filter((unit) => !freshUnitPaths.has(unit));
    const prioritizedStaleUnits = prioritizeStaleUnits(staleUnits, everCrawledUnitPaths, churnByFile);
    const now = Date.now();
    // Skips a unit still in backoff (see ObserverRunner.retryState) and
    // falls through to the next stale one instead - a hard-to-crawl unit no
    // longer blocks the rest of the worklist just by sitting first in order.
    const nextUnit = prioritizedStaleUnits.find((unit) => (runner.retryState.get(unit)?.nextRetryAt ?? 0) <= now);

    if (staleUnits.length === 0) {
      // Genuinely nothing left to do - a real "fully studied" rest.
      runner.resting = true;
      return false;
    }

    if (!nextUnit) {
      // Everything still stale is in backoff right now - NOT the same as
      // fully studied, just waiting out a cooldown; do not report false
      // completion (2026-07-19 fix).
      runner.resting = false;
      return false;
    }

    runner.resting = false;
    runner.activity = { projectPath: projectRootPath, unitPath: nextUnit, startedAt: new Date().toISOString() };

    const result = await crawlUnit({
      projectRootPath,
      unitPath: nextUnit,
      observerModel: models.observerModel,
      criticModel: models.criticModel,
      providerBaseUrl: models.providerBaseUrl,
      providerApiKey: models.providerApiKey,
      maxTurns: CRAWL_MAX_TURNS,
      // Checked every turn, not just before starting - an explicit user
      // stop (or a question-run that started mid-crawl) yields within one
      // turn instead of running to completion regardless.
      shouldAbort: () => runner.stopRequested || hasAnyActiveQuestionRun(),
    }).finally(() => {
      runner.activity = null;
    });

    // Yielded before doing real work - not worth a diagnostic row (just
    // noise), and not "progress" either, so the loop doesn't skip its idle
    // backoff on the next iteration.
    if (result.raw.stopped === "aborted") {
      return false;
    }

    // Real evidence: 24/25 units of a live test project ended up "fresh"
    // forever with a literal error message as their featureSummary, because
    // this used to hash whatever files got touched before a crawl failed
    // (e.g. read one file, then hit a 429) regardless of outcome - a file's
    // content hash doesn't change just because the crawl that read it later
    // failed, so isStale (empty-hashes-only) never re-triggered and the
    // failure was permanently mistaken for a completed, trustworthy result.
    // Only a genuine final_answer counts as "learned this unit" - anything
    // else stores empty hashes so it stays stale and gets retried next pass.
    const sourceFileHashes = result.raw.stopped === "final_answer"
      ? await hashFiles(projectRootPath, result.touchedFiles)
      : {};
    // Snapshot of every file under the unit right now, not just the ones the
    // LLM touched (2026-07-19, full-project review) - lets a later read
    // notice a brand new file added after this crawl, which sourceFileHashes
    // alone can't (see graph-entries.ts's mapRow). Only meaningful paired
    // with a genuine success - [] on failure is fine since empty
    // sourceFileHashes already forces isStale regardless.
    const knownFilePaths = result.raw.stopped === "final_answer"
      ? await listUnitFilePaths(projectRootPath, nextUnit)
      : [];

    // Written either way (cheap diagnostic breadcrumb, and isStale is always
    // true when sourceFileHashes is empty, so a failed attempt self-heals on
    // the next pass rather than looking like a trusted, empty result).
    await upsertBusinessGraphEntry({
      projectRootPath,
      unitPath: nextUnit,
      featureSummary: result.featureSummary,
      keyMechanisms: result.keyMechanisms,
      gotchas: result.gotchas,
      sourceFileHashes,
      knownFilePaths,
      confidence: result.confidence,
    });

    const genuinelySucceeded = result.raw.stopped === "final_answer" && Object.keys(sourceFileHashes).length > 0;

    if (genuinelySucceeded) {
      runner.retryState.delete(nextUnit);
      return true;
    }

    // Bug fix (2026-07-19, full-project review): max_turns used to be
    // indistinguishable from a real success here (this function used to
    // just return `stopped !== "error"`, which is true for max_turns) - a
    // unit that genuinely cannot be crawled within CRAWL_MAX_TURNS got
    // re-selected and re-crawled (a fresh 40-turn LLM run) on literally the
    // next loop iteration, forever, since unit selection always picks the
    // first stale unit in order - permanently starving every other unit in
    // the worklist. Same fate for a "final_answer" with zero touched files
    // (sourceFileHashes empty -> immediately stale again, see
    // graph-entries.ts's isStale). Exponential, capped backoff instead -
    // this unit stops hogging every cycle but still gets retried
    // eventually, and prioritizedStaleUnits.find() above now falls through
    // to the NEXT stale unit in the meantime instead of blocking on this one.
    const previous = runner.retryState.get(nextUnit);
    const failureCount = (previous?.failureCount ?? 0) + 1;
    const delayMs = Math.min(UNIT_RETRY_BASE_MS * 2 ** (failureCount - 1), UNIT_RETRY_MAX_MS);
    runner.retryState.set(nextUnit, { failureCount, nextRetryAt: Date.now() + delayMs });
    return false;
  } catch (error) {
    console.warn(`[observer-monitor] crawl of ${projectRootPath} failed:`, error);
    return false;
  }
}
