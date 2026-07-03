import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { ProjectEntity } from "../../persistence/project.entity.js";
import { TaskCommentEntity } from "../../persistence/task-comment.entity.js";
import { TaskEntity } from "../../persistence/task.entity.js";
import { TasksController } from "./tasks.controller.js";
import { TasksService } from "./tasks.service.js";

@Module({
  imports: [TypeOrmModule.forFeature([TaskEntity, TaskCommentEntity, ProjectEntity])],
  controllers: [TasksController],
  providers: [TasksService],
  exports: [TasksService],
})
export class TasksModule {}
