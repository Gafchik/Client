import { expandRussianTechTransliteration, tokenize } from "@client/shared";
import { dirnameOf, grepContent, listDir, normalizeDirKey, readFile, toWorkspaceRelativePath } from "./tools.js";

// Matches packages/ai's documented provider-call convention (timeout,
// attempts, backoff) rather than inventing new constants - see
// packages/ai/src/index.ts's performProviderRequest.
// Live evidence (2026-07-15): claude-sonnet-4.6's very first turn on a real
// question exceeded the old 25s timeout, got aborted, and - because
// AbortError wasn't in isRetryableError's patterns - failed the ENTIRE run
// immediately with zero retries, zero files read, reported as "insufficient
// data" (a verdict about the model's research, when it was actually a
// one-off infra timeout). Raised for headroom (observations got bigger this
// same session, MAX_OBSERVATION_CHARS 3500->7000) and aborts are now retried
// like any other transient failure instead of killing the run outright.
const PROVIDER_REQUEST_TIMEOUT_MS = 45_000;
const PROVIDER_MAX_ATTEMPTS = 3;
const PROVIDER_BASE_BACKOFF_MS = 1_200;
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
// Live evidence (2026-07-15): every single business_graph_entries row across
// 4 real projects (67/67) turned out to be a stored 429 error message - the
// free Observer model's rate limit (~15 req/min, confirmed earlier this
// session) was blowing straight through 2 attempts at ~1.2s/2.4s backoff.
// 429 specifically gets a much more patient retry budget; other retryable
// statuses (500/502/503/504 - real server-side failures, not "you're going
// too fast") keep the original tight budget so a genuinely broken provider
// still fails fast instead of hanging a live interactive question.
const RATE_LIMIT_MAX_ATTEMPTS = 5;
const RATE_LIMIT_BASE_BACKOFF_MS = 5_000;

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
const MAX_COMPLETION_TOKENS = 2500;

export interface AgenticRunOptions {
  task: string;
  projectRootPath: string;
  researcherModel: string;
  criticModel: string;
  providerBaseUrl: string;
  providerApiKey: string;
  maxTurns?: number;
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
  stopped: "final_answer" | "max_turns" | "error" | "aborted";
  error?: string;
}

interface ProviderUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ParsedAction {
  tool: "list_dir" | "grep_content" | "read_file" | "final_answer";
  arg: string;
}

const SYSTEM_PROMPT = [
  "Ты — опытный senior fullstack разработчик, который исследует незнакомую кодовую базу, чтобы честно ответить на инженерный вопрос.",
  "У тебя есть инструменты. На каждом шаге вызывай РОВНО одно действие, последней строкой в ответе, в таком виде (без markdown-обрамления):",
  "ACTION: list_dir(относительный/путь)",
  "ACTION: grep_content(строка или regex для поиска по содержимому файлов)",
  "ACTION: read_file(относительный/путь/к/файлу.php)",
  "ACTION: final_answer(твой финальный ответ на человеческом языке, с указанием конкретных файлов, если ты их нашёл, или честное признание, что не нашёл)",
  "Перед ACTION можешь коротко (1-2 предложения) написать, что и зачем делаешь.",
  "Начинай с list_dir(\".\") если не знаешь структуру. Ищи буквальные, семантически близкие названия директорий/файлов — не только по-русски, а и переводы на английский.",
  "ВАЖНО: прежде чем читать конкретный файл в папке, которую ты ещё не листал (list_dir) в этом диалоге, сначала сделай list_dir этой папки. Соседний файл с похожим именем может оказаться тем самым, что реально отвечает на вопрос — угадывание имени файла вслепую эту находку пропускает.",
  "У тебя есть время подумать основательно. Не спеши с final_answer, пока не проверил все реалистичные места, включая соседние по смыслу файлы (например: Service рядом может быть не один — проверь директорию целиком).",
  "Когда готов — вызови final_answer один раз. Не выдумывай факты, которых не видел в observations. Если что-то не проверил — прямо скажи, что не проверил, а не утверждай наверняка.",
].join("\n");

const CRITIC_SYSTEM_PROMPT = [
  "Ты — независимый критик-валидатор (другая модель, не та, что исследовала код).",
  "Тебе дан: инженерный вопрос, полная стенограмма действий другой модели (какие файлы она смотрела и что видела), и её предложенный финальный ответ.",
  "Проверь строго: (1) каждое утверждение в ответе должно быть напрямую подтверждено тем, что реально есть в стенограмме - не выдумано и не додумано; (2) если ответ сам упоминает, что что-то 'нужно проверить' или 'не проверено', а по стенограмме видно, что это НЕ проверили перед финальным ответом - это повод отклонить; (3) если ответ уверенно утверждает что-то, для чего в стенограмме недостаточно оснований (например, только один файл из цепочки), это тоже повод отклонить.",
  "Ответь СТРОГО одной строкой: либо \"APPROVED\", либо \"REJECTED: <короткое конкретное указание, что именно нужно проверить перед тем как отвечать снова>\".",
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
const MAX_SEED_GREP_TERMS = 5;

function extractDistinctiveTokens(task: string): string[] {
  const candidates = task.match(DISTINCTIVE_TOKEN_PATTERN) ?? [];
  const seen = new Set<string>();
  const distinctive: string[] = [];

  for (const token of candidates) {
    const hasDigit = /\d/.test(token);
    const isAcronym = /^[A-Z]{2,6}$/.test(token);
    const isMixedCase = /[a-z]/.test(token) && /[A-Z]/.test(token) && token.length >= 3;

    if (!hasDigit && !isAcronym && !isMixedCase) {
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

async function buildSeedGrepObservation(projectRootPath: string, task: string): Promise<string> {
  const terms = [...new Set([...extractDistinctiveTokens(task), ...extractTransliteratedTokens(task)])].slice(
    0,
    MAX_SEED_GREP_TERMS,
  );

  if (terms.length === 0) {
    return "";
  }

  // Bounded per-term, not on the joined block - a fixed overall cap would
  // let noise in an earlier term's results push a later term's real matches
  // out of the budget entirely instead of just trimming each fairly.
  const perTermCap = Math.floor(MAX_OBSERVATION_CHARS / terms.length);
  const results = await Promise.all(
    terms.map(async (term) => {
      const raw = await grepContent(projectRootPath, term);
      const bounded = raw.length > perTermCap ? `${raw.slice(0, perTermCap)}\n... (truncated)` : raw;
      return `grep_content("${term}"):\n${bounded}`;
    }),
  );

  return [
    "Автоматический предварительный поиск по буквальным словам вопроса (до твоего первого хода). Это только отправная точка, не факт — но часто нужное лежит не там, где ожидаешь по названию папки (бизнес-термин из вопроса может быть полем/сущностью в коде, а не директорией), так что стоит свериться с этим перед тем как исследовать вслепую:",
    ...results,
  ].join("\n\n");
}

function getStatusCode(error: unknown): number | null {
  if (error instanceof Error) {
    const match = /^Provider request failed with (\d+)/.exec(error.message);
    return match ? Number(match[1]) : null;
  }
  return null;
}

function isRetryableError(error: unknown): boolean {
  const status = getStatusCode(error);

  if (status !== null) {
    return RETRYABLE_STATUS_CODES.has(status);
  }

  if (error instanceof Error && (error.name === "AbortError" || /aborted/i.test(error.message))) {
    return true;
  }

  return error instanceof Error && /fetch failed|ECONNRESET|ETIMEDOUT/i.test(error.message);
}

async function performCall(
  providerBaseUrl: string,
  providerApiKey: string,
  model: string,
  messages: ChatMessage[],
): Promise<{ content: string; usage: ProviderUsage | null }> {
  const endpoint = `${providerBaseUrl.replace(/\/$/, "")}/chat/completions`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PROVIDER_REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${providerApiKey}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        temperature: 0.1,
        max_tokens: MAX_COMPLETION_TOKENS,
        messages,
      }),
    });

    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      throw new Error(`Provider request failed with ${response.status}${bodyText ? `: ${bodyText.slice(0, 300)}` : ""}`);
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }>;
      usage?: ProviderUsage;
    };
    const rawContent = payload.choices?.[0]?.message?.content;
    const content = typeof rawContent === "string"
      ? rawContent
      : Array.isArray(rawContent)
        ? rawContent.map((part) => part.text ?? "").join("")
        : "";

    return { content, usage: payload.usage ?? null };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function callModel(
  providerBaseUrl: string,
  providerApiKey: string,
  model: string,
  messages: ChatMessage[],
): Promise<{ content: string; usage: ProviderUsage | null }> {
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= RATE_LIMIT_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await performCall(providerBaseUrl, providerApiKey, model, messages);
    } catch (error) {
      lastError = error;

      const isRateLimited = getStatusCode(error) === 429;
      const maxAttempts = isRateLimited ? RATE_LIMIT_MAX_ATTEMPTS : PROVIDER_MAX_ATTEMPTS;

      if (!isRetryableError(error) || attempt >= maxAttempts) {
        throw error;
      }

      const backoffMs = isRateLimited
        ? RATE_LIMIT_BASE_BACKOFF_MS * attempt
        : PROVIDER_BASE_BACKOFF_MS * attempt;
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }

  throw lastError;
}

// Models routinely ignore "call exactly one action" and emit several
// ACTION(...) calls back to back in one completion, sometimes with no
// newlines between them at all. This scans for the first "ACTION: tool("
// occurrence anywhere in the raw text and walks paren depth from there to
// find its matching close-paren (handles nested parens, e.g. grep regex
// groups) - everything after that point is discarded, whatever it is.
function parseAction(content: string): ParsedAction | null {
  const actionPattern = /ACTION:\s*(list_dir|grep_content|read_file|final_answer)\s*\(/;
  const match = actionPattern.exec(content);

  if (!match || match.index === undefined) {
    return null;
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
    return null;
  }

  let arg = content.slice(openParenIndex + 1, closeParenIndex).trim();

  if ((arg.startsWith('"') && arg.endsWith('"')) || (arg.startsWith("'") && arg.endsWith("'"))) {
    arg = arg.slice(1, -1);
  }

  return { tool, arg };
}

async function callCritic(input: {
  criticModel: string;
  providerBaseUrl: string;
  providerApiKey: string;
  task: string;
  transcript: string;
  proposedAnswer: string;
}): Promise<{ approved: boolean; reason: string; promptTokens: number; completionTokens: number }> {
  const messages: ChatMessage[] = [
    { role: "system", content: CRITIC_SYSTEM_PROMPT },
    {
      role: "user",
      content: [
        `Вопрос: ${input.task}`,
        "",
        "Стенограмма действий другой модели:",
        input.transcript,
        "",
        `Предложенный финальный ответ: ${input.proposedAnswer}`,
      ].join("\n"),
    },
  ];

  try {
    const { content, usage } = await callModel(input.providerBaseUrl, input.providerApiKey, input.criticModel, messages);
    const trimmed = content.trim();
    const approved = /^APPROVED/i.test(trimmed);
    const reasonMatch = /^REJECTED:\s*(.*)/is.exec(trimmed);

    return {
      approved,
      reason: approved ? "" : (reasonMatch?.[1]?.trim() || trimmed || "Критик отклонил ответ без указанной причины."),
      promptTokens: usage?.prompt_tokens ?? 0,
      completionTokens: usage?.completion_tokens ?? 0,
    };
  } catch (error) {
    // Critic being unavailable should not deadlock the run - approve by
    // default rather than silently rejecting forever.
    return {
      approved: true,
      reason: `Критик недоступен (${error instanceof Error ? error.message : String(error)}), ответ принят без проверки.`,
      promptTokens: 0,
      completionTokens: 0,
    };
  }
}

export async function runAgenticLoop(options: AgenticRunOptions): Promise<AgenticRunResult> {
  const maxTurns = options.maxTurns ?? DEFAULT_SAFETY_CEILING_TURNS;
  const priorTurnFiles = [...new Set(options.priorTurnFiles ?? [])];
  const priorTurnHint = priorTurnFiles.length > 0
    ? `\n\nВ предыдущей реплике этого диалога ты уже находил и читал такие файлы: ${priorTurnFiles.join(", ")}. Если новый вопрос продолжает ту же тему - начни с чтения этих файлов (read_file) вместо повторного исследования с нуля. Если вопрос явно про другое - проверь их актуальность или ищи заново, не полагайся на них вслепую.`
    : "";
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: `Проект: ${options.projectRootPath}\nВопрос: ${options.task}${priorTurnHint}` },
  ];

  const seedGrepObservation = await buildSeedGrepObservation(options.projectRootPath, options.task);

  if (seedGrepObservation) {
    messages.push({ role: "user", content: seedGrepObservation });
  }

  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  const actionsLog: string[] = [];
  const touchedFiles = new Set<string>();
  const seenDirs = new Set<string>([normalizeDirKey("."), ...priorTurnFiles.map((filePath) => dirnameOf(filePath))]);
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
  ): AgenticRunResult => ({
    finalAnswer: null,
    touchedFiles: [...touchedFiles],
    actionsLog,
    criticVerdict,
    criticRounds,
    totalPromptTokens,
    totalCompletionTokens,
    ...overrides,
  });

  async function evaluateProposedAnswer(candidate: string, turn: number): Promise<AgenticRunResult | "continue-loop"> {
    const criticResult = await callCritic({
      criticModel: options.criticModel,
      providerBaseUrl: options.providerBaseUrl,
      providerApiKey: options.providerApiKey,
      task: options.task,
      transcript: actionsLog.join("\n"),
      proposedAnswer: candidate,
    });
    totalPromptTokens += criticResult.promptTokens;
    totalCompletionTokens += criticResult.completionTokens;
    criticRounds += 1;

    if (criticResult.approved) {
      actionsLog.push(`[turn ${turn}] critic: APPROVED`);
      criticVerdict = criticRounds > 1 ? "rejected-once-then-accepted" : "approved";
      return finalize({ turnsUsed: turn, stopped: "final_answer", finalAnswer: candidate, criticVerdict, criticRounds });
    }

    actionsLog.push(`[turn ${turn}] critic: REJECTED - ${criticResult.reason}`);

    if (turn >= maxTurns) {
      criticVerdict = "rejected-budget-exhausted";
      return finalize({ turnsUsed: turn, stopped: "final_answer", finalAnswer: candidate, criticVerdict, criticRounds });
    }

    messages.push({
      role: "user",
      content: `Критик отклонил твой ответ: ${criticResult.reason}\nПроверь это и потом снова вызови final_answer.`,
    });

    return "continue-loop";
  }

  for (let turn = 1; turn <= maxTurns; turn += 1) {
    if (options.shouldAbort?.()) {
      actionsLog.push(`[turn ${turn}] ABORTED: yielding to a live interactive request.`);
      return finalize({ turnsUsed: turn, stopped: "aborted" });
    }

    let content: string;
    let usage: ProviderUsage | null;

    try {
      const result = await callModel(options.providerBaseUrl, options.providerApiKey, options.researcherModel, messages);
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

    if (totalPromptTokens + totalCompletionTokens >= RUN_TOKEN_SAFETY_LIMIT) {
      actionsLog.push(`[turn ${turn}] SAFETY ABORT: run exceeded ${RUN_TOKEN_SAFETY_LIMIT} tokens.`);
      return finalize({ turnsUsed: turn, stopped: "max_turns" });
    }

    const action = parseAction(content);

    if (!action) {
      actionsLog.push(`[turn ${turn}] NO ACTION PARSED (treated as implicit final answer). raw content: ${content.slice(0, 300)}`);
      messages.push({ role: "assistant", content });

      // The model may have genuinely tried ACTION: final_answer(...), but
      // parseAction's balanced-paren scanner never found a matching close
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

    if (action.tool === "final_answer") {
      actionsLog.push(`[turn ${turn}] final_answer (proposed)`);
      const verdict = await evaluateProposedAnswer(action.arg, turn);

      if (verdict === "continue-loop") {
        continue;
      }

      return verdict;
    }

    let observation: string;

    if (action.tool === "list_dir") {
      observation = await listDir(options.projectRootPath, action.arg);
      seenDirs.add(normalizeDirKey(action.arg));
    } else if (action.tool === "grep_content") {
      observation = await grepContent(options.projectRootPath, action.arg);
      grepTermsSeen.add(action.arg.toLowerCase());
    } else {
      const parentDir = dirnameOf(action.arg);

      if (!seenDirs.has(parentDir)) {
        observation = `Сначала посмотри содержимое папки: ACTION: list_dir(${parentDir}) - ты ещё не листал эту директорию, там может быть файл с похожим, но другим именем, отвечающий на вопрос точнее.`;
      } else {
        observation = await readFile(options.projectRootPath, action.arg);

        if (!observation.startsWith("Error")) {
          touchedFiles.add(toWorkspaceRelativePath(options.projectRootPath, action.arg));
        }
      }
    }

    actionsLog.push(`[turn ${turn}] ${action.tool}(${action.arg}) -> ${observation.split("\n").length} lines`);

    const boundedObservation = observation.length > MAX_OBSERVATION_CHARS
      ? `${observation.slice(0, MAX_OBSERVATION_CHARS)}\n... (truncated)`
      : observation;

    messages.push({ role: "user", content: `OBSERVATION:\n${boundedObservation}` });

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
        content: `Уже ${STUCK_TURNS_THRESHOLD} шагов подряд без новой директории/файла/поискового запроса — похоже, ты застрял, а не действительно основательно исследуешь. Дай финальный ответ прямо сейчас через ACTION: final_answer(...), опираясь на то, что реально нашёл, и честно укажи, чего не хватает — это лучше, чем продолжать блуждать по кругу.`,
      });
    }
  }

  return finalize({ turnsUsed: maxTurns, stopped: "max_turns" });
}
