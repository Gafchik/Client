import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { ProjectMemoryEntryEntity } from "../../persistence/project-memory.entity.js";
import { ProjectEntity } from "../../persistence/project.entity.js";
import { TeamEntity } from "../../persistence/team.entity.js";
import { ChatEntity } from "../../persistence/chat.entity.js";
import { MessageEntity } from "../../persistence/message.entity.js";
import { RunEntity } from "../../persistence/run.entity.js";
import { TaskEntity } from "../../persistence/task.entity.js";
import { TaskCommentEntity } from "../../persistence/task-comment.entity.js";
import { ProjectsController } from "./projects.controller.js";
import { ProjectsService } from "./projects.service.js";

@Module({
  imports: [TypeOrmModule.forFeature([ProjectEntity, ProjectMemoryEntryEntity, TeamEntity, ChatEntity, MessageEntity, RunEntity, TaskEntity, TaskCommentEntity])],
  controllers: [ProjectsController],
  providers: [ProjectsService],
  exports: [ProjectsService],
})
export class ProjectsModule {}
