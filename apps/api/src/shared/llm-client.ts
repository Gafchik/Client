interface BasicLogger {
  log?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
}

interface LlmRetryEvent {
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  reason: string;
  status?: number;
}

interface LlmRequestOptions {
  url: string;
  headers: Record<string, string>;
  body: string;
  logger?: BasicLogger;
  requestKey: string;
  maxAttempts?: number;
  timeoutMs?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  minSpacingMs?: number;
  onRetry?: (event: LlmRetryEvent) => Promise<void> | void;
}

const throttleState = new Map<string, { nextAllowedAt: number }>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function now(): number {
  return Date.now();
}

function withJitter(delayMs: number): number {
  const jitter = Math.floor(delayMs * (0.15 + Math.random() * 0.2));
  return delayMs + jitter;
}

function parseRetryAfterMs(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.max(0, Math.round(seconds * 1000));
  }
  const retryDate = Date.parse(value);
  if (Number.isFinite(retryDate)) {
    return Math.max(0, retryDate - now());
  }
  return null;
}

function parseResetHeaderMs(value: string | null): number | null {
  if (!value) return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  const asMs = numeric > 10_000_000_000 ? numeric : numeric * 1000;
  return Math.max(0, Math.round(asMs - now()));
}

function getHeaderDelayMs(headers: Headers): number | null {
  return (
    parseRetryAfterMs(headers.get("retry-after"))
    ?? parseResetHeaderMs(headers.get("x-ratelimit-reset"))
    ?? parseResetHeaderMs(headers.get("ratelimit-reset"))
    ?? null
  );
}

function shouldRetryStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function describeStatus(status: number): string {
  if (status === 429) return "rate limit";
  if (status >= 500) return "provider temporary failure";
  if (status === 408) return "request timeout";
  if (status === 409) return "provider conflict";
  if (status === 425) return "provider asked to retry later";
  return `HTTP ${status}`;
}

async function waitForThrottleWindow(requestKey: string, minSpacingMs: number): Promise<void> {
  const state = throttleState.get(requestKey);
  const nextAllowedAt = state?.nextAllowedAt ?? 0;
  const waitMs = Math.max(0, nextAllowedAt - now());
  if (waitMs > 0) {
    await sleep(waitMs);
  }
  throttleState.set(requestKey, { nextAllowedAt: now() + minSpacingMs });
}

function markThrottleWindow(requestKey: string, delayMs: number): void {
  const current = throttleState.get(requestKey)?.nextAllowedAt ?? 0;
  const candidate = now() + Math.max(0, delayMs);
  throttleState.set(requestKey, { nextAllowedAt: Math.max(current, candidate) });
}

export async function createLlmStreamRequest(options: LlmRequestOptions): Promise<Response> {
  const {
    url,
    headers,
    body,
    logger,
    requestKey,
    maxAttempts = Number(process.env.LLM_RETRY_MAX_ATTEMPTS ?? 5),
    timeoutMs = Number(process.env.LLM_REQUEST_TIMEOUT_MS ?? 180_000),
    baseDelayMs = Number(process.env.LLM_RETRY_BASE_DELAY_MS ?? 1_500),
    maxDelayMs = Number(process.env.LLM_RETRY_MAX_DELAY_MS ?? 30_000),
    minSpacingMs = Number(process.env.LLM_MIN_SPACING_MS ?? 350),
    onRetry,
  } = options;

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await waitForThrottleWindow(requestKey, minSpacingMs);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (response.ok) {
        return response;
      }

      const status = response.status;
      const rawBody = await response.text();
      const reason = describeStatus(status);

      if (!shouldRetryStatus(status) || attempt === maxAttempts) {
        throw new Error(`API request failed (${status}): ${rawBody}`);
      }

      const headerDelayMs = getHeaderDelayMs(response.headers);
      const backoffDelayMs = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt - 1));
      const delayMs = Math.max(headerDelayMs ?? 0, withJitter(backoffDelayMs));

      markThrottleWindow(requestKey, delayMs);
      logger?.warn?.(`LLM request ${requestKey} got ${status}; retrying in ${delayMs}ms (attempt ${attempt}/${maxAttempts})`);
      await onRetry?.({
        attempt,
        maxAttempts,
        delayMs,
        reason,
        status,
      });
      await sleep(delayMs);
      continue;
    } catch (error) {
      clearTimeout(timeout);
      const err = error instanceof Error ? error : new Error(String(error));
      lastError = err;

      const isAbort = err.name === "AbortError";
      const canRetry = attempt < maxAttempts;
      if (!canRetry) break;

      const delayMs = withJitter(Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt - 1)));
      markThrottleWindow(requestKey, delayMs);
      logger?.warn?.(`LLM request ${requestKey} failed (${isAbort ? "timeout" : err.message}); retrying in ${delayMs}ms (attempt ${attempt}/${maxAttempts})`);
      await onRetry?.({
        attempt,
        maxAttempts,
        delayMs,
        reason: isAbort ? "timeout" : err.message,
      });
      await sleep(delayMs);
    }
  }

  throw lastError ?? new Error(`LLM request ${requestKey} failed after retries`);
}
