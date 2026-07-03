import { forwardRef, Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { ChatEntity } from "../../persistence/chat.entity.js";
import { ProjectEntity } from "../../persistence/project.entity.js";
import { ProviderEntity } from "../../persistence/provider.entity.js";
import { RunEntity } from "../../persistence/run.entity.js";
import { TeamEntity } from "../../persistence/team.entity.js";
import { ChatsModule } from "../chats/chats.module.js";
import { ProjectsModule } from "../projects/projects.module.js";
import { ProvidersModule } from "../providers/providers.module.js";
import { RunsController } from "./runs.controller.js";
import { RunsService } from "./runs.service.js";
import { TeamsModule } from "../teams/teams.module.js";
import { WsModule } from "../ws/ws.module.js";

@Module({
  imports: [
    TypeOrmModule.forFeature([RunEntity, TeamEntity, ChatEntity, ProjectEntity, ProviderEntity]),
    TeamsModule,
    ProjectsModule,
    ProvidersModule,
    forwardRef(() => ChatsModule),
    WsModule,
  ],
  controllers: [RunsController],
  providers: [RunsService],
  exports: [RunsService],
})
export class RunsModule {}