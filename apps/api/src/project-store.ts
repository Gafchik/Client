import { randomUUID } from "node:crypto";
import type { ProjectPathRecord, ProjectRecord } from "@client/shared";
import { runSql, withTransaction } from "./postgres-client.js";

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

interface ProjectRow {
  id: string;
  name: string;
  description: string;
  created_at: Date;
  updated_at: Date;
}

interface ProjectPathRow {
  id: string;
  project_id: string;
  name: string;
  root_path: string;
  created_at: Date;
  updated_at: Date;
}

export async function initializeProjectStore(): Promise<void> {
  // Таблицы создаются централизованно в initializePostgresSchema() (postgres-client.ts).
}

export async function listProjects(): Promise<ProjectRecord[]> {
  const projects = await runSql<ProjectRow>(`select * from projects order by updated_at desc`);
  const paths = await runSql<ProjectPathRow>(`select * from project_paths order by created_at asc`);

  return projects.map((project) => mapProjectRow(project, paths.filter((path) => path.project_id === project.id)));
}

export async function getProjectById(id: string): Promise<ProjectRecord | null> {
  const projects = await runSql<ProjectRow>(`select * from projects where id = $1`, [id]);
  const project = projects[0];

  if (!project) {
    return null;
  }

  const paths = await runSql<ProjectPathRow>(
    `select * from project_paths where project_id = $1 order by created_at asc`,
    [id],
  );

  return mapProjectRow(project, paths);
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
  const name = input.name.trim();
  const description = input.description?.trim() || "";

  await withTransaction(async (client) => {
    await client.query(
      `
        insert into projects (id, name, description, created_at, updated_at)
        values ($1, $2, $3, $4, $4)
        on conflict (id) do update set name = $2, description = $3, updated_at = $4
      `,
      [nextId, name, description, now],
    );

    await client.query(`delete from project_paths where project_id = $1`, [nextId]);

    for (const pathItem of normalizedPaths) {
      await client.query(
        `
          insert into project_paths (id, project_id, name, root_path, created_at, updated_at)
          values ($1, $2, $3, $4, $5, $5)
        `,
        [pathItem.id, nextId, pathItem.name, pathItem.rootPath, now],
      );
    }
  });

  const saved = await getProjectById(nextId);

  if (!saved) {
    throw new Error("Не удалось загрузить проект после сохранения.");
  }

  return saved;
}

export async function deleteProject(id: string): Promise<boolean> {
  const result = await runSql<{ id: string }>(`delete from projects where id = $1 returning id`, [id]);
  return result.length > 0;
}

function mapProjectRow(project: ProjectRow, paths: ProjectPathRow[]): ProjectRecord {
  return {
    id: project.id,
    name: project.name,
    description: project.description ?? "",
    createdAt: new Date(project.created_at).toISOString(),
    updatedAt: new Date(project.updated_at).toISOString(),
    paths: paths.map((path) => mapProjectPathRow(path)),
  };
}

function mapProjectPathRow(path: ProjectPathRow): ProjectPathRecord {
  return {
    id: path.id,
    projectId: path.project_id,
    name: path.name,
    rootPath: path.root_path,
    createdAt: new Date(path.created_at).toISOString(),
    updatedAt: new Date(path.updated_at).toISOString(),
  };
}
