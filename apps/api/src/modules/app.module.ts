import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { TypeOrmModule } from "@nestjs/typeorm";
import { ChatEntity } from "../persistence/chat.entity.js";
import { MessageEntity } from "../persistence/message.entity.js";
import { ProjectEntity } from "../persistence/project.entity.js";
import { ProjectMemoryEntryEntity } from "../persistence/project-memory.entity.js";
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
import { WsModule } from "./ws/ws.module.js";

@Module({
  imports: [
    // envFilePath массивом: при запуске из корня (npm run start) CWD=root
    // и `.env` найдётся; при `npm run -w apps/api` CWD=apps/api и нужен
    // `../../.env` (корень монорепо). Берётся первый существующий файл.
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [".env", "../../.env", "../.env"],
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
        entities: [ProviderEntity, ProjectEntity, ProjectMemoryEntryEntity, ChatEntity, MessageEntity, TeamEntity, RunEntity],
        synchronize: true,
        // Страховка от race: если API стартует раньше, чем Postgres в Docker
        // стал healthy, TypeOrm сам подождёт и переподключится вместо падения.
        retryAttempts: 15,
        retryDelay: 2000,
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
    WsModule,
  ],
})
export class AppModule {}