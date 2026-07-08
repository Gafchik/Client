import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { normalizePath, stableId, type RepositoryChangedFile, type RepositorySnapshot, type WorkspaceSnapshot } from "@client/shared";

const execFileAsync = promisify(execFile);

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
    mergeBase: mergeBaseValue,
    upstream: upstreamValue,
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

async function runGit(
  cwd: string,
  args: string[],
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 8,
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
    mergeBase: "",
    upstream: "",
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
