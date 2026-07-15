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

    // node-postgres требует обработчик 'error' на самом Pool: без него
    // разрыв соединения на IDLE-клиенте (например Postgres перезапустился
    // или контейнер остановлен) становится unhandled 'error' event и роняет
    // весь процесс — проверено живьём (docker stop postgres убил API).
    pool.on("error", (error) => {
      console.warn("[postgres] idle client error (соединение разорвано, пул восстановится сам):", error);
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
  // default_model — какая модель используется по умолчанию для этого провайдера.
  // Раньше выбор модели нигде не сохранялся в БД и всегда падал на
  // CLIENT_PROVIDER_MODEL из .env, если вызывающая сторона явно не передала
  // providerModel в запросе (веб-фронт передавал, но хранил выбор только в
  // localStorage браузера — не в БД). ALTER ... ADD COLUMN IF NOT EXISTS,
  // а не отдельный migration runner — тот же идемпотентный подход, что и
  // create table if not exists выше.
  await runSql(`alter table providers add column if not exists default_model text not null default ''`);

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
  // conversation_id/turn_index — группировка последовательных question-run в
  // один диалог (см. loadConversationTurns в packages/knowledge). У первой
  // реплики conversation_id совпадает с run_id. ALTER ... ADD COLUMN IF NOT
  // EXISTS — тот же идемпотентный подход, что и для providers.default_model выше.
  await runSql(`alter table knowledge_catalog add column if not exists conversation_id text`);
  await runSql(`alter table knowledge_catalog add column if not exists turn_index integer not null default 0`);
  await runSql(
    `create index if not exists idx_knowledge_catalog_conversation on knowledge_catalog(conversation_id, turn_index asc)`,
  );
  // Реальный расход токенов провайдера за run (2026-07-15) — раньше нигде не
  // считался в проде; каждый "сколько токенов это стоило" вопрос в этой
  // сессии приходилось отвечать вручную, throwaway-скриптами. Один запрос
  // (например `select sum(total_tokens) from knowledge_catalog where
  // saved_at > now() - interval '1 day'`) теперь отвечает на это напрямую.
  await runSql(`alter table knowledge_catalog add column if not exists prompt_tokens integer not null default 0`);
  await runSql(`alter table knowledge_catalog add column if not exists completion_tokens integer not null default 0`);
  await runSql(`alter table knowledge_catalog add column if not exists total_tokens integer not null default 0`);
  await runSql(`alter table knowledge_catalog add column if not exists provider_call_count integer not null default 0`);

  await runSql(`
    create table if not exists project_facts (
      id text primary key,
      project_root_path text not null,
      category text not null,
      statement text not null,
      file_paths text[] not null default '{}',
      confidence integer not null default 50,
      status text not null default 'fresh',
      source text not null default 'research',
      content_hashes jsonb not null default '{}',
      created_at timestamptz not null,
      last_confirmed_at timestamptz not null,
      last_confirmed_head_commit text,
      superseded_by_fact_id text references project_facts(id)
    )
  `);
  await runSql(
    `create index if not exists idx_project_facts_lookup on project_facts(project_root_path, status, category)`,
  );

  // business_graph_entries — накопительная память Observer'а (см.
  // observer-monitor.ts): по одной записи на "unit" (директория/модуль
  // проекта верхнего уровня, НЕ то же самое, что IndexedSymbol.containerName
  // — отсюда unit_path, а не container_path, во избежание путаницы).
  // Свежесть — тот же content-hash идиом, что и у project_facts
  // (source_file_hashes сравнивается с текущим индексом на лету при чтении,
  // см. queryBusinessGraphEntries), не по дате/коммиту — переключение веток
  // назад по времени не должно ломать проверку.
  await runSql(`
    create table if not exists business_graph_entries (
      id text primary key,
      project_root_path text not null,
      unit_path text not null,
      feature_summary text not null default '',
      key_mechanisms text[] not null default '{}',
      gotchas text[] not null default '{}',
      source_file_hashes jsonb not null default '{}',
      confidence integer not null default 50,
      created_at timestamptz not null,
      last_crawled_at timestamptz not null
    )
  `);
  await runSql(
    `create index if not exists idx_business_graph_entries_project on business_graph_entries(project_root_path, unit_path)`,
  );

  // teams — Researcher/Critic/Observer роли, каждая закреплена за моделью
  // (свободная строка, отправляется как есть в /chat/completions текущего
  // выбранного Provider — здесь нет отдельных credentials, см. team-store.ts).
  // is_selected — тот же singleton-паттерн, что и providers.is_current
  // (clear-then-set в транзакции, без отдельного unique index).
  await runSql(`
    create table if not exists teams (
      id text primary key,
      name text not null,
      researcher_model text not null default '',
      critic_model text not null default '',
      observer_model text not null default '',
      is_selected boolean not null default false,
      created_at timestamptz not null,
      updated_at timestamptz not null
    )
  `);

  // knowledge_artifacts — полное тело каждого завершённого run'а (весь
  // research/impact/context/answer), раньше жило файлами в
  // .client/knowledge/projects/<hash>/runs/<runId>.json (2026-07-15: явное
  // требование пользователя - ничего не должно лежать в файлах, всё в
  // Postgres). run_id уже глобально уникален (см. knowledge_catalog) -
  // project_root_path здесь не дублируется, при необходимости join через
  // knowledge_catalog.
  await runSql(`
    create table if not exists knowledge_artifacts (
      run_id text primary key,
      body jsonb not null,
      saved_at timestamptz not null
    )
  `);
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
