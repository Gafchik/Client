import { Body, Controller, Delete, Get, Inject, Param, Post } from "@nestjs/common";
import { ProjectsService } from "./projects.service.js";
import { SaveProjectMemoryDto } from "./dto/save-project-memory.dto.js";
import { SaveProjectDto } from "./dto/save-project.dto.js";

@Controller("projects")
export class ProjectsController {
  constructor(@Inject(ProjectsService) private readonly projectsService: ProjectsService) {}

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

  @Get(":id/memory/knowledge-graph")
  async getKnowledgeGraph(@Param("id") id: string) {
    const entry = await this.projectsService.getKnowledgeGraph(id);
    return { entry };
  }

  @Get(":id/memory/dependencies/:entity")
  async getEntityDependencies(@Param("id") id: string, @Param("entity") entity: string) {
    const dependencies = await this.projectsService.getEntityDependencies(id, decodeURIComponent(entity));
    return { dependencies };
  }

  @Post(":id/memory/impact")
  async analyzeImpact(@Param("id") id: string, @Body() body: { changed?: string[] }) {
    const changed = Array.isArray(body?.changed) ? body.changed.map((item) => String(item).trim()).filter(Boolean) : [];
    const impact = await this.projectsService.analyzeImpact(id, changed);
    return { impact };
  }

  @Post(":id/resync")
  async runResync(@Param("id") id: string) {
    const result = await this.projectsService.runResync(id);
    return { result };
  }

  @Get(":id/resync/status")
  async getResyncStatus(@Param("id") id: string) {
    const status = await this.projectsService.getResyncStatus(id);
    return { status };
  }

  @Get(":id/resync/history")
  async listResyncHistory(@Param("id") id: string) {
    const items = await this.projectsService.listResyncHistory(id);
    return { items };
  }

  @Get(":id/resync/history/:entryId")
  async getResyncHistoryEntry(@Param("id") id: string, @Param("entryId") entryId: string) {
    const entry = await this.projectsService.getResyncHistoryEntry(id, entryId);
    return { entry };
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
