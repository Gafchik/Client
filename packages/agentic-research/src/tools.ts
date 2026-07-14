import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { normalizePath } from "@client/shared";

const execFileAsync = promisify(execFile);

const MAX_LIST_ENTRIES = 150;
const MAX_GREP_MATCHES = 25;
const MAX_READ_FILE_CHARS = 3000;

export const IGNORED_DIRS = new Set([
  ".git", ".idea", ".vscode", ".client", "node_modules", "vendor", "dist", "build",
  "coverage", ".turbo", ".next", "storage", "bootstrap", "generated", "var", "logs", "log",
]);

// Canonicalizes any relative path a model wrote (possibly with "./",
// backslashes, or a trailing slash) into the exact same workspace-relative,
// forward-slash form `WorkspaceFile.relativePath`/`IndexedFile.filePath` use
// (packages/workspace resolves via path.relative(rootPath, absolutePath) then
// normalizePath - mirrored here exactly). This is the seam identified as the
// highest integration risk: packages/context matches evidence to file content
// via exact string equality, so any format drift silently drops content.
export function toWorkspaceRelativePath(projectRoot: string, relPath: string): string {
  const absolute = path.resolve(projectRoot, relPath || ".");
  return normalizePath(path.relative(projectRoot, absolute));
}

function resolveWithinRoot(projectRoot: string, relPath: string): string | null {
  const resolvedRoot = path.resolve(projectRoot);
  const target = path.resolve(projectRoot, relPath || ".");

  if (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}${path.sep}`)) {
    return null;
  }

  return target;
}

export async function listDir(projectRoot: string, relPath: string): Promise<string> {
  const target = resolveWithinRoot(projectRoot, relPath);

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

export async function grepContent(projectRoot: string, pattern: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("rg", [
      "-n",
      "-i",
      "--max-count", "2",
      "--glob", "!vendor/*",
      "--glob", "!node_modules/*",
      "--glob", "!storage/*",
      "--glob", "!.git/*",
      "--glob", "!bootstrap/cache/*",
      pattern,
      projectRoot,
    ], { maxBuffer: 10 * 1024 * 1024 });

    const lines = stdout
      .split("\n")
      .filter(Boolean)
      .slice(0, MAX_GREP_MATCHES)
      .map((line) => line.replace(`${projectRoot}/`, "").slice(0, 220));

    return lines.length > 0 ? lines.join("\n") : "(no matches)";
  } catch (error: unknown) {
    const err = error as { code?: number };
    if (err.code === 1) {
      return "(no matches)";
    }
    return `Error running grep: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export async function readFile(projectRoot: string, relPath: string): Promise<string> {
  const target = resolveWithinRoot(projectRoot, relPath);

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
