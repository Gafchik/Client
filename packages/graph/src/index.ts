import {
  deriveStructuralModuleLabel,
  isLocalizationPath,
  type GraphNodeKind,
  type GraphRelationType,
  normalizePath,
  type PipelineRunResult,
  type ResearchQueryProfileKey,
  stableId,
  type GraphEdge,
  type GraphNode,
  type GraphState,
  type IndexResult,
  type WorkspaceSnapshot,
} from "@client/shared";

interface BuildGraphOptions {
  previousRun?: PipelineRunResult | null;
  invalidatedPaths?: string[];
}

export function buildGraph(
  workspace: WorkspaceSnapshot,
  index: IndexResult,
  options: BuildGraphOptions = {},
): GraphState {
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  const fileById = new Map(workspace.files.map((file) => [file.id, file]));
  const symbolById = new Map(index.symbols.map((symbol) => [symbol.id, symbol]));
  const symbolIdByFileAndName = new Map(index.symbols.map((symbol) => [buildSymbolLookupKey(symbol.filePath, symbol.name), symbol.id]));
  const projectNodeId = workspace.projectId;
  const repositoryNodeId = stableId(["repository", workspace.rootPath]);

  nodes.set(repositoryNodeId, {
    id: repositoryNodeId,
    kind: "repository",
    label: workspace.projectName,
    metadata: {
      rootPath: workspace.rootPath,
    },
  });

  nodes.set(projectNodeId, {
    id: projectNodeId,
    kind: "project",
    label: workspace.projectName,
    metadata: {
      rootPath: workspace.rootPath,
    },
  });

  edges.set(stableId(["owns", repositoryNodeId, projectNodeId]), {
    id: stableId(["owns", repositoryNodeId, projectNodeId]),
    type: "OWNS",
    sourceId: repositoryNodeId,
    targetId: projectNodeId,
  });

  const moduleIds = new Map<string, string>();
  const folderIds = new Map<string, string>();

  for (const file of workspace.files) {
    const moduleLabel = getModuleLabel(file.relativePath);
    const moduleId = ensureModuleNode(moduleLabel, workspace, nodes, edges, moduleIds, projectNodeId);
    const folderPath = getFolderPath(file.relativePath);
    const folderId = ensureFolderNodes(folderPath, moduleId, nodes, edges, folderIds, file.relativePath);

    nodes.set(file.id, {
      id: file.id,
      kind: "file",
      label: file.relativePath,
      filePath: file.relativePath,
      metadata: {
        language: file.language,
      },
    });

    edges.set(stableId(["owns", projectNodeId, file.id]), {
      id: stableId(["owns", projectNodeId, file.id]),
      type: "OWNS",
      sourceId: projectNodeId,
      targetId: file.id,
    });

    edges.set(stableId(["belongs-to", file.id, moduleId]), {
      id: stableId(["belongs-to", file.id, moduleId]),
      type: "BELONGS_TO",
      sourceId: file.id,
      targetId: moduleId,
    });

    edges.set(stableId(["contains", moduleId, file.id]), {
      id: stableId(["contains", moduleId, file.id]),
      type: "CONTAINS",
      sourceId: moduleId,
      targetId: file.id,
    });

    if (folderId) {
      edges.set(stableId(["belongs-to", file.id, folderId]), {
        id: stableId(["belongs-to", file.id, folderId]),
        type: "BELONGS_TO",
        sourceId: file.id,
        targetId: folderId,
      });

      edges.set(stableId(["contains", folderId, file.id]), {
        id: stableId(["contains", folderId, file.id]),
        type: "CONTAINS",
        sourceId: folderId,
        targetId: file.id,
      });
    }
  }

  for (const symbol of index.symbols) {
    nodes.set(symbol.id, {
      id: symbol.id,
      kind: mapSymbolKindToGraphKind(symbol.kind),
      label: symbol.containerName ? `${symbol.containerName}.${symbol.name}` : symbol.name,
      filePath: symbol.filePath,
      metadata: {
        symbolKind: symbol.kind,
        language: symbol.language,
      },
    });

    const file = fileById.get(symbol.fileId);

    if (file) {
      edges.set(stableId(["belongs-to", symbol.id, file.id]), {
        id: stableId(["belongs-to", symbol.id, file.id]),
        type: "BELONGS_TO",
        sourceId: symbol.id,
        targetId: file.id,
      });
    }

    if (symbol.containerName) {
      const containerId = symbolIdByFileAndName.get(buildSymbolLookupKey(symbol.filePath, symbol.containerName));

      if (containerId) {
        edges.set(stableId(["belongs-to", symbol.id, containerId]), {
          id: stableId(["belongs-to", symbol.id, containerId]),
          type: "BELONGS_TO",
          sourceId: symbol.id,
          targetId: containerId,
        });
      }
    }
  }

  for (const relation of index.relations) {
    if (!nodes.has(relation.sourceId)) {
      continue;
    }

    if (!nodes.has(relation.targetId)) {
      const label = String(relation.metadata?.targetLabel ?? relation.targetId);
      nodes.set(relation.targetId, {
        id: relation.targetId,
        kind: "dependency",
        label,
        metadata: {
          external: String(relation.metadata?.external ?? "true"),
        },
      });
    }

    const edge: GraphEdge = {
      id: relation.id,
      type: normalizeRelationType(relation.type, relation.metadata),
      sourceId: relation.sourceId,
      targetId: relation.targetId,
    };

    if (relation.metadata) {
      edge.metadata = relation.metadata;
    }

    edges.set(relation.id, edge);
  }

  for (const relation of index.relations) {
    const normalizedType = normalizeRelationType(relation.type, relation.metadata);

    if (!isDependencySignal(normalizedType)) {
      continue;
    }

    const sourceSymbol = symbolById.get(relation.sourceId);
    const sourceFile = sourceSymbol ? fileById.get(sourceSymbol.fileId) : fileById.get(relation.sourceId);

    if (!sourceFile) {
      continue;
    }

    const sourceModuleId = moduleIds.get(getModuleLabel(sourceFile.relativePath));

    if (!sourceModuleId) {
      continue;
    }

    const targetSymbol = symbolById.get(relation.targetId);
    const targetFile = targetSymbol ? fileById.get(targetSymbol.fileId) : fileById.get(relation.targetId);

    if (!targetFile) {
      continue;
    }

    const targetModuleId = moduleIds.get(getModuleLabel(targetFile.relativePath));

    if (!targetModuleId || targetModuleId === sourceModuleId) {
      continue;
    }

    edges.set(stableId(["depends-on", sourceModuleId, targetModuleId, normalizedType]), {
      id: stableId(["depends-on", sourceModuleId, targetModuleId, normalizedType]),
      type: "DEPENDS_ON",
      sourceId: sourceModuleId,
      targetId: targetModuleId,
      metadata: {
        derivedFrom: normalizedType,
      },
    });
  }

  const nodeList = [...nodes.values()];
  const edgeList = [...edges.values()];
  const merged = mergePreviousGraphState(
    {
      graphId: stableId(["graph", workspace.projectId, index.manifest.indexId]),
      projectId: workspace.projectId,
      createdAt: new Date().toISOString(),
      nodes: nodeList,
      edges: edgeList,
      summary: buildGraphSummary(nodeList, edgeList),
    },
    workspace,
    options.previousRun,
    options.invalidatedPaths ?? [],
  );

  return merged;
}

export function getIncomingNeighbors(graph: GraphState, nodeId: string): GraphNode[] {
  const sourceIds = graph.edges.filter((edge) => edge.targetId === nodeId).map((edge) => edge.sourceId);
  const sourceSet = new Set(sourceIds);
  return graph.nodes.filter((node) => sourceSet.has(node.id));
}

export function getOutgoingNeighbors(graph: GraphState, nodeId: string): GraphNode[] {
  const targetIds = graph.edges.filter((edge) => edge.sourceId === nodeId).map((edge) => edge.targetId);
  const targetSet = new Set(targetIds);
  return graph.nodes.filter((node) => targetSet.has(node.id));
}

export function getIncomingEdges(graph: GraphState, nodeId: string): GraphEdge[] {
  return graph.edges.filter((edge) => edge.targetId === nodeId);
}

export function getOutgoingEdges(graph: GraphState, nodeId: string): GraphEdge[] {
  return graph.edges.filter((edge) => edge.sourceId === nodeId);
}

export function getNeighborsByEdgeType(
  graph: GraphState,
  nodeId: string,
  edgeType: GraphRelationType,
  direction: "incoming" | "outgoing",
): GraphNode[] {
  const matchingEdges = graph.edges.filter((edge) =>
    direction === "incoming" ? edge.type === edgeType && edge.targetId === nodeId : edge.type === edgeType && edge.sourceId === nodeId,
  );
  const ids = new Set(matchingEdges.map((edge) => (direction === "incoming" ? edge.sourceId : edge.targetId)));
  return graph.nodes.filter((node) => ids.has(node.id));
}

export function getNodesByKind(graph: GraphState, kind: GraphNodeKind): GraphNode[] {
  return graph.nodes.filter((node) => node.kind === kind);
}

export function getNodeById(graph: GraphState, nodeId: string): GraphNode | undefined {
  return graph.nodes.find((node) => node.id === nodeId);
}

export function getEdgesByType(graph: GraphState, edgeType: GraphRelationType): GraphEdge[] {
  return graph.edges.filter((edge) => edge.type === edgeType);
}

export function getModuleSubgraph(graph: GraphState, moduleLabel: string): GraphNode[] {
  const moduleNode = graph.nodes.find((node) => node.kind === "module" && node.label === moduleLabel);

  if (!moduleNode) {
    return [];
  }

  const directIds = new Set<string>([moduleNode.id]);

  for (const edge of graph.edges) {
    if (edge.sourceId === moduleNode.id || edge.targetId === moduleNode.id) {
      directIds.add(edge.sourceId);
      directIds.add(edge.targetId);
    }
  }

  return graph.nodes.filter((node) => directIds.has(node.id));
}

export function getModuleRelations(graph: GraphState, moduleLabel: string): GraphEdge[] {
  const moduleNode = graph.nodes.find((node) => node.kind === "module" && node.label === moduleLabel);

  if (!moduleNode) {
    return [];
  }

  return graph.edges.filter((edge) => edge.sourceId === moduleNode.id || edge.targetId === moduleNode.id);
}

export function getModuleRelationSummary(
  graph: GraphState,
  moduleLabel: string,
): Array<{ relationType: GraphRelationType; targetLabel: string; direction: "incoming" | "outgoing" }> {
  const moduleNode = graph.nodes.find((node) => node.kind === "module" && node.label === moduleLabel);

  if (!moduleNode) {
    return [];
  }

  return graph.edges
    .filter((edge) => edge.type === "DEPENDS_ON" && (edge.sourceId === moduleNode.id || edge.targetId === moduleNode.id))
    .map((edge) => {
      const direction = edge.sourceId === moduleNode.id ? "outgoing" : "incoming";
      const targetId = direction === "outgoing" ? edge.targetId : edge.sourceId;
      const targetNode = getNodeById(graph, targetId);

      return {
        relationType: edge.type,
        targetLabel: targetNode?.label ?? targetId,
        direction,
      };
    });
}

export function getModuleDependencyNeighbors(graph: GraphState, moduleLabel: string): GraphNode[] {
  const moduleNode = graph.nodes.find((node) => node.kind === "module" && node.label === moduleLabel);

  if (!moduleNode) {
    return [];
  }

  return getNeighborsByEdgeType(graph, moduleNode.id, "DEPENDS_ON", "outgoing");
}

export function getModuleDependents(graph: GraphState, moduleLabel: string): GraphNode[] {
  const moduleNode = graph.nodes.find((node) => node.kind === "module" && node.label === moduleLabel);

  if (!moduleNode) {
    return [];
  }

  return getNeighborsByEdgeType(graph, moduleNode.id, "DEPENDS_ON", "incoming");
}

export function getRouteNodes(graph: GraphState): GraphNode[] {
  return getNodesByKind(graph, "route");
}

export function getMiddlewareNodes(graph: GraphState): GraphNode[] {
  return getNodesByKind(graph, "middleware");
}

export function getCodeNodes(graph: GraphState): GraphNode[] {
  return graph.nodes.filter((node) => isCodeNode(node.kind));
}

export function getFileNodes(graph: GraphState): GraphNode[] {
  return getNodesByKind(graph, "file");
}

export function getStructuralNeighbors(
  graph: GraphState,
  nodeId: string,
  relationTypes: GraphRelationType[],
  direction: "incoming" | "outgoing" | "both" = "both",
): GraphNode[] {
  const allowed = new Set(relationTypes);
  const neighborIds = new Set<string>();

  for (const edge of graph.edges) {
    if (!allowed.has(edge.type)) {
      continue;
    }

    if ((direction === "incoming" || direction === "both") && edge.targetId === nodeId) {
      neighborIds.add(edge.sourceId);
    }

    if ((direction === "outgoing" || direction === "both") && edge.sourceId === nodeId) {
      neighborIds.add(edge.targetId);
    }
  }

  return graph.nodes.filter((node) => neighborIds.has(node.id));
}

export function traverseGraph(
  graph: GraphState,
  startingNodeIds: string[],
  relationTypes: GraphRelationType[],
  maxDepth = 2,
): GraphNode[] {
  const allowed = new Set(relationTypes);
  const visited = new Set<string>(startingNodeIds);
  const queue = startingNodeIds.map((nodeId) => ({ nodeId, depth: 0 }));

  while (queue.length > 0) {
    const current = queue.shift();

    if (!current || current.depth >= maxDepth) {
      continue;
    }

    for (const edge of graph.edges) {
      if (!allowed.has(edge.type)) {
        continue;
      }

      const neighborId =
        edge.sourceId === current.nodeId ? edge.targetId : edge.targetId === current.nodeId ? edge.sourceId : null;

      if (!neighborId || visited.has(neighborId)) {
        continue;
      }

      visited.add(neighborId);
      queue.push({ nodeId: neighborId, depth: current.depth + 1 });
    }
  }

  return graph.nodes.filter((node) => visited.has(node.id));
}

export function getRoutesForModule(graph: GraphState, moduleLabel: string): GraphNode[] {
  const moduleNode = graph.nodes.find((node) => node.kind === "module" && node.label === moduleLabel);

  if (!moduleNode) {
    return [];
  }

  const subgraph = getModuleSubgraph(graph, moduleLabel);
  return subgraph.filter((node) => node.kind === "route");
}

export function getEntryPointNeighbors(graph: GraphState, routeNodeId: string): GraphNode[] {
  return getStructuralNeighbors(graph, routeNodeId, ["REFERENCES", "CALLS", "USES", "BELONGS_TO"], "outgoing");
}

export function getFileOwnedSymbols(graph: GraphState, fileId: string): GraphNode[] {
  return getNeighborsByEdgeType(graph, fileId, "DECLARES", "outgoing");
}

export function getFileDependencies(graph: GraphState, fileId: string): GraphNode[] {
  const ownedSymbols = getFileOwnedSymbols(graph, fileId);
  const dependencyIds = new Set<string>();

  for (const symbol of ownedSymbols) {
    for (const dependency of getSymbolDependencies(graph, symbol.id)) {
      if (dependency.filePath && dependency.filePath !== getNodeById(graph, fileId)?.filePath) {
        dependencyIds.add(dependency.id);
      }
    }
  }

  for (const edge of graph.edges) {
    if (edge.sourceId !== fileId) {
      continue;
    }

    if (!["IMPORTS", "REFERENCES", "CALLS", "USES", "READS", "WRITES", "CREATES"].includes(edge.type)) {
      continue;
    }

    const targetNode = getNodeById(graph, edge.targetId);

    if (targetNode?.filePath && targetNode.filePath !== getNodeById(graph, fileId)?.filePath) {
      dependencyIds.add(targetNode.id);
    }
  }

  return graph.nodes.filter((node) => dependencyIds.has(node.id));
}

export function getFileDependents(graph: GraphState, fileId: string): GraphNode[] {
  const ownedSymbols = getFileOwnedSymbols(graph, fileId);
  const dependentIds = new Set<string>();

  for (const symbol of ownedSymbols) {
    for (const dependent of getSymbolDependents(graph, symbol.id)) {
      if (dependent.filePath && dependent.filePath !== getNodeById(graph, fileId)?.filePath) {
        dependentIds.add(dependent.id);
      }
    }
  }

  for (const edge of graph.edges) {
    if (edge.targetId !== fileId) {
      continue;
    }

    if (!["IMPORTS", "REFERENCES", "CALLS", "USES", "READS", "WRITES", "CREATES"].includes(edge.type)) {
      continue;
    }

    const sourceNode = getNodeById(graph, edge.sourceId);

    if (sourceNode?.filePath && sourceNode.filePath !== getNodeById(graph, fileId)?.filePath) {
      dependentIds.add(sourceNode.id);
    }
  }

  return graph.nodes.filter((node) => dependentIds.has(node.id));
}

export function getSymbolDependencies(graph: GraphState, symbolId: string): GraphNode[] {
  return getStructuralNeighbors(
    graph,
    symbolId,
    ["IMPORTS", "REFERENCES", "CALLS", "USES", "IMPLEMENTS", "EXTENDS", "READS", "WRITES", "CREATES"],
    "outgoing",
  );
}

export function getSymbolDependents(graph: GraphState, symbolId: string): GraphNode[] {
  return getStructuralNeighbors(
    graph,
    symbolId,
    ["IMPORTS", "REFERENCES", "CALLS", "USES", "IMPLEMENTS", "EXTENDS", "READS", "WRITES", "CREATES"],
    "incoming",
  );
}

// Convention-based FE->BE dependency detection (2026-07-17, architecture
// review Tier 3): route symbols ("GET /users/{id}", from extractPhpRoutes)
// and frontend http-call symbols ("GET /users/:param", from
// extractFrontendHttpCalls) are indexed independently - often in different
// repos entirely - so they can only be linked once both sides exist in the
// same merged graph. Call this once, after any cross-repo graph merge, and
// fold the result into graph.edges; a CALLS edge here is what lets
// getFileDependents/getSymbolDependents (both already CALLS-aware) trace
// impact from a backend route change out to every frontend call site, and
// vice versa, with no new traversal code of their own.
export function linkHttpCallsToRoutes(graph: GraphState): GraphEdge[] {
  const routeNodes = graph.nodes.filter((node) => node.kind === "route");
  const httpCallNodes = graph.nodes.filter((node) => node.kind === "http-call");

  if (routeNodes.length === 0 || httpCallNodes.length === 0) {
    return [];
  }

  const existingEdgeIds = new Set(graph.edges.map((edge) => edge.id));
  const routeIdByNormalizedLabel = new Map<string, string>();

  for (const route of routeNodes) {
    routeIdByNormalizedLabel.set(normalizeRouteLikeLabel(route.label), route.id);
  }

  const newEdges: GraphEdge[] = [];

  for (const httpCall of httpCallNodes) {
    const routeId = routeIdByNormalizedLabel.get(normalizeRouteLikeLabel(httpCall.label));

    if (!routeId) {
      continue;
    }

    const edgeId = stableId(["calls-route", httpCall.id, routeId]);

    if (existingEdgeIds.has(edgeId)) {
      continue;
    }

    newEdges.push({
      id: edgeId,
      type: "CALLS",
      sourceId: httpCall.id,
      targetId: routeId,
    });
  }

  return newEdges;
}

// Hot-path/entrypoint-reachability risk signal (2026-07-17, architecture
// review Tier 3): a bug in a file that sits on the request path of a dozen
// public endpoints is a fundamentally different kind of risk than the same
// bug in a file only one obscure admin route ever reaches - structural
// "N files affected" counts alone don't distinguish these. BFS outward from
// every route node over plain structural edges (not CALLS-only, since a
// route usually reaches its real logic via REFERENCES/BELONGS_TO/CONTAINS
// hops through a controller before any CALLS edge appears), capped at
// maxDepth so cost stays bounded regardless of graph size.
export function computeEntrypointReachability(graph: GraphState, maxDepth = 4): Map<string, Set<string>> {
  const routeNodes = graph.nodes.filter((node) => node.kind === "route");

  if (routeNodes.length === 0) {
    return new Map();
  }

  const outgoingByNode = new Map<string, string[]>();

  for (const edge of graph.edges) {
    const existing = outgoingByNode.get(edge.sourceId);

    if (existing) {
      existing.push(edge.targetId);
    } else {
      outgoingByNode.set(edge.sourceId, [edge.targetId]);
    }
  }

  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const reachability = new Map<string, Set<string>>();

  for (const route of routeNodes) {
    const visited = new Set<string>([route.id]);
    let frontier = [route.id];

    for (let depth = 0; depth < maxDepth && frontier.length > 0; depth += 1) {
      const next: string[] = [];

      for (const nodeId of frontier) {
        for (const targetId of outgoingByNode.get(nodeId) ?? []) {
          if (visited.has(targetId)) {
            continue;
          }

          visited.add(targetId);
          next.push(targetId);

          const targetNode = nodeById.get(targetId);

          if (targetNode?.kind === "file" && targetNode.filePath) {
            const existing = reachability.get(targetNode.filePath);

            if (existing) {
              existing.add(route.label);
            } else {
              reachability.set(targetNode.filePath, new Set([route.label]));
            }
          }
        }
      }

      frontier = next;
    }
  }

  return reachability;
}

// Shared normalization so a route label built at PHP-extraction time
// ("GET /users/{id}") and a call-site label built at JS-extraction time
// ("GET /users/:param") converge on the same key, regardless of which
// framework's placeholder syntax each side happened to use.
function normalizeRouteLikeLabel(label: string): string {
  const spaceIndex = label.indexOf(" ");
  const method = (spaceIndex === -1 ? label : label.slice(0, spaceIndex)).toUpperCase();
  const rawPath = spaceIndex === -1 ? "" : label.slice(spaceIndex + 1);
  const normalizedPath = rawPath
    .replace(/\{[^}]*\}/g, ":param")
    .replace(/:[A-Za-z_][A-Za-z0-9_]*/g, ":param")
    .replace(/\/+/g, "/");
  const withLeadingSlash = normalizedPath.startsWith("/") ? normalizedPath : `/${normalizedPath}`;
  const trimmed = withLeadingSlash.length > 1 && withLeadingSlash.endsWith("/") ? withLeadingSlash.slice(0, -1) : withLeadingSlash;
  return `${method} ${trimmed}`;
}

export function getFunctionalEntryPointSet(graph: GraphState, moduleLabel?: string): GraphNode[] {
  const routes = moduleLabel ? getRoutesForModule(graph, moduleLabel) : getRouteNodes(graph);
  const nodeIds = new Set<string>(routes.map((node) => node.id));

  for (const route of routes) {
    for (const neighbor of getEntryPointNeighbors(graph, route.id)) {
      nodeIds.add(neighbor.id);
    }
  }

  if (moduleLabel) {
    const moduleSubgraph = getModuleSubgraph(graph, moduleLabel)
      .filter((node) => node.kind !== "project" && node.kind !== "repository")
      .slice(0, 24);

    for (const node of moduleSubgraph) {
      nodeIds.add(node.id);
    }
  }

  return graph.nodes.filter((node) => nodeIds.has(node.id));
}

export function getStorageTopologyNodes(graph: GraphState): GraphNode[] {
  const nodeIds = new Set<string>();

  for (const node of graph.nodes) {
    const label = node.label.toLowerCase();
    const filePath = node.filePath?.toLowerCase() ?? "";

    if (
      label.includes("server")
      || label.includes("credential")
      || label.includes("vault")
      || label.includes("password")
      || label.includes("passphrase")
      || label.includes("private_key")
      || label.includes("forwarding")
      || filePath.includes("/servers/")
      || (filePath.includes("server") && filePath.includes("credential"))
      || (filePath.includes("forwarding") && filePath.includes("port"))
      || filePath.includes("/vault/")
      || filePath.includes("/migrations/")
    ) {
      nodeIds.add(node.id);
    }
  }

  for (const nodeId of [...nodeIds]) {
    for (const neighbor of getStructuralNeighbors(
      graph,
      nodeId,
      ["BELONGS_TO", "CONTAINS", "USES", "REFERENCES", "READS", "WRITES", "CREATES"],
      "both",
    )) {
      nodeIds.add(neighbor.id);
    }
  }

  return graph.nodes.filter((node) => nodeIds.has(node.id));
}

export function getLocalizationInventoryNodes(graph: GraphState): GraphNode[] {
  return graph.nodes.filter((node) => {
    const label = node.label.toLowerCase();
    const filePath = node.filePath?.toLowerCase() ?? "";

    return (
      label.includes("localization")
      || label.includes("translation")
      || label.includes("locale")
      || isLocalizationPath(filePath)
    );
  });
}

export function getLocalizationRuntimeNodes(graph: GraphState): GraphNode[] {
  const nodeIds = new Set<string>();

  for (const node of graph.nodes) {
    const label = node.label.toLowerCase();
    const filePath = node.filePath?.toLowerCase() ?? "";

    if (
      label.includes("locale")
      || label.includes("language")
      || label.includes("middleware")
      || filePath.includes("/middleware/")
      || filePath.includes("/config/")
      || filePath.includes("/http/")
    ) {
      nodeIds.add(node.id);
    }
  }

  for (const edge of graph.edges) {
    const semantic = String(edge.metadata?.semantic ?? "").toLowerCase();
    const header = String(edge.metadata?.header ?? "").toLowerCase();
    const configKey = String(edge.metadata?.configKey ?? "").toLowerCase();

    if (
      semantic === "locale-set"
      || semantic === "locale-config"
      || semantic === "request-header"
      || header.includes("locale")
      || header.includes("language")
      || configKey.includes("locale")
    ) {
      nodeIds.add(edge.sourceId);
      nodeIds.add(edge.targetId);
    }
  }

  for (const nodeId of [...nodeIds]) {
    for (const neighbor of getStructuralNeighbors(
      graph,
      nodeId,
      ["BELONGS_TO", "CONTAINS", "USES", "REFERENCES", "READS", "WRITES", "CALLS"],
      "both",
    )) {
      nodeIds.add(neighbor.id);
    }
  }

  return graph.nodes.filter((node) => nodeIds.has(node.id));
}

export function getRuntimeSemanticEdges(graph: GraphState, semantic: string): GraphEdge[] {
  const normalized = semantic.toLowerCase();
  return graph.edges.filter((edge) => String(edge.metadata?.semantic ?? "").toLowerCase() === normalized);
}

export function getConfigInventoryNodes(graph: GraphState): GraphNode[] {
  return graph.nodes.filter((node) => {
    const label = node.label.toLowerCase();
    const filePath = node.filePath?.toLowerCase() ?? "";

    return (
      label.includes("config")
      || label.includes("env")
      || label.includes("settings")
      || filePath.startsWith("config/")
      || filePath.includes("/config/")
      || filePath.endsWith(".env")
      || filePath.includes("/env.")
    );
  });
}

export function getBroadScanSeeds(graph: GraphState): GraphNode[] {
  const modules = getNodesByKind(graph, "module").slice(0, 12);
  const routes = getRouteNodes(graph).slice(0, 8);
  const files = getFileNodes(graph).slice(0, 12);
  const seedIds = new Set<string>([...modules, ...routes, ...files].map((node) => node.id));

  return graph.nodes.filter((node) => seedIds.has(node.id));
}

export function getNodesForQueryProfile(
  graph: GraphState,
  queryProfileKey: ResearchQueryProfileKey,
  options?: { moduleLabel?: string },
): GraphNode[] {
  switch (queryProfileKey) {
    case "entrypoint-traversal":
      return getFunctionalEntryPointSet(graph, options?.moduleLabel);
    case "storage-topology":
      return getStorageTopologyNodes(graph);
    case "localization-inventory":
      return getLocalizationInventoryNodes(graph);
    case "config-inventory":
      return getConfigInventoryNodes(graph);
    case "broad-scan":
      return getBroadScanSeeds(graph);
    default:
      return [];
  }
}

function getModuleLabel(filePath: string): string {
  return deriveStructuralModuleLabel(filePath);
}

function getFolderPath(filePath: string): string {
  const parts = filePath.split("/");
  parts.pop();
  return parts.join("/");
}

function ensureModuleNode(
  moduleLabel: string,
  workspace: WorkspaceSnapshot,
  nodes: Map<string, GraphNode>,
  edges: Map<string, GraphEdge>,
  moduleIds: Map<string, string>,
  projectNodeId: string,
): string {
  const existing = moduleIds.get(moduleLabel);

  if (existing) {
    return existing;
  }

  const moduleId = stableId(["module", workspace.projectId, moduleLabel]);
  moduleIds.set(moduleLabel, moduleId);
  nodes.set(moduleId, {
    id: moduleId,
    kind: "module",
    label: moduleLabel,
    metadata: {
      projectId: workspace.projectId,
    },
  });
  edges.set(stableId(["owns", projectNodeId, moduleId]), {
    id: stableId(["owns", projectNodeId, moduleId]),
    type: "OWNS",
    sourceId: projectNodeId,
    targetId: moduleId,
  });

  return moduleId;
}

function ensureFolderNodes(
  folderPath: string,
  moduleId: string,
  nodes: Map<string, GraphNode>,
  edges: Map<string, GraphEdge>,
  folderIds: Map<string, string>,
  filePath: string,
): string | null {
  if (!folderPath) {
    return null;
  }

  const parts = folderPath.split("/");
  let currentPath = "";
  let parentFolderId: string | null = null;
  let lastFolderId: string | null = null;

  for (const part of parts) {
    currentPath = currentPath ? `${currentPath}/${part}` : part;
    const existing = folderIds.get(currentPath);

    if (existing) {
      parentFolderId = existing;
      lastFolderId = existing;
      continue;
    }

    const folderId = stableId(["folder", currentPath]);
    folderIds.set(currentPath, folderId);
    nodes.set(folderId, {
      id: folderId,
      kind: "folder",
      label: currentPath,
      filePath,
    });

    edges.set(stableId(["belongs-to", folderId, moduleId]), {
      id: stableId(["belongs-to", folderId, moduleId]),
      type: "BELONGS_TO",
      sourceId: folderId,
      targetId: moduleId,
    });

    if (parentFolderId) {
      edges.set(stableId(["contains", parentFolderId, folderId]), {
        id: stableId(["contains", parentFolderId, folderId]),
        type: "CONTAINS",
        sourceId: parentFolderId,
        targetId: folderId,
      });
    } else {
      edges.set(stableId(["contains", moduleId, folderId]), {
        id: stableId(["contains", moduleId, folderId]),
        type: "CONTAINS",
        sourceId: moduleId,
        targetId: folderId,
      });
    }

    parentFolderId = folderId;
    lastFolderId = folderId;
  }

  return lastFolderId;
}

function mapSymbolKindToGraphKind(symbolKind: IndexResult["symbols"][number]["kind"]): GraphNodeKind {
  switch (symbolKind) {
    case "class":
      return "class";
    case "interface":
      return "interface";
    case "enum":
      return "enum";
    case "function":
      return "function";
    case "method":
      return "method";
    case "route":
      return "route";
    case "http-call":
      return "http-call";
    case "middleware":
      return "middleware";
    default:
      return "dependency";
  }
}

function buildSymbolLookupKey(filePath: string, name: string): string {
  return `${filePath}::${name}`;
}

function isCodeNode(kind: GraphNodeKind): boolean {
  return ["class", "interface", "enum", "function", "method", "route", "http-call", "middleware"].includes(kind);
}

function normalizeRelationType(
  type: IndexResult["relations"][number]["type"],
  metadata?: Record<string, string | number | boolean>,
): GraphRelationType {
  if (type === "REFERENCES") {
    const semantic = String(metadata?.semantic ?? metadata?.kind ?? "").toLowerCase();

    if (semantic === "service-call" || semantic === "call") {
      return "CALLS";
    }

    if (semantic === "route-handler" || semantic === "usage" || semantic === "use") {
      return "USES";
    }
  }

  return type;
}

function isDependencySignal(type: GraphRelationType): boolean {
  return ["IMPORTS", "REFERENCES", "CALLS", "USES", "IMPLEMENTS", "EXTENDS", "READS", "WRITES", "CREATES"].includes(type);
}

function mergePreviousGraphState(
  current: GraphState,
  workspace: WorkspaceSnapshot,
  previousRun: PipelineRunResult | null | undefined,
  invalidatedPaths: string[],
): GraphState {
  const previousGraph = previousRun?.runtimeCache?.graph;

  if (!previousGraph) {
    return current;
  }

  const invalidatedPathSet = new Set(invalidatedPaths.map((value) => normalizePath(value)));
  // Bug fix (2026-07-19, full-project review, CRITICAL): a selective/narrow
  // workspace scan (a single Q&A question touching ~100-250 files out of a
  // much larger repo, see openWorkspaceSelective) used to be pruned exactly
  // like a full scan here - any previous-graph node whose file wasn't in
  // THIS narrow scan's file set was dropped as if it no longer existed, and
  // saveGraphSnapshot does a full replace (not a merge) into Neo4j - so one
  // narrow question silently shrank the whole project's persisted graph
  // down to the handful of files it happened to touch. find_references/
  // impact-analysis for any OTHER file then falsely reported "no
  // dependents" until the next full background-sync ran (which can be a
  // whole session away - it fires on HEAD changes, not on a timer). A
  // selective scan can only trust EXPLICIT invalidation (a file that
  // genuinely changed/was deleted) - "this file wasn't part of what I
  // looked at this time" is not evidence it's gone.
  const isFullScan = workspace.summary.selectionMode !== "selective";
  const currentPathSet = new Set(workspace.files.map((file) => normalizePath(file.relativePath)));
  const retainedNodes = new Map<string, GraphNode>();
  const retainedEdges = new Map<string, GraphEdge>();

  for (const node of previousGraph.nodes) {
    const nodePath = node.filePath ? normalizePath(node.filePath) : undefined;

    if (nodePath && invalidatedPathSet.has(nodePath)) {
      continue;
    }

    if (nodePath && isFullScan && !currentPathSet.has(nodePath)) {
      continue;
    }

    retainedNodes.set(node.id, node);
  }

  for (const edge of previousGraph.edges) {
    if (!retainedNodes.has(edge.sourceId) || !retainedNodes.has(edge.targetId)) {
      continue;
    }

    retainedEdges.set(edge.id, edge);
  }

  for (const node of current.nodes) {
    retainedNodes.set(node.id, node);
  }

  for (const edge of current.edges) {
    retainedEdges.set(edge.id, edge);
  }

  const nodes = [...retainedNodes.values()];
  const edges = [...retainedEdges.values()];

  return {
    graphId: current.graphId,
    projectId: current.projectId,
    createdAt: current.createdAt,
    nodes,
    edges,
    summary: buildGraphSummary(nodes, edges),
  };
}

function buildGraphSummary(nodes: GraphNode[], edges: GraphEdge[]) {
  return {
    nodeCount: nodes.length,
    edgeCount: edges.length,
    fileCount: nodes.filter((node) => node.kind === "file").length,
    symbolCount: nodes.filter((node) => isCodeNode(node.kind)).length,
    dependencyCount: nodes.filter((node) => node.kind === "dependency").length,
    repositoryCount: nodes.filter((node) => node.kind === "repository").length,
    moduleCount: nodes.filter((node) => node.kind === "module").length,
    folderCount: nodes.filter((node) => node.kind === "folder").length,
    routeCount: nodes.filter((node) => node.kind === "route").length,
  };
}
