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

/**
 * Direct-checkout task session (2026-07-28, explicit product-owner decision
 * to drop worktree isolation - "так себе затея"): `worktreePath` deliberately
 * EQUALS `rootPath` - the Developer works straight in the user's own real
 * checkout, not a separate directory. This was a live, considered tradeoff,
 * not a shortcut: a separate worktree directory has no vendor/node_modules,
 * no .env (both gitignored, so `git worktree add` never brings them along),
 * and a different directory NAME than docker-compose's own project-name
 * convention expects - every one of these caused a real, live failure this
 * session (missing autoloader, "Database hosts array is empty", docker
 * commands that couldn't find the user's own running containers). None of
 * that exists once the Developer just works in the real directory. The
 * safety net moves from "can't touch the real thing" to "can touch it, but
 * commit/push/migrate are still blocked" (FORBIDDEN_COMMAND_PATTERN /
 * isSensitiveDbCommand in develop-loop.ts, both already independent of
 * worktree vs real-checkout) plus serialization (develop-runner.ts allows
 * only one active run per project root at a time - concurrent tasks writing
 * the same real files was the one thing worktrees were genuinely needed
 * for, and the product owner confirmed a single developer never works two
 * tasks on the same project at once anyway). `startCommit`/`branch` are kept
 * for the SAME diff-computation code collectWorktreeChanges already has
 * (`git diff --cached <startCommit>`) - not for isolation, just as the
 * before-snapshot a review diff is computed against.
 */
export async function createTaskSession(rootPath: string): Promise<TaskWorktree> {
  const gitRoot = await resolveGitRoot(rootPath);

  if (!gitRoot) {
    throw new Error(`«${rootPath}» не является git-репозиторием — разработка без git-истории не запускается (нет диффа для ревью).`);
  }

  const normalizedRoot = normalizePath(gitRoot);
  const head = await runGit(normalizedRoot, ["rev-parse", "HEAD"]);

  if (!head.ok) {
    throw new Error(`Не удалось определить HEAD в «${normalizedRoot}»: ${head.stderr.trim() || "git rev-parse HEAD failed"}. Возможно, репозиторий без единого коммита.`);
  }

  const startCommit = normalizeGitValue(head.stdout, "");
  const branchResult = await runGit(normalizedRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const branch = normalizeGitValue(branchResult.stdout, "HEAD");

  return { rootPath: normalizedRoot, worktreePath: normalizedRoot, branch, startCommit };
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

  await linkGitignoredDependencyDirs(normalizedRoot, worktreePath);

  return { rootPath: normalizedRoot, worktreePath, branch, startCommit };
}

// Reviewer's verify_in_transaction (php artisan tinker) and any run_command
// invocation of composer/npm/etc. found the worktree's own dependency
// directories simply missing (2026-07-28, live case: `vendor/autoload.php`
// absent, tinker unusable, Reviewer fell back to reading the diff only).
// `git worktree add` checks out only tracked files - vendor/node_modules are
// gitignored everywhere, so a fresh worktree never has them, and installing
// them per-task (composer install/npm install) would cost minutes per run
// for zero benefit (the task rarely touches dependencies themselves).
// Symlinking straight to the original checkout's already-installed copy is
// the same trick node/PHP projects already use for git-worktree-based
// workflows generally - read-only reference to real, current dependencies,
// no reinstall, no per-project naming assumption (these two names cover the
// overwhelming majority of PHP/Node projects generically, not any one
// project's own layout).
const GITIGNORED_DEPENDENCY_DIR_NAMES = ["vendor", "node_modules"];

async function linkGitignoredDependencyDirs(originalRoot: string, worktreePath: string): Promise<void> {
  for (const dirName of GITIGNORED_DEPENDENCY_DIR_NAMES) {
    const sourcePath = path.join(originalRoot, dirName);
    const targetPath = path.join(worktreePath, dirName);

    try {
      await fs.access(sourcePath);
    } catch {
      continue; // original checkout doesn't have this dependency dir either - nothing to link
    }

    try {
      await fs.access(targetPath);
      continue; // worktree already has something at this path (unlikely, but don't clobber it)
    } catch {
      // expected - proceed to link
    }

    try {
      await fs.symlink(sourcePath, targetPath, "dir");
    } catch {
      // best-effort only - a failed symlink (e.g. unsupported filesystem)
      // just means verify_in_transaction/run_command degrade to "no deps
      // available", never a reason to fail worktree creation itself.
    }
  }
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

  try {
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
  } finally {
    // Unstage again (2026-07-28, live bug found the moment worktree
    // isolation was dropped): `git add -A` above used to stage a
    // THROWAWAY worktree's own index, harmless since the whole directory
    // was disposable. With worktreePath now equal to the real checkout
    // (createTaskSession), leaving everything staged after every diff
    // computation - which happens repeatedly, once per turn, for the
    // WHOLE run - would silently leave the user's real git index in a
    // fully-staged state they never asked for, risking `git commit`
    // picking up more than they meant to. `git reset` unstages without
    // touching the working tree, so the actual file changes this run made
    // are untouched - only the index goes back to matching HEAD.
    await runGit(worktree.worktreePath, ["reset"], WORKTREE_COMMAND_TIMEOUT_MS);
  }
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

/**
 * Read another branch/commit/tag WITHOUT checking it out (2026-07-28,
 * explicit product-owner request: "клауд умеет смотреть как в другой ветке
 * без чекаута, наш проект тоже должен так уметь"). This matters MORE now
 * than it would have before today - with worktree isolation dropped (see
 * createTaskSession), the Developer works directly in the user's real
 * checkout, so an actual `git checkout other-branch` would swap out the
 * real working tree out from under whatever the task is doing. `git show`/
 * `git ls-tree`/`git diff <ref>` all read directly from git's object store
 * without touching a single file on disk - the working tree never moves.
 *
 * mode "content" - a file's content at that ref (git show <ref>:<path>).
 * mode "list" - a directory's entries at that ref (git ls-tree).
 * mode "diff" - diff between the CURRENT working tree and that ref, scoped
 * to one path (or the whole repo if path is "." or empty) - this is the
 * literal "compare with master" case.
 */
export async function readOtherBranch(
  rootPath: string,
  input: { ref: string; path: string; mode?: "content" | "list" | "diff" },
): Promise<string> {
  const mode = input.mode ?? "content";
  const cleanPath = input.path.replace(/^\/+/, "");

  if (mode === "diff") {
    const args = cleanPath && cleanPath !== "." ? ["diff", input.ref, "--", cleanPath] : ["diff", input.ref];
    const result = await runGit(rootPath, args, WORKTREE_COMMAND_TIMEOUT_MS);
    if (!result.ok) {
      return `Error: git diff against "${input.ref}" failed - ${result.stderr.trim() || "unknown ref, or not a git repository"}.`;
    }
    return result.stdout.trim() || "(no differences between the working tree and this ref for this path)";
  }

  if (mode === "list") {
    const result = await runGit(rootPath, ["ls-tree", "--name-only", `${input.ref}:${cleanPath}`], WORKTREE_COMMAND_TIMEOUT_MS);
    if (!result.ok) {
      return `Error: could not list "${cleanPath}" at ref "${input.ref}" - ${result.stderr.trim() || "path does not exist at this ref, or it is a file (try mode: \"content\")"}.`;
    }
    return result.stdout.trim() || "(empty directory at this ref)";
  }

  const result = await runGit(rootPath, ["show", `${input.ref}:${cleanPath}`], WORKTREE_COMMAND_TIMEOUT_MS);
  if (!result.ok) {
    return `Error: could not read "${cleanPath}" at ref "${input.ref}" - ${result.stderr.trim() || "file does not exist at this ref, or it is a directory (try mode: \"list\")"}.`;
  }
  return result.stdout;
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
