import path from "node:path";
import ts from "typescript";
import { Engine as PhpEngine } from "php-parser";
import {
  normalizePath,
  stableId,
  contentHash,
  type IndexRelation,
  type IndexResult,
  type IndexSymbol,
  type IndexedFile,
  type LanguageId,
  type PipelineRunResult,
  type ProjectFile,
  type WorkspaceSnapshot,
} from "@client/shared";

interface IncrementalIndexOptions {
  previousRun?: PipelineRunResult | null;
  changedPaths?: string[];
  deletedPaths?: string[];
}

export async function runFullIndex(
  workspace: WorkspaceSnapshot,
  options: IncrementalIndexOptions = {},
): Promise<IndexResult> {
  const startedAt = new Date().toISOString();
  const symbols: IndexSymbol[] = [];
  const relations: IndexRelation[] = [];
  const files: IndexedFile[] = [];
  const diagnostics = [...workspace.diagnostics];
  const languages = { ...workspace.summary.languages };
  let unsupportedFiles = 0;
  let reusedFileCount = 0;
  let reusedSymbolCount = 0;
  let reusedRelationCount = 0;

  const previousIndex = options.previousRun?.runtimeCache?.index ?? null;
  const previousFileMap = new Map(previousIndex?.files.map((file) => [normalizePath(file.filePath), file]) ?? []);
  const previousSymbolsByFile = groupByFilePath(previousIndex?.symbols ?? []);
  const previousRelationsByFile = groupRelationsByFilePath(previousIndex?.relations ?? [], previousIndex?.symbols ?? []);
  const deletedPathSet = new Set((options.deletedPaths ?? []).map((value) => normalizePath(value)));
  const explicitChangedPathSet = new Set((options.changedPaths ?? []).map((value) => normalizePath(value)));

  const fileByRelativePath = new Map(workspace.files.map((file) => [normalizePath(file.relativePath), file]));

  for (const file of workspace.files) {
    try {
      const normalizedPath = normalizePath(file.relativePath);
      const previousFile = previousFileMap.get(normalizedPath);
      const canReuse =
        previousFile
        && !deletedPathSet.has(normalizedPath)
        && !explicitChangedPathSet.has(normalizedPath)
        && previousFile.contentHash === file.contentHash;

      if (canReuse) {
        const previousFileSymbols = previousSymbolsByFile.get(normalizedPath) ?? [];
        const previousFileRelations = previousRelationsByFile.get(normalizedPath) ?? [];
        files.push(previousFile);
        symbols.push(...previousFileSymbols);
        relations.push(...previousFileRelations);
        reusedFileCount += 1;
        reusedSymbolCount += previousFileSymbols.length;
        reusedRelationCount += previousFileRelations.length;
        continue;
      }

      const record = indexFile(file, fileByRelativePath);
      files.push(record.file);
      symbols.push(...record.symbols);
      relations.push(...record.relations);
    } catch (error) {
      unsupportedFiles += 1;
      const message = error instanceof Error ? error.message : "Unknown parsing error";
      diagnostics.push(`Failed to index ${file.relativePath}: ${message}`);
    }
  }

  const previousPaths = new Set(previousFileMap.keys());
  const currentPaths = new Set(workspace.files.map((file) => normalizePath(file.relativePath)));
  const deletedFiles = Array.from(previousPaths).filter((filePath) => !currentPaths.has(filePath) || deletedPathSet.has(filePath));
  const currentSymbolKeys = new Set(symbols.map((symbol) => buildSymbolStateKey(symbol)));
  const previousSymbols = previousIndex?.symbols ?? [];
  const previousSymbolKeys = new Set(previousSymbols.map((symbol) => buildSymbolStateKey(symbol)));
  const addedSymbols = countDifference(currentSymbolKeys, previousSymbolKeys);
  const removedSymbols = countDifference(previousSymbolKeys, currentSymbolKeys);
  const unchangedSymbols = countIntersection(currentSymbolKeys, previousSymbolKeys);
  const updatedSymbols = Math.max(0, currentSymbolKeys.size - unchangedSymbols - addedSymbols);
  const renamedFiles = (options.changedPaths ?? []).filter((filePath) => previousFileMap.has(normalizePath(filePath)) === false).length;
  const parseEligibleFiles = previousIndex ? workspace.files.length : 0;
  const reparsedFiles = workspace.files.length - reusedFileCount;

  return {
    manifest: {
      indexId: stableId(["index", workspace.projectId, startedAt]),
      ...(previousIndex ? { baseIndexId: previousIndex.manifest.indexId } : {}),
      mode: workspace.summary.selectionMode === "selective" ? "selective" : "full",
      startedAt,
      completedAt: new Date().toISOString(),
      projectId: workspace.projectId,
      fileCount: files.length,
      symbolCount: symbols.length,
      relationCount: relations.length,
      diagnosticsCount: diagnostics.length,
      reusedFileCount,
      reusedSymbolCount,
      reusedRelationCount,
      reindexedFileCount: reparsedFiles,
      deletedFileCount: deletedFiles.length,
      parseCache: {
        eligibleFiles: parseEligibleFiles,
        reusedFiles: reusedFileCount,
        reparsedFiles,
        invalidatedFiles: explicitChangedPathSet.size + deletedFiles.length,
        reason: previousIndex
          ? "Parse cache повторно использует неизменённые файлы по content hash и file path."
          : "Предыдущий индекс отсутствует, parse cache reuse недоступен.",
      },
      astCache: {
        eligibleFiles: parseEligibleFiles,
        reusedAstCount: reusedFileCount,
        rebuiltAstCount: reparsedFiles,
        invalidatedFiles: explicitChangedPathSet.size + deletedFiles.length,
        reason: previousIndex
          ? "AST cache повторно использует прежние структурные артефакты для неизменённых файлов."
          : "Предыдущий индекс отсутствует, AST cache reuse недоступен.",
      },
      symbolDiff: {
        changedFiles: explicitChangedPathSet.size,
        renamedFiles,
        deletedFiles: deletedFiles.length,
        addedSymbols,
        removedSymbols,
        updatedSymbols,
        unchangedSymbols,
        reusedSymbols: reusedSymbolCount,
      },
    },
    files,
    symbols,
    relations,
    diagnostics,
    stats: {
      languages,
      unsupportedFiles,
    },
  };
}

function indexFile(
  file: ProjectFile,
  fileByRelativePath: Map<string, ProjectFile>,
): {
  file: IndexedFile;
  symbols: IndexSymbol[];
  relations: IndexRelation[];
} {
  switch (file.language) {
    case "typescript":
    case "javascript":
      return extractScriptFile(file, fileByRelativePath);
    case "vue":
      return extractVueFile(file, fileByRelativePath);
    case "php":
      return extractPhpFile(file, fileByRelativePath);
    case "markdown":
      return extractMarkdownFile(file);
    case "json":
      return extractJsonFile(file);
    default:
      return {
        file: {
          fileId: file.id,
          filePath: file.relativePath,
          language: file.language,
          contentHash: file.contentHash,
          modifiedAt: file.modifiedAt,
          parseCacheKey: buildParseCacheKey(file),
          astFingerprint: buildAstFingerprint(file),
          symbolIds: [],
          imports: [],
        },
        symbols: [],
        relations: [],
      };
  }
}

// Vue SFC symbol extraction (2026-07-16, multi-path unification - onboarding
// Vue/Quasar frontend repos). Narrow scope on purpose: only pulls out the
// <script>/<script setup> block and reuses the existing generic TS/JS AST
// extractor on it - no <template>/directive analysis. Before this, .vue
// files got zero symbols (fell through indexFile's default case), which is
// harmless for the agentic Researcher (it reads files directly) but left the
// structural graph blind for an entire language. Only the FIRST <script>
// block is read - a Vue 3 file combining a plain <script> (e.g. for
// `defineOptions`) with a separate <script setup> is rare enough that
// handling just one is a reasonable simplification for this MVP.
function extractVueFile(
  file: ProjectFile,
  fileByRelativePath: Map<string, ProjectFile>,
): {
  file: IndexedFile;
  symbols: IndexSymbol[];
  relations: IndexRelation[];
} {
  const openTagMatch = /<script([^>]*)>/i.exec(file.content);

  if (!openTagMatch) {
    return {
      file: {
        fileId: file.id,
        filePath: file.relativePath,
        language: file.language,
        contentHash: file.contentHash,
        modifiedAt: file.modifiedAt,
        parseCacheKey: buildParseCacheKey(file),
        astFingerprint: buildAstFingerprint(file),
        symbolIds: [],
        imports: [],
      },
      symbols: [],
      relations: [],
    };
  }

  const scriptStart = openTagMatch.index + openTagMatch[0].length;
  const closeTagIndex = file.content.indexOf("</script>", scriptStart);
  const scriptContent = closeTagIndex === -1 ? file.content.slice(scriptStart) : file.content.slice(scriptStart, closeTagIndex);
  const langAttrMatch = /lang\s*=\s*["'](\w+)["']/i.exec(openTagMatch[1] ?? "");
  const scriptLanguage: LanguageId = langAttrMatch?.[1]?.toLowerCase() === "ts" || langAttrMatch?.[1]?.toLowerCase() === "typescript"
    ? "typescript"
    : "javascript";
  // Lines before the script content, so symbol line numbers stay accurate
  // against the REAL .vue file, not the extracted script substring.
  const lineOffset = (file.content.slice(0, scriptStart).match(/\n/g) ?? []).length;

  const result = extractScriptFile({ ...file, content: scriptContent, language: scriptLanguage }, fileByRelativePath);

  return {
    ...result,
    file: { ...result.file, filePath: file.relativePath, language: file.language, contentHash: file.contentHash, modifiedAt: file.modifiedAt },
    symbols: result.symbols.map((symbol) => ({ ...symbol, filePath: file.relativePath, language: file.language, line: symbol.line + lineOffset })),
  };
}

function extractScriptFile(
  file: ProjectFile,
  fileByRelativePath: Map<string, ProjectFile>,
): {
  file: IndexedFile;
  symbols: IndexSymbol[];
  relations: IndexRelation[];
} {
  const kind = file.language === "typescript" ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const sourceFile = ts.createSourceFile(file.relativePath, file.content, ts.ScriptTarget.Latest, true, kind);
  const symbols: IndexSymbol[] = [];
  const relations: IndexRelation[] = [];
  const imports: string[] = [];

  const addSymbol = (
    name: string,
    symbolKind: IndexSymbol["kind"],
    node: ts.Node,
    containerName?: string,
  ): IndexSymbol => {
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    const symbol: IndexSymbol = {
      id: stableId(["symbol", file.relativePath, symbolKind, containerName ?? "", name]),
      stableSymbolId: stableId(["stable-symbol", symbolKind, containerName ?? "", name]),
      name,
      kind: symbolKind,
      language: file.language,
      fileId: file.id,
      filePath: file.relativePath,
      line: line + 1,
    };

    if (containerName) {
      symbol.containerName = containerName;
    }

    symbols.push(symbol);
    relations.push({
      id: stableId(["declares", file.id, symbol.id]),
      type: "DECLARES",
      sourceId: file.id,
      targetId: symbol.id,
    });

    return symbol;
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text;
      imports.push(specifier);
      const resolvedTarget = resolveImportTarget(file.relativePath, specifier, fileByRelativePath);
      const targetId = resolvedTarget?.id ?? stableId(["dependency", specifier]);
      relations.push({
        id: stableId(["imports", file.id, targetId, specifier]),
        type: "IMPORTS",
        sourceId: file.id,
        targetId,
        metadata: {
          specifier,
          targetLabel: resolvedTarget?.relativePath ?? specifier,
          external: resolvedTarget ? "false" : "true",
        },
      });
    }

    if (ts.isClassDeclaration(node) && node.name) {
      const classSymbol = addSymbol(node.name.text, "class", node);

      if (node.heritageClauses) {
        for (const clause of node.heritageClauses) {
          for (const typeNode of clause.types) {
            const targetName = typeNode.expression.getText(sourceFile);
            const targetId = stableId(["dependency", targetName]);
            relations.push({
              id: stableId(["heritage", classSymbol.id, targetId, clause.token, targetName]),
              type: clause.token === ts.SyntaxKind.ExtendsKeyword ? "EXTENDS" : "IMPLEMENTS",
              sourceId: classSymbol.id,
              targetId,
              metadata: {
                targetLabel: targetName,
                external: "true",
              },
            });
          }
        }
      }

      for (const member of node.members) {
        if (ts.isMethodDeclaration(member) && member.name && ts.isIdentifier(member.name)) {
          const methodSymbol = addSymbol(member.name.text, "method", member, node.name.text);
          relations.push({
            id: stableId(["contains", classSymbol.id, methodSymbol.id]),
            type: "CONTAINS",
            sourceId: classSymbol.id,
            targetId: methodSymbol.id,
          });
        }
      }
    }

    if (ts.isInterfaceDeclaration(node)) {
      addSymbol(node.name.text, "interface", node);
    }

    if (ts.isEnumDeclaration(node)) {
      addSymbol(node.name.text, "enum", node);
    }

    if (ts.isFunctionDeclaration(node) && node.name) {
      addSymbol(node.name.text, "function", node);
    }

    if (ts.isTypeAliasDeclaration(node)) {
      addSymbol(node.name.text, "type", node);
    }

    if (ts.isVariableStatement(node) && isTopLevelNode(node.parent)) {
      for (const declaration of node.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          addSymbol(declaration.name.text, "variable", declaration);
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  // Convention-based FE->BE dependency detection (2026-07-17, architecture
  // review Tier 3): extracted as plain symbols with no relation of their own
  // here - matching them to the backend's Route:: symbols (extractPhpRoutes)
  // needs the full merged graph (frontend + backend, often different repos),
  // which doesn't exist yet at single-file index time. See
  // packages/graph's linkHttpCallsToRoutes for the matching pass.
  const httpCalls = extractFrontendHttpCalls(file);
  symbols.push(...httpCalls.symbols);
  relations.push(...httpCalls.relations);

  return {
    file: {
      fileId: file.id,
      filePath: file.relativePath,
      language: file.language,
      contentHash: file.contentHash,
      modifiedAt: file.modifiedAt,
      parseCacheKey: buildParseCacheKey(file),
      astFingerprint: buildAstFingerprint(file),
      symbolIds: symbols.map((symbol) => symbol.id),
      imports,
    },
    symbols,
    relations,
  };
}

// Matches axios/$http/api-style client calls: axios.post('/login', ...),
// this.$axios.get(`/users/${id}`), apiClient.delete("/users/1"). Restricted
// to identifiers that plausibly name an HTTP client (axios/api/http/client,
// case-insensitively) rather than matching ANY ".get("/post(" call - those
// words are common enough on plain objects/Maps that an unrestricted match
// would produce mostly noise.
const HTTP_CLIENT_CALL_PATTERN =
  /\b(?:\$?axios|\$?http|\w*[Aa]pi\w*|\w*[Cc]lient\w*)\s*\.\s*(get|post|put|patch|delete)\s*\(\s*(['"`])((?:(?!\2)[^\\]|\\.)*?)\2/g;
// Bare fetch('/path', { method: 'POST' }) - method defaults to GET per the
// Fetch API spec when the init object is absent or has no method field.
const FETCH_CALL_PATTERN = /\bfetch\s*\(\s*(['"`])((?:(?!\1)[^\\]|\\.)*?)\1(\s*,\s*\{[\s\S]{0,300}?\})?/g;
const FETCH_METHOD_PATTERN = /method\s*:\s*['"](\w+)['"]/;
// axios({ method: 'post', url: '/login' }) object-call form - key order is
// not guaranteed, so url/method are extracted independently from the same
// bounded window rather than assumed adjacent.
const AXIOS_OBJECT_CALL_PATTERN = /\baxios\s*\(\s*\{([\s\S]{0,300}?)\}\s*\)/g;
const AXIOS_OBJECT_URL_PATTERN = /\burl\s*:\s*(['"`])((?:(?!\1)[^\\]|\\.)*?)\1/;
const AXIOS_OBJECT_METHOD_PATTERN = /\bmethod\s*:\s*['"](\w+)['"]/;

function normalizeHttpCallPath(rawPath: string): string {
  const withoutQuery = rawPath.split("?")[0] ?? rawPath;
  const withParams = withoutQuery
    // JS template literal interpolation: `/users/${id}` -> /users/:param
    .replace(/\$\{[^}]*\}/g, ":param")
    // Laravel-style route placeholders, in case a shared helper mirrors backend paths: {id}/{id?} -> :param
    .replace(/\{[^}]*\}/g, ":param")
    // Vue-router style dynamic segments: :id -> :param (normalizes naming, not just braces)
    .replace(/:[A-Za-z_][A-Za-z0-9_]*/g, ":param");
  const collapsedSlashes = withParams.replace(/\/+/g, "/");
  const withLeadingSlash = collapsedSlashes.startsWith("/") ? collapsedSlashes : `/${collapsedSlashes}`;
  return withLeadingSlash.length > 1 && withLeadingSlash.endsWith("/") ? withLeadingSlash.slice(0, -1) : withLeadingSlash;
}

function getLineNumberAt(content: string, charIndex: number): number {
  let line = 1;

  for (let index = 0; index < charIndex && index < content.length; index += 1) {
    if (content[index] === "\n") {
      line += 1;
    }
  }

  return line;
}

function extractFrontendHttpCalls(file: ProjectFile): { symbols: IndexSymbol[]; relations: IndexRelation[] } {
  const symbols: IndexSymbol[] = [];
  const relations: IndexRelation[] = [];
  const content = file.content;
  const seen = new Set<string>();

  const addCall = (method: string, rawPath: string, charIndex: number): void => {
    // A literal string with no interpolation and no leading slash almost
    // never denotes an endpoint path in these call shapes (more often a
    // named event, a relative import, or unrelated string argument) - skip
    // rather than risk a false match.
    if (!rawPath || (!rawPath.startsWith("/") && !rawPath.includes("${"))) {
      return;
    }

    const normalizedPath = normalizeHttpCallPath(rawPath);
    const name = `${method.toUpperCase()} ${normalizedPath}`;
    const dedupeKey = `${name}@${charIndex}`;

    if (seen.has(dedupeKey)) {
      return;
    }

    seen.add(dedupeKey);

    const symbol: IndexSymbol = {
      id: stableId(["symbol", file.relativePath, "http-call", "", name, String(charIndex)]),
      stableSymbolId: stableId(["stable-symbol", "http-call", "", name]),
      name,
      kind: "http-call",
      language: file.language,
      fileId: file.id,
      filePath: file.relativePath,
      line: getLineNumberAt(content, charIndex),
      signature: rawPath,
    };

    symbols.push(symbol);
    relations.push({
      id: stableId(["declares", file.id, symbol.id]),
      type: "DECLARES",
      sourceId: file.id,
      targetId: symbol.id,
    });
  };

  for (const match of content.matchAll(HTTP_CLIENT_CALL_PATTERN)) {
    const method = match[1];
    const rawPath = match[3];

    if (method && rawPath !== undefined && match.index !== undefined) {
      addCall(method, rawPath, match.index);
    }
  }

  for (const match of content.matchAll(FETCH_CALL_PATTERN)) {
    const rawPath = match[2];
    const optionsBlock = match[3] ?? "";
    const method = FETCH_METHOD_PATTERN.exec(optionsBlock)?.[1] ?? "GET";

    if (rawPath !== undefined && match.index !== undefined) {
      addCall(method, rawPath, match.index);
    }
  }

  for (const match of content.matchAll(AXIOS_OBJECT_CALL_PATTERN)) {
    const block = match[1] ?? "";
    const url = AXIOS_OBJECT_URL_PATTERN.exec(block)?.[2];
    const method = AXIOS_OBJECT_METHOD_PATTERN.exec(block)?.[1] ?? "GET";

    if (url !== undefined && match.index !== undefined) {
      addCall(method, url, match.index);
    }
  }

  return { symbols, relations };
}

function extractMarkdownFile(file: ProjectFile): {
  file: IndexedFile;
  symbols: IndexSymbol[];
  relations: IndexRelation[];
} {
  const symbols: IndexSymbol[] = [];
  const relations: IndexRelation[] = [];
  const lines = file.content.split("\n");

  lines.forEach((line, index) => {
    const headingMatch = /^(#{1,6})\s+(.+)$/.exec(line.trim());

    if (!headingMatch) {
      return;
    }

    const hashes = headingMatch[1];
    const title = headingMatch[2];

    if (!hashes || !title) {
      return;
    }

    const symbol: IndexSymbol = {
      id: stableId(["symbol", file.relativePath, "heading", title]),
      stableSymbolId: stableId(["stable-symbol", "heading", title.trim()]),
      name: title.trim(),
      kind: "heading",
      language: file.language,
      fileId: file.id,
      filePath: file.relativePath,
      line: index + 1,
      signature: `${hashes.length}`,
    };
    symbols.push(symbol);
    relations.push({
      id: stableId(["declares", file.id, symbol.id]),
      type: "DECLARES",
      sourceId: file.id,
      targetId: symbol.id,
    });
  });

  return {
    file: {
      fileId: file.id,
      filePath: file.relativePath,
      language: file.language,
      contentHash: file.contentHash,
      modifiedAt: file.modifiedAt,
      parseCacheKey: buildParseCacheKey(file),
      astFingerprint: buildAstFingerprint(file),
      symbolIds: symbols.map((symbol) => symbol.id),
      imports: [],
    },
    symbols,
    relations,
  };
}

function extractJsonFile(file: ProjectFile): {
  file: IndexedFile;
  symbols: IndexSymbol[];
  relations: IndexRelation[];
} {
  const symbols: IndexSymbol[] = [];
  const relations: IndexRelation[] = [];

  try {
    const parsed = JSON.parse(file.content) as Record<string, unknown>;

    for (const key of Object.keys(parsed)) {
      const symbol: IndexSymbol = {
        id: stableId(["symbol", file.relativePath, "json-key", key]),
        stableSymbolId: stableId(["stable-symbol", "json-key", key]),
        name: key,
        kind: "json-key",
        language: file.language,
        fileId: file.id,
        filePath: file.relativePath,
        line: 1,
      };
      symbols.push(symbol);
      relations.push({
        id: stableId(["declares", file.id, symbol.id]),
        type: "DECLARES",
        sourceId: file.id,
        targetId: symbol.id,
      });
    }
  } catch {
    return {
      file: {
        fileId: file.id,
        filePath: file.relativePath,
        language: file.language,
        contentHash: file.contentHash,
        modifiedAt: file.modifiedAt,
        parseCacheKey: buildParseCacheKey(file),
        astFingerprint: buildAstFingerprint(file),
        symbolIds: [],
        imports: [],
      },
      symbols: [],
      relations: [],
    };
  }

  return {
    file: {
      fileId: file.id,
      filePath: file.relativePath,
      language: file.language,
      contentHash: file.contentHash,
      modifiedAt: file.modifiedAt,
      parseCacheKey: buildParseCacheKey(file),
      astFingerprint: buildAstFingerprint(file),
      symbolIds: symbols.map((symbol) => symbol.id),
      imports: [],
    },
    symbols,
    relations,
  };
}

// PHP AST-based indexing (2026-07-17, architecture review Tier 3 - the
// highest-risk item on the list, since nearly every PHP-derived feature
// shipped this session (routes, http-call linking, hot-path risk, impact
// analysis) reads the symbols/relations this produces). Tries a real parser
// (php-parser, pure JS, no PHP runtime needed) first - it is strictly more
// correct than the regex approach below for exactly the cases regex cannot
// see at all: class-like text inside comments/strings, methods with no
// explicit visibility keyword (implicit public - valid PHP, silently
// invisible to the old `(public|protected|private)\s+function` pattern),
// and multi-class files (the old code attributed EVERY method in a file to
// the FIRST class found, via `defaultContainerName`). Falls back to the
// proven regex extractor on ANY parse or extraction failure - never
// silently drops a file to zero symbols just because php-parser choked on
// one construct it doesn't support.
function extractPhpFile(
  file: ProjectFile,
  fileByRelativePath: Map<string, ProjectFile>,
): {
  file: IndexedFile;
  symbols: IndexSymbol[];
  relations: IndexRelation[];
} {
  try {
    return extractPhpFileViaAst(file, fileByRelativePath);
  } catch (error) {
    console.warn(`[indexer] PHP AST parse failed for ${file.relativePath}, falling back to regex extraction:`, error instanceof Error ? error.message : error);
    return extractPhpFileViaRegex(file, fileByRelativePath);
  }
}

interface PhpAstNode {
  kind: string;
  name?: { name: string } | string;
  loc?: { start: { offset: number; line: number }; end: { offset: number; line: number } };
  children?: PhpAstNode[];
  body?: PhpAstNode[] | PhpAstNode | null;
  items?: PhpAstNode[];
  extends?: PhpAstNode | PhpAstNode[] | null;
  implements?: PhpAstNode[] | null;
  arguments?: PhpAstNode[];
  alias?: { name: string } | null;
  visibility?: string;
}

function phpNodeName(node: PhpAstNode | null | undefined): string | undefined {
  if (!node) {
    return undefined;
  }

  return typeof node.name === "string" ? node.name : node.name?.name;
}

function extractPhpFileViaAst(
  file: ProjectFile,
  fileByRelativePath: Map<string, ProjectFile>,
): {
  file: IndexedFile;
  symbols: IndexSymbol[];
  relations: IndexRelation[];
} {
  const content = file.content;
  const lineStarts = buildLineStarts(content);
  const symbols: IndexSymbol[] = [];
  const relations: IndexRelation[] = [];
  const imports: string[] = [];
  const useMap = new Map<string, string>();
  const symbolByContainerAndName = new Map<string, IndexSymbol>();
  const phpDeclaredNames = new Set<string>();
  // Regex-based, but scans raw content directly rather than parsing
  // declarations - unrelated to the declaration-parsing this replaces, kept
  // exactly as-is (see extractPhpMethodParameterRelations/extractPhpServiceCalls,
  // which depend on its output and are themselves unchanged).
  const propertyTypeByName = collectPhpPropertyTypes(content);
  const methodScopes: PhpMethodScope[] = [];
  const classSymbols = new Map<string, IndexSymbol>();

  // Takes a LINE number (not an offset) as its 3rd argument - this exact
  // signature is shared with extractPhpRoutes (called at the bottom of this
  // function, unchanged), which already calls it that way.
  const addSymbol = (
    name: string,
    symbolKind: IndexSymbol["kind"],
    line: number,
    containerName?: string,
    signature?: string,
  ): IndexSymbol => {
    const symbol: IndexSymbol = {
      id: stableId(["symbol", file.relativePath, symbolKind, containerName ?? "", name]),
      stableSymbolId: stableId(["stable-symbol", symbolKind, containerName ?? "", name]),
      name,
      kind: symbolKind,
      language: file.language,
      fileId: file.id,
      filePath: file.relativePath,
      line,
    };

    if (containerName) {
      symbol.containerName = containerName;
    }

    if (signature) {
      symbol.signature = signature;
    }

    symbols.push(symbol);
    phpDeclaredNames.add(name);
    symbolByContainerAndName.set(buildSymbolLookupKey(containerName, name), symbol);
    relations.push({
      id: stableId(["declares", file.id, symbol.id]),
      type: "DECLARES",
      sourceId: file.id,
      targetId: symbol.id,
    });

    return symbol;
  };

  const engine = new PhpEngine({
    parser: { extractDoc: false, php7: true },
    ast: { withPositions: true },
  });
  const ast = engine.parseCode(content, file.relativePath) as PhpAstNode;

  // namespace/group-use wrap top-level declarations one level deep (and a
  // file can have several namespace blocks) - flattened here so the rest of
  // this function can walk one flat list, same as the regex version
  // effectively did by scanning the whole file at once.
  const topLevelNodes: PhpAstNode[] = [];

  const collectTopLevel = (node: PhpAstNode | null | undefined): void => {
    if (!node) {
      return;
    }

    if (node.kind === "namespace") {
      for (const child of node.children ?? []) {
        collectTopLevel(child);
      }
    } else {
      topLevelNodes.push(node);
    }
  };

  for (const child of ast.children ?? []) {
    collectTopLevel(child);
  }

  // Pass 1: use-imports.
  for (const node of topLevelNodes) {
    if (node.kind !== "usegroup") {
      continue;
    }

    for (const item of node.items ?? []) {
      const imported = phpNodeName(item);

      if (!imported) {
        continue;
      }

      const aliasName = phpNodeName(item.alias as PhpAstNode | undefined);
      const shortName = aliasName ?? imported.split("\\").pop();

      if (!shortName) {
        continue;
      }

      useMap.set(shortName, imported);
      imports.push(imported);

      const resolvedTarget = resolvePhpClassTarget(imported, fileByRelativePath);
      const targetId = resolvedTarget?.id ?? stableId(["dependency", imported]);

      relations.push({
        id: stableId(["imports", file.id, targetId, imported]),
        type: "IMPORTS",
        sourceId: file.id,
        targetId,
        metadata: {
          specifier: imported,
          targetLabel: resolvedTarget?.relativePath ?? imported,
          external: resolvedTarget ? "false" : "true",
        },
      });
    }
  }

  // Pass 2: class/interface/enum/trait declarations - traits are indexed
  // too (kind "class", the closest existing fit - SymbolKind has no
  // separate "trait" value) unlike the old regex version, which silently
  // skipped them entirely; a project's real business logic frequently lives
  // in a project-own trait, not just in library traits.
  const containerNodes = topLevelNodes.filter((node) => ["class", "interface", "enum", "trait"].includes(node.kind));

  for (const node of containerNodes) {
    const name = phpNodeName(node);

    if (!name) {
      continue;
    }

    const symbolKind: IndexSymbol["kind"] = node.kind === "interface" ? "interface" : node.kind === "enum" ? "enum" : "class";
    const classSymbol = addSymbol(name, symbolKind, getLineNumber(lineStarts, node.loc?.start.offset ?? 0));
    classSymbols.set(name, classSymbol);
  }

  // Pass 3: inheritance - class.extends is a single name node, interface.extends is an array (interfaces can extend several).
  for (const node of containerNodes) {
    const name = phpNodeName(node);
    const classSymbol = name ? classSymbols.get(name) : undefined;

    if (!classSymbol) {
      continue;
    }

    const extendsNodes = Array.isArray(node.extends) ? node.extends : node.extends ? [node.extends] : [];

    for (const extendsNode of extendsNodes) {
      const parentName = phpNodeName(extendsNode);

      if (!parentName) {
        continue;
      }

      const targetId = resolvePhpSymbolOrDependencyId(parentName, useMap, symbolByContainerAndName);
      relations.push({
        id: stableId(["extends", classSymbol.id, targetId, parentName]),
        type: "EXTENDS",
        sourceId: classSymbol.id,
        targetId,
        metadata: {
          targetLabel: parentName,
          external: String(!isLocalPhpSymbol(parentName, useMap, symbolByContainerAndName)),
        },
      });
    }

    for (const implementsNode of node.implements ?? []) {
      const contractName = phpNodeName(implementsNode);

      if (!contractName) {
        continue;
      }

      const targetId = resolvePhpSymbolOrDependencyId(contractName, useMap, symbolByContainerAndName);
      relations.push({
        id: stableId(["implements", classSymbol.id, targetId, contractName]),
        type: "IMPLEMENTS",
        sourceId: classSymbol.id,
        targetId,
        metadata: {
          targetLabel: contractName,
          external: String(!isLocalPhpSymbol(contractName, useMap, symbolByContainerAndName)),
        },
      });
    }
  }

  // Pass 4: methods, correctly scoped to their ACTUAL containing
  // class/interface/enum/trait - unlike the old regex version, which
  // attributed every method in the file to whichever class was found FIRST.
  for (const node of containerNodes) {
    const containerName = phpNodeName(node);
    const classSymbol = containerName ? classSymbols.get(containerName) : undefined;
    const body = Array.isArray(node.body) ? node.body : [];

    for (const member of body) {
      if (member.kind !== "method" || member.loc === undefined) {
        continue;
      }

      const methodName = phpNodeName(member);

      if (!methodName) {
        continue;
      }

      const methodSymbol = addSymbol(methodName, "method", getLineNumber(lineStarts, member.loc.start.offset), containerName);
      const bodyNode = !Array.isArray(member.body) ? member.body : null;
      const bodyEndOffset = bodyNode?.loc?.end.offset ?? member.loc.end.offset;

      methodScopes.push({
        symbolId: methodSymbol.id,
        containerName,
        methodName,
        startOffset: member.loc.start.offset,
        endOffset: bodyEndOffset,
      });

      if (classSymbol) {
        relations.push({
          id: stableId(["contains", classSymbol.id, methodSymbol.id]),
          type: "CONTAINS",
          sourceId: classSymbol.id,
          targetId: methodSymbol.id,
        });
      }

      const methodArguments = member.arguments ?? [];

      if (methodArguments.length > 0) {
        const first = methodArguments[0]?.loc;
        const last = methodArguments[methodArguments.length - 1]?.loc;
        const paramsText = first && last ? content.slice(first.start.offset, last.end.offset) : "";

        extractPhpMethodParameterRelations(
          paramsText,
          methodSymbol.id,
          useMap,
          symbolByContainerAndName,
          relations,
          propertyTypeByName,
          methodName,
        );
      }
    }
  }

  // Pass 5: top-level functions (not inside any class/interface/enum/trait).
  for (const node of topLevelNodes) {
    if (node.kind !== "function" || node.loc === undefined) {
      continue;
    }

    const functionName = phpNodeName(node);

    if (!functionName) {
      continue;
    }

    addSymbol(functionName, "function", getLineNumber(lineStarts, node.loc.start.offset));
  }

  // Same shared, content-scanning sub-extractors the regex path uses -
  // unaffected by how declarations above were found, since they read
  // useMap/symbolByContainerAndName/methodScopes/propertyTypeByName, not the
  // AST itself.
  extractPhpServiceCalls(
    file,
    content,
    useMap,
    fileByRelativePath,
    symbolByContainerAndName,
    relations,
    phpDeclaredNames,
    propertyTypeByName,
    methodScopes,
  );
  extractPhpStaticCalls(content, useMap, symbolByContainerAndName, relations, methodScopes);
  extractPhpRuntimeSignals(file, content, relations, methodScopes);
  extractPhpRoutes(file, content, useMap, fileByRelativePath, symbols, relations, symbolByContainerAndName, addSymbol);

  return {
    file: {
      fileId: file.id,
      filePath: file.relativePath,
      language: file.language,
      contentHash: file.contentHash,
      modifiedAt: file.modifiedAt,
      parseCacheKey: buildParseCacheKey(file),
      astFingerprint: buildAstFingerprint(file),
      symbolIds: symbols.map((symbol) => symbol.id),
      imports,
    },
    symbols,
    relations,
  };
}

function extractPhpFileViaRegex(
  file: ProjectFile,
  fileByRelativePath: Map<string, ProjectFile>,
): {
  file: IndexedFile;
  symbols: IndexSymbol[];
  relations: IndexRelation[];
} {
  const symbols: IndexSymbol[] = [];
  const relations: IndexRelation[] = [];
  const imports: string[] = [];
  const useMap = new Map<string, string>();
  const content = file.content;
  const lineStarts = buildLineStarts(content);
  const symbolByContainerAndName = new Map<string, IndexSymbol>();
  const phpDeclaredNames = new Set<string>();
  const propertyTypeByName = collectPhpPropertyTypes(content);
  const methodScopes: PhpMethodScope[] = [];

  const addSymbol = (
    name: string,
    symbolKind: IndexSymbol["kind"],
    line: number,
    containerName?: string,
    signature?: string,
  ): IndexSymbol => {
    const symbol: IndexSymbol = {
      id: stableId(["symbol", file.relativePath, symbolKind, containerName ?? "", name]),
      stableSymbolId: stableId(["stable-symbol", symbolKind, containerName ?? "", name]),
      name,
      kind: symbolKind,
      language: file.language,
      fileId: file.id,
      filePath: file.relativePath,
      line,
    };

    if (containerName) {
      symbol.containerName = containerName;
    }

    if (signature) {
      symbol.signature = signature;
    }

    symbols.push(symbol);
    phpDeclaredNames.add(name);
    symbolByContainerAndName.set(buildSymbolLookupKey(containerName, name), symbol);
    relations.push({
      id: stableId(["declares", file.id, symbol.id]),
      type: "DECLARES",
      sourceId: file.id,
      targetId: symbol.id,
    });

    return symbol;
  };

  const usePattern = /^\s*use\s+([^;]+);/gm;

  for (const match of content.matchAll(usePattern)) {
    const imported = match[1]?.trim();

    if (!imported) {
      continue;
    }

    const shortName = imported.split("\\").pop();

    if (!shortName) {
      continue;
    }

    useMap.set(shortName, imported);
    imports.push(imported);

    const resolvedTarget = resolvePhpClassTarget(imported, fileByRelativePath);
    const targetId = resolvedTarget?.id ?? stableId(["dependency", imported]);

    relations.push({
      id: stableId(["imports", file.id, targetId, imported]),
      type: "IMPORTS",
      sourceId: file.id,
      targetId,
      metadata: {
        specifier: imported,
        targetLabel: resolvedTarget?.relativePath ?? imported,
        external: resolvedTarget ? "false" : "true",
      },
    });
  }

  const classPattern = /\b(class|interface|trait|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/g;
  const classSymbols = new Map<string, IndexSymbol>();

  for (const match of content.matchAll(classPattern)) {
    const kind = match[1];
    const name = match[2];

    if (!kind || !name || kind === "trait") {
      continue;
    }

    const line = getLineNumber(lineStarts, match.index ?? 0);
    const symbolKind: IndexSymbol["kind"] = kind === "interface" ? "interface" : kind === "enum" ? "enum" : "class";
    const classSymbol = addSymbol(name, symbolKind, line);
    classSymbols.set(name, classSymbol);
  }

  const inheritancePattern =
    /\bclass\s+([A-Za-z_][A-Za-z0-9_]*)\s+extends\s+([A-Za-z_\\][A-Za-z0-9_\\]*)(?:\s+implements\s+([A-Za-z0-9_\\,\s]+))?/g;

  for (const match of content.matchAll(inheritancePattern)) {
    const className = match[1];
    const parentName = match[2];
    const implemented = match[3];
    const classSymbol = className ? classSymbols.get(className) : null;

    if (classSymbol && parentName) {
      const targetId = resolvePhpSymbolOrDependencyId(parentName, useMap, symbolByContainerAndName);
      relations.push({
        id: stableId(["extends", classSymbol.id, targetId, parentName]),
        type: "EXTENDS",
        sourceId: classSymbol.id,
        targetId,
        metadata: {
          targetLabel: parentName,
          external: String(!isLocalPhpSymbol(parentName, useMap, symbolByContainerAndName)),
        },
      });
    }

    if (classSymbol && implemented) {
      for (const contract of implemented.split(",").map((value) => value.trim()).filter(Boolean)) {
        const targetId = resolvePhpSymbolOrDependencyId(contract, useMap, symbolByContainerAndName);
        relations.push({
          id: stableId(["implements", classSymbol.id, targetId, contract]),
          type: "IMPLEMENTS",
          sourceId: classSymbol.id,
          targetId,
          metadata: {
            targetLabel: contract,
            external: String(!isLocalPhpSymbol(contract, useMap, symbolByContainerAndName)),
          },
        });
      }
    }
  }

  const interfaceExtendsPattern = /\binterface\s+([A-Za-z_][A-Za-z0-9_]*)\s+extends\s+([A-Za-z0-9_\\,\s]+)/g;

  for (const match of content.matchAll(interfaceExtendsPattern)) {
    const interfaceName = match[1];
    const parents = match[2];
    const interfaceSymbol = interfaceName ? classSymbols.get(interfaceName) : null;

    if (!interfaceSymbol || !parents) {
      continue;
    }

    for (const parent of parents.split(",").map((value) => value.trim()).filter(Boolean)) {
      const targetId = resolvePhpSymbolOrDependencyId(parent, useMap, symbolByContainerAndName);
      relations.push({
        id: stableId(["extends", interfaceSymbol.id, targetId, parent]),
        type: "EXTENDS",
        sourceId: interfaceSymbol.id,
        targetId,
        metadata: {
          targetLabel: parent,
          external: String(!isLocalPhpSymbol(parent, useMap, symbolByContainerAndName)),
        },
      });
    }
  }

  const methodPattern =
    /\b(public|protected|private)\s+function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([\s\S]*?)\)\s*(?::\s*[A-Za-z0-9_\\|?]+)?\s*\{/g;
  const defaultContainerName = [...classSymbols.keys()][0];

  for (const match of content.matchAll(methodPattern)) {
    const methodName = match[2];
    const params = match[3] ?? "";

    if (!methodName) {
      continue;
    }

    const line = getLineNumber(lineStarts, match.index ?? 0);
    const methodSymbol = addSymbol(methodName, "method", line, defaultContainerName);
    const bodyStart = content.indexOf("{", match.index ?? 0);
    const bodyEnd = bodyStart >= 0 ? findMatchingBraceIndex(content, bodyStart) : -1;

    methodScopes.push({
      symbolId: methodSymbol.id,
      containerName: defaultContainerName,
      methodName,
      startOffset: match.index ?? 0,
      endOffset: bodyEnd >= 0 ? bodyEnd : content.length - 1,
    });

    if (defaultContainerName) {
      const classSymbol = classSymbols.get(defaultContainerName);

      if (classSymbol) {
        relations.push({
          id: stableId(["contains", classSymbol.id, methodSymbol.id]),
          type: "CONTAINS",
          sourceId: classSymbol.id,
          targetId: methodSymbol.id,
        });
      }
    }

    extractPhpMethodParameterRelations(
      params,
      methodSymbol.id,
      useMap,
      symbolByContainerAndName,
      relations,
      propertyTypeByName,
      methodName,
    );
  }

  const functionPattern = /(?:^|\s)function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/gm;

  for (const match of content.matchAll(functionPattern)) {
    const functionName = match[1];

    if (!functionName || content.slice(Math.max(0, (match.index ?? 0) - 16), match.index ?? 0).includes("public")) {
      continue;
    }

    const line = getLineNumber(lineStarts, match.index ?? 0);
    addSymbol(functionName, "function", line);
  }

  extractPhpServiceCalls(
    file,
    content,
    useMap,
    fileByRelativePath,
    symbolByContainerAndName,
    relations,
    phpDeclaredNames,
    propertyTypeByName,
    methodScopes,
  );
  extractPhpStaticCalls(content, useMap, symbolByContainerAndName, relations, methodScopes);
  extractPhpRuntimeSignals(file, content, relations, methodScopes);
  extractPhpRoutes(file, content, useMap, fileByRelativePath, symbols, relations, symbolByContainerAndName, addSymbol);

  return {
    file: {
      fileId: file.id,
      filePath: file.relativePath,
      language: file.language,
      contentHash: file.contentHash,
      modifiedAt: file.modifiedAt,
      parseCacheKey: buildParseCacheKey(file),
      astFingerprint: buildAstFingerprint(file),
      symbolIds: symbols.map((symbol) => symbol.id),
      imports,
    },
    symbols,
    relations,
  };
}

function buildParseCacheKey(file: ProjectFile): string {
  return stableId(["parse-cache", file.relativePath, file.contentHash]);
}

function buildAstFingerprint(file: ProjectFile): string {
  return contentHash(`${file.language}:${file.relativePath}:${file.contentHash}`);
}

function groupByFilePath(symbols: IndexSymbol[]): Map<string, IndexSymbol[]> {
  const map = new Map<string, IndexSymbol[]>();

  for (const symbol of symbols) {
    const key = normalizePath(symbol.filePath);
    const current = map.get(key) ?? [];
    current.push(symbol);
    map.set(key, current);
  }

  return map;
}

function groupRelationsByFilePath(relations: IndexRelation[], symbols: IndexSymbol[]): Map<string, IndexRelation[]> {
  const symbolFileMap = new Map(symbols.map((symbol) => [symbol.id, normalizePath(symbol.filePath)]));
  const map = new Map<string, IndexRelation[]>();

  for (const relation of relations) {
    const key = symbolFileMap.get(relation.sourceId) ?? relation.metadata?.sourceFilePath;

    if (typeof key !== "string") {
      continue;
    }

    const current = map.get(key) ?? [];
    current.push(relation);
    map.set(key, current);
  }

  return map;
}

function buildSymbolStateKey(symbol: IndexSymbol): string {
  return [
    symbol.stableSymbolId,
    symbol.filePath,
    symbol.line,
    symbol.signature ?? "",
    symbol.containerName ?? "",
  ].join("::");
}

function countDifference(left: Set<string>, right: Set<string>): number {
  let count = 0;

  for (const item of left) {
    if (!right.has(item)) {
      count += 1;
    }
  }

  return count;
}

function countIntersection(left: Set<string>, right: Set<string>): number {
  let count = 0;

  for (const item of left) {
    if (right.has(item)) {
      count += 1;
    }
  }

  return count;
}

function resolveImportTarget(
  sourceFilePath: string,
  specifier: string,
  fileByRelativePath: Map<string, ProjectFile>,
): ProjectFile | null {
  if (!specifier.startsWith(".")) {
    return null;
  }

  const sourceDirectory = path.posix.dirname(normalizePath(sourceFilePath));
  const basePath = normalizePath(path.posix.normalize(path.posix.join(sourceDirectory, specifier)));
  const candidates = [
    basePath,
    `${basePath}.ts`,
    `${basePath}.tsx`,
    `${basePath}.js`,
    `${basePath}.jsx`,
    `${basePath}/index.ts`,
    `${basePath}/index.tsx`,
    `${basePath}/index.js`,
    `${basePath}/index.jsx`,
  ];

  for (const candidate of candidates) {
    const target = fileByRelativePath.get(candidate);

    if (target) {
      return target;
    }
  }

  return null;
}

function isTopLevelNode(node: ts.Node): boolean {
  return ts.isSourceFile(node);
}

function resolvePhpClassTarget(className: string, fileByRelativePath: Map<string, ProjectFile>): ProjectFile | null {
  if (!className.startsWith("App\\")) {
    return null;
  }

  const relativePath = normalizePath(`app/${className.slice(4).replace(/\\/g, "/")}.php`);
  return fileByRelativePath.get(relativePath) ?? null;
}

function extractPhpRoutes(
  file: ProjectFile,
  content: string,
  useMap: Map<string, string>,
  fileByRelativePath: Map<string, ProjectFile>,
  symbols: IndexSymbol[],
  relations: IndexRelation[],
  symbolByContainerAndName: Map<string, IndexSymbol>,
  addSymbol: (
    name: string,
    symbolKind: IndexSymbol["kind"],
    line: number,
    containerName?: string,
    signature?: string,
  ) => IndexSymbol,
): void {
  const lines = content.split("\n");
  const prefixStack: Array<{ prefix: string; depth: number }> = [];
  const middlewareStack: Array<{ names: string[]; depth: number }> = [];
  let depth = 0;
  let consumedThroughIndex = -1;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();

    if (index <= consumedThroughIndex) {
      depth += countOccurrences(line, "{");
      depth -= countOccurrences(line, "}");

      while (prefixStack.length && depth <= prefixStack[prefixStack.length - 1]!.depth) {
        prefixStack.pop();
      }

      while (middlewareStack.length && depth <= middlewareStack[middlewareStack.length - 1]!.depth) {
        middlewareStack.pop();
      }

      continue;
    }

    // Bug fix (2026-07-19, full-project review): a leaf Route::verb(...) call
    // whose ARGUMENTS span multiple physical lines (long controller/action
    // names, a multi-line `[Controller::class, 'method']` array - a common
    // real-world Laravel/Pint formatting style) used to be completely
    // invisible below: every regex here only ever saw ONE `trimmed` physical
    // line at a time, so the opening line (just "Route::get(") matched
    // nothing and the route silently never became a symbol/node/search hit -
    // not degraded, just gone. Only LEAF verb calls get joined, never
    // Route::group/prefix opens - those legitimately open a multi-line
    // closure body that must stay matched line-by-line, and joining until
    // parens balance there would swallow the entire block (every nested
    // route inside it) into one opaque blob. Scope boundary, not a bug: a
    // ->middleware()/->name() chained AFTER the call's closing paren, on its
    // own separate line, is still not picked up (join stops the moment the
    // call's own parens balance, deliberately, to stay bounded) - the route
    // itself is still indexed either way, just without that one edge; the
    // same as this codebase's pre-existing single-line behavior for that style.
    let matchable = trimmed;

    if (ROUTE_VERB_OPEN_PATTERN.test(trimmed) && countUnquotedParenBalance(trimmed) > 0) {
      const joined = joinMultilineRouteStatement(lines, index);

      if (joined.endIndex > index) {
        matchable = joined.text;
        consumedThroughIndex = joined.endIndex;
      }
    }

    const prefixMatch = /Route::prefix\(\s*['"]([^'"]+)['"]\s*\)->group/.exec(matchable);

    if (prefixMatch?.[1]) {
      prefixStack.push({
        prefix: normalizeRoutePath(prefixMatch[1]),
        depth,
      });
    }

    const middlewareGroupMatch = /Route::middleware\(([^)]+)\)->group/.exec(matchable);

    if (middlewareGroupMatch?.[1]) {
      middlewareStack.push({
        names: parseMiddlewareNames(middlewareGroupMatch[1]),
        depth,
      });
    }

    const routeMatch =
      // \s* right after the opening [ (2026-07-19, full-project review): a
      // multi-line array literal - `[` on its own line, `Controller::class`
      // indented on the next - is completely ordinary PHP formatting, and
      // joinMultilineRouteStatement above joins lines with a single space,
      // not by deleting the original newline's whitespace entirely -
      // without this the joined text ends up as "[ Controller::class" and
      // silently fails to match even though the statement was joined
      // correctly. Also fixes the same gap for genuinely single-line routes
      // written with a space after [ (e.g. `[ UserController::class, 'show']`).
      /Route::(?:middleware\(([^)]+)\)->)?(get|post|put|patch|delete|options)\(\s*['"]([^'"]+)['"]\s*,\s*\[\s*([A-Za-z0-9_\\]+)::class\s*,\s*['"]([A-Za-z0-9_]+)['"]\s*\]\s*\)(?:->middleware\(([^)]+)\))?/i.exec(
        matchable,
      );

    if (routeMatch) {
      const inlineLeadingMiddleware = routeMatch[1];
      const method = routeMatch[2]?.toUpperCase();
      const routePath = routeMatch[3];
      const controllerRef = routeMatch[4];
      const actionName = routeMatch[5];
      const inlineTrailingMiddleware = routeMatch[6];

      if (method && routePath && controllerRef && actionName) {
        const fullPath = joinRoutePath(prefixStack.map((item) => item.prefix), routePath);
        const routeSymbol = addSymbol(`${method} ${fullPath}`, "route", index + 1, undefined, `${controllerRef}@${actionName}`);
        const resolvedController = resolvePhpControllerReference(controllerRef, useMap, fileByRelativePath);
        const controllerSymbolId = resolveControllerSymbolId(controllerRef, useMap, symbolByContainerAndName);
        const methodSymbolId = resolveMethodSymbolId(controllerRef, actionName, useMap, symbolByContainerAndName);
        const targetId = methodSymbolId ?? controllerSymbolId ?? resolvedController?.id ?? stableId(["dependency", controllerRef, actionName]);

        relations.push({
          id: stableId(["references", routeSymbol.id, targetId, controllerRef, actionName]),
          type: "REFERENCES",
          sourceId: routeSymbol.id,
          targetId,
          metadata: {
            semantic: "route-handler",
            controller: controllerRef,
            action: actionName,
            routePath: fullPath,
            targetLabel: resolvedController?.relativePath ?? `${controllerRef}@${actionName}`,
          },
        });

        if (controllerSymbolId && controllerSymbolId !== targetId) {
          relations.push({
            id: stableId(["references", routeSymbol.id, controllerSymbolId, controllerRef, "class"]),
            type: "REFERENCES",
            sourceId: routeSymbol.id,
            targetId: controllerSymbolId,
            metadata: {
              semantic: "route-handler",
              controller: controllerRef,
              action: actionName,
              routePath: fullPath,
              targetLabel: controllerRef,
            },
          });
        }

        const inheritedMiddleware = middlewareStack.flatMap((item) => item.names);
        const inlineMiddleware = [
          ...parseMiddlewareNames(inlineLeadingMiddleware),
          ...parseMiddlewareNames(inlineTrailingMiddleware),
          ...parseMiddlewareNamesFromLine(matchable),
        ];
        const allMiddleware = uniqueStringList([...inheritedMiddleware, ...inlineMiddleware]);

        for (const middlewareName of allMiddleware) {
        const middlewareSymbol = addSymbol(`middleware:${middlewareName}`, "middleware", index + 1, undefined, middlewareName);
          relations.push({
            id: stableId(["uses", routeSymbol.id, middlewareSymbol.id, middlewareName]),
            type: "USES",
            sourceId: routeSymbol.id,
            targetId: middlewareSymbol.id,
            metadata: {
              semantic: "middleware",
              targetLabel: middlewareName,
            },
          });
        }
      }
    }

    depth += countOccurrences(line, "{");
    depth -= countOccurrences(line, "}");

    while (prefixStack.length && depth <= prefixStack[prefixStack.length - 1]!.depth) {
      prefixStack.pop();
    }

    while (middlewareStack.length && depth <= middlewareStack[middlewareStack.length - 1]!.depth) {
      middlewareStack.pop();
    }
  }
}

const ROUTE_VERB_OPEN_PATTERN = /^Route::(?:middleware\([^)]*\)->)?(get|post|put|patch|delete|options|any|match)\(/i;
const MAX_ROUTE_STATEMENT_JOIN_LINES = 12;

// Ignores parens inside string literals ('/users/(archived)' is a real,
// if unusual, valid route path) so a quoted paren can't throw the balance
// off and either truncate a real multi-line join early or make a
// perfectly ordinary single-line route look "unbalanced".
function countUnquotedParenBalance(text: string): number {
  let depth = 0;

  for (const ch of stripQuotedContent(text)) {
    if (ch === "(") {
      depth += 1;
    } else if (ch === ")") {
      depth -= 1;
    }
  }

  return depth;
}

// Removes the CONTENTS of single/double-quoted strings (keeping the quote
// characters themselves as boundary markers) so callers can safely test for
// structural PHP characters/keywords without tripping on a route path
// placeholder like '/users/{id}' or a literal '(' inside a string.
function stripQuotedContent(text: string): string {
  let result = "";
  let quote: string | null = null;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (quote) {
      if (ch === "\\") {
        i += 1;
      } else if (ch === quote) {
        quote = null;
        result += ch;
      }

      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      result += ch;
    } else {
      result += ch;
    }
  }

  return result;
}

// Joins a leaf Route::verb(...) call's continuation lines until its parens
// balance. Bails out (returns the original single line, unjoined) the
// moment a continuation line looks like anything other than plain call
// arguments OUTSIDE of a string literal - a real brace or a `function`
// keyword means this isn't actually a leaf call (or the source has a
// syntax error) and blindly swallowing lines would risk hiding real routes
// inside whatever it consumed. Checked against the string-stripped form so
// an entirely ordinary route path placeholder like '/users/{id}' can't
// trip the bail-out (a route path is exactly where `{param}` segments live
// in real Laravel code - the common case this whole fix exists for). Capped
// at MAX_ROUTE_STATEMENT_JOIN_LINES so a genuinely unbalanced/malformed
// statement can't run away and consume the rest of the file.
function joinMultilineRouteStatement(lines: string[], startIndex: number): { text: string; endIndex: number } {
  const startLine = (lines[startIndex] ?? "").trim();
  let text = startLine;
  let endIndex = startIndex;
  let balance = countUnquotedParenBalance(text);

  while (balance > 0 && endIndex + 1 < lines.length && endIndex - startIndex < MAX_ROUTE_STATEMENT_JOIN_LINES) {
    const nextLine = (lines[endIndex + 1] ?? "").trim();
    const structural = stripQuotedContent(nextLine);

    if (structural.includes("{") || /\bfunction\b/.test(structural)) {
      return { text: startLine, endIndex: startIndex };
    }

    endIndex += 1;
    text += ` ${nextLine}`;
    balance += countUnquotedParenBalance(nextLine);
  }

  return balance === 0 ? { text, endIndex } : { text: startLine, endIndex: startIndex };
}

function resolvePhpControllerReference(
  controllerRef: string,
  useMap: Map<string, string>,
  fileByRelativePath: Map<string, ProjectFile>,
): ProjectFile | null {
  const fullyQualified = controllerRef.includes("\\") ? controllerRef : useMap.get(controllerRef) ?? controllerRef;
  return resolvePhpClassTarget(fullyQualified, fileByRelativePath);
}

function joinRoutePath(prefixes: string[], routePath: string): string {
  const combined = [...prefixes, routePath]
    .map((value) => normalizeRoutePath(value))
    .filter(Boolean)
    .join("/");

  return combined ? `/${combined}`.replace(/\/+/g, "/") : "/";
}

function normalizeRoutePath(value: string): string {
  return value.replace(/^\/+/, "").replace(/\/+$/, "");
}

function countOccurrences(value: string, target: string): number {
  let count = 0;

  for (const char of value) {
    if (char === target) {
      count += 1;
    }
  }

  return count;
}

function buildLineStarts(content: string): number[] {
  const lineStarts = [0];

  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === "\n") {
      lineStarts.push(index + 1);
    }
  }

  return lineStarts;
}

function getLineNumber(lineStarts: number[], index: number): number {
  let low = 0;
  let high = lineStarts.length - 1;
  let result = 0;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = lineStarts[middle];

    if (candidate === undefined) {
      break;
    }

    if (candidate <= index) {
      result = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  return result + 1;
}

function buildSymbolLookupKey(containerName: string | undefined, name: string): string {
  return `${containerName ?? ""}::${name}`;
}

function resolveControllerSymbolId(
  controllerRef: string,
  useMap: Map<string, string>,
  symbolByContainerAndName: Map<string, IndexSymbol>,
): string | null {
  const controllerName = extractControllerShortName(controllerRef, useMap);

  if (!controllerName) {
    return null;
  }

  return symbolByContainerAndName.get(buildSymbolLookupKey(undefined, controllerName))?.id ?? null;
}

function resolveMethodSymbolId(
  controllerRef: string,
  actionName: string,
  useMap: Map<string, string>,
  symbolByContainerAndName: Map<string, IndexSymbol>,
): string | null {
  const controllerName = extractControllerShortName(controllerRef, useMap);

  if (!controllerName) {
    return null;
  }

  return symbolByContainerAndName.get(buildSymbolLookupKey(controllerName, actionName))?.id ?? null;
}

function extractControllerShortName(controllerRef: string, useMap: Map<string, string>): string | null {
  const fullyQualified = controllerRef.includes("\\") ? controllerRef : useMap.get(controllerRef) ?? controllerRef;
  const shortName = fullyQualified.split("\\").pop();
  return shortName ?? null;
}

function extractPhpServiceCalls(
  file: ProjectFile,
  content: string,
  useMap: Map<string, string>,
  fileByRelativePath: Map<string, ProjectFile>,
  symbolByContainerAndName: Map<string, IndexSymbol>,
  relations: IndexRelation[],
  phpDeclaredNames: Set<string>,
  propertyTypeByName: Map<string, string>,
  methodScopes: PhpMethodScope[],
): void {
  const methodCallPattern = /\$this->([A-Za-z_][A-Za-z0-9_]*)->([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;

  for (const match of content.matchAll(methodCallPattern)) {
    const propertyName = match[1];
    const methodName = match[2];

    if (!propertyName || !methodName) {
      continue;
    }

    const serviceType = propertyTypeByName.get(propertyName);

    if (!serviceType) {
      continue;
    }

    const fullyQualified = serviceType.includes("\\") ? serviceType : useMap.get(serviceType) ?? serviceType;
    const targetFile = resolvePhpClassTarget(fullyQualified, fileByRelativePath);
    const shortName = fullyQualified.split("\\").pop();
    const methodSymbolId = shortName ? symbolByContainerAndName.get(buildSymbolLookupKey(shortName, methodName))?.id : null;
    const targetId = methodSymbolId ?? targetFile?.id;

    if (!targetId) {
      continue;
    }

    const sourceMethodScope = findPhpMethodScopeAtOffset(methodScopes, match.index ?? 0);
    const sourceCandidates = [...phpDeclaredNames]
      .map((name) => symbolByContainerAndName.get(buildSymbolLookupKey(name, methodName)))
      .filter((value): value is IndexSymbol => Boolean(value));
    const sourceId = sourceMethodScope?.symbolId ?? sourceCandidates[0]?.id ?? file.id;

    relations.push({
      id: stableId(["references", sourceId, targetId, "service-call", propertyName, methodName]),
      type: "CALLS",
      sourceId,
      targetId,
      metadata: {
        semantic: "service-call",
        service: fullyQualified,
        method: methodName,
        targetLabel: targetFile?.relativePath ?? `${fullyQualified}@${methodName}`,
      },
    });
  }
}

function extractPhpMethodParameterRelations(
  params: string,
  methodSymbolId: string,
  useMap: Map<string, string>,
  symbolByContainerAndName: Map<string, IndexSymbol>,
  relations: IndexRelation[],
  propertyTypeByName: Map<string, string>,
  methodName: string,
): void {
  const paramPattern =
    /(?:^|,)\s*(?:(public|protected|private)\s+)?(?:(readonly)\s+)?([A-Za-z_\\][A-Za-z0-9_\\]*)\s+\$([A-Za-z_][A-Za-z0-9_]*)/g;

  for (const match of params.matchAll(paramPattern)) {
    const visibility = match[1];
    const typeName = match[3];
    const parameterName = match[4];

    if (!typeName || !parameterName || isBuiltInPhpType(typeName)) {
      continue;
    }

    if (visibility) {
      propertyTypeByName.set(parameterName, typeName);
    }

    const targetId = resolvePhpSymbolOrDependencyId(typeName, useMap, symbolByContainerAndName);
    relations.push({
      id: stableId(["uses", methodSymbolId, targetId, "param-type", methodName, parameterName]),
      type: "USES",
      sourceId: methodSymbolId,
      targetId,
      metadata: {
        semantic: "parameter-type",
        parameter: parameterName,
        targetLabel: typeName,
      },
    });
  }
}

function collectPhpPropertyTypes(content: string): Map<string, string> {
  const propertyTypeByName = new Map<string, string>();
  const propertyPattern =
    /\b(public|protected|private)\s+(?:readonly\s+)?([A-Za-z_\\][A-Za-z0-9_\\]*)\s+\$([A-Za-z_][A-Za-z0-9_]*)\b/g;

  for (const match of content.matchAll(propertyPattern)) {
    const typeName = match[2];
    const propertyName = match[3];

    if (!typeName || !propertyName || isBuiltInPhpType(typeName)) {
      continue;
    }

    propertyTypeByName.set(propertyName, typeName);
  }

  return propertyTypeByName;
}

function extractPhpStaticCalls(
  content: string,
  useMap: Map<string, string>,
  symbolByContainerAndName: Map<string, IndexSymbol>,
  relations: IndexRelation[],
  methodScopes: PhpMethodScope[],
): void {
  const staticCallPattern = /\b([A-Z][A-Za-z0-9_\\]*)::([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;

  for (const match of content.matchAll(staticCallPattern)) {
    const classRef = match[1];
    const staticMethod = match[2];

    if (!classRef || !staticMethod) {
      continue;
    }

    const scope = findPhpMethodScopeAtOffset(methodScopes, match.index ?? 0);

    if (!scope) {
      continue;
    }

    const targetId = resolvePhpSymbolOrDependencyId(classRef, useMap, symbolByContainerAndName);
    const relationType = classifyPhpStaticCall(staticMethod);

    relations.push({
      id: stableId(["static-call", scope.symbolId, targetId, classRef, staticMethod, match.index ?? 0]),
      type: relationType,
      sourceId: scope.symbolId,
      targetId,
      metadata: {
        semantic: "static-call",
        method: staticMethod,
        targetLabel: classRef,
      },
    });
  }
}

function extractPhpRuntimeSignals(
  file: ProjectFile,
  content: string,
  relations: IndexRelation[],
  methodScopes: PhpMethodScope[],
): void {
  const headerPatterns = [
    /\$request->header\(\s*['"]([^'"]+)['"]/g,
    /request\(\)->header\(\s*['"]([^'"]+)['"]/g,
    /headers->get\(\s*['"]([^'"]+)['"]/g,
  ];
  const configPattern = /\b(?:config|env)\(\s*['"]([^'"]+)['"]/g;
  const localeSetPattern = /\b(?:app\(\)->setLocale|App::setLocale)\(\s*\$?([A-Za-z_][A-Za-z0-9_]*)?/g;

  for (const pattern of headerPatterns) {
    for (const match of content.matchAll(pattern)) {
      const headerName = match[1];
      const sourceScope = findPhpMethodScopeAtOffset(methodScopes, match.index ?? 0);
      const sourceId = sourceScope?.symbolId ?? file.id;

      if (!headerName) {
        continue;
      }

      relations.push({
        id: stableId(["reads", sourceId, file.id, "header", headerName, match.index ?? 0]),
        type: "READS",
        sourceId,
        targetId: file.id,
        metadata: {
          semantic: "request-header",
          header: headerName,
          targetLabel: headerName,
          sourceFilePath: file.relativePath,
        },
      });
    }
  }

  for (const match of content.matchAll(configPattern)) {
    const configKey = match[1];
    const sourceScope = findPhpMethodScopeAtOffset(methodScopes, match.index ?? 0);
    const sourceId = sourceScope?.symbolId ?? file.id;

    if (!configKey) {
      continue;
    }

    relations.push({
      id: stableId(["reads", sourceId, file.id, "config", configKey, match.index ?? 0]),
      type: "READS",
      sourceId,
      targetId: file.id,
      metadata: {
        semantic: configKey.includes("locale") ? "locale-config" : "config-read",
        configKey,
        targetLabel: configKey,
        sourceFilePath: file.relativePath,
      },
    });
  }

  for (const match of content.matchAll(localeSetPattern)) {
    const localeValue = match[1];
    const sourceScope = findPhpMethodScopeAtOffset(methodScopes, match.index ?? 0);
    const sourceId = sourceScope?.symbolId ?? file.id;

    relations.push({
      id: stableId(["writes", sourceId, file.id, "locale", localeValue ?? "unknown", match.index ?? 0]),
      type: "WRITES",
      sourceId,
      targetId: file.id,
      metadata: {
        semantic: "locale-set",
        localeSource: localeValue ?? "unknown",
        targetLabel: "application-locale",
        sourceFilePath: file.relativePath,
      },
    });
  }

}

function resolvePhpSymbolOrDependencyId(
  symbolRef: string,
  useMap: Map<string, string>,
  symbolByContainerAndName: Map<string, IndexSymbol>,
): string {
  const shortName = extractControllerShortName(symbolRef, useMap) ?? symbolRef;
  return symbolByContainerAndName.get(buildSymbolLookupKey(undefined, shortName))?.id ?? stableId(["dependency", symbolRef]);
}

function isLocalPhpSymbol(
  symbolRef: string,
  useMap: Map<string, string>,
  symbolByContainerAndName: Map<string, IndexSymbol>,
): boolean {
  const shortName = extractControllerShortName(symbolRef, useMap) ?? symbolRef;
  return symbolByContainerAndName.has(buildSymbolLookupKey(undefined, shortName));
}

function findMatchingBraceIndex(content: string, openBraceIndex: number): number {
  let depth = 0;

  for (let index = openBraceIndex; index < content.length; index += 1) {
    const char = content[index];

    if (char === "{") {
      depth += 1;
    }

    if (char === "}") {
      depth -= 1;

      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

function findPhpMethodScopeAtOffset(methodScopes: PhpMethodScope[], offset: number): PhpMethodScope | null {
  return methodScopes.find((scope) => offset >= scope.startOffset && offset <= scope.endOffset) ?? null;
}

function parseMiddlewareNames(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return [...value.matchAll(/['"]([^'"]+)['"]/g)]
    .map((match) => match[1])
    .filter((item): item is string => Boolean(item));
}

function parseMiddlewareNamesFromLine(line: string): string[] {
  const values: string[] = [];

  for (const match of line.matchAll(/middleware\(([^)]+)\)/g)) {
    values.push(...parseMiddlewareNames(match[1]));
  }

  return values;
}

function uniqueStringList(values: string[]): string[] {
  return values.filter((value, index) => Boolean(value) && values.indexOf(value) === index);
}

function classifyPhpStaticCall(methodName: string): IndexRelation["type"] {
  const normalized = methodName.toLowerCase();

  if (["create", "make", "factory"].includes(normalized)) {
    return "CREATES";
  }

  if (["put", "save", "update", "delete", "forget", "pull", "revoke"].includes(normalized)) {
    return "WRITES";
  }

  if (["find", "findorfail", "first", "firstorfail", "where", "query", "get", "has", "remember", "driver", "user"].includes(normalized)) {
    return "READS";
  }

  return "USES";
}

function isBuiltInPhpType(typeName: string): boolean {
  return ["string", "int", "float", "bool", "array", "object", "mixed", "callable", "iterable", "self", "parent", "static"].includes(
    typeName.toLowerCase(),
  );
}

interface PhpMethodScope {
  symbolId: string;
  containerName: string | undefined;
  methodName: string;
  startOffset: number;
  endOffset: number;
}
