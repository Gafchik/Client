import { Pool, type PoolClient } from "pg";

let pool: Pool | null = null;

export function getPostgresPool(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL?.trim();

    pool = connectionString
      ? new Pool({ connectionString })
      : new Pool({
          host: process.env.POSTGRES_HOST?.trim() || "127.0.0.1",
          port: Number(process.env.POSTGRES_PORT ?? 5432),
          user: process.env.POSTGRES_USER?.trim() || "client",
          password: process.env.POSTGRES_PASSWORD?.trim() || "clientmeta",
          database: process.env.POSTGRES_DB?.trim() || "client",
        });
  }

  return pool;
}

export async function runSql<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const result = await getPostgresPool().query(sql, params);
  return result.rows as T[];
}

/**
 * Идемпотентная инициализация схемы (`create table if not exists`), без
 * отдельного migration runner'а — соразмерно текущему размеру проекта
 * (тот же подход, что и `create constraint if not exists` в neo4j-client.ts).
 * Metадannye: Project, Provider, история чатов (knowledge_catalog).
 * Тела run-артефактов и pipeline-status остаются файлами в `.client/`.
 */
export async function initializePostgresSchema(): Promise<void> {
  await runSql(`
    create table if not exists projects (
      id text primary key,
      name text not null,
      description text not null default '',
      created_at timestamptz not null,
      updated_at timestamptz not null
    )
  `);

  await runSql(`
    create table if not exists project_paths (
      id text primary key,
      project_id text not null references projects(id) on delete cascade,
      name text not null,
      root_path text not null,
      created_at timestamptz not null,
      updated_at timestamptz not null
    )
  `);
  await runSql(`create index if not exists idx_project_paths_project_id on project_paths(project_id)`);

  await runSql(`
    create table if not exists providers (
      id text primary key,
      name text not null,
      base_url text not null,
      api_key text not null default '',
      is_active boolean not null default true,
      is_current boolean not null default false,
      created_at timestamptz not null,
      updated_at timestamptz not null
    )
  `);

  await runSql(`
    create table if not exists knowledge_catalog (
      run_id text primary key,
      project_root_path text not null,
      task text not null,
      saved_at timestamptz not null,
      storage_path text not null,
      summary text not null default '',
      mode text not null,
      repository_id text,
      branch text,
      head_commit text,
      head_fingerprint text
    )
  `);
  await runSql(
    `create index if not exists idx_knowledge_catalog_project on knowledge_catalog(project_root_path, saved_at desc)`,
  );
}

/**
 * Транзакционная обёртка для многошаговых записей (например: пересоздать
 * project_paths проекта атомарно). BEGIN/COMMIT/ROLLBACK вокруг переданной
 * функции; клиент всегда возвращается в пул через `release()`.
 */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPostgresPool().connect();

  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function verifyPostgresConnectivity(): Promise<boolean> {
  try {
    await runSql("select 1");
    return true;
  } catch {
    return false;
  }
}

export async function closePostgresPool(): Promise<void> {
  if (!pool) {
    return;
  }

  await pool.end();
  pool = null;
}
