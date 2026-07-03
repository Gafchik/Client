import { Injectable, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import path from "node:path";
import { Repository } from "typeorm";
import { ProjectMemoryEntryEntity } from "../../persistence/project-memory.entity.js";
import { ProjectEntity } from "../../persistence/project.entity.js";
import { TeamEntity } from "../../persistence/team.entity.js";
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
