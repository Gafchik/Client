import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./modules/app.module.js";

async function bootstrap() {
  const logger = new Logger("Bootstrap");
  const app = await NestFactory.create(AppModule, {
    cors: true,
  });

  let closing = false;
  const shutdown = async (signal: NodeJS.Signals) => {
    if (closing) return;
    closing = true;
    logger.log(`Received ${signal}, closing API...`);
    try {
      await app.close();
      logger.log("API closed");
      process.exit(0);
    } catch (error) {
      logger.error(`API shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  const port = Number(process.env.PORT || 3000);
  await app.listen(port, "0.0.0.0");
  logger.log(`API listening on 0.0.0.0:${port}`);
}

void bootstrap();
