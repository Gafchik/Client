import { stableId, type PathRole } from "@client/shared";
import { runSql } from "./postgres-client.js";

interface CodeEmbeddingRow {
  file_path: string;
  content_hash: string;
  embedding: number[];
}

export interface CodeEmbeddingMatch {
  filePath: string;
  score: number;
}

/** Cross-path match (2026-07-16, multi-path unification) - additionally identifies WHICH physical repo the file belongs to, so the caller can build a label-prefixed virtual path (see packages/agentic-research/tools.ts's WorkspaceRoot convention). */
export interface CrossPathCodeEmbeddingMatch extends CodeEmbeddingMatch {
  projectRootPath: string;
  role: PathRole;
}

function cosineSimilarity(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < length; i += 1) {
    const valueA = a[i] ?? 0;
    const valueB = b[i] ?? 0;
    dot += valueA * valueB;
    normA += valueA * valueA;
    normB += valueB * valueB;
  }

  if (normA === 0 || normB === 0) {
    return 0;
  }

  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
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
    await runSql(
      `
        insert into code_embeddings (id, project_root_path, file_path, content_hash, embedding, role, updated_at)
        values ($1, $2, $3, $4, $5::jsonb, $6, $7)
        on conflict (id) do update set
          content_hash = excluded.content_hash,
          embedding = excluded.embedding,
          role = excluded.role,
          updated_at = excluded.updated_at
      `,
      [id, input.projectRootPath, input.filePath, input.contentHash, JSON.stringify(input.embedding), input.role, new Date().toISOString()],
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
 * Brute-force cosine similarity over every stored vector for one project.
 * Fine at this scale (hundreds to a few thousand files per project, not the
 * terabytes ElasticSearch/OpenSearch would be justified for - see
 * project-state.md's docs-research entry on why that was rejected).
 */
export async function findSemanticMatches(
  projectRootPath: string,
  queryEmbedding: number[],
  topK = 8,
): Promise<CodeEmbeddingMatch[]> {
  try {
    const rows = await runSql<CodeEmbeddingRow>(
      `select file_path, content_hash, embedding from code_embeddings where project_root_path = $1`,
      [projectRootPath],
    );

    return rows
      .map((row) => ({ filePath: row.file_path, score: cosineSimilarity(queryEmbedding, row.embedding) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
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
 * ambiguous once two repos share directory names like "src".
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
    const rows = await runSql<CodeEmbeddingRow & { project_root_path: string; role: PathRole }>(
      `select project_root_path, file_path, content_hash, embedding, role from code_embeddings where project_root_path = any($1::text[])`,
      [projectRootPaths],
    );

    return rows
      .map((row) => ({
        filePath: row.file_path,
        score: cosineSimilarity(queryEmbedding, row.embedding),
        projectRootPath: row.project_root_path,
        role: row.role,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  } catch (error) {
    console.warn("[code-embeddings] findSemanticMatchesAcrossPaths failed, degrading to no matches:", error);
    return [];
  }
}
