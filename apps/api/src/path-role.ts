import { promises as fs } from "node:fs";
import path from "node:path";
import type { PathRole } from "@client/shared";

async function readJsonIfExists(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function hasAnyDependency(pkg: Record<string, unknown>, names: string[]): boolean {
  const deps = { ...(pkg.dependencies as Record<string, unknown> | undefined), ...(pkg.devDependencies as Record<string, unknown> | undefined) };
  return names.some((name) => name in deps);
}

/**
 * Generic manifest-signature classifier (2026-07-16, multi-path unification) -
 * no project-specific names, same principle as the rest of this codebase
 * (see docs/state/project-state.md's "No project-specific hardcoding").
 * Cheap: at most a handful of file reads/stats per path, run once on
 * project save.
 */
export async function inferProjectPathRole(rootPath: string): Promise<PathRole> {
  // Any of these manifest/marker files is a strong, generic backend signal
  // regardless of which specific backend framework/language is in use.
  if (await readJsonIfExists(path.join(rootPath, "composer.json"))) {
    return "backend";
  }

  if (
    (await exists(path.join(rootPath, "go.mod")))
    || (await exists(path.join(rootPath, "Cargo.toml")))
    || ((await exists(path.join(rootPath, "manage.py"))) && (await exists(path.join(rootPath, "requirements.txt"))))
  ) {
    return "backend";
  }

  const packageJson = await readJsonIfExists(path.join(rootPath, "package.json"));

  if (!packageJson) {
    return "unknown";
  }

  const isDesktop =
    hasAnyDependency(packageJson, ["electron"])
    || (hasAnyDependency(packageJson, ["@quasar/app", "@quasar/app-vite", "@quasar/app-webpack"]) && (await exists(path.join(rootPath, "src-electron"))));

  if (isDesktop) {
    return "frontend-desktop";
  }

  // "next" is its own strong, generic signal (a Next.js app has neither
  // index.html nor a vite/angular config - just next.config.*) - checked
  // live against a real Next.js path that the marker-file list below
  // otherwise misclassified as "unknown".
  const isWebFrontend =
    hasAnyDependency(packageJson, ["next"])
    || (
      hasAnyDependency(packageJson, ["vue", "react", "@angular/core", "quasar", "@quasar/app-vite", "@quasar/app-webpack"])
      && (
        (await exists(path.join(rootPath, "index.html")))
        || (await exists(path.join(rootPath, "vite.config.js")))
        || (await exists(path.join(rootPath, "vite.config.ts")))
        || (await exists(path.join(rootPath, "angular.json")))
        || (await exists(path.join(rootPath, "next.config.js")))
        || (await exists(path.join(rootPath, "next.config.mjs")))
        || (await exists(path.join(rootPath, "next.config.ts")))
      )
    );

  if (isWebFrontend) {
    return "frontend-web";
  }

  if (typeof packageJson.bin !== "undefined") {
    return "cli";
  }

  return "unknown";
}
