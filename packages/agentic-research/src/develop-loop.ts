import { callModel, type ChatMessage } from "./provider.js";
import { buildSeedGrepObservation } from "./loop.js";
import {
  dirnameOf,
  editFile,
  grepContent,
  listDir,
  normalizeDirKey,
  readFile,
  runShellCommand,
  toWorkspaceRelativePath,
  writeFile,
  type ShellCommandResult,
  type WorkspaceRoot,
} from "./tools.js";

// Development runs are longer than research runs (write -> verify -> fix
// cycles), so both ceilings are wider than loop.ts's. Same philosophy though:
// these stop a genuinely runaway loop, they do not pressure the model to
// finish before it is done.
// Raised 2026-07-18 on real evidence, not a guess: multiple live multi-root
// Slay runs did healthy, correctly-progressing work (10-15 files touched,
// zero FORMAT_ERROR after the concrete block-example fix, genuine breadth -
// backend + frontend + i18n for one feature) and STILL hit the old 60-turn/
// 600K-token ceiling before ever reaching task_complete/Reviewer - the
// bottleneck was the ceiling itself, not a stuck loop the ceiling exists to
// catch. Explicitly the "мы не бюджетировали research, мы его
// оптимизировали" principle applied in the OTHER direction now: the
// optimization pass (semanticSeedFiles, stuck detector, deterministic
// edit_file recovery, concrete block example) came FIRST and is what makes
// raising this defensible today, not a substitute for it.
const DEFAULT_DEVELOP_CEILING_TURNS = 90;
const DEVELOP_TOKEN_SAFETY_LIMIT = 950_000;
// Live evidence (iteration 4, 2026-07-18): 14 FORMAT_ERROR incidents, almost
// all on real ~500-600 line Vue SFCs (SshTab.vue, AddEditServerDialog.vue) -
// logs showed the SEARCH block parsed fine but the REPLACE/CONTENT block's
// CLOSING marker never arrived, consistent with the shared 4000-token
// completion cap (provider.ts's MAX_COMPLETION_TOKENS) truncating a large
// file's content mid-block. Iteration 5 tried the obvious fix - raising it
// to 16_000 for just the Developer's per-turn call - and on an isolated
// control test it was NOT safe: deepseek/deepseek-v3.2 (via this provider)
// deterministically switched to emitting its own native tool-call special
// tokens (`<｜｜DSML｜｜tool_calls>...`) instead of this loop's prompt-based
// ACTION protocol, from turn 2 onward, on two separate runs - zero files
// changed, 100% no-progress. Reverted; still uses the shared default (see
// callModel's optional maxCompletionTokens param in provider.ts, added for
// this experiment and left in place, but NOT used with an inflated value
// here). The 4000-token baseline still delivered 13 real files with only
// 3/32 turns hitting FORMAT_ERROR - manageable via this loop's existing
// turn-level retry. Large-file truncation remains a real, open gap, but the
// actual dominant bottleneck at 4000 turned out to be unbounded PROMPT
// token growth across turns (974K prompt tokens by turn 32, tripping
// DEVELOP_TOKEN_SAFETY_LIMIT) - fixed by conversation-history
// trimming/summarization, not a bigger completion cap. Left for a future
// iteration, out of scope for this 5-iteration cycle.
const MAX_ACTIONS_PER_TURN = 4;
const MAX_OBSERVATION_CHARS = 7000;
// Editing needs to SEE more of a file than answering does - a truncated read
// hides exactly the code the edit must match. Still bounded: cost control,
// and edit_file's uniqueness requirement keeps truncation from corrupting.
const DEVELOP_READ_FILE_CHARS = 24_000;
// A diff bigger than this is almost certainly a runaway (vendored deps,
// generated code) - the reviewer sees the head and is told it was truncated.
const MAX_REVIEW_DIFF_CHARS = 60_000;
// One fix round, then the verdict is final and a human decides
// (docs/architecture/011-developer-pipeline.md: bounded retry is what keeps
// the Developer<->Reviewer loop from burning budget on noise findings).
const MAX_REVIEW_ROUNDS = 2;
// Live evidence (2026-07-18): against a real 392-line file (magendamd
// CreateClinicAction.php - the earlier develop-loop tests only ever hit
// small synthetic files, which never surfaced this), a run made 13
// consecutive edit_file attempts against the SAME file that all failed to
// match, burning ~560K tokens before the run-level safety ceiling finally
// caught it - zero code delivered. The model kept blindly guessing against
// its own (evidently wrong) mental model of the file's current content
// instead of re-reading it. This is the research loop's STUCK_TURNS
// nudge, applied at file granularity instead of whole-run granularity.
const EDIT_FAILURE_STUCK_THRESHOLD = 3;

// General "no progress" detector (2026-07-18), ported from the research
// loop's proven STUCK_TURNS_THRESHOLD mechanism - deliberately NOT a
// turn-count nudge (same philosophy as research: this only fires when the
// explored/edited surface has genuinely stopped growing for many turns
// straight, not on a timer). Higher than research's 8/+4 because a develop
// run's natural read/edit/verify cycle legitimately revisits similar ground
// more than pure exploration does.
const STUCK_TURNS_THRESHOLD = 10;
const STUCK_TURNS_HARD_ABORT = STUCK_TURNS_THRESHOLD + 5;

// DB safety (2026-07-18, explicit product-owner requirement): a command
// that mutates persisted schema/data in a way git cannot roll back. Kept
// generic across ORMs/stacks (Laravel/Rails/Django/Alembic/Flyway/Prisma/
// Knex/TypeORM + raw destructive SQL) rather than hardcoded to one project's
// tooling - matches this codebase's existing anti-hardcoding stance. Any
// match halts the run for human approval (see runDevelopmentTask) instead
// of executing silently or being blocked outright - migrations are
// sometimes genuinely required to complete a task, unlike git writes which
// the Developer never needs at all.
// Live evidence (2026-07-18): "php artisan migrate:status" (a READ-ONLY
// check, no mutation at all) tripped this pattern on the very first live
// test - "artisan migrate" matched as a substring with the word boundary
// satisfied by the following ":". Negative lookahead excludes THAT one
// read-only subcommand while still catching bare "migrate" and every
// mutating migrate: variant (caught separately by the migrate:(rollback|...)
// alternative below, which is unaffected by this exclusion).
const SENSITIVE_DB_COMMAND_PATTERN = /\b(artisan\s+migrate(?!:status)|artisan\s+db:seed|rails\s+db:(migrate|schema:load|seed)|manage\.py\s+migrate|alembic\s+(upgrade|downgrade)|flyway\s+migrate|knex\s+migrate|prisma\s+migrate|typeorm\s+migration:run|migrate:(rollback|reset|fresh|refresh))\b|\b(DROP\s+TABLE|DROP\s+DATABASE|TRUNCATE\s+TABLE|ALTER\s+TABLE)\b/i;
// A dry-run flag anywhere in the command means nothing actually executes,
// regardless of which migrate variant it decorates - live evidence
// (2026-07-18): the model itself reached for --pretend specifically to be
// cautious after an earlier attempt was refused, and the gate blocked even
// that already-safe caution, forcing a redundant approval round.
const DRY_RUN_FLAG_PATTERN = /--pretend\b|--dry-run\b/i;

function isSensitiveDbCommand(command: string): boolean {
  return SENSITIVE_DB_COMMAND_PATTERN.test(command) && !DRY_RUN_FLAG_PATTERN.test(command);
}

export interface DevelopVerificationEntry extends ShellCommandResult {
  turn: number;
}

export interface DevelopReviewRound {
  verdict: "approved" | "needs-changes";
  noteFindings: string[];
  findings: string[];
  raw: string;
}

export interface DevelopRunOptions {
  task: string;
  /** Worktree roots (packages/repository-git createTaskWorktree) - NEVER the user's own checkout. */
  projectRoots: WorkspaceRoot[];
  developerModel: string;
  reviewerModel: string;
  providerBaseUrl: string;
  providerApiKey: string;
  maxTurns?: number;
  shouldAbort?: () => boolean;
  /** Same memory-injection channels the research loop uses (fact store / glossary / observer graph). */
  knownFactsHint?: string;
  observerHint?: string;
  /**
   * Review-feedback continuation: the previous develop iteration in this
   * conversation. When worktreeCarriesChanges is true, the current worktree
   * ALREADY CONTAINS that iteration's delivered changes and `task` is the
   * user's feedback on them - the loop must adjust, not restart.
   */
  priorIteration?: { task: string; summary: string; worktreeCarriesChanges: boolean };
  semanticSearch?: (query: string) => Promise<string>;
  findReferences?: (symbolOrFileName: string) => Promise<string>;
  /**
   * Top file paths by semantic similarity to the task - same mechanism as
   * loop.ts's research loop, where this was "the single biggest latency
   * lever measured" (auto-reads content into pre-turn context instead of
   * spending a full round-trip on read_file for files the model would have
   * asked for anyway). Ported 2026-07-18: declared in this interface since
   * day one but never actually wired by develop-runner.ts, so every develop
   * run so far paid the exploration cost research already solved.
   */
  semanticSeedFiles?: (query: string) => Promise<string[]>;
  /**
   * Injected by the caller (who owns the worktrees): returns the current
   * full diff + changed file list. Called when the Developer declares
   * task_complete, before the Reviewer sees anything.
   */
  collectDiff: () => Promise<{ diff: string; changedFiles: string[] }>;
  /**
   * Sensitive DB-mutating commands (migrations, seeds, schema DDL) approved
   * and already executed earlier in THIS SAME conversation (2026-07-18 DB
   * safety - see runDevelopmentTask's SENSITIVE_DB_COMMAND_PATTERN). Surfaced
   * to the model so a follow-up like "revert that migration" can be resolved
   * from context instead of guessing which command is meant.
   */
  priorSensitiveActions?: DevelopSensitiveAction[];
  onProgress?: (info: { turn: number; filesChanged: number; phase: "developing" | "reviewing" | "fixing" }) => void;
  /**
   * Impact analysis (2026-07-18, docs/architecture/011 §4.13): deterministic
   * structural-dependents lookup against the SAME persisted graph
   * find_references already uses - given the files actually edited this
   * run, returns which OTHER files/symbols in the project structurally call
   * or depend on them, so the Reviewer's finding (2) ("correctness bugs and
   * behavior broken for existing callers") is grounded in real graph data
   * instead of resting entirely on whether the Developer happened to call
   * find_references enough times. Deliberately NOT a new role/handoff (see
   * §1's "each handoff is a context loss") - injected straight into the
   * EXISTING Reviewer call as grounding context, same continuous run.
   * Sync and cheap (pure graph traversal) - undefined when no graph
   * snapshot exists yet, degrading silently to today's behavior.
   */
  computeImpactPreview?: (editedFiles: string[]) => string;
  /**
   * Semantic repeat detection (2026-07-18, docs/architecture/011 §4.16
   * follow-up): the round-2 repeat-suppression added in §4.15
   * (suppressRepeatedRoundTwoBlockers) only matches findings by normalized
   * STRING equality - live evidence showed round 1 and round 2 restating
   * the exact same already-disputed claim in different wording ("не имеет
   * ограничения" vs "не имеет ограничения NOT NULL") slip past it entirely,
   * since the normalized keys differ even though the underlying claim is
   * identical. Given (candidateFinding, comparisonTexts), returns the
   * highest cosine similarity between the candidate's embedding and any
   * comparison text's embedding - undefined/best-effort: on any failure
   * (no provider, network error) the caller falls back to the existing
   * string-only check, never blocking the review on this.
   */
  computeFindingSimilarity?: (candidateFinding: string, comparisonTexts: string[]) => Promise<number>;
  /**
   * Read-only DB inspection (2026-07-18, docs/architecture/011 §4.19,
   * explicit product-owner directive from their own real workflow - see
   * apps/api/src/db-query-tool.ts for the connection-resolution/safety
   * design). Undefined when no DB config could be resolved for this
   * project - the db_query ACTION is simply omitted from the protocol,
   * same "honest degradation" convention as findReferences/computeImpactPreview.
   */
  dbQuery?: (query: string) => Promise<string>;
}

/**
 * A DB-mutating command (migration, seed, schema DDL) the Developer wanted
 * to run. `status: "pending"` halts the run for human approval (2026-07-18
 * DB safety) - the orchestrator (develop-runner.ts) executes it directly in
 * the worktree on approval (not the model re-issuing it, so the exact
 * command that was shown is the exact command that runs) and records the
 * result before resuming.
 */
export interface DevelopSensitiveAction {
  command: string;
  /** The model's own stated reason, shown to the human alongside the raw command. */
  reason: string;
  status: "pending" | "approved" | "rejected";
  exitCode?: number;
  output?: string;
  executedAt?: string;
}

export interface DevelopRunResult {
  /** Developer's task_complete text (Russian, user-visible). */
  summary: string | null;
  /** Set when the run stopped to ask the user ONE clarifying question instead of guessing. */
  clarificationQuestion: string | null;
  /** Set when the run halted on a sensitive DB command awaiting human approval (stopped === "needs-approval"). */
  pendingApproval: DevelopSensitiveAction | null;
  /** Every sensitive DB command this run touched (approved+executed or rejected) - not just the pending one. */
  sensitiveActions: DevelopSensitiveAction[];
  diff: string;
  changedFiles: string[];
  verificationLog: DevelopVerificationEntry[];
  reviews: DevelopReviewRound[];
  /** Final gate outcome. "not-run" = empty diff or reviewer unavailable (see reviews/raw for why). */
  reviewVerdict: "approved" | "needs-changes" | "not-run";
  touchedFiles: string[];
  actionsLog: string[];
  turnsUsed: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  stopped: "task_complete" | "needs-clarification" | "needs-approval" | "max_turns" | "error" | "aborted";
  error?: string;
}

type DevelopTool =
  | "list_dir"
  | "grep_content"
  | "read_file"
  | "semantic_search"
  | "find_references"
  | "db_query"
  | "run_command"
  | "write_file"
  | "edit_file"
  | "ask_user"
  | "task_complete";

export interface ParsedDevelopAction {
  tool: DevelopTool;
  arg: string;
  /** write_file's <<<CONTENT block. */
  content?: string;
  /** edit_file's <<<SEARCH / <<<REPLACE blocks. */
  search?: string;
  replace?: string;
  /** Set when the ACTION line was found but its required block(s) were malformed - executor bounces this back verbatim. */
  formatError?: string;
}

function isMicroCopyTask(task: string): boolean {
  const normalized = task.toLowerCase();
  const hasReplaceIntent = /замени|переименуй|исправь|переведи/.test(normalized);
  const hasTextCue = /слово|текст|строк|placeholder|label|заголов|подпись|provider|backend|frontend|chat|локал|перевод/.test(normalized);
  const hasTightScope = /больше ничего|ничего не меняй|только пользовательский текст|только текст|только в .*блоке|только .*строк/.test(normalized);
  const excludesCodeyTask = !/миграц|api|endpoint|schema|таблиц|column|поле|model|service|controller|bug|ошибк|exception|refactor|рефактор|логик/.test(normalized);
  return hasReplaceIntent && hasTextCue && hasTightScope && excludesCodeyTask;
}

function buildDevelopSystemPrompt(hasSemanticSearch: boolean, isMultiRoot: boolean, hasFindReferences: boolean, hasDbQuery: boolean): string {
  return [
    "You are an experienced senior fullstack developer implementing a code change in a project you are seeing for the first time. You work in an isolated git worktree - your edits cannot damage the user's checkout, and everything you change will be reviewed as a diff.",
    "You have tools. Write each action on its own line in this exact form (no markdown wrapping):",
    "ACTION: list_dir(relative/path)",
    "ACTION: grep_content(string or regex to search file contents for)",
    "ACTION: read_file(relative/path/to/file.php)",
    ...(hasSemanticSearch
      ? ["ACTION: semantic_search(a plain-language description of what you are looking for) - finds files by MEANING, use it when the business term from the task does not match any file/directory name or grep hit."]
      : []),
    ...(hasFindReferences
      ? ["ACTION: find_references(ClassOrFunctionOrFileName) - REAL structural callers/dependents from the persisted code graph; use before changing a shared function's signature/behavior to see who depends on it."]
      : []),
    ...(hasDbQuery
      ? [
          // Live evidence motivating this tool (2026-07-18, explicit
          // product-owner directive from their own real workflow): seeing
          // an actual row is often faster than reading a model - and for a
          // non-trivial query, get it right against real data FIRST, then
          // translate to this project's ORM/query-builder convention
          // (checking for an existing scope/relation to reuse along the
          // way, same as instruction 1 below).
          "ACTION: db_query(a single SELECT/WITH/EXPLAIN/SHOW statement) - runs read-only against the project's REAL database (resolved from its own .env/docker-compose, not the worktree). READ-ONLY ONLY, enforced in code regardless of what you send - no INSERT/UPDATE/DELETE/DDL, no multiple statements, this is for INSPECTION not mutation. Use it to: see real example rows instead of guessing from a model's field list; when debugging \"X did not save correctly\", check what actually got persisted before guessing where the bug is; when building a non-trivial query (filters/joins/aggregation), get the raw SQL right against real data FIRST, then translate it into this project's ORM/query-builder style (checking for an already-existing scope/relation to reuse, per instruction 1). All actual schema/data changes still go through run_command's normal DB-safety gate (migrations, seeders) - db_query itself can never write anything.",
        ]
      : []),
    "ACTION: run_command(shell command) - runs in the project root (180s timeout). Use it to run the project's OWN checks: tests, linter, build, php -l, etc. Also use it to boot local infrastructure this task needs (e.g. docker compose up -d for a database) - check for a docker-compose file / README / .env.example as part of your normal exploration if the task needs a working DB.",
    ...(isMultiRoot
      ? [
          "For run_command in this multi-part project, prefix with the part label: ACTION: run_command(api: php artisan test) - the label goes INSIDE the parentheses, as the first part of the command argument. It is NOT a separate action type: never write \"ACTION: api: php artisan test\" (missing the run_command(...) wrapper entirely) - that is not a recognized action and will be silently ignored, wasting the whole turn.",
        ]
      : []),
    "DB SAFETY: a command that changes persisted schema or data in a way git cannot undo (running a migration, db:seed, migrate:rollback, DROP/ALTER/TRUNCATE, etc.) will NOT execute when you call run_command - it instead PAUSES this run for a human to approve, and resumes afterward WITH THE REAL OUTPUT of what you ran, so you can act on it. This is expected, not an error - if the task genuinely needs a migration, issue it via run_command like any other command and wait; do not try to work around it (no manually editing files inside a database, no alternate commands to sneak past it). A command with --pretend or --dry-run (e.g. php artisan migrate --pretend) runs immediately WITHOUT pausing - nothing actually changes, so it is a good first move to preview a migration before running it for real. If you only need to VERIFY something against the database without permanently changing data (e.g. checking a query/insert behaves correctly), wrap it in an explicit transaction that you roll back yourself using the project's own DB tooling (e.g. for Laravel: php artisan tinker --execute=\"DB::beginTransaction(); ...; DB::rollBack();\", or raw SQL: START TRANSACTION; ...; ROLLBACK;) - that is a normal run_command too, not a paused one, since nothing is actually left changed.",
    "ACTION: write_file(relative/path/to/file.ext) - creates or fully overwrites a file. The content comes in a block IMMEDIATELY after the ACTION line:",
    "<<<CONTENT",
    "...entire file content...",
    "CONTENT>>>",
    "ACTION: edit_file(relative/path/to/file.ext) - targeted edit of an existing file. Two blocks IMMEDIATELY after the ACTION line:",
    "<<<SEARCH",
    "...exact existing lines (must match the file EXACTLY and occur exactly once)...",
    "SEARCH>>>",
    "<<<REPLACE",
    "...replacement lines...",
    "REPLACE>>>",
    // Live evidence (2026-07-18): different models varied sharply in how
    // often they generated MALFORMED blocks (missing/mismatched markers) -
    // one model repeatedly opened "<<<SEARCH" but never closed it with
    // "SEARCH>>>" on its own line. The prose description + placeholder
    // above was not enough for every model to reliably imitate; a complete,
    // concrete worked example (real code, not "...lines...") gives every
    // model something to pattern-match exactly, character for character.
    "Concrete worked example of a complete, correctly-formed edit_file call - copy this EXACT structure, only the content differs:",
    "ACTION: edit_file(app/Models/User.php)",
    "<<<SEARCH",
    "    protected $fillable = [",
    "        'name',",
    "        'email',",
    "    ];",
    "SEARCH>>>",
    "<<<REPLACE",
    "    protected $fillable = [",
    "        'name',",
    "        'email',",
    "        'phone',",
    "    ];",
    "REPLACE>>>",
    "Notice: each marker (\"<<<SEARCH\", \"SEARCH>>>\", \"<<<REPLACE\", \"REPLACE>>>\") is ALONE on its own line, with nothing else on that line - not indented, not combined with code, not followed by extra text. Every SEARCH block you open MUST be closed with \"SEARCH>>>\" before \"<<<REPLACE\" begins - never skip the closing marker.",
    "PREFER edit_file over write_file for existing files: read_file output can be truncated, and rewriting a file from a truncated read destroys the part you never saw. edit_file is immune to that - it only touches the block you matched.",
    "ACTION: ask_user(one clarifying question IN RUSSIAN) - use ONLY if the task is genuinely ambiguous in a way that materially changes what to implement (different behavior, different data model - not naming/details you can decide yourself). It ends the run and asks the human. Ask at the START, before writing code - never after you have already implemented one interpretation.",
    "ACTION: task_complete(final summary IN RUSSIAN) - call exactly once, when the change is done and verified as well as this project allows. The summary must state: what was changed and why, what was verified (which commands, what they showed), honestly what was NOT verified and why (e.g. the project has no test suite), and - only if genuinely non-empty, do not pad this - remaining risk (something you are not fully certain about, an edge case you could not check) and anything worth a human manually checking before this ships. No meta commentary.",
    "",
    "How to work:",
    "1. STUDY BEFORE WRITING, ACTIVELY, NOT JUST BY LUCK OF GREP. Before implementing anything, explicitly look for whether this project ALREADY has a mechanism for this kind of thing" + (hasSemanticSearch ? " - semantic_search is often the right tool for this (it finds by MEANING: e.g. search \"default records created for a new X\" or \"clone template data for new entity\", not just the task's literal words)" : "") + ". Find 2-3 places where this project already does something similar and read them - then write YOUR change in the same style, same naming, same patterns, same error handling, REUSING an existing mechanism (a shared method/hook/utility) instead of writing a new parallel one when one already exists. Code that reinvents what the codebase already has is wrong even when it runs - it is technical debt from the moment it is written.",
    `2. BEFORE CHANGING WHAT ALREADY EXISTS - never break an existing caller. Before you edit the BODY or SIGNATURE of a function/method that other code might call, or before you rename/remove/move anything existing,${hasFindReferences ? " use find_references(name) to see its real callers/dependents" : " grep_content for its name to see where else it is used"} and make sure your change keeps them working (or update them too, if that is genuinely required and still in scope). State in your task_complete summary which existing callers you checked for anything you changed rather than purely added - \"I did not check\" is an honest thing to write if true, but silently not checking is not.`,
    "3. STATE A SHORT PLAN before your first write_file/edit_file (a few sentences in your own reasoning text, not a separate tool call): which files need to change and why, which existing pattern from step 1 you are reusing (if any), and explicitly - does this task need a DATABASE MIGRATION/schema change? A feature that adds or reads a new field/column/table needs a real migration in this same task, not just application code that silently assumes the column exists - code referencing a column with no migration creating it is broken, not done. If there is a real, non-obvious choice between two reasonable ways to implement this (not a trivial choice with one obvious answer), name it and say which you picked and why - the safer/more consistent one wins over the cleverer one. Getting this right BEFORE writing code prevents discovering a missing piece late, when budget is tight.",
    "4. Read a file (read_file) before editing it - edit_file requires an exact match of existing content, guessing will just bounce.",
    "5. IMPORTANT: before reading a specific file in a directory you have not listed (list_dir) yet, list_dir it first - a neighboring file may be the real place to change.",
    "6. Keep the change minimal and coherent: implement what the task asks, do not refactor unrelated code, do not add features nobody asked for. Do not add error handling, validation, or defensive checks for scenarios that cannot happen given how this code is actually called - trust the surrounding code's own guarantees the same way it already does. Do not introduce a new abstraction (helper/base class/interface/config flag) for something that only has one or two call sites today - three similar lines beats a premature abstraction. If you must touch a file whose connection to the task is not obvious, say why in your summary.",
    "7. After meaningful changes, verify with run_command using the project's own tooling (look for package.json scripts, composer.json, Makefile, phpunit.xml etc.). A syntax check (php -l, node --check) is the bare minimum when no test suite exists. If verification is impossible, say so honestly in the summary instead of pretending.",
    // Tests-as-separate-step (2026-07-18, docs/architecture/011 §4.12): the
    // OLD version of this instruction told the Developer to add/extend
    // persisted test files as part of every task - directly caused a real
    // 45-turn spiral (building unrelated test factories/migrations from
    // scratch to satisfy this). Test coverage is now the user's own
    // explicit, separate, opt-in decision made AFTER review - writing test
    // FILES here is scope the task did not ask for, same as any other
    // unrequested feature (see instruction 6).
    "8. VERIFY YOUR OWN WORK, but do not write persisted test files unless the task explicitly asked for tests: for a BUG FIX, reproduce the wrong behavior first (an ad hoc run_command - a one-off script, a REPL/tinker call, a manual reproduction), then fix, then show the SAME ad hoc check now passing - before/after with throwaway commands, not a new test file added to the repo. Adding actual test files/test infrastructure is out of scope unless the task says so - that is a separate step the user decides on later.",
    "9. Do not invent APIs, columns, or config keys you have not seen in this codebase. Check first.",
    "10. Default to no comments in code you write. Add one only when it captures a non-obvious WHY (a hidden constraint, a workaround, something that would genuinely surprise the next reader) - never comments that restate what well-named code already says.",
    `You may batch up to ${MAX_ACTIONS_PER_TURN} ACTION lines per turn (they execute in order, results come back together). Any ACTION beyond the ${MAX_ACTIONS_PER_TURN}th is NOT executed - if you need more, split them across turns and wait for the results. Exceptions: task_complete and ask_user must be called ALONE.`,
    "Before an ACTION you may briefly (1-2 sentences) write what you are doing and why.",
    "If the reviewer later returns findings: fix the ones that are real. If a finding is factually wrong, do NOT change code to appease it - explain why in your next task_complete summary under a line starting with \"Оспорено:\".",
  ].join("\n");
}

export const REVIEWER_SYSTEM_PROMPT = [
  "You are an independent senior code reviewer (a different model from the author). You are given: the original task, the full unified diff of the change, and the verification journal (commands the author ran, with exit codes).",
  "Form your OWN opinion of how this task should be solved in this codebase, then judge the diff against it. You were deliberately NOT given the author's notes or plan - review the result, not the intention.",
  "Review ONLY the changed files visible in the diff and their direct, explicitly-provided structural impact. Do not turn this into a broader audit of neighboring modules, hypothetical files, or unrelated architecture cleanup.",
  "Look for, in order of importance: (1) the diff not actually doing what the task asks, or doing it partially; (2) correctness bugs and behavior broken for existing callers visible from the diff context - if a \"Structural impact\" block is given below, it lists REAL, deterministically-found dependents of the changed files (not a claim, actual graph data); check whether the diff's behavior change is compatible with each one, this is your strongest source for this finding, stronger than what you can infer from the diff alone; (3) changes with no plausible relation to the task (each must be justified or flagged); (4) a verification command the author actually RAN that FAILED (non-zero exit / visible error in its output) and the diff does not address it - flag it; (5) clear inconsistency with the surrounding code's own style visible in the diff context; (6) duplication and single-responsibility drift VISIBLE IN THE DIFF CONTEXT ITSELF - only flag this if you can point at a SPECIFIC existing function/method shown in the diff's surrounding context that the new code re-implements instead of reusing or extending, or a single new function/method that does two or more clearly unrelated things. Do not lecture about SOLID/DRY/design patterns in the abstract and do not suggest introducing a new abstraction (factory/strategy/interface/base class) unless the diff's own surrounding context already uses that abstraction elsewhere for the same kind of thing - proposing patterns the codebase does not already use is over-engineering, not a real finding; (7) a NEW PERSISTED FIELD WITH NO MIGRATION - if the diff adds a field/column to something that looks like it is meant to be saved to a database (added to a model's fillable/casts array, an ORM entity/@Column decorator, a serializer, a repository insert/update call) but the diff contains NO migration/schema file creating that column anywhere, flag it explicitly as broken - this code will fail at runtime against a real database, not just be incomplete (live evidence: this exact gap shipped a 'tags' field with zero migration).",
  // Tests-as-separate-step (2026-07-18, docs/architecture/011 §4.12, explicit
  // product-owner directive): this project's own primary test target (and
  // the owner's own work projects) are NOT test-covered by convention -
  // demanding acceptance-evidence/test coverage by default fought that
  // reality instead of respecting it, and was a major real source of wasted
  // turns this session (one run burned 45 turns building unrelated test
  // infrastructure chasing exactly this kind of finding). Test coverage is
  // now an explicit, separate, opt-in step the USER decides on AFTER a
  // correctness approval, never something the Reviewer blocks on.
  "Do NOT flag missing tests, missing acceptance-evidence, or a verification journal limited to static checks (lint/typecheck) as a reason to withhold approval - test coverage is handled as a separate, explicit step after this review, not part of it. Only flag a verification command that was actually run and actually failed (see (4)).",
  "Do NOT invent problems. Every finding must be concrete, grounded in the diff or the journal, and actionable - no vague advice, no style nitpicks the surrounding code itself contradicts, no demands to add features beyond the task.",
  // Live evidence (2026-07-18): a trivial rename task got the SAME finding
  // in both review rounds - "there might be other language files you
  // haven't checked" - even though the author's OWN verification journal
  // showed a list_dir(lang/) call that already proved only 4 language
  // directories exist. The finding speculated instead of reading the
  // evidence already sitting right there in the journal it was given.
  "Before writing a finding that says something MIGHT be missing/incomplete/unchecked ('there could be other files', 'this might not cover X'), check the verification journal you were given - if a command already shown there (list_dir, grep, a test run) already answers that specific question, use that answer instead of speculating, even if the answer means there is nothing to flag.",
  "Do NOT enumerate the diff line by line confirming things ARE correct/present/used properly - if something is fine, say nothing about it, do not write a finding that concludes 'this is fine/correct/not required'. A real diff rarely has more than a handful of genuine findings - if you notice yourself listing more than ~6-8, stop and re-read: you have very likely drifted into restating non-problems instead of finding real ones.",
  "If you are reviewing a SECOND round and are shown the previous blocker list plus the author's dispute/summary, only keep blocking on a blocker that is STILL present in the updated diff or on a TRULY NEW blocker introduced by the fix. Do not repeat an already-disputed blocker unless the updated diff or verification journal gives fresh concrete evidence that it remains broken.",
  // Live evidence (2026-07-18): round 1 blocked on a column having
  // unique() ("the task never asked for global uniqueness"); the author
  // removed unique() exactly as asked; round 2 then blocked on the
  // ABSENCE of unique() on that same column, reversing the round-1
  // position without ever acknowledging the reversal - a genuine
  // consistency failure, not a new finding.
  "If the author's fix did EXACTLY what your own previous round asked for (e.g. you said a constraint should not be there, and it is now gone), do NOT flag the resulting state as a NEW problem in this round unless you explicitly say why your own earlier guidance was wrong - silently reversing your own prior position without acknowledging it is not a legitimate finding, it is inconsistency. If you genuinely believe the previous round's guidance was mistaken, say so explicitly instead of pretending this is a fresh, unrelated observation.",
  "Classify every finding explicitly as either BLOCKER or NOTE. BLOCKER means merge should stop because the task is still wrong or broken. NOTE means a minor concern, cleanup idea, or follow-up that should NOT block approval.",
  // Live evidence (2026-07-18): a confidently-worded finding claimed a class
  // import was missing and would cause a fatal error - the class was
  // actually in the SAME namespace as the caller, so no import was needed;
  // that finding was simply wrong. Another finding re-demanded something
  // the diff you were given ALREADY contained. Before writing any finding
  // that says something is missing/absent/not done, look again at the
  // EXACT diff text you were given for this specific claim - do not rely on
  // a general expectation of what code like this usually needs. If you are
  // not certain the diff you can actually see supports the finding, do not
  // write it.",
  "Reply STRICTLY in this format: either the single word \"APPROVED\", or \"NEEDS_CHANGES:\" followed by a numbered list of findings IN RUSSIAN, one finding per number, each starting with either \"BLOCKER:\" or \"NOTE:\".",
].join("\n");

// Narrow, generic (not tied to one stack/ORM) detector for DB schema/
// migration files - matches Laravel/Rails/Django/Alembic/Flyway/raw-SQL
// naming conventions by directory or filename shape, not any one project's
// literal paths (see memory: no project-specific hardcoding). Used ONLY to
// decide whether to append the normalization checklist below - everywhere
// else in the reviewer this stays silent, since most tickets touch zero
// schema files and the checklist would just be noise on them.
const SCHEMA_CHANGE_PATTERN = /\bmigrations?\/|\bdb\/migrate\/|schema\.(rb|sql|prisma)$|\.sql$|\balembic\/versions\//i;

function touchesSchema(changedFiles: string[]): boolean {
  return changedFiles.some((filePath) => SCHEMA_CHANGE_PATTERN.test(filePath));
}

export const SCHEMA_REVIEW_ADDENDUM = [
  "This diff touches a database migration/schema file - additionally check, ONLY to the extent visible in the diff itself:",
  "- repeating groups or comma-packed multi-values in a single column (1NF violation);",
  "- a non-key column that only depends on PART of a composite primary key (2NF violation);",
  "- a column whose value is derivable from another column/table already in the diff's context instead of being stored redundantly (3NF/transitive-dependency smell) - unless it is a plausible, explicitly-justified denormalization (e.g. a cached/materialized value);",
  "- a new or altered column that plausibly needs an index/foreign key/not-null constraint given how it is used elsewhere in the diff, but does not have one.",
  "- CONFLICTING UNIQUE CONSTRAINTS: a column that is derived from (e.g. a slug generated from a name) or logically tied to another column already scoped to a parent/tenant (e.g. unique per profile_id/user_id/tenant_id), but ALSO has its own standalone global unique constraint - this silently defeats the intended scoping (two different tenants can never use the same derived value, even though the composite constraint says they should be able to). Live evidence: a migration correctly scoped `name` as unique(['profile_id', 'name']) but ALSO put a bare unique() on the auto-generated `slug` column, which is derived from `name` - the second tenant to create a same-named tag would be permanently blocked, contradicting the feature's own stated per-profile scoping.",
  "Only raise these if genuinely visible in the diff - do not demand a full schema redesign for an unrelated small change.",
].join("\n");

const DEVELOP_ACTION_PATTERN = /ACTION:\s*(list_dir|grep_content|read_file|semantic_search|find_references|db_query|run_command|write_file|edit_file|ask_user|task_complete)\s*\(/g;

// Same balanced-paren scanning as loop.ts's parseActions (kept separate on
// purpose: the research parser is proven live and this one adds block
// payloads it must never destabilize). Handles backslash-escaped parens in
// grep regexes and shell commands.
function findBalancedClose(content: string, openParenIndex: number): number {
  let depth = 0;

  for (let i = openParenIndex; i < content.length; i += 1) {
    const isEscaped = content[i - 1] === "\\" && content[i - 2] !== "\\";

    if (isEscaped) {
      continue;
    }

    if (content[i] === "(") {
      depth += 1;
    } else if (content[i] === ")") {
      depth -= 1;

      if (depth === 0) {
        return i;
      }
    }
  }

  return -1;
}

function extractBlock(segment: string, marker: string): { value: string; endIndex: number } | null {
  const open = `<<<${marker}`;
  const close = `${marker}>>>`;
  const openIndex = segment.indexOf(open);

  if (openIndex === -1) {
    return null;
  }

  const contentStart = segment.indexOf("\n", openIndex + open.length);

  if (contentStart === -1) {
    return null;
  }

  const closeIndex = segment.indexOf(close, contentStart);

  if (closeIndex === -1) {
    return null;
  }

  // Strip the single newline that precedes the closing marker (the marker
  // sits on its own line) - everything else is verbatim file content.
  const rawValue = segment.slice(contentStart + 1, closeIndex);
  return { value: rawValue.replace(/\n$/, ""), endIndex: closeIndex + close.length };
}

export interface ParsedDevelopTurn {
  actions: ParsedDevelopAction[];
  /**
   * ACTION lines beyond the per-turn cap. Live evidence (2026-07-17, first
   * E2E run): the developer batched 6 actions in one turn - the mutation
   * adding the actual feature call and the npm-run-check verification were
   * both silently dropped by the cap, the model believed they had happened,
   * skipped re-verification, and then (honestly, from its own view) DISPUTED
   * the reviewer's correct findings about exactly those two gaps. For
   * mutations, a silently dropped action is a corrupted mental model of the
   * workspace - the loop must tell the model outright.
   */
  droppedActionCount: number;
}

export function parseDevelopActions(content: string): ParsedDevelopTurn {
  const actions: ParsedDevelopAction[] = [];
  let searchFrom = 0;

  while (actions.length < MAX_ACTIONS_PER_TURN) {
    DEVELOP_ACTION_PATTERN.lastIndex = searchFrom;
    const match = DEVELOP_ACTION_PATTERN.exec(content);

    if (!match || match.index === undefined) {
      break;
    }

    const tool = match[1] as DevelopTool;
    const openParenIndex = match.index + match[0].length - 1;
    const closeParenIndex = findBalancedClose(content, openParenIndex);

    if (closeParenIndex === -1) {
      break;
    }

    let arg = content.slice(openParenIndex + 1, closeParenIndex).trim();

    if ((arg.startsWith('"') && arg.endsWith('"')) || (arg.startsWith("'") && arg.endsWith("'"))) {
      arg = arg.slice(1, -1);
    }

    searchFrom = closeParenIndex + 1;

    if (tool === "write_file" || tool === "edit_file") {
      // Blocks must appear between this ACTION and the next one.
      DEVELOP_ACTION_PATTERN.lastIndex = searchFrom;
      const nextMatch = DEVELOP_ACTION_PATTERN.exec(content);
      const segment = content.slice(searchFrom, nextMatch?.index ?? content.length);

      // Diagnostic detail (2026-07-18, live evidence): a real run hit
      // FORMAT_ERROR 3 turns in a row on the SAME file (i18n index.ts),
      // burning the rest of its budget, with no visibility into what was
      // actually malformed - the generic "missing its content block"
      // message alone did not steer the model right. A short snippet of
      // what the parser actually saw (what came right after the ACTION line)
      // is included in the error now, so both the model AND actionsLog get
      // a concrete "here is what went wrong", not just "something is wrong".
      const segmentSnippet = segment.trim().slice(0, 200).replace(/\n/g, "\\n");

      if (tool === "write_file") {
        const block = extractBlock(segment, "CONTENT");

        if (!block) {
          actions.push({
            tool,
            arg,
            formatError: `write_file(${arg}) is missing a valid "<<<CONTENT" ... "CONTENT>>>" block right after the ACTION line. What followed your ACTION line instead was: "${segmentSnippet}${segment.length > 200 ? "..." : ""}". The markers must be EXACTLY "<<<CONTENT" and "CONTENT>>>", each on their own line, with no extra characters.`,
          });
        } else {
          actions.push({ tool, arg, content: block.value });
          searchFrom += block.endIndex;
        }
      } else {
        const searchBlock = extractBlock(segment, "SEARCH");
        const replaceSegmentStart = searchBlock ? searchBlock.endIndex : 0;
        const replaceBlock = searchBlock ? extractBlock(segment.slice(replaceSegmentStart), "REPLACE") : null;

        if (!searchBlock || !replaceBlock) {
          const whichMissing = !searchBlock ? "the \"<<<SEARCH\" ... \"SEARCH>>>\" block" : "the \"<<<REPLACE\" ... \"REPLACE>>>\" block (SEARCH block was found and parsed fine)";
          actions.push({
            tool,
            arg,
            formatError: `edit_file(${arg}) is missing ${whichMissing}. What followed your ACTION line was: "${segmentSnippet}${segment.length > 200 ? "..." : ""}". The markers must be EXACTLY "<<<SEARCH"/"SEARCH>>>" then "<<<REPLACE"/"REPLACE>>>", each on their own line, immediately after the ACTION line, with no extra characters or reordering.`,
          });
        } else {
          actions.push({ tool, arg, search: searchBlock.value, replace: replaceBlock.value });
          searchFrom += replaceSegmentStart + replaceBlock.endIndex;
        }
      }
    } else {
      actions.push({ tool, arg });
    }

    if (tool === "task_complete" || tool === "ask_user") {
      break;
    }
  }

  // task_complete / ask_user win alone, wherever they appeared in the batch -
  // mixing them with unexecuted tool requests makes no sense.
  const exclusiveIndex = actions.findIndex((action) => action.tool === "task_complete" || action.tool === "ask_user");

  if (exclusiveIndex !== -1) {
    return { actions: [actions[exclusiveIndex] as ParsedDevelopAction], droppedActionCount: 0 };
  }

  // Count the ACTION lines the cap left unexecuted (see ParsedDevelopTurn).
  let droppedActionCount = 0;
  DEVELOP_ACTION_PATTERN.lastIndex = searchFrom;

  while (DEVELOP_ACTION_PATTERN.exec(content)) {
    droppedActionCount += 1;
  }

  return { actions, droppedActionCount };
}

function formatVerificationJournal(entries: DevelopVerificationEntry[]): string {
  if (entries.length === 0) {
    return "(the author ran no verification commands)";
  }

  return entries
    .map((entry) => `$ ${entry.command}\nexit code ${entry.exitCode} (${Math.round(entry.durationMs / 1000)}s)\n${entry.output.slice(0, 1500)}`)
    .join("\n\n");
}

// Live evidence (2026-07-18): a repetition-loop reviewer response listed
// items like "missing check for X - used correctly"/"missing Y - not
// required" over a hundred times, each one admitting in its own text that
// there is no actual problem. A finding is not a finding if it says so
// itself - this is a text-pattern filter, not a request for the model to
// behave differently (see docs/architecture/011 §1: "нельзя полагаться на
// послушание модели"). Capped as a hard backstop too, in case a genuine
// diff somehow has more real findings than any diff this size plausibly
// would - the fix-round conversation already handles a long findings list
// poorly regardless of whether each one is real.
const SELF_CONTRADICTING_FINDING_PATTERN = /это корректно|используется корректно|это нормально|не является ошибкой|не является блокирующ|проблем(?:ы)? нет|не требуется\.?\s*$|не обязательно(?:\.|\s*$)|эквивалентно\.?\s*$|по умолчанию.{0,20}(?:это нормально|нормально)\.?\s*$/i;
const MAX_REVIEWER_FINDINGS = 10;

function filterSelfContradictingFindings(findings: string[]): string[] {
  return findings.filter((finding) => !SELF_CONTRADICTING_FINDING_PATTERN.test(finding)).slice(0, MAX_REVIEWER_FINDINGS);
}

function normalizeFindingKey(finding: string): string {
  return finding
    .toLowerCase()
    .replace(/^(blocker|note)\s*:\s*/i, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function splitFindingsBySeverity(findings: string[]): { blockers: string[]; notes: string[] } {
  const blockers: string[] = [];
  const notes: string[] = [];

  for (const finding of findings) {
    const trimmed = finding.trim();

    if (/^note\s*:/i.test(trimmed)) {
      notes.push(trimmed.replace(/^note\s*:\s*/i, "").trim());
      continue;
    }

    if (/^blocker\s*:/i.test(trimmed)) {
      blockers.push(trimmed.replace(/^blocker\s*:\s*/i, "").trim());
      continue;
    }

    blockers.push(trimmed);
  }

  return { blockers, notes };
}

const NON_BLOCKING_REVIEWER_FALLBACK_PATTERN = /(?:\bслово\b|\bформулировк|\bформулировка\b|\bтекст\b|\bкопирайт|\bcopy\b|\bcopywriting\b|\bстилист|\bграммат|\bопечатк|\bперевод\b|\bлокализац|\bназван(?:ие|ия)\b|\bнаименован|\bлучше\b|\bстоит\b|\bпредпочтительн|\bболее корректн|\bнеестественн|\bчитабельн|\bфраз|\bтермин\b|\bлишн(?:ее|яя|ий)\b|\bбессмысленн|\bничего не меняй\b)/i;
const STRONG_BLOCKER_SIGNAL_PATTERN = /(?:runtime|рантайм|фатальн|упад[её]т|слом|ошибк|exception|undefined|не сработает|не работает|неверн|неправильн|missing|отсутствует|не созда[её]т|не обновля[её]т|не сохраня[её]т|не ловит|validation|валидац|migration|миграц|schema|колонк|column|database|бд|sql|данн|caller|dependen|совместим|регрес|broken|bug|дефект|не тот файл|не ту|не там|не выполняет задачу|частично|only part|не покрывает задачу|wrong place|не в том месте)/i;

function downgradeSoftBlockers(blockers: string[], notes: string[]): { blockers: string[]; notes: string[] } {
  const keptBlockers: string[] = [];
  const extraNotes: string[] = [];

  for (const finding of blockers) {
    const looksSoft = NON_BLOCKING_REVIEWER_FALLBACK_PATTERN.test(finding);
    const looksStrong = STRONG_BLOCKER_SIGNAL_PATTERN.test(finding);

    if (looksSoft && !looksStrong) {
      extraNotes.push(finding);
      continue;
    }

    keptBlockers.push(finding);
  }

  return { blockers: keptBlockers, notes: [...notes, ...extraNotes] };
}

function dedupeNotes(findings: string[]): string[] {
  return findings.filter((finding, index, list) => {
    const key = normalizeFindingKey(finding);
    return key && list.findIndex((item) => normalizeFindingKey(item) === key) === index;
  });
}

// Live evidence (2026-07-18): round 1 disputed a NOT-NULL claim on a column
// ("Laravel's $table->string() is NOT NULL by default, this is correct as
// written"); round 2 restated the SAME claim as "поле не имеет ограничения
// NOT NULL" (round 1 had said "не имеет ограничения") - different enough
// wording that normalizeFindingKey produced different keys, so the exact
// match below missed it and the disputed claim got re-blocked anyway. The
// semantic fallback exists specifically for this: an LLM naturally
// paraphrases, so a string-only repeat check will always miss some real
// repeats. Checked ONLY against disputedLines (not all of priorRound's
// findings) - a finding that matches a FIXED (non-disputed) prior finding
// reappearing is a legitimate "the fix didn't actually work" signal and
// must stay a blocker; only a match against something the author explicitly
// disputed is safe to demote.
//
// Threshold calibrated (2026-07-18) against real embeddings before ever
// running this through the full pipeline: the qwen3-embedding-8b cosine
// similarity of the ACTUAL observed same-claim pair above was only 0.83 -
// an initial 0.87 guess would have missed the exact case this exists for.
// A different-but-related-topic pair ("missing NOT NULL" vs "missing
// index", same table) scored 0.62, and a totally unrelated pair scored
// 0.45 - 0.75 sits with real margin above the false-positive risk (0.62)
// and below the genuine match (0.83).
const SEMANTIC_REPEAT_THRESHOLD = 0.75;

async function suppressRepeatedRoundTwoBlockers(
  blockers: string[],
  priorRound?: DevelopReviewRound,
  authorDisputeSummary?: string,
  computeFindingSimilarity?: (candidateFinding: string, comparisonTexts: string[]) => Promise<number>,
): Promise<{ blockers: string[]; notes: string[] }> {
  if (!priorRound || blockers.length === 0) {
    return { blockers, notes: [] };
  }

  const priorKeys = new Set(priorRound.findings.map(normalizeFindingKey));
  const disputedLines = extractSummaryChunks(authorDisputeSummary ?? "");
  const disputedKeys = new Set(disputedLines.map(normalizeFindingKey));
  const keptBlockers: string[] = [];
  const demotedNotes: string[] = [];

  for (const finding of blockers) {
    const key = normalizeFindingKey(finding);
    const isExactRepeat = key && priorKeys.has(key);
    const wasExactlyDisputed = key && disputedKeys.has(key);

    if (isExactRepeat && wasExactlyDisputed) {
      demotedNotes.push(`Повторно заявленная находка после оспаривания: ${finding}`);
      continue;
    }

    if (computeFindingSimilarity && disputedLines.length > 0) {
      try {
        const similarity = await computeFindingSimilarity(finding, disputedLines);

        if (similarity >= SEMANTIC_REPEAT_THRESHOLD) {
          demotedNotes.push(`Повторно заявленная находка после оспаривания (перефразировано): ${finding}`);
          continue;
        }
      } catch {
        // Best-effort - a similarity-check failure just falls through to
        // keeping the finding as a blocker, same as if it were never called.
      }
    }

    keptBlockers.push(finding);
  }

  return { blockers: keptBlockers, notes: demotedNotes };
}

// Live evidence (2026-07-18, three separate failed attempts): trying to
// recognize a "dispute" by keyword/tag kept losing to the Developer's own
// formatting variance - a plain numbered-list item with no "Оспорено:" tag
// at all; a "**Оспорено:**" SECTION HEADER with the actual reasoning in
// bullet points below it, not on that line; phrasing like "было бы
// неконсистентным и избыточным" that no fixed keyword list anticipates.
// Matching natural-language disagreement by regex is a losing game - an
// LLM has effectively unlimited ways to phrase the same disagreement.
// Gave up on trying to classify WHICH parts of the summary are "disputes"
// at all - instead this just splits the whole summary into paragraph/
// bullet-sized chunks (a much more reliable STRUCTURAL signal than
// dispute-specific vocabulary) and lets the semantic-similarity threshold
// in suppressRepeatedRoundTwoBlockers do the actual relevance judgment.
// Known residual risk, accepted deliberately: this can no longer
// distinguish "the author disputed this" from "the author described
// fixing this" - a genuine "the fix didn't actually work" re-block could
// theoretically get suppressed if its embedding happens to be close to the
// fix-description text. Live evidence today was 3-for-3 the other way
// (real repeats missed, zero false suppressions observed) - revisit if
// that ever flips.
function extractSummaryChunks(summary: string): string[] {
  const paragraphs = summary.split(/\n\s*\n/).map((paragraph) => paragraph.trim()).filter(Boolean);
  const chunks: string[] = [];

  for (const paragraph of paragraphs) {
    const lines = paragraph.split("\n").map((line) => line.trim()).filter(Boolean);
    const hasListMarkers = lines.some((line) => /^[-•*]\s|^\d+\.\s/.test(line));

    if (!hasListMarkers) {
      chunks.push(paragraph);
      continue;
    }

    let current = "";

    for (const line of lines) {
      if (/^[-•*]\s|^\d+\.\s/.test(line)) {
        if (current) {
          chunks.push(current.trim());
        }

        current = line;
      } else {
        current += ` ${line}`;
      }
    }

    if (current) {
      chunks.push(current.trim());
    }
  }

  return chunks.filter((chunk) => chunk.length >= 15);
}

async function callReviewer(input: {
  reviewerModel: string;
  providerBaseUrl: string;
  providerApiKey: string;
  task: string;
  diff: string;
  changedFiles: string[];
  verificationLog: DevelopVerificationEntry[];
  /** Deterministic structural-dependents block (see DevelopRunOptions.computeImpactPreview) - grounds finding (2) in real graph data. */
  impactPreview?: string;
  priorRound?: DevelopReviewRound;
  authorDisputeSummary?: string;
  computeFindingSimilarity?: (candidateFinding: string, comparisonTexts: string[]) => Promise<number>;
}): Promise<{ round: DevelopReviewRound | null; promptTokens: number; completionTokens: number; unavailableReason?: string }> {
  const boundedDiff = input.diff.length > MAX_REVIEW_DIFF_CHARS
    ? `${input.diff.slice(0, MAX_REVIEW_DIFF_CHARS)}\n... (diff truncated at ${MAX_REVIEW_DIFF_CHARS} chars - flag this if the visible part alone cannot justify approval)`
    : input.diff;
  const messages: ChatMessage[] = [
    { role: "system", content: REVIEWER_SYSTEM_PROMPT },
    {
      role: "user",
      content: [
        `Task: ${input.task}`,
        ...(touchesSchema(input.changedFiles) ? ["", SCHEMA_REVIEW_ADDENDUM] : []),
        "",
        "Verification journal:",
        formatVerificationJournal(input.verificationLog),
        // Live evidence (2026-07-18): with the OLD framing ("previous
        // blockers from the prior round"), the model would re-emit the same
        // blockers verbatim even when the diff below (the CURRENT, updated
        // version) clearly already contained the fix - it looks like
        // anchoring on its own prior conclusion instead of freshly
        // re-checking. Reframed as another reviewer's pass over an OLDER
        // snapshot, with an explicit instruction to verify against the diff
        // you are ACTUALLY given below, not to trust the list on faith.
        ...(input.priorRound
          ? [
              "",
              "A reviewer pass over an EARLIER, now-superseded version of this diff (before the author's latest changes) raised these points - they may or may not still apply, you must check the CURRENT diff below yourself, do not assume any of them are still true just because they were raised before:",
              ...(input.priorRound.findings.length ? input.priorRound.findings.map((finding, index) => `${index + 1}. ${finding}`) : ["(none)"]),
            ]
          : []),
        ...(input.authorDisputeSummary
          ? [
              "",
              "The author's response to that earlier pass (fixes made and/or points disputed as wrong):",
              input.authorDisputeSummary,
            ]
          : []),
        ...(input.priorRound
          ? [
              "",
              "Before repeating ANY point from that earlier pass, find the specific text in the CURRENT diff below that still shows the problem. If you cannot point to it, the issue is resolved - do not report it again.",
            ]
          : []),
        ...(input.impactPreview
          ? ["", "Structural impact (deterministic, from the project's dependency graph - not the author's claim): who actually depends on the changed files:", input.impactPreview]
          : []),
        "",
        "Unified diff of the change:",
        boundedDiff,
      ].join("\n"),
    },
  ];

  try {
    const { content, usage } = await callModel(input.providerBaseUrl, input.providerApiKey, input.reviewerModel, messages);
    const trimmed = content.trim();
    const approved = /^APPROVED\b/i.test(trimmed);
    const rawFindings = approved
      ? []
      : trimmed
        .replace(/^NEEDS_CHANGES:?/i, "")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => /^\d+[.)]/.test(line) || /^[-•]/.test(line))
        .map((line) => line.replace(/^\d+[.)]\s*/, "").replace(/^[-•]\s*/, ""));
    // Live evidence (task-decomposition test, 2026-07-18): a correct 4-file
    // Laravel migration+model diff got a NEEDS_CHANGES verdict from a
    // reviewer response that degenerated into 100+ near-duplicate items
    // like "missing check for X - used correctly", each one self-admitting
    // there is no actual problem, running until it hit the completion token
    // limit mid-sentence. This is a decoding repetition-loop failure mode,
    // not the model finding real issues - deterministic filtering doesn't
    // rely on the model not doing this again. A finding whose own text
    // already says the thing IS correct/not required is not a finding.
    const filteredFindings = filterSelfContradictingFindings(rawFindings);
    const { blockers, notes } = splitFindingsBySeverity(filteredFindings);
    const severityAdjusted = downgradeSoftBlockers(blockers, notes);
    const priorKeys = new Set((input.priorRound?.findings ?? []).map(normalizeFindingKey));
    const dedupedBlockers = severityAdjusted.blockers.filter((finding, index, list) => {
      const key = normalizeFindingKey(finding);
      return key && list.findIndex((item) => normalizeFindingKey(item) === key) === index;
    });
    const dedupedNotes = severityAdjusted.notes.filter((finding, index, list) => {
      const key = normalizeFindingKey(finding);
      return key && list.findIndex((item) => normalizeFindingKey(item) === key) === index;
    });
    const repeatedAdjusted = await suppressRepeatedRoundTwoBlockers(
      dedupedBlockers,
      input.priorRound,
      input.authorDisputeSummary,
      input.computeFindingSimilarity,
    );
    const roundTwoRepeatedNotes = dedupeNotes((input.priorRound
      ? dedupedNotes.filter((finding) => !priorKeys.has(normalizeFindingKey(finding)))
      : dedupedNotes).concat(repeatedAdjusted.notes));

    return {
      round: {
        verdict: approved ? "approved" : repeatedAdjusted.blockers.length > 0 ? "needs-changes" : "approved",
        noteFindings: roundTwoRepeatedNotes,
        // A non-APPROVED reply with no parseable numbered findings still
        // carries its message - keep the raw text as the single finding
        // rather than silently approving a rejection.
        findings: approved ? [] : (repeatedAdjusted.blockers.length > 0 ? repeatedAdjusted.blockers : filteredFindings.length > 0 ? [] : [trimmed]),
        raw: trimmed,
      },
      promptTokens: usage?.prompt_tokens ?? 0,
      completionTokens: usage?.completion_tokens ?? 0,
    };
  } catch (error) {
    // Reviewer being unavailable must not deadlock the run - the diff is
    // still delivered, honestly marked as not reviewed (the human merges by
    // hand in v1 anyway).
    return {
      round: null,
      promptTokens: 0,
      completionTokens: 0,
      unavailableReason: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function runDevelopmentTask(options: DevelopRunOptions): Promise<DevelopRunResult> {
  const maxTurns = options.maxTurns ?? DEFAULT_DEVELOP_CEILING_TURNS;
  const isMultiRoot = options.projectRoots.length > 1;
  const microCopyTask = isMicroCopyTask(options.task);
  const projectLine = isMultiRoot
    ? `Project parts: ${options.projectRoots.map((root) => `${root.label} (${root.role})`).join(", ")}`
    : `Project: ${options.projectRoots[0]?.absolutePath ?? ""}`;
  const priorIterationBlock = options.priorIteration
    ? [
      "",
      options.priorIteration.worktreeCarriesChanges
        ? `CONTEXT: this worktree ALREADY CONTAINS changes you delivered earlier in this conversation for the task: "${options.priorIteration.task}". Your summary of that work was: "${options.priorIteration.summary.slice(0, 800)}". The task above is the user's REVIEW FEEDBACK on that delivered result - re-read the files you changed, adjust the existing implementation accordingly (do not start from scratch, do not blindly revert), and remember the final diff is cumulative against the original baseline.`
        : `CONTEXT: earlier in this conversation you worked on the task "${options.priorIteration.task}" (summary: "${options.priorIteration.summary.slice(0, 800)}"), but that iteration's changes are NOT in this worktree - it starts from a clean baseline. The task above continues that conversation; implement it fully here.`,
    ]
    : [];
  // Bug fix (2026-07-18, live test): the FIRST version of this block only
  // rendered exitCode, never the command's actual output - a resumed run
  // after an approved "migrate:status" had no way to know WHICH migrations
  // were pending (the whole point of running it) and correctly, but
  // unhelpfully, asked the user to clarify instead. Output is exactly the
  // point of showing this at all.
  const sensitiveActionsBlock = options.priorSensitiveActions?.length
    ? [
      "",
      "Sensitive DB commands already approved and executed earlier in this conversation (for context, e.g. if the task above asks you to undo/revert one of them - resolve which one from this list, do not guess):",
      ...options.priorSensitiveActions.flatMap((action, index) => [
        `${index + 1}. $ ${action.command} (${action.reason}) - ${action.status}${action.exitCode !== undefined ? `, exit ${action.exitCode}` : ""}`,
        ...(action.output ? [`   Output:\n${action.output.slice(0, 2000).split("\n").map((line) => `   ${line}`).join("\n")}`] : []),
      ]),
    ]
    : [];
  const messages: ChatMessage[] = [
    { role: "system", content: buildDevelopSystemPrompt(Boolean(options.semanticSearch), isMultiRoot, Boolean(options.findReferences), Boolean(options.dbQuery)) },
    {
      role: "user",
      content: [
        projectLine,
        `Task: ${options.task}`,
        ...(microCopyTask
          ? [
              "",
              "MICRO-COPY MODE: this is a narrow text-edit task, not a feature task.",
              "- First prove the exact target line(s): grep the literal word(s), then read only the file that contains the user-facing text you plan to change.",
              "- Change the MINIMUM possible surface: ideally one string literal / one line. If two nearby strings contain the same English word, do NOT change both unless the task text explicitly requires both.",
              "- If the user said \"больше ничего не меняй\" or similar, treat any extra text change as suspicious by default and keep it out unless you can point to the exact words in the task that require it.",
              "- For verification, prefer grep/sed on the exact lines you changed and explicitly confirm that neighboring text stayed the same.",
            ]
          : []),
        ...priorIterationBlock,
        ...sensitiveActionsBlock,
        ...(options.observerHint ? ["", options.observerHint] : []),
      ].join("\n"),
    },
  ];

  const seedGrepObservation = await buildSeedGrepObservation(options.projectRoots, options.task, []);

  if (seedGrepObservation) {
    messages.push({ role: "user", content: seedGrepObservation });
  }

  // Auto-read seed (2026-07-18, ported from loop.ts - see
  // DevelopRunOptions.semanticSeedFiles's docstring): content of the top
  // semantic matches goes straight into pre-turn context. Unlike research's
  // version, seed files here are added DIRECTLY to touchedFiles (not a
  // separate conditionally-promoted set) - touchedFiles has a load-bearing
  // functional role for Developer (it gates edit_file), so a seed-read file
  // must be immediately editable without an extra read_file round-trip,
  // which is the whole point of the optimization.
  const seedReadFiles = new Set<string>();

  if (options.semanticSeedFiles) {
    try {
      const seedPaths = (await options.semanticSeedFiles(options.task)).slice(0, 3);
      const seedBlocks: string[] = [];

      for (const seedPath of seedPaths) {
        const content = await readFile(options.projectRoots, seedPath, DEVELOP_READ_FILE_CHARS);

        if (!content.startsWith("Error")) {
          const normalized = toWorkspaceRelativePath(options.projectRoots, seedPath);
          seedReadFiles.add(normalized);
          const bounded = content.length > MAX_OBSERVATION_CHARS
            ? `${content.slice(0, MAX_OBSERVATION_CHARS)}\n... (truncated)`
            : content;
          seedBlocks.push(`FILE ${normalized}:\n${bounded}`);
        }
      }

      if (seedBlocks.length > 0) {
        messages.push({
          role: "user",
          content: [
            "The most semantically relevant files have been read for you in advance (same as read_file output) - they now count as read, you can edit_file them directly without re-requesting. If they already tell you what you need - act on them right away instead of re-reading; if not, research as usual:",
            ...seedBlocks,
          ].join("\n\n---\n\n"),
        });
      }
    } catch {
      // Seed pre-reads are an optimization, never a dependency.
    }
  }

  if (options.knownFactsHint) {
    messages.push({ role: "user", content: options.knownFactsHint });
  }

  // Context compaction (iteration 5 evidence, 2026-07-18): raw message
  // history was found to be the REAL driver behind DEVELOP_TOKEN_SAFETY_LIMIT
  // aborts, not completion truncation - a real run hit 974K prompt tokens by
  // turn 32 purely from carrying every past turn's full observations
  // (up to DEVELOP_READ_FILE_CHARS=24_000 chars per read_file) forward
  // forever. actionsLog already IS a compact, complete one-line-per-action
  // record of the whole run - once history grows past a trigger size, older
  // raw turns are collapsed into a single synthetic message built from
  // actionsLog, while the most recent turns stay verbatim for immediate
  // continuity. touchedFiles/editedFiles gating lives in JS state, not in
  // message history, so this cannot corrupt edit eligibility - a model that
  // needs an old file's current content just re-reads it (same recovery
  // path the stuck-detector already relies on).
  const seedMessageCount = messages.length;
  const HISTORY_COMPACT_TRIGGER_MESSAGES = 50;
  const HISTORY_KEEP_RECENT_MESSAGES = 24;
  let historyCompactionMessageIndex = -1;

  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  const actionsLog: string[] = [...[...seedReadFiles].map((filePath) => `[seed] auto-read ${filePath}`)];
  const touchedFiles = new Set<string>([...seedReadFiles]);
  const editedFiles = new Set<string>();
  const editFailuresByFile = new Map<string, number>();
  const seenDirs = new Set<string>([normalizeDirKey("."), ...[...seedReadFiles].map((filePath) => dirnameOf(filePath))]);
  const grepTermsSeen = new Set<string>();
  const verificationLog: DevelopVerificationEntry[] = [];
  const reviews: DevelopReviewRound[] = [];
  const sensitiveActions: DevelopSensitiveAction[] = [...(options.priorSensitiveActions ?? [])];
  let latestDiff = "";
  let latestChangedFiles: string[] = [];
  let phase: "developing" | "reviewing" | "fixing" = "developing";
  let zeroMutationBounceSent = false;
  let zeroVerificationBounceSent = false;
  let noActionStreak = 0;
  let stuckTurns = 0;
  let stuckNudgeSent = false;
  let lastSurfaceSize = touchedFiles.size + seenDirs.size + grepTermsSeen.size + editedFiles.size;

  const finalize = async (
    overrides: Partial<DevelopRunResult> & Pick<DevelopRunResult, "turnsUsed" | "stopped">,
  ): Promise<DevelopRunResult> => {
    // Live evidence (2026-07-18): every non-task_complete exit (max_turns,
    // token safety abort, error, aborted, needs-clarification) used to
    // return latestDiff/latestChangedFiles as whatever they last were -
    // which is "" / [] unless the model had ALREADY called task_complete at
    // least once, since collectDiff() was only ever invoked from
    // evaluateTaskComplete. A real run that DID successfully edit files
    // (editedFiles.size > 0, confirmed live via onProgress's filesChanged)
    // but then ran out of turn/token budget before calling task_complete
    // reported an EMPTY diff - and develop-runner.ts then deletes the
    // worktree entirely when the diff is empty, permanently discarding real,
    // successfully-applied work. Best-effort recovery: if edits happened but
    // no diff was ever collected, collect it now so the caller gets the
    // actual state of the worktree instead of a false "nothing happened".
    if (editedFiles.size > 0 && !latestDiff.trim() && overrides.stopped !== "task_complete") {
      try {
        const collected = await options.collectDiff();
        latestDiff = collected.diff;
        latestChangedFiles = collected.changedFiles;
      } catch {
        // Worktree may already be gone/unreachable - report what we know
        // (editedFiles) rather than crash the whole finalize path.
      }
    }

    return {
      summary: null,
      clarificationQuestion: null,
      pendingApproval: null,
      sensitiveActions,
      diff: latestDiff,
      changedFiles: latestChangedFiles,
      verificationLog,
      reviews,
      reviewVerdict: "not-run",
      touchedFiles: [...touchedFiles],
      actionsLog,
      totalPromptTokens,
      totalCompletionTokens,
      ...overrides,
    };
  };

  async function evaluateTaskComplete(summary: string, turn: number): Promise<DevelopRunResult | "continue-loop"> {
    if (editedFiles.size === 0 && !zeroMutationBounceSent && turn < maxTurns - 5) {
      zeroMutationBounceSent = true;
      actionsLog.push(`[turn ${turn}] task_complete bounced: zero files changed.`);
      messages.push({
        role: "user",
        content: "You are declaring the task complete without having changed a single file. If the task genuinely requires no code change, explain exactly why in a new task_complete. Otherwise, implement it first.",
      });
      return "continue-loop";
    }

    if (editedFiles.size > 0 && verificationLog.length === 0 && !zeroVerificationBounceSent && turn < maxTurns - 3) {
      // Deterministic gate, one bounce max (2026-07-17, first E2E run: the
      // developer claimed "проверено npm run check" while the journal was
      // empty - the command had been silently dropped by the action cap and
      // the model never noticed). If the project genuinely has nothing
      // runnable, the model states that in its next summary and proceeds.
      zeroVerificationBounceSent = true;
      actionsLog.push(`[turn ${turn}] task_complete bounced: files changed but zero verification commands were run.`);
      messages.push({
        role: "user",
        content: "You changed files but ran NO verification command this run (the journal the reviewer sees is empty). Run the project's own checks via run_command (tests/linter/build, or at minimum a syntax check) - or, if this project truly has nothing runnable, say so explicitly in your summary - then call task_complete again.",
      });
      return "continue-loop";
    }

    const collected = await options.collectDiff();
    latestDiff = collected.diff;
    latestChangedFiles = collected.changedFiles;

    if (!latestDiff.trim()) {
      actionsLog.push(`[turn ${turn}] task_complete with empty diff - delivered without review.`);
      return finalize({ turnsUsed: turn, stopped: "task_complete", summary, reviewVerdict: "not-run" });
    }

    phase = "reviewing";
    options.onProgress?.({ turn, filesChanged: latestChangedFiles.length, phase });

    const reviewResult = await callReviewer({
      reviewerModel: options.reviewerModel,
      providerBaseUrl: options.providerBaseUrl,
      providerApiKey: options.providerApiKey,
      task: options.task,
      diff: latestDiff,
      changedFiles: latestChangedFiles,
      verificationLog,
      ...(options.computeImpactPreview ? { impactPreview: options.computeImpactPreview([...editedFiles]) } : {}),
      ...(reviews.length > 0 ? { priorRound: reviews[reviews.length - 1] } : {}),
      ...(reviews.length > 0 && summary ? { authorDisputeSummary: summary } : {}),
      ...(options.computeFindingSimilarity ? { computeFindingSimilarity: options.computeFindingSimilarity } : {}),
    });
    totalPromptTokens += reviewResult.promptTokens;
    totalCompletionTokens += reviewResult.completionTokens;

    if (!reviewResult.round) {
      actionsLog.push(`[turn ${turn}] reviewer unavailable (${reviewResult.unavailableReason ?? "unknown"}) - delivered without review.`);
      return finalize({ turnsUsed: turn, stopped: "task_complete", summary, reviewVerdict: "not-run" });
    }

    reviews.push(reviewResult.round);
    actionsLog.push(`[turn ${turn}] reviewer: ${reviewResult.round.verdict.toUpperCase()}${reviewResult.round.findings.length ? ` (${reviewResult.round.findings.length} findings)` : ""}`);

    if (reviewResult.round.verdict === "approved") {
      return finalize({ turnsUsed: turn, stopped: "task_complete", summary, reviewVerdict: "approved" });
    }

    if (reviews.length >= MAX_REVIEW_ROUNDS || turn >= maxTurns) {
      // Second rejection (or budget edge) is final - a human decides now,
      // not a third loop iteration (011: "двойной провал -> человек").
      return finalize({ turnsUsed: turn, stopped: "task_complete", summary, reviewVerdict: "needs-changes" });
    }

    phase = "fixing";
    messages.push({
      role: "user",
      content: [
        "An independent reviewer examined your diff and returned these findings:",
        ...reviewResult.round.findings.map((finding, index) => `${index + 1}. ${finding}`),
        ...(reviewResult.round.noteFindings.length
          ? [
              "",
              "Non-blocking notes from the reviewer (do not expand scope just to satisfy them; fix only if they are genuinely cheap and directly relevant):",
              ...reviewResult.round.noteFindings.map((finding, index) => `${index + 1}. ${finding}`),
            ]
          : []),
        "",
        "Address each finding: fix the ones that are real (then re-verify with run_command where relevant) and call task_complete again. If a finding is factually wrong, do NOT change code for it - explain why in the new summary under a line starting with \"Оспорено:\". This is the final review round.",
        // Live evidence (debugger-flow test, 2026-07-18): a 1-line bug fix got
        // a legitimate "no acceptance evidence, only mocks" finding, and the
        // response spiraled into rewriting THREE unrelated model files and
        // building new test factories from scratch to reach a full DB-backed
        // integration test - burned 25+ turns chasing test infrastructure and
        // never got back to task_complete. A test-coverage finding is real,
        // but the RESPONSE size must stay proportionate to the ORIGINAL
        // change size, not to how thorough testing could theoretically be.
        "A finding about missing/weak test coverage does NOT license expanding scope: do not modify application files (models, unrelated services) that were not already in your diff just to make a test possible, and do not build new test factories/migrations from scratch for a small fix. Prefer strengthening the test with what already exists in the project. If closing the gap properly would require infrastructure disproportionate to the size of your actual change, keep the existing (even if imperfect) verification and dispute the ask as disproportionate under \"Оспорено:\" instead of chasing it - a proportionate, imperfect test that ships beats a perfect one that never finishes.",
      ].join("\n"),
    });
    return "continue-loop";
  }

  function compactHistoryIfNeeded(): void {
    if (messages.length - seedMessageCount <= HISTORY_COMPACT_TRIGGER_MESSAGES) {
      return;
    }

    const keepFromIndex = messages.length - HISTORY_KEEP_RECENT_MESSAGES;

    if (keepFromIndex <= seedMessageCount) {
      return;
    }

    const summaryContent = [
      "Сводка более ранних ходов этого прогона (полные сообщения этих ходов удалены из контекста, чтобы разговор не рос бесконечно - если нужно текущее содержимое файла, перечитай его через read_file, не полагайся на память о его прошлом содержимом):",
      ...actionsLog,
    ].join("\n");

    if (historyCompactionMessageIndex === -1) {
      messages.splice(seedMessageCount, keepFromIndex - seedMessageCount, { role: "user", content: summaryContent });
      historyCompactionMessageIndex = seedMessageCount;
    } else {
      messages[historyCompactionMessageIndex] = { role: "user", content: summaryContent };
      messages.splice(historyCompactionMessageIndex + 1, keepFromIndex - (historyCompactionMessageIndex + 1));
    }
  }

  for (let turn = 1; turn <= maxTurns; turn += 1) {
    compactHistoryIfNeeded();

    if (options.shouldAbort?.()) {
      actionsLog.push(`[turn ${turn}] ABORTED by caller.`);
      return finalize({ turnsUsed: turn, stopped: "aborted" });
    }

    options.onProgress?.({ turn, filesChanged: editedFiles.size, phase });

    let content: string;

    try {
      const result = await callModel(options.providerBaseUrl, options.providerApiKey, options.developerModel, messages);
      content = result.content;
      totalPromptTokens += result.usage?.prompt_tokens ?? 0;
      totalCompletionTokens += result.usage?.completion_tokens ?? 0;
    } catch (error) {
      return finalize({ turnsUsed: turn, stopped: "error", error: error instanceof Error ? error.message : String(error) });
    }

    if (totalPromptTokens + totalCompletionTokens >= DEVELOP_TOKEN_SAFETY_LIMIT) {
      actionsLog.push(`[turn ${turn}] SAFETY ABORT: run exceeded ${DEVELOP_TOKEN_SAFETY_LIMIT} tokens.`);
      return finalize({ turnsUsed: turn, stopped: "max_turns" });
    }

    messages.push({ role: "assistant", content });
    const { actions, droppedActionCount } = parseDevelopActions(content);

    if (actions.length === 0) {
      noActionStreak += 1;
      actionsLog.push(`[turn ${turn}] NO ACTION PARSED. raw content: ${content.slice(0, 200)}`);

      if (noActionStreak >= 3) {
        // Three protocol-free replies in a row - the model is not going to
        // recover; treat the last one as its de-facto summary and let the
        // normal completion path (diff collection + review) judge the work.
        const verdict = await evaluateTaskComplete(content.trim(), turn);
        return verdict === "continue-loop" ? finalize({ turnsUsed: turn, stopped: "max_turns" }) : verdict;
      }

      messages.push({
        role: "user",
        content: "No ACTION line was parsed from your reply. Use the exact protocol: ACTION: tool(argument) - with write_file/edit_file blocks where required. If you are done, use ACTION: task_complete(summary in Russian).",
      });
      continue;
    }

    noActionStreak = 0;

    const first = actions[0] as ParsedDevelopAction;

    if (first.tool === "ask_user") {
      actionsLog.push(`[turn ${turn}] ask_user`);
      return finalize({ turnsUsed: turn, stopped: "needs-clarification", clarificationQuestion: first.arg });
    }

    if (first.tool === "task_complete") {
      actionsLog.push(`[turn ${turn}] task_complete (proposed)`);
      const verdict = await evaluateTaskComplete(first.arg, turn);

      if (verdict === "continue-loop") {
        continue;
      }

      return verdict;
    }

    const observationBlocks: string[] = [];

    for (const action of actions) {
      let observation: string;
      let skipTruncation = false;

      if (action.formatError) {
        observation = `Error: ${action.formatError}`;
      } else if (action.tool === "list_dir") {
        observation = await listDir(options.projectRoots, action.arg);
        seenDirs.add(normalizeDirKey(action.arg));
      } else if (action.tool === "grep_content") {
        observation = await grepContent(options.projectRoots, action.arg);
        grepTermsSeen.add(action.arg.toLowerCase());
      } else if (action.tool === "semantic_search") {
        observation = options.semanticSearch
          ? await options.semanticSearch(action.arg)
          : "(semantic search is not available for this project)";
      } else if (action.tool === "find_references") {
        observation = options.findReferences
          ? await options.findReferences(action.arg)
          : "(find_references is not available for this project)";
      } else if (action.tool === "db_query") {
        observation = options.dbQuery
          ? await options.dbQuery(action.arg)
          : "(db_query is not available - no resolvable database connection for this project)";
      } else if (action.tool === "run_command") {
        // DB safety (2026-07-18): a command that mutates persisted
        // schema/data (migrations, seeds, destructive DDL) halts the WHOLE
        // run for human approval instead of executing - git-based rollback
        // cannot undo this class of change, unlike everything else the
        // Developer does inside the throwaway worktree. The orchestrator
        // (develop-runner.ts) executes the EXACT command shown here on
        // approval (not the model re-issuing it) and resumes with the real
        // result in priorSensitiveActions - see DevelopRunOptions.
        if (isSensitiveDbCommand(action.arg)) {
          const reasonMatch = /^([\s\S]*?)(?:\n?ACTION:)/.exec(content);
          const reason = (reasonMatch?.[1] ?? "").trim().slice(0, 300) || "Developer wants to run this as part of the task.";
          const pendingApproval: DevelopSensitiveAction = { command: action.arg, reason, status: "pending" };
          actionsLog.push(`[turn ${turn}] run_command(${action.arg}) -> HALTED for human approval (sensitive DB command).`);
          return finalize({
            turnsUsed: turn,
            stopped: "needs-approval",
            pendingApproval,
            sensitiveActions: [...sensitiveActions, pendingApproval],
          });
        }

        const result = await runShellCommand(options.projectRoots, action.arg);
        verificationLog.push({ ...result, turn });
        observation = `exit code ${result.exitCode} (${Math.round(result.durationMs / 1000)}s)\n${result.output || "(no output)"}`;
      } else if (action.tool === "write_file") {
        observation = await writeFile(options.projectRoots, action.arg, action.content ?? "");

        if (observation.startsWith("OK")) {
          editedFiles.add(toWorkspaceRelativePath(options.projectRoots, action.arg));
        }
      } else if (action.tool === "edit_file") {
        const normalized = toWorkspaceRelativePath(options.projectRoots, action.arg);

        if (!touchedFiles.has(normalized)) {
          // Deterministic guard, mirror of the research loop's list-before-
          // read: an exact-match edit of a file never read THIS run is a
          // guess by construction.
          observation = `Error: you have not read ${action.arg} in this run - read_file it first, then edit based on its actual current content.`;
        } else {
          observation = await editFile(options.projectRoots, action.arg, action.search ?? "", action.replace ?? "");

          if (observation.startsWith("OK")) {
            editedFiles.add(normalized);
            editFailuresByFile.delete(normalized);
          } else {
            const failures = (editFailuresByFile.get(normalized) ?? 0) + 1;

            if (failures >= EDIT_FAILURE_STUCK_THRESHOLD) {
              // Live evidence (2026-07-18, second occurrence on a real Slay
              // run): the original design here EVICTED the file from
              // touchedFiles and INSTRUCTED the model to read_file it again
              // before retrying - but that depends on the model actually
              // complying. It did not: 13 further edit_file attempts against
              // the exact same file followed, with not one intervening
              // read_file call, every one failing identically (permanently
              // walled off, since eviction alone never re-adds the file
              // without a read_file the model never issued). Deterministic
              // fix: do not rely on compliance - auto-fetch the file's
              // CURRENT content and inject it directly into this same
              // observation, so accurate content reaches the model whether
              // or not it "chooses" to re-read.
              editFailuresByFile.delete(normalized);
              const freshContent = await readFile(options.projectRoots, action.arg, DEVELOP_READ_FILE_CHARS);
              observation = `${observation}\n\nSTOP GUESSING: ${failures} attempts against this exact file in a row have all failed to match. Here is its CURRENT actual content (fetched for you automatically) - your next SEARCH block must match this exactly:\n${freshContent}`;
              skipTruncation = true;
            } else {
              editFailuresByFile.set(normalized, failures);
            }
          }
        }
      } else {
        const parentDir = dirnameOf(action.arg);

        if (!seenDirs.has(parentDir)) {
          const dirListing = await listDir(options.projectRoots, parentDir);
          seenDirs.add(normalizeDirKey(parentDir));
          observation = `You asked to read a file in the "${parentDir}" directory, which you have not listed yet - here is its content (a neighboring file with a similar name might be the real place to change); read the file you need as your next action:\n${dirListing}`;
        } else {
          observation = await readFile(options.projectRoots, action.arg, DEVELOP_READ_FILE_CHARS);

          if (!observation.startsWith("Error")) {
            touchedFiles.add(toWorkspaceRelativePath(options.projectRoots, action.arg));
          }
        }
      }

      // Diagnostic detail (2026-07-18): previously every outcome logged
      // identically ("tool(arg) -> N lines"), making a malformed-block
      // formatError indistinguishable from a real editFile/writeFile
      // failure or a successful call - live evidence: a run made ~14
      // consecutive write_file/edit_file "attempts" against one file with
      // ZERO actual changes landing, and there was no way to tell from the
      // log alone whether the model kept sending broken <<<CONTENT/SEARCH
      // blocks or kept guessing wrong content. A short outcome tag costs
      // nothing and turns that guesswork into a fact next time.
      const outcomeTag = action.formatError
        ? "FORMAT_ERROR"
        : observation.startsWith("OK")
          ? "OK"
          : observation.startsWith("Error")
            ? "ERROR"
            : "";
      // FORMAT_ERROR also gets a short snippet of what the model actually
      // sent, right in actionsLog - not just visible to the model in its own
      // next turn - so a stuck run's real cause is a fact in the trace, not
      // a guess during post-mortem (2026-07-18 live evidence: this exact gap
      // cost real diagnosis time).
      const logSnippet = outcomeTag === "FORMAT_ERROR" ? ` — ${observation.slice(0, 220).replace(/\n/g, " ")}` : "";
      actionsLog.push(`[turn ${turn}] ${action.tool}(${action.arg}) -> ${observation.split("\n").length} lines${outcomeTag ? ` [${outcomeTag}]` : ""}${logSnippet}`);

      const boundedObservation = observation.length > MAX_OBSERVATION_CHARS && action.tool !== "read_file" && !skipTruncation
        ? `${observation.slice(0, MAX_OBSERVATION_CHARS)}\n... (truncated)`
        : observation;

      observationBlocks.push(`ACTION ${action.tool}(${action.arg}):\n${boundedObservation}`);
    }

    if (droppedActionCount > 0) {
      actionsLog.push(`[turn ${turn}] ${droppedActionCount} action(s) beyond the per-turn cap were NOT executed.`);
      observationBlocks.push(
        `IMPORTANT: ${droppedActionCount} further ACTION line(s) in your reply were NOT executed - the per-turn limit is ${MAX_ACTIONS_PER_TURN} actions. Their effects did NOT happen (no edits applied, no commands run). Re-issue them now, before anything else.`,
      );
    }

    const observationHeader = observationBlocks.length > 1 ? `OBSERVATIONS (${observationBlocks.length}):\n` : "OBSERVATION:\n";
    messages.push({ role: "user", content: observationHeader + observationBlocks.join("\n\n---\n\n") });

    // General "no progress" detector (2026-07-18) - ported from the research
    // loop's proven mechanism (see STUCK_TURNS_THRESHOLD). editedFiles counts
    // toward progress here (unlike research, which has no write concept) -
    // making real edits is progress even without new exploration.
    const currentSurfaceSize = touchedFiles.size + seenDirs.size + grepTermsSeen.size + editedFiles.size;

    if (currentSurfaceSize === lastSurfaceSize) {
      stuckTurns += 1;
    } else {
      stuckTurns = 0;
      stuckNudgeSent = false;
      lastSurfaceSize = currentSurfaceSize;
    }

    if (stuckTurns >= STUCK_TURNS_HARD_ABORT) {
      actionsLog.push(`[turn ${turn}] SAFETY ABORT: no new directory/file/grep term/edit for ${stuckTurns} turns straight.`);
      return finalize({ turnsUsed: turn, stopped: "max_turns" });
    }

    if (stuckTurns >= STUCK_TURNS_THRESHOLD && !stuckNudgeSent) {
      stuckNudgeSent = true;
      messages.push({
        role: "user",
        content: `${STUCK_TURNS_THRESHOLD} turns in a row now with no new directory/file/search term/edit - it looks like you are stuck (re-reading the same ground) rather than making progress. If you have enough to act, do so now (write_file/edit_file); if you are blocked, call task_complete now describing exactly what is done and what is not, honestly - that is better than continuing to wander in circles.`,
      });
    }
  }

  return finalize({ turnsUsed: maxTurns, stopped: "max_turns" });
}
