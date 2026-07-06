import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
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

  async upsertKnowledgeGraphIndex(input: SaveProjectMemoryDto) {
    const entries = await this.projectMemoryRepository.find({
      where: { projectId: input.projectId, isActive: true, kind: "knowledge-graph-index" },
      order: { updatedAt: "DESC" },
      take: 1,
    });
    const existing = entries[0] || null;
    const incomingGraph = input.graph && typeof input.graph === "object" ? input.graph as Record<string, any> : {};
    const currentGraph = existing?.graph && typeof existing.graph === "object" ? existing.graph as Record<string, any> : {};

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

    return this.saveMemory({
      ...input,
      id: existing?.id,
      title: "Knowledge Graph Index",
      kind: "knowledge-graph-index",
      graph: mergedGraph,
      summary: input.summary || "Сводный граф знаний проекта",
      details: input.details || "Автоматически объединённый индекс знаний проекта",
      tags: Array.from(new Set([...(input.tags || []), "knowledge-graph", "index", "source-of-truth"])),
    });
  }

  async saveMemory(input: SaveProjectMemoryDto) {
    const project = await this.projectsRepository.findOneBy({ id: input.projectId });
    if (!project) throw new Error("projectId is invalid");
    const existing = input.id ? await this.projectMemoryRepository.findOneBy({ id: input.id }) : null;

    const entity = this.projectMemoryRepository.create({
      id: existing?.id || `memory-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      projectId: project.id,
      title: input.title?.trim() || existing?.title || "Project memory",
      summary: input.summary?.trim() || existing?.summary || "",
      details: input.details?.trim() || existing?.details || "",
      graph: input.graph && typeof input.graph === "object" ? input.graph : existing?.graph || {},
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
