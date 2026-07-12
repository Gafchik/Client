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
  }

  return pool;
}

export async function runSql<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const result = await getPool().query(sql, params);
  return result.rows as T[];
}
