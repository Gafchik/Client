<script setup lang="ts">
import { computed, reactive } from "vue";
import type { ProjectMemoryEntry } from "../../types";

type GraphNode = {
  id: string;
  name: string;
  kind: string;
  location?: string;
  feature?: string;
};

type GraphRelation = {
  from: string;
  to: string;
  type: string;
  reason?: string;
};

type PositionedNode = GraphNode & {
  x: number;
  y: number;
  color: string;
  metrics: { in: number; out: number; degree: number };
};

const props = defineProps<{
  open: boolean;
  loading: boolean;
  error?: string;
  entry: ProjectMemoryEntry | null;
}>();

const emit = defineEmits<{
  (e: "close"): void;
  (e: "refresh"): void;
  (e: "resync"): void;
}>();

const ui = reactive({
  search: "",
  selectedKinds: new Set<string>(),
  selectedRelationTypes: new Set<string>(),
  activeNodeId: "",
});

const graph = computed(() => {
  const raw = (props.entry?.graph || {}) as Record<string, unknown>;
  const entityIndex = Array.isArray(raw.entityIndex) ? raw.entityIndex : [];
  const relations = Array.isArray(raw.relations) ? raw.relations : [];
  const coverage = (raw.coverage && typeof raw.coverage === "object" ? raw.coverage : {}) as Record<string, unknown>;

  const nodes: GraphNode[] = entityIndex
    .filter((item) => item && typeof item === "object")
    .map((item: any) => ({
      id: String(item.id || ""),
      name: String(item.name || item.id || "Сущность"),
      kind: String(item.kind || "Другое"),
      location: item.location ? String(item.location) : undefined,
      feature: item.feature ? String(item.feature) : undefined,
    }))
    .filter((n) => n.id);

  const edges: GraphRelation[] = relations
    .filter((item) => item && typeof item === "object")
    .map((item: any) => ({
      from: String(item.from || ""),
      to: String(item.to || ""),
      type: String(item.type || "related_to"),
      reason: item.reason ? String(item.reason) : "",
    }))
    .filter((r) => r.from && r.to);

  return {
    nodes,
    edges,
    coverage,
    unknowns: Array.isArray(raw.unknowns) ? raw.unknowns.map((x) => String(x || "")).filter(Boolean).slice(0, 50) : [],
  };
});

const kindStats = computed(() => {
  const map = new Map<string, number>();
  for (const node of graph.value.nodes) {
    map.set(node.kind, (map.get(node.kind) || 0) + 1);
  }
  return Array.from(map.entries())
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind));
});

const relationTypeStats = computed(() => {
  const map = new Map<string, number>();
  for (const edge of graph.value.edges) {
    map.set(edge.type, (map.get(edge.type) || 0) + 1);
  }
  return Array.from(map.entries())
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
});

const filteredNodes = computed(() => {
  const q = ui.search.trim().toLowerCase();
  return graph.value.nodes.filter((node) => {
    if (ui.selectedKinds.size && !ui.selectedKinds.has(node.kind)) return false;
    if (!q) return true;
    return [node.id, node.name, node.kind, node.location || ""].join(" ").toLowerCase().includes(q);
  });
});

const filteredEdges = computed(() => {
  const allowedNodes = new Set(filteredNodes.value.map((n) => n.id));
  return graph.value.edges.filter((edge) => {
    if (ui.selectedRelationTypes.size && !ui.selectedRelationTypes.has(edge.type)) return false;
    return allowedNodes.has(edge.from) && allowedNodes.has(edge.to);
  });
});

const nodeMetrics = computed(() => {
  const map = new Map<string, { in: number; out: number; degree: number }>();
  for (const node of filteredNodes.value) map.set(node.id, { in: 0, out: 0, degree: 0 });
  for (const edge of filteredEdges.value) {
    const from = map.get(edge.from);
    const to = map.get(edge.to);
    if (from) from.out += 1;
    if (to) to.in += 1;
  }
  for (const value of map.values()) value.degree = value.in + value.out;
  return map;
});

const nodePalette = ["#8b5cf6", "#38bdf8", "#f59e0b", "#22c55e", "#f97316", "#a855f7", "#06b6d4", "#84cc16"];

function colorByKind(kind: string): string {
  let h = 0;
  for (let i = 0; i < kind.length; i += 1) h = (h * 31 + kind.charCodeAt(i)) >>> 0;
  return nodePalette[h % nodePalette.length];
}

const topNodes = computed(() => {
  const rows = [...filteredNodes.value]
    .sort((a, b) => (nodeMetrics.value.get(b.id)?.degree || 0) - (nodeMetrics.value.get(a.id)?.degree || 0));
  return rows.slice(0, 9);
});

const centerNode = computed(() => {
  if (ui.activeNodeId) {
    const found = topNodes.value.find((n) => n.id === ui.activeNodeId);
    if (found) return found;
  }
  return topNodes.value[0] || null;
});

const renderedNodes = computed(() => {
  if (!centerNode.value) return [] as PositionedNode[];
  const centerX = 50;
  const centerY = 48;
  const ring = topNodes.value.filter((n) => n.id !== centerNode.value?.id).slice(0, 8);

  const positioned: PositionedNode[] = [{
    ...centerNode.value,
    x: centerX,
    y: centerY,
    color: "#2563eb",
    metrics: nodeMetrics.value.get(centerNode.value.id) || { in: 0, out: 0, degree: 0 },
  }];

  ring.forEach((node, index) => {
    const angle = (Math.PI * 2 * index) / Math.max(ring.length, 1) - Math.PI / 2;
    const x = centerX + Math.cos(angle) * 34;
    const y = centerY + Math.sin(angle) * 28;
    positioned.push({
      ...node,
      x,
      y,
      color: colorByKind(node.kind),
      metrics: nodeMetrics.value.get(node.id) || { in: 0, out: 0, degree: 0 },
    });
  });

  return positioned;
});

const renderedEdges = computed(() => {
  const nodes = new Map(renderedNodes.value.map((n) => [n.id, n]));
  return filteredEdges.value
    .filter((edge) => nodes.has(edge.from) && nodes.has(edge.to))
    .slice(0, 60)
    .map((edge) => {
      const from = nodes.get(edge.from)!;
      const to = nodes.get(edge.to)!;
      const cx = (from.x + to.x) / 2;
      const cy = (from.y + to.y) / 2 - 6;
      return {
        ...edge,
        d: `M ${from.x} ${from.y} Q ${cx} ${cy} ${to.x} ${to.y}`,
      };
    });
});

const activeNode = computed(() => {
  if (ui.activeNodeId) {
    return filteredNodes.value.find((n) => n.id === ui.activeNodeId) || null;
  }
  return centerNode.value;
});

const activeNodeRelations = computed(() => {
  if (!activeNode.value) return { outgoing: [] as GraphRelation[], incoming: [] as GraphRelation[] };
  const id = activeNode.value.id;
  return {
    outgoing: filteredEdges.value.filter((r) => r.from === id).slice(0, 20),
    incoming: filteredEdges.value.filter((r) => r.to === id).slice(0, 20),
  };
});

const graphCoverage = computed(() => {
  const values = Object.values(graph.value.coverage).map((value) => Number(value || 0)).filter((n) => Number.isFinite(n));
  if (!values.length) return 0;
  return Math.round(values.reduce((sum, item) => sum + item, 0) / values.length);
});

function toggleKind(kind: string) {
  if (ui.selectedKinds.has(kind)) ui.selectedKinds.delete(kind);
  else ui.selectedKinds.add(kind);
}

function toggleRelationType(type: string) {
  if (ui.selectedRelationTypes.has(type)) ui.selectedRelationTypes.delete(type);
  else ui.selectedRelationTypes.add(type);
}

function selectNode(id: string) {
  ui.activeNodeId = id;
}

function exportJson() {
  const payload = {
    generatedAt: new Date().toISOString(),
    nodes: filteredNodes.value,
    relations: filteredEdges.value,
    coverage: graph.value.coverage,
    unknowns: graph.value.unknowns,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const href = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = href;
  link.download = "project-knowledge-graph.json";
  link.click();
  URL.revokeObjectURL(href);
}
</script>

<template>
  <div v-if="open" class="kg-backdrop">
    <section class="kg-modal">
      <header class="kg-toolbar">
        <div class="title-wrap">
          <strong>Project Map</strong>
          <span>v1.0</span>
        </div>
        <input v-model="ui.search" type="text" placeholder="Search entities (файл, модуль, сервис...)" />
        <button class="tool" @click="emit('refresh')">Fit</button>
        <button class="tool" @click="emit('resync')">Resync Project</button>
        <button class="tool" @click="exportJson">Export</button>
        <button class="tool danger" @click="emit('close')">✕</button>
      </header>

      <p v-if="loading" class="status">Загрузка графа...</p>
      <p v-else-if="error" class="status error">{{ error }}</p>

      <div v-else class="kg-layout">
        <aside class="left-panel">
          <h3>Filters & Layers</h3>
          <div class="filter-block">
            <h4>Entity Types</h4>
            <button
              v-for="item in kindStats"
              :key="item.kind"
              class="chip"
              :class="{ active: ui.selectedKinds.has(item.kind) }"
              @click="toggleKind(item.kind)"
            >
              <span>{{ item.kind }}</span>
              <strong>{{ item.count }}</strong>
            </button>
          </div>
          <div class="filter-block">
            <h4>Relationships</h4>
            <button
              v-for="item in relationTypeStats"
              :key="item.type"
              class="chip"
              :class="{ active: ui.selectedRelationTypes.has(item.type) }"
              @click="toggleRelationType(item.type)"
            >
              <span>{{ item.type }}</span>
              <strong>{{ item.count }}</strong>
            </button>
          </div>
        </aside>

        <main class="graph-center">
          <svg class="edge-layer" viewBox="0 0 100 100" preserveAspectRatio="none">
            <path
              v-for="edge in renderedEdges"
              :key="`${edge.from}-${edge.type}-${edge.to}`"
              :d="edge.d"
              class="edge"
            />
          </svg>

          <button
            v-for="node in renderedNodes"
            :key="node.id"
            class="node"
            :class="{ core: node.id === centerNode?.id, active: activeNode?.id === node.id }"
            :style="{ left: `${node.x}%`, top: `${node.y}%`, borderColor: node.color }"
            @click="selectNode(node.id)"
          >
            <strong>{{ node.name }}</strong>
            <span>{{ node.metrics.degree }} связей</span>
          </button>

          <div class="mini-map" />
        </main>

        <aside class="right-panel">
          <h3>{{ activeNode?.name || "Inspector" }}</h3>
          <p class="subtitle">{{ activeNode?.kind || "Выберите узел" }}</p>

          <div class="info-block" v-if="activeNode">
            <h4>Overview</h4>
            <p>{{ activeNode.location || activeNode.id }}</p>
          </div>

          <div class="info-block">
            <h4>Relations</h4>
            <p><strong>Исходящие:</strong> {{ activeNodeRelations.outgoing.length }}</p>
            <p><strong>Входящие:</strong> {{ activeNodeRelations.incoming.length }}</p>
          </div>

          <div class="info-block" v-if="graph.unknowns.length">
            <h4>Unknowns</h4>
            <ul>
              <li v-for="item in graph.unknowns.slice(0, 6)" :key="item">{{ item }}</li>
            </ul>
          </div>
        </aside>
      </div>

      <footer class="kg-bottom">
        <div class="stat-card"><span>Total Entities</span><strong>{{ filteredNodes.length }}</strong></div>
        <div class="stat-card"><span>Total Relations</span><strong>{{ filteredEdges.length }}</strong></div>
        <div class="stat-card"><span>Coverage</span><strong>{{ graphCoverage }}%</strong></div>
        <div class="stat-card"><span>Quick Actions</span><small>Find Unused · Analyze Dependencies · Generate Docs</small></div>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.kg-backdrop {
  position: fixed;
  inset: 0;
  z-index: 220;
  background: rgba(2, 6, 23, 0.9);
  display: grid;
  place-items: center;
  padding: 12px;
}

.kg-modal {
  width: min(98vw, 1760px);
  height: min(96vh, 1040px);
  border: 1px solid rgba(96, 165, 250, 0.25);
  border-radius: 14px;
  background: radial-gradient(circle at 15% 10%, rgba(37, 99, 235, 0.2), transparent 30%),
    radial-gradient(circle at 80% 80%, rgba(16, 185, 129, 0.15), transparent 35%),
    #050a14;
  color: #dbeafe;
  display: grid;
  grid-template-rows: auto 1fr auto;
  overflow: hidden;
}

.kg-toolbar {
  display: grid;
  grid-template-columns: auto minmax(280px, 1fr) auto auto auto auto;
  gap: 8px;
  align-items: center;
  padding: 10px;
  border-bottom: 1px solid rgba(148, 163, 184, 0.2);
}

.title-wrap {
  display: flex;
  align-items: center;
  gap: 8px;
}

.title-wrap span {
  font-size: 11px;
  color: #94a3b8;
}

.kg-toolbar input {
  width: 100%;
  border: 1px solid rgba(148, 163, 184, 0.28);
  background: #0b1320;
  color: #dbeafe;
  border-radius: 10px;
  padding: 9px 10px;
}

.tool {
  border-radius: 10px;
  border: 1px solid rgba(148, 163, 184, 0.25);
  background: #0b1320;
  color: #cbd5e1;
  padding: 8px 10px;
}

.tool.danger {
  color: #fca5a5;
  border-color: rgba(248, 113, 113, 0.4);
}

.status {
  padding: 12px;
  color: #93c5fd;
}

.status.error {
  color: #fca5a5;
}

.kg-layout {
  min-height: 0;
  display: grid;
  grid-template-columns: 270px minmax(540px, 1fr) 320px;
  gap: 10px;
  padding: 10px;
}

.left-panel,
.right-panel,
.graph-center {
  border: 1px solid rgba(148, 163, 184, 0.18);
  border-radius: 12px;
  background: rgba(2, 10, 25, 0.82);
  min-height: 0;
}

.left-panel,
.right-panel {
  padding: 10px;
  overflow: auto;
}

.left-panel h3,
.right-panel h3 {
  margin: 0 0 10px;
  font-size: 14px;
  color: #93c5fd;
}

.filter-block {
  margin-bottom: 12px;
}

.filter-block h4,
.info-block h4 {
  margin: 0 0 8px;
  font-size: 12px;
  color: #cbd5e1;
}

.chip {
  width: 100%;
  display: flex;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
  border-radius: 8px;
  border: 1px solid rgba(148, 163, 184, 0.25);
  background: #0b1320;
  color: #cbd5e1;
  padding: 6px 8px;
}

.chip.active {
  border-color: rgba(59, 130, 246, 0.6);
  background: rgba(37, 99, 235, 0.2);
}

.graph-center {
  position: relative;
  overflow: hidden;
}

.edge-layer {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}

.edge {
  fill: none;
  stroke: rgba(96, 165, 250, 0.5);
  stroke-width: 0.35;
  stroke-dasharray: 1.2 0.8;
}

.node {
  position: absolute;
  transform: translate(-50%, -50%);
  width: 150px;
  border-radius: 12px;
  border: 1px solid;
  background: linear-gradient(180deg, rgba(14, 25, 47, 0.9), rgba(7, 14, 27, 0.9));
  color: #dbeafe;
  padding: 8px;
  text-align: left;
}

.node strong {
  display: block;
  font-size: 13px;
}

.node span {
  display: block;
  margin-top: 2px;
  font-size: 11px;
  color: #93c5fd;
}

.node.core {
  width: 170px;
  box-shadow: 0 0 0 1px rgba(37, 99, 235, 0.6) inset, 0 0 20px rgba(37, 99, 235, 0.25);
}

.node.active {
  box-shadow: 0 0 0 1px rgba(16, 185, 129, 0.7) inset;
}

.mini-map {
  position: absolute;
  right: 12px;
  bottom: 12px;
  width: 120px;
  height: 84px;
  border: 1px solid rgba(148, 163, 184, 0.22);
  border-radius: 10px;
  background: linear-gradient(135deg, rgba(30, 41, 59, 0.6), rgba(2, 6, 23, 0.7));
}

.subtitle {
  margin: -6px 0 10px;
  color: #94a3b8;
  font-size: 12px;
}

.info-block {
  margin-bottom: 12px;
}

.info-block p,
.info-block li {
  margin: 4px 0;
  font-size: 12px;
  color: #cbd5e1;
  word-break: break-word;
}

.info-block ul {
  margin: 0;
  padding-left: 16px;
}

.kg-bottom {
  border-top: 1px solid rgba(148, 163, 184, 0.2);
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
  padding: 10px;
}

.stat-card {
  border: 1px solid rgba(148, 163, 184, 0.2);
  border-radius: 10px;
  padding: 8px 10px;
  background: #0b1320;
}

.stat-card span {
  display: block;
  font-size: 11px;
  color: #94a3b8;
}

.stat-card strong {
  font-size: 22px;
  color: #e2e8f0;
}

.stat-card small {
  display: block;
  margin-top: 2px;
  font-size: 11px;
  color: #93c5fd;
}

@media (max-width: 1200px) {
  .kg-layout {
    grid-template-columns: 1fr;
  }

  .kg-bottom {
    grid-template-columns: 1fr 1fr;
  }

  .kg-toolbar {
    grid-template-columns: 1fr;
  }
}
</style>
