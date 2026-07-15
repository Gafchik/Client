import { Redis } from "ioredis";

let client: Redis | null = null;

export function getRedisClient(): Redis {
  if (!client) {
    const url = process.env.REDIS_URL?.trim();

    client = url
      ? new Redis(url)
      : new Redis({
          host: process.env.REDIS_HOST?.trim() || "127.0.0.1",
          port: Number(process.env.REDIS_PORT ?? 6380),
          maxRetriesPerRequest: 3,
        });

    // Same reasoning as postgres-client.ts's Pool 'error' handler - without
    // this, a dropped connection (Redis container restarted/stopped) becomes
    // an unhandled 'error' event and crashes the whole API process.
    client.on("error", (error: Error) => {
      console.warn("[redis] connection error (соединение восстановится само):", error);
    });
  }

  return client;
}

export async function closeRedisClient(): Promise<void> {
  if (!client) {
    return;
  }

  await client.quit();
  client = null;
}

export async function verifyRedisConnectivity(): Promise<boolean> {
  try {
    await getRedisClient().ping();
    return true;
  } catch {
    return false;
  }
}
