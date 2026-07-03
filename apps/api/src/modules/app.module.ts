import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { TypeOrmModule } from "@nestjs/typeorm";
import { ChatEntity } from "../persistence/chat.entity.js";
import { MessageEntity } from "../persistence/message.entity.js";
import { ProjectEntity } from "../persistence/project.entity.js";
import { ProviderEntity } from "../persistence/provider.entity.js";
import { TeamEntity } from "../persistence/team.entity.js";
import { RunEntity } from "../persistence/run.entity.js";
import { ChatsModule } from "./chats/chats.module.js";
import { TeamsModule } from "./teams/teams.module.js";
import { RunsModule } from "./runs/runs.module.js";
import { CatalogModule } from "./catalog/catalog.module.js";
import { HealthModule } from "./health/health.module.js";
import { ProjectsModule } from "./projects/projects.module.js";
import { ProvidersModule } from "./providers/providers.module.js";
import { SettingsModule } from "./settings/settings.module.js";
import { TaskEntity } from "../persistence/task.entity.js";
import { TasksModule } from "./tasks/tasks.module.js";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ".env",
    }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        type: "postgres",
        host: configService.get<string>("DATABASE_HOST", "db"),
        port: configService.get<number>("DATABASE_PORT", 5432),
        username: configService.get<string>("DATABASE_USER", "postgres"),
        password: configService.get<string>("DATABASE_PASSWORD", "postgres"),
        database: configService.get<string>("DATABASE_NAME", "ai_agent_team"),
        entities: [ProviderEntity, ProjectEntity, ChatEntity, MessageEntity, TeamEntity, RunEntity, TaskEntity],
        synchronize: true,
      }),
    }),
    ProvidersModule,
    ProjectsModule,
    ChatsModule,
    TeamsModule,
    RunsModule,
    CatalogModule,
    HealthModule,
    SettingsModule,
    TasksModule,
  ],
})
export class AppModule {}
