import { promises as fs } from "node:fs";
import path from "node:path";
import {
  contentHash,
  stableId,
  type FactSource,
  type FactStatus,
  type IndexResult,
  type ProjectFact,
  type RepositorySnapshot,
  type ResearchReport,
} from "@client/shared";
import { runSql } from "./postgres-client.js";

interface ProjectFactRow {
  id: string;
  project_root_path: string;
  category: string;
  statement: string;
  file_paths: string[];
  confidence: number;
  status: FactStatus;
  source: FactSource;
  content_hashes: Record<string, string>;
  created_at: Date;
  last_confirmed_at: Date;
  last_confirmed_head_commit: string | null;
  superseded_by_fact_id: string | null;
}

function mapFactRow(row: ProjectFactRow): ProjectFact {
  return {
    id: row.id,
    projectRootPath: row.project_root_path,
    category: row.category,
    statement: row.statement,
    filePaths: row.file_paths ?? [],
    confidence: row.confidence,
    status: row.status,
    source: row.source,
    contentHashes: row.content_hashes ?? {},
    createdAt: new Date(row.created_at).toISOString(),
    lastConfirmedAt: new Date(row.last_confirmed_at).toISOString(),
    ...(row.last_confirmed_head_commit ? { lastConfirmedHeadCommit: row.last_confirmed_head_commit } : {}),
    ...(row.superseded_by_fact_id ? { supersededByFactId: row.superseded_by_fact_id } : {}),
  };
}

/**
 * Читает накопленные факты проекта и пересчитывает staleness по content hash
 * текущего индекса — без отдельного background job, пересчёт происходит на
 * лету при каждом чтении. Переименованные файлы (git mv) мигрируются на новый
 * путь по данным `repository.changedFiles`, а не считаются потерянными.
 *
 * Никогда не бросает исключение: при ошибке Postgres research должен
 * деградировать до обычного broad-scan, а не падать целиком.
 */
export async function queryRelevantFacts(
  projectRootPath: string,
  currentIndex: IndexResult,
  repository?: RepositorySnapshot,
): Promise<ProjectFact[]> {
  try {
    const rows = await runSql<ProjectFactRow>(
      `select * from project_facts where project_root_path = $1 and status != 'deprecated' order by last_confirmed_at desc limit 100`,
      [projectRootPath],
    );

    const currentHashByPath = new Map(currentIndex.files.map((file) => [file.filePath, file.contentHash]));
    const renameTargetByOldPath = new Map(
      (repository?.changedFiles ?? [])
        .filter((entry) => entry.changeType === "renamed" && entry.previousPath)
        .map((entry) => [entry.previousPath as string, entry.path]),
    );

    return rows.map((row) => {
      const fact = mapFactRow(row);
      const migratedFilePaths = fact.filePaths.map((filePath) => renameTargetByOldPath.get(filePath) ?? filePath);
      const stillValid = migratedFilePaths.some(
        (filePath) => currentHashByPath.get(filePath) === fact.contentHashes[filePath],
      );

      return {
        ...fact,
        filePaths: migratedFilePaths,
        status: stillValid ? fact.status : ("potentially_stale" as FactStatus),
      };
    });
  } catch (error) {
    console.warn("[facts] queryRelevantFacts failed, degrading to no facts:", error);
    return [];
  }
}

/**
 * Cross-path variant (2026-07-16, multi-path unification) for the agentic
 * Researcher's "verify, then rely" seed hint - queries confirmed facts
 * across EVERY physical repo of a project at once, not just the one
 * `IndexResult` `queryRelevantFacts` is normally tied to. Staleness is
 * recomputed the same way business_graph_entries does (graph-entries.ts's
 * currentHashOf) - reads each fact's own small file set on demand, no full
 * index needed, cheap since a fact typically references 1-3 files. No
 * rename-tracking here (that needs a git diff per repo, more than this
 * lightweight hint warrants) - a renamed file's fact just goes stale, same
 * as any other content change.
 */
export async function queryFactsAcrossPaths(projectRootPaths: string[]): Promise<ProjectFact[]> {
  if (projectRootPaths.length === 0) {
    return [];
  }

  try {
    const rows = await runSql<ProjectFactRow>(
      `select * from project_facts where project_root_path = any($1::text[]) and status != 'deprecated' order by last_confirmed_at desc limit 100`,
      [projectRootPaths],
    );

    return await Promise.all(
      rows.map(async (row) => {
        const fact = mapFactRow(row);
        const stillValid = await isFactStillValid(row.project_root_path, fact);
        return { ...fact, status: stillValid ? fact.status : ("potentially_stale" as FactStatus) };
      }),
    );
  } catch (error) {
    console.warn("[facts] queryFactsAcrossPaths failed, degrading to no facts:", error);
    return [];
  }
}

async function isFactStillValid(projectRootPath: string, fact: ProjectFact): Promise<boolean> {
  for (const filePath of fact.filePaths) {
    try {
      const content = await fs.readFile(path.resolve(projectRootPath, filePath), "utf8");
      if (contentHash(content) === fact.contentHashes[filePath]) {
        return true;
      }
    } catch {
      // File missing/unreadable - not valid via this path, keep checking others.
    }
  }

  return false;
}

/**
 * Промоутит top-evidence текущего research'а (только origin === "baseline" —
 * грязный worktree не должен становиться durable фактом) в Fact Store.
 * Дедуп — по содержанию (projectRootPath+category+statement), не по составу
 * файлов: повторное обнаружение того же вывода обновляет существующую
 * запись (union filePaths/contentHashes), а не плодит дубликаты.
 *
 * Намеренно НЕ пытается детектировать семантическое противоречие между
 * разными фактами на одном файле — ранняя версия помечала любые два факта
 * с пересекающимися filePaths как superseded, что на практике убивало
 * совместимые, взаимно дополняющие факты об одном файле (см. живой тест:
 * два разных, оба верных вывода про AuthController.php гасили друг друга).
 * Временной дрейф ("этот факт больше не верен") обрабатывается content-hash
 * staleness-проверкой в queryRelevantFacts, а не supersede-эвристикой здесь.
 * `supersededByFactId` в схеме зарезервировано под будущий явный путь
 * (например user-confirmed коррекция), но promotion его не заполняет.
 *
 * Вызывается fire-and-forget из pipeline-runner — никогда не бросает
 * исключение и не должен блокировать ответ пользователю.
 */
/**
 * Removes every fact for one physical path (2026-07-16) - called when a
 * project or a single path within it is deleted, so the fact store does not
 * keep serving "verify, then rely" hints about a repo that no longer exists
 * (or, worse, silently reattaches to a different project that later reuses
 * the same filesystem path).
 */
/**
 * Promotes REUSABLE code-convention facts discovered during a Reviewer-
 * approved development task (2026-07-18, docs/architecture/011, §4.2
 * follow-up - packages/ai's extractCodePatternFacts is the extraction half,
 * this is the storage half). Deliberately a separate, leaner function from
 * promoteFactsFromResearch rather than a generic "any category" variant of
 * it: research facts carry evidence[].score and an origin/confidence model
 * tied to the Q&A critic's verdict, which does not exist here - the trust
 * signal for a development fact is simply "did an independent Reviewer
 * approve the diff this pattern was discovered while building" (checked by
 * the caller, develop-runner.ts, before this is ever invoked). Reuses the
 * SAME project_facts table and the SAME near-duplicate/belief-reconciliation
 * machinery as research facts - a pattern fact is not a different kind of
 * fact, just a different origin, and future Q&A research over this project
 * benefits from it exactly the same way a future development task does
 * (both read through queryFactsAcrossPaths/queryRelevantFacts).
 */
export async function promoteFactsFromDevelopment(
  projectRootPath: string,
  patterns: Array<{ statement: string; filePaths: string[] }>,
  headCommit: string,
  readFileContent: (filePath: string) => Promise<string | null>,
  checkConflict?: ConflictChecker,
): Promise<void> {
  try {
    const now = new Date().toISOString();

    for (const pattern of patterns) {
      const contentHashes: Record<string, string> = {};

      for (const filePath of pattern.filePaths) {
        const content = await readFileContent(filePath);

        if (content !== null) {
          contentHashes[filePath] = contentHash(content);
        }
      }

      // Every related file failed to read (deleted/moved since the run) -
      // nothing left to anchor staleness tracking to, skip rather than store
      // an unverifiable fact.
      if (Object.keys(contentHashes).length === 0) {
        continue;
      }

      const category = "pattern";
      const normalizedStatement = pattern.statement.trim().toLowerCase();
      const id = stableId(["fact", projectRootPath, category, normalizedStatement]);
      const verifiedFilePaths = Object.keys(contentHashes);

      let candidateConflictRows: ExistingFactRow[] = [];

      if (checkConflict) {
        try {
          candidateConflictRows = await runSql<ExistingFactRow>(
            `select id, statement from project_facts where project_root_path = $1 and status = 'fresh' and file_paths && $2::text[] and id != $3 limit 3`,
            [projectRootPath, verifiedFilePaths, id],
          );
        } catch (error) {
          console.warn("[facts] belief reconciliation lookup (development) failed, skipping:", error);
        }
      }

      await runSql(
        `
          insert into project_facts
            (id, project_root_path, category, statement, file_paths, confidence, status, source, content_hashes, created_at, last_confirmed_at, last_confirmed_head_commit)
          values ($1, $2, $3, $4, $5::text[], $6, 'fresh', 'execution', $7::jsonb, $8, $8, $9)
          on conflict (id) do update set
            file_paths = array(select distinct unnest(project_facts.file_paths || excluded.file_paths)),
            status = 'fresh',
            content_hashes = project_facts.content_hashes || excluded.content_hashes,
            last_confirmed_at = excluded.last_confirmed_at,
            last_confirmed_head_commit = excluded.last_confirmed_head_commit
        `,
        [
          id,
          projectRootPath,
          category,
          pattern.statement,
          verifiedFilePaths,
          // Fixed, moderate confidence - a pattern fact has no per-item
          // score like research evidence does; "approved by Reviewer" is
          // already the trust gate, this just keeps it below a
          // user-confirmed fact's ceiling.
          70,
          JSON.stringify(contentHashes),
          now,
          headCommit,
        ],
      );

      for (const existing of candidateConflictRows) {
        if (looksLikeNearDuplicate(existing.statement, pattern.statement)) {
          continue;
        }

        try {
          const isConflict = await checkConflict!(existing.statement, pattern.statement);

          if (isConflict) {
            await runSql(
              `update project_facts set status = 'contradicted', superseded_by_fact_id = $1 where id = $2`,
              [id, existing.id],
            );
          }
        } catch (error) {
          console.warn("[facts] belief reconciliation check (development) failed, skipping:", error);
        }
      }
    }
  } catch (error) {
    console.warn("[facts] promoteFactsFromDevelopment failed:", error);
  }
}

export async function deleteFactsForPath(projectRootPath: string): Promise<void> {
  try {
    await runSql(`delete from project_facts where project_root_path = $1`, [projectRootPath]);
  } catch (error) {
    console.warn("[facts] deleteFactsForPath failed:", error);
  }
}

interface ExistingFactRow {
  id: string;
  statement: string;
}

// Belief reconciliation (2026-07-17): injected rather than imported, so
// packages/knowledge stays free of any LLM-calling code - pipeline-runner
// supplies the real implementation (packages/ai's classifyFactConflict).
type ConflictChecker = (existingStatement: string, candidateStatement: string) => Promise<boolean>;

// A quick, free guard before spending an LLM call: if the two statements
// already share most of their significant words, they're almost certainly
// the same finding reworded, not a contradiction - not worth checking.
function looksLikeNearDuplicate(left: string, right: string): boolean {
  const wordsOf = (text: string) => new Set(text.toLowerCase().split(/\W+/).filter((word) => word.length >= 4));
  const leftWords = wordsOf(left);
  const rightWords = wordsOf(right);

  if (leftWords.size === 0 || rightWords.size === 0) {
    return false;
  }

  const shared = [...leftWords].filter((word) => rightWords.has(word)).length;
  return shared / Math.min(leftWords.size, rightWords.size) >= 0.7;
}

export async function promoteFactsFromResearch(
  projectRootPath: string,
  report: ResearchReport,
  repository: RepositorySnapshot,
  index: IndexResult,
  checkConflict?: ConflictChecker,
): Promise<void> {
  try {
    const currentHashByPath = new Map(index.files.map((file) => [file.filePath, file.contentHash]));
    const category = report.dominantModule || "general";
    const now = new Date().toISOString();

    // Architecture review finding (2026-07-16): this filter only ever
    // matched origin === "baseline", which the deterministic (legacy,
    // now rarely used) research path assigns - agentic team-mode evidence
    // is always origin === "structural" (packages/agentic-research's
    // adapter.ts), so the fact store had a silently one-way-broken write
    // path: every question answered through team-mode (the actual daily
    // usage) never contributed a single fact back, despite the whole
    // point of the fact store being "verify, then rely" knowledge that
    // compounds across questions. "baseline" was never really a trust
    // signal to begin with (it meant "from the committed baseline, not an
    // uncommitted overlay" - a git-dirtiness axis, unrelated to answer
    // quality). The real trust signal for agentic evidence is the
    // research's own confidence, which already encodes the critic's
    // verdict (adapter.ts's deriveConfidence: approved=85,
    // rejected-once-then-accepted=65, rejected-budget-exhausted=45) - only
    // promoting at >=65 means the critic genuinely approved the answer
    // this evidence backs, not just that the loop happened to touch a file.
    const isTrustworthyOrigin = (item: ResearchReport["evidence"][number]) =>
      item.origin === "baseline" || (item.origin === "structural" && report.confidence >= 65);

    const candidates = report.evidence
      .filter((item) => isTrustworthyOrigin(item) && item.filePath && currentHashByPath.has(item.filePath))
      .sort((left, right) => right.score - left.score)
      .slice(0, 3);

    for (const item of candidates) {
      const filePath = item.filePath as string;
      const contentHash = currentHashByPath.get(filePath) as string;
      const statement = `${item.label}: ${item.reason}`;
      const normalizedStatement = statement.trim().toLowerCase();
      const id = stableId(["fact", projectRootPath, category, normalizedStatement]);
      const contentHashesJson = JSON.stringify({ [filePath]: contentHash });

      // Existing facts to reconcile against are looked up BEFORE the insert
      // below (which the on-conflict clause could otherwise turn into a
      // reconfirmation of a fact identical to `id`, throwing off "is this
      // really a different existing fact" further down).
      let candidateConflictRows: ExistingFactRow[] = [];

      if (checkConflict) {
        try {
          candidateConflictRows = await runSql<ExistingFactRow>(
            `select id, statement from project_facts where project_root_path = $1 and status = 'fresh' and $2 = any(file_paths) and id != $3 limit 3`,
            [projectRootPath, filePath, id],
          );
        } catch (error) {
          console.warn("[facts] belief reconciliation lookup failed, skipping:", error);
        }
      }

      await runSql(
        `
          insert into project_facts
            (id, project_root_path, category, statement, file_paths, confidence, status, source, content_hashes, created_at, last_confirmed_at, last_confirmed_head_commit)
          values ($1, $2, $3, $4, array[$5]::text[], $6, 'fresh', 'research', $7::jsonb, $8, $8, $9)
          on conflict (id) do update set
            file_paths = array(select distinct unnest(project_facts.file_paths || excluded.file_paths)),
            confidence = greatest(project_facts.confidence, excluded.confidence),
            status = 'fresh',
            content_hashes = project_facts.content_hashes || excluded.content_hashes,
            last_confirmed_at = excluded.last_confirmed_at,
            last_confirmed_head_commit = excluded.last_confirmed_head_commit
        `,
        [
          id,
          projectRootPath,
          category,
          statement,
          filePath,
          // item.score — сумма эвристических бонусов, не нормализована в [0,100] —
          // клампим на всякий случай перед записью в integer-колонку.
          Math.max(5, Math.min(100, Math.round(item.score))),
          contentHashesJson,
          now,
          repository.headCommit,
        ],
      );

      // Run AFTER the insert above - superseded_by_fact_id references
      // project_facts(id), so the new fact's row must already exist before
      // an existing row can point its FK at it.
      for (const existing of candidateConflictRows) {
        if (looksLikeNearDuplicate(existing.statement, statement)) {
          continue;
        }

        try {
          const isConflict = await checkConflict!(existing.statement, statement);

          if (isConflict) {
            await runSql(
              `update project_facts set status = 'contradicted', superseded_by_fact_id = $1 where id = $2`,
              [id, existing.id],
            );
          }
        } catch (error) {
          console.warn("[facts] belief reconciliation check failed, skipping:", error);
        }
      }
    }
  } catch (error) {
    console.warn("[facts] promoteFactsFromResearch failed:", error);
  }
}
