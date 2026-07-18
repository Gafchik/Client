import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { normalizePath, stableId, type RepositoryChangedFile, type RepositorySnapshot, type WorkspaceSnapshot } from "@client/shared";

const execFileAsync = promisify(execFile);
const GIT_COMMAND_TIMEOUT_MS = 5_000;
// Worktree creation checks out the entire tree - on a large repo that is
// legitimately slower than the 5s budget of the read-only status commands
// above, and a timeout here aborts a development run before it starts.
const WORKTREE_COMMAND_TIMEOUT_MS = 120_000;

export async function inspectRepository(workspace: WorkspaceSnapshot): Promise<RepositorySnapshot> {
  const scannedAt = new Date().toISOString();
  const fallback = buildFallbackSnapshot(workspace, scannedAt);
  const gitRoot = await resolveGitRoot(workspace.rootPath);

  if (!gitRoot) {
    return {
      ...fallback,
      diagnostics: ["Git-репозиторий не найден. Historical repository intelligence недоступен."],
    };
  }

  const normalizedRoot = normalizePath(gitRoot);
  const [branch, headCommit, upstream, mergeBase, statusOutput] = await Promise.all([
    runGit(normalizedRoot, ["rev-parse", "--abbrev-ref", "HEAD"]),
    runGit(normalizedRoot, ["rev-parse", "HEAD"]),
    runGit(normalizedRoot, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]),
    resolveMergeBase(normalizedRoot),
    runGit(normalizedRoot, ["status", "--porcelain=v1"]),
  ]);

  const branchValue = normalizeGitValue(branch.stdout, "HEAD");
  const headValue = normalizeGitValue(headCommit.stdout, "unknown");
  const upstreamValue = upstream.ok ? normalizeGitValue(upstream.stdout, "") : "";
  const mergeBaseValue = mergeBase.ok ? normalizeGitValue(mergeBase.stdout, headValue) : headValue;
  const changedFiles = parsePorcelainStatus(statusOutput.stdout);
  const diagnostics = collectDiagnostics({
    branch: branchValue,
    upstream,
    mergeBase,
    status: statusOutput,
    changedFiles,
  });

  return {
    repositoryId: stableId(["repository", normalizedRoot]),
    projectId: workspace.projectId,
    rootPath: normalizedRoot,
    branch: branchValue,
    headCommit: headValue,
    headFingerprint: buildHeadFingerprint(normalizedRoot, branchValue, headValue, mergeBaseValue),
    mergeBase: mergeBaseValue,
    upstream: upstreamValue,
    stateFingerprint: buildRepositoryStateFingerprint(normalizedRoot, branchValue, headValue, mergeBaseValue, changedFiles),
    worktreeFingerprint: buildWorktreeFingerprint(changedFiles),
    branchFingerprint: stableId(["branch", normalizedRoot, branchValue, mergeBaseValue]),
    isGitRepository: true,
    isDirty: changedFiles.length > 0,
    isDetachedHead: branchValue === "HEAD",
    hasUnmergedPaths: changedFiles.some((file) => isConflictStatus(file)),
    hasUntrackedFiles: changedFiles.some((file) => file.scope === "untracked"),
    changedFiles,
    diagnostics,
    summary: buildRepositorySummary(changedFiles),
    scannedAt,
  };
}

async function resolveGitRoot(rootPath: string): Promise<string | null> {
  const result = await runGit(rootPath, ["rev-parse", "--show-toplevel"]);
  return result.ok ? normalizeGitValue(result.stdout, "") : null;
}

async function resolveMergeBase(rootPath: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const upstream = await runGit(rootPath, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);

  if (!upstream.ok) {
    return {
      ok: false,
      stdout: "",
      stderr: upstream.stderr,
    };
  }

  const upstreamRef = normalizeGitValue(upstream.stdout, "");

  if (!upstreamRef) {
    return {
      ok: false,
      stdout: "",
      stderr: "Upstream не определён.",
    };
  }

  return runGit(rootPath, ["merge-base", "HEAD", upstreamRef]);
}

export async function runGit(
  cwd: string,
  args: string[],
  timeoutMs: number = GIT_COMMAND_TIMEOUT_MS,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 8,
      timeout: timeoutMs,
    });

    return {
      ok: true,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string };

    return {
      ok: false,
      stdout: failed.stdout ?? "",
      stderr: failed.stderr ?? "",
    };
  }
}

function parsePorcelainStatus(output: string): RepositoryChangedFile[] {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean);

  const changedFiles: RepositoryChangedFile[] = [];

  for (const line of lines) {
    const status = line.slice(0, 2);
    const rawPath = line.slice(3);
    const renamedParts = rawPath.split(" -> ");
    const currentPath = normalizePath(renamedParts[renamedParts.length - 1] ?? rawPath);
    const previousPath = renamedParts.length > 1 ? normalizePath(renamedParts[0] ?? "") : undefined;
    const indexStatus = status[0] ?? " ";
    const workTreeStatus = status[1] ?? " ";

    if (status === "??") {
      changedFiles.push({
        path: currentPath,
        changeType: "untracked",
        scope: "untracked",
      });
      continue;
    }

    if (indexStatus !== " ") {
      changedFiles.push(withPreviousPath({
        path: currentPath,
        changeType: mapGitStatusToChangeType(indexStatus),
        scope: "staged",
      }, previousPath));
    }

    if (workTreeStatus !== " ") {
      changedFiles.push(withPreviousPath({
        path: currentPath,
        changeType: mapGitStatusToChangeType(workTreeStatus),
        scope: "unstaged",
      }, previousPath));
    }
  }

  return dedupeChangedFiles(changedFiles);
}

function dedupeChangedFiles(files: RepositoryChangedFile[]): RepositoryChangedFile[] {
  const map = new Map<string, RepositoryChangedFile>();

  for (const file of files) {
    const key = `${file.scope}:${file.changeType}:${file.previousPath ?? ""}:${file.path}`;
    map.set(key, file);
  }

  return Array.from(map.values()).sort((left, right) => left.path.localeCompare(right.path));
}

function withPreviousPath(
  file: Omit<RepositoryChangedFile, "previousPath">,
  previousPath?: string,
): RepositoryChangedFile {
  if (!previousPath) {
    return file;
  }

  return {
    ...file,
    previousPath,
  };
}

function mapGitStatusToChangeType(code: string): RepositoryChangedFile["changeType"] {
  switch (code) {
    case "A":
      return "added";
    case "M":
      return "modified";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    case "T":
      return "type-changed";
    case "U":
      return "unknown";
    default:
      return "unknown";
  }
}

function buildRepositorySummary(changedFiles: RepositoryChangedFile[]): RepositorySnapshot["summary"] {
  return {
    changedFileCount: changedFiles.length,
    stagedCount: changedFiles.filter((file) => file.scope === "staged").length,
    unstagedCount: changedFiles.filter((file) => file.scope === "unstaged").length,
    untrackedCount: changedFiles.filter((file) => file.scope === "untracked").length,
    deletedCount: changedFiles.filter((file) => file.changeType === "deleted").length,
    renamedCount: changedFiles.filter((file) => file.changeType === "renamed").length,
  };
}

function collectDiagnostics(input: {
  branch: string;
  upstream: { ok: boolean; stdout: string; stderr: string };
  mergeBase: { ok: boolean; stdout: string; stderr: string };
  status: { ok: boolean; stdout: string; stderr: string };
  changedFiles: RepositoryChangedFile[];
}): string[] {
  const diagnostics: string[] = [];

  if (input.branch === "HEAD") {
    diagnostics.push("Detached HEAD: планирование и release-context будут иметь пониженную уверенность.");
  }

  if (!input.upstream.ok) {
    diagnostics.push("Upstream ветка не определена или недоступна. Merge-base и divergence signals частично недоступны.");
  }

  if (!input.mergeBase.ok && input.upstream.ok) {
    diagnostics.push("Не удалось вычислить merge-base. Rollback и divergence analysis будут консервативными.");
  }

  if (!input.status.ok) {
    diagnostics.push("Не удалось прочитать git status. Working tree signals могут быть неполными.");
  }

  if ([input.upstream.stderr, input.mergeBase.stderr, input.status.stderr].some((message) => message.includes("timed out"))) {
    diagnostics.push("Одна или несколько git-команд превысили timeout. Repository snapshot построен в деградированном режиме, чтобы не блокировать question-run.");
  }

  if (input.changedFiles.some((file) => isConflictStatus(file))) {
    diagnostics.push("В репозитории обнаружены конфликтные изменения. Mutation execution должен быть заблокирован до ручного разрешения.");
  }

  if (input.changedFiles.some((file) => file.scope === "untracked")) {
    diagnostics.push("Есть untracked файлы. Planner должен учитывать, что рабочее дерево не полностью зафиксировано.");
  }

  return diagnostics;
}

function isConflictStatus(file: RepositoryChangedFile): boolean {
  return file.changeType === "unknown" && (file.scope === "staged" || file.scope === "unstaged");
}

function buildFallbackSnapshot(workspace: WorkspaceSnapshot, scannedAt: string): RepositorySnapshot {
  return {
    repositoryId: stableId(["repository", workspace.rootPath]),
    projectId: workspace.projectId,
    rootPath: workspace.rootPath,
    branch: "",
    headCommit: "",
    headFingerprint: stableId(["head", workspace.rootPath, "nogit"]),
    mergeBase: "",
    upstream: "",
    stateFingerprint: stableId(["repository-state", workspace.rootPath, "nogit"]),
    worktreeFingerprint: stableId(["worktree", workspace.rootPath, "clean"]),
    branchFingerprint: stableId(["branch", workspace.rootPath, "nogit"]),
    isGitRepository: false,
    isDirty: false,
    isDetachedHead: false,
    hasUnmergedPaths: false,
    hasUntrackedFiles: false,
    changedFiles: [],
    diagnostics: [],
    summary: {
      changedFileCount: 0,
      stagedCount: 0,
      unstagedCount: 0,
      untrackedCount: 0,
      deletedCount: 0,
      renamedCount: 0,
    },
    scannedAt,
  };
}

function normalizeGitValue(value: string, fallback: string): string {
  const trimmed = value.trim();
  return trimmed.length ? trimmed : fallback;
}

function buildWorktreeFingerprint(changedFiles: RepositoryChangedFile[]): string {
  if (changedFiles.length === 0) {
    return stableId(["worktree", "clean"]);
  }

  const parts = changedFiles
    .map((file) => `${file.scope}:${file.changeType}:${file.previousPath ?? ""}:${file.path}`)
    .sort();

  return stableId(["worktree", ...parts]);
}

function buildRepositoryStateFingerprint(
  rootPath: string,
  branch: string,
  headCommit: string,
  mergeBase: string,
  changedFiles: RepositoryChangedFile[],
): string {
  return stableId([
    "repository-state",
    rootPath,
    branch,
    headCommit,
    mergeBase,
    buildWorktreeFingerprint(changedFiles),
  ]);
}

function buildHeadFingerprint(
  rootPath: string,
  branch: string,
  headCommit: string,
  mergeBase: string,
): string {
  return stableId([
    "head",
    rootPath,
    branch,
    headCommit,
    mergeBase,
  ]);
}

export function deriveRepositoryScopedPaths(repository: RepositorySnapshot, workspace: WorkspaceSnapshot): string[] {
  const workspaceFiles = new Set(workspace.files.map((file) => normalizePath(file.relativePath)));
  const candidatePaths = new Set<string>();

  for (const changedFile of repository.changedFiles) {
    if (workspaceFiles.has(changedFile.path)) {
      candidatePaths.add(changedFile.path);
    }

    if (changedFile.previousPath && workspaceFiles.has(changedFile.previousPath)) {
      candidatePaths.add(changedFile.previousPath);
    }
  }

  return Array.from(candidatePaths).sort((left, right) => left.localeCompare(right));
}

export function deriveRepositoryLabel(rootPath: string): string {
  return path.basename(rootPath) || "repository";
}

export interface FileChurnSignal {
  /** How many commits touched this file within the lookback window. */
  commitCount: number;
  /** Of those, how many commit subjects look like a fix/bug/revert. */
  fixCommitCount: number;
}

const CHURN_LOOKBACK = "6 months ago";
// Generic commit-message keywords, not project-specific - the same
// principle already established elsewhere in this codebase.
const FIX_COMMIT_PATTERN = /\bfix|bug|hotfix|patch|revert|regression\b|исправ|баг\b|ошибк/i;
// \x01 as a line-prefix separator for commit subjects - distinguishes them
// from the file-path lines --name-only also prints, without needing a
// second git invocation per commit.
const CHURN_LOG_FORMAT = "%x01%s";

/**
 * Real risk signal from git history (2026-07-16, architecture review
 * finding: Impact's "risk" was previously just a proxy for blast-radius
 * size - file/symbol count thresholds - with no actual historical signal,
 * even though the repository is already being inspected for other reasons).
 * One `git log` call for the whole repo's recent history, not one per file -
 * a file's bug-fix-commit frequency is a genuine, historically-grounded risk
 * indicator that costs nothing extra to compute this way. Degrades to an
 * empty map (no risk signal, not a crash) on any git failure - matches this
 * package's existing fallback-snapshot philosophy for a non-git or
 * git-command-timeout case.
 */
export async function computeFileChurnSignals(rootPath: string): Promise<Map<string, FileChurnSignal>> {
  const signals = new Map<string, FileChurnSignal>();
  const result = await runGit(rootPath, ["log", `--since=${CHURN_LOOKBACK}`, "--name-only", `--format=${CHURN_LOG_FORMAT}`]);

  if (!result.ok) {
    return signals;
  }

  let currentIsFixCommit = false;

  for (const rawLine of result.stdout.split("\n")) {
    if (rawLine.startsWith("\x01")) {
      currentIsFixCommit = FIX_COMMIT_PATTERN.test(rawLine.slice(1));
      continue;
    }

    const filePath = rawLine.trim();

    if (!filePath) {
      continue;
    }

    const existing = signals.get(filePath) ?? { commitCount: 0, fixCommitCount: 0 };
    existing.commitCount += 1;

    if (currentIsFixCommit) {
      existing.fixCommitCount += 1;
    }

    signals.set(filePath, existing);
  }

  return signals;
}

/**
 * Isolated checkout for one development task in one physical repo
 * (docs/architecture/011-developer-pipeline.md, "изоляция"). The Developer
 * agent mutates ONLY the worktree - the user's own checkout (their branch,
 * their uncommitted changes, their IDE state) is never touched. Checkpoints
 * and rollback are plain git in this worktree, not a bespoke engine.
 */
export interface TaskWorktree {
  /** Original repo root the worktree was created from. */
  rootPath: string;
  /** The isolated checkout the Developer works in. */
  worktreePath: string;
  /** Task branch checked out in the worktree (exists in the original repo too). */
  branch: string;
  /** HEAD commit the worktree started from - the diff baseline. */
  startCommit: string;
}

export async function createTaskWorktree(rootPath: string, taskId: string, label: string): Promise<TaskWorktree> {
  const gitRoot = await resolveGitRoot(rootPath);

  if (!gitRoot) {
    throw new Error(`«${rootPath}» не является git-репозиторием — разработка без git-изоляции не запускается (нет безопасного отката).`);
  }

  const normalizedRoot = normalizePath(gitRoot);
  const head = await runGit(normalizedRoot, ["rev-parse", "HEAD"]);

  if (!head.ok) {
    throw new Error(`Не удалось определить HEAD в «${normalizedRoot}»: ${head.stderr.trim() || "git rev-parse HEAD failed"}. Возможно, репозиторий без единого коммита.`);
  }

  const startCommit = normalizeGitValue(head.stdout, "");
  const branch = `client/task-${taskId}`;
  // Outside the repo on purpose: a worktree directory inside the repo would
  // show up as an untracked dir in the user's own `git status` and get
  // picked up by their IDE/indexer.
  const worktreePath = normalizePath(path.join(os.tmpdir(), "client-task-worktrees", taskId, label));
  await fs.mkdir(path.dirname(worktreePath), { recursive: true });

  const added = await runGit(normalizedRoot, ["worktree", "add", "-b", branch, worktreePath, startCommit], WORKTREE_COMMAND_TIMEOUT_MS);

  if (!added.ok) {
    throw new Error(`Не удалось создать worktree для задачи: ${added.stderr.trim() || added.stdout.trim() || "git worktree add failed"}`);
  }

  return { rootPath: normalizedRoot, worktreePath, branch, startCommit };
}

/**
 * Full diff of everything the task changed, including newly created files.
 * Staging inside the throwaway worktree is safe by construction (nobody else
 * uses its index), and `diff --cached <startCommit>` stays correct even if
 * the Developer chose to commit intermediate checkpoints along the way.
 */
export async function collectWorktreeChanges(worktree: TaskWorktree): Promise<{ diff: string; changedFiles: string[] }> {
  const staged = await runGit(worktree.worktreePath, ["add", "-A"], WORKTREE_COMMAND_TIMEOUT_MS);

  if (!staged.ok) {
    return { diff: "", changedFiles: [] };
  }

  const [diffResult, namesResult] = await Promise.all([
    runGit(worktree.worktreePath, ["diff", "--cached", worktree.startCommit], WORKTREE_COMMAND_TIMEOUT_MS),
    runGit(worktree.worktreePath, ["diff", "--cached", "--name-only", worktree.startCommit], WORKTREE_COMMAND_TIMEOUT_MS),
  ]);

  return {
    diff: diffResult.ok ? diffResult.stdout : "",
    changedFiles: namesResult.ok
      ? namesResult.stdout.split("\n").map((line) => normalizePath(line.trim())).filter(Boolean)
      : [],
  };
}

export interface ApplyWorktreeDiffResult {
  applied: boolean;
  changedFiles: string[];
  error?: string;
}

/**
 * Applies a task worktree's diff directly onto the user's REAL checkout
 * (worktree.rootPath) as UNCOMMITTED changes - explicit, opt-in "bring
 * this into my current branch" action (2026-07-18, explicit product-owner
 * request: after 5 years of commercial experience they had never once
 * needed a git worktree and don't want to learn one now - they want to
 * give a task, hear "done", say "bring it into my branch", and review the
 * result as an ordinary uncommitted diff in their own IDE, same as any
 * other local edit). NEVER commits, NEVER pushes, NEVER touches the user's
 * branch pointer or index - purely `git apply` of the exact diff already
 * computed from the worktree. Safe by construction regardless of whatever
 * ELSE is uncommitted in the target checkout: `git apply --check` (a dry
 * run) is tried first, and git's own conflict detection refuses cleanly -
 * changing nothing - if the base has diverged too far to apply, rather
 * than partially applying or corrupting unrelated local changes.
 */
export async function applyWorktreeDiffToRoot(worktree: TaskWorktree): Promise<ApplyWorktreeDiffResult> {
  const { diff, changedFiles } = await collectWorktreeChanges(worktree);

  if (!diff.trim()) {
    return { applied: false, changedFiles: [], error: "Пустой diff - нечего заносить в ветку." };
  }

  const patchPath = path.join(os.tmpdir(), `client-apply-${Date.now()}-${Math.random().toString(36).slice(2)}.patch`);
  await fs.writeFile(patchPath, diff, "utf8");

  try {
    const check = await runGit(worktree.rootPath, ["apply", "--check", patchPath], WORKTREE_COMMAND_TIMEOUT_MS);

    if (!check.ok) {
      return {
        applied: false,
        changedFiles: [],
        error: check.stderr.trim() || "Diff не применяется без конфликтов к текущему состоянию ветки - вероятно, файлы успели измениться с момента старта задачи.",
      };
    }

    const apply = await runGit(worktree.rootPath, ["apply", patchPath], WORKTREE_COMMAND_TIMEOUT_MS);

    if (!apply.ok) {
      return {
        applied: false,
        changedFiles: [],
        error: apply.stderr.trim() || "git apply завершился с ошибкой после успешной проверки.",
      };
    }

    return { applied: true, changedFiles };
  } finally {
    await fs.unlink(patchPath).catch(() => {});
  }
}

export async function removeTaskWorktree(worktree: TaskWorktree, options?: { deleteBranch?: boolean }): Promise<void> {
  // Best-effort cleanup - a leftover worktree in tmpdir is an annoyance, not
  // a correctness problem, so failures here never mask the run's own result.
  await runGit(worktree.rootPath, ["worktree", "remove", "--force", worktree.worktreePath], WORKTREE_COMMAND_TIMEOUT_MS);
  await runGit(worktree.rootPath, ["worktree", "prune"], WORKTREE_COMMAND_TIMEOUT_MS);

  if (options?.deleteBranch) {
    await runGit(worktree.rootPath, ["branch", "-D", worktree.branch]);
  }

  // `worktree remove` only deletes worktreePath itself, never the wrapper
  // directory createTaskWorktree made for it (path.join(tmpdir, ..., taskId,
  // label)) - live evidence this session: manually found and removed a dozen+
  // of these empty husks in client-task-worktrees, three separate times. Only
  // removes it if genuinely empty (fs.rmdir, not rm -rf) - if anything
  // unexpected is still in there, leave it for a human to look at rather than
  // silently deleting it.
  await fs.rmdir(path.dirname(worktree.worktreePath)).catch(() => {});
}

export function shouldPreferSelectiveWorkspace(repository: RepositorySnapshot, workspace: WorkspaceSnapshot): boolean {
  if (workspace.summary.profile !== "large-repository") {
    return false;
  }

  if (!repository.isGitRepository) {
    return false;
  }

  if (repository.hasUnmergedPaths) {
    return false;
  }

  const changedPathCount = repository.summary.changedFileCount;

  return changedPathCount > 0 && changedPathCount <= 150;
}
