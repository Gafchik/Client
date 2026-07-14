import { crawlUnit, listWorkUnits } from "@client/agentic-research";
import { hashFiles, queryBusinessGraphEntries, upsertBusinessGraphEntry } from "@client/knowledge";
import { getCurrentProvider } from "./provider-store.js";
import { listProjects } from "./project-store.js";
import { getSelectedTeam } from "./team-store.js";

interface ObserverMonitorConfig {
  intervalMs?: number;
}

// Deliberately much slower than project-state-monitor's 15s tick - this is
// background, non-interactive, low-priority work (nvidia/nemotron-3-ultra by
// default: free, but rate-limited to 15 req/min and, confirmed by direct
// testing, never self-terminates an open-ended task). One bounded crawl per
// tick, on a genuinely finite worklist item, is what gives it an objective
// stopping point - not a turn budget or a nudge.
const DEFAULT_INTERVAL_MS = 5 * 60_000;
const CRAWL_MAX_TURNS = 40;

let monitorTimer: NodeJS.Timeout | null = null;
let monitorRunning = false;
// Round-robin start position across the flattened (project, path) list -
// without this, a project with many units (e.g. 144 containers) would keep
// winning every tick until fully fresh before any OTHER project ever got a
// single crawl, starving every other project for potentially many hours.
let nextPathIndex = 0;

export function startObserverMonitor(config: ObserverMonitorConfig = {}): void {
  if (monitorTimer) {
    return;
  }

  const intervalMs = config.intervalMs ?? DEFAULT_INTERVAL_MS;
  void tick();

  monitorTimer = setInterval(() => {
    void tick();
  }, intervalMs);
  monitorTimer.unref?.();
}

export function stopObserverMonitor(): void {
  if (!monitorTimer) {
    return;
  }

  clearInterval(monitorTimer);
  monitorTimer = null;
}

async function tick(): Promise<void> {
  if (monitorRunning) {
    return;
  }

  monitorRunning = true;

  try {
    // Resolved fresh every tick, never cached - same rationale as
    // resolveMonitorProvider in project-state-monitor.ts: an operator can
    // change the selected team/provider between ticks.
    const selectedTeam = await getSelectedTeam();

    if (!selectedTeam?.observerModel.trim()) {
      return;
    }

    const provider = await getCurrentProvider();

    if (!provider?.baseUrl || !provider.apiKey) {
      return;
    }

    const projects = await listProjects();
    const allPaths = projects.flatMap((project) => project.paths.map((projectPath) => projectPath.rootPath));

    if (allPaths.length === 0) {
      return;
    }

    // Always advance the rotation by one path per tick, regardless of
    // outcome, so a project with nothing stale right now doesn't get
    // re-checked first again before every other project has had a turn.
    const startIndex = nextPathIndex % allPaths.length;
    nextPathIndex = (nextPathIndex + 1) % allPaths.length;

    for (let offset = 0; offset < allPaths.length; offset += 1) {
      const rootPath = allPaths[(startIndex + offset) % allPaths.length]!;
      const crawled = await crawlOneStaleUnit(rootPath, {
        observerModel: selectedTeam.observerModel,
        criticModel: selectedTeam.criticModel,
        providerBaseUrl: provider.baseUrl,
        providerApiKey: provider.apiKey,
      });

      // One crawl per tick, total - crawling is much heavier than a status
      // poll, and letting more than one run per tick risks pile-up if a
      // crawl outlasts the interval (monitorRunning only guards against
      // overlapping ticks, not a slow one delaying the next).
      if (crawled) {
        return;
      }
    }
  } catch (error) {
    console.warn("[observer-monitor] tick failed, will retry next interval:", error);
  } finally {
    monitorRunning = false;
  }
}

async function crawlOneStaleUnit(
  projectRootPath: string,
  models: { observerModel: string; criticModel: string; providerBaseUrl: string; providerApiKey: string },
): Promise<boolean> {
  try {
    const [units, entries] = await Promise.all([
      listWorkUnits(projectRootPath),
      queryBusinessGraphEntries(projectRootPath),
    ]);
    const freshUnitPaths = new Set(entries.filter((entry) => !entry.isStale).map((entry) => entry.unitPath));
    const nextUnit = units.find((unit) => !freshUnitPaths.has(unit));

    if (!nextUnit) {
      return false;
    }

    const result = await crawlUnit({
      projectRootPath,
      unitPath: nextUnit,
      observerModel: models.observerModel,
      criticModel: models.criticModel,
      providerBaseUrl: models.providerBaseUrl,
      providerApiKey: models.providerApiKey,
      maxTurns: CRAWL_MAX_TURNS,
    });

    const sourceFileHashes = await hashFiles(projectRootPath, result.touchedFiles);

    // Written either way (cheap diagnostic breadcrumb, and isStale is always
    // true when sourceFileHashes is empty, so a failed attempt self-heals on
    // the next pass rather than looking like a trusted, empty result). But an
    // outright transport/provider failure (e.g. the free-tier 15rpm limit)
    // isn't "this project made progress" - it shouldn't stop this tick's
    // rotation from reaching the NEXT project, unlike a real (even if
    // incomplete) crawl attempt.
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
