import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
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
import { SaveProjectMemoryDto } from "./dto/save-project-memory.dto.js";
import { SaveProjectDto } from "./dto/save-project.dto.js";

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
  ) {}

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
