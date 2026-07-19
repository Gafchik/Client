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

// Finds "the level where the project actually branches into many features,"
// generically - not by assuming any particular convention (e.g. Laravel's
// app/src/Containers/<name>, which would just be hardcoding one project's
// layout again). A directory with exactly one subdirectory is treated as a
// pass-through wrapper (app -> src -> Containers) and skipped through until
// reaching either a genuine fan-out (2+ siblings) or a dead end.
async function followToFanOut(absDir: string, depth = 0): Promise<string[]> {
  if (depth > 6) {
    return [];
  }

  const subDirs = (await safeReaddir(absDir)).filter(isRelevantDir);

  if (subDirs.length === 0) {
    return [];
  }

  if (subDirs.length > 1) {
    return subDirs.map((entry) => path.join(absDir, entry.name));
  }

  return followToFanOut(path.join(absDir, subDirs[0]!.name), depth + 1);
}

/**
 * Enumerates candidate "units" (feature-sized directories) for the Observer
 * to crawl one at a time - cheap, no LLM call. Deliberately simpler than
 * docs/architecture/008's aspirational graph-cluster unit of work; this is a
 * pragmatic first cut that works for any project layout, not a hardcoded
 * domain-profile lookup (the exact anti-pattern this whole feature exists to
 * escape).
 */
export async function listWorkUnits(projectRootPath: string, maxUnits = 200): Promise<string[]> {
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
