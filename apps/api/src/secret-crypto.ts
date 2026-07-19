import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const ALGORITHM = "aes-256-gcm";
const VERSION_PREFIX = "v1";
const KEY_DERIVATION_SALT = "client-provider-secrets";

let cachedKey: Buffer | null = null;

/**
 * Ключ шифрования секретов (API-ключи провайдеров) at rest в Neo4j.
 * В проде нужно явно задать CLIENT_SECRET_KEY. Если переменная не задана
 * (типичный случай для локальной разработки), ключ генерируется один раз
 * и персистится в `.client/secret.key` (директория уже в .gitignore) —
 * это не заменяет полноценный secret manager, но исключает ситуацию, когда
 * ключ шифрования лежит в том же дампе/бэкапе, что и зашифрованные данные.
 */
export async function initializeSecretCrypto(appRootPath: string): Promise<void> {
  const envKey = process.env.CLIENT_SECRET_KEY?.trim();

  if (envKey) {
    cachedKey = scryptSync(envKey, KEY_DERIVATION_SALT, 32);
    return;
  }

  const keyFilePath = path.join(appRootPath, ".client", "secret.key");

  try {
    const existing = (await fs.readFile(keyFilePath, "utf8")).trim();

    if (existing) {
      cachedKey = scryptSync(existing, KEY_DERIVATION_SALT, 32);
      return;
    }
  } catch {
    // ключа ещё нет — сгенерируем ниже
  }

  // Loud on purpose (2026-07-19, full-project review fix): this used to be
  // completely silent - if `.client/secret.key` doesn't survive a restart
  // (any deployment where that directory isn't on durable storage), a fresh
  // key gets generated here with zero indication anything happened, every
  // already-encrypted providers.api_key row in Postgres becomes
  // undecryptable (see decryptSecret's own new log below), and the operator
  // just sees every provider silently show no API key with no diagnostic
  // trail connecting the two events. Harmless noise on a genuine first-ever
  // run; the one log line that actually explains a real key-loss incident
  // otherwise.
  console.warn(`[secret-crypto] Generating a NEW encryption key at ${keyFilePath} (none found there). If this is not the very first run of this app, every previously-encrypted secret (provider API keys) will fail to decrypt from now on - restore the old .client/secret.key or CLIENT_SECRET_KEY instead of proceeding, if that data matters.`);
  const generated = randomBytes(32).toString("hex");
  await fs.mkdir(path.dirname(keyFilePath), { recursive: true });
  await fs.writeFile(keyFilePath, generated, { mode: 0o600 });
  cachedKey = scryptSync(generated, KEY_DERIVATION_SALT, 32);
}

function getKey(): Buffer {
  if (!cachedKey) {
    throw new Error("Secret crypto не инициализирован: вызови initializeSecretCrypto() при старте приложения.");
  }

  return cachedKey;
}

export function encryptSecret(plainText: string): string {
  if (!plainText) {
    return "";
  }

  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [VERSION_PREFIX, iv.toString("base64"), authTag.toString("base64"), encrypted.toString("base64")].join(":");
}

/**
 * Расшифровывает значение, сохранённое через `encryptSecret`. Значения,
 * сохранённые до внедрения шифрования (plaintext), не совпадают с форматом
 * `v1:...` и возвращаются как есть — они автоматически станут зашифрованными
 * при следующем сохранении провайдера через `saveProvider`.
 */
export function decryptSecret(payload: string): string {
  if (!payload) {
    return "";
  }

  const parts = payload.split(":");

  if (parts.length !== 4 || parts[0] !== VERSION_PREFIX) {
    return payload;
  }

  const ivB64 = parts[1] ?? "";
  const tagB64 = parts[2] ?? "";
  const dataB64 = parts[3] ?? "";

  try {
    const decipher = createDecipheriv(ALGORITHM, getKey(), Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    const decrypted = Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]);
    return decrypted.toString("utf8");
  } catch (error) {
    // Loud on purpose (2026-07-19, full-project review fix): this used to
    // swallow the failure completely, returning "" indistinguishable from a
    // genuinely-empty secret. A GCM auth-tag failure here almost always
    // means the encryption key changed since this value was written (see
    // initializeSecretCrypto's new log above) - without this, an operator
    // just sees providers silently missing their API key with no way to
    // tell "never set" apart from "undecryptable now".
    console.error("[secret-crypto] Failed to decrypt a stored secret - returning empty. Likely cause: the encryption key changed since this value was saved (see any recent \"Generating a NEW encryption key\" log).", error);
    return "";
  }
}
