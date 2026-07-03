import { forwardRef, Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { ChatEntity } from "../../persistence/chat.entity.js";
import { ProjectEntity } from "../../persistence/project.entity.js";
import { ProviderEntity } from "../../persistence/provider.entity.js";
import { RunEntity } from "../../persistence/run.entity.js";
import { TaskEntity } from "../../persistence/task.entity.js";
import { TeamEntity } from "../../persistence/team.entity.js";
import { ChatsModule } from "../chats/chats.module.js";
import { ProjectsModule } from "../projects/projects.module.js";
import { ProvidersModule } from "../providers/providers.module.js";
import { RunsController } from "./runs.controller.js";
import { RunsService } from "./runs.service.js";
import { TasksModule } from "../tasks/tasks.module.js";
import { TeamsModule } from "../teams/teams.module.js";

@Module({
  imports: [
    TypeOrmModule.forFeature([RunEntity, TeamEntity, ChatEntity, ProjectEntity, ProviderEntity, TaskEntity]),
    TeamsModule,
    ProjectsModule,
    ProvidersModule,
    TasksModule,
    forwardRef(() => ChatsModule),
  ],
  controllers: [RunsController],
  providers: [RunsService],
  exports: [RunsService],
})
export class RunsModule {}
