import { Body, Controller, Delete, Get, Param, Post, Query } from "@nestjs/common";
import { SaveTaskDto } from "./dto/save-task.dto.js";
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

  @Delete(":id")
  async deleteTask(@Param("id") id: string) {
    return this.tasksService.remove(id);
  }
}
