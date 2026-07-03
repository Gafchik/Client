import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { ProjectMemoryEntryEntity } from "../../persistence/project-memory.entity.js";
import { ProjectEntity } from "../../persistence/project.entity.js";
import { TeamEntity } from "../../persistence/team.entity.js";
import { ProjectsController } from "./projects.controller.js";
import { ProjectsService } from "./projects.service.js";

@Module({
  imports: [TypeOrmModule.forFeature([ProjectEntity, ProjectMemoryEntryEntity, TeamEntity])],
  controllers: [ProjectsController],
  providers: [ProjectsService],
  exports: [ProjectsService],
})
export class ProjectsModule {}
