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
