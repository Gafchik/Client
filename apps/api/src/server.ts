import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createApp } from "./app.js";
import { markInFlightRunsInterrupted } from "./pipeline-runner.js";

loadLocalEnv();

const app = createApp();
const port = Number(process.env.PORT ?? 3031);

app
  .listen({
    host: "0.0.0.0",
    port,
  })
  .catch((error) => {
    app.log.error(error);
    process.exit(1);
  });

// Долгий research/graph/index на большом репозитории — это синхронный,
// неразрывный JS-стек: пока он не отдаст управление обратно event loop'у,
// процесс физически не может обработать даже штатный SIGINT (Ctrl+C) —
// сигнал доставляется, но колбэк не выполнится, пока не освободится стек.
// Поэтому Ctrl+C во время "долго думает" мог не срабатывать вообще без
// какой-либо обратной связи. Явный обработчик + жёсткий таймаут гарантируют,
// что как только процесс СМОЖЕТ обработать сигнал, он гарантированно
// завершится за ограниченное время — а не зависнет ещё на неопределённый
// срок из-за повисшего cleanup-шага.
const SHUTDOWN_HARD_TIMEOUT_MS = 4000;
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  app.log.info(`Получен ${signal}, завершаю работу (до ${SHUTDOWN_HARD_TIMEOUT_MS}мс на graceful shutdown)...`);

  const forceExitTimer = setTimeout(() => {
    app.log.warn("Graceful shutdown не уложился в таймаут, принудительно завершаю процесс.");
    process.exit(1);
  }, SHUTDOWN_HARD_TIMEOUT_MS);

  try {
    // Помечаем то, что этот процесс ещё отслеживает как running/queued,
    // прерванным сразу — не дожидаясь bootstrap следующего запуска API.
    await markInFlightRunsInterrupted();
    // Триггерит Fastify onClose hook: останавливает project state monitor,
    // закрывает Neo4j driver и Postgres pool (см. app.ts).
    await app.close();
    process.exit(0);
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  } finally {
    clearTimeout(forceExitTimer);
  }
}

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});
process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

function loadLocalEnv(): void {
  const envCandidates = [
    path.resolve(process.cwd(), ".env"),
    path.resolve(process.cwd(), "..", ".env"),
    path.resolve(process.cwd(), "..", "..", ".env"),
  ];

  for (const envPath of envCandidates) {
    if (!existsSync(envPath)) {
      continue;
    }

    const content = readFileSync(envPath, "utf8");

    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();

      if (!line || line.startsWith("#")) {
        continue;
      }

      const separatorIndex = line.indexOf("=");

      if (separatorIndex <= 0) {
        continue;
      }

      const key = line.slice(0, separatorIndex).trim();
      const value = line.slice(separatorIndex + 1).trim().replace(/^['"]|['"]$/g, "");

      if (!key) {
        continue;
      }

      process.env[key] = value;
    }

    return;
  }
}
