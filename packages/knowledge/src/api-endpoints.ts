import { promises as fs } from "node:fs";
import path from "node:path";
import { contentHash, stableId } from "@client/shared";
import { runSql, runWithTransaction } from "./postgres-client.js";

// API surface memory (2026-07-31, product-owner idea after finding magendamd's
// own committed openapi.json): Observer already reads route/controller/request
// files as part of describing a unit's business logic - this captures the
// SAME investigation's structural byproduct (which HTTP endpoints this unit
// exposes, what they accept/return) as its own queryable table, instead of
// only ever living as unstructured prose inside featureSummary. Works on ANY
// stack (Express routes, Django urls.py, FastAPI decorators, ...) because
// it's the LLM's own reading comprehension doing the extraction, not a
// per-framework static parser like a real OpenAPI generator would need -
// lower per-entry accuracy, but zero extra crawl cost and works everywhere,
// not only where someone already wired up a swagger-style generator.
export interface ApiEndpointEntry {
  id: string;
  projectRootPath: string;
  unitPath: string;
  method: string;
  path: string;
  controllerAction: string;
  requestFields: string;
  responseFields: string;
  sourceFileHashes: Record<string, string>;
  confidence: number;
  createdAt: string;
  lastCrawledAt: string;
  /** Recomputed at read time from current file content hashes - not stored, same idiom as BusinessGraphEntry.isStale. */
  isStale: boolean;
}

interface ApiEndpointRow {
  id: string;
  project_root_path: string;
  unit_path: string;
  method: string;
  path: string;
  controller_action: string;
  request_fields: string;
  response_fields: string;
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

async function mapRow(row: ApiEndpointRow): Promise<ApiEndpointEntry> {
  const sourceFileHashes = row.source_file_hashes ?? {};
  const paths = Object.keys(sourceFileHashes);
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
    method: row.method,
    path: row.path,
    controllerAction: row.controller_action,
    requestFields: row.request_fields,
    responseFields: row.response_fields,
    sourceFileHashes,
    confidence: row.confidence,
    createdAt: new Date(row.created_at).toISOString(),
    lastCrawledAt: new Date(row.last_crawled_at).toISOString(),
    isStale,
  };
}

/** Cross-path variant (multi-root project) - same convention as queryBusinessGraphEntriesAcrossPaths. */
export async function queryApiEndpointsAcrossPaths(projectRootPaths: string[]): Promise<ApiEndpointEntry[]> {
  if (projectRootPaths.length === 0) {
    return [];
  }

  try {
    const rows = await runSql<ApiEndpointRow>(
      `select * from api_endpoints where project_root_path = any($1::text[]) order by last_crawled_at desc`,
      [projectRootPaths],
    );

    return await Promise.all(rows.map((row) => mapRow(row)));
  } catch (error) {
    console.warn("[api-endpoints] queryApiEndpointsAcrossPaths failed, degrading to no hints:", error);
    return [];
  }
}

/** Removes every crawled endpoint row for one physical path (2026-07-31) - same convention as deleteBusinessGraphEntriesForPath. */
export async function deleteApiEndpointsForPath(projectRootPath: string): Promise<void> {
  try {
    await runSql(`delete from api_endpoints where project_root_path = $1`, [projectRootPath]);
  } catch (error) {
    console.warn("[api-endpoints] deleteApiEndpointsForPath failed:", error);
  }
}

export interface ReplaceApiEndpointsForUnitInput {
  projectRootPath: string;
  unitPath: string;
  endpoints: Array<{ method: string; path: string; controllerAction: string; requestFields: string; responseFields: string }>;
  sourceFileHashes: Record<string, string>;
  confidence: number;
}

/**
 * Fire-and-forget from the Observer crawl - never throws. One unit crawl
 * always produces the COMPLETE current set of routes that unit exposes, so
 * this replaces (delete + insert, in one transaction) rather than trying to
 * reconcile individual rows - a route removed from the code simply isn't in
 * the new set and its old row goes away, no separate "is this route still
 * there" check needed.
 */
export async function replaceApiEndpointsForUnit(input: ReplaceApiEndpointsForUnitInput): Promise<void> {
  try {
    const now = new Date().toISOString();
    const confidence = Math.max(5, Math.min(100, Math.round(input.confidence)));
    const hashesJson = JSON.stringify(input.sourceFileHashes);

    await runWithTransaction(async (runSqlInTx) => {
      await runSqlInTx(`delete from api_endpoints where project_root_path = $1 and unit_path = $2`, [input.projectRootPath, input.unitPath]);

      for (const endpoint of input.endpoints) {
        const id = stableId(["api-endpoint", input.projectRootPath, input.unitPath, endpoint.method, endpoint.path]);
        await runSqlInTx(
          `
            insert into api_endpoints
              (id, project_root_path, unit_path, method, path, controller_action, request_fields, response_fields, source_file_hashes, confidence, created_at, last_crawled_at)
            values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $11)
            on conflict (id) do update set
              controller_action = excluded.controller_action,
              request_fields = excluded.request_fields,
              response_fields = excluded.response_fields,
              source_file_hashes = excluded.source_file_hashes,
              confidence = excluded.confidence,
              last_crawled_at = excluded.last_crawled_at
          `,
          [id, input.projectRootPath, input.unitPath, endpoint.method, endpoint.path, endpoint.controllerAction, endpoint.requestFields, endpoint.responseFields, hashesJson, confidence, now],
        );
      }
    });
  } catch (error) {
    console.warn("[api-endpoints] replaceApiEndpointsForUnit failed:", error);
  }
}
