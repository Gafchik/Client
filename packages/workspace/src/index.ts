import { promises as fs } from "node:fs";
import path from "node:path";
import {
  contentHash,
  normalizePath,
  ProjectFile,
  stableId,
  type LanguageId,
  type WorkspaceSnapshot,
} from "@client/shared";

const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".idea",
  ".client",
  "node_modules",
  "vendor",
  "dist",
  "build",
  "coverage",
  ".turbo",
  ".next",
  ".nuxt",
  "tmp",
  "temp",
]);

const IGNORED_FILE_PREFIXES = ["dump_"];
const MAX_FILE_SIZE_BYTES = 1024 * 1024;
const SUPPORTED_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".md",
  ".mdx",
  ".yaml",
  ".yml",
  ".sql",
  ".php",
  ".vue",
]);

export async function openWorkspace(rootPath: string): Promise<WorkspaceSnapshot> {
  const startedAt = new Date().toISOString();
  const normalizedRoot = normalizePath(path.resolve(rootPath));
  const files: ProjectFile[] = [];
  const ignoredPaths: string[] = [];
  const diagnostics: string[] = [];

  await walkDirectory(normalizedRoot, normalizedRoot, files, ignoredPaths, diagnostics);

  const languages: Record<string, number> = {};

  for (const file of files) {
    languages[file.language] = (languages[file.language] ?? 0) + 1;
  }

  return {
    projectId: stableId(["project", normalizedRoot]),
    projectName: path.basename(normalizedRoot),
    rootPath: normalizedRoot,
    scannedAt: startedAt,
    files,
    ignoredPaths,
    diagnostics,
    summary: {
      totalFiles: files.length,
      indexedFiles: files.length,
      languages,
    },
  };
}

export async function scanWorkspaceOverview(rootPath: string): Promise<{
  projectId: string;
  projectName: string;
  rootPath: string;
  scannedAt: string;
  summary: WorkspaceSnapshot["summary"];
}> {
  const scannedAt = new Date().toISOString();
  const normalizedRoot = normalizePath(path.resolve(rootPath));
  const summary = {
    totalFiles: 0,
    indexedFiles: 0,
    languages: {} as Record<string, number>,
  };

  await walkDirectorySummary(normalizedRoot, normalizedRoot, summary);

  return {
    projectId: stableId(["project", normalizedRoot]),
    projectName: path.basename(normalizedRoot),
    rootPath: normalizedRoot,
    scannedAt,
    summary,
  };
}

async function walkDirectory(
  rootPath: string,
  currentPath: string,
  files: ProjectFile[],
  ignoredPaths: string[],
  diagnostics: string[],
): Promise<void> {
  const entries = await fs.readdir(currentPath, { withFileTypes: true });

  for (const entry of entries) {
    const absolutePath = normalizePath(path.join(currentPath, entry.name));
    const relativePath = normalizePath(path.relative(rootPath, absolutePath));

    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORIES.has(entry.name)) {
        ignoredPaths.push(relativePath);
        continue;
      }

      await walkDirectory(rootPath, absolutePath, files, ignoredPaths, diagnostics);
      continue;
    }

    if (!entry.isFile()) {
      ignoredPaths.push(relativePath);
      continue;
    }

    if (entry.name === ".DS_Store" || IGNORED_FILE_PREFIXES.some((prefix) => entry.name.startsWith(prefix))) {
      ignoredPaths.push(relativePath);
      continue;
    }

    const language = detectLanguage(entry.name);

    if (language === "unknown") {
      ignoredPaths.push(relativePath);
      continue;
    }

    try {
      const stat = await fs.stat(absolutePath);

      if (stat.size > MAX_FILE_SIZE_BYTES) {
        ignoredPaths.push(relativePath);
        diagnostics.push(`Пропущен слишком большой файл ${relativePath}: ${stat.size} байт.`);
        continue;
      }

      const content = await fs.readFile(absolutePath, "utf8");

      files.push({
        id: stableId(["file", relativePath]),
        absolutePath,
        relativePath,
        extension: path.extname(entry.name).toLowerCase(),
        language,
        size: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        contentHash: contentHash(content),
        content,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown read error";
      diagnostics.push(`Failed to read ${relativePath}: ${message}`);
    }
  }
}

async function walkDirectorySummary(
  rootPath: string,
  currentPath: string,
  summary: WorkspaceSnapshot["summary"],
): Promise<void> {
  const entries = await fs.readdir(currentPath, { withFileTypes: true });

  for (const entry of entries) {
    const absolutePath = normalizePath(path.join(currentPath, entry.name));

    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORIES.has(entry.name)) {
        continue;
      }

      await walkDirectorySummary(rootPath, absolutePath, summary);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    if (entry.name === ".DS_Store" || IGNORED_FILE_PREFIXES.some((prefix) => entry.name.startsWith(prefix))) {
      continue;
    }

    const language = detectLanguage(entry.name);

    if (language === "unknown") {
      continue;
    }

    summary.totalFiles += 1;
    summary.indexedFiles += 1;
    summary.languages[language] = (summary.languages[language] ?? 0) + 1;
  }
}

function detectLanguage(fileName: string): LanguageId {
  const lowerName = fileName.toLowerCase();
  const extension = path.extname(lowerName);

  if (fileName === "Dockerfile" || lowerName.endsWith(".dockerfile")) {
    return "dockerfile";
  }

  if (!extension && !SUPPORTED_EXTENSIONS.has(extension)) {
    return "unknown";
  }

  switch (extension) {
    case ".ts":
    case ".tsx":
      return "typescript";
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs":
      return "javascript";
    case ".json":
      return "json";
    case ".md":
    case ".mdx":
      return "markdown";
    case ".yaml":
    case ".yml":
      return "yaml";
    case ".sql":
      return "sql";
    case ".php":
      return "php";
    case ".vue":
      return "vue";
    default:
      return "unknown";
  }
}
