import { promises as fs } from "node:fs";
import path from "node:path";
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

  return {
    id: row.id,
    projectRootPath: row.project_root_path,
    unitPath: row.unit_path,
    featureSummary: row.feature_summary,
    keyMechanisms: row.key_mechanisms ?? [],
    gotchas: row.gotchas ?? [],
    sourceFileHashes,
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
          (id, project_root_path, unit_path, feature_summary, key_mechanisms, gotchas, source_file_hashes, confidence, created_at, last_crawled_at)
        values ($1, $2, $3, $4, $5::text[], $6::text[], $7::jsonb, $8, $9, $9)
        on conflict (id) do update set
          feature_summary = excluded.feature_summary,
          key_mechanisms = excluded.key_mechanisms,
          gotchas = excluded.gotchas,
          source_file_hashes = excluded.source_file_hashes,
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
        Math.max(5, Math.min(100, Math.round(input.confidence))),
        now,
      ],
    );
  } catch (error) {
    console.warn("[graph-entries] upsertBusinessGraphEntry failed:", error);
  }
}
