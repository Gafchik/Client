# AI Agent Team

Docker-first monorepo для команды AI-агентов:

- фронт: `Vue 3 + Vite`
- бек: `NestJS`
- БД: `Postgres`
- запуск: `docker compose up --build`

Идея такая: ты создаешь одну или много команд агентов, у каждой команды настраиваешь роли, модели, множители, температуру, лимиты контекста и тест-команды. Потом даешь задачу и путь к проекту, а пайплайн проходит шаги `PM -> Research -> Spec -> Code -> Review -> Test`.

## Что уже есть

- GUI без консоли;
- несколько команд агентов;
- каталог моделей из твоего списка;
- настройка каждой роли отдельно;
- история запусков в Postgres;
- сохранение артефактов запусков в `storage/`;
- применение изменений в файлы проекта;
- локальные тест-команды после кодинга;
- подсчет `actual` и `weighted` токенов по запуску.

## Структура

```txt
apps/api   -> NestJS API
apps/web   -> Vue 3 + Vite SPA
storage/   -> артефакты запусков
workspace/ -> сюда монтируются проекты для работы агентов
```

## Быстрый старт

1. Создай `.env` на основе примера:

```bash
cp .env.example .env
```

2. Заполни минимум:

```env
AI_TEAM_API_KEY=...
AI_TEAM_BASE_URL=https://your-openai-compatible-host/v1
POSTGRES_DB=ai_agent_team
POSTGRES_USER=postgres
POSTGRES_PASSWORD=postgres
API_PORT=3000
WEB_PORT=8080
TZ=Europe/Kiev
```

3. Положи проект, который будут трогать агенты, в папку `workspace/`.

Пример:

```txt
workspace/my-project
```

4. Подними все сервисы:

```bash
docker compose up --build
```

5. Открой GUI:

```txt
http://localhost:8080
```

## Как задавать путь к проекту

Так как API работает внутри контейнера, путь надо указывать контейнерный:

```txt
/workspace/my-project
```

Если хочешь работать с другим локальным проектом, просто смонтируй его в `docker-compose.yml` внутрь `/workspace/...`.

## Хранение данных

- Postgres хранит команды и историю запусков;
- `storage/teams/<team-id>/runs/<run-id>/` хранит:
  - артефакты агентов;
  - результаты тестов;
  - `final-report.json`.

## Полезные команды

```bash
npm run docker:up
npm run docker:down
npm run docker:logs
```

## Текущий статус

Собран рабочий каркас продукта. Следующим этапом можно усилить:

- авторизацию;
- memory между запусками;
- параллельные ветки агентов;
- web-research агента;
- git/PR workflow;
- более строгий budget control по дням.
