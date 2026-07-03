import { Module } from "@nestjs/common";
import { ProvidersModule } from "../providers/providers.module.js";
import { CatalogController } from "./catalog.controller.js";

@Module({
  imports: [ProvidersModule],
  controllers: [CatalogController],
})
export class CatalogModule {}
