import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { rgPath } from "@vscode/ripgrep";
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
    // Bootstrap fix (2026-07-17): was a bare "rg" command string, which
    // silently depended on ripgrep being separately installed as a system
    // binary (present on this machine via Homebrew, invisible in package.json
    // and undocumented anywhere) - a fresh clone on a machine without it
    // would have every grep_content ACTION fail, which is most of what the
    // agentic loop actually does. @vscode/ripgrep bundles a prebuilt binary
    // per platform as a real npm dependency, downloaded on `npm install` -
    // zero manual system-level setup step for whoever else runs this.
    const { stdout } = await execFileAsync(rgPath, [
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

export async function readFile(roots: WorkspaceRoot[], relPath: string, maxChars: number = MAX_READ_FILE_CHARS): Promise<string> {
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
    return content.length > maxChars
      ? `${content.slice(0, maxChars)}\n... (truncated, ${content.length} chars total)`
      : content;
  } catch (error) {
    return `Error reading file: ${error instanceof Error ? error.message : String(error)}`;
  }
}

// ---------------------------------------------------------------------------
// Mutation tools (2026-07-17, docs/architecture/011-developer-pipeline.md).
// Available ONLY to the develop-loop, which always points its WorkspaceRoots
// at throwaway git worktrees (packages/repository-git's createTaskWorktree) -
// never at the user's own checkout. Path traversal is blocked by the same
// resolveWithinRoot guard the read tools use; on top of that a small
// deny-list protects the pieces whose corruption would be silent and nasty
// even inside a worktree.

function resolveWritableTarget(roots: WorkspaceRoot[], relPath: string): { target: string } | { error: string } {
  const resolved = resolvePath(roots, relPath);

  if (resolved === "top-level" || !resolved) {
    return { error: `Error: "${relPath}" is not a path inside any known root. Top-level parts of this project are: ${describeRoots(roots)}.` };
  }

  const target = resolveWithinRoot(resolved.root, resolved.rest);

  if (!target) {
    return { error: "Error: path is outside the project root." };
  }

  const segments = resolved.rest.replace(/\\/g, "/").split("/").filter(Boolean);

  if (segments.some((segment) => segment === ".git")) {
    return { error: "Error: writing inside .git is not allowed." };
  }

  if (segments[segments.length - 1] === ".env") {
    return { error: "Error: writing .env is not allowed (secrets stay under human control). If the task needs a new env variable, change .env.example and mention it in your summary." };
  }

  return { target };
}

export async function writeFile(roots: WorkspaceRoot[], relPath: string, content: string): Promise<string> {
  const resolved = resolveWritableTarget(roots, relPath);

  if ("error" in resolved) {
    return resolved.error;
  }

  try {
    await fs.mkdir(path.dirname(resolved.target), { recursive: true });
    await fs.writeFile(resolved.target, content, "utf8");
    return `OK: wrote ${content.length} chars to ${relPath}.`;
  } catch (error) {
    return `Error writing file: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Exact-match search/replace edit. Deliberately requires uniqueness: with
 * read_file truncation in play, a full-file rewrite from a truncated read
 * would silently destroy the unseen tail - a targeted replace of a block the
 * model has actually SEEN cannot.
 */
// Small enough that a read_file already showed the WHOLE file, no
// truncation risk from a write_file full-overwrite - see editFile's
// occurrences===0 branch.
const SMALL_FILE_REWRITE_THRESHOLD = 1500;
const NEAREST_MATCH_HINT_MAX_LINES = 14;
// Below this, the "closest" file line shares too few words with the
// SEARCH block's anchor line to be a meaningful hint - showing it would
// mislead more than help (e.g. two unrelated one-word lines both scoring
// a spurious 1.0 on a near-empty token set).
const NEAREST_MATCH_MIN_SCORE = 0.4;

function tokenizeLine(line: string): Set<string> {
  return new Set(line.toLowerCase().split(/[^a-z0-9_]+/i).filter((token) => token.length >= 2));
}

function lineTokenOverlap(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) {
    return 0;
  }

  let shared = 0;

  for (const token of left) {
    if (right.has(token)) {
      shared += 1;
    }
  }

  return shared / Math.max(left.size, right.size);
}

/**
 * Live evidence (2026-07-18): against a real, denser file (392-line PHP
 * class), a run made 13+ consecutive failed edit_file attempts and burned
 * ~560K tokens before the run-level safety ceiling caught it, ZERO changes
 * delivered - the model kept blindly re-guessing a SEARCH block with no
 * signal about WHY each guess failed. A bare "not found" gives the model
 * nothing to correct against; showing the ACTUAL nearest content the file
 * has (found via simple line-level word-overlap against the SEARCH block's
 * first substantial line, not a heavy diff library) turns a blind retry
 * into an informed one. Returns "" when nothing meaningfully similar exists
 * (a real signal too - the code may not be where the model thinks it is).
 */
function findNearestMatchHint(content: string, search: string): string {
  const searchLines = search.split("\n");
  const anchorLine = searchLines.find((line) => line.trim().length >= 6)?.trim();

  if (!anchorLine) {
    return "";
  }

  const anchorTokens = tokenizeLine(anchorLine);

  if (anchorTokens.size === 0) {
    return "";
  }

  const fileLines = content.split("\n");
  let bestIndex = -1;
  let bestScore = 0;

  for (let i = 0; i < fileLines.length; i += 1) {
    const score = lineTokenOverlap(anchorTokens, tokenizeLine(fileLines[i] as string));

    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }

  if (bestIndex === -1 || bestScore < NEAREST_MATCH_MIN_SCORE) {
    return "\n\n(No line in the file closely resembles the first substantial line of your SEARCH block - this content may not be in this file at all, or your memory of it is far off. Consider read_file again from scratch.)";
  }

  const windowStart = Math.max(0, bestIndex - 3);
  const windowEnd = Math.min(fileLines.length, windowStart + NEAREST_MATCH_HINT_MAX_LINES);
  const snippet = fileLines
    .slice(windowStart, windowEnd)
    .map((line, offset) => `${windowStart + offset + 1}: ${line}`)
    .join("\n");

  return `\n\nThe closest similar content ACTUALLY in the file right now (around line ${bestIndex + 1}) is:\n${snippet}\n\nCompare this against your SEARCH block and adjust for the real differences (exact wording, whitespace, surrounding lines) - do not just retry the same guess.`;
}

function normalizeLineForMatch(line: string): string {
  return line.trim().replace(/\s+/g, " ");
}

interface TolerantMatchSpan {
  start: number;
  end: number;
}

/**
 * Whitespace-tolerant fallback for edit_file (2026-07-18, live evidence:
 * advisory error-message text - the nearest-match hint, the small-file
 * write_file suggestion - was NOT reliably followed across 3 real failed
 * runs on 2 real projects; the model kept retrying byte-exact edit_file
 * anyway). Rather than hoping another sentence of prompt text changes
 * behavior, this changes edit_file's actual matching semantics: only
 * consulted AFTER an exact match fails, compares content line-by-line with
 * leading/trailing whitespace trimmed and internal whitespace runs
 * collapsed - catches "the code is really there, the model just mis-typed
 * the indentation/spacing" without the risk of a fuzzy/substring match
 * (every SEARCH line must still equal its corresponding content line after
 * normalization, in order, and the window must be UNIQUE - a second
 * candidate window means "ambiguous", not "guess one").
 * Returns the exact character span of the ORIGINAL (non-normalized) text to
 * replace, so real formatting outside the matched span is untouched and
 * `replace` is inserted exactly as the model wrote it.
 */
// Blank lines at the very start/end of a SEARCH block are almost always a
// formatting artifact (a model accidentally leaving an extra blank line
// before the closing marker), not a meaningful requirement that the file
// have a matching blank line there - stripped before window-matching so
// that artifact alone does not turn an otherwise-good match into "not
// found" (live evidence, 2026-07-18: this exact shape happened on a
// one-line file with no trailing newline).
function trimBlankEdgeLines(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;

  while (start < end && lines[start]?.trim() === "") {
    start += 1;
  }

  while (end > start && lines[end - 1]?.trim() === "") {
    end -= 1;
  }

  return lines.slice(start, end);
}

function findWhitespaceTolerantMatch(content: string, search: string): TolerantMatchSpan | "ambiguous" | null {
  const contentLines = content.split("\n");
  const searchLines = trimBlankEdgeLines(search.split("\n"));
  const normalizedSearchLines = searchLines.map(normalizeLineForMatch);

  // An all-blank-after-normalization search block would "match" almost any
  // window of blank/whitespace-only lines - not a meaningful signal.
  if (normalizedSearchLines.every((line) => line.length === 0)) {
    return null;
  }

  const matchStarts: number[] = [];

  for (let start = 0; start + searchLines.length <= contentLines.length; start += 1) {
    let matchesHere = true;

    for (let offset = 0; offset < searchLines.length; offset += 1) {
      if (normalizeLineForMatch(contentLines[start + offset] as string) !== normalizedSearchLines[offset]) {
        matchesHere = false;
        break;
      }
    }

    if (matchesHere) {
      matchStarts.push(start);

      // A second candidate already makes it ambiguous - no need to scan
      // the rest of a potentially large file.
      if (matchStarts.length > 1) {
        return "ambiguous";
      }
    }
  }

  if (matchStarts.length === 0) {
    return null;
  }

  const matchStart = matchStarts[0] as number;
  const startOffset = contentLines.slice(0, matchStart).reduce((sum, line) => sum + line.length + 1, 0);
  const matchedLength = contentLines.slice(matchStart, matchStart + searchLines.length).join("\n").length;
  return { start: startOffset, end: startOffset + matchedLength };
}

export async function editFile(roots: WorkspaceRoot[], relPath: string, search: string, replace: string): Promise<string> {
  const resolved = resolveWritableTarget(roots, relPath);

  if ("error" in resolved) {
    return resolved.error;
  }

  let content: string;

  try {
    content = await fs.readFile(resolved.target, "utf8");
  } catch (error) {
    return `Error: cannot edit "${relPath}" - ${error instanceof Error ? error.message : String(error)}. Use write_file to create a new file.`;
  }

  const occurrences = content.split(search).length - 1;

  if (occurrences === 0) {
    // Whitespace-tolerant fallback (2026-07-18) - tried BEFORE giving up:
    // advisory error text alone (nearest-match hint, small-file write_file
    // suggestion) proved unreliable across 3 real failed runs on 2 real
    // projects, the model kept retrying byte-exact anyway. A unique
    // line-normalized match is precise enough to apply automatically rather
    // than just describing to the model.
    const tolerantMatch = findWhitespaceTolerantMatch(content, search);

    if (tolerantMatch && tolerantMatch !== "ambiguous") {
      try {
        const nextContent = content.slice(0, tolerantMatch.start) + replace + content.slice(tolerantMatch.end);
        await fs.writeFile(resolved.target, nextContent, "utf8");
        return `OK: edited ${relPath} via whitespace-tolerant match (your SEARCH block's whitespace/indentation did not exactly match the file, but the content matched after normalizing spacing - applied automatically). Replaced ${tolerantMatch.end - tolerantMatch.start} chars with ${replace.length}.`;
      } catch (error) {
        return `Error writing file: ${error instanceof Error ? error.message : String(error)}`;
      }
    }

    // Live evidence (2026-07-18, second real project): the earlier
    // nearest-match hint targets the "large, dense file" failure mode
    // (Magenda's 391-line class) - a SEPARATE failure mode showed up on a
    // real Slay run the same day: repeated failed edit_file attempts
    // against a ONE-LINE and a 21-line file. edit_file's exact-match
    // fragility is a deliberate tradeoff to avoid write_file's truncated-
    // read destructive-overwrite risk on LARGE files (see the system
    // prompt's "PREFER edit_file over write_file" guidance) - but that risk
    // does not exist for a small file a full read_file already showed in
    // full. Below the threshold, write_file is strictly safer AND simpler,
    // so say so explicitly instead of only ever pointing back at edit_file.
    const smallFileAdvice = content.length < SMALL_FILE_REWRITE_THRESHOLD
      ? `\n\nThis file is small (${content.length} chars, shown to you in full by read_file) - consider write_file to overwrite it completely instead of fighting edit_file's exact-match requirement.`
      : "";
    const ambiguousNote = tolerantMatch === "ambiguous"
      ? "\n\n(A whitespace-tolerant match found this content in MORE THAN ONE place - extend the SEARCH block with more surrounding lines to make it unique.)"
      : "";
    return `Error: SEARCH block not found in ${relPath}. The block must match the file content EXACTLY (including whitespace/indentation) - re-read the file (read_file) and retry with an exact excerpt.${ambiguousNote}${smallFileAdvice}${findNearestMatchHint(content, search)}`;
  }

  if (occurrences > 1) {
    return `Error: SEARCH block matches ${occurrences} places in ${relPath} - extend it with surrounding lines until it is unique, then retry.`;
  }

  try {
    await fs.writeFile(resolved.target, content.replace(search, replace), "utf8");
    return `OK: edited ${relPath} (replaced ${search.length} chars with ${replace.length}).`;
  } catch (error) {
    return `Error writing file: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export interface ShellCommandResult {
  command: string;
  exitCode: number;
  durationMs: number;
  output: string;
}

const RUN_COMMAND_TIMEOUT_MS = 180_000;
const MAX_COMMAND_OUTPUT_CHARS = 12_000;
// Not a security sandbox (the run executes on the same machine either way) -
// this catches the commands whose damage would land OUTSIDE the throwaway
// worktree, where git-based rollback cannot undo it.
//
// Temporary, deliberately conservative extra safety net (2026-07-17,
// explicit user request after live-testing this pipeline against a real
// production project on a Friday): every git write subcommand is blocked
// for the model, not just push. This costs the Developer nothing - the
// harness's own diff collection (packages/repository-git's
// collectWorktreeChanges) reads the worktree's plain working-tree state via
// `git add -A` + `git diff --cached`, called directly by our own code
// through a completely separate path (runGit in repository-git), never
// through this function - so the model never needed `git commit` (or any
// other write subcommand) to deliver its work in the first place.
// The extra caution is warranted beyond "push looked risky enough": a git
// worktree shares its object/ref database with the user's real checkout, so
// a command that LOOKS contained to "inside the worktree" is not always -
// e.g. `git branch -f master <sha>` or `git update-ref refs/heads/master
// <sha>` moves the SHARED master ref, not just the worktree's own throwaway
// branch. Revisiting this to something more permissive (e.g. allowing
// `git commit` inside the worktree once there is an accuracy track record)
// is a deliberate future decision - see
// docs/architecture/011-developer-pipeline.md.
const FORBIDDEN_COMMAND_PATTERN = /\bgit\s+(push|commit|merge|rebase|reset|checkout|switch|remote|worktree|filter-branch|reflog|update-ref|symbolic-ref|branch\s+(-[dDmMfF]|--delete|--force|--move)|tag\s+(-f|--force))\b|\bnpm\s+publish\b|\bsudo\b|\brm\s+(-[a-z]*\s+)*[/~]|\bmkfs\b|\bshutdown\b|\breboot\b/i;

export async function runShellCommand(roots: WorkspaceRoot[], rawArg: string): Promise<ShellCommandResult> {
  let command = rawArg.trim();
  let cwdRoot = roots[0] as WorkspaceRoot;

  if (roots.length > 1) {
    const colonIndex = command.indexOf(":");
    const label = colonIndex > 0 ? command.slice(0, colonIndex).trim() : "";
    const matched = roots.find((root) => root.label === label);

    if (!matched) {
      return {
        command,
        exitCode: 1,
        durationMs: 0,
        output: `Error: this project has multiple parts - prefix the command with the part label, e.g. "${(roots[0] as WorkspaceRoot).label}: npm test". Known parts: ${describeRoots(roots)}.`,
      };
    }

    cwdRoot = matched;
    command = command.slice(colonIndex + 1).trim();
  }

  if (!command) {
    return { command: rawArg, exitCode: 1, durationMs: 0, output: "Error: empty command." };
  }

  if (FORBIDDEN_COMMAND_PATTERN.test(command)) {
    return { command, exitCode: 1, durationMs: 0, output: "Error: this command is not allowed. Git write operations (commit/push/merge/rebase/reset/checkout/branch -f/...) are temporarily disabled for this pipeline - use write_file/edit_file to change code, run_command only to verify (tests/linter/build). Publish/sudo/destructive filesystem operations outside the worktree are also blocked." };
  }

  const startedAt = Date.now();

  try {
    const { stdout, stderr } = await execFileAsync("/bin/sh", ["-c", command], {
      cwd: cwdRoot.absolutePath,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: RUN_COMMAND_TIMEOUT_MS,
    });
    const output = `${stdout}${stderr ? `\n${stderr}` : ""}`.trim();
    return {
      command,
      exitCode: 0,
      durationMs: Date.now() - startedAt,
      output: output.length > MAX_COMMAND_OUTPUT_CHARS ? `${output.slice(-MAX_COMMAND_OUTPUT_CHARS)}\n... (truncated from start)` : output,
    };
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string; code?: number; killed?: boolean };
    const output = `${failed.stdout ?? ""}${failed.stderr ? `\n${failed.stderr}` : ""}`.trim()
      || (error instanceof Error ? error.message : String(error));
    return {
      command,
      exitCode: typeof failed.code === "number" ? failed.code : 1,
      durationMs: Date.now() - startedAt,
      // Failing output's TAIL is what carries the actual error message in
      // almost every build/test tool - keep the end, drop the start.
      output: `${failed.killed ? `(timed out after ${RUN_COMMAND_TIMEOUT_MS / 1000}s) ` : ""}${output.length > MAX_COMMAND_OUTPUT_CHARS ? `...\n${output.slice(-MAX_COMMAND_OUTPUT_CHARS)}` : output}`,
    };
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
