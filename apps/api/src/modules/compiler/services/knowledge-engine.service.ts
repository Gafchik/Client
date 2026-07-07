import { Inject, Injectable } from "@nestjs/common";
import { ProjectsService } from "../../projects/projects.service.js";
import { ProjectKnowledgeSnapshot } from "../types/compiler.types.js";

@Injectable()
export class KnowledgeEngineService {
  constructor(
    @Inject(ProjectsService)
    private readonly projectsService: ProjectsService,
  ) {}

  async getSnapshot(projectId: string, query: string): Promise<ProjectKnowledgeSnapshot> {
    const memory = await this.projectsService.searchMemory(projectId, query, 8);
    const graphEntry = await this.projectsService.getKnowledgeGraph(projectId);
    const graph = graphEntry?.graph && typeof graphEntry.graph === "object"
      ? graphEntry.graph as Record<string, any>
      : {};

    const coverageRaw = graph.coverage && typeof graph.coverage === "object"
      ? graph.coverage as Record<string, unknown>
      : {};
    const coverage: Record<string, number> = {};
    for (const [key, value] of Object.entries(coverageRaw)) {
      const num = Number(value);
      coverage[key] = Number.isFinite(num) ? Math.max(0, Math.min(100, Math.round(num))) : 0;
    }

    const topEntities = Array.isArray(graph.entityIndex)
      ? graph.entityIndex.slice(0, 24).map((item: any) => ({
          id: String(item?.id || ""),
          name: String(item?.name || item?.id || "Unknown"),
          kind: String(item?.kind || "Unknown"),
          location: String(item?.location || item?.path || "unknown"),
        }))
      : [];

    const unknowns = Array.isArray(graph.unknowns)
      ? graph.unknowns.map((item: unknown) => String(item || "").trim()).filter(Boolean).slice(0, 20)
      : [];

    const topMemory = memory.map((entry: any) => ({
      id: String(entry.id),
      title: String(entry.title || ""),
      summary: String(entry.summary || ""),
      kind: String(entry.kind || ""),
      relatedFiles: Array.isArray(entry.relatedFiles) ? entry.relatedFiles.map((f: any) => String(f)) : [],
    }));

    return { coverage, unknowns, topEntities, topMemory };
  }
}

