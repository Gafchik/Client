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

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
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
        temperature: resolveProviderTemperature(model, 0.1),
        max_tokens: maxCompletionTokens ?? MAX_COMPLETION_TOKENS,
        messages,
        ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
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

export async function callModel(
  providerBaseUrl: string,
  providerApiKey: string,
  model: string,
  messages: ChatMessage[],
  reasoningEffort?: string,
  maxCompletionTokens?: number,
): Promise<{ content: string; usage: ProviderUsage | null }> {
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= RATE_LIMIT_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await performCall(providerBaseUrl, providerApiKey, model, messages, reasoningEffort, maxCompletionTokens);
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
