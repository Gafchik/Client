import { Body, Controller, Delete, Get, Param, Post } from "@nestjs/common";
import { ProjectsService } from "./projects.service.js";
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

  @Delete(":id")
  async deleteProject(@Param("id") id: string) {
    return this.projectsService.remove(id);
  }
}
