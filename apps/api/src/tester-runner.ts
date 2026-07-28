import { runTesterTask, type TesterRunResult, type WorkspaceRoot } from "@client/agentic-research";
import { queryFactsAcrossPaths, queryGlossaryAcrossPaths } from "@client/knowledge";
import { normalizePath, stableId, type ProjectPathRecord } from "@client/shared";
import { buildDbQueryTool, checkDockerComposeHealth } from "./db-query-tool.js";
import { buildHttpRequestTool } from "./dev-server-tool.js";
import { buildGlossaryHint, buildKnownFactsHint, buildObserverHintSuffix, buildSemanticSearchTool } from "./pipeline-runner.js";

/**
 * Tester pipeline orchestration (2026-07-27, explicit product-owner
 * request - see docs/architecture/011-developer-pipeline.md's Tester
 * section). Deliberately thin, same stance develop-runner.ts's own
 * docstring already states: all reasoning lives in
 * packages/agentic-research's tester-loop, this file only does memory
 * injection + tool resolution + telemetry-shaped status tracking.
 *
 * Structurally simpler than develop-runner.ts on purpose: Tester never
 * writes anything, so there is no worktree lifecycle, no diff collection,
 * no review rounds, no chain-advance - `originalRoots` IS what the loop
 * runs against, not a mapped worktree copy.
 *
 * v1 scope (explicit product-owner decision, 2026-07-27): API-level
 * testing only. `teams.tester_model` (added 2026-07-28, same
 * developer_model/reviewer_model precedent) falls back to reviewerModel
 * when unset (team-store.ts's mapTeamRow) - Tester and Reviewer are both
 * "judge real behavior against evidence" roles, closer in required skill
 * than Developer. app.ts's /api/test/run also accepts a per-request
 * override for casting several models against the same task without
 * touching the team's saved config.
 */

export interface TesterRunStatusRecord {
  runId: string;
  conversationId: string;
  status: "running" | "completed" | "failed";
  task: string;
  projectPath: string;
  testerModel: string;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  progress?: { turn: number; phase: string };
  result?: TesterRunResult;
  errorMessage?: string;
}

export interface StartTesterRunInput {
  task: string;
  projectPath: string;
  projectPaths?: ProjectPathRecord[];
  providerBaseUrl: string;
  providerApiKey: string;
  testerModel: string;
  conversationId?: string;
}

const MAX_TRACKED_RUNS = 100;
const testerRunStatuses = new Map<string, TesterRunStatusRecord>();

function pruneTrackedRuns(): void {
  if (testerRunStatuses.size < MAX_TRACKED_RUNS) {
    return;
  }

  const oldestFirst = [...testerRunStatuses.values()].sort((left, right) => left.startedAt.localeCompare(right.startedAt));

  for (const record of oldestFirst.slice(0, testerRunStatuses.size - MAX_TRACKED_RUNS + 1)) {
    testerRunStatuses.delete(record.runId);
  }
}

export function getTesterRunStatus(runId: string): TesterRunStatusRecord | null {
  return testerRunStatuses.get(runId) ?? null;
}

export function findLatestTesterRunForConversation(conversationId: string): TesterRunStatusRecord | null {
  let latest: TesterRunStatusRecord | null = null;

  for (const record of testerRunStatuses.values()) {
    if (record.conversationId === conversationId && (!latest || record.startedAt > latest.startedAt)) {
      latest = record;
    }
  }

  return latest;
}

export function startTesterRun(input: StartTesterRunInput): TesterRunStatusRecord {
  const startedAt = new Date().toISOString();
  const runId = stableId(["tester-run", input.projectPath, input.task, Date.now()]);
  const record: TesterRunStatusRecord = {
    runId,
    conversationId: input.conversationId?.trim() || runId,
    status: "running",
    task: input.task,
    projectPath: input.projectPath,
    testerModel: input.testerModel,
    startedAt,
    updatedAt: startedAt,
  };

  pruneTrackedRuns();
  testerRunStatuses.set(runId, record);

  void executeTesterRun(record, input)
    .catch((error) => {
      record.status = "failed";
      record.errorMessage = error instanceof Error ? error.message : String(error);
    })
    .finally(() => {
      record.finishedAt = new Date().toISOString();
      record.updatedAt = record.finishedAt;
    });

  return record;
}

async function executeTesterRun(record: TesterRunStatusRecord, input: StartTesterRunInput): Promise<void> {
  const originalRoots: WorkspaceRoot[] = input.projectPaths?.length
    ? input.projectPaths.map((pathRecord) => ({
        label: pathRecord.name,
        absolutePath: normalizePath(pathRecord.rootPath),
        role: pathRecord.role,
      }))
    : [{ label: "root", absolutePath: normalizePath(input.projectPath), role: "unknown" }];

  // Memory injection - IDENTICAL channels/queries develop-runner.ts already
  // uses for Developer/Reviewer, run against the same ORIGINAL project
  // paths (facts/glossary/observer entries are keyed by them). Best-effort:
  // Postgres being down degrades to a memory-less but still-correct run.
  let knownFactsHint = "";
  let observerHint = "";

  try {
    const originalPaths = originalRoots.map((root) => root.absolutePath);
    const [facts, glossary, environmentHealthNotes] = await Promise.all([
      queryFactsAcrossPaths(originalPaths),
      queryGlossaryAcrossPaths(originalPaths),
      // Read-only "are this project's own docker services actually up"
      // check (2026-07-28) - same rationale as develop-runner.ts: know
      // upfront rather than have the Tester burn turns on db_query/
      // http_request calls that fail for a reason unrelated to the task.
      Promise.all(originalPaths.map((rootPath) => checkDockerComposeHealth(rootPath))),
    ]);
    knownFactsHint = [buildKnownFactsHint(originalRoots, facts), buildGlossaryHint(glossary), ...environmentHealthNotes.filter((note): note is string => Boolean(note))].filter(Boolean).join("\n\n");
  } catch {
    // no memory, still a valid run
  }

  try {
    observerHint = (await buildObserverHintSuffix(originalRoots, input.task)).text;
  } catch {
    // same
  }

  const semanticSearchTool = buildSemanticSearchTool(originalRoots, input.providerBaseUrl, input.providerApiKey);
  // Read-only DB/HTTP inspection - resolved against the ORIGINAL project
  // roots (never a worktree - there is none for Tester), same "find this
  // project's own running thing" convention db-query-tool.ts established.
  const dbQueryTool = await buildDbQueryTool(originalRoots.map((root) => root.absolutePath)).catch(() => null);
  const httpRequestTool = await buildHttpRequestTool(originalRoots.map((root) => root.absolutePath)).catch(() => null);

  const result = await runTesterTask({
    task: input.task,
    projectRoots: originalRoots,
    testerModel: input.testerModel,
    providerBaseUrl: input.providerBaseUrl,
    providerApiKey: input.providerApiKey,
    ...(knownFactsHint ? { knownFactsHint } : {}),
    ...(observerHint ? { observerHint } : {}),
    semanticSearch: semanticSearchTool,
    ...(dbQueryTool ? { dbQuery: dbQueryTool } : {}),
    ...(httpRequestTool ? { httpRequest: httpRequestTool } : {}),
    onProgress: (progressInfo) => {
      record.progress = progressInfo;
      record.updatedAt = new Date().toISOString();
    },
  });

  record.result = result;
  record.status = result.stopped === "error" ? "failed" : "completed";

  if (result.error) {
    record.errorMessage = result.error;
  }
}
