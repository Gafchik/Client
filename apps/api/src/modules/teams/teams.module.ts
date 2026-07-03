import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { ProviderEntity } from "../../persistence/provider.entity.js";
import { TeamEntity } from "../../persistence/team.entity.js";
import { ProvidersModule } from "../providers/providers.module.js";
import { TeamsController } from "./teams.controller.js";
import { TeamsService } from "./teams.service.js";

@Module({
  imports: [TypeOrmModule.forFeature([TeamEntity, ProviderEntity]), ProvidersModule],
  controllers: [TeamsController],
  providers: [TeamsService],
  exports: [TeamsService],
})
export class TeamsModule {}
