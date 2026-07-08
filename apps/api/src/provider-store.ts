import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import type { ProviderModelRecord, ProviderRecord } from "@client/shared";

export interface ProviderSecretRecord extends ProviderRecord {
  apiKey: string;
}

export interface SaveProviderInput {
  id?: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  isActive?: boolean;
  isCurrent?: boolean;
}

export interface ProviderCatalog {
  models: ProviderModelRecord[];
  recommendedModelId: string;
}

let pool: Pool | null = null;
let initialized = false;

export async function initializeProviderStore(): Promise<void> {
  const databasePool = getPool();

  if (!initialized) {
    await databasePool.query(`
      create table if not exists providers (
        id text primary key,
        name text not null,
        base_url text not null,
        api_key text not null default '',
        is_active boolean not null default true,
        is_current boolean not null default false,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )
    `);
    await databasePool.query(`alter table providers drop column if exists model`);
    initialized = true;
  }

  await ensureDefaultProvider();
}

export async function listProviders(): Promise<ProviderRecord[]> {
  const result = await getPool().query(
    `
      select id, name, base_url, api_key, is_active, is_current, created_at, updated_at
      from providers
      order by is_current desc, updated_at desc
    `,
  );

  return result.rows.map(mapProviderRow);
}

export async function getCurrentProvider(): Promise<ProviderSecretRecord | null> {
  const result = await getPool().query(
    `
      select id, name, base_url, api_key, is_active, is_current, created_at, updated_at
      from providers
      where is_current = true and is_active = true
      order by updated_at desc
      limit 1
    `,
  );

  if (result.rowCount === 0) {
    return null;
  }

  return mapProviderSecretRow(result.rows[0]);
}

export async function getProviderById(id: string): Promise<ProviderSecretRecord | null> {
  const result = await getPool().query(
    `
      select id, name, base_url, api_key, is_active, is_current, created_at, updated_at
      from providers
      where id = $1
      limit 1
    `,
    [id],
  );

  if (result.rowCount === 0) {
    return null;
  }

  return mapProviderSecretRow(result.rows[0]);
}

export async function saveProvider(input: SaveProviderInput): Promise<ProviderRecord> {
  const nextId = input.id?.trim() || `provider-${randomUUID()}`;
  const shouldBeCurrent = input.isCurrent ?? false;

  if (shouldBeCurrent) {
    await getPool().query(`update providers set is_current = false, updated_at = now() where is_current = true`);
  }

  const result = await getPool().query(
    `
      insert into providers (id, name, base_url, api_key, is_active, is_current)
      values ($1, $2, $3, $4, $5, $6)
      on conflict (id)
      do update set
        name = excluded.name,
        base_url = excluded.base_url,
        api_key = case
          when excluded.api_key <> '' then excluded.api_key
          else providers.api_key
        end,
        is_active = excluded.is_active,
        is_current = excluded.is_current,
        updated_at = now()
      returning id, name, base_url, api_key, is_active, is_current, created_at, updated_at
    `,
    [
      nextId,
      input.name.trim(),
      input.baseUrl.trim(),
      input.apiKey.trim(),
      input.isActive ?? true,
      shouldBeCurrent,
    ],
  );

  return mapProviderRow(result.rows[0]);
}

export async function setCurrentProvider(id: string): Promise<ProviderRecord | null> {
  const existing = await getProviderById(id);

  if (!existing) {
    return null;
  }

  await getPool().query(`update providers set is_current = false, updated_at = now() where is_current = true`);
  const result = await getPool().query(
    `
      update providers
      set is_current = true, is_active = true, updated_at = now()
      where id = $1
      returning id, name, base_url, api_key, is_active, is_current, created_at, updated_at
    `,
    [id],
  );

  return mapProviderRow(result.rows[0]);
}

export async function deleteProvider(id: string): Promise<boolean> {
  const existing = await getProviderById(id);

  if (!existing) {
    return false;
  }

  await getPool().query(`delete from providers where id = $1`, [id]);

  if (existing.isCurrent) {
    const fallback = await getPool().query(
      `
        update providers
        set is_current = true, updated_at = now()
        where id = (
          select id from providers
          where is_active = true
          order by updated_at desc
          limit 1
        )
        returning id
      `,
    );

    if (fallback.rowCount === 0) {
      await ensureDefaultProvider();
    }
  }

  return true;
}

export async function fetchProviderModels(providerId?: string): Promise<ProviderCatalog> {
  const provider = providerId ? await getProviderById(providerId) : await getCurrentProvider();

  if (!provider) {
    return {
      models: [],
      recommendedModelId: "nvidia/nemotron-3-ultra",
    };
  }

  if (!provider.apiKey.trim()) {
    return {
      models: buildFallbackModels(provider.id),
      recommendedModelId: "nvidia/nemotron-3-ultra",
    };
  }

  const endpoint = `${provider.baseUrl.replace(/\/$/, "")}/models`;

  try {
    const response = await fetch(endpoint, {
      headers: {
        Authorization: `Bearer ${provider.apiKey}`,
      },
    });

    if (!response.ok) {
      return {
        models: buildFallbackModels(provider.id),
        recommendedModelId: "nvidia/nemotron-3-ultra",
      };
    }

    const payload = (await response.json()) as {
      data?: Array<{ id?: string; name?: string }>;
      models?: Array<{ id?: string; name?: string }>;
    };
    const sourceList = payload.data ?? payload.models ?? [];
    const models: ProviderModelRecord[] = [];

    for (const item of sourceList) {
      const id = typeof item.id === "string" ? item.id : "";

      if (!id) {
        continue;
      }

      models.push({
        id,
        label: typeof item.name === "string" && item.name.trim() ? item.name : id,
        providerId: provider.id,
        ...(id === "nvidia/nemotron-3-ultra" ? { isDefault: true } : {}),
      });
    }

    return {
      models: models.length ? models : buildFallbackModels(provider.id),
      recommendedModelId: models.some((item) => item.id === "nvidia/nemotron-3-ultra")
        ? "nvidia/nemotron-3-ultra"
        : models[0]?.id ?? "nvidia/nemotron-3-ultra",
    };
  } catch {
    return {
      models: buildFallbackModels(provider.id),
      recommendedModelId: "nvidia/nemotron-3-ultra",
    };
  }
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

async function ensureDefaultProvider(): Promise<void> {
  const countResult = await getPool().query(`select count(*)::int as count from providers`);
  const count = Number(countResult.rows[0]?.count ?? 0);

  if (count > 0) {
    return;
  }

  await saveProvider({
    id: "provider-routmy-primary",
    name: "rout.my",
    baseUrl: process.env.CLIENT_PROVIDER_BASE_URL?.trim() || "https://api.rout.my/v1",
    apiKey: process.env.CLIENT_PROVIDER_API_KEY?.trim() || "",
    isActive: true,
    isCurrent: true,
  });
}

function mapProviderRow(row: Record<string, unknown>): ProviderRecord {
  const apiKey = String(row.api_key ?? "");

  return {
    id: String(row.id),
    name: String(row.name),
    baseUrl: String(row.base_url),
    apiKeyMasked: maskApiKey(apiKey),
    hasApiKey: apiKey.length > 0,
    isActive: Boolean(row.is_active),
    isCurrent: Boolean(row.is_current),
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
  };
}

function mapProviderSecretRow(row: Record<string, unknown>): ProviderSecretRecord {
  const publicRecord = mapProviderRow(row);

  return {
    ...publicRecord,
    apiKey: String(row.api_key ?? ""),
  };
}

function buildFallbackModels(providerId: string): ProviderModelRecord[] {
  return [
    {
      id: "nvidia/nemotron-3-ultra",
      label: "nvidia/nemotron-3-ultra",
      providerId,
      isDefault: true,
    },
    {
      id: "deepseek/deepseek-v4-pro",
      label: "deepseek/deepseek-v4-pro",
      providerId,
    },
    {
      id: "openai/gpt-5.4",
      label: "openai/gpt-5.4",
      providerId,
    },
  ];
}

function maskApiKey(value: string): string {
  const trimmed = value.trim();

  if (!trimmed) {
    return "";
  }

  if (trimmed.length <= 8) {
    return "*".repeat(trimmed.length);
  }

  return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}
