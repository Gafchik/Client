import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { execSync } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import * as fs from "fs";
import { Repository } from "typeorm";
import { ProjectMemoryEntryEntity } from "../../persistence/project-memory.entity.js";
import { ProjectEntity } from "../../persistence/project.entity.js";
import { TeamEntity } from "../../persistence/team.entity.js";
import { ChatEntity } from "../../persistence/chat.entity.js";
import { MessageEntity } from "../../persistence/message.entity.js";
import { RunEntity } from "../../persistence/run.entity.js";
import { WsGateway } from "../ws/ws.gateway.js";
import { SaveProjectMemoryDto } from "./dto/save-project-memory.dto.js";
import { SaveProjectDto } from "./dto/save-project.dto.js";

type ResyncStageKey =
  | "scan"
  | "detect"
  | "research"
  | "knowledge_graph"
  | "relationships"
  | "documentation"
  | "memory"
  | "coverage"
  | "validation"
  | "optimize";

type ResyncStageState = {
  key: ResyncStageKey;
  title: string;
  status: "pending" | "active" | "done" | "error";
  startedAt?: string;
  finishedAt?: string;
  durationMs: number;
  message?: string;
};

@Injectable()
export class ProjectsService {
  private readonly relationTypes = new Set<string>([
    "uses", "used_by", "calls", "called_by", "implements", "extends", "belongs_to", "contains",
    "creates", "reads", "writes", "updates", "deletes", "renders", "depends_on", "owns", "emits",
    "listens", "validates", "returns", "imports", "exports", "related_to",
  ]);

  private readonly reverseRelationMap: Record<string, string> = {
    uses: "used_by",
    used_by: "uses",
    calls: "called_by",
    called_by: "calls",
    imports: "used_by",
    exports: "related_to",
    extends: "related_to",
    implements: "related_to",
    belongs_to: "contains",
    contains: "belongs_to",
    creates: "used_by",
    reads: "used_by",
    writes: "used_by",
    updates: "used_by",
    deletes: "used_by",
    renders: "used_by",
    depends_on: "used_by",
    owns: "belongs_to",
    emits: "listens",
    listens: "emits",
    validates: "related_to",
    returns: "used_by",
    related_to: "related_to",
  };

  constructor(
    @InjectRepository(ProjectEntity)
    private readonly projectsRepository: Repository<ProjectEntity>,
    @InjectRepository(ProjectMemoryEntryEntity)
    private readonly projectMemoryRepository: Repository<ProjectMemoryEntryEntity>,
    @InjectRepository(TeamEntity)
    private readonly teamsRepository: Repository<TeamEntity>,
    @InjectRepository(ChatEntity)
    private readonly chatsRepository: Repository<ChatEntity>,
    @InjectRepository(MessageEntity)
    private readonly messagesRepository: Repository<MessageEntity>,
    @InjectRepository(RunEntity)
    private readonly runsRepository: Repository<RunEntity>,
    @Inject(ConfigService)
    private readonly configService: ConfigService,
    @Inject(WsGateway)
    private readonly wsGateway: WsGateway,
  ) {}

  private readonly scanIgnoreDirs = new Set([
    ".git",
    "node_modules",
    "vendor",
    "bower_components",
    "__pycache__",
    ".venv",
    "venv",
    ".cache",
    ".turbo",
    "dist",
    "build",
    ".next",
    "coverage",
    ".idea",
    ".vscode",
  ]);

  private readonly scanExtensions = new Set([
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".json",
    ".vue",
    ".md",
    ".mdx",
    ".yml",
    ".yaml",
    ".sql",
    ".sh",
    ".css",
    ".scss",
    ".html",
    ".xml",
    ".env",
  ]);

  private readonly dependencyScanExtensions = new Set([
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".vue",
    ".php",
  ]);

  async list() {
    return this.projectsRepository.find({
      relations: {
        team: true,
      },
      order: {
        updatedAt: "DESC",
      },
    });
  }

  async getById(id: string) {
    const project = await this.projectsRepository.findOne({
      where: { id },
      relations: {
        team: true,
      },
    });
    if (!project) throw new NotFoundException("Project not found");
    return project;
  }

  async listMemory(projectId: string) {
    await this.getById(projectId);
    return this.projectMemoryRepository.find({
      where: { projectId, isActive: true },
      order: { updatedAt: "DESC" },
    });
  }

  async searchMemory(projectId: string, query: string, limit = 6) {
    await this.getById(projectId);
    const normalizedQuery = String(query || "").trim().toLowerCase();
    if (!normalizedQuery) {
      return this.projectMemoryRepository.find({
        where: { projectId, isActive: true },
        order: { updatedAt: "DESC" },
        take: limit,
      });
    }

    const entries = await this.projectMemoryRepository.find({
      where: { projectId, isActive: true },
      order: { updatedAt: "DESC" },
      take: Math.max(limit * 4, 20),
    });

    const keywords = normalizedQuery
      .split(/[\s,.;:!?()[\]{}"']+/)
      .map((item) => item.trim())
      .filter((item) => item.length > 2);

    const scoreEntry = (entry: ProjectMemoryEntryEntity) => {
      const haystack = [
        entry.title,
        entry.summary,
        entry.details,
        ...(entry.tags || []),
        ...(entry.relatedFiles || []),
      ].join(" \n ").toLowerCase();
      let score = entry.relevanceScore || 0;
      if (entry.kind === "knowledge-graph-index") score += 6;
      if ((entry.tags || []).includes("source-of-truth")) score += 4;
      for (const keyword of keywords) {
        if (haystack.includes(keyword)) score += 2;
      }
      if (haystack.includes(normalizedQuery)) score += 4;
      return score;
    };

    return entries
      .map((entry) => ({ entry, score: scoreEntry(entry) }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score || new Date(b.entry.updatedAt).getTime() - new Date(a.entry.updatedAt).getTime())
      .slice(0, limit)
      .map(({ entry }) => entry);
  }

  private mergeUniqueObjects<T extends Record<string, any>>(existing: T[], incoming: T[], keyBuilder: (item: T) => string): T[] {
    const map = new Map<string, T>();
    for (const item of existing) {
      const key = keyBuilder(item);
      if (key) map.set(key, item);
    }
    for (const item of incoming) {
      const key = keyBuilder(item);
      if (!key) continue;
      const prev = map.get(key);
      map.set(key, prev ? { ...prev, ...item } : item);
    }
    return Array.from(map.values());
  }

  private normalizeCoverageValue(value: unknown): number {
    const num = Number(value);
    if (!Number.isFinite(num)) return 0;
    return Math.max(0, Math.min(100, Math.round(num)));
  }

  private normalizeRelationType(value: unknown): string {
    const normalized = String(value || "").trim().toLowerCase().replace(/\s+/g, "_");
    if (!normalized) return "related_to";
    return this.relationTypes.has(normalized) ? normalized : "related_to";
  }

  private reverseRelationType(type: string): string {
    return this.reverseRelationMap[type] || "related_to";
  }

  private normalizeNodeId(value: unknown): string {
    const raw = String(value || "").trim();
    if (!raw) return "";
    return raw.replace(/\\/g, "/");
  }

  private normalizeEntityIndexItem(item: Record<string, any>): Record<string, any> {
    const id = this.normalizeNodeId(item.id || `${item.kind || "entity"}:${item.name || item.path || item.location || "unknown"}`);
    return {
      ...item,
      id,
      name: String(item.name || item.id || item.path || "Unknown"),
      kind: String(item.kind || "Unknown"),
      location: String(item.location || item.path || "unknown"),
      feature: item.feature ? String(item.feature) : undefined,
    };
  }

  private collectGraphNodes(graph: Record<string, any>): Array<Record<string, any>> {
    const nodes: Array<Record<string, any>> = [];
    const pushNode = (node: Record<string, any>) => {
      const normalized = this.normalizeEntityIndexItem(node);
      if (!normalized.id) return;
      nodes.push(normalized);
    };

    const entityIndex = Array.isArray(graph.entityIndex) ? graph.entityIndex : [];
    for (const item of entityIndex) {
      if (item && typeof item === "object") pushNode(item as Record<string, any>);
    }

    const entities = Array.isArray(graph.entities) ? graph.entities : [];
    for (const entity of entities) {
      if (!entity || typeof entity !== "object") continue;
      const e = entity as Record<string, any>;
      pushNode({
        id: e.id || `${e.kind || "entity"}:${e.name || e.location || "unknown"}`,
        name: e.name || e.id,
        kind: e.kind || "Entity",
        location: e.location || "unknown",
        feature: Array.isArray(e.featureIds) && e.featureIds.length ? e.featureIds[0] : undefined,
      });
    }

    const files = Array.isArray(graph.files) ? graph.files : [];
    for (const file of files) {
      if (!file || typeof file !== "object") continue;
      const f = file as Record<string, any>;
      const filePath = String(f.path || "");
      if (!filePath) continue;
      pushNode({
        id: `file:${filePath}`,
        name: path.basename(filePath),
        kind: String(f.type || "File"),
        location: filePath,
      });
    }

    const modules = Array.isArray(graph.modules) ? graph.modules : [];
    for (const module of modules) {
      if (!module || typeof module !== "object") continue;
      const m = module as Record<string, any>;
      const moduleId = String(m.id || m.name || "");
      if (!moduleId) continue;
      pushNode({
        id: `module:${moduleId}`,
        name: m.name || moduleId,
        kind: "Module",
        location: Array.isArray(m.paths) ? String(m.paths[0] || "unknown") : "unknown",
      });
    }

    const features = Array.isArray(graph.features) ? graph.features : [];
    for (const feature of features) {
      if (!feature || typeof feature !== "object") continue;
      const f = feature as Record<string, any>;
      const featureId = String(f.id || f.name || "");
      if (!featureId) continue;
      pushNode({
        id: `feature:${featureId}`,
        name: f.name || featureId,
        kind: "Feature",
        location: "graph:features",
        feature: featureId,
      });
    }

    return this.mergeUniqueObjects(nodes, [], (item) => String(item.id || ""));
  }

  private buildGraphFileHashes(
    projectLocalPath: string,
    relatedFiles: string[],
    previousHashes: Record<string, any>,
  ): Record<string, { hash: string; size: number; mtimeMs: number; unchanged: boolean }> {
    const hashes: Record<string, { hash: string; size: number; mtimeMs: number; unchanged: boolean }> = {};
    for (const rel of relatedFiles) {
      const normalizedRel = String(rel || "").replace(/\\/g, "/").trim();
      if (!normalizedRel) continue;
      const abs = path.resolve(projectLocalPath, normalizedRel);
      try {
        const stat = fs.statSync(abs);
        if (!stat.isFile()) continue;
        const content = fs.readFileSync(abs);
        const hash = crypto.createHash("sha1").update(content).digest("hex");
        const prev = previousHashes?.[normalizedRel];
        const unchanged = Boolean(prev && prev.hash === hash);
        hashes[normalizedRel] = {
          hash,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          unchanged,
        };
      } catch {
        // Файл мог быть удалён/перемещён — не роняем сборку графа.
      }
    }
    return hashes;
  }

  private enrichKnowledgeGraph(
    graph: Record<string, any>,
    projectLocalPath: string,
    relatedFiles: string[],
    previousGraph: Record<string, any>,
  ): Record<string, unknown> {
    const rawRelations = Array.isArray(graph.relations) ? graph.relations : [];
    const normalizedRelations = this.mergeUniqueObjects(
      rawRelations
        .filter((item: any) => item && typeof item === "object")
        .map((item: any) => ({
          from: this.normalizeNodeId(item.from),
          to: this.normalizeNodeId(item.to),
          type: this.normalizeRelationType(item.type),
          reason: String(item.reason || ""),
        }))
        .filter((item: any) => item.from && item.to),
      [],
      (item: Record<string, any>) => `${item.from}|${item.type}|${item.to}`,
    );

    const relationMap = new Map<string, Record<string, any>>();
    for (const relation of normalizedRelations) {
      relationMap.set(`${relation.from}|${relation.type}|${relation.to}`, relation);
      const reverseType = this.reverseRelationType(relation.type);
      const reverseKey = `${relation.to}|${reverseType}|${relation.from}`;
      if (!relationMap.has(reverseKey)) {
        relationMap.set(reverseKey, {
          from: relation.to,
          to: relation.from,
          type: reverseType,
          reason: relation.reason || `Auto reverse for ${relation.type}`,
          inferred: true,
        });
      }
    }
    const relations = Array.from(relationMap.values());

    const nodes = this.collectGraphNodes({ ...graph, relations });
    const outgoing: Record<string, Array<{ to: string; type: string }>> = {};
    const incoming: Record<string, Array<{ from: string; type: string }>> = {};
    for (const relation of relations) {
      if (!outgoing[relation.from]) outgoing[relation.from] = [];
      if (!incoming[relation.to]) incoming[relation.to] = [];
      outgoing[relation.from].push({ to: relation.to, type: relation.type });
      incoming[relation.to].push({ from: relation.from, type: relation.type });
    }

    const nodeMetrics: Record<string, { outgoing: number; incoming: number; degree: number; impactScore: number }> = {};
    for (const node of nodes) {
      const outCount = outgoing[node.id]?.length || 0;
      const inCount = incoming[node.id]?.length || 0;
      const degree = outCount + inCount;
      nodeMetrics[node.id] = {
        outgoing: outCount,
        incoming: inCount,
        degree,
        impactScore: inCount * 2 + outCount,
      };
    }

    const previousHashes = previousGraph?.fileHashes && typeof previousGraph.fileHashes === "object"
      ? previousGraph.fileHashes as Record<string, any>
      : {};
    const fileHashes = this.buildGraphFileHashes(projectLocalPath, relatedFiles, previousHashes);

    const changedFiles = Object.entries(fileHashes)
      .filter(([, info]) => !info.unchanged)
      .map(([file]) => file);

    return {
      ...graph,
      relations,
      entityIndex: this.mergeUniqueObjects(
        Array.isArray(graph.entityIndex) ? graph.entityIndex as Record<string, any>[] : [],
        nodes,
        (item) => String(item.id || `${item.kind || ""}:${item.name || ""}:${item.location || ""}`),
      ),
      indexes: {
        outgoing,
        incoming,
      },
      metrics: {
        nodeCount: nodes.length,
        relationCount: relations.length,
        connectedNodeCount: Object.keys(nodeMetrics).filter((id) => nodeMetrics[id].degree > 0).length,
        nodeMetrics,
        updatedAt: new Date().toISOString(),
      },
      fileHashes,
      incremental: {
        changedFiles,
        unchangedFiles: Object.entries(fileHashes).filter(([, info]) => info.unchanged).map(([file]) => file),
      },
    };
  }

  private async getLatestKnowledgeGraphEntry(projectId: string): Promise<ProjectMemoryEntryEntity | null> {
    await this.getById(projectId);
    const [indexEntry] = await this.projectMemoryRepository.find({
      where: { projectId, isActive: true, kind: "knowledge-graph-index" },
      order: { updatedAt: "DESC" },
      take: 1,
    });
    if (indexEntry) return indexEntry;
    const [fallback] = await this.projectMemoryRepository.find({
      where: { projectId, isActive: true },
      order: { updatedAt: "DESC" },
      take: 1,
    });
    return fallback || null;
  }

  async getKnowledgeGraph(projectId: string) {
    const entry = await this.getLatestKnowledgeGraphEntry(projectId);
    if (!entry) return null;
    return entry;
  }

  async getEntityDependencies(projectId: string, entityIdOrName: string) {
    const entry = await this.getLatestKnowledgeGraphEntry(projectId);
    if (!entry) return { entity: entityIdOrName, dependencies: [], usedBy: [], relatedFeatures: [], relatedApi: [], models: [], coveringTests: [] };
    const graph = entry.graph && typeof entry.graph === "object" ? entry.graph as Record<string, any> : {};
    const entityIndex = Array.isArray(graph.entityIndex) ? graph.entityIndex : [];
    const normalized = String(entityIdOrName || "").trim().toLowerCase();
    const node = entityIndex.find((item: any) => {
      const id = String(item?.id || "").toLowerCase();
      const name = String(item?.name || "").toLowerCase();
      return normalized === id || normalized === name;
    });
    const nodeId = String(node?.id || entityIdOrName || "");
    const outgoing = graph.indexes?.outgoing?.[nodeId] || [];
    const incoming = graph.indexes?.incoming?.[nodeId] || [];
    const features = Array.isArray(graph.features) ? graph.features : [];
    const apiMap = Array.isArray(graph.apiMap) ? graph.apiMap : [];
    const dataModels = Array.isArray(graph.dataModels) ? graph.dataModels : [];

    const relatedFeatures = features.filter((f: any) => {
      const id = String(f?.id || "");
      const text = JSON.stringify(f || {}).toLowerCase();
      return text.includes(nodeId.toLowerCase()) || (node?.feature && id === String(node.feature));
    }).map((f: any) => f.id || f.name);

    const relatedApi = apiMap.filter((a: any) => JSON.stringify(a || {}).toLowerCase().includes(nodeId.toLowerCase()))
      .map((a: any) => `${a.method || "Unknown"} ${a.url || "Unknown"}`);

    const models = dataModels.filter((m: any) => JSON.stringify(m || {}).toLowerCase().includes(nodeId.toLowerCase()))
      .map((m: any) => m.name || m.location || "Unknown");

    const coveringTests = entityIndex
      .filter((item: any) => {
        const kind = String(item?.kind || "").toLowerCase();
        const loc = String(item?.location || item?.path || "").toLowerCase();
        if (kind.includes("test") || loc.includes(".spec.") || loc.includes(".test.")) return true;
        return false;
      })
      .filter((testNode: any) => {
        const tid = String(testNode?.id || "");
        const uses = graph.indexes?.outgoing?.[tid] || [];
        return uses.some((rel: any) => String(rel?.to || "") === nodeId);
      })
      .map((item: any) => item.location || item.id);

    return {
      entity: node || { id: nodeId, name: entityIdOrName },
      dependencies: outgoing,
      usedBy: incoming,
      relatedFeatures,
      relatedApi,
      models,
      coveringTests,
      metrics: graph.metrics?.nodeMetrics?.[nodeId] || null,
    };
  }

  async analyzeImpact(projectId: string, changed: string[]) {
    const entry = await this.getLatestKnowledgeGraphEntry(projectId);
    if (!entry) {
      return {
        changed,
        impactedNodes: [],
        impactedFiles: [],
        impactedServices: [],
        impactedApi: [],
        impactedPages: [],
        testsToRun: [],
      };
    }
    const graph = entry.graph && typeof entry.graph === "object" ? entry.graph as Record<string, any> : {};
    const incoming = graph.indexes?.incoming && typeof graph.indexes.incoming === "object"
      ? graph.indexes.incoming as Record<string, Array<{ from: string; type: string }>>
      : {};
    const outgoing = graph.indexes?.outgoing && typeof graph.indexes.outgoing === "object"
      ? graph.indexes.outgoing as Record<string, Array<{ to: string; type: string }>>
      : {};
    const nodes = Array.isArray(graph.entityIndex) ? graph.entityIndex : [];

    const seedIds = new Set<string>();
    for (const c of changed || []) {
      const normalized = String(c || "").trim().toLowerCase();
      if (!normalized) continue;
      seedIds.add(normalized);
      seedIds.add(`file:${normalized}`);
      for (const node of nodes) {
        const id = String(node?.id || "").toLowerCase();
        const name = String(node?.name || "").toLowerCase();
        const loc = String(node?.location || node?.path || "").toLowerCase();
        if (id === normalized || name === normalized || loc === normalized || id === `file:${normalized}`) {
          seedIds.add(id);
        }
      }
    }

    const queue = Array.from(seedIds);
    const visited = new Set<string>(queue);
    while (queue.length) {
      const current = queue.shift() as string;
      const deps = incoming[current] || [];
      for (const dep of deps) {
        const next = String(dep.from || "");
        if (!next || visited.has(next)) continue;
        visited.add(next);
        queue.push(next);
      }
    }

    const impactedNodes = Array.from(visited);
    const findById = (id: string) => nodes.find((n: any) => String(n?.id || "") === id);
    const impactedFiles = impactedNodes
      .map((id) => findById(id))
      .filter((node: any) => node && String(node.kind || "").toLowerCase().includes("file"))
      .map((node: any) => node.location || node.path || node.id);

    const impactedServices = impactedNodes
      .map((id) => findById(id))
      .filter((node: any) => {
        const kind = String(node?.kind || "").toLowerCase();
        return kind.includes("service") || String(node?.name || "").toLowerCase().includes("service");
      })
      .map((node: any) => node.name || node.id);

    const impactedApi = (Array.isArray(graph.apiMap) ? graph.apiMap : [])
      .filter((api: any) => {
        const text = JSON.stringify(api || {}).toLowerCase();
        return impactedNodes.some((id) => text.includes(String(id || "").toLowerCase()));
      })
      .map((api: any) => `${api.method || "Unknown"} ${api.url || "Unknown"}`);

    const impactedPages = impactedNodes
      .map((id) => findById(id))
      .filter((node: any) => {
        const kind = String(node?.kind || "").toLowerCase();
        return kind.includes("page") || kind.includes("component") || kind.includes("view");
      })
      .map((node: any) => node.location || node.name || node.id);

    const testsToRun = nodes
      .filter((node: any) => {
        const kind = String(node?.kind || "").toLowerCase();
        const loc = String(node?.location || node?.path || "").toLowerCase();
        return kind.includes("test") || loc.includes(".spec.") || loc.includes(".test.");
      })
      .filter((testNode: any) => {
        const testId = String(testNode?.id || "");
        const uses = outgoing[testId] || [];
        return uses.some((rel) => visited.has(String(rel.to || "")));
      })
      .map((node: any) => node.location || node.path || node.id);

    return {
      changed,
      impactedNodes,
      impactedFiles: Array.from(new Set(impactedFiles)),
      impactedServices: Array.from(new Set(impactedServices)),
      impactedApi: Array.from(new Set(impactedApi)),
      impactedPages: Array.from(new Set(impactedPages)),
      testsToRun: Array.from(new Set(testsToRun)),
    };
  }

  private getResyncStageTemplate(): ResyncStageState[] {
    return [
      { key: "scan", title: "Scanning Project...", status: "pending", durationMs: 0 },
      { key: "detect", title: "Detecting Changes...", status: "pending", durationMs: 0 },
      { key: "research", title: "Deep Code Research...", status: "pending", durationMs: 0 },
      { key: "knowledge_graph", title: "Updating Knowledge Graph...", status: "pending", durationMs: 0 },
      { key: "relationships", title: "Rebuilding Relationships...", status: "pending", durationMs: 0 },
      { key: "documentation", title: "Refreshing Documentation...", status: "pending", durationMs: 0 },
      { key: "memory", title: "Optimizing Memory...", status: "pending", durationMs: 0 },
      { key: "coverage", title: "Calculating Coverage...", status: "pending", durationMs: 0 },
      { key: "validation", title: "Final Validation...", status: "pending", durationMs: 0 },
      { key: "optimize", title: "Optimizing Indexes...", status: "pending", durationMs: 0 },
    ];
  }

  private computeCoverageAverage(coverage: Record<string, unknown> | undefined): number {
    const values = Object.values(coverage || {}).map((value) => this.normalizeCoverageValue(value));
    if (!values.length) return 0;
    return Math.round(values.reduce((sum, n) => sum + n, 0) / values.length);
  }

  private listProjectFiles(projectLocalPath: string): Array<{ path: string; size: number; mtimeMs: number; ext: string }> {
    const out: Array<{ path: string; size: number; mtimeMs: number; ext: string }> = [];
    const ignoredDirNames = new Set(Array.from(this.scanIgnoreDirs).map((name) => String(name || "").toLowerCase()));

    const walk = (absDir: string) => {
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(absDir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const abs = path.join(absDir, entry.name);
        const entryNameLower = String(entry.name || "").toLowerCase();
        if (entry.isDirectory()) {
          if (ignoredDirNames.has(entryNameLower)) continue;
          walk(abs);
          continue;
        }
        if (!entry.isFile()) continue;
        const rel = path.relative(projectLocalPath, abs).replace(/\\/g, "/");
        if (!rel || rel.startsWith("..")) continue;
        const relSegments = rel.split("/").map((segment) => String(segment || "").toLowerCase());
        if (relSegments.some((segment) => ignoredDirNames.has(segment))) continue;
        const ext = path.extname(entry.name).toLowerCase();
        if (!this.scanExtensions.has(ext) && !entry.name.startsWith(".env")) continue;
        try {
          const stat = fs.statSync(abs);
          out.push({ path: rel, size: stat.size, mtimeMs: stat.mtimeMs, ext: ext || path.basename(entry.name).toLowerCase() });
        } catch {
          // ignore broken entries
        }
      }
    };

    walk(projectLocalPath);
    out.sort((a, b) => a.path.localeCompare(b.path));
    return out;
  }

  private computeProjectDigest(files: Array<{ path: string; size: number; mtimeMs: number }>): string {
    const hash = crypto.createHash("sha1");
    for (const file of files) {
      hash.update(`${file.path}|${file.size}|${Math.round(file.mtimeMs)}\n`);
    }
    return hash.digest("hex");
  }

  private runGit(projectLocalPath: string, command: string): string | null {
    try {
      return execSync(`git -C ${JSON.stringify(projectLocalPath)} ${command}`, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    } catch {
      return null;
    }
  }

  private parseGitNameStatus(lines: string[]): { changed: Set<string>; added: Set<string>; deleted: Set<string> } {
    const changed = new Set<string>();
    const added = new Set<string>();
    const deleted = new Set<string>();
    for (const line of lines) {
      const trimmed = String(line || "").trim();
      if (!trimmed) continue;
      const parts = trimmed.split(/\s+/);
      const status = parts[0] || "M";
      const file = (parts[parts.length - 1] || "").replace(/\\/g, "/");
      if (!file) continue;
      if (status.includes("D")) {
        deleted.add(file);
        continue;
      }
      if (status.includes("A") || status.startsWith("??")) {
        added.add(file);
        changed.add(file);
        continue;
      }
      changed.add(file);
    }
    return { changed, added, deleted };
  }

  private detectIncrementalChanges(projectLocalPath: string, previousGitHead?: string | null) {
    const insideGit = this.runGit(projectLocalPath, "rev-parse --is-inside-work-tree");
    const gitAvailable = insideGit === "true";
    const currentGitHead = gitAvailable ? this.runGit(projectLocalPath, "rev-parse HEAD") : null;

    if (!gitAvailable || !currentGitHead || !previousGitHead) {
      return {
        strategy: "full-scan" as const,
        gitAvailable,
        gitHead: currentGitHead,
        changedFiles: [] as string[],
        newFiles: [] as string[],
        deletedFiles: [] as string[],
      };
    }

    const diffOutput = this.runGit(projectLocalPath, `diff --name-status ${previousGitHead}..${currentGitHead}`) || "";
    const stagedOutput = this.runGit(projectLocalPath, "diff --name-status --cached") || "";
    const worktreeOutput = this.runGit(projectLocalPath, "diff --name-status") || "";
    const untrackedOutput = this.runGit(projectLocalPath, "ls-files --others --exclude-standard") || "";

    const parsed = this.parseGitNameStatus([
      ...diffOutput.split("\n"),
      ...stagedOutput.split("\n"),
      ...worktreeOutput.split("\n"),
      ...untrackedOutput.split("\n").filter(Boolean).map((file) => `?? ${file}`),
    ]);

    return {
      strategy: "git-incremental" as const,
      gitAvailable,
      gitHead: currentGitHead,
      changedFiles: Array.from(parsed.changed),
      newFiles: Array.from(parsed.added),
      deletedFiles: Array.from(parsed.deleted),
    };
  }

  private readProjectFileText(
    projectLocalPath: string,
    relativePath: string,
    maxBytes = 256 * 1024,
  ): string {
    try {
      const abs = path.resolve(projectLocalPath, relativePath);
      const stat = fs.statSync(abs);
      if (!stat.isFile() || stat.size > maxBytes) return "";
      return fs.readFileSync(abs, "utf8");
    } catch {
      return "";
    }
  }

  private extractDependencySpecifiers(content: string): string[] {
    if (!content) return [];
    const specs = new Set<string>();
    const push = (value: string) => {
      const cleaned = String(value || "").trim();
      if (!cleaned || cleaned.length > 400) return;
      specs.add(cleaned);
    };

    const patterns: RegExp[] = [
      /import\s+[^"'`]*?\s+from\s+["'`]([^"'`]+)["'`]/g,
      /import\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
      /export\s+[^"'`]*?\s+from\s+["'`]([^"'`]+)["'`]/g,
      /require\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
      /(?:include|include_once|require|require_once)\s*\(?\s*["'`]([^"'`]+)["'`]\s*\)?/g,
    ];
    for (const pattern of patterns) {
      let match: RegExpExecArray | null = null;
      while ((match = pattern.exec(content)) !== null) {
        push(match[1] || "");
      }
    }

    return Array.from(specs);
  }

  private resolveDependencySpecifier(
    projectLocalPath: string,
    sourceFilePath: string,
    specifier: string,
    knownFiles: Set<string>,
  ): string | null {
    const raw = String(specifier || "").trim().replace(/\\/g, "/");
    if (!raw) return null;
    if (/^(node:|https?:|data:|@?[\w-]+$)/i.test(raw)) return null;

    let relBase = "";
    if (raw.startsWith("./") || raw.startsWith("../")) {
      const sourceDirAbs = path.resolve(projectLocalPath, path.dirname(sourceFilePath));
      const targetAbs = path.resolve(sourceDirAbs, raw);
      relBase = path.relative(projectLocalPath, targetAbs).replace(/\\/g, "/");
    } else if (raw.startsWith("~/") || raw.startsWith("@/") || raw.startsWith("#/")) {
      relBase = raw.slice(2);
    } else if (raw.startsWith("/")) {
      relBase = raw.slice(1);
    } else if (raw.startsWith("src/") || raw.startsWith("apps/")) {
      relBase = raw;
    } else {
      return null;
    }

    relBase = relBase.replace(/\\/g, "/").replace(/^\.?\//, "");
    if (!relBase || relBase.startsWith("..")) return null;

    const candidates = new Set<string>();
    const ext = path.extname(relBase).toLowerCase();
    if (ext) {
      candidates.add(relBase);
    } else {
      candidates.add(relBase);
      for (const candidateExt of this.dependencyScanExtensions) {
        candidates.add(`${relBase}${candidateExt}`);
      }
      for (const candidateExt of this.dependencyScanExtensions) {
        candidates.add(`${relBase}/index${candidateExt}`);
      }
    }

    for (const candidate of candidates) {
      if (knownFiles.has(candidate)) return candidate;
    }
    return null;
  }

  private normalizeToken(value: string): string {
    return String(value || "")
      .trim()
      .replace(/[<>{}()[\],;:'"`]/g, "")
      .replace(/\s+/g, "");
  }

  private extractCodeSymbols(content: string): Array<{ name: string; kind: string }> {
    if (!content) return [];
    const found = new Map<string, { name: string; kind: string }>();
    const push = (name: string, kind: string) => {
      const normalized = this.normalizeToken(name);
      if (!normalized || normalized.length < 2 || normalized.length > 120) return;
      const key = `${kind}:${normalized}`;
      if (!found.has(key)) found.set(key, { name: normalized, kind });
    };

    const patterns: Array<{ kind: string; regex: RegExp }> = [
      { kind: "class", regex: /(?:^|\s)class\s+([A-Za-z_][A-Za-z0-9_]*)/g },
      { kind: "interface", regex: /(?:^|\s)interface\s+([A-Za-z_][A-Za-z0-9_]*)/g },
      { kind: "enum", regex: /(?:^|\s)enum\s+([A-Za-z_][A-Za-z0-9_]*)/g },
      { kind: "type", regex: /(?:^|\s)type\s+([A-Za-z_][A-Za-z0-9_]*)\s*=/g },
      { kind: "function", regex: /(?:^|\s)function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g },
      { kind: "method", regex: /(?:public|private|protected|static|async|\s)+([A-Za-z_][A-Za-z0-9_]*)\s*\([^)]*\)\s*[{=>]/g },
      { kind: "const", regex: /(?:^|\s)const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=/g },
    ];

    for (const { kind, regex } of patterns) {
      let match: RegExpExecArray | null = null;
      while ((match = regex.exec(content)) !== null) {
        push(match[1] || "", kind);
      }
    }

    return Array.from(found.values()).slice(0, 400);
  }

  private extractFileLogicSignals(content: string): {
    callTargets: string[];
    extendsTargets: string[];
    implementsTargets: string[];
    createsTargets: string[];
    emitsEvents: string[];
    listensEvents: string[];
    readsTargets: string[];
    writesTargets: string[];
    validatesTargets: string[];
    rendersTargets: string[];
  } {
    const collect = (regex: RegExp, max = 200) => {
      const out = new Set<string>();
      let match: RegExpExecArray | null = null;
      while ((match = regex.exec(content)) !== null && out.size < max) {
        const token = this.normalizeToken(match[1] || "");
        if (token) out.add(token);
      }
      return Array.from(out);
    };

    const callTargets = collect(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g, 250)
      .filter((name) => !["if", "for", "while", "switch", "return", "catch", "function", "typeof", "new"].includes(name));

    const extendsTargets = collect(/\bextends\s+([A-Za-z_][A-Za-z0-9_]*)/g, 80);
    const implementsTargets = collect(/\bimplements\s+([A-Za-z_][A-Za-z0-9_,\s]*)/g, 120)
      .flatMap((row) => row.split(",").map((item) => this.normalizeToken(item)).filter(Boolean));
    const createsTargets = collect(/\bnew\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g, 200);
    const emitsEvents = collect(/\b(?:emit|dispatch|broadcast)\s*\(\s*["'`]([^"'`]+)["'`]/g, 200);
    const listensEvents = collect(/\b(?:on|addEventListener|subscribe|listen)\s*\(\s*["'`]([^"'`]+)["'`]/g, 200);
    const readsTargets = collect(/\b(?:get|find|load|read|select|query)\s*([A-Za-z_][A-Za-z0-9_]*)?\s*\(/g, 200);
    const writesTargets = collect(/\b(?:set|save|create|update|delete|insert|write)\s*([A-Za-z_][A-Za-z0-9_]*)?\s*\(/g, 200);
    const validatesTargets = collect(/\b(?:validate|assert|ensure|guard)\s*([A-Za-z_][A-Za-z0-9_]*)?\s*\(/g, 200);
    const rendersTargets = collect(/\b(?:render|mount|hydrate)\s*([A-Za-z_][A-Za-z0-9_]*)?\s*\(/g, 120);

    return {
      callTargets,
      extendsTargets,
      implementsTargets,
      createsTargets,
      emitsEvents,
      listensEvents,
      readsTargets,
      writesTargets,
      validatesTargets,
      rendersTargets,
    };
  }

  private buildDeepResearchGraph(
    projectLocalPath: string,
    files: Array<{ path: string; size: number; mtimeMs: number; ext: string }>,
    graph: Record<string, unknown>,
  ): Record<string, unknown> {
    const knownFiles = new Set(files.map((file) => file.path));
    const fileToModule = new Map<string, string>();
    for (const file of files) {
      const top = file.path.split("/")[0] || "root";
      fileToModule.set(file.path, `module:${top}`);
    }

    const symbolIndex = new Map<string, { id: string; filePath: string; kind: string; name: string }>();
    const symbols: Array<Record<string, unknown>> = [];
    const relationKeys = new Set<string>();
    const callGraph: Array<Record<string, unknown>> = [];
    const relationStats = new Map<string, number>();
    const enrichedRelations: Array<Record<string, unknown>> = Array.isArray((graph as any).relations)
      ? [ ...((graph as any).relations as Array<Record<string, unknown>>) ]
      : [];
    for (const relation of enrichedRelations) {
      const type = String((relation as any)?.type || "related_to");
      relationStats.set(type, (relationStats.get(type) || 0) + 1);
      relationKeys.add(`${String((relation as any)?.from || "")}|${type}|${String((relation as any)?.to || "")}`);
    }

    const pushRelation = (from: string, type: string, to: string, reason: string) => {
      if (!from || !to) return;
      const key = `${from}|${type}|${to}`;
      if (relationKeys.has(key)) return;
      relationKeys.add(key);
      enrichedRelations.push({ from, type, to, reason });
      relationStats.set(type, (relationStats.get(type) || 0) + 1);
    };

    const fileLogic: Array<Record<string, unknown>> = [];
    const fileById = new Map(files.map((file) => [`file:${file.path}`, file.path]));
    const unknowns = new Set(Array.isArray((graph as any).unknowns) ? ((graph as any).unknowns as unknown[]).map((x) => String(x || "")).filter(Boolean) : []);

    for (const file of files) {
      if (!this.dependencyScanExtensions.has(file.ext)) continue;
      const content = this.readProjectFileText(projectLocalPath, file.path);
      if (!content) continue;

      const fileId = `file:${file.path}`;
      const symbolsInFile = this.extractCodeSymbols(content);
      for (const symbol of symbolsInFile) {
        const symbolId = `symbol:${file.path}:${symbol.kind}:${symbol.name}`;
        symbols.push({
          id: symbolId,
          name: symbol.name,
          kind: `Symbol:${symbol.kind}`,
          location: file.path,
          file: file.path,
          symbolKind: symbol.kind,
        });
        symbolIndex.set(symbol.name, { id: symbolId, filePath: file.path, kind: symbol.kind, name: symbol.name });
        pushRelation(fileId, "contains", symbolId, "File contains symbol");
        const moduleId = fileToModule.get(file.path);
        if (moduleId) pushRelation(moduleId, "contains", symbolId, "Module contains symbol");
      }

      const logic = this.extractFileLogicSignals(content);
      fileLogic.push({
        fileId,
        file: file.path,
        ...logic,
      });

      for (const target of logic.extendsTargets) {
        const symbol = symbolIndex.get(target);
        if (symbol) pushRelation(fileId, "extends", symbol.id, `Extends ${target}`);
        else if (target) unknowns.add(`${file.path}:extends:${target}`);
      }
      for (const target of logic.implementsTargets) {
        const symbol = symbolIndex.get(target);
        if (symbol) pushRelation(fileId, "implements", symbol.id, `Implements ${target}`);
        else if (target) unknowns.add(`${file.path}:implements:${target}`);
      }
      for (const target of logic.createsTargets) {
        const symbol = symbolIndex.get(target);
        if (symbol) pushRelation(fileId, "creates", symbol.id, `Creates ${target}`);
      }
      for (const eventName of logic.emitsEvents) {
        const eventId = `event:${eventName}`;
        pushRelation(fileId, "emits", eventId, `Emits event ${eventName}`);
      }
      for (const eventName of logic.listensEvents) {
        const eventId = `event:${eventName}`;
        pushRelation(fileId, "listens", eventId, `Listens event ${eventName}`);
      }
      for (const target of logic.readsTargets) {
        if (target) pushRelation(fileId, "reads", `symbol-ref:${target}`, `Reads ${target}`);
      }
      for (const target of logic.writesTargets) {
        if (target) pushRelation(fileId, "writes", `symbol-ref:${target}`, `Writes ${target}`);
      }
      for (const target of logic.validatesTargets) {
        if (target) pushRelation(fileId, "validates", `symbol-ref:${target}`, `Validates ${target}`);
      }
      for (const target of logic.rendersTargets) {
        if (target) pushRelation(fileId, "renders", `symbol-ref:${target}`, `Renders ${target}`);
      }
      for (const call of logic.callTargets) {
        const targetSymbol = symbolIndex.get(call);
        if (targetSymbol) {
          pushRelation(fileId, "calls", targetSymbol.id, `Calls ${call}`);
          callGraph.push({
            from: file.path,
            to: targetSymbol.filePath,
            callee: call,
            targetSymbolId: targetSymbol.id,
          });
          if (targetSymbol.filePath !== file.path) {
            pushRelation(fileId, "uses", `file:${targetSymbol.filePath}`, `Uses ${call} from ${targetSymbol.filePath}`);
          }
        }
      }
    }

    const reusedSymbols = new Map<string, Set<string>>();
    for (const item of callGraph) {
      const key = String(item.targetSymbolId || "");
      if (!key) continue;
      if (!reusedSymbols.has(key)) reusedSymbols.set(key, new Set());
      reusedSymbols.get(key)!.add(String(item.from || ""));
    }

    const symbolUsage: Array<Record<string, unknown>> = [];
    for (const [symbolId, callers] of reusedSymbols) {
      symbolUsage.push({
        symbolId,
        reuseCount: callers.size,
        reusedByFiles: Array.from(callers).sort(),
      });
    }

    const fileCallStats = new Map<string, { incoming: number; outgoing: number }>();
    for (const file of files) fileCallStats.set(file.path, { incoming: 0, outgoing: 0 });
    for (const edge of callGraph) {
      const from = String(edge.from || "");
      const to = String(edge.to || "");
      if (fileCallStats.has(from)) fileCallStats.get(from)!.outgoing += 1;
      if (fileCallStats.has(to)) fileCallStats.get(to)!.incoming += 1;
    }

    const hotFiles = Array.from(fileCallStats.entries())
      .map(([file, stat]) => ({ file, incomingCalls: stat.incoming, outgoingCalls: stat.outgoing, score: stat.incoming * 2 + stat.outgoing }))
      .sort((a, b) => b.score - a.score || b.incomingCalls - a.incomingCalls)
      .slice(0, 120);

    const deepStats = {
      filesAnalyzed: fileLogic.length,
      symbolsExtracted: symbols.length,
      callEdges: callGraph.length,
      relationByType: Object.fromEntries(Array.from(relationStats.entries()).sort((a, b) => b[1] - a[1])),
      hotFiles,
      generatedAt: new Date().toISOString(),
    };

    const relationIndexByFrom: Record<string, Array<{ to: string; type: string }>> = {};
    const relationIndexByTo: Record<string, Array<{ from: string; type: string }>> = {};
    for (const relation of enrichedRelations) {
      const from = String((relation as any).from || "");
      const to = String((relation as any).to || "");
      const type = String((relation as any).type || "related_to");
      if (!from || !to) continue;
      if (!relationIndexByFrom[from]) relationIndexByFrom[from] = [];
      if (!relationIndexByTo[to]) relationIndexByTo[to] = [];
      relationIndexByFrom[from].push({ to, type });
      relationIndexByTo[to].push({ from, type });
    }

    return {
      ...graph,
      relations: enrichedRelations,
      symbols,
      callGraph,
      fileLogic,
      symbolUsage,
      indexes: {
        ...(graph as any).indexes,
        callsFromFile: relationIndexByFrom,
        callsToFile: relationIndexByTo,
      },
      analytics: {
        ...((graph as any).analytics || {}),
        deepCodeResearch: deepStats,
      },
      unknowns: Array.from(unknowns),
      updatedAt: new Date().toISOString(),
    };
  }

  private buildGraphFromFiles(
    projectLocalPath: string,
    files: Array<{ path: string; size: number; mtimeMs: number; ext: string }>,
  ): Record<string, unknown> {
    const modulesMap = new Map<string, { id: string; name: string; paths: string[]; fileCount: number }>();
    const entities: Array<Record<string, unknown>> = [];
    const relations: Array<Record<string, unknown>> = [];
    const features: Array<Record<string, unknown>> = [];
    const apiMap: Array<Record<string, unknown>> = [];
    const frontendMap: Array<Record<string, unknown>> = [];
    const dataModels: Array<Record<string, unknown>> = [];
    const adrs: Array<Record<string, unknown>> = [];
    const relationKeys = new Set<string>();
    const unknownSpecifiers = new Set<string>();
    const knownFiles = new Set(files.map((file) => file.path));

    const pushRelation = (from: string, type: string, to: string, reason: string) => {
      const key = `${from}|${type}|${to}`;
      if (relationKeys.has(key)) return;
      relationKeys.add(key);
      relations.push({ from, type, to, reason });
    };

    for (const file of files) {
      const top = file.path.split("/")[0] || "root";
      const moduleId = `module:${top}`;
      if (!modulesMap.has(moduleId)) {
        modulesMap.set(moduleId, { id: top, name: top, paths: [top], fileCount: 0 });
      }
      modulesMap.get(moduleId)!.fileCount += 1;

      const fileId = `file:${file.path}`;
      const lowered = file.path.toLowerCase();
      const kind = lowered.includes("service")
        ? "Service"
        : lowered.includes("controller")
          ? "Controller"
          : lowered.includes("component") || file.ext === ".vue"
            ? "Component"
            : lowered.includes("api") || lowered.includes("route")
              ? "API"
              : lowered.includes("test") || lowered.includes("spec")
                ? "Test"
                : lowered.endsWith(".md")
                  ? "Documentation"
                  : "File";

      entities.push({
        id: fileId,
        name: path.basename(file.path),
        kind,
        location: file.path,
        module: top,
      });
      pushRelation(moduleId, "contains", fileId, "File belongs to top-level module");

      if (lowered.includes("/views/") || lowered.includes("/features/") || lowered.includes("feature")) {
        features.push({ id: `feature:${file.path}`, name: path.basename(file.path), files: [file.path] });
      }
      if (kind === "Component") {
        frontendMap.push({ route: file.path, page: path.basename(file.path), source: file.path });
      }
      if (lowered.includes("entity") || lowered.includes("model") || lowered.includes("schema")) {
        dataModels.push({ name: path.basename(file.path), location: file.path });
      }
      if (lowered.includes("adr") || lowered.includes("decision")) {
        adrs.push({ id: `adr:${file.path}`, title: path.basename(file.path), location: file.path });
      }

      if (this.dependencyScanExtensions.has(file.ext)) {
        const content = this.readProjectFileText(projectLocalPath, file.path);
        const specifiers = this.extractDependencySpecifiers(content);
        for (const specifier of specifiers) {
          const resolved = this.resolveDependencySpecifier(projectLocalPath, file.path, specifier, knownFiles);
          if (resolved) {
            const targetFileId = `file:${resolved}`;
            if (targetFileId !== fileId) {
              pushRelation(fileId, "depends_on", targetFileId, `Code dependency: ${specifier}`);
            }
          } else if (
            (specifier.startsWith(".") || specifier.startsWith("@/") || specifier.startsWith("~/") || specifier.startsWith("#/") || specifier.startsWith("/"))
            && unknownSpecifiers.size < 300
          ) {
            unknownSpecifiers.add(`${file.path} -> ${specifier}`);
          }
        }

        const apiDecorators = content.matchAll(/@(Get|Post|Put|Patch|Delete)\s*\(\s*["'`]([^"'`]*)["'`]\s*\)/g);
        let apiDetected = false;
        for (const match of apiDecorators) {
          apiDetected = true;
          apiMap.push({
            method: String(match[1] || "AUTO").toUpperCase(),
            url: String(match[2] || "/"),
            source: file.path,
          });
        }
        if (!apiDetected && kind === "API") {
          apiMap.push({ method: "AUTO", url: `/${file.path.replace(/\.[^.]+$/, "")}`, source: file.path });
        }
      } else if (kind === "API") {
        apiMap.push({ method: "AUTO", url: `/${file.path.replace(/\.[^.]+$/, "")}`, source: file.path });
      }
    }

    const coverage = {
      backend: Math.min(100, Math.round((files.filter((f) => f.path.includes("apps/api") || f.path.includes("src/modules")).length / Math.max(files.length, 1)) * 100)),
      frontend: Math.min(100, Math.round((files.filter((f) => f.path.includes("apps/web") || f.ext === ".vue").length / Math.max(files.length, 1)) * 100)),
      infrastructure: Math.min(100, Math.round((files.filter((f) => f.path.includes("docker") || f.path.includes("k8s") || f.path.includes("infra")).length / Math.max(files.length, 1)) * 100)),
      config: Math.min(100, Math.round((files.filter((f) => f.ext === ".json" || f.ext === ".yml" || f.ext === ".yaml" || f.path.includes(".env")).length / Math.max(files.length, 1)) * 100)),
      tests: Math.min(100, Math.round((files.filter((f) => f.path.includes("test") || f.path.includes("spec")).length / Math.max(files.length, 1)) * 100)),
      scripts: Math.min(100, Math.round((files.filter((f) => f.path.includes("scripts/") || f.ext === ".sh").length / Math.max(files.length, 1)) * 100)),
      docs: Math.min(100, Math.round((files.filter((f) => f.ext === ".md" || f.ext === ".mdx").length / Math.max(files.length, 1)) * 100)),
    };

    return {
      version: Date.now(),
      generatedAt: new Date().toISOString(),
      projectPath: projectLocalPath,
      modules: Array.from(modulesMap.values()),
      files: files.map((file) => ({ path: file.path, size: file.size, mtimeMs: file.mtimeMs, type: file.ext })),
      entities,
      relations,
      features,
      apiMap,
      frontendMap,
      dataModels,
      adrs,
      entityIndex: entities,
      coverage,
      unknowns: Array.from(unknownSpecifiers),
    };
  }

  private async pruneDuplicateMemoryEntries(projectId: string) {
    const entries = await this.projectMemoryRepository.find({
      where: { projectId, isActive: true },
      order: { updatedAt: "DESC" },
    });
    const seen = new Set<string>();
    for (const entry of entries) {
      const key = `${entry.kind}|${entry.title}`;
      if (!seen.has(key)) {
        seen.add(key);
        continue;
      }
      entry.isActive = false;
      await this.projectMemoryRepository.save(entry);
    }
  }

  async runResync(projectId: string) {
    const project = await this.getById(projectId);
    const startedAtDate = new Date();
    const startedAt = startedAtDate.toISOString();
    const runId = `resync-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const stages = this.getResyncStageTemplate();

    const [latestResync] = await this.projectMemoryRepository.find({
      where: { projectId, isActive: true, kind: "resync-history" },
      order: { updatedAt: "DESC" },
      take: 1,
    });
    const previousMeta = latestResync?.graph && typeof latestResync.graph === "object"
      ? latestResync.graph as Record<string, any>
      : {};
    const previousGitHead = String(previousMeta?.meta?.gitHead || "") || null;

    const runStage = async <T>(key: ResyncStageKey, work: () => Promise<T> | T, message?: string): Promise<T> => {
      const stage = stages.find((item) => item.key === key);
      if (!stage) return await work();
      const started = Date.now();
      stage.status = "active";
      stage.startedAt = new Date().toISOString();
      stage.message = message;
      this.wsGateway.broadcastToProject(projectId, "project:resync:stage", {
        runId,
        projectId,
        stage,
      });

      try {
        const result = await work();
        stage.status = "done";
        stage.finishedAt = new Date().toISOString();
        stage.durationMs = Date.now() - started;
        this.wsGateway.broadcastToProject(projectId, "project:resync:stage", {
          runId,
          projectId,
          stage,
        });
        return result;
      } catch (error) {
        stage.status = "error";
        stage.finishedAt = new Date().toISOString();
        stage.durationMs = Date.now() - started;
        stage.message = error instanceof Error ? error.message : String(error);
        this.wsGateway.broadcastToProject(projectId, "project:resync:stage", {
          runId,
          projectId,
          stage,
        });
        throw error;
      }
    };

    const existingKg = await this.getLatestKnowledgeGraphEntry(projectId);
    const previousCoverage = this.computeCoverageAverage((existingKg?.graph as Record<string, any> | undefined)?.coverage);

    const files = await runStage("scan", async () => this.listProjectFiles(project.localPath));
    const changeDetection = await runStage("detect", async () => this.detectIncrementalChanges(project.localPath, previousGitHead));

    const digest = this.computeProjectDigest(files);
    const changedFiles = files.map((file) => file.path);
    const fullRescan = true;

    const baseGraph = await runStage("knowledge_graph", async () => this.buildGraphFromFiles(project.localPath, files));
    const graph = await runStage("research", async () => this.buildDeepResearchGraph(project.localPath, files, baseGraph as Record<string, unknown>));

    const knowledgeEntry = await runStage("relationships", async () => this.saveMemory({
      id: existingKg?.id,
      projectId,
      title: "Knowledge Graph Index",
      summary: "Сводный граф знаний проекта обновлён через Resync Project",
      details: `Resync run: ${runId}`,
      kind: "knowledge-graph-index",
      tags: ["knowledge-graph", "source-of-truth", "resync"],
      relatedFiles: files.map((file) => file.path),
      graph: graph as Record<string, unknown>,
      sourceRunId: runId,
    }));

    const docsFiles = files.filter((file) => [".md", ".mdx"].includes(file.ext));
    const apiFiles = files.filter((file) => file.path.toLowerCase().includes("controller") || file.path.toLowerCase().includes("api"));
    const serviceFiles = files.filter((file) => file.path.toLowerCase().includes("service"));
    const componentFiles = files.filter((file) => file.path.toLowerCase().includes("component") || file.ext === ".vue");

    await runStage("documentation", async () => this.saveMemory({
      projectId,
      title: `Resync Documentation Snapshot (${new Date().toLocaleString()})`,
      kind: "documentation-index",
      summary: `Обновлено документации: ${docsFiles.length}`,
      details: docsFiles.slice(0, 400).map((file) => file.path).join("\n"),
      tags: ["documentation", "resync"],
      relatedFiles: docsFiles.map((file) => file.path),
      sourceRunId: runId,
      relevanceScore: 0.8,
    }));

    await runStage("memory", async () => {
      await this.saveMemory({
        projectId,
        title: `Fact Memory Snapshot (${new Date().toLocaleString()})`,
        kind: "fact-memory",
        summary: `Файлов: ${files.length}, API: ${apiFiles.length}, сервисов: ${serviceFiles.length}, компонентов: ${componentFiles.length}`,
        details: JSON.stringify({
          totalFiles: files.length,
          apiFiles: apiFiles.length,
          serviceFiles: serviceFiles.length,
          componentFiles: componentFiles.length,
          docsFiles: docsFiles.length,
        }, null, 2),
        tags: ["facts", "resync"],
        sourceRunId: runId,
      });
      await this.saveMemory({
        projectId,
        title: `Decision Memory (${new Date().toLocaleString()})`,
        kind: "decision-memory",
        summary: fullRescan
          ? "Использован полный рескан проекта"
          : "Использована инкрементальная git-синхронизация",
        details: JSON.stringify({
          strategy: fullRescan ? "full" : "git-incremental",
          gitHead: changeDetection.gitHead,
          changedFiles: changedFiles.length,
        }, null, 2),
        tags: ["decisions", "resync"],
        sourceRunId: runId,
      });
      await this.saveMemory({
        projectId,
        title: `Experience Memory (${new Date().toLocaleString()})`,
        kind: "experience-memory",
        summary: `Resync completed. Strategy: ${fullRescan ? "full" : "incremental"}`,
        details: "Pipeline completed successfully with automatic cleanup, deduplication and graph refresh.",
        tags: ["experience", "resync"],
        sourceRunId: runId,
      });
      await this.pruneDuplicateMemoryEntries(projectId);
    });

    const coverageAfter = await runStage("coverage", async () => {
      const graphCoverage = (knowledgeEntry.graph as Record<string, any> | undefined)?.coverage as Record<string, unknown> | undefined;
      return this.computeCoverageAverage(graphCoverage);
    });

    const validation = await runStage("validation", async () => {
      const graphData = (knowledgeEntry.graph || {}) as Record<string, any>;
      const hasEntityIndex = Array.isArray(graphData.entityIndex) && graphData.entityIndex.length > 0;
      const hasRelations = Array.isArray(graphData.relations);
      const duplicateCheck = new Set((graphData.entityIndex || []).map((item: any) => String(item?.id || ""))).size
        === (graphData.entityIndex || []).length;
      return {
        ok: Boolean(hasEntityIndex && hasRelations && duplicateCheck),
        hasEntityIndex,
        hasRelations,
        duplicateCheck,
      };
    });

    await runStage("optimize", async () => {
      const graphData = (knowledgeEntry.graph || {}) as Record<string, any>;
      const dedupedRelations = this.mergeUniqueObjects(
        Array.isArray(graphData.relations) ? graphData.relations : [],
        [],
        (item: Record<string, any>) => `${item.from || ""}|${item.type || ""}|${item.to || ""}`,
      );
      if (Array.isArray(graphData.relations) && dedupedRelations.length !== graphData.relations.length) {
        await this.saveMemory({
          id: knowledgeEntry.id,
          projectId,
          title: knowledgeEntry.title,
          summary: knowledgeEntry.summary,
          details: knowledgeEntry.details,
          kind: knowledgeEntry.kind,
          tags: knowledgeEntry.tags,
          relatedFiles: knowledgeEntry.relatedFiles,
          graph: {
            ...graphData,
            relations: dedupedRelations,
            optimizedAt: new Date().toISOString(),
          },
          sourceRunId: runId,
        });
      }
    });

    const finishedAtDate = new Date();
    const finishedAt = finishedAtDate.toISOString();
    const durationMs = Math.max(0, finishedAtDate.getTime() - startedAtDate.getTime());

    const summary = {
      scannedFiles: files.length,
      changedFiles: changedFiles.length,
      newFiles: changeDetection.newFiles.length,
      deletedFiles: changeDetection.deletedFiles.length,
      newEntities: Array.isArray((knowledgeEntry.graph as Record<string, any>)?.entityIndex)
        ? ((knowledgeEntry.graph as Record<string, any>).entityIndex as unknown[]).length
        : 0,
      newRelations: Array.isArray((knowledgeEntry.graph as Record<string, any>)?.relations)
        ? ((knowledgeEntry.graph as Record<string, any>).relations as unknown[]).length
        : 0,
      updatedServices: serviceFiles.length,
      updatedComponents: componentFiles.length,
      updatedApi: apiFiles.length,
      updatedDocumentation: docsFiles.length,
      updatedArchitecturalDecisions: files.filter((file) => file.path.toLowerCase().includes("adr") || file.path.toLowerCase().includes("decision")).length,
      updatedMemoryEntries: 3,
      coverageBefore: previousCoverage,
      coverageAfter,
      durationMs,
      memoryIntegrity: validation.ok ? "ok" : "warning",
      alreadySynchronized: false,
    };

    const historyEntry = await this.saveMemory({
      projectId,
      title: `Resync Project — ${new Date().toLocaleString()}`,
      kind: "resync-history",
      summary: summary.alreadySynchronized
        ? "Project is already synchronized"
        : "Project synchronized successfully",
      details: JSON.stringify(summary, null, 2),
      tags: ["resync", "history"],
      relatedFiles: changedFiles.slice(0, 500),
      sourceRunId: runId,
      graph: {
        runId,
        startedAt,
        finishedAt,
        durationMs,
        stages,
        summary,
        validation,
        changes: {
          strategy: changeDetection.strategy,
          changedFiles,
          newFiles: changeDetection.newFiles,
          deletedFiles: changeDetection.deletedFiles,
        },
        meta: {
          gitHead: changeDetection.gitHead,
          digest,
        },
      },
    });

    const result = {
      runId,
      projectId,
      startedAt,
      finishedAt,
      durationMs,
      status: "completed",
      stages,
      summary,
      historyEntryId: historyEntry.id,
      message: summary.alreadySynchronized
        ? "Project is already synchronized. Knowledge Graph is up to date."
        : "Project synchronized successfully.",
    };

    this.wsGateway.broadcastToProject(projectId, "project:resync:completed", result);
    return result;
  }

  async getResyncStatus(projectId: string) {
    const project = await this.getById(projectId);
    const [latestResync] = await this.projectMemoryRepository.find({
      where: { projectId, isActive: true, kind: "resync-history" },
      order: { updatedAt: "DESC" },
      take: 1,
    });

    const statusWithoutHistory = {
      projectId,
      status: "outdated",
      changedFiles: 0,
      changedPreview: [] as string[],
      message: "Knowledge is outdated.",
      coverage: 0,
      lastSynchronization: null as null | Record<string, unknown>,
    };

    if (!latestResync || !latestResync.graph || typeof latestResync.graph !== "object") {
      return statusWithoutHistory;
    }

    const graphData = latestResync.graph as Record<string, any>;
    const lastDigest = String(graphData?.meta?.digest || "");
    const lastGitHead = String(graphData?.meta?.gitHead || "") || null;

    const files = await this.listProjectFiles(project.localPath);
    const digest = this.computeProjectDigest(files);
    const changedByDigest = lastDigest !== digest;
    const incremental = await this.detectIncrementalChanges(project.localPath, lastGitHead);
    const changedFiles = incremental.strategy === "git-incremental"
      ? incremental.changedFiles
      : changedByDigest
        ? files.map((file) => file.path)
        : [];

    const coverage = Number(graphData?.summary?.coverageAfter || graphData?.summary?.coverageBefore || 0);
    const outdated = changedByDigest || changedFiles.length > 0;

    return {
      projectId,
      status: outdated ? "outdated" : "synchronized",
      changedFiles: changedFiles.length,
      changedPreview: changedFiles.slice(0, 30),
      message: outdated ? "Knowledge is outdated." : "Knowledge is synchronized.",
      coverage,
      lastSynchronization: {
        at: latestResync.updatedAt,
        durationMs: Number(graphData?.durationMs || 0),
        result: latestResync.summary,
      },
    };
  }

  async listResyncHistory(projectId: string) {
    await this.getById(projectId);
    const entries = await this.projectMemoryRepository.find({
      where: { projectId, isActive: true, kind: "resync-history" },
      order: { updatedAt: "DESC" },
      take: 50,
    });

    return entries.map((entry) => {
      const graphData = entry.graph && typeof entry.graph === "object" ? entry.graph as Record<string, any> : {};
      const summary = graphData.summary && typeof graphData.summary === "object" ? graphData.summary as Record<string, any> : {};
      return {
        id: entry.id,
        title: entry.title,
        summary: entry.summary,
        date: entry.updatedAt,
        durationMs: Number(graphData.durationMs || summary.durationMs || 0),
        changedFiles: Number(summary.changedFiles || 0),
        updatedEntities: Number(summary.newEntities || 0),
        coverageBefore: Number(summary.coverageBefore || 0),
        coverageAfter: Number(summary.coverageAfter || 0),
        memoryIntegrity: String(summary.memoryIntegrity || "unknown"),
        details: graphData,
      };
    });
  }

  async getResyncHistoryEntry(projectId: string, entryId: string) {
    await this.getById(projectId);
    const entry = await this.projectMemoryRepository.findOne({
      where: { id: entryId, projectId, isActive: true, kind: "resync-history" },
    });
    if (!entry) {
      throw new NotFoundException("Resync history entry not found");
    }
    return entry;
  }

  async upsertKnowledgeGraphIndex(input: SaveProjectMemoryDto) {
    const entries = await this.projectMemoryRepository.find({
      where: { projectId: input.projectId, isActive: true, kind: "knowledge-graph-index" },
      order: { updatedAt: "DESC" },
      take: 1,
    });
    const existing = entries[0] || null;
    const incomingGraph = input.graph && typeof input.graph === "object" ? input.graph as Record<string, any> : {};
    const currentGraph = existing?.graph && typeof existing.graph === "object" ? existing.graph as Record<string, any> : {};
    const project = await this.projectsRepository.findOneBy({ id: input.projectId });
    if (!project) throw new Error("projectId is invalid");

    const mergedGraph: Record<string, unknown> = {
      version: Math.max(Number(currentGraph.version || 0), Number(incomingGraph.version || 0), 1),
      domains: Array.from(new Set([...(Array.isArray(currentGraph.domains) ? currentGraph.domains : []), ...(Array.isArray(incomingGraph.domains) ? incomingGraph.domains : [])])),
      modules: this.mergeUniqueObjects(
        Array.isArray(currentGraph.modules) ? currentGraph.modules as Record<string, any>[] : [],
        Array.isArray(incomingGraph.modules) ? incomingGraph.modules as Record<string, any>[] : [],
        (item) => String(item.id || item.name || ""),
      ),
      files: this.mergeUniqueObjects(
        Array.isArray(currentGraph.files) ? currentGraph.files as Record<string, any>[] : [],
        Array.isArray(incomingGraph.files) ? incomingGraph.files as Record<string, any>[] : [],
        (item) => String(item.path || item.id || ""),
      ),
      entities: this.mergeUniqueObjects(
        Array.isArray(currentGraph.entities) ? currentGraph.entities as Record<string, any>[] : [],
        Array.isArray(incomingGraph.entities) ? incomingGraph.entities as Record<string, any>[] : [],
        (item) => String(item.id || `${item.kind || ""}:${item.name || ""}`),
      ),
      relations: this.mergeUniqueObjects(
        Array.isArray(currentGraph.relations) ? currentGraph.relations as Record<string, any>[] : [],
        Array.isArray(incomingGraph.relations) ? incomingGraph.relations as Record<string, any>[] : [],
        (item) => `${item.from || ""}|${item.type || ""}|${item.to || ""}`,
      ),
      features: this.mergeUniqueObjects(
        Array.isArray(currentGraph.features) ? currentGraph.features as Record<string, any>[] : [],
        Array.isArray(incomingGraph.features) ? incomingGraph.features as Record<string, any>[] : [],
        (item) => String(item.id || item.name || ""),
      ),
      apiMap: this.mergeUniqueObjects(
        Array.isArray(currentGraph.apiMap) ? currentGraph.apiMap as Record<string, any>[] : [],
        Array.isArray(incomingGraph.apiMap) ? incomingGraph.apiMap as Record<string, any>[] : [],
        (item) => `${item.method || ""}:${item.url || ""}`,
      ),
      dataModels: this.mergeUniqueObjects(
        Array.isArray(currentGraph.dataModels) ? currentGraph.dataModels as Record<string, any>[] : [],
        Array.isArray(incomingGraph.dataModels) ? incomingGraph.dataModels as Record<string, any>[] : [],
        (item) => String(item.name || item.location || ""),
      ),
      frontendMap: this.mergeUniqueObjects(
        Array.isArray(currentGraph.frontendMap) ? currentGraph.frontendMap as Record<string, any>[] : [],
        Array.isArray(incomingGraph.frontendMap) ? incomingGraph.frontendMap as Record<string, any>[] : [],
        (item) => String(item.route || item.page || ""),
      ),
      dataFlows: this.mergeUniqueObjects(
        Array.isArray(currentGraph.dataFlows) ? currentGraph.dataFlows as Record<string, any>[] : [],
        Array.isArray(incomingGraph.dataFlows) ? incomingGraph.dataFlows as Record<string, any>[] : [],
        (item) => String(item.name || item.trigger || ""),
      ),
      adrs: this.mergeUniqueObjects(
        Array.isArray(currentGraph.adrs) ? currentGraph.adrs as Record<string, any>[] : [],
        Array.isArray(incomingGraph.adrs) ? incomingGraph.adrs as Record<string, any>[] : [],
        (item) => String(item.id || item.title || ""),
      ),
      entityIndex: this.mergeUniqueObjects(
        Array.isArray(currentGraph.entityIndex) ? currentGraph.entityIndex as Record<string, any>[] : [],
        Array.isArray(incomingGraph.entityIndex) ? incomingGraph.entityIndex as Record<string, any>[] : [],
        (item) => String(item.id || `${item.kind || ""}:${item.name || ""}:${item.location || ""}`),
      ),
      coverage: {
        backend: Math.max(this.normalizeCoverageValue((currentGraph.coverage as any)?.backend), this.normalizeCoverageValue((incomingGraph.coverage as any)?.backend)),
        frontend: Math.max(this.normalizeCoverageValue((currentGraph.coverage as any)?.frontend), this.normalizeCoverageValue((incomingGraph.coverage as any)?.frontend)),
        infrastructure: Math.max(this.normalizeCoverageValue((currentGraph.coverage as any)?.infrastructure), this.normalizeCoverageValue((incomingGraph.coverage as any)?.infrastructure)),
        config: Math.max(this.normalizeCoverageValue((currentGraph.coverage as any)?.config), this.normalizeCoverageValue((incomingGraph.coverage as any)?.config)),
        tests: Math.max(this.normalizeCoverageValue((currentGraph.coverage as any)?.tests), this.normalizeCoverageValue((incomingGraph.coverage as any)?.tests)),
        scripts: Math.max(this.normalizeCoverageValue((currentGraph.coverage as any)?.scripts), this.normalizeCoverageValue((incomingGraph.coverage as any)?.scripts)),
        docs: Math.max(this.normalizeCoverageValue((currentGraph.coverage as any)?.docs), this.normalizeCoverageValue((incomingGraph.coverage as any)?.docs)),
      },
      unknowns: Array.from(new Set([
        ...(Array.isArray(currentGraph.unknowns) ? currentGraph.unknowns.map((item) => String(item).trim()).filter(Boolean) : []),
        ...(Array.isArray(incomingGraph.unknowns) ? incomingGraph.unknowns.map((item) => String(item).trim()).filter(Boolean) : []),
      ])),
      updatedAt: new Date().toISOString(),
    };

    const enrichedGraph = this.enrichKnowledgeGraph(
      mergedGraph,
      project.localPath,
      Array.isArray(input.relatedFiles) ? input.relatedFiles : [],
      currentGraph,
    );

    return this.saveMemory({
      ...input,
      id: existing?.id,
      title: "Knowledge Graph Index",
      kind: "knowledge-graph-index",
      graph: enrichedGraph,
      summary: input.summary || "Сводный граф знаний проекта",
      details: input.details || "Автоматически объединённый индекс знаний проекта",
      tags: Array.from(new Set([...(input.tags || []), "knowledge-graph", "index", "source-of-truth"])),
    });
  }

  async saveMemory(input: SaveProjectMemoryDto) {
    const project = await this.projectsRepository.findOneBy({ id: input.projectId });
    if (!project) throw new Error("projectId is invalid");
    const existing = input.id ? await this.projectMemoryRepository.findOneBy({ id: input.id }) : null;
    const existingGraph = existing?.graph && typeof existing.graph === "object" ? existing.graph as Record<string, any> : {};
    const incomingGraph = input.graph && typeof input.graph === "object" ? input.graph as Record<string, any> : null;
    const shouldEnrichGraph = Boolean(incomingGraph && (String(input.kind || "").includes("knowledge-graph") || String(input.kind || "") === "feature"));
    const persistedGraph = shouldEnrichGraph && incomingGraph
      ? this.enrichKnowledgeGraph(
          incomingGraph,
          project.localPath,
          Array.isArray(input.relatedFiles) ? input.relatedFiles : [],
          existingGraph,
        )
      : incomingGraph || existing?.graph || {};

    const entity = this.projectMemoryRepository.create({
      id: existing?.id || `memory-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      projectId: project.id,
      title: input.title?.trim() || existing?.title || "Project memory",
      summary: input.summary?.trim() || existing?.summary || "",
      details: input.details?.trim() || existing?.details || "",
      graph: persistedGraph,
      kind: input.kind?.trim() || existing?.kind || "feature",
      tags: Array.isArray(input.tags) ? input.tags.map((tag) => String(tag).trim()).filter(Boolean) : existing?.tags || [],
      relatedFiles: Array.isArray(input.relatedFiles)
        ? input.relatedFiles.map((file) => String(file).trim()).filter(Boolean)
        : existing?.relatedFiles || [],
      sourceRunId: input.sourceRunId ?? existing?.sourceRunId ?? null,
      sourceChatId: input.sourceChatId ?? existing?.sourceChatId ?? null,
      relevanceScore: typeof input.relevanceScore === "number" ? input.relevanceScore : existing?.relevanceScore ?? 0.5,
      isActive: true,
      createdAt: existing?.createdAt || new Date(),
      updatedAt: new Date(),
    });

    return this.projectMemoryRepository.save(entity);
  }

  async save(input: SaveProjectDto) {
    const existing = input.id ? await this.projectsRepository.findOneBy({ id: input.id }) : null;
    const localPath = (input.localPath || existing?.localPath || "").trim();
    if (!localPath) {
      throw new Error("localPath is required");
    }
    const team = input.teamId ? await this.teamsRepository.findOneBy({ id: input.teamId }) : existing?.teamId ? await this.teamsRepository.findOneBy({ id: existing.teamId }) : null;

    const absoluteLocalPath = path.resolve(localPath);
    const localRoot = path.resolve(this.configService.get<string>("LOCAL_PROJECTS_ROOT", "/Users/evgenii"));
    
    if (!absoluteLocalPath.startsWith(localRoot)) {
      throw new Error(`Project path must be inside ${localRoot}`);
    }

    if (!fs.existsSync(absoluteLocalPath)) {
      try {
        fs.mkdirSync(absoluteLocalPath, { recursive: true });
      } catch (e) {
        throw new Error(`Cannot create directory ${localPath}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    const entity = this.projectsRepository.create({
      id: existing?.id || `project-${Date.now()}`,
      name: input.name?.trim() || existing?.name || path.basename(localPath),
      description: input.description?.trim() || existing?.description || "",
      localPath: absoluteLocalPath,
      containerPath: this.mapLocalPathToContainerPath(absoluteLocalPath),
      teamId: team?.id ?? null,
      isActive: true,
      createdAt: existing?.createdAt || new Date(),
      updatedAt: new Date(),
    });

    return this.projectsRepository.save(entity);
  }

  async remove(id: string) {
    const project = await this.getById(id);
    
    // Явное каскадное удаление связанных данных
    const chatIds = (await this.chatsRepository.find({ where: { projectId: id }, select: { id: true } })).map(c => c.id);
    
    if (chatIds.length) {
      for (const chatId of chatIds) {
        await this.messagesRepository.delete({ chatId });
        await this.runsRepository.delete({ chatId });
      }
    }
    
    await this.projectMemoryRepository.delete({ projectId: id });
    await this.chatsRepository.delete({ projectId: id });
    
    await this.projectsRepository.remove(project);
    return { ok: true };
  }

  mapLocalPathToContainerPath(localPath: string) {
    const localRoot = path.resolve(this.configService.get<string>("LOCAL_PROJECTS_ROOT", "/Users/evgenii"));
    const containerRoot = path.resolve(this.configService.get<string>("CONTAINER_PROJECTS_ROOT", localRoot));
    const absoluteLocalPath = path.resolve(localPath);

    if (!absoluteLocalPath.startsWith(localRoot)) {
      throw new Error(`Project path must be inside ${localRoot}`);
    }

    const relative = path.relative(localRoot, absoluteLocalPath);
    return path.join(containerRoot, relative);
  }
}
