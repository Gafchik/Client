# Архитектура AI Agent Team

## Обзор

AI Agent Team — это монорепо (Nx-style структура) с двумя основными приложениями:
- **apps/api** — NestJS бэкенд (REST API + WebSocket)
- **apps/web** — Vue 3 + Vite SPA фронтенд

База данных: PostgreSQL с TypeORM. Запуск через Docker Compose.

---

## Структура монорепо

```
.
├── apps/
│   ├── api/                 # NestJS приложение
│   │   ├── src/
│   │   │   ├── main.ts      # Bootstrap, глобальные пайпы, CORS
│   │   │   ├── app.module.ts
│   │   │   ├── modules/     # Фичевые модули
│   │   │   │   ├── chats/
│   │   │   │   ├── projects/
│   │   │   │   ├── providers/
│   │   │   │   ├── runs/
│   │   │   │   ├── teams/
│   │   │   │   ├── catalog/
│   │   │   │   ├── health/
│   │   │   │   ├── settings/
│   │   │   │   └── ws/
│   │   │   ├── persistence/ # TypeORM сущности
│   │   │   │   ├── chat.entity.ts
│   │   │   │   ├── message.entity.ts
│   │   │   │   ├── project.entity.ts
│   │   │   │   ├── project-memory.entity.ts
│   │   │   │   ├── provider.entity.ts
│   │   │   │   ├── run.entity.ts
│   │   │   │   └── team.entity.ts
│   │   │   └── shared/      # Утилиты (json, logger, etc.)
│   │   └── Dockerfile
│   └── web/                 # Vue 3 + Vite приложение
│       ├── src/
│       │   ├── main.ts
│       │   ├── App.vue
│       │   ├── router/
│       │   ├── views/       # Страницы (Dashboard, Workspace, Teams, etc.)
│       │   ├── components/  # UI компоненты
│       │   ├── api.ts       # API клиент
│       │   ├── types.ts     # TypeScript типы (DTO)
│       │   └── stores/      # Pinia stores
│       └── Dockerfile
├── storage/                 # Артефакты запусков (файловая система)
├── workspace/               # Монтируемые проекты для работы агентов
├── docker-compose.yml
└── .env.example
```

---

## NestJS модули (apps/api/src/modules)

| Модуль | Ответственность | Ключевые сервисы/контроллеры |
|--------|-----------------|------------------------------|
| **chats** | Чаты, сообщения, история, стриминг токенов | `ChatsController`, `ChatsService` |
| **projects** | Проекты, память проекта | `ProjectsController`, `ProjectsService` |
| **providers** | LLM провайдеры (OpenAI-совместимые) | `ProvidersController`, `ProvidersService` |
| **runs** | Запуски пайплайнов агентов, оркестрация | `RunsController`, `RunsService` (81KB!) |
| **teams** | Команды агентов, конфигурация ролей | `TeamsController`, `TeamsService` |
| **catalog** | Каталог моделей от провайдеров | `CatalogController`, `CatalogService` |
| **health** | Health check эндпоинт | `HealthController` |
| **settings** | Настройки окружения (paths) | `SettingsController` |
| **ws** | WebSocket gateway для real-time | `WsGateway` |

### Паттерны

- **Module-per-feature**: каждый домен — отдельный модуль с контроллером, сервисом, DTO, сущностями
- **Repository pattern**: через `@InjectRepository(Entity)` + `Repository<Entity>` от TypeORM
- **Service layer**: бизнес-логика в сервисах, контроллеры тонкие
- **DTO**: валидация через `class-validator` (`SaveChatDto`, `StartRunDto`, etc.)
- **ForwardRef**: для циклических зависимостей (ChatsService ↔ RunsService)
- **WebSocket Gateway**: `WsGateway` с `@SubscribeMessage` для событий

---

## TypeORM сущности (apps/api/src/persistence)

### ChatEntity (`chats`)
```typescript
id: string (PK)
projectId: string (FK → projects)
teamId: string (FK → teams)
title: string
summary: text
isActive: boolean
createdAt: Date
updatedAt: Date
// Relations (EAGER по умолчанию — ПРОБЛЕМА!):
project: ProjectEntity @ManyToOne
team: TeamEntity @ManyToOne
messages: MessageEntity[] @OneToMany
runs: RunEntity[] @OneToMany
```

### MessageEntity (`messages`)
```typescript
id: string (PK)
chatId: string (FK → chats)
role: string (user/assistant/orchestrator/analyst/developer/tester)
content: text
meta: jsonb (usage, runId, type, etc.)
createdAt: Date
chat: ChatEntity @ManyToOne
```

### ProjectEntity (`projects`)
```typescript
id: string (PK)
name: string
description: text
localPath: string (путь на хосте)
containerPath: string (путь в контейнере)
teamId: string (FK → teams, nullable)
isActive: boolean
createdAt: Date
updatedAt: Date
chats: ChatEntity[] @OneToMany
memory: ProjectMemoryEntity[] @OneToMany
```

### ProjectMemoryEntity (`project_memory`)
```typescript
id: string (PK)
projectId: string (FK → projects)
title: string
summary: text
details: text
kind: string (decision/pattern/gotcha/etc.)
tags: string[]
relatedFiles: string[]
sourceRunId: string (nullable)
createdAt: Date
updatedAt: Date
project: ProjectEntity @ManyToOne
```

### ProviderEntity (`providers`)
```typescript
id: string (PK)
name: string
baseUrl: string
apiKey: string (encrypted в будущем)
modelsUrl: string
isActive: boolean
isCurrent: boolean
createdAt: Date
updatedAt: Date
teams: TeamEntity[] @OneToMany
```

### TeamEntity (`teams`)
```typescript
id: string (PK)
name: string
description: text
providerId: string (FK → providers, nullable)
config: jsonb (TeamConfig: language, budget, workspace, run, testing, agents)
createdAt: Date
updatedAt: Date
provider: ProviderEntity @ManyToOne
chats: ChatEntity[] @OneToMany
runs: RunEntity[] @OneToMany
```

### RunEntity (`runs`)
```typescript
id: string (PK, uuid)
chatId: string (FK → chats, nullable)
teamId: string (FK → teams)
teamName: string (denormalized)
projectId: string (FK → projects, nullable)
projectPath: string
task: text
status: string (queued/running/completed/failed)
startedAt: Date
finishedAt: Date (nullable)
error: text (nullable)
events: jsonb[] (timeline событий для поллинга)
finalReport: jsonb (итоговый отчет)
runDir: string (путь к артефактам в storage/)
retryCount: number
createdAt: Date
updatedAt: Date
chat: ChatEntity @ManyToOne
team: TeamEntity @ManyToOne
project: ProjectEntity @ManyToOne
```

---

## Связи между модулями

```
Team (1) ─────< (N) Chat
Team (1) ─────< (N) Run
Team (N) ─────> (1) Provider
Project (1) ────< (N) Chat
Project (1) ────< (N) Run
Project (1) ────< (N) ProjectMemory
Chat (1) ──────< (N) Message
Chat (1) ──────< (N) Run
Run (N) ───────> (1) Chat (nullable)
Run (N) ───────> (1) Team
Run (N) ───────> (1) Project (nullable)
```

---

## WebSocket Gateway (apps/api/src/modules/ws/ws.gateway.ts)

### Подключение
- Path: `/ws/socket.io`
- CORS: `origin: "*"`
- Auth: JWT токен в `handshake.auth.token` или `handshake.query.token`

### Комнаты (Rooms)
- `chat:{chatId}` — чат-комната для стриминга токенов и активности агентов
- `project:{projectId}` — проектная комната (пока не используется активно)

### Клиентские события (SubscribeMessage)
| Событие | Payload | Описание |
|---------|---------|----------|
| `join:chat` | `{ chatId: string }` | Войти в комнату чата |
| `join:project` | `{ projectId: string }` | Войти в комнату проекта |
| `leave:chat` | `{ chatId: string }` | Выйти из комнаты чата |
| `leave:project` | `{ projectId: string }` | Выйти из комнаты проекта |

### Серверные события (emit)
| Событие | Payload | Описание |
|---------|---------|----------|
| `token:stream` | `{ role, content, done, usage? }` | Стриминг токенов от LLM |
| `agent:activity` | `{ role, agentName, label, status, detail }` | Активность агента (working/idle/done/error) |
| `run:event` | `{ runId, event, data, timestamp }` | Событие запуска (для поллинга) |

### Методы WsGateway
- `broadcastToChat(chatId, event, data)` — эмит в комнату чата
- `broadcastToProject(projectId, event, data)` — эмит в комнату проекта
- `broadcastRunEvent(runId, chatId, event, data)` — событие запуска
- `broadcastTokenStream(chatId, data)` — стриминг токенов
- `broadcastAgentActivity(chatId, data)` — активность агента

---

## Известные проблемы и технический долг

### 1. Eager Loading в ChatEntity (КРИТИЧНО)
**Файл:** `apps/api/src/persistence/chat.entity.ts`

Все `@ManyToOne` и `@OneToMany` отношения загружаются **eager** по умолчанию (TypeORM eager=true по умолчанию для `@ManyToOne` без `lazy: true`).

```typescript
@ManyToOne(() => ProjectEntity, (project) => project.chats, { onDelete: "CASCADE" })
@JoinColumn({ name: "projectId" })
project!: ProjectEntity;  // EAGER!

@OneToMany(() => MessageEntity, (message) => message.chat)
messages!: MessageEntity[];  // EAGER!
```

**Последствия:**
- `chatsRepository.find()` подтягивает ВСЕ сообщения, проект, команду, запуски для КАЖДОГО чата
- N+1 проблемы при листинге чатов
- Огромное потребление памяти при больших чатах

**Решение:** Добавить `lazy: true` к отношениям или использовать QueryBuilder с явными `leftJoinAndSelect` только где нужно.

### 2. Огромный RunsService (81KB, ~2000 строк)
**Файл:** `apps/api/src/modules/runs/runs.service.ts`

Сервис содержит:
- Оркестрацию всего пайплайна (orchestrator → analyst → developer → tester → reviewer)
- LLM вызовы (fetch к провайдерам)
- Файловую систему (чтение/запись артефактов)
- Git операции
- Парсинг ответов агентов
- WebSocket уведомления
- Retry логику
- Recovery зомби-ранов

**Проблемы:**
- Нарушение Single Responsibility Principle
- Сложно тестировать, отлаживать, ревьюить
- Высокая когнитивная нагрузка

**Предлагаемое разделение:**
- `RunExecutor` — запуск шагов пайплайна
- `RunLogger` — логирование событий, запись в БД
- `RunStateManager` — управление статусами, переходами
- `AgentRunner` — вызов LLM для конкретного агента
- `ArtifactManager` — работа с файлами в storage/
- `GitOperator` — git операции (diff, apply, commit)

### 3. Отсутствие пагинации
Методы `list()` в сервисах (`ChatsService.list`, `RunsService.list`, `ProjectsService.list`) возвращают **все** записи без лимита/оффсета.

### 4. Отсутствие авторизации
JWT проверяется только в WebSocket gateway. REST эндпоинты открыты.

### 5. Синхронизация типов фронтенд/бэкенд
Типы в `apps/web/src/types.ts` дублируют DTO бэкенда. Нет единого источника правды (shared package или codegen).

### 6. Хранение API ключей в открытом виде
`ProviderEntity.apiKey` хранится в plain text. Требуется шифрование.

---

## Запуск и разработка

```bash
# Поднять всё
docker compose up --build

# Только API (hot reload)
cd apps/api && npm run start:dev

# Только Web (hot reload)
cd apps/web && npm run dev

# Миграции БД (TypeORM synchronize: true в dev)
# В продакшене — только миграции!
```

---

## Переменные окружения (.env)

| Переменная | Описание | Пример |
|------------|----------|--------|
| `AI_TEAM_API_KEY` | API ключ для LLM провайдера по умолчанию | `sk-...` |
| `AI_TEAM_BASE_URL` | Base URL провайдера | `https://api.openai.com/v1` |
| `POSTGRES_DB` | Имя БД | `ai_agent_team` |
| `POSTGRES_USER` | Пользователь БД | `postgres` |
| `POSTGRES_PASSWORD` | Пароль БД | `postgres` |
| `API_PORT` | Порт API | `3000` |
| `WEB_PORT` | Порт Web | `8080` |
| `TZ` | Таймзона | `Europe/Kiev` |
| `LOCAL_PROJECTS_ROOT` | Корень проектов на хосте | `/Users/evgenii` |
| `CONTAINER_PROJECTS_ROOT` | Корень проектов в контейнере | `/host-projects` |
| `JWT_SECRET` | Секрет для JWT (WS auth) | `super-secret` |