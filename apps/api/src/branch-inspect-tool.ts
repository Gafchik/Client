import { readOtherBranch } from "@client/repository-git";
import type { WorkspaceRoot } from "@client/agentic-research";

/**
 * Multi-root wrapper around repository-git's readOtherBranch (2026-07-28) -
 * same "label: rest" convention run_command already uses for a multi-repo
 * project (tools.ts's runShellCommand), since a git ref is inherently
 * per-physical-repo - "master" means something different in each root of a
 * multi-root project, there is no sensible "try each root" fallback the way
 * db_query/http_request use (those resolve to whichever ONE root actually
 * has a working DB/dev-server; here every root always has SOME git history,
 * so silently picking the first one would silently answer about the wrong
 * repo half the time).
 */
export interface ReadOtherBranchInput {
  root?: string;
  ref: string;
  path: string;
  mode?: "content" | "list" | "diff";
}

export function buildReadOtherBranchTool(roots: WorkspaceRoot[]): (input: ReadOtherBranchInput) => Promise<string> {
  const isMultiRoot = roots.length > 1;

  return async (input: ReadOtherBranchInput): Promise<string> => {
    let target = roots[0] as WorkspaceRoot;

    if (isMultiRoot) {
      if (!input.root) {
        return `Error: this project has multiple parts - pass "root" as one of: ${roots.map((root) => root.label).join(", ")}.`;
      }

      const matched = roots.find((root) => root.label === input.root);

      if (!matched) {
        return `Error: unknown root "${input.root}" - known parts: ${roots.map((root) => root.label).join(", ")}.`;
      }

      target = matched;
    }

    return readOtherBranch(target.absolutePath, { ref: input.ref, path: input.path, ...(input.mode ? { mode: input.mode } : {}) });
  };
}
