import { Injectable, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { ProjectEntity } from "../../persistence/project.entity.js";
import { TaskEntity } from "../../persistence/task.entity.js";
import { SaveTaskDto } from "./dto/save-task.dto.js";

@Injectable()
export class TasksService {
  constructor(
    @InjectRepository(TaskEntity)
    private readonly tasksRepository: Repository<TaskEntity>,
    @InjectRepository(ProjectEntity)
    private readonly projectsRepository: Repository<ProjectEntity>,
  ) {}

  async list(projectId?: string) {
    return this.tasksRepository.find({
      where: projectId ? { projectId } : {},
      order: {
        updatedAt: "DESC",
      },
    });
  }

  async getById(id: string) {
    const task = await this.tasksRepository.findOneBy({ id });
    if (!task) throw new NotFoundException("Task not found");
    return task;
  }

  async save(input: SaveTaskDto) {
    const existing = input.id ? await this.tasksRepository.findOneBy({ id: input.id }) : null;
    const projectId = input.projectId || existing?.projectId || "";
    const project = await this.projectsRepository.findOneBy({ id: projectId });
    if (!project) {
      throw new Error("projectId is invalid");
    }

    const entity = this.tasksRepository.create({
      id: existing?.id || `task-${Date.now()}`,
      projectId: project.id,
      title: input.title?.trim() || existing?.title || "Новая задача",
      description: input.description?.trim() || existing?.description || "",
      status: input.status || existing?.status || "backlog",
      sourceChatId: input.sourceChatId ?? existing?.sourceChatId ?? null,
      createdAt: existing?.createdAt || new Date(),
      updatedAt: new Date(),
    });

    return this.tasksRepository.save(entity);
  }

  async remove(id: string) {
    const task = await this.getById(id);
    await this.tasksRepository.remove(task);
    return { ok: true };
  }
}
