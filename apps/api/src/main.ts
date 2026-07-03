import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./modules/app.module.js";

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    cors: true,
  });

  app.setGlobalPrefix("api");

  const port = Number(process.env.PORT || 3000);
  await app.listen(port, "0.0.0.0");
}

bootstrap();
