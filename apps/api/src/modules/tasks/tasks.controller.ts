import { Body, Controller, Delete, Get, Param, Post, Query } from "@nestjs/common";
import { CreateTaskCommentDto } from "./dto/create-task-comment.dto.js";
import { SaveTaskDto } from "./dto/save-task.dto.js";
import { UpdateTaskStatusDto } from "./dto/update-task-status.dto.js";
import { TasksService } from "./tasks.service.js";

@Controller("tasks")
export class TasksController {
  constructor(private readonly tasksService: TasksService) {}

  @Get()
  async listTasks(@Query("projectId") projectId?: string) {
    const tasks = await this.tasksService.list(projectId);
    return { tasks };
  }

  @Post()
  async saveTask(@Body() body: SaveTaskDto) {
    const task = await this.tasksService.save(body);
    return { task };
  }

  @Post(":id/status")
  async updateTaskStatus(@Param("id") id: string, @Body() body: UpdateTaskStatusDto) {
    const task = await this.tasksService.updateStatus(id, body);
    return { task };
  }

  @Get(":id/comments")
  async getTaskComments(@Param("id") id: string) {
    const comments = await this.tasksService.listComments(id);
    return { comments };
  }

  @Post(":id/comments/result")
  async addResultComment(@Param("id") id: string, @Body() body: CreateTaskCommentDto) {
    const comment = await this.tasksService.addResultComment(id, body);
    return { comment };
  }

  @Delete(":id")
  async deleteTask(@Param("id") id: string) {
    return this.tasksService.remove(id);
  }
}
