import type { GraphEdge, GraphNode, GraphState } from "@client/shared";
import { openSession } from "./neo4j-client.js";

/**
 * Persistent Knowledge Graph layer (Slice 4, docs/architecture/008-next-generation-architecture.md, раздел 6).
 *
 * Текущая реализация — первый шаг к целевой модели L1: граф сохраняется и переживает
 * перезапуск процесса. Полноценная snapshot+overlay модель по коммитам (раздел 6.2 документа 008)
 * ещё не реализована — сейчас граф хранится как единый актуальный срез на project, который
 * полностью перезаписывается при каждом успешном run. Это уже устраняет главный разрыв MVP
 * (in-memory граф без персистентности, см. 002-storage.md/project-state.md), но versioning
 * per-commit — предмет следующего инкремента.
 */

export async function initializeGraphStore(): Promise<void> {
  const session = openSession();

  try {
    await session.run(
      `create constraint graph_node_id_unique if not exists for (n:GraphNode) require (n.projectId, n.nodeId) is node key`,
    );
  } catch {
    // Older Neo4j editions may not support composite node keys the same way; fall back to a plain index.
    await session.run(`create index graph_node_lookup if not exists for (n:GraphNode) on (n.projectId, n.nodeId)`);
  }

  await session.run(`create index graph_edge_lookup if not exists for (n:GraphNode) on (n.projectId)`);
  await session.close();
}

export async function saveGraphSnapshot(graph: GraphState): Promise<void> {
  const session = openSession();

  try {
    await session.executeWrite(async (tx) => {
      await tx.run(`match (n:GraphNode { projectId: $projectId }) detach delete n`, {
        projectId: graph.projectId,
      });

      await tx.run(
        `
          unwind $nodes as node
          create (n:GraphNode {
            projectId: $projectId,
            graphId: $graphId,
            nodeId: node.id,
            kind: node.kind,
            label: node.label,
            filePath: node.filePath,
            metadata: node.metadata
          })
        `,
        {
          projectId: graph.projectId,
          graphId: graph.graphId,
          nodes: graph.nodes.map(serializeNode),
        },
      );

      await tx.run(
        `
          unwind $edges as edge
          match (source:GraphNode { projectId: $projectId, nodeId: edge.sourceId })
          match (target:GraphNode { projectId: $projectId, nodeId: edge.targetId })
          create (source)-[r:RELATES {
            edgeId: edge.id,
            type: edge.type,
            metadata: edge.metadata
          }]->(target)
        `,
        {
          projectId: graph.projectId,
          edges: graph.edges.map(serializeEdge),
        },
      );
    });
  } finally {
    await session.close();
  }
}

export async function loadGraphSnapshot(projectId: string): Promise<GraphState | null> {
  const session = openSession();

  try {
    const nodeResult = await session.run(
      `
        match (n:GraphNode { projectId: $projectId })
        return n.graphId as graphId, n.nodeId as nodeId, n.kind as kind, n.label as label,
               n.filePath as filePath, n.metadata as metadata
      `,
      { projectId },
    );

    if (nodeResult.records.length === 0) {
      return null;
    }

    const edgeResult = await session.run(
      `
        match (:GraphNode { projectId: $projectId })-[r:RELATES]->(:GraphNode { projectId: $projectId })
        return r.edgeId as edgeId, r.type as type, startNode(r).nodeId as sourceId, endNode(r).nodeId as targetId, r.metadata as metadata
      `,
      { projectId },
    );

    const graphId = String(nodeResult.records[0]?.get("graphId") ?? "");
    const nodes: GraphNode[] = nodeResult.records.map((record) => deserializeNode(record.toObject()));
    const edges: GraphEdge[] = edgeResult.records.map((record) => deserializeEdge(record.toObject()));

    return {
      graphId,
      projectId,
      createdAt: new Date().toISOString(),
      nodes,
      edges,
      summary: buildSummaryFromNodesAndEdges(nodes, edges),
    };
  } finally {
    await session.close();
  }
}

// Live evidence (2026-07-15): a raw grep for "relation" pulled in Eloquent's
// own vocabulary (withRelations/relationLoaded) plus an unrelated
// causal_relationship feature - too generic to discriminate. But the FULL
// persisted graph (from background-sync, not the narrow per-question graph)
// has precise, noise-free symbol names for the same task - a real match
// (e.g. "UnlinkRelatedCasesAction") never collides with framework plumbing
// the way free-text search does. Can't derive a file path from a label
// generically (namespace->path conventions are project-specific, e.g. this
// codebase's "Src\Containers\X" - would be exactly the hardcoding the user
// has repeatedly ruled out) - so this returns trailing SYMBOL NAMES to use as
// additional grep terms, letting the model's own tools resolve them to real
// files instead of guessing a path convention.
export async function findGraphSymbolHints(projectId: string, terms: string[], maxResults = 8): Promise<string[]> {
  if (terms.length === 0) {
    return [];
  }

  const session = openSession();

  try {
    const result = await session.run(
      `
        match (n:GraphNode { projectId: $projectId })
        where any(term in $terms where toLower(n.label) contains term)
        return distinct n.label as label
        limit 200
      `,
      { projectId, terms: terms.map((term) => term.toLowerCase()) },
    );

    const seen = new Set<string>();
    const symbols: string[] = [];

    for (const record of result.records) {
      const label = String(record.get("label") ?? "");
      // Generic trailing-identifier extraction - namespace/path separators
      // vary by language (\ in PHP, :: in C++/Rust, . in JS/Python, @ for a
      // class@method reference) but "take what's after the last one" holds
      // across all of them without assuming any specific convention.
      const segments = label.split(/[\\/.@]|::/).filter(Boolean);
      const symbol = segments[segments.length - 1];

      if (!symbol || symbol.length < 3) {
        continue;
      }

      const key = symbol.toLowerCase();

      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      symbols.push(symbol);

      if (symbols.length >= maxResults) {
        break;
      }
    }

    return symbols;
  } catch (error) {
    console.warn("[graph-store] findGraphSymbolHints failed, degrading to no hints:", error);
    return [];
  } finally {
    await session.close();
  }
}

export async function deleteGraphSnapshot(projectId: string): Promise<void> {
  const session = openSession();

  try {
    await session.run(`match (n:GraphNode { projectId: $projectId }) detach delete n`, { projectId });
  } finally {
    await session.close();
  }
}

function serializeNode(node: GraphNode): Record<string, unknown> {
  return {
    id: node.id,
    kind: node.kind,
    label: node.label,
    filePath: node.filePath ?? null,
    metadata: node.metadata ? JSON.stringify(node.metadata) : null,
  };
}

function deserializeNode(row: Record<string, unknown>): GraphNode {
  const metadataRaw = row.metadata;
  const filePath = row.filePath;

  return {
    id: String(row.nodeId),
    kind: row.kind as GraphNode["kind"],
    label: String(row.label),
    ...(typeof filePath === "string" && filePath ? { filePath } : {}),
    ...(typeof metadataRaw === "string" && metadataRaw ? { metadata: JSON.parse(metadataRaw) } : {}),
  };
}

function serializeEdge(edge: GraphEdge): Record<string, unknown> {
  return {
    id: edge.id,
    type: edge.type,
    sourceId: edge.sourceId,
    targetId: edge.targetId,
    metadata: edge.metadata ? JSON.stringify(edge.metadata) : null,
  };
}

function deserializeEdge(row: Record<string, unknown>): GraphEdge {
  const metadataRaw = row.metadata;

  return {
    id: String(row.edgeId),
    type: row.type as GraphEdge["type"],
    sourceId: String(row.sourceId),
    targetId: String(row.targetId),
    ...(typeof metadataRaw === "string" && metadataRaw ? { metadata: JSON.parse(metadataRaw) } : {}),
  };
}

function buildSummaryFromNodesAndEdges(nodes: GraphNode[], edges: GraphEdge[]): GraphState["summary"] {
  return {
    nodeCount: nodes.length,
    edgeCount: edges.length,
    fileCount: nodes.filter((node) => node.kind === "file").length,
    symbolCount: nodes.filter((node) =>
      node.kind === "class"
      || node.kind === "interface"
      || node.kind === "enum"
      || node.kind === "function"
      || node.kind === "method",
    ).length,
    dependencyCount: nodes.filter((node) => node.kind === "dependency").length,
    repositoryCount: nodes.filter((node) => node.kind === "repository").length,
    moduleCount: nodes.filter((node) => node.kind === "module").length,
    folderCount: nodes.filter((node) => node.kind === "folder").length,
    routeCount: nodes.filter((node) => node.kind === "route").length,
  };
}
