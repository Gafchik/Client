import { stableId } from "@client/shared";
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
}

export async function upsertCodeEmbedding(input: UpsertCodeEmbeddingInput): Promise<void> {
  try {
    const id = stableId(["code-embedding", input.projectRootPath, input.filePath]);
    await runSql(
      `
        insert into code_embeddings (id, project_root_path, file_path, content_hash, embedding, updated_at)
        values ($1, $2, $3, $4, $5::jsonb, $6)
        on conflict (id) do update set
          content_hash = excluded.content_hash,
          embedding = excluded.embedding,
          updated_at = excluded.updated_at
      `,
      [id, input.projectRootPath, input.filePath, input.contentHash, JSON.stringify(input.embedding), new Date().toISOString()],
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
