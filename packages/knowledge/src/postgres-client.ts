import { Pool } from "pg";

let pool: Pool | null = null;
let usingInjectedPool = false;

/**
 * Bug fix (2026-07-19, full-project review): apps/api/src/postgres-client.ts
 * and this file used to each create their OWN independent `Pool` against the
 * exact same database (same env vars, same connection settings) - doubling
 * real connection pressure on Postgres for no reason, and only apps/api's
 * copy was ever closed on shutdown (see closePostgresPool there); this one
 * leaked its connections until the process itself exited. apps/api owns
 * Postgres lifecycle (it's the one that runs initializePostgresSchema and
 * closePostgresPool on the `onClose` hook) - it now calls setSharedPool()
 * once at boot, before anything else touches the database, so every query
 * from this package goes through that SAME pool/connection budget and gets
 * closed by that SAME shutdown path. getPool() still lazily creates its own
 * as a fallback if setSharedPool was never called (tests, or any other
 * future consumer of this package that doesn't happen to be apps/api) -
 * this must keep working standalone, not require apps/api's boot sequence.
 */
export function setSharedPool(sharedPool: Pool): void {
  pool = sharedPool;
  usingInjectedPool = true;
}

/** Companion to apps/api's closePostgresPool - drops the reference so a lazy fallback pool can't be confused with the (now-closed) shared one. */
export function clearSharedPool(): void {
  if (usingInjectedPool) {
    pool = null;
    usingInjectedPool = false;
  }
}

function getPool(): Pool {
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
    // разрыв соединения на IDLE-клиенте становится unhandled 'error' event
    // и роняет весь процесс — проверено живьём (docker stop postgres убил API).
    pool.on("error", (error) => {
      console.warn("[knowledge/postgres] idle client error (соединение разорвано, пул восстановится сам):", error);
    });
  }

  return pool;
}

export async function runSql<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const result = await getPool().query(sql, params);
  return result.rows as T[];
}

/**
 * Bug fix (2026-07-19, full-project review): several multi-statement writes
 * in this package (e.g. saveKnowledgeArtifacts's catalog row + facts +
 * glossary + business-graph writes) ran as independent runSql() calls with
 * no transaction around them - a failure partway through left some of a
 * logically-single write committed and the rest not, with no rollback.
 * Checks out ONE client for the whole callback (not the shared pool's
 * round-robin per-query behavior runSql relies on) so BEGIN/COMMIT see the
 * same session; any thrown error - including one the caller's own callback
 * raises - rolls back everything done so far under it, and the client is
 * always released back to the pool.
 */
export async function runWithTransaction<T>(
  work: (runSqlInTransaction: <R = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<R[]>) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();

  try {
    await client.query("begin");

    const result = await work(async (sql, params = []) => {
      const queryResult = await client.query(sql, params);
      return queryResult.rows;
    });

    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
