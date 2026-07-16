import { stableId } from "@client/shared";
import { runSql } from "./postgres-client.js";

// Domain Glossary (2026-07-17, architecture review Tier 3): project_facts
// (facts.ts) accumulates one-off statements tied to specific evidence
// files, but every statement promoted from agentic evidence reads as
// boilerplate ("file X was actually opened by the researcher") rather than
// an actual business-meaning definition - the Researcher's own evidence.reason
// field was never designed to carry that. This is a separate, structured
// store of TERMS ("GoogleAccount", "active subscription", ...) each with
// ONE crisp, persistent business definition - built by a dedicated
// extraction call (packages/ai's extractDomainGlossaryTerms) over the
// research's actual final answer, not over evidence metadata.
export interface DomainGlossaryEntry {
  id: string;
  projectRootPath: string;
  term: string;
  definition: string;
  relatedFiles: string[];
  confidence: number;
  sourceRunId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface DomainGlossaryEntryRow {
  id: string;
  project_root_path: string;
  term: string;
  definition: string;
  related_files: string[];
  confidence: number;
  source_run_id: string | null;
  created_at: Date;
  updated_at: Date;
}

function mapRow(row: DomainGlossaryEntryRow): DomainGlossaryEntry {
  return {
    id: row.id,
    projectRootPath: row.project_root_path,
    term: row.term,
    definition: row.definition,
    relatedFiles: row.related_files ?? [],
    confidence: row.confidence,
    sourceRunId: row.source_run_id,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

/** Cross-path variant, same reasoning as queryFactsAcrossPaths - a project's glossary spans every physical repo it has. */
export async function queryGlossaryAcrossPaths(projectRootPaths: string[]): Promise<DomainGlossaryEntry[]> {
  if (projectRootPaths.length === 0) {
    return [];
  }

  try {
    const rows = await runSql<DomainGlossaryEntryRow>(
      `select * from domain_glossary_entries where project_root_path = any($1::text[]) order by confidence desc, updated_at desc limit 100`,
      [projectRootPaths],
    );

    return rows.map(mapRow);
  } catch (error) {
    console.warn("[glossary] queryGlossaryAcrossPaths failed, degrading to no glossary:", error);
    return [];
  }
}

/** Removes every glossary entry for one physical path - same deletion-cascade reasoning as deleteFactsForPath. */
export async function deleteGlossaryEntriesForPath(projectRootPath: string): Promise<void> {
  try {
    await runSql(`delete from domain_glossary_entries where project_root_path = $1`, [projectRootPath]);
  } catch (error) {
    console.warn("[glossary] deleteGlossaryEntriesForPath failed:", error);
  }
}

export interface UpsertGlossaryEntryInput {
  projectRootPath: string;
  term: string;
  definition: string;
  relatedFiles: string[];
  confidence: number;
  sourceRunId?: string;
}

/**
 * One row per (project, term) - unlike facts, re-discovering the same term
 * REPLACES the definition (keeping whichever attempt scored higher
 * confidence) rather than accumulating duplicate observations, since a
 * glossary entry is meant to read as a single current definition.
 * Fire-and-forget from pipeline-runner - never throws.
 */
export async function upsertGlossaryEntry(input: UpsertGlossaryEntryInput): Promise<void> {
  try {
    const normalizedTerm = input.term.trim();

    if (!normalizedTerm) {
      return;
    }

    const id = stableId(["domain-glossary", input.projectRootPath, normalizedTerm.toLowerCase()]);
    const now = new Date().toISOString();
    const confidence = Math.max(5, Math.min(100, Math.round(input.confidence)));

    await runSql(
      `
        insert into domain_glossary_entries
          (id, project_root_path, term, definition, related_files, confidence, source_run_id, created_at, updated_at)
        values ($1, $2, $3, $4, $5::text[], $6, $7, $8, $8)
        on conflict (project_root_path, lower(term)) do update set
          definition = case when excluded.confidence >= domain_glossary_entries.confidence then excluded.definition else domain_glossary_entries.definition end,
          related_files = array(select distinct unnest(domain_glossary_entries.related_files || excluded.related_files)),
          confidence = greatest(domain_glossary_entries.confidence, excluded.confidence),
          source_run_id = excluded.source_run_id,
          updated_at = excluded.updated_at
      `,
      [id, input.projectRootPath, normalizedTerm, input.definition.trim(), input.relatedFiles, confidence, input.sourceRunId ?? null, now],
    );
  } catch (error) {
    console.warn("[glossary] upsertGlossaryEntry failed:", error);
  }
}
