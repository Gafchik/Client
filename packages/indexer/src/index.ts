import path from "node:path";
import ts from "typescript";
import {
  normalizePath,
  stableId,
  type IndexRelation,
  type IndexResult,
  type IndexSymbol,
  type IndexedFile,
  type LanguageId,
  type ProjectFile,
  type WorkspaceSnapshot,
} from "@client/shared";

export async function runFullIndex(workspace: WorkspaceSnapshot): Promise<IndexResult> {
  const startedAt = new Date().toISOString();
  const symbols: IndexSymbol[] = [];
  const relations: IndexRelation[] = [];
  const files: IndexedFile[] = [];
  const diagnostics = [...workspace.diagnostics];
  const languages = { ...workspace.summary.languages };
  let unsupportedFiles = 0;

  const fileByRelativePath = new Map(workspace.files.map((file) => [normalizePath(file.relativePath), file]));

  for (const file of workspace.files) {
    try {
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

  return {
    manifest: {
      indexId: stableId(["index", workspace.projectId, startedAt]),
      mode: "full",
      startedAt,
      completedAt: new Date().toISOString(),
      projectId: workspace.projectId,
      fileCount: files.length,
      symbolCount: symbols.length,
      relationCount: relations.length,
      diagnosticsCount: diagnostics.length,
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
          symbolIds: [],
          imports: [],
        },
        symbols: [],
        relations: [],
      };
  }
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

  return {
    file: {
      fileId: file.id,
      filePath: file.relativePath,
      language: file.language,
      symbolIds: symbols.map((symbol) => symbol.id),
      imports,
    },
    symbols,
    relations,
  };
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
      symbolIds: symbols.map((symbol) => symbol.id),
      imports: [],
    },
    symbols,
    relations,
  };
}

function extractPhpFile(
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
  const symbolByContainerAndName = new Map<string, IndexSymbol>();
  const phpDeclaredNames = new Set<string>();
  const propertyTypeByName = new Map<string, string>();
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

    const line = getLineNumber(content, match.index ?? 0);
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

    const line = getLineNumber(content, match.index ?? 0);
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

    const line = getLineNumber(content, match.index ?? 0);
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
  extractPhpRoutes(file, content, useMap, fileByRelativePath, symbols, relations, symbolByContainerAndName, addSymbol);

  return {
    file: {
      fileId: file.id,
      filePath: file.relativePath,
      language: file.language,
      symbolIds: symbols.map((symbol) => symbol.id),
      imports,
    },
    symbols,
    relations,
  };
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

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();

    const prefixMatch = /Route::prefix\(\s*['"]([^'"]+)['"]\s*\)->group/.exec(trimmed);

    if (prefixMatch?.[1]) {
      prefixStack.push({
        prefix: normalizeRoutePath(prefixMatch[1]),
        depth,
      });
    }

    const middlewareGroupMatch = /Route::middleware\(([^)]+)\)->group/.exec(trimmed);

    if (middlewareGroupMatch?.[1]) {
      middlewareStack.push({
        names: parseMiddlewareNames(middlewareGroupMatch[1]),
        depth,
      });
    }

    const routeMatch =
      /Route::(?:middleware\(([^)]+)\)->)?(get|post|put|patch|delete|options)\(\s*['"]([^'"]+)['"]\s*,\s*\[([A-Za-z0-9_\\]+)::class\s*,\s*['"]([A-Za-z0-9_]+)['"]\s*\]\s*\)(?:->middleware\(([^)]+)\))?/i.exec(
        trimmed,
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
          ...parseMiddlewareNamesFromLine(trimmed),
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
  return value.split(target).length - 1;
}

function getLineNumber(content: string, index: number): number {
  return content.slice(0, index).split("\n").length;
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

    const propertyPattern = new RegExp(`private\\s+readonly\\s+([A-Za-z_\\\\][A-Za-z0-9_\\\\]*)\\s+\\$${propertyName}\\b`);
    const propertyMatch = propertyPattern.exec(content);
    const serviceType = propertyTypeByName.get(propertyName) ?? propertyMatch?.[1];

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
