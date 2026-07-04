import { forwardRef, Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { ChatEntity } from "../../persistence/chat.entity.js";
import { MessageEntity } from "../../persistence/message.entity.js";
import { ProjectEntity } from "../../persistence/project.entity.js";
import { ProjectMemoryEntryEntity } from "../../persistence/project-memory.entity.js";
import { RunEntity } from "../../persistence/run.entity.js";
import { TeamEntity } from "../../persistence/team.entity.js";
import { ChatsController } from "./chats.controller.js";
import { ChatsService } from "./chats.service.js";
import { RunsModule } from "../runs/runs.module.js";
import { TeamsModule } from "../teams/teams.module.js";
import { ProvidersModule } from "../providers/providers.module.js";
import { WsModule } from "../ws/ws.module.js";

@Module({
  imports: [
    TypeOrmModule.forFeature([ChatEntity, MessageEntity, ProjectEntity, ProjectMemoryEntryEntity, TeamEntity, RunEntity]),
    TeamsModule,
    ProvidersModule,
    forwardRef(() => RunsModule),
    WsModule,
  ],
  controllers: [ChatsController],
  providers: [ChatsService],
  exports: [ChatsService],
})
export class ChatsModule {}
