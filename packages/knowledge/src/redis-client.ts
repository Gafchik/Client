import { Redis } from "ioredis";

let client: Redis | null = null;
let usingInjectedClient = false;

/** Same duplicate-connection fix as postgres-client.ts's setSharedPool - see that comment. apps/api calls this once at boot with its own Redis client. */
export function setSharedRedisClient(sharedClient: Redis): void {
  client = sharedClient;
  usingInjectedClient = true;
}

/** Companion to apps/api's closeRedisClient. */
export function clearSharedRedisClient(): void {
  if (usingInjectedClient) {
    client = null;
    usingInjectedClient = false;
  }
}

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
