import { callModel, type ChatMessage, type ToolCall, type ToolDefinition } from "./provider.js";
import {
  dirnameOf,
  grepContent,
  listDir,
  normalizeDirKey,
  readFileRaw,
  formatReadFileSlice,
  type WorkspaceRoot,
} from "./tools.js";

// Tester role (2026-07-27, explicit product-owner request): a QA-shaped
// agentic role, distinct from both Developer (writes code, isolated
// worktree) and Reviewer (diff-scoped, judges a change already made).
// Tester verifies REAL, RUNNING behavior against the actual project - no
// worktree (it never writes anything, so none of Developer's isolation
// concerns apply), full original task/ticket text (never diff-scoped the
// way Reviewer is), and the SAME business-context memory channels
// (knownFactsHint/observerHint) Developer/Reviewer already get. Modeled
// structurally on callReviewer's bounded tool-calling verify-loop
// (develop-loop.ts) rather than Developer's explore-then-write loop, since
// Tester's shape is "gather evidence via tools, then give a final report,"
// not "explore, then mutate."
//
// v1 scope, explicit product-owner decision (2026-07-27): API-level
// testing only (http_request) - browser/frontend testing (browser_*
// tools, Playwright) is deliberately deferred to a later pass, NOT built
// now. TesterRunOptions.browserTools exists as a typed seam so that later
// work slots in without restructuring this loop or its tool-dispatch
// switch - see the commented-out union members below and
// docs/architecture/011-developer-pipeline.md's Tester section for the
// full phased plan.
//
// Also explicit (2026-07-27): no run_command. Developer's run_command is
// safe because it executes inside a disposable git worktree; Reviewer's
// verify_in_transaction is safe because it wraps the shell in a real DB
// transaction that always rolls back. Tester has neither safety net - it
// runs directly against the real project, never a worktree - so offering
// arbitrary shell here would be a strictly bigger risk than the bounded
// http_request/db_query tools it does get. Deferred, not silently built.
export type TesterTool =
  | "list_dir"
  | "grep_content"
  | "read_file"
  | "semantic_search"
  | "find_references"
  | "db_query"
  | "http_request"
  | "test_plan"
  | "note"
  | "ask_user"
  | "task_complete";

export interface TesterHttpRequestInput {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface TesterHttpResult {
  status: number;
  headers: Record<string, string>;
  body: string;
  durationMs: number;
}

export interface ParsedTesterAction {
  tool: TesterTool;
  arg: string;
  offset?: number | undefined;
  formatError?: string;
}

export interface TesterRunOptions {
  /** FULL original ticket/bug-report text, in the user's own words - never diff-scoped like Reviewer's task. */
  task: string;
  /** REAL project roots - NEVER a worktree. Tester writes nothing, so none of Developer's git-isolation is needed. */
  projectRoots: WorkspaceRoot[];
  testerModel: string;
  providerBaseUrl: string;
  providerApiKey: string;
  maxTurns?: number;
  shouldAbort?: () => boolean;
  /** Same memory-injection channels Developer/Reviewer already use. */
  knownFactsHint?: string;
  observerHint?: string;
  semanticSearch?: (query: string) => Promise<string>;
  findReferences?: (symbolOrFileName: string) => Promise<string>;
  /** Read-only SQL - reuses apps/api/src/db-query-tool.ts's buildDbQueryTool as-is, same tool the Developer/Reviewer already have. */
  dbQuery?: (query: string) => Promise<string>;
  /**
   * Real HTTP call against THIS project's own resolved dev-server base URL
   * (apps/api/src/dev-server-tool.ts) - undefined when no dev server could
   * be resolved/reached for this project, same "honest degradation"
   * convention dbQuery/findReferences already use. Code-level safety gate
   * (isSafeTestTargetHost) lives in the resolver, not here - this closure
   * is only ever constructed already pointed at a safe target.
   */
  httpRequest?: (input: TesterHttpRequestInput) => Promise<TesterHttpResult>;
  onProgress?: (info: { turn: number; phase: "testing" }) => void;
}

export interface TesterRunResult {
  /** Russian, "Тестер — сделал X, получил Y" - the task_complete argument verbatim, meant to read as the first half of a Tester/Developer dialogue. */
  report: string | null;
  clarificationQuestion: string | null;
  requestLog: Array<{ turn: number; request: TesterHttpRequestInput; result: TesterHttpResult }>;
  actionsLog: string[];
  turnsUsed: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  stopped: "task_complete" | "needs-clarification" | "max_turns" | "error" | "aborted";
  error?: string;
  // Every non-GET call this run made, successful or not (2026-07-28,
  // explicit product-owner request after twice manually discovering left-
  // over mutated rows this session - kimi/glm each changed real records via
  // update-status and hit their turn/token ceiling before reverting).
  // Deliberately NOT an attempted auto-revert: Tester is generic across
  // whatever REST API a project happens to have, so there is no safe,
  // non-project-specific way to know what a given endpoint's "previous
  // value" even means (see the no-hardcoding convention this codebase
  // already follows for db-query-tool.ts/dev-server-tool.ts). What IS
  // generic and deterministic is surfacing every mutating call plainly, so
  // a human never has to re-derive this by hand from raw requestLog again.
  mutatingRequests: Array<{ turn: number; method: string; path: string; body?: string; status: number }>;
}

// Live-evidence-tuned constants live in develop-loop.ts because Developer
// has years of live runs behind those numbers; Tester has none yet. These
// are deliberately conservative starting points, not a claim of having
// been tuned - see docs/architecture/011-developer-pipeline.md's Tester
// section, "open question 3": revisit once a first real benchmark exists,
// the same way every existing ceiling in this codebase was set from live
// runs, never guessed upfront and left alone.
//
// TESTER_TOKEN_SAFETY_LIMIT raised 900K -> 1.5M (2026-07-27, first live
// smoke test): the initial guess cut a real investigation off at turn 39
// with zero report - the model had already found a genuine bug (same
// "wrong credentials" request 500s with one payload shape, 422 with
// another) but spent many turns iterating request/header variations
// before the budget ran out, never reaching task_complete. Matches
// Developer's own DEVELOP_TOKEN_SAFETY_LIMIT order of magnitude rather
// than guessing a smaller number a second time.
//
// TESTER_DEFAULT_MAX_TURNS raised 40 -> 70 (2026-07-27, same live smoke
// test, second attempt): with the token limit no longer binding, the SAME
// run instead hit the turn cap at 40 - actionsLog showed a real,
// legitimate investigation (traced Fortify/Sanctum/CSRF config, the
// exception handler, tried several CSRF-token/header combinations) that
// simply never stopped to report. This mirrors the exact "curious junior
// won't stop digging" pattern already seen and tuned for on the Developer
// side this session - same fix direction (more room + an explicit
// stop-and-report instruction, see buildTesterSystemPrompt's "How to
// work" step 5 below), not yet a proactive forced bounce like
// Developer's EXPLORATION_BUDGET_BOUNCE_RATIO - add one if a THIRD run
// still doesn't converge.
//
// Raised again 70 -> 110 (2026-07-28, Document Due model-casting run):
// glm-4.7 and gpt-5 both hit 70 mid-investigation - both had already
// reached the actual state-changing endpoint (update-status) and made
// real, verified requests, just too late in the run to also verify
// cleanup and write a report. kimi-k2.7-code stopped even earlier (46)
// having mutated real data and never reverting it (caught and fixed by
// hand afterwards) - a sign that "running out of room" cuts runs off
// mid-mutation, which is worse than cutting them off mid-read. A third
// ceiling bump if this still isn't enough should come with a proactive
// bounce (see comment above), not another blind increase.
// Raised again 110 -> 180, tokens 1.5M -> 3M (2026-07-28, explicit product-
// owner decision, "чисто ради прикола"): real cost check first, not a blind
// bump - Tester runs a single model (deepseek-v4-pro, 0.7x) with no
// escalation, and the account's daily allowance is 51M tokens/day. A
// full-ceiling run at the OLD 1.5M limit was already ~1.05M billed tokens
// (0.7x), roughly 2% of the daily allowance - doubling the ceiling still
// leaves single-task cost in the low single-digit percent range. Turn
// ceiling raised proportionally, matching develop-loop.ts's new
// DEFAULT_DEVELOP_CEILING_TURNS - a token-only raise just moves the
// bottleneck to turns instead of removing it, per the exact "ran out of
// room mid-mutation" failure class this file's own history above documents.
const TESTER_DEFAULT_MAX_TURNS = 180;
const TESTER_TOKEN_SAFETY_LIMIT = 3_000_000;

// TESTER_EXPLORATION_BUDGET_BOUNCE_RATIO (2026-07-28, added the moment the
// 70->110 bump above was confirmed NOT to fix anything on its own): with the
// extra room, kimi-k2.7-code/glm-4.7/gpt-5 all used most or all of the new
// 110-turn budget and STILL never called task_complete - glm spent 91 turns
// mostly re-reading code (37 read_file calls), gpt-5 60 turns split between
// db_query/read_file with only 9 real http_request calls. More turns just
// gave the same "curious junior won't stop digging" pattern more room to
// run in, exactly as develop-loop.ts's own EXPLORATION_BUDGET_BOUNCE_RATIO
// comment predicted for its role. Mirrors that same fix direction here:
// once a run has burned through most of its budget, forcibly cut off every
// evidence-gathering tool and leave only note/ask_user/task_complete, so
// the model MUST synthesize a report from what it already has instead of
// continuing to gather more.
const TESTER_EXPLORATION_BUDGET_BOUNCE_RATIO = 0.6;
const MAX_OBSERVATION_CHARS = 20_000;
const TESTER_READ_FILE_CHARS = 24_000;
// History compaction (2026-07-28): the testPlan/durableNotes message slots
// below were already built to "survive compaction" per their own comments,
// but nothing ever actually compacted anything - every http_request/db_query/
// read_file observation (up to MAX_OBSERVATION_CHARS=20_000 each) stayed in
// `messages` forever and got resent on every subsequent call, same unbounded-
// growth shape already found and fixed in the Researcher loop (loop.ts) and
// the Developer loop (develop-loop.ts's HISTORY_COMPACT_TRIGGER_MESSAGES).
// This loop's own ceiling history (900K->1.5M tokens, 40->70->110 turns, see
// comments above) is the same "raise the ceiling" pattern that turned out to
// be treating the symptom - reusing develop-loop.ts's already-tuned values
// rather than re-guessing new ones.
const TESTER_HISTORY_COMPACT_TRIGGER_MESSAGES = 24;
const TESTER_HISTORY_KEEP_RECENT_MESSAGES = 24;

export const TESTER_SYSTEM_PROMPT_HEADER = [
  "You are a QA engineer verifying REAL, RUNNING behavior of a project - not a code reviewer reading a diff, not a developer guessing what code would do. You were given a task or bug report; your job is to actually exercise the system (real HTTP calls, real DB reads) and report what ACTUALLY happens, not what the ticket/code suggests should happen.",
  "Prefer making the real call over predicting what it would return - if you find yourself reasoning about what an endpoint 'should' return instead of calling it, call it instead.",
  "You have NO ability to change code - you are read-only against the real project (not a throwaway copy). Do not suggest edits inline; your job ends at a clear, evidence-backed report of what you observed.",
  "State every finding as: what you did (exact request/query), what you observed (exact response/result), and what was expected per the task - one item at a time, numbered. A finding with no concrete request/response pair behind it is not a finding.",
].join("\n");

function buildTesterSystemPrompt(hasHttpRequest: boolean, hasDbQuery: boolean, hasSemanticSearch: boolean, hasFindReferences: boolean): string {
  return [
    TESTER_SYSTEM_PROMPT_HEADER,
    "",
    "Tools:",
    "test_plan - call this ONCE, FIRST, before any exploration or testing: a numbered list of the concrete scenarios you will check for this task. task_complete is rejected until this exists, and your final report should address every item on it.",
    "list_dir - list a directory's contents.",
    "grep_content - search file contents for a literal string or regex.",
    "read_file - read a file's contents (use to correlate a UI/API behavior with the code that produces it - e.g. which endpoint a frontend action calls, or what a business rule actually checks).",
    ...(hasSemanticSearch ? ["semantic_search - find files by MEANING rather than literal words."] : []),
    ...(hasFindReferences ? ["find_references - real structural callers/dependents of a class or function, from the project's persisted code graph."] : []),
    ...(hasDbQuery ? ["db_query - a single read-only SELECT/WITH/EXPLAIN/SHOW against the project's real database - use to confirm what actually got persisted, not just what an API response claims."] : []),
    ...(hasHttpRequest
      ? [
          "http_request - make a REAL HTTP call against this project's own running dev server (method, path, optional headers, body) and see the actual status/headers/body. This is your primary tool - use it to reproduce the exact scenario the task describes, not just read code and guess. For POST/PUT/PATCH calls that need a payload (login, create, update), ALWAYS fill in `body` with the full JSON string - an empty body on a call that needed one will fail validation and look like a bug in the endpoint when the real mistake is your own missing body.",
        ]
      : []),
    "note - save a short, durable fact you want to keep for the rest of this run (survives context compaction) - e.g. an endpoint's real shape, a business rule you confirmed by reading code.",
    "ask_user - a clarifying question IN RUSSIAN - only when the task is genuinely ambiguous about WHAT to test or WHERE (which environment, which account/role) in a way that changes your approach.",
    "task_complete - call exactly once, when you have a clear, evidence-backed report. The summary (IN RUSSIAN) must read as a QA report: what you tried, what you observed (exact requests/responses), whether it matches the task's expectation, and - only if genuinely present - what you could NOT verify and why (e.g. no dev server resolved for a scope this task needed).",
    "",
    "How to work:",
    ...[
      "Read the task like a real bug report or acceptance-test script, then call test_plan ONCE with a numbered list of the concrete, checkable scenarios you will verify (a specific request, a specific role/account, a specific expected outcome per item) - before any exploration or testing. This is your own checklist, not a formality: task_complete will be rejected if you never wrote one, and your final report should address every item on it, either with a result or an explicit reason you could not check it.",
      ...(hasDbQuery
        ? [
            "If the task involves an account/role/tenant scope (a specific user, clinic, org, permission level) - do ONE cheap db_query triage pass FIRST: look up that account's own scope/tenant id and compare it to where the relevant data actually lives, BEFORE spending many turns on HTTP experiments. An 'empty list' or '0 results' finding is very often explained this way in one or two queries, and jumping straight to guessing via repeated HTTP calls with different filters wastes most of a run on something a single query would have answered.",
          ]
        : []),
      "Before calling an endpoint you have not seen before, a quick grep/read_file for its route/controller is reasonable - but do not substitute reading code for actually calling it. Code tells you what SHOULD happen; the real call tells you what DOES happen.",
      "If something you tried fails or looks wrong, try to isolate exactly which part is wrong (wrong status code? wrong field in the payload? missing entirely?) rather than a vague 'doesn't work'.",
      "Do not speculate about root cause in the code - that is the Developer's job, not yours. State the observed discrepancy precisely; naming the exact file/function is a bonus if you already know it from reading code, not a requirement.",
    ].map((step, index) => `${index + 1}. ${step}`),
    "You may call several tools in one turn when they are genuinely independent. test_plan, task_complete, and ask_user must be called ALONE, not alongside other tool calls.",
    "You may briefly (1-2 sentences) say what you are doing and why before calling tools.",
  ].join("\n");
}

function buildTesterTools(hasSemanticSearch: boolean, hasFindReferences: boolean, hasDbQuery: boolean, hasHttpRequest: boolean): ToolDefinition[] {
  const tools: ToolDefinition[] = [
    { type: "function", function: { name: "list_dir", description: "List a directory's contents.", parameters: { type: "object", properties: { path: { type: "string", description: "Relative path from the project root." } }, required: ["path"] } } },
    { type: "function", function: { name: "grep_content", description: "Search file contents for a literal string or regex.", parameters: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] } } },
    { type: "function", function: { name: "read_file", description: "Read a file's contents. Long files are truncated - pass `offset` (the char offset the truncation message gives you) to continue reading.", parameters: { type: "object", properties: { path: { type: "string", description: "Relative path from the project root." }, offset: { type: "number", description: "Character offset to continue from - omit for the start of the file." } }, required: ["path"] } } },
  ];

  if (hasSemanticSearch) {
    tools.push({ type: "function", function: { name: "semantic_search", description: "Find files by MEANING rather than literal words.", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } } });
  }

  if (hasFindReferences) {
    tools.push({ type: "function", function: { name: "find_references", description: "REAL structural callers/dependents of a class or function, from the project's persisted code graph.", parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } } });
  }

  if (hasDbQuery) {
    tools.push({ type: "function", function: { name: "db_query", description: "Run a single read-only SELECT/WITH/EXPLAIN/SHOW statement against the project's real database. Never INSERT/UPDATE/DELETE/DDL.", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } } });
  }

  if (hasHttpRequest) {
    tools.push({
      type: "function",
      function: {
        name: "http_request",
        description: "Make a real HTTP call against this project's own running dev server. Returns the actual status code, headers, and body. IMPORTANT: if this is a POST/PUT/PATCH request that needs a payload (login, create, update, etc.) you MUST fill in the body field with the full JSON payload as a string - a POST/PUT without a body will hit server-side validation and fail every time, exactly like forgetting to type a form's fields before clicking submit.",
        parameters: {
          type: "object",
          properties: {
            method: { type: "string", description: "GET, POST, PUT, PATCH, DELETE, etc." },
            path: { type: "string", description: "Path (and query string) relative to the project's base URL, e.g. \"/api/v1/clinics/1\"." },
            headers: { type: "object", description: "Optional extra headers (e.g. Authorization, Content-Type).", additionalProperties: { type: "string" } },
            body: { type: "string", description: "Request body as a raw JSON string, e.g. \"{\\\"email\\\":\\\"a@b.com\\\"}\". REQUIRED whenever the endpoint expects a payload (most POST/PUT/PATCH calls) - omitting it silently sends no body at all." },
          },
          required: ["method", "path"],
        },
      },
    });
  }

  tools.push(
    {
      type: "function",
      function: {
        name: "test_plan",
        description: "Call this ONCE, first, before any exploration or testing. Write a numbered list of the concrete scenarios you will check for this task, derived from reading it (a specific request, a specific role/account, a specific expected outcome per item). This becomes your own checklist - you will be asked to confirm every item is addressed before you can call task_complete.",
        parameters: { type: "object", properties: { cases: { type: "string", description: "Numbered list of test scenarios, one per line, e.g. \"1. ...\\n2. ...\"." } }, required: ["cases"] },
      },
    },
    { type: "function", function: { name: "note", description: "Save a short, durable fact you want to keep for the rest of this run (survives context compaction) - not a place for full dumps.", parameters: { type: "object", properties: { fact: { type: "string" } }, required: ["fact"] } } },
    { type: "function", function: { name: "ask_user", description: "Ask the human ONE clarifying question (in Russian) about WHAT/WHERE to test. Ends the run.", parameters: { type: "object", properties: { question: { type: "string" } }, required: ["question"] } } },
    { type: "function", function: { name: "task_complete", description: "Call exactly once, alone, when you have a clear evidence-backed QA report that addresses every item in your test_plan (or explains why it could not be checked). Summary in Russian.", parameters: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] } } },
  );

  return tools;
}

function toolCallToAction(toolCall: ToolCall): ParsedTesterAction {
  const tool = toolCall.function.name as TesterTool;
  let args: Record<string, unknown> = {};

  try {
    args = JSON.parse(toolCall.function.arguments || "{}") as Record<string, unknown>;
  } catch {
    return { tool, arg: "", formatError: `Could not parse tool call arguments as JSON: ${(toolCall.function.arguments ?? "").slice(0, 200)}` };
  }

  const str = (key: string): string => (typeof args[key] === "string" ? (args[key] as string) : "");

  switch (tool) {
    case "list_dir":
      return { tool, arg: str("path") };
    case "read_file":
      return { tool, arg: str("path"), offset: typeof args.offset === "number" ? args.offset : undefined };
    case "grep_content":
      return { tool, arg: str("pattern") };
    case "semantic_search":
      return { tool, arg: str("query") };
    case "find_references":
      return { tool, arg: str("name") };
    case "db_query":
      return { tool, arg: str("query") };
    case "http_request": {
      if (typeof args.method !== "string" || typeof args.path !== "string") {
        return { tool, arg: "", formatError: "http_request call is missing the required \"method\" and/or \"path\" field." };
      }
      // Packed as JSON in `arg` (mirrors write_file/edit_file's multi-field
      // shape elsewhere in this codebase) - the dispatch below parses it
      // back out. Keeping ParsedTesterAction's shape uniform (tool + one
      // string arg + optional fields) rather than adding yet more optional
      // fields to the interface for one tool.
      return {
        tool,
        arg: JSON.stringify({
          method: args.method,
          path: args.path,
          headers: typeof args.headers === "object" && args.headers ? args.headers : undefined,
          // 2026-07-28, live bug: the schema declares body as a string, but
          // at least one model (grok-4.1-fast) sends it as an already-parsed
          // JSON object instead of a double-encoded string. Silently
          // dropping it (as this used to do) sends the request with NO
          // body at all, and the resulting 422 gives the model no signal
          // that ITS OWN call was malformed - it just looks like the
          // endpoint rejects valid credentials. Coerce instead of drop.
          body: typeof args.body === "string" ? args.body : args.body !== undefined ? JSON.stringify(args.body) : undefined,
        }),
      };
    }
    case "test_plan":
      return { tool, arg: str("cases") };
    case "note":
      return { tool, arg: str("fact") };
    case "ask_user":
      return { tool, arg: str("question") };
    case "task_complete":
      return { tool, arg: str("summary") };
    default:
      return { tool, arg: "", formatError: `Unknown tool: ${String(tool)}` };
  }
}

export async function runTesterTask(options: TesterRunOptions): Promise<TesterRunResult> {
  const maxTurns = options.maxTurns ?? TESTER_DEFAULT_MAX_TURNS;
  const hasHttpRequest = Boolean(options.httpRequest);
  const hasDbQuery = Boolean(options.dbQuery);
  const hasSemanticSearch = Boolean(options.semanticSearch);
  const hasFindReferences = Boolean(options.findReferences);
  let testerTools = buildTesterTools(hasSemanticSearch, hasFindReferences, hasDbQuery, hasHttpRequest);
  const REPORT_MODE_TOOL_NAMES = new Set(["test_plan", "note", "ask_user", "task_complete"]);
  const reportOnlyTesterTools = testerTools.filter((tool) => REPORT_MODE_TOOL_NAMES.has(tool.function.name));
  let explorationBudgetBounceSent = false;

  const messages: ChatMessage[] = [
    { role: "system", content: buildTesterSystemPrompt(hasHttpRequest, hasDbQuery, hasSemanticSearch, hasFindReferences) },
    {
      role: "user",
      content: [
        `Project: ${options.projectRoots.map((root) => root.absolutePath).join(", ")}`,
        `Task: ${options.task}`,
        ...(options.observerHint ? ["", options.observerHint] : []),
        ...(options.knownFactsHint ? ["", options.knownFactsHint] : []),
        ...(!hasHttpRequest ? ["", "NOTE: no running dev server could be resolved for this project - you have no http_request tool this run. Say so explicitly in your report rather than guessing at behavior from code alone."] : []),
      ].join("\n"),
    },
  ];

  // Test-plan slot (2026-07-28, explicit product-owner request): same fixed
  // message-slot pattern as durableNotes below (survives compaction), but
  // rendered BEFORE it since the plan should anchor everything that
  // follows. Deliberately absent until the model writes one - the blunt
  // "not yet written" text is itself the nudge, and task_complete is
  // gated on this being non-null (see the task_complete branch below).
  let testPlan: string | null = null;
  const testPlanMessageIndex = messages.length;
  const renderTestPlan = (): string => (testPlan === null ? "Тест-план: ещё не составлен - составь его первым делом через test_plan, до начала тестирования." : `Тест-план (составлен через test_plan):\n${testPlan}`);
  messages.push({ role: "user", content: renderTestPlan() });

  const durableNotes: string[] = [];
  const durableNotesMessageIndex = messages.length;
  const renderDurableNotes = (): string =>
    durableNotes.length === 0
      ? "Заметки (note), сохранённые за этот прогон: пока нет."
      : ["Заметки (note), сохранённые за этот прогон (переживают сжатие истории):", ...durableNotes.map((note, index) => `${index + 1}. ${note}`)].join("\n");
  messages.push({ role: "user", content: renderDurableNotes() });

  const seedMessageCount = messages.length;
  let historyCompactionMessageIndex = -1;
  // A turn is 1 assistant message + N tool-role responses (N varies with how
  // many tools the model batched) - message-COUNT-based compaction alone
  // could otherwise cut between an assistant message's tool_calls and one of
  // its own tool responses, which every provider rejects as malformed.
  // Tracks the message index right after each turn fully completes, so
  // compaction only ever cuts at a turn boundary. Same design as
  // develop-loop.ts's turnBoundaries.
  const turnBoundaries: number[] = [];

  function compactHistoryIfNeeded(): void {
    if (messages.length - seedMessageCount <= TESTER_HISTORY_COMPACT_TRIGGER_MESSAGES) {
      return;
    }

    const target = messages.length - TESTER_HISTORY_KEEP_RECENT_MESSAGES;
    let keepFromIndex = seedMessageCount;

    for (const boundary of turnBoundaries) {
      if (boundary <= target && boundary > keepFromIndex) {
        keepFromIndex = boundary;
      }
    }

    if (keepFromIndex <= seedMessageCount) {
      return;
    }

    const summaryContent = [
      "Сводка более ранних ходов этого прогона (полные сообщения этих ходов удалены из контекста, чтобы разговор не рос бесконечно - если нужно текущее содержимое файла или повторный запрос, сделай его снова через нужный инструмент, не полагайся на память):",
      ...actionsLog,
    ].join("\n");

    const beforeLength = messages.length;

    if (historyCompactionMessageIndex === -1) {
      messages.splice(seedMessageCount, keepFromIndex - seedMessageCount, { role: "user", content: summaryContent });
      historyCompactionMessageIndex = seedMessageCount;
    } else {
      messages[historyCompactionMessageIndex] = { role: "user", content: summaryContent };
      messages.splice(historyCompactionMessageIndex + 1, keepFromIndex - (historyCompactionMessageIndex + 1));
    }

    const shift = messages.length - beforeLength;

    for (let i = turnBoundaries.length - 1; i >= 0; i -= 1) {
      if ((turnBoundaries[i] as number) <= keepFromIndex) {
        turnBoundaries.splice(i, 1);
      } else {
        turnBoundaries[i] = (turnBoundaries[i] as number) + shift;
      }
    }
  }

  const seenDirs = new Set<string>([normalizeDirKey(".")]);
  const requestLog: TesterRunResult["requestLog"] = [];
  const actionsLog: string[] = [];
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;

  const finalize = (overrides: Partial<TesterRunResult>): TesterRunResult => ({
    report: null,
    clarificationQuestion: null,
    requestLog,
    actionsLog,
    turnsUsed: 0,
    totalPromptTokens,
    totalCompletionTokens,
    stopped: "max_turns",
    mutatingRequests: requestLog
      .filter(({ request }) => request.method.toUpperCase() !== "GET")
      .map(({ turn, request, result }) => ({ turn, method: request.method.toUpperCase(), path: request.path, ...(request.body ? { body: request.body } : {}), status: result.status })),
    ...overrides,
  });

  for (let turn = 1; turn <= maxTurns; turn += 1) {
    compactHistoryIfNeeded();

    if (options.shouldAbort?.()) {
      actionsLog.push(`[turn ${turn}] ABORTED by caller.`);
      return finalize({ turnsUsed: turn, stopped: "aborted" });
    }

    options.onProgress?.({ turn, phase: "testing" });

    let content: string | null;
    let toolCalls: ToolCall[];

    try {
      const result = await callModel(options.providerBaseUrl, options.providerApiKey, options.testerModel, messages, undefined, undefined, testerTools);
      content = result.content;
      toolCalls = result.toolCalls ?? [];
      totalPromptTokens += result.usage?.prompt_tokens ?? 0;
      totalCompletionTokens += result.usage?.completion_tokens ?? 0;
    } catch (error) {
      return finalize({ turnsUsed: turn, stopped: "error", error: error instanceof Error ? error.message : String(error) });
    }

    if (totalPromptTokens + totalCompletionTokens >= TESTER_TOKEN_SAFETY_LIMIT) {
      actionsLog.push(`[turn ${turn}] SAFETY ABORT: run exceeded ${TESTER_TOKEN_SAFETY_LIMIT} tokens.`);
      return finalize({ turnsUsed: turn, stopped: "max_turns" });
    }

    messages.push({ role: "assistant", content: content || null, tool_calls: toolCalls.length ? toolCalls : undefined });

    if (toolCalls.length === 0) {
      messages.push({ role: "user", content: "No tool call was made in your reply. Call one of the available tools, or task_complete(summary in Russian) if you are done." });
      turnBoundaries.push(messages.length);
      continue;
    }

    const actions = toolCalls.map(toolCallToAction);
    const first = actions[0] as ParsedTesterAction;

    if (first.tool === "ask_user") {
      actionsLog.push(`[turn ${turn}] ask_user`);
      return finalize({ turnsUsed: turn, stopped: "needs-clarification", clarificationQuestion: first.arg });
    }

    if (first.tool === "task_complete") {
      if (testPlan === null) {
        // Soft gate, not a hard block: give the model one explicit chance to
        // write the plan it skipped, rather than silently accepting a report
        // with no checklist behind it or looping forever if it never
        // complies. actionsLog records the near-miss either way. Every
        // tool_call_id from this turn still needs a matching "tool" message
        // (several providers reject the next request otherwise) - a plain
        // "user" message alone would leave task_complete's call unanswered.
        actionsLog.push(`[turn ${turn}] task_complete REJECTED: no test_plan was ever written.`);
        for (const toolCall of toolCalls) {
          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            name: toolCall.function.name,
            content: "Rejected: you called task_complete without ever calling test_plan first. Call test_plan now with the numbered list of scenarios your report just covered (retroactively is fine), then call task_complete again.",
          });
        }
        turnBoundaries.push(messages.length);
        continue;
      }

      // Live bug (2026-07-28): the test_plan gate above checks WHETHER a
      // plan exists, not whether the report itself has real content - a
      // real run called task_complete with test_plan already done but an
      // EMPTY summary string, and this returned a "completed" result with
      // report:"" that looked successful everywhere except the one field
      // that actually mattered. Same soft-gate pattern as the test_plan
      // check: reject and give the model one explicit chance to actually
      // write the report it apparently meant to.
      if (first.arg.trim().length < 20) {
        actionsLog.push(`[turn ${turn}] task_complete REJECTED: summary was empty or too short (${first.arg.length} chars).`);
        for (const toolCall of toolCalls) {
          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            name: toolCall.function.name,
            content: "Rejected: task_complete's summary was empty or far too short to be a real report. Call task_complete again with the FULL QA report text as the summary argument - what you did, what you observed, whether it matches the task.",
          });
        }
        turnBoundaries.push(messages.length);
        continue;
      }

      actionsLog.push(`[turn ${turn}] task_complete`);
      return finalize({ turnsUsed: turn, stopped: "task_complete", report: first.arg });
    }

    for (let actionIndex = 0; actionIndex < actions.length; actionIndex += 1) {
      const action = actions[actionIndex] as ParsedTesterAction;
      const toolCallId = (toolCalls[actionIndex] as ToolCall).id;
      let observation: string;

      if (action.formatError) {
        observation = `Error: ${action.formatError}`;
      } else if (action.tool === "list_dir") {
        observation = await listDir(options.projectRoots, action.arg);
        seenDirs.add(normalizeDirKey(action.arg));
      } else if (action.tool === "grep_content") {
        observation = await grepContent(options.projectRoots, action.arg);
      } else if (action.tool === "semantic_search") {
        observation = options.semanticSearch ? await options.semanticSearch(action.arg) : "(semantic search is not available for this project)";
      } else if (action.tool === "find_references") {
        observation = options.findReferences ? await options.findReferences(action.arg) : "(find_references is not available for this project)";
      } else if (action.tool === "db_query") {
        observation = options.dbQuery ? await options.dbQuery(action.arg) : "(db_query is not available - no resolvable database connection for this project)";
      } else if (action.tool === "http_request") {
        if (!options.httpRequest) {
          observation = "(http_request is not available - no resolvable dev server for this project)";
        } else {
          try {
            const parsed = JSON.parse(action.arg) as TesterHttpRequestInput;
            const result = await options.httpRequest(parsed);
            requestLog.push({ turn, request: parsed, result });
            observation = `HTTP ${result.status} (${Math.round(result.durationMs)}ms)\nHeaders: ${JSON.stringify(result.headers)}\nBody:\n${result.body}`;
          } catch (error) {
            observation = `Error: http_request failed - ${error instanceof Error ? error.message : String(error)}`;
          }
        }
      } else if (action.tool === "test_plan") {
        testPlan = action.arg;
        messages[testPlanMessageIndex] = { role: "user", content: renderTestPlan() };
        observation = "Test plan recorded. Work through it, then make sure your task_complete report addresses every item.";
      } else if (action.tool === "note") {
        durableNotes.push(action.arg);
        messages[durableNotesMessageIndex] = { role: "user", content: renderDurableNotes() };
        observation = "Noted.";
      } else {
        const parentDir = dirnameOf(action.arg);

        if (!seenDirs.has(parentDir)) {
          const dirListing = await listDir(options.projectRoots, parentDir);
          seenDirs.add(normalizeDirKey(parentDir));
          observation = `You asked to read a file in the "${parentDir}" directory, which you have not listed yet - here is its content; read the file you need as your next action:\n${dirListing}`;
        } else {
          const raw = await readFileRaw(options.projectRoots, action.arg);
          observation = "error" in raw ? raw.error : formatReadFileSlice(raw.content, TESTER_READ_FILE_CHARS, action.offset ?? 0);
        }
      }

      const boundedObservation = observation.length > MAX_OBSERVATION_CHARS ? `${observation.slice(0, MAX_OBSERVATION_CHARS)}\n... (truncated)` : observation;
      actionsLog.push(`[turn ${turn}] ${action.tool}(${action.arg.length > 200 ? `${action.arg.slice(0, 200)}...` : action.arg}) -> ${observation.split("\n").length} lines`);
      messages.push({ role: "tool", tool_call_id: toolCallId, name: action.tool, content: boundedObservation });
    }

    // See TESTER_EXPLORATION_BUDGET_BOUNCE_RATIO's comment above - proactive
    // and unconditional (unlike Developer's version, which only fires while
    // zero edits exist yet): Tester's whole job IS gathering evidence, so
    // there is no "hasn't done anything real yet" gate to check - the
    // failure mode observed live was gathering evidence right up to the
    // ceiling without ever stopping to write it up, regardless of how much
    // real work happened.
    const budgetUsedRatio = Math.max(turn / maxTurns, (totalPromptTokens + totalCompletionTokens) / TESTER_TOKEN_SAFETY_LIMIT);

    if (!explorationBudgetBounceSent && budgetUsedRatio >= TESTER_EXPLORATION_BUDGET_BOUNCE_RATIO) {
      explorationBudgetBounceSent = true;
      testerTools = reportOnlyTesterTools;
      actionsLog.push(`[turn ${turn}] exploration-budget bounce: ${Math.round(budgetUsedRatio * 100)}% of budget used, no report yet.`);
      messages.push({
        role: "user",
        content: `You have used over ${Math.round(TESTER_EXPLORATION_BUDGET_BOUNCE_RATIO * 100)}% of your available turn/token budget for this task and have not called task_complete yet. Evidence-gathering tools (list_dir/read_file/grep_content/semantic_search/find_references/db_query/http_request) are now DISABLED for the rest of this run - only note, ask_user, and task_complete remain available. Write your report now based on what you have already found: state clearly what you verified, what you did NOT get to, and why - a report with honest gaps is far more useful than no report at all.`,
      });
    }

    turnBoundaries.push(messages.length);
  }

  return finalize({ turnsUsed: maxTurns, stopped: "max_turns" });
}
