import { expandRussianTechTransliteration, tokenize } from "@client/shared";
import { callModel, type ChatMessage, type ProviderUsage } from "./provider.js";
import { dirnameOf, grepContent, listDir, normalizeDirKey, readFile, toWorkspaceRelativePath, type WorkspaceRoot } from "./tools.js";

// Provider call/retry/backoff mechanics (performCall/callModel and their
// constants) moved verbatim to provider.ts (2026-07-17, Developer pipeline) -
// shared with develop-loop.ts, zero behavior change here.

// No turn-count pressure/nudge on purpose (reverted mid-session after live
// testing showed it just pressures models to conclude before they actually
// know enough - worse than an incomplete answer a chat follow-up can finish).
// SAFETY_CEILING_TURNS/RUN_TOKEN_SAFETY_LIMIT exist only to stop a genuinely
// runaway loop, not to shape when the model decides it's done.
const DEFAULT_SAFETY_CEILING_TURNS = 40;
// Live evidence (2026-07-15): two different strong models, asked a genuinely
// wide multi-file business question (CaseData's relation-case flow, 8-10
// legitimately relevant files), both got cut off by this exact ceiling while
// still actively finding new files each turn - not stuck, not runaway, just
// a thorough investigation of a wide feature that needed more room. Raised
// rather than left at the point where it was silently acting as turn-pressure
// on hard questions (the thing this project explicitly does not want) while
// contributing nothing on easy ones, which already converge naturally well
// under the old ceiling (42K-84K tokens observed on the slay-api questions).
const RUN_TOKEN_SAFETY_LIMIT = 450_000;
// Matches tools.ts's MAX_READ_FILE_CHARS (7000) - raising the read cap alone
// without this would just move the same truncation from readFile to here.
const MAX_OBSERVATION_CHARS = 7000;
// Bug fix (2026-07-19, live incident): actionsLog used to record ONLY a
// line count per action ("grep_content(doskey) -> 3 lines") - this is the
// ENTIRE transcript the Critic sees (callCritic's `transcript` is
// actionsLog.join("\n")). The Critic's whole job is checking the final
// answer's claims against what was actually observed, but a line count
// alone can't confirm OR refute any content-level claim - a live case had
// the researcher assert "grep пусто" (no matches) for a term that, in
// reality, WAS present in a file it had itself already opened; the Critic
// had no way to catch this, since actionsLog never told it what the grep
// actually returned. A short content preview per action - not the full
// MAX_OBSERVATION_CHARS text, that would balloon the Critic's own prompt
// across a multi-turn transcript - gives the Critic just enough to spot-
// check a suspicious claim without materially changing token cost.
const ACTIONSLOG_PREVIEW_CHARS = 400;
// Models frequently want to explore several things at once (list a dir, grep
// two terms) - letting them batch several ACTION lines into one turn instead
// of one per round-trip cuts turn count (and the resent-context cost that
// comes with each turn) on exploration-heavy questions. Capped so one turn
// can't balloon into an unbounded batch.
const MAX_ACTIONS_PER_TURN = 4;
// A/B test (2026-07-16, per rout.my docs confirming this parameter is
// accepted and has a real latency effect): applies only to the Researcher's
// own turn-by-turn tool-selection calls in this loop, never to the critic
// (kept at full effort - it is the quality gate) and never to the final
// user-facing answer synthesis prompt (packages/ai, a separate call).
// Turned on (2026-07-23, team-mode latency work): deciding which grep/read
// to do next is a mechanical tool-selection choice, not deep reasoning, and
// the Critic staying at full effort means a worse-judged exploration turn
// just gets rejected and redone (more turns on THAT case) rather than a
// wrong answer slipping through - the safety net this loop exists for is
// unaffected either way. "low" is the conservative end of the documented
// range, not "minimal" - reduce further only after live comparison.
const RESEARCHER_REASONING_EFFORT: string | undefined = "low";

export interface ObserverEntryRef {
  projectRootPath: string;
  unitPath: string;
  /** Full text (summary + mechanisms + gotchas) the researcher was actually shown for this entry - what the Critic compares the final answer against. */
  text: string;
}

export interface AgenticRunOptions {
  task: string;
  /**
   * The physical repo(s) making up this project (2026-07-16, multi-path
   * unification). A single-repo project is just a one-element array - every
   * caller (interactive Researcher, Observer's crawlUnit) goes through this
   * same shape, no branching on repo count anywhere in the loop.
   */
  projectRoots: WorkspaceRoot[];
  researcherModel: string;
  criticModel: string;
  providerBaseUrl: string;
  providerApiKey: string;
  maxTurns?: number;
  /**
   * Deterministic escalation (2026-07-19) - see the runAgenticLoop closure's
   * own comment next to `activeResearcherModel` for the full rationale.
   * Undefined/same-as-researcherModel means escalation never fires, exactly
   * today's behavior.
   */
  researcherEscalationModel?: string;
  /**
   * Checked before every turn - lets a caller (e.g. the Observer background
   * crawler) yield immediately once it returns true, rather than only
   * checking once before the whole run starts. A background crawl and a
   * live interactive question-run share the same provider/API key, so a
   * many-turn background loop can otherwise degrade a real user's request
   * mid-conversation with no way to back off once started.
   */
  shouldAbort?: () => boolean;
  /**
   * Workspace-relative paths of files already read in the PREVIOUS turn of
   * this same conversation (see pipeline-runner.ts's priorConversationTurn).
   * Without this, every follow-up question in an ongoing conversation starts
   * a brand-new loop with no memory of what the last turn already found -
   * live testing showed a 3-turn conversation about the same User model
   * re-discovering (and re-failing to fully read) app/Models/User.php's
   * location on every single turn instead of building on the last one.
   * Seeds seenDirs (so the list-before-read guard doesn't force a redundant
   * listing) and is surfaced to the model as a hint to jump to, not a fact
   * to blindly trust - the question may have moved on to something else.
   */
  priorTurnFiles?: string[];
  /**
   * The PREVIOUS turn's own question text and short answer summary (2026-07-17,
   * bug fix - live evidence: a follow-up like "дай список роутов" [give me a
   * list of routes], with no explicit subject, implicitly meant "routes for
   * Bill Items" [the previous turn's topic] but the model had no textual
   * signal for that - priorTurnFiles only carries bare file paths, never what
   * they were ABOUT - and answered a completely generic, unscoped question
   * instead. This is the missing semantic bridge: unlike priorTurnFiles (a
   * lead to jump to), this tells the model outright what the ongoing topic
   * is, so it can recognize an elliptical follow-up and stay scoped instead
   * of treating every message as a fresh, standalone question.
   */
  priorTurnTopic?: { task: string; summary: string };
  /**
   * Observer's business-graph hint text (pipeline-runner.ts's
   * buildObserverHintSuffix) - kept OUT of `task` on purpose (2026-07-15 bug
   * fix): task flows straight into ResearchReport.task, which the chat UI
   * renders verbatim as "Задача" - concatenating the hint into it leaked
   * Observer's internal "ищи здесь, но проверь" text into the user-visible
   * question. Appended to the LLM-facing message only, same as
   * priorTurnHint below.
   */
  observerHint?: string;
  /**
   * Vision Analyzer's structured read of any screenshots attached to this
   * message (2026-07-19, картинки-в-чате feature) - pipeline-runner.ts's
   * buildAttachmentContextHint. Same "kept OUT of task" reasoning as
   * observerHint just above.
   */
  attachmentHint?: string;
  /**
   * Structured counterpart to observerHint (2026-07-19, architecture review
   * "safety fuse" request): the SAME entries that hint text was built from,
   * kept separately because the hint is just a formatted string with no way
   * back to which specific business_graph_entries row a given claim came
   * from. Lets the Critic compare the final answer against each entry's own
   * text (not just trust the researcher's own paraphrase of it) and, when it
   * finds a genuine contradiction backed by the transcript, name exactly
   * which (projectRootPath, unitPath) row needs a correction written back -
   * see callCritic's CORRECTION[...] reply format below.
   */
  observerEntries?: ObserverEntryRef[];
  /**
   * Short guidance derived from classifying the question's shape (packages/ai's
   * classifyQuestionShape/buildQuestionShapeHint - 2026-07-16, architecture
   * review finding: intent classification existed but never reached the
   * Researcher's own investigation strategy, only the final answer's tone).
   * Empty for a plain "locate" question - only diagnostic/change/compare
   * shapes get an actual hint.
   */
  questionShapeHint?: string;
  /**
   * Symbol names (class/function names, not paths) found by matching task
   * keywords against the FULL persisted code graph (packages/graph, built by
   * background-sync - see apps/api/src/graph-store.ts's
   * findGraphSymbolHints). Precise where a raw content grep for a generic
   * word ("relation") is not: live evidence showed the graph resolving
   * "relation cases" to real symbols like UnlinkRelatedCasesAction with none
   * of the Eloquent withRelations()/relationLoaded() noise a text grep pulls
   * in. Merged into the seed-grep step as additional terms, not resolved to
   * a file path here - namespace-to-path conventions are project-specific
   * and would be exactly the hardcoding this project has repeatedly ruled
   * out, so the model's own grep_content resolves these to real files.
   */
  graphHintTerms?: string[];
  /**
   * Embeddings-backed semantic search over the project's code (packages/knowledge's
   * code-embeddings.ts + packages/ai's embedTexts) - injected by the caller
   * (apps/api/src/pipeline-runner.ts) rather than called directly here, so
   * this package stays free of any DB/provider-embeddings dependency, same
   * as shouldAbort. Finds files by MEANING, not literal substring - the
   * thing grep_content structurally cannot do (a business term from the
   * question is rarely the identifier used in code). Returns a formatted
   * observation string, same shape as list_dir/grep_content/read_file's
   * return values. Optional: when absent (e.g. Observer's crawlUnit, or no
   * embedding index built yet for this project), the tool is not advertised
   * to the model at all.
   */
  semanticSearch?: (query: string) => Promise<string>;
  /**
   * Top file paths by semantic similarity to the task (same index as
   * semanticSearch, but structured). When present, the loop AUTO-READS these
   * files before turn 1 and puts their content into the seed context - the
   * single biggest latency lever measured (2026-07-16): easy questions spent
   * 2-3 of their 5-8 turns just requesting reads of exactly these files, at
   * a full LLM round-trip each. Quality-neutral by construction: it is the
   * same read_file output the model would have requested, minus the
   * round-trips; the model remains free to read anything else.
   */
  semanticSeedFiles?: (query: string) => Promise<string[]>;
  /**
   * Graph-backed structural navigation (2026-07-16, architecture review
   * finding: the graph already exists in the system - built early for
   * Impact analysis - but was never exposed to the Researcher itself, which
   * had only lexical grep to answer "who calls this"). Given a symbol or
   * file name, returns real callers/dependents from the persisted structural
   * graph - catches renamed-variable/interface-indirection call sites that a
   * text grep for the literal name would miss. Injected the same way as
   * semanticSearch (this package stays free of the graph-building
   * dependency); degrades to an honest "not available" string rather than
   * blocking when the graph has no matching node (e.g. a dynamic-dispatch
   * call the graph never resolved statically) - a real limitation, not
   * hidden from the model.
   */
  findReferences?: (symbolOrFileName: string) => Promise<string>;
  /**
   * Read-only DB inspection (2026-07-18, docs/architecture/011 §4.19,
   * explicit product-owner directive from their own real workflow: "when
   * a bug is reported, I reproduce it, then check what actually got
   * written to the DB, and work backward from there" - this loop is what
   * the debugger's diagnose step (§4.9) routes through, so this is exactly
   * the tool that scenario needs). Injected the same way as
   * semanticSearch/findReferences (this package stays free of the
   * connection-resolution/docker dependency - see
   * apps/api/src/db-query-tool.ts); undefined when no DB config could be
   * resolved for this project, same "honest degradation" convention.
   */
  dbQuery?: (query: string) => Promise<string>;
  /**
   * Pre-formatted block of previously CONFIRMED project facts (fact store,
   * packages/knowledge) relevant to this task - "verify, then rely" seeds.
   * Team-mode never saw the fact store before 2026-07-16 (only the legacy
   * deterministic path did), which wasted the accumulating knowledge base.
   */
  knownFactsHint?: string;
  /**
   * Called at the start of every turn - lets the caller surface live
   * progress (turn number, files read so far) to the user while the
   * research phase (~95% of a question's wall time) is running.
   */
  onProgress?: (info: { turn: number; filesRead: number }) => void;
}

export interface AgenticRunResult {
  finalAnswer: string | null;
  /** Normalized, workspace-relative paths of every file actually read (real evidence, not directory listings). */
  touchedFiles: string[];
  actionsLog: string[];
  criticVerdict: "approved" | "rejected-once-then-accepted" | "rejected-budget-exhausted" | "not-run";
  criticRounds: number;
  turnsUsed: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  /** Researcher-only slice of the totals above (2026-07-18, per-role usage breakdown - see docs/architecture, "Подробнее" token panel). */
  researcherPromptTokens: number;
  researcherCompletionTokens: number;
  /** Critic-only slice - Critic also classifies chat messages elsewhere, but THIS is only its answer-review calls inside this loop. */
  criticPromptTokens: number;
  criticCompletionTokens: number;
  stopped: "final_answer" | "max_turns" | "error" | "aborted";
  error?: string;
  /**
   * Set when the Critic found a genuine, transcript-backed contradiction
   * between the final answer and a specific Observer entry it was given
   * (see AgenticRunOptions.observerEntries) - the caller (pipeline-runner.ts)
   * writes this back to business_graph_entries as a scoped gotcha, not a
   * full rewrite, so a future reader of the SAME entry doesn't get misled by
   * the same gap again. Never set by the researcher itself, only by the
   * independent Critic pass - a self-reported "I found an error in the
   * hint" claim is exactly the kind of unverified assertion this project's
   * whole approach exists to distrust.
   */
  observerCorrection?: { projectRootPath: string; unitPath: string; note: string };
  /**
   * Set only when escalation actually fired this run (2026-07-19) - the
   * model name it escalated TO, plus its OWN token slice, kept separate
   * from researcherPromptTokens/researcherCompletionTokens above (those
   * stay the base-model-only portion) because the escalation model almost
   * always carries a different cost multiplier; the caller (pipeline-runner.ts's
   * usage summary) needs both slices to attribute spend correctly instead of
   * reporting the whole run's cost under whichever model started it.
   */
  escalatedResearcherModel?: string;
  escalatedResearcherPromptTokens?: number;
  escalatedResearcherCompletionTokens?: number;
  escalatedResearcherCallCount?: number;
}

interface ParsedAction {
  tool: "list_dir" | "grep_content" | "read_file" | "semantic_search" | "find_references" | "db_query" | "request_verification" | "final_answer";
  arg: string;
}

// Translated to English (2026-07-16, user's explicit request - weaker
// models parse English instructions more reliably). The one exception is
// final_answer's own content: it must stay in Russian, since it flows into
// ResearchReport.functionalSummary and can end up user-visible directly in a
// fallback path (verified live earlier this session: a raw, unsynthesized
// agentic answer leaking to the user is a real failure mode, not
// hypothetical) - the downstream answer-synthesis prompt (packages/ai) also
// demands Russian, but this is a deliberate second safety net, not
// redundant.
function buildSystemPrompt(hasSemanticSearch: boolean, isMultiRoot: boolean, hasFindReferences: boolean, hasDbQuery: boolean, hasEscalationModel: boolean): string {
  return [
    "You are an experienced senior fullstack developer investigating an unfamiliar codebase to honestly answer an engineering question.",
    "You have tools. Write each action on its own line in this exact form (no markdown wrapping):",
    "ACTION: list_dir(relative/path)",
    "ACTION: grep_content(string or regex to search file contents for)",
    "ACTION: read_file(relative/path/to/file.php)",
    ...(hasSemanticSearch
      ? [
        "ACTION: semantic_search(a plain-language description of what you are looking for)",
        "semantic_search finds files by MEANING, not literal text - use it when the business term from the question (e.g. \"relation cases\", \"profile access\") does not obviously match any file/directory name or grep hit, instead of guessing blindly.",
      ]
      : []),
    ...(hasFindReferences
      ? [
        "ACTION: find_references(ClassOrFunctionOrFileName)",
        "find_references looks up REAL structural callers/dependents of a class, function, or file from the persisted code graph - use it instead of grep_content when you need \"who actually calls/uses this\", because grep only matches the literal name as text and misses calls through a renamed variable, an interface, or other indirection. It may come back empty for a name the graph does not have a resolved node for (e.g. purely dynamic dispatch) - that is an honest limit of static analysis, not a sign nothing calls it; fall back to grep_content in that case.",
      ]
      : []),
    ...(hasDbQuery
      ? [
        "ACTION: db_query(a single SELECT/WITH/EXPLAIN/SHOW statement)",
        "db_query runs read-only against the project's REAL database (resolved from its own .env/docker-compose). READ-ONLY ONLY, enforced in code regardless of what you send - no INSERT/UPDATE/DELETE/DDL, no multiple statements. Use it when a question is really about DATA, not code: what a config/setting is actually set to for a real record, whether a described bug's symptom is visible in the actual stored row (e.g. \"field X did not save\" - check what actually got persisted, not just what the code SHOULD do), what real example values/relationships a table holds instead of guessing from a model's field list alone.",
      ]
      : []),
    ...(hasEscalationModel
      ? [
        "ACTION: request_verification(a specific, concrete reason: which exact claim/file you are unsure about and why - not a vague \"just to be safe\")",
        "request_verification hands the rest of this investigation to a stronger model, before you commit to a final_answer - use it when you notice a genuine reason to distrust your own read of the evidence: two files disagree, a business term could plausibly map to more than one similarly-named mechanism (e.g. \"relation\" vs \"Relationship\"), or you are about to answer confidently from only one weak match. Do not use it just because the question is broad - only when you have a CONCRETE, nameable doubt. This does not replace final_answer or skip review - a critic still checks your answer either way - it only changes which model does the remaining thinking. You will not always have this option; if it is not offered, keep investigating and answering yourself.",
      ]
      : []),
    "ACTION: final_answer(your final answer IN RUSSIAN, naming specific files if you found them, or an honest admission that you did not; the content must be ONLY the answer itself - no meta commentary like 'revised version of the answer' or notes addressed to the critic)",
    ...(isMultiRoot
      ? [
        "IMPORTANT: this project has MULTIPLE physical repos (parts), listed in \"Project parts\" above with their role (e.g. backend, frontend-web, frontend-desktop, cli) and shown by list_dir(\".\"). Every path you write starts with the part's name, e.g. \"web/src/boot/axios.js\" or \"api/routes/api.php\" - the part name is not a regular directory, it is which repo you are in.",
        "A question about UI/screens/buttons is usually answered inside a frontend part; a question about data storage/API endpoints/business rules is usually in the backend part. Many questions genuinely span both (e.g. \"what does this button call, and what does the backend do\") - in that case grep_content across all parts in one call and read files from whichever parts actually matter, do not restrict yourself to one part out of habit.",
        "USE THE FRONTEND AS A BUSINESS GLOSSARY: a frontend part's i18n/locale files and UI component labels are written in the user's own business language, not engineering names - e.g. an i18n file may map an English key like `cancelSubscription` to the exact literal phrase the user typed. If a business term from the question has no obvious match by its literal wording, grep for the exact phrase itself (do not only translate/rephrase it) - a hit in an i18n/locale file often reveals the real technical name to then search for, and the UI component that uses that translation key leads you to which backend endpoint it calls.",
      ]
      : []),
    `IMPORTANT for speed: if you already see several places worth checking (several files to read, several directories to look at, several terms to grep) - do not spread this across separate turns one at a time. Write several ACTION lines in a row in one response (up to ${MAX_ACTIONS_PER_TURN} per turn), they execute in order and the results come back together in one batch. One ACTION per turn is NOT more careful, it is just slower: every extra turn is a whole separate model call that re-sends the entire history again. The one exception is final_answer: if you call it, call ONLY it, with no other ACTION in the same response (look at the results first, then answer).`,
    "Before an ACTION you may briefly (1-2 sentences) write what you are doing and why.",
    "Start with list_dir(\".\") if you do not know the structure. Look for literal, semantically close directory/file names - not only in Russian, but also their English translations.",
    "IMPORTANT: before reading a specific file in a directory you have not listed (list_dir) yet in this conversation, list_dir that directory first. A neighboring file with a similar name might be the one that actually answers the question - blindly guessing a filename skips that discovery.",
    "You have time to think it through properly. Do not rush to final_answer before checking all realistic places, including neighboring files with related meaning (e.g. there may be more than one Service nearby - check the whole directory).",
    "IMPORTANT before giving up: if the question names a specific field/column/variable/parameter (e.g. `personal_claim_number`, `is_active`) and you have not yet grepped that EXACT literal name across the whole project, do that before writing a final_answer that admits you could not find enough. Which file assigns/reads it, and under what condition, is usually only visible by searching for the literal name itself - reading a handful of plausible-looking files that happen to reference it is not the same as tracing where it is actually written to and why. An honest 'insufficient facts' answer is only honest if grep_content for the literal term was actually tried and still came up empty.",
    // Bug fix (2026-07-19, live incident): asked whether a stateful shell
    // command would work through a CLI, the model correctly found a
    // function that blocks it - and ALSO opened the exact file that calls
    // that function, which contained an early-return branch (an `--shell`
    // flag) that skips the block entirely and is the whole reason a
    // separate "shell integration" subsystem exists in that project. It had
    // read every needed file, but the final answer restated only the
    // blocking mechanism it found first, never connecting the bypass branch
    // it had ALSO already seen. Finding ONE function that blocks/restricts
    // something is not proof every caller reaches it the same way.
    "IMPORTANT before concluding something is BLOCKED, RESTRICTED, or WON'T WORK: a check/guard found in one function only proves that PARTICULAR call path is blocked - trace backward to whether the same functionality can be reached through a different path (a flag, an alternate function, an early return before the check, a separate mode) that skips it. This especially applies when you notice a whole extra piece of infrastructure nearby (an \"integration\"/\"wrapper\"/\"install\" mechanism, a config flag, a second entrypoint) whose apparent purpose is to make the thing you just called blocked actually work - if you have not traced whether THAT mechanism reaches the guard differently, your answer is incomplete even if the guard function itself is described correctly. Do not let a plausible first explanation stop you from checking the files you already opened for a second path.",
    // Same live incident, a second gap (a later re-run of the exact same
    // question skipped the file with the bypass entirely this time, having
    // seen it only as an import/reference in another file it DID open) -
    // inferring a called function's behavior from its name or from how a
    // neighboring file imports/calls it is not the same as having actually
    // read that function's own body, especially when the call passes a
    // flag/option argument (exactly the shape that changes behavior).
    "If a file you opened imports, requires, or calls a function whose ACTUAL behavior matters for answering the question - especially one invoked with a flag/option argument, since that is exactly what usually changes what a function does - open that function's own definition before answering, do not infer its behavior from its name or from how the caller uses it. A reference to something is not evidence of what it does.",
    "When ready, call final_answer exactly once. Do not invent facts you have not seen in the observations. If you did not check something, say so plainly instead of asserting it with confidence.",
  ].join("\n");
}

const CRITIC_SYSTEM_PROMPT = [
  "You are an independent critic-validator (a different model from the one that researched the code).",
  "You are given: an engineering question, a full transcript of another model's actions (which files it looked at and what it saw), and its proposed final answer.",
  "Check strictly: (1) every claim in the answer must be directly confirmed by what is actually in the transcript - not invented, not guessed; (2) if the answer itself mentions that something 'needs checking' or 'was not checked', but the transcript shows this was NOT checked before the final answer - that is grounds for rejection; (3) if the answer confidently asserts something for which the transcript has insufficient grounds (e.g. only one file out of a chain), that is also grounds for rejection; (4) if the answer is essentially 'I cannot answer without reading files X, Y' while the transcript shows those files were never read - REJECT and tell it to actually read them: giving up without reading the files it itself names is not an acceptable final answer; (5) if the question names a specific field/column/variable/parameter and the answer gives up ('not enough facts', 'needs manual debugging') without the transcript showing a grep_content call for that EXACT literal name anywhere - REJECT and tell it to grep that literal term first. A give-up answer is not automatically honest just because it makes no false claims - it must show the obvious literal search was actually tried; (6) if the answer concludes something is BLOCKED/RESTRICTED/WON'T WORK, but the transcript shows the model ALSO opened a file that contains an alternate path reaching the same functionality (a flag, an early return, a second entrypoint, an \"integration\"/\"wrapper\"/\"install\" mechanism whose evident purpose is to enable exactly the thing being called blocked) and the final answer never addresses whether that alternate path bypasses the block - REJECT and name the specific file/branch it needs to reconcile. Seeing contradicting evidence in your own transcript and not mentioning it in the answer is exactly the kind of gap this check exists to catch, not a matter of the researcher model's stylistic choice.",
  // Bug fix (2026-07-19, architecture review "safety fuse" request): the
  // Observer's own cached hints (business_graph_entries) are themselves
  // written by an LLM crawl and can be stale/wrong in the exact same ways
  // this whole prompt worries about the RESEARCHER being wrong - but until
  // now nothing ever fed a discovered Observer inaccuracy back into that
  // store, so the same wrong hint kept getting reused as "prior knowledge"
  // indefinitely, even after the code that would prove it wrong had been
  // sitting right there the whole time (live incident: an Observer hint
  // said a mechanism has no bypass; the transcript showed the researcher
  // opening the exact file that IS the bypass, but that never made it back
  // into the Observer's own record).
  "(7) You may ALSO be given \"Observer hints\" (background-scan leads the researcher was told to verify, not confirmed facts). If the transcript+answer together clearly PROVE a specific hint's claim is wrong or incomplete (not just that the answer phrased something differently) - i.e. the transcript itself contains direct evidence contradicting that hint - append a SECOND line after APPROVED: \"CORRECTION[<the exact unit path from the hint's brackets>]: <a short, specific note IN RUSSIAN stating exactly what the hint got wrong and what the transcript actually showed>\". Only do this when the contradiction is directly grounded in the transcript, never from the answer's own wording alone - an unsupported correction is worse than no correction, since it gets written back as if it were verified fact. If there is no genuine, transcript-backed contradiction, do not add this line at all - most runs will have nothing to correct.",
  "Reply STRICTLY: either just \"APPROVED\" (plus an optional CORRECTION line per (7) above), or \"REJECTED: <a short, specific note IN RUSSIAN on exactly what needs to be checked before answering again>\" (no CORRECTION line on a rejection - the researcher will re-investigate before the answer is settled).",
].join("\n");

// Live evidence (2026-07-15): asked "что такое папка w9" against a real
// project - the model explored only 2 root files across 48 turns and never
// once grepped the literal word "w9", even though `grep -ril "w9"` finds the
// whole feature (AttachW9DocumentsToGeneratedBillAction.php,
// EdocumentFolderController, a migration) in under a second. Business terms
// in a user's own question routinely don't match any folder/file name at all
// (the same "DME hidden under Suplay" shape from day one of this project) -
// a plain-language question gives no reason for the model to think "grep for
// this exact word" is the obvious first move, so it's done automatically
// instead of hoping the model reaches for it on its own.
const DISTINCTIVE_TOKEN_PATTERN = /[A-Za-z][A-Za-z0-9_-]*/g;
// Raised from 5 - graph-derived symbol names (findGraphSymbolHints) are now
// a third term source alongside Latin/transliterated tokens.
// Raised from 7 (2026-07-16) to make room for raw Cyrillic phrase terms
// (extractCyrillicPhraseTokens) without crowding out graph-hint/distinctive
// terms that were already filling the old budget on hard questions.
const MAX_SEED_GREP_TERMS = 9;

function extractDistinctiveTokens(task: string): string[] {
  const candidates = task.match(DISTINCTIVE_TOKEN_PATTERN) ?? [];
  const seen = new Set<string>();
  const distinctive: string[] = [];

  for (const token of candidates) {
    const hasDigit = /\d/.test(token);
    const isAcronym = /^[A-Z]{2,6}$/.test(token);
    const isMixedCase = /[a-z]/.test(token) && /[A-Z]/.test(token) && token.length >= 3;
    // Bug fix (2026-07-17): a lowercase snake_case identifier like
    // "personal_claim_number" - the single most common naming convention for
    // PHP/Laravel model fields and DB columns - matched none of the above and
    // was silently NEVER auto-grepped, even when it was the exact literal
    // term the user's question was about. Live evidence: two consecutive
    // questions about this exact field both gave up with "not enough facts"
    // without the loop ever having grepped it automatically.
    const isSnakeCaseIdentifier = token.includes("_") && token.length >= 5;

    if (!hasDigit && !isAcronym && !isMixedCase && !isSnakeCaseIdentifier) {
      continue;
    }

    const key = token.toLowerCase();

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    distinctive.push(token);
  }

  return distinctive;
}

// Live evidence (2026-07-15): "релейшн кейс"/"репликейтед кейс" are
// PHONETIC TRANSLITERATIONS written in Cyrillic ("relation case", "replicated
// case"), not the Latin words themselves - extractDistinctiveTokens above
// only scans Latin script, so a fully-Cyrillic question yields zero seed
// terms and the model falls back to guessing (it landed on Eloquent's own
// generic withRelations()/loadRelations() plumbing instead of the real
// CaseData/LinkCasesDataDTO feature). expandRussianTechTransliteration
// (packages/shared) already exists for exactly this gap in the deterministic
// path's tokenizer - reused here rather than duplicating a stem list.
function extractTransliteratedTokens(task: string): string[] {
  const cyrillicTokens = tokenize(task).filter((token) => /[а-яё]/i.test(token));
  const expanded = expandRussianTechTransliteration(cyrillicTokens);
  return expanded.filter((token) => !cyrillicTokens.includes(token));
}

// Multi-path unification made this a real, generic win (2026-07-16, user's
// request to use the frontend for better business-semantics understanding):
// a project WITH a frontend has i18n/locale files and UI component labels
// containing the exact literal Cyrillic business phrase from the question
// ("Отменить подписку", "Личный кабинет") as a plain string value - something
// pure backend code (English identifiers) never had a reason to contain.
// Grepping the raw phrase (not just its tech-jargon transliteration) can hit
// that locale entry directly, and from there the connected component/store/
// endpoint. Harmless on backend-only projects too - a raw Cyrillic phrase
// that matches nothing just costs one empty seed slot, never a wrong lead.
const CYRILLIC_STOP_WORDS = new Set([
  "как", "что", "где", "почему", "кто", "когда", "это", "эта", "этот",
  "для", "или", "если", "при", "его", "или", "чем", "тем", "все", "всех",
  "нет", "или", "уже", "ещё", "еще", "мы", "вы", "они", "мне", "нам",
]);

function extractCyrillicPhraseTokens(task: string): string[] {
  return tokenize(task)
    .filter((token) => /[а-яё]/i.test(token) && token.length >= 4 && !CYRILLIC_STOP_WORDS.has(token.toLowerCase()))
    .slice(0, 4);
}

// Exported (2026-07-17) for reuse by develop-loop.ts - the same "grep the
// literal words of the task before turn 1" seed applies to change tasks.
export async function buildSeedGrepObservation(projectRoots: WorkspaceRoot[], task: string, graphHintTerms: string[]): Promise<string> {
  // Graph-derived symbol names go first - precise (real class/function names
  // from the persisted code graph), so if the term budget is tight they
  // should win over generic transliterated words like "case"/"relation".
  // Raw Cyrillic phrases come right after (also literal, not a guessed
  // translation) - transliterated tech-jargon guesses go last since they are
  // the least directly grounded of the three sources.
  const terms = [
    ...new Set([
      ...graphHintTerms,
      ...extractDistinctiveTokens(task),
      ...extractCyrillicPhraseTokens(task),
      ...extractTransliteratedTokens(task),
    ]),
  ].slice(0, MAX_SEED_GREP_TERMS);

  if (terms.length === 0) {
    return "";
  }

  // Bounded per-term, not on the joined block - a fixed overall cap would
  // let noise in an earlier term's results push a later term's real matches
  // out of the budget entirely instead of just trimming each fairly.
  const perTermCap = Math.floor(MAX_OBSERVATION_CHARS / terms.length);
  const results = await Promise.all(
    terms.map(async (term) => {
      const raw = await grepContent(projectRoots, term);
      const bounded = raw.length > perTermCap ? `${raw.slice(0, perTermCap)}\n... (truncated)` : raw;
      return `grep_content("${term}"):\n${bounded}`;
    }),
  );

  return [
    "Automatic preliminary search for the literal words of the question (before your first turn). This is only a starting point, not a fact - but the thing you need often is not where you'd expect from a folder name (a business term from the question can be a field/entity in code, not a directory), so it is worth checking this before exploring blindly:",
    ...results,
  ].join("\n\n");
}

// Models routinely ignore "one action per turn" and emit several ACTION(...)
// calls back to back in one completion, sometimes with no newlines between
// them at all - and now they're explicitly invited to (multi-action turns,
// 2026-07-15). Scans for each "ACTION: tool(" occurrence in order and walks
// paren depth from each to find its matching close-paren (handles nested
// parens, e.g. grep regex groups), stopping once MAX_ACTIONS_PER_TURN is
// reached or no further match/close-paren is found.
function parseActions(content: string): ParsedAction[] {
  const actionPattern = /ACTION:\s*(list_dir|grep_content|read_file|semantic_search|find_references|db_query|request_verification|final_answer)\s*\(/g;
  const actions: ParsedAction[] = [];
  let searchFrom = 0;

  while (actions.length < MAX_ACTIONS_PER_TURN) {
    actionPattern.lastIndex = searchFrom;
    const match = actionPattern.exec(content);

    if (!match || match.index === undefined) {
      break;
    }

    const tool = match[1] as ParsedAction["tool"];
    const openParenIndex = match.index + match[0].length - 1;
    let depth = 0;
    let closeParenIndex = -1;

    // grep_content patterns often contain backslash-escaped literal parens
    // (e.g. "authorize\(" to match the literal string "authorize(") - a naive
    // depth count treats those as real nesting and never finds a matching
    // close, silently dropping the whole action. A single preceding backslash
    // means "this paren is a literal character in the pattern, not a scope
    // boundary" and must not affect depth.
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
          closeParenIndex = i;
          break;
        }
      }
    }

    if (closeParenIndex === -1) {
      break;
    }

    let arg = content.slice(openParenIndex + 1, closeParenIndex).trim();

    if ((arg.startsWith('"') && arg.endsWith('"')) || (arg.startsWith("'") && arg.endsWith("'"))) {
      arg = arg.slice(1, -1);
    }

    actions.push({ tool, arg });

    if (tool === "final_answer") {
      // Conclusive - a batch mixing final_answer with unexecuted tool
      // requests makes no sense (the model hasn't seen their results yet).
      break;
    }

    searchFrom = closeParenIndex + 1;
  }

  // Whether final_answer came first, last, or mixed in - it wins alone.
  const finalAnswerIndex = actions.findIndex((action) => action.tool === "final_answer");
  return finalAnswerIndex === -1 ? actions : [actions[finalAnswerIndex] as ParsedAction];
}

async function callCritic(input: {
  criticModel: string;
  providerBaseUrl: string;
  providerApiKey: string;
  task: string;
  transcript: string;
  proposedAnswer: string;
  observerEntries?: ObserverEntryRef[];
}): Promise<{ approved: boolean; reason: string; promptTokens: number; completionTokens: number; correction: { projectRootPath: string; unitPath: string; note: string } | null }> {
  const messages: ChatMessage[] = [
    { role: "system", content: CRITIC_SYSTEM_PROMPT },
    {
      role: "user",
      content: [
        `Question: ${input.task}`,
        "",
        "Transcript of the other model's actions:",
        input.transcript,
        "",
        `Proposed final answer: ${input.proposedAnswer}`,
        ...(input.observerEntries?.length
          ? [
              "",
              "Observer hints the researcher was given (unverified leads it was told to verify, tagged by unit path - check #6 against these):",
              ...input.observerEntries.map((entry) => `[${entry.unitPath}] ${entry.text}`),
            ]
          : []),
      ].join("\n"),
    },
  ];

  try {
    const { content, usage } = await callModel(input.providerBaseUrl, input.providerApiKey, input.criticModel, messages);
    const trimmed = content.trim();
    const approved = /^APPROVED/i.test(trimmed);
    const reasonMatch = /^REJECTED:\s*(.*)/is.exec(trimmed);
    // Only ever trusted when paired with APPROVED - a rejected answer means
    // the researcher goes back and re-investigates anyway, and a correction
    // derived from a not-yet-settled answer would be premature.
    const correctionMatch = approved ? /CORRECTION\[([^\]]+)\]:\s*(.+)/is.exec(trimmed) : null;
    const correctionUnitPath = correctionMatch?.[1]?.trim();
    const matchingEntry = correctionUnitPath
      ? input.observerEntries?.find((entry) => entry.unitPath === correctionUnitPath)
      : undefined;

    // Kept in Russian, not translated (2026-07-16 prompt sweep): this is the
    // fallback for when the critic's own reply is malformed/empty - the
    // NORMAL case (the model's own REJECTED: reason) is Russian per
    // CRITIC_SYSTEM_PROMPT, so this stays consistent with it rather than
    // mixing languages in the same field the Researcher reads next turn.
    return {
      approved,
      reason: approved ? "" : (reasonMatch?.[1]?.trim() || trimmed || "Критик отклонил ответ без указанной причины."),
      promptTokens: usage?.prompt_tokens ?? 0,
      completionTokens: usage?.completion_tokens ?? 0,
      // matchingEntry required (not just a well-formed CORRECTION[...] line) -
      // a unit path the critic invented that doesn't match any entry it was
      // actually given is not trustworthy enough to write back.
      correction: matchingEntry && correctionMatch?.[2]
        ? { projectRootPath: matchingEntry.projectRootPath, unitPath: matchingEntry.unitPath, note: correctionMatch[2].trim() }
        : null,
    };
  } catch (error) {
    // Critic being unavailable should not deadlock the run - approve by
    // default rather than silently rejecting forever.
    return {
      approved: true,
      reason: `Критик недоступен (${error instanceof Error ? error.message : String(error)}), ответ принят без проверки.`,
      promptTokens: 0,
      completionTokens: 0,
      correction: null,
    };
  }
}

export async function runAgenticLoop(options: AgenticRunOptions): Promise<AgenticRunResult> {
  const maxTurns = options.maxTurns ?? DEFAULT_SAFETY_CEILING_TURNS;
  const priorTurnFiles = [...new Set(options.priorTurnFiles ?? [])];
  // Topic bridge comes FIRST, files second - the topic is what tells the
  // model an elliptical question ("give me a list of routes", no subject) is
  // a continuation at all; the file list is only useful once that's established.
  const priorTurnTopicHint = options.priorTurnTopic
    ? `\n\nThe PREVIOUS question in this same conversation was: "${options.priorTurnTopic.task}" - and it was answered with: "${options.priorTurnTopic.summary}". If the new question is elliptical (no explicit subject - e.g. "give me a list of routes for it", "and how do I call it", "what about on mobile") it almost always means "continue about the SAME topic as the previous question", not a fresh unscoped question about the whole project - resolve the missing subject against the previous topic before researching. Only ignore this if the new question clearly names something unrelated.`
    : "";
  const priorTurnHint = priorTurnFiles.length > 0
    ? `\n\nIn the previous turn of this conversation you already found and read these files: ${priorTurnFiles.join(", ")}. If the new question continues the same topic - start by reading these files (read_file) instead of researching from scratch. If the question is clearly about something else - check whether they are still relevant or search anew, do not rely on them blindly.`
    : "";
  const observerHintBlock = options.observerHint ? `\n\n${options.observerHint}` : "";
  const attachmentHintBlock = options.attachmentHint ? `\n\n${options.attachmentHint}` : "";
  const questionShapeBlock = options.questionShapeHint ? `\n\n${options.questionShapeHint}` : "";
  const isMultiRoot = options.projectRoots.length > 1;
  // Single-repo projects keep the exact original "Project: <path>" line -
  // zero behavior change for the still-overwhelmingly-common case of one
  // physical repo (see tools.ts's resolvePath fast path for the same
  // principle applied to path resolution).
  const projectLine = isMultiRoot
    ? `Project parts: ${options.projectRoots.map((root) => `${root.label} (${root.role})`).join(", ")}`
    : `Project: ${options.projectRoots[0]?.absolutePath ?? ""}`;
  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt(Boolean(options.semanticSearch), isMultiRoot, Boolean(options.findReferences), Boolean(options.dbQuery), Boolean(options.researcherEscalationModel)) },
    { role: "user", content: `${projectLine}\nQuestion: ${options.task}${priorTurnTopicHint}${priorTurnHint}${observerHintBlock}${attachmentHintBlock}${questionShapeBlock}` },
  ];

  // Seed semantic search runs in parallel with the seed grep (2026-07-16) -
  // stage timing on live runs showed research is ~100s of a ~106s question
  // run, so the only real speed lever is fewer exploration turns; handing the
  // model meaning-ranked file candidates BEFORE its first turn attacks that
  // directly (the same rationale as the seed grep, for the complementary
  // failure mode: question words that never literally appear in the code).
  // Verified live that the raw Russian task text works cross-lingually
  // against English code (qwen3-embedding ranked the right CaseData files
  // top-8 for the raw "релейшн кейсы" question). Failure/empty results
  // (index not built yet, provider hiccup) come back as "(...)"-wrapped
  // status strings from the injected tool - those are dropped silently
  // rather than shown as a confusing empty seed block.
  const [seedGrepObservation, seedSemanticObservation] = await Promise.all([
    buildSeedGrepObservation(
      options.projectRoots,
      options.task,
      options.graphHintTerms ?? [],
    ),
    options.semanticSearch
      ? options.semanticSearch(options.task).then((result) => (result.trim().startsWith("(") ? "" : result)).catch(() => "")
      : Promise.resolve(""),
  ]);

  if (seedGrepObservation) {
    messages.push({ role: "user", content: seedGrepObservation });
  }

  if (seedSemanticObservation) {
    messages.push({
      role: "user",
      content: [
        "Automatic semantic (by-meaning) search for the question itself (before your first turn). Files ranked by semantic similarity to the question - these are leads to verify with read_file, not established facts:",
        seedSemanticObservation,
      ].join("\n"),
    });
  }

  // Auto-read seed (2026-07-16, speed pass): content of the top semantic
  // matches goes straight into the pre-turn context. Tracked separately from
  // touchedFiles - a seed file only becomes evidence if the final answer
  // actually mentions it (see finalize), otherwise speculative pre-reads
  // would pollute evidence/impact/context on every question they turned out
  // irrelevant for. Widened 3 -> 5 then reverted back to 3 (2026-07-23):
  // widening was meant to trade a bigger first prompt for fewer turns, but
  // live data showed the real bottleneck was the embeddings call itself
  // (a flaky provider, now fixed with a short fail-fast timeout - see
  // embedTexts) and the unindexed Postgres scan behind it (also fixed, see
  // findSemanticMatches*) - widening just meant hitting that same expensive
  // path more per run, for no measured turn-count benefit once those were
  // still broken. Revisit widening again only with the underlying fixes in
  // place and fresh measurements, not as a first lever.
  const seedReadFiles = new Set<string>();

  if (options.semanticSeedFiles) {
    try {
      const seedPaths = (await options.semanticSeedFiles(options.task)).slice(0, 3);
      const seedBlocks: string[] = [];

      for (const seedPath of seedPaths) {
        const content = await readFile(options.projectRoots, seedPath);

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
            "The most semantically relevant files have been read for you in advance (same as read_file output). If they already answer the question - answer right away instead of re-requesting them; if not - research as usual:",
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

  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  // Per-role slice of the totals above (2026-07-18) - kept alongside, not
  // instead of, the totals: every existing consumer of totalPromptTokens/
  // totalCompletionTokens (develop-runner, crawlUnit, etc.) keeps working
  // unchanged; only the "Подробнее" token panel needs the split.
  let researcherPromptTokens = 0;
  let researcherCompletionTokens = 0;
  let criticPromptTokens = 0;
  let criticCompletionTokens = 0;
  // Deterministic escalation (2026-07-19, architecture review "dream team"
  // follow-up): the Critic REJECTING the proposed answer is a real,
  // code-level signal the base model struggled - not a self-assessment the
  // researcher model makes about its own confidence (deliberately avoided
  // elsewhere in this project, see the architecture review's rejection of
  // self-reported confidence scores). On the FIRST rejection, if an
  // escalation model is configured and differs from what's active, switch
  // to it for the rest of this run - cheap by default, stronger only when
  // there's concrete evidence the cheap pass wasn't enough. Tracked
  // separately from researcherPromptTokens/researcherCompletionTokens
  // because the escalation model almost always has a DIFFERENT cost
  // multiplier - lumping them together would misattribute spend in the
  // "Подробнее" usage panel.
  let activeResearcherModel = options.researcherModel;
  let hasEscalated = false;
  let escalatedResearcherPromptTokens = 0;
  let escalatedResearcherCompletionTokens = 0;
  let escalatedResearcherCalls = 0;
  const actionsLog: string[] = [...[...seedReadFiles].map((filePath) => `[seed] auto-read ${filePath}`)];
  const touchedFiles = new Set<string>();
  const seenDirs = new Set<string>([
    normalizeDirKey("."),
    ...priorTurnFiles.map((filePath) => dirnameOf(filePath)),
    ...[...seedReadFiles].map((filePath) => dirnameOf(filePath)),
  ]);
  const grepTermsSeen = new Set<string>();
  let criticRounds = 0;
  let criticVerdict: AgenticRunResult["criticVerdict"] = "not-run";
  // Live evidence (2026-07-15): a run burned 48 calls / ~300K tokens (hit the
  // hard safety ceiling) while reading only 2 files total - most turns were
  // repeating the same ground, not genuine exploration, because the loop
  // resends the full accumulated history every turn regardless of whether
  // new information is actually coming in. This is deliberately NOT a
  // turn-count nudge (rejected earlier this session - it pressured models to
  // conclude before they actually knew enough): it only fires when the
  // explored surface (new dirs/files/grep terms) has genuinely stopped
  // growing for many turns straight, which is the "runaway, not thorough"
  // case the safety ceiling already exists to catch, just sooner.
  const STUCK_TURNS_THRESHOLD = 8;
  let stuckTurns = 0;
  let stuckNudgeSent = false;
  let lastSurfaceSize = touchedFiles.size + seenDirs.size + grepTermsSeen.size;

  const finalize = (
    overrides: Partial<AgenticRunResult> & Pick<AgenticRunResult, "turnsUsed" | "stopped">,
  ): AgenticRunResult => {
    // Seed pre-reads become evidence only when the answer actually leans on
    // them (mentions the path or the class/file stem) - see seedReadFiles.
    const answerText = (overrides.finalAnswer ?? "").toLowerCase();

    if (answerText) {
      for (const seedPath of seedReadFiles) {
        const stem = (seedPath.split("/").pop() ?? seedPath).replace(/\.[a-z0-9]+$/i, "").toLowerCase();

        if (answerText.includes(seedPath.toLowerCase()) || (stem.length >= 4 && answerText.includes(stem))) {
          touchedFiles.add(seedPath);
        }
      }
    }

    return {
      finalAnswer: null,
      touchedFiles: [...touchedFiles],
      actionsLog,
      criticVerdict,
      criticRounds,
      totalPromptTokens,
      totalCompletionTokens,
      researcherPromptTokens,
      researcherCompletionTokens,
      criticPromptTokens,
      criticCompletionTokens,
      ...(hasEscalated
        ? {
            escalatedResearcherModel: activeResearcherModel,
            escalatedResearcherPromptTokens,
            escalatedResearcherCompletionTokens,
            escalatedResearcherCallCount: escalatedResearcherCalls,
          }
        : {}),
      ...overrides,
    };
  };

  // Deterministic guard, no LLM involved (2026-07-16, live incident): a run
  // gave up on turn 2 with "cannot answer without reading files X, Y" having
  // read ZERO files (it only saw the seed grep/semantic listings), and the
  // critic APPROVED it - an honest non-answer contains no unconfirmed claims,
  // so it slips through the critic's honesty-focused rules. One bounce max:
  // if the model insists a second time, the critic (whose prompt now also
  // covers this case) makes the call.
  let zeroReadBounceSent = false;

  async function evaluateProposedAnswer(candidate: string, turn: number): Promise<AgenticRunResult | "continue-loop"> {
    // seedReadFiles count as real reads (their full content was in context).
    if (touchedFiles.size === 0 && seedReadFiles.size === 0 && !zeroReadBounceSent && turn < maxTurns - 5) {
      zeroReadBounceSent = true;
      actionsLog.push(`[turn ${turn}] final_answer bounced: zero files read - directory/grep listings alone are not evidence.`);
      messages.push({
        role: "user",
        content: "You are proposing a final answer without having read a single file (read_file) - directory listings and grep matches are leads, not evidence. Read the key files you yourself consider relevant, then answer based on their actual content.",
      });
      return "continue-loop";
    }

    const criticResult = await callCritic({
      criticModel: options.criticModel,
      providerBaseUrl: options.providerBaseUrl,
      providerApiKey: options.providerApiKey,
      task: options.task,
      transcript: actionsLog.join("\n"),
      proposedAnswer: candidate,
      ...(options.observerEntries ? { observerEntries: options.observerEntries } : {}),
    });
    totalPromptTokens += criticResult.promptTokens;
    totalCompletionTokens += criticResult.completionTokens;
    criticPromptTokens += criticResult.promptTokens;
    criticCompletionTokens += criticResult.completionTokens;
    criticRounds += 1;

    if (criticResult.approved) {
      actionsLog.push(`[turn ${turn}] critic: APPROVED`);

      if (criticResult.correction) {
        actionsLog.push(`[turn ${turn}] critic: CORRECTION flagged for Observer entry "${criticResult.correction.unitPath}"`);
      }

      criticVerdict = criticRounds > 1 ? "rejected-once-then-accepted" : "approved";
      return finalize({
        turnsUsed: turn,
        stopped: "final_answer",
        finalAnswer: candidate,
        criticVerdict,
        criticRounds,
        ...(criticResult.correction ? { observerCorrection: criticResult.correction } : {}),
      });
    }

    actionsLog.push(`[turn ${turn}] critic: REJECTED - ${criticResult.reason}`);

    if (!hasEscalated && options.researcherEscalationModel && options.researcherEscalationModel !== activeResearcherModel) {
      activeResearcherModel = options.researcherEscalationModel;
      hasEscalated = true;
      actionsLog.push(`[turn ${turn}] ESCALATED to ${activeResearcherModel} after critic rejection.`);
    }

    if (turn >= maxTurns) {
      criticVerdict = "rejected-budget-exhausted";
      return finalize({ turnsUsed: turn, stopped: "final_answer", finalAnswer: candidate, criticVerdict, criticRounds });
    }

    messages.push({
      role: "user",
      content: `The critic rejected your answer: ${criticResult.reason}\nCheck this, then call final_answer again.`,
    });

    return "continue-loop";
  }

  for (let turn = 1; turn <= maxTurns; turn += 1) {
    if (options.shouldAbort?.()) {
      actionsLog.push(`[turn ${turn}] ABORTED: yielding to a live interactive request.`);
      return finalize({ turnsUsed: turn, stopped: "aborted" });
    }

    options.onProgress?.({ turn, filesRead: touchedFiles.size + seedReadFiles.size });

    let content: string;
    let usage: ProviderUsage | null;

    try {
      const result = await callModel(
        options.providerBaseUrl,
        options.providerApiKey,
        activeResearcherModel,
        messages,
        RESEARCHER_REASONING_EFFORT,
      );
      content = result.content;
      usage = result.usage;
    } catch (error) {
      return finalize({
        turnsUsed: turn,
        stopped: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    }

    totalPromptTokens += usage?.prompt_tokens ?? 0;
    totalCompletionTokens += usage?.completion_tokens ?? 0;

    if (hasEscalated) {
      escalatedResearcherPromptTokens += usage?.prompt_tokens ?? 0;
      escalatedResearcherCompletionTokens += usage?.completion_tokens ?? 0;
      escalatedResearcherCalls += 1;
    } else {
      researcherPromptTokens += usage?.prompt_tokens ?? 0;
      researcherCompletionTokens += usage?.completion_tokens ?? 0;
    }

    if (totalPromptTokens + totalCompletionTokens >= RUN_TOKEN_SAFETY_LIMIT) {
      actionsLog.push(`[turn ${turn}] SAFETY ABORT: run exceeded ${RUN_TOKEN_SAFETY_LIMIT} tokens.`);
      return finalize({ turnsUsed: turn, stopped: "max_turns" });
    }

    const actions = parseActions(content);

    if (actions.length === 0) {
      actionsLog.push(`[turn ${turn}] NO ACTION PARSED (treated as implicit final answer). raw content: ${content.slice(0, 300)}`);
      messages.push({ role: "assistant", content });

      // The model may have genuinely tried ACTION: final_answer(...), but
      // parseActions's balanced-paren scanner never found a matching close
      // (a stray unbalanced paren anywhere in a long markdown answer is
      // enough) and correctly returned null - verified live: this leaked the
      // literal "ACTION: final_answer(" protocol prefix into a stored
      // Observer business-graph hint, which then got shown to the user
      // verbatim as if it were a clean answer. Strip that prefix (and a
      // trailing lone close-paren, if the model's text happened to end with
      // one) before treating the rest as the candidate - otherwise this is
      // genuinely free-form prose with no ACTION attempt, left as-is.
      const finalAnswerPrefixPattern = /ACTION:\s*final_answer\s*\(/;
      const prefixMatch = finalAnswerPrefixPattern.exec(content);
      const rawCandidate = prefixMatch
        ? content.slice(prefixMatch.index + prefixMatch[0].length).replace(/\)\s*$/, "")
        : content;

      const verdict = await evaluateProposedAnswer(rawCandidate.trim(), turn);

      if (verdict === "continue-loop") {
        continue;
      }

      // Bug fix (2026-07-15): this used to force stopped:"parse_error" here
      // regardless of the critic's verdict, discarding a genuinely good,
      // critic-approved answer just because the model skipped the
      // ACTION: final_answer(...) wrapper. Downstream (toValidationResult)
      // reads stopped === "final_answer" to decide whether an answer exists
      // at all - the override silently turned confirmed-good answers into
      // "insufficient-evidence", which skipped the LLM answer-polish pass
      // entirely and surfaced the raw, duplicated deterministic-fallback
      // template to the user instead. `verdict` already carries the correct
      // "final_answer" stopped value from evaluateProposedAnswer - trust it,
      // exactly like the explicit ACTION: final_answer(...) branch below does.
      return verdict;
    }

    messages.push({ role: "assistant", content });

    if (actions[0]?.tool === "final_answer") {
      // parseActions guarantees final_answer is alone when present.
      actionsLog.push(`[turn ${turn}] final_answer (proposed)`);
      const verdict = await evaluateProposedAnswer(actions[0].arg, turn);

      if (verdict === "continue-loop") {
        continue;
      }

      return verdict;
    }

    // Batch executed sequentially, not in parallel - a later action in the
    // same batch (e.g. read_file right after list_dir on its parent) must see
    // seenDirs/touchedFiles updates from earlier ones in this same turn, the
    // same ordering guarantee a single action always had.
    const observationBlocks: string[] = [];

    for (const action of actions) {
      let observation: string;

      if (action.tool === "list_dir") {
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
      } else if (action.tool === "request_verification") {
        // Phase 3 (2026-07-23, per the latency/quality plan): the Critic is
        // still ALWAYS run on every final_answer regardless (see
        // evaluateProposedAnswer) - this is additive agency on TOP of that
        // floor, not a replacement for it. It only changes which model does
        // the remaining thinking, and only ever moves in the same direction
        // the existing reactive (post-rejection) escalation already does -
        // it just lets the researcher ask for it proactively, with a
        // concrete stated reason, instead of only after a critic rejection.
        if (!options.researcherEscalationModel) {
          observation = "No escalation model is configured for this run - continue investigating and answering with what you have.";
        } else if (hasEscalated) {
          observation = `Already escalated to ${activeResearcherModel} earlier this run - continue with it, no further switch happens.`;
        } else {
          activeResearcherModel = options.researcherEscalationModel;
          hasEscalated = true;
          actionsLog.push(`[turn ${turn}] model-requested escalation to ${activeResearcherModel}: ${action.arg}`);
          observation = `Escalated to ${activeResearcherModel} for the rest of this investigation, because: ${action.arg}. Continue investigating with this in mind - a critic will still check your final answer either way.`;
        }
      } else {
        const parentDir = dirnameOf(action.arg);

        if (!seenDirs.has(parentDir)) {
          // Auto-perform the list_dir instead of just instructing the model
          // to do it next turn (2026-07-15 speed pass) - we already know
          // exactly which directory needs listing, so doing it now saves a
          // full round-trip instead of bouncing the model back empty-handed.
          const dirListing = await listDir(options.projectRoots, parentDir);
          seenDirs.add(normalizeDirKey(parentDir));
          observation = `You asked to read a file in the "${parentDir}" directory, which you have not listed yet - here is its content (a neighboring file with a similar name might answer more precisely); read the file you need as your next action:\n${dirListing}`;
        } else {
          observation = await readFile(options.projectRoots, action.arg);

          if (!observation.startsWith("Error")) {
            touchedFiles.add(toWorkspaceRelativePath(options.projectRoots, action.arg));
          }
        }
      }

      const observationPreview = observation.trim()
        ? observation.trim().replace(/\s+/g, " ").slice(0, ACTIONSLOG_PREVIEW_CHARS)
        : "";
      actionsLog.push(
        `[turn ${turn}] ${action.tool}(${action.arg}) -> ${observation.split("\n").length} lines`
        + (observationPreview ? `\n    preview: ${observationPreview}${observation.trim().length > ACTIONSLOG_PREVIEW_CHARS ? "..." : ""}` : ""),
      );

      const boundedObservation = observation.length > MAX_OBSERVATION_CHARS
        ? `${observation.slice(0, MAX_OBSERVATION_CHARS)}\n... (truncated)`
        : observation;

      observationBlocks.push(`ACTION ${action.tool}(${action.arg}):\n${boundedObservation}`);
    }

    const observationHeader = observationBlocks.length > 1 ? `OBSERVATIONS (${observationBlocks.length}):\n` : "OBSERVATION:\n";
    messages.push({ role: "user", content: observationHeader + observationBlocks.join("\n\n---\n\n") });

    const currentSurfaceSize = touchedFiles.size + seenDirs.size + grepTermsSeen.size;

    if (currentSurfaceSize === lastSurfaceSize) {
      stuckTurns += 1;
    } else {
      stuckTurns = 0;
      stuckNudgeSent = false;
      lastSurfaceSize = currentSurfaceSize;
    }

    if (stuckTurns >= STUCK_TURNS_THRESHOLD + 4) {
      // Nudged below and still no new ground covered several turns later -
      // genuinely stuck (not "thorough"), stop paying for it.
      actionsLog.push(`[turn ${turn}] SAFETY ABORT: no new directory/file/grep term for ${stuckTurns} turns straight.`);
      return finalize({ turnsUsed: turn, stopped: "max_turns" });
    }

    if (stuckTurns >= STUCK_TURNS_THRESHOLD && !stuckNudgeSent) {
      stuckNudgeSent = true;
      messages.push({
        role: "user",
        content: `${STUCK_TURNS_THRESHOLD} turns in a row now with no new directory/file/search term - it looks like you are stuck, not genuinely researching further. Give a final answer right now via ACTION: final_answer(...), based on what you have actually found, and honestly state what is missing - that is better than continuing to wander in circles.`,
      });
    }
  }

  return finalize({ turnsUsed: maxTurns, stopped: "max_turns" });
}
