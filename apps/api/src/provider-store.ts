import { randomUUID } from "node:crypto";
import type { ProviderModelRecord, ProviderRecord } from "@client/shared";
import { runSql, withTransaction } from "./postgres-client.js";
import { decryptSecret, encryptSecret } from "./secret-crypto.js";

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

// nvidia/nemotron-3-ultra бесплатна (см. docs/architecture/009-model-catalog-and-role-profiles.md,
// price band Micro 0.0x) — разумный дефолт для тестов, не требует платного провайдера "из коробки".
const DEFAULT_RECOMMENDED_MODEL_ID = "nvidia/nemotron-3-ultra";

interface ProviderRow {
  id: string;
  name: string;
  base_url: string;
  api_key: string;
  is_active: boolean;
  is_current: boolean;
  created_at: Date;
  updated_at: Date;
}

export async function initializeProviderStore(): Promise<void> {
  // Таблица создаётся централизованно в initializePostgresSchema() (postgres-client.ts).
  await ensureDefaultProvider();
}

export async function listProviders(): Promise<ProviderRecord[]> {
  const rows = await runSql<ProviderRow>(
    `select * from providers order by is_current desc, updated_at desc`,
  );

  return rows.map((row) => mapProviderRow(row));
}

export async function getCurrentProvider(): Promise<ProviderSecretRecord | null> {
  const rows = await runSql<ProviderRow>(
    `select * from providers where is_current = true and is_active = true order by updated_at desc limit 1`,
  );

  const row = rows[0];
  return row ? mapProviderSecretRow(row) : null;
}

export async function getProviderById(id: string): Promise<ProviderSecretRecord | null> {
  const rows = await runSql<ProviderRow>(`select * from providers where id = $1 limit 1`, [id]);
  const row = rows[0];
  return row ? mapProviderSecretRow(row) : null;
}

export async function saveProvider(input: SaveProviderInput): Promise<ProviderRecord> {
  const nextId = input.id?.trim() || `provider-${randomUUID()}`;
  const shouldBeCurrent = input.isCurrent ?? false;
  const now = new Date().toISOString();

  // getProviderById уже отдаёт расшифрованный apiKey (см. mapProviderSecretRow),
  // поэтому nextApiKey здесь всегда plaintext — шифруем непосредственно перед записью.
  const existing = await getProviderById(nextId);
  const nextApiKey = input.apiKey.trim() || existing?.apiKey || "";

  await withTransaction(async (client) => {
    if (shouldBeCurrent) {
      await client.query(`update providers set is_current = false, updated_at = $1 where is_current = true`, [now]);
    }

    await client.query(
      `
        insert into providers (id, name, base_url, api_key, is_active, is_current, created_at, updated_at)
        values ($1, $2, $3, $4, $5, $6, $7, $7)
        on conflict (id) do update set
          name = $2,
          base_url = $3,
          api_key = $4,
          is_active = $5,
          is_current = $6,
          updated_at = $7
      `,
      [nextId, input.name.trim(), input.baseUrl.trim(), encryptSecret(nextApiKey), input.isActive ?? true, shouldBeCurrent, now],
    );
  });

  const saved = await getProviderById(nextId);

  if (!saved) {
    throw new Error("Не удалось загрузить провайдера после сохранения.");
  }

  return stripApiKey(saved);
}

export async function setCurrentProvider(id: string): Promise<ProviderRecord | null> {
  const existing = await getProviderById(id);

  if (!existing) {
    return null;
  }

  const now = new Date().toISOString();

  await withTransaction(async (client) => {
    await client.query(`update providers set is_current = false, updated_at = $1 where is_current = true`, [now]);
    await client.query(`update providers set is_current = true, is_active = true, updated_at = $1 where id = $2`, [
      now,
      id,
    ]);
  });

  const saved = await getProviderById(id);
  return saved ? stripApiKey(saved) : null;
}

export async function deleteProvider(id: string): Promise<boolean> {
  const existing = await getProviderById(id);

  if (!existing) {
    return false;
  }

  await runSql(`delete from providers where id = $1`, [id]);

  if (existing.isCurrent) {
    const now = new Date().toISOString();
    const fallbackRows = await runSql<{ id: string }>(
      `select id from providers where is_active = true order by updated_at desc limit 1`,
    );
    const fallbackId = fallbackRows[0]?.id;

    if (fallbackId) {
      await runSql(`update providers set is_current = true, updated_at = $1 where id = $2`, [now, fallbackId]);
    } else {
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
      recommendedModelId: DEFAULT_RECOMMENDED_MODEL_ID,
    };
  }

  if (!provider.apiKey.trim()) {
    return {
      models: buildFallbackModels(provider.id),
      recommendedModelId: DEFAULT_RECOMMENDED_MODEL_ID,
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
        recommendedModelId: DEFAULT_RECOMMENDED_MODEL_ID,
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
        ...(id === DEFAULT_RECOMMENDED_MODEL_ID ? { isDefault: true } : {}),
      });
    }

    return {
      models: models.length ? models : buildFallbackModels(provider.id),
      recommendedModelId: models.some((item) => item.id === DEFAULT_RECOMMENDED_MODEL_ID)
        ? DEFAULT_RECOMMENDED_MODEL_ID
        : models[0]?.id ?? DEFAULT_RECOMMENDED_MODEL_ID,
    };
  } catch {
    return {
      models: buildFallbackModels(provider.id),
      recommendedModelId: DEFAULT_RECOMMENDED_MODEL_ID,
    };
  }
}

async function ensureDefaultProvider(): Promise<void> {
  const countRows = await runSql<{ count: string }>(`select count(*)::text as count from providers`);
  const count = Number(countRows[0]?.count ?? 0);

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

function mapProviderRow(row: ProviderRow): ProviderRecord {
  const apiKey = decryptSecret(row.api_key ?? "");

  return {
    id: row.id,
    name: row.name,
    baseUrl: row.base_url,
    apiKeyMasked: maskApiKey(apiKey),
    hasApiKey: apiKey.length > 0,
    isActive: Boolean(row.is_active),
    isCurrent: Boolean(row.is_current),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function stripApiKey(record: ProviderSecretRecord): ProviderRecord {
  const { apiKey: _apiKey, ...publicRecord } = record;
  void _apiKey;
  return publicRecord;
}

function mapProviderSecretRow(row: ProviderRow): ProviderSecretRecord {
  const publicRecord = mapProviderRow(row);

  return {
    ...publicRecord,
    apiKey: decryptSecret(row.api_key ?? ""),
  };
}

function buildFallbackModels(providerId: string): ProviderModelRecord[] {
  return [
    {
      id: DEFAULT_RECOMMENDED_MODEL_ID,
      label: DEFAULT_RECOMMENDED_MODEL_ID,
      providerId,
      isDefault: true,
    },
    {
      id: "openai/gpt-5.4",
      label: "openai/gpt-5.4",
      providerId,
    },
    {
      id: "deepseek/deepseek-chat-v3.1",
      label: "deepseek/deepseek-chat-v3.1",
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
