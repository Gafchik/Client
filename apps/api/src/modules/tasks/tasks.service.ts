import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { ProjectEntity } from "../../persistence/project.entity.js";
import { TaskCommentEntity } from "../../persistence/task-comment.entity.js";
import { TASK_STATUSES, TaskEntity, TaskStatus } from "../../persistence/task.entity.js";
import { CreateTaskCommentDto } from "./dto/create-task-comment.dto.js";
import { SaveTaskDto } from "./dto/save-task.dto.js";
import { UpdateTaskStatusDto } from "./dto/update-task-status.dto.js";

const allowedTransitions: Record<TaskStatus, TaskStatus[]> = {
  backlog: ["todo"],
  todo: ["in_progress"],
  in_progress: ["review"],
  review: ["done", "in_progress"],
  done: [],
};

@Injectable()
export class TasksService {
  constructor(
    @InjectRepository(TaskEntity)
    private readonly tasksRepository: Repository<TaskEntity>,
    @InjectRepository(TaskCommentEntity)
    private readonly taskCommentsRepository: Repository<TaskCommentEntity>,
    @InjectRepository(ProjectEntity)
    private readonly projectsRepository: Repository<ProjectEntity>,
  ) {}

  async list(projectId?: string) {
    return this.tasksRepository.find({
      where: projectId ? { projectId } : {},
      order: { updatedAt: "DESC" },
    });
  }

  async getById(id: string) {
    const task = await this.tasksRepository.findOneBy({ id });
    if (!task) throw new NotFoundException("Task not found");
    return task;
  }

  async listComments(taskId: string) {
    await this.getById(taskId);
    return this.taskCommentsRepository.find({
      where: { taskId },
      order: { createdAt: "ASC" },
    });
  }

  async save(input: SaveTaskDto) {
    const existing = input.id ? await this.tasksRepository.findOneBy({ id: input.id }) : null;
    const projectId = input.projectId || existing?.projectId || "";
    const project = await this.projectsRepository.findOneBy({ id: projectId });
    if (!project) throw new BadRequestException("projectId is invalid");

    const nextStatus = input.status || existing?.status || "backlog";
    this.assertKnownStatus(nextStatus);

    if (existing && input.status && input.status !== existing.status) {
      this.assertTransitionAllowed(existing.status, input.status);
    }

    const entity = this.tasksRepository.create({
      id: existing?.id || `task-${Date.now()}`,
      projectId: project.id,
      title: input.title?.trim() || existing?.title || "New task",
      description: input.description?.trim() || existing?.description || "",
      status: nextStatus,
      sourceChatId: input.sourceChatId ?? existing?.sourceChatId ?? null,
      createdAt: existing?.createdAt || new Date(),
      updatedAt: new Date(),
    });

    const saved = await this.tasksRepository.save(entity);

    if (existing && input.status && input.status !== existing.status) {
      await this.createComment(saved.id, {
        type: "status_change",
        content: `Status changed: ${existing.status} -> ${input.status}`,
        author: "system",
      });
    }

    return saved;
  }

  async updateStatus(id: string, input: UpdateTaskStatusDto) {
    this.assertKnownStatus(input.status);
    const task = await this.getById(id);

    if (task.status === input.status) {
      return task;
    }

    this.assertTransitionAllowed(task.status, input.status);
    const previous = task.status;
    task.status = input.status;
    task.updatedAt = new Date();
    const saved = await this.tasksRepository.save(task);

    await this.createComment(id, {
      type: "status_change",
      content: input.comment?.trim() || `Status changed: ${previous} -> ${input.status}`,
      author: input.author?.trim() || "system",
    });

    return saved;
  }

  async addResultComment(id: string, input: CreateTaskCommentDto) {
    await this.getById(id);
    if (!input.content?.trim()) {
      throw new BadRequestException("content is required");
    }

    return this.createComment(id, {
      type: "result",
      content: input.content.trim(),
      author: input.author?.trim() || "system",
    });
  }

  async remove(id: string) {
    const task = await this.getById(id);
    await this.tasksRepository.remove(task);
    return { ok: true };
  }

  private assertKnownStatus(status: string): asserts status is TaskStatus {
    if (!TASK_STATUSES.includes(status as TaskStatus)) {
      throw new BadRequestException(`Unknown task status: ${status}`);
    }
  }

  private assertTransitionAllowed(from: TaskStatus, to: TaskStatus) {
    if (!allowedTransitions[from]?.includes(to)) {
      throw new BadRequestException(`Transition not allowed: ${from} -> ${to}`);
    }
  }

  private async createComment(taskId: string, input: { type: "status_change" | "result"; content: string; author?: string | null }) {
    const entity = this.taskCommentsRepository.create({
      id: `task-comment-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      taskId,
      type: input.type,
      content: input.content,
      author: input.author ?? null,
      createdAt: new Date(),
    });
    return this.taskCommentsRepository.save(entity);
  }
}
