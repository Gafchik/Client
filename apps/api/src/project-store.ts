import { randomUUID } from "node:crypto";
import { forgetProjectPath } from "@client/knowledge";
import type { PathRole, ProjectPathRecord, ProjectRecord } from "@client/shared";
import { runSql, withTransaction } from "./postgres-client.js";
import { inferProjectPathRole } from "./path-role.js";
import { stopObserver } from "./observer-monitor.js";

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
  role: PathRole;
  sort_order: number;
  created_at: Date;
  updated_at: Date;
}

export async function initializeProjectStore(): Promise<void> {
  // Таблицы создаются централизованно в initializePostgresSchema() (postgres-client.ts).
  await backfillUnclassifiedPathRoles();
  await backfillMissingSortOrder();
}

// One-time backfill (2026-07-16, live bug found during multi-path
// verification) - rows saved before sort_order existed all default to 0,
// which is exactly the "no real order" state that caused the bug (paths[0]
// resolving to an arbitrary path). Assigns a stable sequential order per
// project (by id - there is no way to recover the user's original intended
// order from the corrupted-tiebreaker created_at data) so at least it is
// deterministic going forward; a user who wants a SPECIFIC primary path can
// re-save the project through the UI, which always writes sort_order
// correctly from the form's array order.
async function backfillMissingSortOrder(): Promise<void> {
  try {
    const projectIds = await runSql<{ project_id: string }>(
      `select distinct project_id from project_paths where project_id in (
        select project_id from project_paths group by project_id having count(*) > 1
      )`,
    );

    // Backend first, then web/desktop frontends, then cli/unknown - a more
    // useful default primary path than pure id order (the legacy
    // deterministic pipeline's workspace/index/graph stays keyed to
    // paths[0], and a backend repo is what that pipeline was built around).
    const rolePriority: Record<string, number> = { backend: 0, "frontend-web": 1, "frontend-desktop": 2, cli: 3, unknown: 4 };

    for (const { project_id } of projectIds) {
      const rows = await runSql<{ id: string; role: string }>(
        `select id, role from project_paths where project_id = $1 order by id asc`,
        [project_id],
      );
      rows.sort((a, b) => (rolePriority[a.role] ?? 9) - (rolePriority[b.role] ?? 9));

      // Only rebalance if every row still has the untouched default (0) -
      // a project already re-saved through the UI has real, meaningful
      // sort_order values that must not be clobbered by this one-time pass.
      const stillDefault = await runSql<{ count: string }>(
        `select count(*) from project_paths where project_id = $1 and sort_order != 0`,
        [project_id],
      );

      if (Number(stillDefault[0]?.count ?? "0") > 0) {
        continue;
      }

      await Promise.all(
        rows.map((row, index) => runSql(`update project_paths set sort_order = $1 where id = $2`, [index, row.id])),
      );
    }
  } catch (error) {
    console.warn("[project-store] backfillMissingSortOrder failed, will retry next boot:", error);
  }
}

// One-time backfill (2026-07-16, multi-path unification) - project_paths
// rows saved before the `role` column existed default to 'unknown'; this
// classifies them on boot instead of requiring the user to re-save every
// project through the UI. Cheap (a handful of file reads per path) and
// idempotent - safe to run on every startup.
async function backfillUnclassifiedPathRoles(): Promise<void> {
  try {
    const rows = await runSql<{ id: string; root_path: string }>(
      `select id, root_path from project_paths where role = 'unknown'`,
    );

    for (const row of rows) {
      const role = await inferProjectPathRole(row.root_path);

      if (role !== "unknown") {
        await runSql(`update project_paths set role = $1 where id = $2`, [role, row.id]);
      }
    }
  } catch (error) {
    console.warn("[project-store] backfillUnclassifiedPathRoles failed, will retry next boot:", error);
  }
}

export async function listProjects(): Promise<ProjectRecord[]> {
  const projects = await runSql<ProjectRow>(`select * from projects order by updated_at desc`);
  const paths = await runSql<ProjectPathRow>(`select * from project_paths order by sort_order asc, created_at asc`);

  return projects.map((project) => mapProjectRow(project, paths.filter((path) => path.project_id === project.id)));
}

export async function getProjectById(id: string): Promise<ProjectRecord | null> {
  const projects = await runSql<ProjectRow>(`select * from projects where id = $1`, [id]);
  const project = projects[0];

  if (!project) {
    return null;
  }

  const paths = await runSql<ProjectPathRow>(
    `select * from project_paths where project_id = $1 order by sort_order asc, created_at asc`,
    [id],
  );

  return mapProjectRow(project, paths);
}

export async function saveProject(input: SaveProjectInput): Promise<ProjectRecord> {
  const nextId = input.id?.trim() || `project-${randomUUID()}`;
  const normalizedPathsRaw = input.paths
    .map((item) => ({
      id: item.id?.trim() || `project-path-${randomUUID()}`,
      name: item.name.trim(),
      rootPath: item.rootPath.trim(),
    }))
    .filter((item) => item.name && item.rootPath);
  // Auto-detected per path on every save (2026-07-16, multi-path
  // unification) - cheap (a handful of file reads), re-run on every save so
  // an edited path (e.g. rootPath changed) gets re-classified too.
  const normalizedPaths = await Promise.all(
    normalizedPathsRaw.map(async (item) => ({ ...item, role: await inferProjectPathRole(item.rootPath) })),
  );

  if (!input.name.trim()) {
    throw new Error("Нужно указать имя проекта.");
  }

  if (normalizedPaths.length === 0) {
    throw new Error("Нужно добавить хотя бы один путь проекта.");
  }

  const now = new Date().toISOString();
  const name = input.name.trim();
  const description = input.description?.trim() || "";

  // Cleanup for paths removed from an EXISTING project (2026-07-16, live bug
  // found during multi-path verification): saveProject always deletes and
  // re-inserts every project_paths row, but a path the user removed from the
  // form (e.g. dropped "gui" from slay) previously left every other table
  // (knowledge_catalog/facts/business_graph_entries/code_embeddings) keyed by
  // that rootPath orphaned forever - see forgetProjectPath. Computed BEFORE
  // the transaction below deletes the old project_paths rows.
  const previousRootPaths = input.id?.trim()
    ? new Set((await getProjectById(input.id.trim()))?.paths.map((path) => path.rootPath) ?? [])
    : new Set<string>();
  const nextRootPaths = new Set(normalizedPaths.map((path) => path.rootPath));
  const removedRootPaths = [...previousRootPaths].filter((rootPath) => !nextRootPaths.has(rootPath));

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

    for (const [index, pathItem] of normalizedPaths.entries()) {
      await client.query(
        `
          insert into project_paths (id, project_id, name, root_path, role, sort_order, created_at, updated_at)
          values ($1, $2, $3, $4, $5, $6, $7, $7)
        `,
        [pathItem.id, nextId, pathItem.name, pathItem.rootPath, pathItem.role, index, now],
      );
    }
  });

  for (const removedRootPath of removedRootPaths) {
    stopObserver(removedRootPath);
    void forgetProjectPath(removedRootPath);
  }

  const saved = await getProjectById(nextId);

  if (!saved) {
    throw new Error("Не удалось загрузить проект после сохранения.");
  }

  return saved;
}

export async function deleteProject(id: string): Promise<boolean> {
  // Fetched BEFORE the delete - project_paths cascades away with the
  // project row (FK ON DELETE CASCADE), but that only clears project_paths
  // itself; every other table (knowledge_catalog/facts/business_graph_entries/
  // code_embeddings) is keyed by a plain project_root_path STRING with no FK
  // at all, so it needs its own explicit cleanup per removed path (live bug
  // found during multi-path verification - see forgetProjectPath).
  const existing = await getProjectById(id);
  const result = await runSql<{ id: string }>(`delete from projects where id = $1 returning id`, [id]);
  const deleted = result.length > 0;

  if (deleted && existing) {
    for (const path of existing.paths) {
      stopObserver(path.rootPath);
      void forgetProjectPath(path.rootPath);
    }
  }

  return deleted;
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
    role: path.role ?? "unknown",
    createdAt: new Date(path.created_at).toISOString(),
    updatedAt: new Date(path.updated_at).toISOString(),
  };
}
