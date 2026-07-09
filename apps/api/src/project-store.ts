import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import type { ProjectPathRecord, ProjectRecord } from "@client/shared";

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

let pool: Pool | null = null;
let initialized = false;

export async function initializeProjectStore(): Promise<void> {
  const databasePool = getPool();

  if (!initialized) {
    await databasePool.query(`
      create table if not exists projects (
        id text primary key,
        name text not null,
        description text not null default '',
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )
    `);
    await databasePool.query(`
      create table if not exists project_paths (
        id text primary key,
        project_id text not null references projects(id) on delete cascade,
        name text not null,
        root_path text not null,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )
    `);
    initialized = true;
  }
}

export async function listProjects(): Promise<ProjectRecord[]> {
  const result = await getPool().query(
    `
      select
        p.id as project_id,
        p.name as project_name,
        p.description as project_description,
        p.created_at as project_created_at,
        p.updated_at as project_updated_at,
        pp.id as path_id,
        pp.name as path_name,
        pp.root_path as path_root_path,
        pp.created_at as path_created_at,
        pp.updated_at as path_updated_at
      from projects p
      left join project_paths pp on pp.project_id = p.id
      order by p.updated_at desc, pp.created_at asc
    `,
  );

  const projectMap = new Map<string, ProjectRecord>();

  for (const row of result.rows) {
    const projectId = String(row.project_id);
    const existing = projectMap.get(projectId);

    if (!existing) {
      projectMap.set(projectId, {
        id: projectId,
        name: String(row.project_name),
        description: String(row.project_description ?? ""),
        createdAt: new Date(String(row.project_created_at)).toISOString(),
        updatedAt: new Date(String(row.project_updated_at)).toISOString(),
        paths: [],
      });
    }

    if (row.path_id) {
      projectMap.get(projectId)?.paths.push({
        id: String(row.path_id),
        projectId,
        name: String(row.path_name),
        rootPath: String(row.path_root_path),
        createdAt: new Date(String(row.path_created_at)).toISOString(),
        updatedAt: new Date(String(row.path_updated_at)).toISOString(),
      });
    }
  }

  return Array.from(projectMap.values());
}

export async function getProjectById(id: string): Promise<ProjectRecord | null> {
  const projects = await listProjects();
  return projects.find((project) => project.id === id) ?? null;
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

  const client = await getPool().connect();

  try {
    await client.query("begin");
    await client.query(
      `
        insert into projects (id, name, description)
        values ($1, $2, $3)
        on conflict (id)
        do update set
          name = excluded.name,
          description = excluded.description,
          updated_at = now()
      `,
      [nextId, input.name.trim(), input.description?.trim() || ""],
    );

    await client.query(`delete from project_paths where project_id = $1`, [nextId]);

    for (const pathItem of normalizedPaths) {
      await client.query(
        `
          insert into project_paths (id, project_id, name, root_path)
          values ($1, $2, $3, $4)
        `,
        [pathItem.id, nextId, pathItem.name, pathItem.rootPath],
      );
    }

    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }

  const saved = await getProjectById(nextId);

  if (!saved) {
    throw new Error("Не удалось загрузить проект после сохранения.");
  }

  return saved;
}

export async function deleteProject(id: string): Promise<boolean> {
  const result = await getPool().query(`delete from projects where id = $1`, [id]);
  return Number(result.rowCount ?? 0) > 0;
}

function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      host: process.env.DATABASE_HOST ?? "127.0.0.1",
      port: Number(process.env.DATABASE_PORT ?? 35433),
      database: process.env.DATABASE_NAME ?? process.env.POSTGRES_DB ?? "client",
      user: process.env.DATABASE_USER ?? process.env.POSTGRES_USER ?? "postgres",
      password: process.env.DATABASE_PASSWORD ?? process.env.POSTGRES_PASSWORD ?? "postgres",
      max: 10,
    });
  }

  return pool;
}
