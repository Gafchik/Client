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

    // Same reasoning as apps/api's redis-client.ts / postgres-client.ts Pool
    // 'error' handler - without this, a dropped connection becomes an
    // unhandled 'error' event and crashes the whole process.
    client.on("error", (error: Error) => {
      console.warn("[knowledge/redis] connection error (соединение восстановится само):", error);
    });
  }

  return client;
}
