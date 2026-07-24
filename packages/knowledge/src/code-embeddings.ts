import { stableId, type PathRole } from "@client/shared";
import { runSql } from "./postgres-client.js";

export interface CodeEmbeddingMatch {
  filePath: string;
  score: number;
}

/** Cross-path match (2026-07-16, multi-path unification) - additionally identifies WHICH physical repo the file belongs to, so the caller can build a label-prefixed virtual path (see packages/agentic-research/tools.ts's WorkspaceRoot convention). */
export interface CrossPathCodeEmbeddingMatch extends CodeEmbeddingMatch {
  projectRootPath: string;
  role: PathRole;
}

export interface CodeEmbeddingIndexState {
  contentHash: string;
  updatedAt: string;
}

/**
 * filePath -> {contentHash, updatedAt} currently stored. The indexer uses
 * updatedAt as a cheap pre-filter (compare against the file's mtime via
 * fs.stat, no read needed) before falling back to a real content-hash check -
 * without it, every tick would re-read every file's full content just to see
 * nothing changed, which does not scale past a handful of files.
 * Degrades to empty (full reindex) if Postgres is briefly unavailable.
 */
export async function getCodeEmbeddingContentHashes(projectRootPath: string): Promise<Record<string, CodeEmbeddingIndexState>> {
  try {
    const rows = await runSql<{ file_path: string; content_hash: string; updated_at: Date }>(
      `select file_path, content_hash, updated_at from code_embeddings where project_root_path = $1`,
      [projectRootPath],
    );
    return Object.fromEntries(
      rows.map((row) => [row.file_path, { contentHash: row.content_hash, updatedAt: new Date(row.updated_at).toISOString() }]),
    );
  } catch (error) {
    console.warn("[code-embeddings] getCodeEmbeddingContentHashes failed, indexer will treat all files as new:", error);
    return {};
  }
}

export interface UpsertCodeEmbeddingInput {
  projectRootPath: string;
  filePath: string;
  contentHash: string;
  embedding: number[];
  /** Auto-detected path role (2026-07-16, multi-path unification) - stored at embed time so cross-path queries don't need a join against project_paths. */
  role: PathRole;
}

export async function upsertCodeEmbedding(input: UpsertCodeEmbeddingInput): Promise<void> {
  try {
    const id = stableId(["code-embedding", input.projectRootPath, input.filePath]);
    // embedding_vec (2026-07-23, pgvector migration): written alongside the
    // legacy jsonb column, not instead of it - embedding stays the durable
    // source of truth, embedding_vec is what findSemanticMatches* actually
    // reads now. Written from the same JSON text form the jsonb column uses,
    // so both columns are always in sync from one input.
    const embeddingJson = JSON.stringify(input.embedding);
    // 2026-07-24: reusing $5 for both ::jsonb and ::vector casts fails with
    // "cannot cast type jsonb to vector" (pg 42846) - node-postgres binds a
    // parameter's type from its first cast, so the second cast tries to
    // convert the already-jsonb-typed value straight to vector, which
    // Postgres does not support. A literal-string repro of the same SQL
    // works fine (no bound-parameter typing involved), which is why this
    // silently passed a raw-SQL sanity check. Passing the JSON text as two
    // separate parameters avoids the conflict entirely.
    await runSql(
      `
        insert into code_embeddings (id, project_root_path, file_path, content_hash, embedding, embedding_vec, role, updated_at)
        values ($1, $2, $3, $4, $5::jsonb, $8::vector, $6, $7)
        on conflict (id) do update set
          content_hash = excluded.content_hash,
          embedding = excluded.embedding,
          embedding_vec = excluded.embedding_vec,
          role = excluded.role,
          updated_at = excluded.updated_at
      `,
      [id, input.projectRootPath, input.filePath, input.contentHash, embeddingJson, input.role, new Date().toISOString(), embeddingJson],
    );
  } catch (error) {
    console.warn("[code-embeddings] upsertCodeEmbedding failed:", error);
  }
}

/** Removes rows for files the indexer no longer finds on disk (renamed/deleted since the last pass). */
export async function pruneCodeEmbeddings(projectRootPath: string, keepFilePaths: string[]): Promise<void> {
  try {
    await runSql(
      `delete from code_embeddings where project_root_path = $1 and not (file_path = any($2::text[]))`,
      [projectRootPath, keepFilePaths],
    );
  } catch (error) {
    console.warn("[code-embeddings] pruneCodeEmbeddings failed:", error);
  }
}

/**
 * Ranking pushed down to Postgres via pgvector's native `<=>` (cosine
 * distance) operator + ORDER BY/LIMIT (2026-07-23 - the previous approach
 * fetched EVERY row for the project over the wire and ranked in JS; confirmed
 * live on a real project with 7995 rows: 5.5s of pure data transfer per call,
 * on every single semantic-search/seed lookup. No index on embedding_vec -
 * qwen3-embedding-8b's 4096 dims exceeds pgvector's 2000-dim ivfflat/hnsw
 * limit - but a native sequential scan over a few thousand rows in C is still
 * drastically faster than transferring+parsing the same rows into Node.
 * `1 - distance` converts cosine DISTANCE back to the similarity SCORE the
 * rest of this codebase already expects (higher = more similar).
 */
export async function findSemanticMatches(
  projectRootPath: string,
  queryEmbedding: number[],
  topK = 8,
): Promise<CodeEmbeddingMatch[]> {
  try {
    const rows = await runSql<{ file_path: string; score: number }>(
      `
        select file_path, 1 - (embedding_vec <=> $2::vector) as score
        from code_embeddings
        where project_root_path = $1 and embedding_vec is not null
        order by embedding_vec <=> $2::vector
        limit $3
      `,
      [projectRootPath, JSON.stringify(queryEmbedding), topK],
    );

    return rows.map((row) => ({ filePath: row.file_path, score: row.score }));
  } catch (error) {
    console.warn("[code-embeddings] findSemanticMatches failed, degrading to no matches:", error);
    return [];
  }
}

/**
 * Cross-path variant (2026-07-16, multi-path unification) - ranks matches
 * across EVERY physical repo of a project at once (a single semantic query
 * can and should surface both a frontend page and the backend endpoint it
 * calls). Returns which repo + role each match belongs to so the caller can
 * build a label-prefixed virtual path (packages/agentic-research's
 * WorkspaceRoot convention) instead of a bare relative path that would be
 * ambiguous once two repos share directory names like "src". Same pgvector
 * pushdown as findSemanticMatches - see its comment for why.
 */
export async function findSemanticMatchesAcrossPaths(
  projectRootPaths: string[],
  queryEmbedding: number[],
  topK = 8,
): Promise<CrossPathCodeEmbeddingMatch[]> {
  if (projectRootPaths.length === 0) {
    return [];
  }

  try {
    const rows = await runSql<{ project_root_path: string; file_path: string; role: PathRole; score: number }>(
      `
        select project_root_path, file_path, role, 1 - (embedding_vec <=> $2::vector) as score
        from code_embeddings
        where project_root_path = any($1::text[]) and embedding_vec is not null
        order by embedding_vec <=> $2::vector
        limit $3
      `,
      [projectRootPaths, JSON.stringify(queryEmbedding), topK],
    );

    return rows.map((row) => ({
      filePath: row.file_path,
      score: row.score,
      projectRootPath: row.project_root_path,
      role: row.role,
    }));
  } catch (error) {
    console.warn("[code-embeddings] findSemanticMatchesAcrossPaths failed, degrading to no matches:", error);
    return [];
  }
}
