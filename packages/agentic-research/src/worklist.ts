import { promises as fs, type Dirent } from "node:fs";
import path from "node:path";
import { normalizePath } from "@client/shared";
import { IGNORED_DIRS } from "./tools.js";

function isRelevantDir(entry: Dirent): boolean {
  return entry.isDirectory() && !IGNORED_DIRS.has(entry.name) && !entry.name.startsWith(".");
}

async function safeReaddir(absDir: string): Promise<Dirent[]> {
  try {
    return await fs.readdir(absDir, { withFileTypes: true });
  } catch {
    return [];
  }
}

// A directory whose subtree fits comfortably in one crawlUnit() pass is
// left alone even if it still branches internally - Containers/CaseData
// (Models/Actions/DTO/Builders/UI/... - one cohesive feature) should stay
// ONE unit, not fragment into "CaseData/Models", "CaseData/Actions", etc,
// each too small on its own to summarize meaningfully. Only genuinely large
// aggregates (e.g. Containers/ itself, holding ~100 sibling feature
// modules) are worth splitting further. 150 is a rough "one Laravel
// container module's worth of files" - crawlUnit doesn't read every file
// anyway (see its maxTurns), this just bounds how coarse a single summary
// is asked to be.
const UNIT_SIZE_FANOUT_THRESHOLD_FILES = 150;

async function countFilesUpTo(absDir: string, limit: number, depth = 0): Promise<number> {
  if (depth > 8) {
    return 0;
  }

  const entries = await safeReaddir(absDir);
  let count = 0;

  for (const entry of entries) {
    if (count >= limit) {
      break;
    }

    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith(".")) {
        continue;
      }

      count += await countFilesUpTo(path.join(absDir, entry.name), limit - count, depth + 1);
    } else if (entry.isFile()) {
      count += 1;
    }
  }

  return count;
}

// Finds "the level(s) where the project actually branches into many
// features," generically - not by assuming any particular convention (e.g.
// Laravel's app/src/Containers/<name>, which would just be hardcoding one
// project's layout again). A directory with exactly one subdirectory is
// treated as a pass-through wrapper (app -> src -> Containers) and skipped
// through; a genuine fan-out (2+ siblings) that's still too big to crawl as
// one unit recurses into EACH branch too, so a returned unit is only ever a
// true leaf - either a dead end, a single-child chain that dead-ends, or a
// branch small enough to summarize as one cohesive feature.
//
// Bug fix (2026-07-25, live granularity complaint): this used to stop at
// the FIRST fan-out it found and return those directories as final units,
// without ever checking whether one of THEM was itself a further fan-out
// point. On a real Laravel/Apiato project this meant app -> {View, src}
// (app's own fan-out) was treated as final, and src's own ~100
// Containers/<Module> children - the actual feature-sized units this whole
// function exists to find - were folded into one "app/src" blob instead of
// ~100 separate units. An unconditionally recursive first attempt at this
// fix overcorrected the other way (fragmented Containers/CaseData itself
// into CaseData/Models, CaseData/Actions, etc) - the size check above is
// what keeps recursion from going past the actual feature-module level.
async function followToFanOut(absDir: string, depth = 0): Promise<string[]> {
  if (depth > 6) {
    // Hit the depth cap mid-chain - treat where we stopped as a leaf unit
    // rather than silently dropping this branch's coverage entirely.
    return [absDir];
  }

  const subDirs = (await safeReaddir(absDir)).filter(isRelevantDir);

  if (subDirs.length === 0) {
    return [];
  }

  if (subDirs.length === 1) {
    return followToFanOut(path.join(absDir, subDirs[0]!.name), depth + 1);
  }

  const fileCount = await countFilesUpTo(absDir, UNIT_SIZE_FANOUT_THRESHOLD_FILES + 1);

  if (fileCount <= UNIT_SIZE_FANOUT_THRESHOLD_FILES) {
    return [absDir];
  }

  const expanded = await Promise.all(
    subDirs.map((entry) => followToFanOut(path.join(absDir, entry.name), depth + 1)),
  );

  return expanded.flatMap((result, index) => (result.length > 0 ? result : [path.join(absDir, subDirs[index]!.name)]));
}

/**
 * Enumerates candidate "units" (feature-sized directories) for the Observer
 * to crawl one at a time - cheap, no LLM call. Deliberately simpler than
 * docs/architecture/008's aspirational graph-cluster unit of work; this is a
 * pragmatic first cut that works for any project layout, not a hardcoded
 * domain-profile lookup (the exact anti-pattern this whole feature exists to
 * escape).
 */
// Raised 200 -> 500 (2026-07-25) alongside the recursive fan-out fix above -
// a real Laravel/Apiato project's Containers/<Module> layer alone can be
// ~100 units, and that's now found instead of folded into one blob, so the
// old cap could silently truncate coverage of legitimately large projects.
export async function listWorkUnits(projectRootPath: string, maxUnits = 500): Promise<string[]> {
  const rootDirs = (await safeReaddir(projectRootPath)).filter(isRelevantDir);
  const units: string[] = [];

  for (const dir of rootDirs) {
    const absDir = path.join(projectRootPath, dir.name);
    const fanOut = await followToFanOut(absDir);

    if (fanOut.length > 0) {
      for (const absUnit of fanOut) {
        units.push(normalizePath(path.relative(projectRootPath, absUnit)));
      }
    } else {
      units.push(normalizePath(dir.name));
    }
  }

  return units.slice(0, maxUnits);
}

const UNIT_FILE_LISTING_MAX_FILES = 300;
const UNIT_FILE_LISTING_MAX_DEPTH = 8;

/**
 * Bug fix (2026-07-19, full-project review): staleness detection
 * (packages/knowledge's graph-entries.ts) only ever compared content
 * hashes of files a crawl had ALREADY recorded in source_file_hashes - a
 * brand new file dropped into an already-crawled unit was never in that
 * set to begin with, so it was never checked and the unit stayed "fresh"
 * forever regardless. This gives the crawl-time and read-time sides a
 * shared, cheap "what files exist under this unit right now" snapshot so
 * staleness can also ask "is there a file here now that wasn't here at
 * crawl time" - independent of which of those files the LLM actually chose
 * to read (crawls are deliberately selective, see crawlUnit; a file the
 * LLM skipped as irrelevant is NOT "new," it just was never touched).
 * Bounded the same way listWorkUnits already is - a "unit" is meant to be
 * a feature-sized directory, not the whole repo, so this deliberately
 * isn't a full recursive project scan.
 */
export async function listUnitFilePaths(
  projectRootPath: string,
  unitPath: string,
  maxFiles = UNIT_FILE_LISTING_MAX_FILES,
): Promise<string[]> {
  const absUnitDir = path.join(projectRootPath, unitPath);
  const results: string[] = [];

  async function walk(absDir: string, depth: number): Promise<void> {
    if (results.length >= maxFiles || depth > UNIT_FILE_LISTING_MAX_DEPTH) {
      return;
    }

    const entries = await safeReaddir(absDir);

    for (const entry of entries) {
      if (results.length >= maxFiles) {
        return;
      }

      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith(".")) {
          continue;
        }

        await walk(path.join(absDir, entry.name), depth + 1);
      } else if (entry.isFile()) {
        results.push(normalizePath(path.relative(projectRootPath, path.join(absDir, entry.name))));
      }
    }
  }

  await walk(absUnitDir, 0);
  return results;
}
