import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createApp } from "./app.js";

loadLocalEnv();

const app = createApp();
const port = Number(process.env.PORT ?? 3001);

app
  .listen({
    host: "0.0.0.0",
    port,
  })
  .catch((error) => {
    app.log.error(error);
    process.exit(1);
  });

function loadLocalEnv(): void {
  const envPath = path.resolve(process.cwd(), ".env");

  if (!existsSync(envPath)) {
    return;
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
}
