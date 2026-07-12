import { randomUUID } from "node:crypto";
import type { ProviderModelRecord, ProviderRecord } from "@client/shared";
import { runQuery } from "./neo4j-client.js";
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

const DEFAULT_RECOMMENDED_MODEL_ID = "anthropic/claude-sonnet-5";

export async function initializeProviderStore(): Promise<void> {
  await runQuery(`create constraint provider_id_unique if not exists for (p:Provider) require p.id is unique`);
  await ensureDefaultProvider();
}

export async function listProviders(): Promise<ProviderRecord[]> {
  const rows = await runQuery<{ provider: Record<string, unknown> }>(`
    match (p:Provider)
    return p { .* } as provider
    order by p.isCurrent desc, p.updatedAt desc
  `);

  return rows.map((row) => mapProviderRow(row.provider));
}

export async function getCurrentProvider(): Promise<ProviderSecretRecord | null> {
  const rows = await runQuery<{ provider: Record<string, unknown> }>(`
    match (p:Provider { isCurrent: true, isActive: true })
    return p { .* } as provider
    order by p.updatedAt desc
    limit 1
  `);

  const row = rows[0];
  return row ? mapProviderSecretRow(row.provider) : null;
}

export async function getProviderById(id: string): Promise<ProviderSecretRecord | null> {
  const rows = await runQuery<{ provider: Record<string, unknown> }>(
    `
      match (p:Provider { id: $id })
      return p { .* } as provider
      limit 1
    `,
    { id },
  );

  const row = rows[0];
  return row ? mapProviderSecretRow(row.provider) : null;
}

export async function saveProvider(input: SaveProviderInput): Promise<ProviderRecord> {
  const nextId = input.id?.trim() || `provider-${randomUUID()}`;
  const shouldBeCurrent = input.isCurrent ?? false;
  const now = new Date().toISOString();

  if (shouldBeCurrent) {
    await runQuery(`match (p:Provider { isCurrent: true }) set p.isCurrent = false, p.updatedAt = $now`, { now });
  }

  // getProviderById уже отдаёт расшифрованный apiKey (см. mapProviderSecretRow),
  // поэтому nextApiKey здесь всегда plaintext — шифруем непосредственно перед записью.
  const existing = await getProviderById(nextId);
  const nextApiKey = input.apiKey.trim() || existing?.apiKey || "";

  await runQuery(
    `
      merge (p:Provider { id: $id })
      on create set p.createdAt = $now
      set
        p.name = $name,
        p.baseUrl = $baseUrl,
        p.apiKey = $apiKey,
        p.isActive = $isActive,
        p.isCurrent = $isCurrent,
        p.updatedAt = $now
    `,
    {
      id: nextId,
      name: input.name.trim(),
      baseUrl: input.baseUrl.trim(),
      apiKey: encryptSecret(nextApiKey),
      isActive: input.isActive ?? true,
      isCurrent: shouldBeCurrent,
      now,
    },
  );

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
  await runQuery(`match (p:Provider { isCurrent: true }) set p.isCurrent = false, p.updatedAt = $now`, { now });
  await runQuery(
    `
      match (p:Provider { id: $id })
      set p.isCurrent = true, p.isActive = true, p.updatedAt = $now
    `,
    { id, now },
  );

  const saved = await getProviderById(id);
  return saved ? stripApiKey(saved) : null;
}

export async function deleteProvider(id: string): Promise<boolean> {
  const existing = await getProviderById(id);

  if (!existing) {
    return false;
  }

  await runQuery(`match (p:Provider { id: $id }) detach delete p`, { id });

  if (existing.isCurrent) {
    const now = new Date().toISOString();
    const fallbackRows = await runQuery<{ id: string }>(
      `
        match (p:Provider { isActive: true })
        return p.id as id
        order by p.updatedAt desc
        limit 1
      `,
    );
    const fallbackId = fallbackRows[0]?.id;

    if (fallbackId) {
      await runQuery(`match (p:Provider { id: $id }) set p.isCurrent = true, p.updatedAt = $now`, {
        id: fallbackId,
        now,
      });
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
  const countRows = await runQuery<{ count: number }>(`match (p:Provider) return count(p) as count`);
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

function mapProviderRow(row: Record<string, unknown>): ProviderRecord {
  const apiKey = decryptSecret(String(row.apiKey ?? ""));

  return {
    id: String(row.id),
    name: String(row.name),
    baseUrl: String(row.baseUrl),
    apiKeyMasked: maskApiKey(apiKey),
    hasApiKey: apiKey.length > 0,
    isActive: Boolean(row.isActive),
    isCurrent: Boolean(row.isCurrent),
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
  };
}

function stripApiKey(record: ProviderSecretRecord): ProviderRecord {
  const { apiKey: _apiKey, ...publicRecord } = record;
  void _apiKey;
  return publicRecord;
}

function mapProviderSecretRow(row: Record<string, unknown>): ProviderSecretRecord {
  const publicRecord = mapProviderRow(row);

  return {
    ...publicRecord,
    apiKey: decryptSecret(String(row.apiKey ?? "")),
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
