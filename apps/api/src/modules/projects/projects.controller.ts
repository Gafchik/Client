import { Body, Controller, Delete, Get, Param, Post } from "@nestjs/common";
import { ProjectsService } from "./projects.service.js";
import { SaveProjectMemoryDto } from "./dto/save-project-memory.dto.js";
import { SaveProjectDto } from "./dto/save-project.dto.js";

@Controller("projects")
export class ProjectsController {
  constructor(private readonly projectsService: ProjectsService) {}

  @Get()
  async listProjects() {
    const projects = await this.projectsService.list();
    return { projects };
  }

  @Post()
  async saveProject(@Body() body: SaveProjectDto) {
    const project = await this.projectsService.save(body);
    return { project };
  }

  @Get(":id/memory")
  async listProjectMemory(@Param("id") id: string) {
    const entries = await this.projectsService.listMemory(id);
    return { entries };
  }

  @Post("memory")
  async saveProjectMemory(@Body() body: SaveProjectMemoryDto) {
    const entry = await this.projectsService.saveMemory(body);
    return { entry };
  }

  @Delete(":id")
  async deleteProject(@Param("id") id: string) {
    return this.projectsService.remove(id);
  }
}
