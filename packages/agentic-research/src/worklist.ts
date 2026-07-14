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
