# Client

Локальный инструмент для исследования незнакомого кода: подключаешь один или несколько реальных репозиториев (backend/frontend/desktop/cli), задаёшь вопрос на человеческом языке в чате — команда из Researcher/Critic/Observer (реальные LLM-роли, agentic-цикл с инструментами `list_dir`/`grep_content`/`read_file`/`semantic_search`/`find_references`) исследует проект и отвечает с конкретными файлами/строками, а не общими словами.

Однопользовательский локальный инструмент (для себя и пары друзей) — без авторизации, без multi-tenant изоляции.

## Требования

- Node.js 20+ (разрабатывалось на 24)
- Docker + Docker Compose (Postgres, Redis, Neo4j — поднимаются в контейнерах)
- `npm` (workspaces, монорепо — отдельный `npm install` в подпакетах не нужен)
- `ripgrep` (`rg`) в системе — обязателен для agentic research (`grep_content` вызывает реальный бинарник, а не shell alias)

## Запуск с нуля

```bash
git clone <этот репозиторий>
cd client
cp .env.example .env

docker compose up -d
npm install

# два отдельных терминала
npm run dev:api   # apps/api, слушает :3001
npm run dev:web   # apps/web (Vite), слушает :3000, проксирует /api на :3001
```

Открыть `http://localhost:3000`. Схема Postgres создаётся автоматически при первом старте API (idempotent `create table if not exists` на каждой таблице) — отдельного шага миграции нет.

`.env` — только секреты/локальные оверрайды (не коммитится). Значения в `.env.example` совпадают с реальными дефолтами backend и `docker-compose.yml`, поэтому для одиночного локального запуска обычно достаточно просто скопировать файл без правок.

## Что обязательно проверить на новой машине

1. `docker compose up -d` действительно поднял `postgres`, `redis`, `neo4j`.
2. `rg --version` показывает настоящий бинарник, а не shell alias/function.
3. `http://localhost:3001/api/health` отвечает `postgresConnected: true`, `redisConnected: true`. `neo4jConnected` тоже желателен, но его отказ больше не должен валить весь API.
4. Если на машине уже заняты `3000`, `3001`, `5432`, `6380`, `7474`, `7687`, их нужно переопределить в `.env` до старта.

## Что создаётся автоматически

- Postgres schema — при старте API
- файл шифрования секретов `.client/secret.key` — если не задан `CLIENT_SECRET_KEY`
- дефолтный provider — только как bootstrap-заглушка, не готовая к работе без реального API key
- дефолтная team `Проверенная тройка`

## Первая настройка через UI

1. **Провайдеры** (`/providers`) — добавить реального LLM-провайдера (base URL + API key + модели). Без этого шага любой запрос упадёт на авторизации — автосозданный дефолтный провайдер (`https://api.rout.my/v1`) без ключа работать не будет.
2. **Команды** (`/teams`) — создать команду: назначить модели на роли Researcher/Critic/Observer, отметить команду как выбранную (`isSelected`). Без выбранной команды пайплайн работает по старому детерминированному пути (kill-switch), не через agentic-исследование.
3. **Проекты** (`/projects`) — добавить проект и один или несколько путей (абсолютные пути к реальным репозиториям на диске этой машины). Роль каждого пути (backend/frontend-web/frontend-desktop/cli) определяется автоматически по манифестам (`composer.json`/`package.json`). Для multi-repo проекта порядок путей важен: первым лучше сохранять основной backend path.
4. **Чат** (`/chat`) — выбрать проект, задать вопрос.

Если у друга после клонирования "проектов нет", это нормально для чистой Postgres-базы: metadata проектов/провайдеров/команд не лежат в git, их нужно создать через UI заново или загрузить из своей БД/бэкапа.

## Структура

Монорепо, `npm` workspaces:

- `apps/api` — Fastify backend, оркестрация пайплайна (`pipeline-runner.ts`)
- `apps/web` — React UI
- `packages/*` — независимые пакеты (workspace-сканирование, PHP/TS/Vue-индексация, структурный граф, git-интеллектуальность, agentic Team-режим, знания/факты/глоссарий, impact-анализ, контекст, planner, LLM-провайдеры)

Подробное описание каждого модуля — `docs/modules/README.md`. Текущее состояние проекта и история решений — `docs/state/project-state.md`. Ближайший следующий шаг продукта — `docs/architecture/010-senior-developer-capability-roadmap.md`.

## Проверка, что всё поднялось

```bash
curl http://localhost:3001/api/health
# {"status":"ok","now":"...","neo4jConnected":true,"postgresConnected":true,"redisConnected":true}
```

Полезно также открыть:

- `http://localhost:3000/chat`
- `http://localhost:3000/providers`
- `http://localhost:3000/projects`
- `http://localhost:3000/teams`

## Тесты/типы

```bash
npm run typecheck   # tsc --noEmit по всем пакетам
```

Автоматических тестов на данный момент нет (см. `docs/state/project-state.md`) — верификация в этом проекте до сих пор шла через живые прогоны на реальных подключённых проектах, а не через test suite.
