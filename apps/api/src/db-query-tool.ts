import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Read-only DB inspection for the Developer/Researcher loops (2026-07-18,
 * docs/architecture/011-developer-pipeline.md §4.19 - explicit
 * product-owner request, from their own real workflow: "when I explore a
 * feature, I'd rather see a real row in the table than read an abstract
 * model description"; "when a bug is reported, I reproduce it, then look
 * at what actually got written to the DB, and work backward from there";
 * "for a complex SELECT, I iterate it directly against the DB until it's
 * right, then translate to the project's ORM convention"). None of this
 * pipeline had any DB read access before this - only run_command's own
 * shell, gated to block mutations, with no dedicated support for actually
 * finding/using the project's real database.
 *
 * Two-layer safety, explicit product-owner directive ("нужно
 * перестраховаться и на уровне кода и на уровне модели"): (1) code-level -
 * isReadOnlyQuery rejects anything that isn't a single SELECT/WITH/EXPLAIN/
 * SHOW statement, regardless of what the model asks for; (2) prompt-level -
 * the tool description told to the model states the same restriction, so a
 * well-behaved model does not even try. Neither layer trusts the other.
 */

const execFileAsync = promisify(execFile);
const DB_QUERY_TIMEOUT_MS = 20_000;
const DOCKER_DISCOVERY_TIMEOUT_MS = 8_000;
const MAX_QUERY_OUTPUT_CHARS = 6_000;

export type DbEngine = "postgres" | "mysql";

export interface DbConnectionPlan {
  engine: DbEngine;
  mode: "direct" | "docker-exec";
  host?: string;
  port?: string;
  containerId?: string;
  database: string;
  username: string;
  password: string;
}

async function execCommand(command: string, args: string[], timeoutMs: number, extraEnv?: Record<string, string>): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync(command, args, {
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024 * 4,
      env: { ...process.env, ...extraEnv },
    });
    return { ok: true, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string };
    return { ok: false, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
  }
}

async function parseEnvFile(envPath: string): Promise<Record<string, string>> {
  try {
    const content = await fs.readFile(envPath, "utf8");
    const env: Record<string, string> = {};

    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();

      if (!line || line.startsWith("#")) {
        continue;
      }

      const separatorIndex = line.indexOf("=");

      if (separatorIndex <= 0) {
        continue;
      }

      const key = line.slice(0, separatorIndex).trim();
      const value = line.slice(separatorIndex + 1).trim().replace(/^['"]|['"]$/g, "");
      env[key] = value;
    }

    return env;
  } catch {
    return {};
  }
}

function detectEngine(env: Record<string, string>): DbEngine | null {
  const connection = (env.DB_CONNECTION ?? env.DATABASE_CONNECTION ?? "").toLowerCase();

  if (connection.includes("pgsql") || connection.includes("postgres")) {
    return "postgres";
  }

  if (connection.includes("mysql") || connection.includes("mariadb")) {
    return "mysql";
  }

  const url = (env.DATABASE_URL ?? "").toLowerCase();

  if (url.startsWith("postgres")) {
    return "postgres";
  }

  if (url.startsWith("mysql")) {
    return "mysql";
  }

  return null;
}

// A bare service name ("db", "postgres", "mysql-primary") has no dots and
// isn't an IP literal - that combination is the practical tell for "this is
// a docker-compose service name, not a directly reachable host" (a real
// remote host like an RDS endpoint always has dots; "localhost"/"127.0.0.1"
// are handled separately as always-direct).
function looksLikeDockerServiceName(host: string): boolean {
  const normalized = host.toLowerCase();

  if (normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1") {
    return false;
  }

  return !host.includes(".") && !/^\d+\.\d+\.\d+\.\d+$/.test(host);
}

async function findComposeFile(rootPath: string): Promise<string | null> {
  for (const name of ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"]) {
    const candidate = path.join(rootPath, name);

    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // try next candidate
    }
  }

  return null;
}

/**
 * Best-effort, deliberately NOT a real YAML parser - line/indentation
 * scanning for one narrow question: does the named service publish a host
 * port? Ambiguous or unparseable input just returns null (falls back to
 * docker-exec, which works regardless of port publishing) rather than
 * risking a wrong port.
 */
async function findPublishedHostPort(composeFilePath: string, serviceName: string): Promise<string | null> {
  let content: string;

  try {
    content = await fs.readFile(composeFilePath, "utf8");
  } catch {
    return null;
  }

  const lines = content.split(/\r?\n/);
  const serviceHeaderPattern = new RegExp(`^(\\s*)${serviceName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\s*$`);
  let serviceIndent = -1;
  let inService = false;
  let inPorts = false;

  for (const line of lines) {
    if (!inService) {
      const match = serviceHeaderPattern.exec(line);

      if (match) {
        inService = true;
        serviceIndent = (match[1] as string).length;
      }

      continue;
    }

    const currentIndent = line.length - line.trimStart().length;

    if (line.trim() && currentIndent <= serviceIndent) {
      break; // left the service block
    }

    if (/^\s*ports:\s*$/.test(line)) {
      inPorts = true;
      continue;
    }

    if (inPorts) {
      const portLine = /^\s*-\s*["']?(\d+):(\d+)["']?/.exec(line);

      if (portLine) {
        return portLine[1] as string; // host-side port
      }

      if (line.trim() && !line.trim().startsWith("-")) {
        inPorts = false; // left the ports list
      }
    }
  }

  return null;
}

/**
 * Resolves the real running container for a docker-compose service - run
 * FROM the original project root (never a develop-loop worktree, whose
 * different directory name would make Compose treat it as an unrelated
 * project with no matching running containers) so `docker compose` picks
 * up the SAME project context the user's own containers are already
 * running under.
 */
async function findRunningContainer(rootPath: string, serviceName: string): Promise<string | null> {
  const v2 = await execCommand("docker", ["compose", "ps", "-q", serviceName], DOCKER_DISCOVERY_TIMEOUT_MS);
  const containerId = v2.ok ? v2.stdout.trim().split("\n")[0]?.trim() : "";

  if (containerId) {
    return containerId;
  }

  const v1 = await execCommand("docker-compose", ["ps", "-q", serviceName], DOCKER_DISCOVERY_TIMEOUT_MS);
  const legacyId = v1.ok ? v1.stdout.trim().split("\n")[0]?.trim() : "";
  return legacyId || null;
}

export async function resolveDbConnectionPlan(rootPath: string): Promise<DbConnectionPlan | null> {
  const env = await parseEnvFile(path.join(rootPath, ".env"));
  const engine = detectEngine(env);

  if (!engine) {
    return null;
  }

  const database = env.DB_DATABASE ?? "";
  const username = env.DB_USERNAME ?? "";
  const password = env.DB_PASSWORD ?? "";

  if (!database) {
    return null; // not enough to connect - degrade silently, db_query just won't be offered
  }

  const host = env.DB_HOST ?? "127.0.0.1";
  const port = env.DB_PORT ?? (engine === "postgres" ? "5432" : "3306");

  if (!looksLikeDockerServiceName(host)) {
    return { engine, mode: "direct", host, port, database, username, password };
  }

  const composeFile = await findComposeFile(rootPath);

  if (composeFile) {
    const publishedPort = await findPublishedHostPort(composeFile, host);

    if (publishedPort) {
      return { engine, mode: "direct", host: "127.0.0.1", port: publishedPort, database, username, password };
    }
  }

  const containerId = await findRunningContainer(rootPath, host);

  if (!containerId) {
    return null; // docker not available / container not running - degrade silently
  }

  return { engine, mode: "docker-exec", containerId, database, username, password };
}

// Single statement, read-only verbs only, no filesystem-adjacent functions
// that could exfiltrate/write data even from within a nominally read-only
// statement (COPY ... TO, INTO OUTFILE, pg_read_file, LOAD_FILE, dblink).
const READ_ONLY_QUERY_PATTERN = /^\s*(select|with|explain|show|desc|describe)\b/i;
// Widened (2026-07-19, full-project review): the leading-verb check alone
// lets a genuinely destructive statement through as long as it is wrapped
// in a SELECT - `SELECT pg_terminate_backend(pid)` starts with SELECT and
// matched none of the (exfiltration-focused) names below, despite killing a
// real connection. A denylist can never be complete against every
// side-effecting function in two SQL dialects, but the ones that are
// destructive/DoS-capable rather than merely "reads a file" belong here too
// - not just exfiltration, per the product owner's own "перестраховаться"
// (better safe) directive for this tool's code-level layer.
const DANGEROUS_QUERY_PATTERN = /\b(pg_read_file|pg_read_binary_file|lo_export|lo_import|lo_create|lo_unlink|dblink|dblink_exec|pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_rotate_logfile|pg_switch_wal|set_config|sleep|benchmark)\s*\(|into\s+outfile|into\s+dumpfile|load_file\b|copy\s+\S+\s+to\b/i;

export function isReadOnlyQuery(query: string): boolean {
  const trimmed = query.trim();

  if (!READ_ONLY_QUERY_PATTERN.test(trimmed)) {
    return false;
  }

  if (DANGEROUS_QUERY_PATTERN.test(trimmed)) {
    return false;
  }

  const withoutTrailingSemicolon = trimmed.replace(/;\s*$/, "");
  return !withoutTrailingSemicolon.includes(";");
}

function buildCliInvocation(plan: DbConnectionPlan, query: string): { command: string; args: string[]; env: Record<string, string> } {
  const psqlArgs = ["-X", "-t", "-A", "-U", plan.username, "-d", plan.database, "-c", query];
  const mysqlArgs = [`-u${plan.username}`, `-p${plan.password}`, plan.database, "-e", query];

  if (plan.mode === "docker-exec") {
    if (plan.engine === "postgres") {
      return { command: "docker", args: ["exec", "-e", `PGPASSWORD=${plan.password}`, plan.containerId as string, "psql", ...psqlArgs], env: {} };
    }

    return { command: "docker", args: ["exec", plan.containerId as string, "mysql", ...mysqlArgs], env: {} };
  }

  if (plan.engine === "postgres") {
    return {
      command: "psql",
      args: ["-h", plan.host as string, "-p", plan.port as string, ...psqlArgs],
      env: { PGPASSWORD: plan.password },
    };
  }

  return {
    command: "mysql",
    args: ["-h", plan.host as string, "-P", plan.port as string, ...mysqlArgs],
    env: {},
  };
}

export async function executeDbQuery(plan: DbConnectionPlan, query: string): Promise<string> {
  if (!isReadOnlyQuery(query)) {
    return "Error: db_query only allows a single read-only statement (SELECT/WITH/EXPLAIN/SHOW/DESCRIBE) - no mutations, no stacked statements, no file-system functions. This query was rejected before it ran.";
  }

  const invocation = buildCliInvocation(plan, query);
  const result = await execCommand(invocation.command, invocation.args, DB_QUERY_TIMEOUT_MS, invocation.env);
  const output = (result.stdout || result.stderr || "(empty result)").trim();

  if (!output) {
    return "(query ran, zero rows / no output)";
  }

  return output.length > MAX_QUERY_OUTPUT_CHARS
    ? `${output.slice(0, MAX_QUERY_OUTPUT_CHARS)}\n... (truncated at ${MAX_QUERY_OUTPUT_CHARS} chars - narrow the query or add LIMIT)`
    : output;
}

/**
 * Tries each project root in order (a multi-root project's DB config
 * typically lives in the backend root, not a frontend/gui/cli root) and
 * returns a ready-to-use tool function for the FIRST root that resolves a
 * connection. Returns null (feature simply unavailable, same "honest
 * degradation" convention as computeImpactPreview/findReferences) if no
 * root has a usable DB config or the DB isn't reachable.
 */
export async function buildDbQueryTool(originalRootPaths: string[]): Promise<((query: string) => Promise<string>) | null> {
  for (const rootPath of originalRootPaths) {
    const plan = await resolveDbConnectionPlan(rootPath);

    if (plan) {
      return (query: string) => executeDbQuery(plan, query);
    }
  }

  return null;
}
