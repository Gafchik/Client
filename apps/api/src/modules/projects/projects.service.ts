import { Injectable, NotFoundException } from "@nestjs/common";
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
import { TaskEntity } from "../../persistence/task.entity.js";
import { TaskCommentEntity } from "../../persistence/task-comment.entity.js";
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
    @InjectRepository(TaskEntity)
    private readonly tasksRepository: Repository<TaskEntity>,
    @InjectRepository(TaskCommentEntity)
    private readonly taskCommentsRepository: Repository<TaskCommentEntity>,
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
      localPath,
      containerPath: this.mapLocalPathToContainerPath(localPath),
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
      await this.messagesRepository.delete({ chatId: chatIds[0] }); // TypeORM не поддерживает IN в delete, делаем по одному
      for (const chatId of chatIds) {
        await this.messagesRepository.delete({ chatId });
      }
      await this.runsRepository.delete({ chatId: chatIds[0] });
      for (const chatId of chatIds) {
        await this.runsRepository.delete({ chatId });
      }
    }
    
    await this.tasksRepository.delete({ projectId: id });
    await this.projectMemoryRepository.delete({ projectId: id });
    await this.chatsRepository.delete({ projectId: id });
    
    await this.projectsRepository.remove(project);
    return { ok: true };
  }

  mapLocalPathToContainerPath(localPath: string) {
    const localRoot = path.resolve(this.configService.get<string>("LOCAL_PROJECTS_ROOT", "/Users/evgenii"));
    const containerRoot = path.resolve(this.configService.get<string>("CONTAINER_PROJECTS_ROOT", "/host-projects"));
    const absoluteLocalPath = path.resolve(localPath);

    if (!absoluteLocalPath.startsWith(localRoot)) {
      throw new Error(`Project path must be inside ${localRoot}`);
    }

    const relative = path.relative(localRoot, absoluteLocalPath);
    return path.join(containerRoot, relative);
  }
}
