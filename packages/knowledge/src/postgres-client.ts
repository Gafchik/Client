import { Pool } from "pg";

let pool: Pool | null = null;

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
