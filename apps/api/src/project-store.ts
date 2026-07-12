import { randomUUID } from "node:crypto";
import type { ProjectPathRecord, ProjectRecord } from "@client/shared";
import { runQuery } from "./neo4j-client.js";

export interface SaveProjectPathInput {
  id?: string;
  name: string;
  rootPath: string;
}

export interface SaveProjectInput {
  id?: string;
  name: string;
  description?: string;
  paths: SaveProjectPathInput[];
}

export async function initializeProjectStore(): Promise<void> {
  await runQuery(`create constraint project_id_unique if not exists for (p:Project) require p.id is unique`);
  await runQuery(`create constraint project_path_id_unique if not exists for (pp:ProjectPath) require pp.id is unique`);
}

export async function listProjects(): Promise<ProjectRecord[]> {
  const rows = await runQuery<{
    project: Record<string, unknown>;
    paths: Array<Record<string, unknown>>;
  }>(`
    match (p:Project)
    optional match (p)-[:HAS_PATH]->(pp:ProjectPath)
    with p, pp
    order by pp.createdAt asc
    with p, collect(pp { .* }) as paths
    return p { .* } as project, paths
    order by p.updatedAt desc
  `);

  return rows.map((row) => mapProjectRow(row.project, row.paths));
}

export async function getProjectById(id: string): Promise<ProjectRecord | null> {
  const rows = await runQuery<{
    project: Record<string, unknown>;
    paths: Array<Record<string, unknown>>;
  }>(
    `
      match (p:Project { id: $id })
      optional match (p)-[:HAS_PATH]->(pp:ProjectPath)
      with p, pp
      order by pp.createdAt asc
      with p, collect(pp { .* }) as paths
      return p { .* } as project, paths
    `,
    { id },
  );

  const row = rows[0];

  if (!row) {
    return null;
  }

  return mapProjectRow(row.project, row.paths);
}

export async function saveProject(input: SaveProjectInput): Promise<ProjectRecord> {
  const nextId = input.id?.trim() || `project-${randomUUID()}`;
  const normalizedPaths = input.paths
    .map((item) => ({
      id: item.id?.trim() || `project-path-${randomUUID()}`,
      name: item.name.trim(),
      rootPath: item.rootPath.trim(),
    }))
    .filter((item) => item.name && item.rootPath);

  if (!input.name.trim()) {
    throw new Error("Нужно указать имя проекта.");
  }

  if (normalizedPaths.length === 0) {
    throw new Error("Нужно добавить хотя бы один путь проекта.");
  }

  const now = new Date().toISOString();

  await runQuery(
    `
      merge (p:Project { id: $id })
      on create set p.createdAt = $now
      set p.name = $name, p.description = $description, p.updatedAt = $now
      with p
      optional match (p)-[r:HAS_PATH]->(old:ProjectPath)
      delete r, old
    `,
    {
      id: nextId,
      name: input.name.trim(),
      description: input.description?.trim() || "",
      now,
    },
  );

  for (const pathItem of normalizedPaths) {
    await runQuery(
      `
        match (p:Project { id: $projectId })
        merge (pp:ProjectPath { id: $pathId })
        set pp.name = $name, pp.rootPath = $rootPath, pp.createdAt = $now, pp.updatedAt = $now
        merge (p)-[:HAS_PATH]->(pp)
      `,
      {
        projectId: nextId,
        pathId: pathItem.id,
        name: pathItem.name,
        rootPath: pathItem.rootPath,
        now,
      },
    );
  }

  const saved = await getProjectById(nextId);

  if (!saved) {
    throw new Error("Не удалось загрузить проект после сохранения.");
  }

  return saved;
}

export async function deleteProject(id: string): Promise<boolean> {
  const rows = await runQuery<{ deletedCount: number }>(
    `
      match (p:Project { id: $id })
      optional match (p)-[:HAS_PATH]->(pp:ProjectPath)
      with p, collect(pp) as paths
      foreach (item in paths | detach delete item)
      with p
      with p, 1 as deletedCount
      detach delete p
      return deletedCount
    `,
    { id },
  );

  return rows.length > 0;
}

function mapProjectRow(project: Record<string, unknown>, paths: Array<Record<string, unknown>>): ProjectRecord {
  return {
    id: String(project.id),
    name: String(project.name),
    description: String(project.description ?? ""),
    createdAt: String(project.createdAt),
    updatedAt: String(project.updatedAt),
    paths: paths
      .filter((path) => path && path.id)
      .map((path) => mapProjectPathRow(path, String(project.id))),
  };
}

function mapProjectPathRow(path: Record<string, unknown>, projectId: string): ProjectPathRecord {
  return {
    id: String(path.id),
    projectId,
    name: String(path.name),
    rootPath: String(path.rootPath),
    createdAt: String(path.createdAt),
    updatedAt: String(path.updatedAt),
  };
}
