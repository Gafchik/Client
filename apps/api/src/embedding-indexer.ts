import { promises as fs } from "node:fs";
import path from "node:path";
import { embedTexts } from "@client/ai";
import { IGNORED_DIRS } from "@client/agentic-research";
import { getCodeEmbeddingContentHashes, pruneCodeEmbeddings, upsertCodeEmbedding } from "@client/knowledge";
import { contentHash, normalizePath, type PathRole } from "@client/shared";
import { getCurrentProvider } from "./provider-store.js";
import { listProjects } from "./project-store.js";

// Semantic code search over an embeddings index (2026-07-16) - see
// project-state.md's docs-research entry. Whole-file granularity, not
// per-chunk: an MVP deliberately kept as simple as possible, matching how the
// rest of the codebase already caps file reads instead of chunking.
const EMBEDDING_MODEL = "qwen/qwen3-embedding-8b";
// Generic source-file extensions, not project-specific (this codebase's
// standing rule - see docs/state/project-state.md's INTENT_PROFILES note).
const CODE_EXTENSIONS = new Set([
  ".php", ".ts", ".tsx", ".js", ".jsx", ".vue", ".py", ".go", ".java", ".rb", ".cs",
]);
const MAX_FILE_CHARS_FOR_EMBEDDING = 8000;
const MAX_FILE_BYTES = 300_000;
// Live evidence (2026-07-16): a real project (magendamd_backend) has ~8300
// code files - at the original conservative pace (25 files/tick, 30s
// interval) a first full pass would take ~2.7 HOURS, during which
// semantic_search would mostly return noise for anything not embedded yet
// (confirmed live: a query for the CaseData relation-cases flow returned
// unrelated AcuNotes files simply because CaseData had not been reached yet).
// Raised aggressively - embeddings are a separate, cheap endpoint (0.1x
// token_multiplier, confirmed via /v1/models) from the heavily rate-limited
// chat models, so there is no shared-budget reason to throttle this hard.
const MAX_FILES_PER_TICK = 300;
const EMBEDDING_BATCH_SIZE = 20;
const DEFAULT_INTERVAL_MS = 10_000;

interface EmbeddingIndexerConfig {
  fallbackProviderBaseUrl: string;
  fallbackProviderApiKey: string;
  intervalMs?: number;
}

interface ResolvedProvider {
  baseUrl: string;
  apiKey: string;
}

let indexerTimer: NodeJS.Timeout | null = null;
let indexerRunning = false;

export function startEmbeddingIndexer(config: EmbeddingIndexerConfig): void {
  if (indexerTimer) {
    return;
  }

  const intervalMs = config.intervalMs ?? DEFAULT_INTERVAL_MS;
  void tick(config);
  indexerTimer = setInterval(() => {
    void tick(config);
  }, intervalMs);
  indexerTimer.unref?.();
}

export function stopEmbeddingIndexer(): void {
  if (!indexerTimer) {
    return;
  }

  clearInterval(indexerTimer);
  indexerTimer = null;
}

async function resolveProvider(config: EmbeddingIndexerConfig): Promise<ResolvedProvider> {
  try {
    const provider = await getCurrentProvider();
    if (provider) {
      return {
        baseUrl: provider.baseUrl || config.fallbackProviderBaseUrl,
        apiKey: provider.apiKey || config.fallbackProviderApiKey,
      };
    }
  } catch {
    // БД временно недоступна - используем bootstrap-фолбэк, не роняем tick.
  }

  return { baseUrl: config.fallbackProviderBaseUrl, apiKey: config.fallbackProviderApiKey };
}

async function tick(config: EmbeddingIndexerConfig): Promise<void> {
  if (indexerRunning) {
    return;
  }

  indexerRunning = true;

  try {
    const provider = await resolveProvider(config);

    if (!provider.baseUrl || !provider.apiKey) {
      return;
    }

    const projects = await listProjects();
    const allPaths = projects.flatMap((project) =>
      project.paths.map((projectPath) => ({ rootPath: normalizePath(projectPath.rootPath), role: projectPath.role })),
    );

    // Parallel across project paths (each is an independent tree + its own
    // embedding-model calls) - sequential awaiting here would make a
    // multi-sub-project monorepo (e.g. magendamd's 3 paths) index one at a
    // time for no reason, tripling the time to a usable first pass.
    await Promise.all(allPaths.map(({ rootPath, role }) => indexOneProject(rootPath, role, provider)));
  } catch (error) {
    // setInterval + void: an uncaught rejection here would be an unhandled
    // promise rejection that kills the whole process (same failure mode
    // documented in project-state-monitor.ts).
    console.warn("[embedding-indexer] tick failed, will retry next interval:", error);
  } finally {
    indexerRunning = false;
  }
}

async function walkCodeFiles(rootPath: string): Promise<string[]> {
  const results: string[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);

    for (const entry of entries) {
      if (entry.name.startsWith(".") || IGNORED_DIRS.has(entry.name)) {
        continue;
      }

      const absolute = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        await walk(absolute);
      } else if (CODE_EXTENSIONS.has(path.extname(entry.name))) {
        results.push(absolute);
      }
    }
  }

  await walk(rootPath);
  return results;
}

async function indexOneProject(rootPath: string, role: PathRole, provider: ResolvedProvider): Promise<void> {
  const absoluteFiles = await walkCodeFiles(rootPath);
  const relativeFiles = absoluteFiles.map((absolute) => normalizePath(path.relative(rootPath, absolute)));
  const indexState = await getCodeEmbeddingContentHashes(rootPath);

  const candidates: Array<{ relPath: string; content: string; hash: string }> = [];

  for (const [absolutePath, relPath] of absoluteFiles.map((absolute, i) => [absolute, relativeFiles[i] ?? ""] as const)) {
    if (candidates.length >= MAX_FILES_PER_TICK) {
      break;
    }

    const known = indexState[relPath];

    try {
      const stat = await fs.stat(absolutePath);

      if (stat.size > MAX_FILE_BYTES) {
        continue;
      }

      // Cheap pre-filter: if this file was embedded after it was last
      // modified on disk, it cannot have changed - skip the content read
      // entirely. Without this, every tick re-reads every file in the
      // project just to confirm nothing changed.
      if (known && stat.mtime.toISOString() <= known.updatedAt) {
        continue;
      }

      const content = await fs.readFile(absolutePath, "utf8");
      const hash = contentHash(content);

      if (known?.contentHash === hash) {
        continue;
      }

      candidates.push({ relPath, content: content.slice(0, MAX_FILE_CHARS_FOR_EMBEDDING), hash });
    } catch {
      continue;
    }
  }

  // Walk always covers the whole tree (cheap - readdir only), even though
  // embedding itself is bounded per tick - so pruning deleted/renamed files
  // stays correct regardless of how large the pending backlog is.
  await pruneCodeEmbeddings(rootPath, relativeFiles);

  const batches: Array<typeof candidates> = [];
  for (let i = 0; i < candidates.length; i += EMBEDDING_BATCH_SIZE) {
    batches.push(candidates.slice(i, i + EMBEDDING_BATCH_SIZE));
  }

  // Batches run concurrently (independent embedding calls) - during the
  // initial catch-up pass on a large project this is the difference between
  // minutes and hours to a usable index.
  await Promise.all(
    batches.map(async (batch) => {
      try {
        const vectors = await embedTexts({
          providerBaseUrl: provider.baseUrl,
          providerApiKey: provider.apiKey,
          embeddingModel: EMBEDDING_MODEL,
          texts: batch.map((item) => item.content),
        });

        await Promise.all(
          batch.map((item, index) => {
            const embedding = vectors[index];
            return embedding
              ? upsertCodeEmbedding({ projectRootPath: rootPath, filePath: item.relPath, contentHash: item.hash, embedding, role })
              : Promise.resolve();
          }),
        );
      } catch (error) {
        console.warn(`[embedding-indexer] batch embed failed for ${rootPath}:`, error);
      }
    }),
  );
}
