import { promises as fs } from "node:fs";
import path from "node:path";
import { findComposeFile, findPublishedHostPort, parseEnvFile } from "./db-query-tool.js";

/**
 * HTTP dev-server resolution for the Tester role (2026-07-27, explicit
 * product-owner request - see db-query-tool.ts's docstring for the sibling
 * "db_query" tool this mirrors). Same "find this project's own running
 * thing from its own .env/docker-compose, never hardcode one project's
 * ports/URLs" pattern - execCommand/parseEnvFile/findComposeFile/
 * findPublishedHostPort/findRunningContainer are reused as-is from
 * db-query-tool.ts (they were always generic docker/env utilities, never
 * actually DB-specific).
 *
 * Unlike DB resolution, there is no universal env-var convention for
 * "which compose service is the web server" (DB resolution has DB_HOST to
 * anchor on) - this falls back to a best-effort common-name/port heuristic,
 * explicitly weaker than resolveDbConnectionPlan's - degrade silently
 * (return null, http_request simply not offered) rather than guess a wrong
 * URL and let the Tester "test" against nothing real.
 *
 * Safety (explicit product-owner decision, 2026-07-27): v1 tests LOCAL DEV
 * ONLY - isSafeTestTargetHost is a code-level gate (same "neither layer
 * trusts the other" stance as isReadOnlyQuery) that rejects any resolved
 * base URL that is not loopback/docker-local. There is no path in this
 * file that can ever resolve to a real remote/production host - production
 * testing is a deliberately separate, later decision (needs its own safety
 * design, e.g. a human-approval gate mirroring develop-loop.ts's sensitive
 * DB-command flow), not silently built in here.
 */

const HTTP_PROBE_TIMEOUT_MS = 4_000;
const HTTP_REQUEST_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BODY_CHARS = 8_000;
// Common web-server-shaped service/container names, tried in order - best
// guess, not a proven-generic mechanism the way DB_HOST-anchored resolution
// is. Ports preferred when scanning a compose file with no name match.
const COMMON_WEB_SERVICE_NAMES = ["webserver", "web", "app", "nginx", "api", "backend"];
const COMMON_HTTP_PORTS = new Set(["80", "8000", "8080", "3000"]);

export interface DevServerConnectionPlan {
  baseUrl: string;
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "0.0.0.0";
}

// Code-level gate (never trust the model, verify deterministically): only
// a loopback URL is ever considered safe to construct a plan for. This is
// checked again defensively at request-execution time too, not just at
// resolution time, in case a future change to this file's resolution
// logic ever accidentally returns something else.
export function isSafeTestTargetHost(baseUrl: string): boolean {
  try {
    const parsed = new URL(baseUrl);
    return isLoopbackHost(parsed.hostname);
  } catch {
    return false;
  }
}

async function probeHttp(baseUrl: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), HTTP_PROBE_TIMEOUT_MS);

    try {
      const response = await fetch(baseUrl, { signal: controller.signal, redirect: "manual" });
      // Any response at all (even a 4xx/5xx from the app itself) proves
      // something is actually listening - that is all a probe needs to
      // confirm, whether this specific app returns 200 at "/" or not.
      return response.status > 0;
    } finally {
      clearTimeout(timeoutId);
    }
  } catch {
    return false;
  }
}

async function resolveBackendDevServer(rootPath: string): Promise<DevServerConnectionPlan | null> {
  const env = await parseEnvFile(path.join(rootPath, ".env"));
  const appUrl = env.APP_URL ?? "";

  if (appUrl) {
    try {
      const parsed = new URL(appUrl);

      if (isLoopbackHost(parsed.hostname) && (await probeHttp(appUrl))) {
        return { baseUrl: appUrl.replace(/\/$/, "") };
      }
    } catch {
      // malformed APP_URL - fall through to compose-based discovery
    }
  }

  const composeFile = await findComposeFile(rootPath);

  if (!composeFile) {
    return null;
  }

  for (const serviceName of COMMON_WEB_SERVICE_NAMES) {
    const publishedPort = await findPublishedHostPort(composeFile, serviceName);

    if (publishedPort) {
      const candidate = `http://127.0.0.1:${publishedPort}`;

      if (await probeHttp(candidate)) {
        return { baseUrl: candidate };
      }
    }
  }

  // Last resort: scan every service block for ANY published port that
  // looks HTTP-shaped, in case the project uses a service name outside
  // COMMON_WEB_SERVICE_NAMES entirely (findPublishedHostPort needs a name
  // to anchor on, so this re-scans the raw file directly instead).
  let content: string;

  try {
    content = await fs.readFile(composeFile, "utf8");
  } catch {
    return null;
  }

  const portMatches = content.matchAll(/-\s*["']?(\d+):(\d+)["']?/g);

  for (const match of portMatches) {
    const hostPort = match[1] as string;

    if (COMMON_HTTP_PORTS.has(hostPort)) {
      const candidate = `http://127.0.0.1:${hostPort}`;

      if (await probeHttp(candidate)) {
        return { baseUrl: candidate };
      }
    }
  }

  return null;
}

async function resolveFrontendDevServer(rootPath: string): Promise<DevServerConnectionPlan | null> {
  let packageJsonRaw: string;

  try {
    packageJsonRaw = await fs.readFile(path.join(rootPath, "package.json"), "utf8");
  } catch {
    return null;
  }

  let devScript = "";

  try {
    const parsed = JSON.parse(packageJsonRaw) as { scripts?: Record<string, string> };
    devScript = parsed.scripts?.dev ?? "";
  } catch {
    return null;
  }

  const explicitPort = /(?:-p\s+|PORT=)(\d{2,5})/.exec(devScript)?.[1];
  const port = explicitPort ?? "3000";
  const candidate = `http://127.0.0.1:${port}`;

  return (await probeHttp(candidate)) ? { baseUrl: candidate } : null;
}

/**
 * Tries each project root in order, resolving by whatever that root
 * actually looks like (a Laravel-style .env+docker-compose backend vs a
 * Next.js-style package.json frontend) rather than assuming one shape for
 * every root - a multi-root project mixes both. Returns null (http_request
 * simply not offered, same "honest degradation" convention buildDbQueryTool
 * already uses) when nothing resolves/probes as actually reachable for
 * ANY in-scope root.
 */
export async function resolveDevServerPlan(rootPath: string): Promise<DevServerConnectionPlan | null> {
  const hasEnvFile = await fs.access(path.join(rootPath, ".env")).then(() => true).catch(() => false);

  if (hasEnvFile) {
    const backendPlan = await resolveBackendDevServer(rootPath);

    if (backendPlan) {
      return backendPlan;
    }
  }

  return resolveFrontendDevServer(rootPath);
}

export interface DevServerHttpRequestInput {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface DevServerHttpResult {
  status: number;
  headers: Record<string, string>;
  body: string;
  durationMs: number;
}

export async function executeHttpRequest(plan: DevServerConnectionPlan, input: DevServerHttpRequestInput): Promise<DevServerHttpResult> {
  if (!isSafeTestTargetHost(plan.baseUrl)) {
    // Defensive re-check (see file docstring) - should be unreachable in
    // practice since resolveDevServerPlan never returns a non-loopback
    // baseUrl, but this tool never trusts a value just because it looks
    // like it came from a trusted resolver.
    return { status: 0, headers: {}, body: "Error: refused - resolved base URL is not a local/loopback address.", durationMs: 0 };
  }

  const url = `${plan.baseUrl}${input.path.startsWith("/") ? "" : "/"}${input.path}`;
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), HTTP_REQUEST_TIMEOUT_MS);

  // Default Content-Type to application/json whenever a body is present and
  // the model didn't set one itself (2026-07-28, live bug: several models
  // sent a perfectly valid JSON-string body with NO Content-Type header at
  // all, and Laravel silently treats an unlabeled body as un-parseable -
  // every field comes back "required" even though the JSON was correct.
  // Two different models hit this independently; relying on every model to
  // remember this header is exactly the "trust model compliance" pattern
  // this codebase avoids elsewhere - default it instead).
  const hasContentTypeHeader = input.headers && Object.keys(input.headers).some((key) => key.toLowerCase() === "content-type");
  const requestHeaders = input.body && !hasContentTypeHeader ? { "Content-Type": "application/json", ...(input.headers ?? {}) } : input.headers;

  try {
    const response = await fetch(url, {
      method: input.method.toUpperCase(),
      ...(requestHeaders ? { headers: requestHeaders } : {}),
      ...(input.body ? { body: input.body } : {}),
      signal: controller.signal,
      redirect: "manual",
    });
    const bodyText = await response.text().catch(() => "");
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });

    return {
      status: response.status,
      headers,
      body: bodyText.length > MAX_RESPONSE_BODY_CHARS ? `${bodyText.slice(0, MAX_RESPONSE_BODY_CHARS)}\n... (truncated)` : bodyText,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      status: 0,
      headers: {},
      body: `Error: request failed - ${error instanceof Error ? error.message : String(error)}`,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Tries each project root in order and returns a ready-to-use tool
 * function for the FIRST root that resolves AND probes as reachable -
 * mirrors buildDbQueryTool's exact shape/degradation convention.
 */
export async function buildHttpRequestTool(originalRootPaths: string[]): Promise<((input: DevServerHttpRequestInput) => Promise<DevServerHttpResult>) | null> {
  for (const rootPath of originalRootPaths) {
    const plan = await resolveDevServerPlan(rootPath);

    if (plan) {
      return (input: DevServerHttpRequestInput) => executeHttpRequest(plan, input);
    }
  }

  return null;
}
