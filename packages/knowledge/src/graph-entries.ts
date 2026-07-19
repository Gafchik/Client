import { promises as fs } from "node:fs";
import path from "node:path";
import { listUnitFilePaths } from "@client/agentic-research";
import { contentHash, stableId } from "@client/shared";
import { runSql } from "./postgres-client.js";

export interface BusinessGraphEntry {
  id: string;
  projectRootPath: string;
  unitPath: string;
  featureSummary: string;
  keyMechanisms: string[];
  gotchas: string[];
  sourceFileHashes: Record<string, string>;
  /** Full file listing under this unit AT CRAWL TIME (not just the files the LLM chose to read) - see isStale's "new file" check below. */
  knownFilePaths: string[];
  confidence: number;
  createdAt: string;
  lastCrawledAt: string;
  /** Recomputed at read time from current file content hashes - not stored. */
  isStale: boolean;
}

interface BusinessGraphEntryRow {
  id: string;
  project_root_path: string;
  unit_path: string;
  feature_summary: string;
  key_mechanisms: string[];
  gotchas: string[];
  source_file_hashes: Record<string, string>;
  known_file_paths: string[] | null;
  confidence: number;
  created_at: Date;
  last_crawled_at: Date;
}

async function currentHashOf(projectRootPath: string, filePath: string): Promise<string | null> {
  try {
    const content = await fs.readFile(path.resolve(projectRootPath, filePath), "utf8");
    return contentHash(content);
  } catch {
    return null;
  }
}

async function mapRow(row: BusinessGraphEntryRow): Promise<BusinessGraphEntry> {
  const sourceFileHashes = row.source_file_hashes ?? {};
  const knownFilePaths = row.known_file_paths ?? [];
  const paths = Object.keys(sourceFileHashes);
  // Content-hash equality, not commit order or date - a developer switching
  // to an older branch can make files "go back in time," and staleness must
  // still be detected correctly regardless of that direction (same idiom as
  // queryRelevantFacts in facts.ts). Hashed on demand for just this entry's
  // own small file set, rather than requiring a full project IndexResult -
  // cheap enough to do per-entry on every read, no separate index needed.
  let isStale = paths.length === 0;

  if (!isStale) {
    for (const filePath of paths) {
      const currentHash = await currentHashOf(row.project_root_path, filePath);
      if (currentHash !== sourceFileHashes[filePath]) {
        isStale = true;
        break;
      }
    }
  }

  // Bug fix (2026-07-19, full-project review): the hash loop above can only
  // ever notice a file it ALREADY knew about changing - a brand new file
  // dropped into an already-crawled unit was never in sourceFileHashes to
  // begin with, so it was never checked and the unit stayed "fresh" forever
  // regardless of what got added. Compares against knownFilePaths (the full
  // directory listing AT CRAWL TIME, not just the subset the LLM chose to
  // read - crawls are deliberately selective, see crawlUnit, so a file it
  // skipped as irrelevant is not "new"). Only runs when the hash check
  // didn't already decide staleness, and only when we HAVE a crawl-time
  // listing to compare against (older rows written before this fix carry
  // an empty array - degrades to hash-only staleness for those, exactly
  // today's behavior, rather than falsely flagging every pre-existing row
  // stale on the next read). Never throws - a filesystem hiccup here must
  // degrade to "assume no new files," not take staleness detection down.
  if (!isStale && knownFilePaths.length > 0) {
    try {
      const currentFilePaths = await listUnitFilePaths(row.project_root_path, row.unit_path);
      const knownSet = new Set(knownFilePaths);
      isStale = currentFilePaths.some((filePath) => !knownSet.has(filePath));
    } catch {
      // Filesystem unavailable/unit path gone - leave isStale as decided by hashes above.
    }
  }

  return {
    id: row.id,
    projectRootPath: row.project_root_path,
    unitPath: row.unit_path,
    featureSummary: row.feature_summary,
    keyMechanisms: row.key_mechanisms ?? [],
    gotchas: row.gotchas ?? [],
    sourceFileHashes,
    knownFilePaths,
    confidence: row.confidence,
    createdAt: new Date(row.created_at).toISOString(),
    lastCrawledAt: new Date(row.last_crawled_at).toISOString(),
    isStale,
  };
}

/**
 * Читает накопленные записи бизнес-графа (Observer, packages/agentic-research)
 * и пересчитывает staleness по content hash каждой конкретной ссылки — тот же
 * без-фонового-job подход, что и у Fact Store (queryRelevantFacts): протухшую
 * запись не нужно отдельно инвалидировать, она просто помечается isStale при
 * следующем чтении. Никогда не бросает исключение — недоступность Postgres не
 * должна ронять research, только деградировать до "подсказок нет".
 */
export async function queryBusinessGraphEntries(projectRootPath: string): Promise<BusinessGraphEntry[]> {
  try {
    const rows = await runSql<BusinessGraphEntryRow>(
      `select * from business_graph_entries where project_root_path = $1 order by last_crawled_at desc`,
      [projectRootPath],
    );

    return await Promise.all(rows.map((row) => mapRow(row)));
  } catch (error) {
    console.warn("[graph-entries] queryBusinessGraphEntries failed, degrading to no hints:", error);
    return [];
  }
}

/** Cross-path variant (2026-07-16, multi-path unification) - Observer crawls each physical repo of a project independently, this reads hints from ALL of them at once for the agentic Researcher's observerHint. */
export async function queryBusinessGraphEntriesAcrossPaths(projectRootPaths: string[]): Promise<BusinessGraphEntry[]> {
  if (projectRootPaths.length === 0) {
    return [];
  }

  try {
    const rows = await runSql<BusinessGraphEntryRow>(
      `select * from business_graph_entries where project_root_path = any($1::text[]) order by last_crawled_at desc`,
      [projectRootPaths],
    );

    return await Promise.all(rows.map((row) => mapRow(row)));
  } catch (error) {
    console.warn("[graph-entries] queryBusinessGraphEntriesAcrossPaths failed, degrading to no hints:", error);
    return [];
  }
}

/** Removes every Observer-crawled entry for one physical path (2026-07-16) - see facts.ts's deleteFactsForPath for why. */
export async function deleteBusinessGraphEntriesForPath(projectRootPath: string): Promise<void> {
  try {
    await runSql(`delete from business_graph_entries where project_root_path = $1`, [projectRootPath]);
  } catch (error) {
    console.warn("[graph-entries] deleteBusinessGraphEntriesForPath failed:", error);
  }
}

/** Hashes a small, known set of files (e.g. what one crawl touched) - not a full project scan. */
export async function hashFiles(projectRootPath: string, filePaths: string[]): Promise<Record<string, string>> {
  const entries = await Promise.all(
    filePaths.map(async (filePath) => [filePath, await currentHashOf(projectRootPath, filePath)] as const),
  );

  return Object.fromEntries(entries.filter((entry): entry is [string, string] => entry[1] !== null));
}

export interface UpsertBusinessGraphEntryInput {
  projectRootPath: string;
  unitPath: string;
  featureSummary: string;
  keyMechanisms: string[];
  gotchas: string[];
  sourceFileHashes: Record<string, string>;
  /** Full file listing under this unit at crawl time - see BusinessGraphEntry.knownFilePaths. */
  knownFilePaths: string[];
  confidence: number;
}

/** Fire-and-forget from the Observer crawl - never throws. */
export async function upsertBusinessGraphEntry(input: UpsertBusinessGraphEntryInput): Promise<void> {
  try {
    const id = stableId(["business-graph", input.projectRootPath, input.unitPath]);
    const now = new Date().toISOString();

    await runSql(
      `
        insert into business_graph_entries
          (id, project_root_path, unit_path, feature_summary, key_mechanisms, gotchas, source_file_hashes, known_file_paths, confidence, created_at, last_crawled_at)
        values ($1, $2, $3, $4, $5::text[], $6::text[], $7::jsonb, $8::text[], $9, $10, $10)
        on conflict (id) do update set
          feature_summary = excluded.feature_summary,
          key_mechanisms = excluded.key_mechanisms,
          gotchas = excluded.gotchas,
          source_file_hashes = excluded.source_file_hashes,
          known_file_paths = excluded.known_file_paths,
          confidence = excluded.confidence,
          last_crawled_at = excluded.last_crawled_at
      `,
      [
        id,
        input.projectRootPath,
        input.unitPath,
        input.featureSummary,
        input.keyMechanisms,
        input.gotchas,
        JSON.stringify(input.sourceFileHashes),
        input.knownFilePaths,
        Math.max(5, Math.min(100, Math.round(input.confidence))),
        now,
      ],
    );
  } catch (error) {
    console.warn("[graph-entries] upsertBusinessGraphEntry failed:", error);
  }
}

const MAX_GOTCHAS_PER_ENTRY = 15;

/**
 * Opportunistic correction (2026-07-19, architecture review "safety fuse"
 * request): isStale only ever catches "the code changed since the crawl" -
 * it has no way to express "the crawl was wrong/incomplete from day one and
 * the code never changed since." Appends a scoped correction note to an
 * EXISTING entry's gotchas - not a full rewrite - when an independent Critic
 * pass (packages/agentic-research's callCritic, never the researcher's own
 * self-assertion) finds a transcript-backed contradiction between a real
 * run's answer and this entry's own text. A `where` clause matching the
 * exact row (not a read-modify-write in application code) keeps the array
 * append atomic against a concurrent Observer crawl overwriting the same
 * row - Postgres's own `||` array concat operator does the append inside
 * the UPDATE itself. Capped so an entry that keeps getting flagged doesn't
 * grow its gotchas list forever; the reset-knowledge button (apps/api's
 * /api/observer/reset-knowledge) is the real fix for an entry that has
 * accumulated enough corrections to mean the summary itself needs redoing.
 */
export async function appendBusinessGraphEntryCorrection(input: {
  projectRootPath: string;
  unitPath: string;
  note: string;
}): Promise<void> {
  try {
    const taggedNote = `[ПОПРАВКА ${new Date().toISOString().slice(0, 10)}] ${input.note}`;
    await runSql(
      `
        update business_graph_entries
        set gotchas = gotchas || $3::text[]
        where project_root_path = $1 and unit_path = $2 and coalesce(array_length(gotchas, 1), 0) < ${MAX_GOTCHAS_PER_ENTRY}
      `,
      [input.projectRootPath, input.unitPath, [taggedNote]],
    );
  } catch (error) {
    console.warn("[graph-entries] appendBusinessGraphEntryCorrection failed:", error);
  }
}
