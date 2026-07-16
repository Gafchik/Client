import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { normalizePath, type PathRole } from "@client/shared";

const execFileAsync = promisify(execFile);

const MAX_LIST_ENTRIES = 150;
const MAX_GREP_MATCHES = 25;
// Live evidence (2026-07-15): a real 6.5KB controller got silently truncated
// at 3000 chars, cutting off exactly the line that answered the question
// (Google-login branch setting email_verified_at) - the model read the file,
// just never saw the part that mattered. Ordinary controllers/services
// routinely exceed 3000 chars; the cap exists to bound cost, not to fit
// "typical" files.
const MAX_READ_FILE_CHARS = 7000;

export const IGNORED_DIRS = new Set([
  ".git", ".idea", ".vscode", ".client", "node_modules", "vendor", "dist", "build",
  "coverage", ".turbo", ".next", "storage", "bootstrap", "generated", "var", "logs", "log",
]);

/**
 * One physical repository within a (possibly multi-repo) project - e.g. a
 * Laravel API and a Vue/Quasar frontend that together make up one logical
 * product (2026-07-16, multi-path unification). `label` is the name the
 * project owner already gave the path when adding it (api/web/gui/cli) -
 * reused as-is for the virtual path prefix the model sees, rather than
 * inventing a new naming scheme. `role` is auto-detected (path-role.ts) and
 * surfaced to the model as a navigation hint, never as a hard restriction.
 */
export interface WorkspaceRoot {
  label: string;
  absolutePath: string;
  role: PathRole;
}

interface ResolvedPath {
  root: WorkspaceRoot;
  /** Path relative to root.absolutePath - "" means the root directory itself. */
  rest: string;
}

// Splits a model-provided virtual path ("web/src/boot/axios.js") into its
// leading root label and the remainder. "." / "" both mean "no specific
// root" - callers treat that as "list the roots themselves" (there is
// exactly one meaningful top level in a multi-root project: the set of
// repos, not a directory).
function splitVirtualPath(relPath: string): { label: string; rest: string } | null {
  const normalized = relPath.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "").trim();

  if (normalized === "" || normalized === ".") {
    return null;
  }

  const slashIndex = normalized.indexOf("/");
  return slashIndex === -1
    ? { label: normalized, rest: "" }
    : { label: normalized.slice(0, slashIndex), rest: normalized.slice(slashIndex + 1) };
}

function describeRoots(roots: WorkspaceRoot[]): string {
  return roots.map((root) => `${root.label} (${root.role})`).join(", ");
}

// The overwhelmingly common case is still a single-repo project (today: any
// project with exactly one path). For that case path resolution is
// IDENTICAL to the pre-multi-root behavior - no label, no prefix, "." lists
// the actual top-level directory - so existing single-repo projects and
// Observer's crawlUnit (always a single unit-relative root) see zero
// behavior change. The label-prefixed virtual-path convention only kicks in
// once a project genuinely has 2+ physical repos.
function resolvePath(roots: WorkspaceRoot[], relPath: string): ResolvedPath | "top-level" | null {
  if (roots.length === 1) {
    return { root: roots[0] as WorkspaceRoot, rest: relPath };
  }

  const split = splitVirtualPath(relPath);

  if (!split) {
    return "top-level";
  }

  const root = roots.find((candidate) => candidate.label === split.label);
  return root ? { root, rest: split.rest } : null;
}

// Canonicalizes any relative path a model wrote (possibly with "./",
// backslashes, or a trailing slash) into the exact same workspace-relative,
// forward-slash form `WorkspaceFile.relativePath`/`IndexedFile.filePath` use
// (packages/workspace resolves via path.relative(rootPath, absolutePath) then
// normalizePath - mirrored here exactly). This is the seam identified as the
// highest integration risk: packages/context matches evidence to file content
// via exact string equality, so any format drift silently drops content.
// Multi-root (2026-07-16): for a genuinely multi-repo project the canonical
// form gains a `label/` prefix - load-bearing there, since it disambiguates
// which physical repo a path belongs to when two repos share directory
// names like "src". Single-repo projects are completely unaffected.
export function toWorkspaceRelativePath(roots: WorkspaceRoot[], relPath: string): string {
  const resolved = resolvePath(roots, relPath);

  if (!resolved || resolved === "top-level") {
    return normalizePath(relPath);
  }

  const absolute = path.resolve(resolved.root.absolutePath, resolved.rest || ".");
  const withinRoot = normalizePath(path.relative(resolved.root.absolutePath, absolute));

  if (roots.length === 1) {
    return withinRoot;
  }

  return withinRoot === "." || withinRoot === "" ? resolved.root.label : `${resolved.root.label}/${withinRoot}`;
}

function resolveWithinRoot(root: WorkspaceRoot, rest: string): string | null {
  const resolvedRoot = path.resolve(root.absolutePath);
  const target = path.resolve(root.absolutePath, rest || ".");

  if (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}${path.sep}`)) {
    return null;
  }

  return target;
}

export async function listDir(roots: WorkspaceRoot[], relPath: string): Promise<string> {
  const resolved = resolvePath(roots, relPath);

  if (resolved === "top-level") {
    // Only reachable when roots.length > 1 - the model always sees the
    // repos listed first, never a bare filesystem listing that hides which
    // repo is which.
    return roots.map((root) => `[dir] ${root.label} (${root.role})`).join("\n");
  }

  if (!resolved) {
    return `Error: unknown root "${splitVirtualPath(relPath)?.label ?? relPath}". Top-level parts of this project are: ${describeRoots(roots)}.`;
  }

  const target = resolveWithinRoot(resolved.root, resolved.rest);

  if (!target) {
    return "Error: path is outside the project root.";
  }

  try {
    const entries = await fs.readdir(target, { withFileTypes: true });
    const filtered = entries
      .filter((entry) => !IGNORED_DIRS.has(entry.name) && !entry.name.startsWith("."))
      .slice(0, MAX_LIST_ENTRIES)
      .map((entry) => `${entry.isDirectory() ? "[dir] " : "[file]"} ${entry.name}`);

    return filtered.length > 0 ? filtered.join("\n") : "(empty directory)";
  } catch (error) {
    return `Error listing directory: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export async function grepContent(roots: WorkspaceRoot[], pattern: string): Promise<string> {
  try {
    // One ripgrep call across every repo at once (rg accepts multiple path
    // arguments natively) - a cross-repo question ("where does the frontend
    // call this endpoint") needs exactly this: a single ACTION that searches
    // both sides, not one grep per repo.
    const { stdout } = await execFileAsync("rg", [
      "-n",
      "-i",
      "--max-count", "2",
      "--glob", "!vendor/**",
      "--glob", "!node_modules/**",
      "--glob", "!storage/**",
      "--glob", "!.git/**",
      "--glob", "!bootstrap/cache/**",
      "--glob", "!dist/**",
      pattern,
      ...roots.map((root) => root.absolutePath),
    ], { maxBuffer: 10 * 1024 * 1024 });

    const lines = stdout
      .split("\n")
      .filter(Boolean)
      .slice(0, MAX_GREP_MATCHES)
      .map((line) => {
        if (roots.length === 1) {
          return line.replace(`${(roots[0] as WorkspaceRoot).absolutePath}/`, "").slice(0, 220);
        }

        const matchingRoot = roots.find((root) => line.startsWith(`${root.absolutePath}/`));
        const rewritten = matchingRoot ? line.replace(`${matchingRoot.absolutePath}/`, `${matchingRoot.label}/`) : line;
        return rewritten.slice(0, 220);
      });

    return lines.length > 0 ? lines.join("\n") : "(no matches)";
  } catch (error: unknown) {
    const err = error as { code?: number };
    if (err.code === 1) {
      return "(no matches)";
    }
    return `Error running grep: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export async function readFile(roots: WorkspaceRoot[], relPath: string): Promise<string> {
  const resolved = resolvePath(roots, relPath);

  if (resolved === "top-level" || !resolved) {
    return `Error: "${relPath}" is not a file inside any known root. Top-level parts of this project are: ${describeRoots(roots)}.`;
  }

  const target = resolveWithinRoot(resolved.root, resolved.rest);

  if (!target) {
    return "Error: path is outside the project root.";
  }

  try {
    const content = await fs.readFile(target, "utf8");
    return content.length > MAX_READ_FILE_CHARS
      ? `${content.slice(0, MAX_READ_FILE_CHARS)}\n... (truncated, ${content.length} chars total)`
      : content;
  } catch (error) {
    return `Error reading file: ${error instanceof Error ? error.message : String(error)}`;
  }
}

// On the profile-access question, every model guessed sibling filenames
// (ProfileService.php) inside a directory it had never listed, and as a
// result none of them ever saw ProfileAccessService.php sitting right next
// to it. Requiring the containing directory be listed before a guessed file
// inside it can be read closes that exact blind spot mechanically.
export function normalizeDirKey(relPath: string): string {
  const normalized = relPath.replace(/\\/g, "/").replace(/\/+$/, "").trim();
  return normalized === "" || normalized === "." ? "." : normalized;
}

export function dirnameOf(relPath: string): string {
  const normalized = relPath.replace(/\\/g, "/");
  const lastSlash = normalized.lastIndexOf("/");
  return lastSlash === -1 ? "." : normalizeDirKey(normalized.slice(0, lastSlash));
}
