import { resolveProviderTemperature } from "@client/shared";

// Extracted verbatim from loop.ts (2026-07-17, Developer pipeline) so the
// develop-loop can reuse the exact same provider-call/retry/backoff behavior
// the research loop has already proven live, instead of duplicating it.
// Matches packages/ai's documented provider-call convention (timeout,
// attempts, backoff) rather than inventing new constants - see
// packages/ai/src/index.ts's performProviderRequest.
// Live evidence (2026-07-15): claude-sonnet-4.6's very first turn on a real
// question exceeded the old 25s timeout, got aborted, and - because
// AbortError wasn't in isRetryableError's patterns - failed the ENTIRE run
// immediately with zero retries, zero files read, reported as "insufficient
// data" (a verdict about the model's research, when it was actually a
// one-off infra timeout). Raised for headroom and aborts are now retried
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
// Raised (2026-07-15) - the Observer's structured output (summary + up to 5
// mechanisms + up to 5 gotchas) and a fully-traced deep answer can both run
// long; a response truncated mid-generation before it closes
// "final_answer(...)" looks identical to an unbalanced-paren parse failure,
// and the real fix is not cutting it off to begin with.
export const MAX_COMPLETION_TOKENS = 4000;

export interface ProviderUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

// Native tool-calling (2026-07-26): confirmed live that rout.my (the
// provider gateway) already normalizes EVERY model - openai/gpt-5.4,
// anthropic/claude-opus-4.6, x-ai/grok-4.1-fast, deepseek/deepseek-v3.2, all
// tested directly - into the same OpenAI-style `tools`/`tool_calls` shape
// regardless of the underlying provider's own native format. No per-model
// adapter is needed; one shape works everywhere. This replaces the
// text-based "ACTION: name(args)" prompt protocol both agentic loops
// (loop.ts, develop-loop.ts) used to rely on, which live testing showed
// breaking down in two DIFFERENT model-specific ways once model choice
// moved beyond the couple of models the protocol was originally tuned
// against: grok-4.1-fast got stuck in a 30-turn loop failing to reproduce
// the exact <<<SEARCH/<<<REPLACE marker syntax, and deepseek-v3.2 started
// emitting garbled/malformed output specifically when transitioning from
// investigation to writing after a long run. A side-by-side test of the
// SAME task via native tool_calls (JSON-schema-validated by the API itself,
// no prompt-format-imitation possible) produced ZERO format errors on both
// gpt-5.4 and claude-opus-4.6.
export interface ToolCallFunction {
  name: string;
  arguments: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: ToolCallFunction;
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  // Optional (not just "") because a native tool-calling turn's assistant
  // message often has NO text content at all, only tool_calls - some
  // providers return null there, and sending "" back on the next turn where
  // a provider expects null/absent is itself a source of subtle protocol
  // mismatches worth avoiding.
  content?: string | null;
  /** Present on an assistant message that requested one or more tool calls instead of (or alongside) text. */
  tool_calls?: ToolCall[] | undefined;
  /** Required on a `role: "tool"` message - which tool_call this result answers. */
  tool_call_id?: string | undefined;
  /** Conventionally the tool name, mirrored back on a `role: "tool"` message - not required by every provider but harmless to include. */
  name?: string | undefined;
}

export function getStatusCode(error: unknown): number | null {
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
  reasoningEffort?: string,
  maxCompletionTokens?: number,
  tools?: ToolDefinition[],
): Promise<{ content: string; toolCalls: ToolCall[] | null; usage: ProviderUsage | null }> {
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
        temperature: resolveProviderTemperature(model, 0.1),
        max_tokens: maxCompletionTokens ?? MAX_COMPLETION_TOKENS,
        messages,
        ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
        ...(tools?.length ? { tools, tool_choice: "auto" } : {}),
      }),
    });

    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      throw new Error(`Provider request failed with ${response.status}${bodyText ? `: ${bodyText.slice(0, 300)}` : ""}`);
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> | null; tool_calls?: ToolCall[] } }>;
      usage?: ProviderUsage;
    };
    const rawContent = payload.choices?.[0]?.message?.content;
    const content = typeof rawContent === "string"
      ? rawContent
      : Array.isArray(rawContent)
        ? rawContent.map((part) => part.text ?? "").join("")
        : "";
    const toolCalls = payload.choices?.[0]?.message?.tool_calls ?? null;

    return { content, toolCalls, usage: payload.usage ?? null };
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function callModel(
  providerBaseUrl: string,
  providerApiKey: string,
  model: string,
  messages: ChatMessage[],
  reasoningEffort?: string,
  maxCompletionTokens?: number,
  tools?: ToolDefinition[],
): Promise<{ content: string; toolCalls: ToolCall[] | null; usage: ProviderUsage | null }> {
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= RATE_LIMIT_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await performCall(providerBaseUrl, providerApiKey, model, messages, reasoningEffort, maxCompletionTokens, tools);
    } catch (error) {
      lastError = error;

      const isRateLimited = getStatusCode(error) === 429;
      const maxAttempts = isRateLimited ? RATE_LIMIT_MAX_ATTEMPTS : PROVIDER_MAX_ATTEMPTS;

      if (!isRetryableError(error) || attempt >= maxAttempts) {
        throw error;
      }

      const baseBackoffMs = isRateLimited
        ? RATE_LIMIT_BASE_BACKOFF_MS * attempt
        : PROVIDER_BASE_BACKOFF_MS * attempt;
      // Random jitter (+/-20%) per rout.my's error-handling docs: several
      // runs can hit the same rate limit at once, and a purely deterministic
      // backoff makes them all retry in lockstep.
      const jitterMs = baseBackoffMs * 0.2 * (Math.random() * 2 - 1);
      await new Promise((resolve) => setTimeout(resolve, baseBackoffMs + jitterMs));
    }
  }

  throw lastError;
}
