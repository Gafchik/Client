import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { crawlUnit, listWorkUnits } from "@client/agentic-research";
import { hashFiles, queryBusinessGraphEntries, upsertBusinessGraphEntry } from "@client/knowledge";
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
}

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

  const runner: ObserverRunner = {
    projectRootPath,
    stopRequested: false,
    activity: null,
    lastCheckedHead: null,
    resting: false,
  };
  runners.set(projectRootPath, runner);
  void runnerLoop(runner);
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

async function crawlOneStaleUnit(
  runner: ObserverRunner,
  models: { observerModel: string; criticModel: string; providerBaseUrl: string; providerApiKey: string },
): Promise<boolean> {
  const projectRootPath = runner.projectRootPath;

  try {
    const [units, entries] = await Promise.all([
      listWorkUnits(projectRootPath),
      queryBusinessGraphEntries(projectRootPath),
    ]);
    const freshUnitPaths = new Set(entries.filter((entry) => !entry.isStale).map((entry) => entry.unitPath));
    const nextUnit = units.find((unit) => !freshUnitPaths.has(unit));

    if (!nextUnit) {
      runner.resting = true;
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

    // Written either way (cheap diagnostic breadcrumb, and isStale is always
    // true when sourceFileHashes is empty, so a failed attempt self-heals on
    // the next pass rather than looking like a trusted, empty result).
    await upsertBusinessGraphEntry({
      projectRootPath,
      unitPath: nextUnit,
      featureSummary: result.featureSummary,
      keyMechanisms: [],
      gotchas: [],
      sourceFileHashes,
      confidence: result.confidence,
    });

    return result.raw.stopped !== "error";
  } catch (error) {
    console.warn(`[observer-monitor] crawl of ${projectRootPath} failed:`, error);
    return false;
  }
}
