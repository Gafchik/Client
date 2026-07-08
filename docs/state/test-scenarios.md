# Test Scenarios

**Дата обновления:** 2026-07-08  
**Назначение:** единая матрица ручных сценариев для проверки `Research -> Impact -> Context -> Plan` без необходимости каждый раз придумывать новые запросы.

## Как использовать

Каждый сценарий проверяется минимум по 6 полям:

1. `dominantModule`
2. `affectedModules`
3. `functionalSummary`
4. `evidence`
5. `impact.affectedFiles`
6. `context.includedFiles`

Для хорошего результата система должна:

- вести в правильную доменную зону;
- не уезжать в нерелевантные модули;
- поднимать реальные структурные опоры;
- собирать контекст из полезных файлов, а не из случайного шума.

## Статусы

- `green` — уже проходит хорошо
- `yellow` — частично проходит, но есть шум
- `red` — пока системно проваливается

## 1. Functional Flow

### 1.1 Авторизация

- Запрос: `как работает модуль авторизации?`
- Класс: `functional`
- Что проверяет:
  - понимает ли система auth flow;
  - поднимает ли route/controller/service/model цепочку;
  - не уходит ли в billing или другие соседние зоны.
- Ожидаемый фокус:
  - `auth`
  - `web-login`
  - `email-verification`
- Ожидаемые структурные опоры:
  - `routes/api/auth/routes.php`
  - `routes/api/web-login/routes.php`
  - `app/Http/Controllers/AuthController.php`
  - `app/Http/Controllers/WebLoginController.php`
  - `app/Services/WebLoginTicketService.php`
- Текущий статус: `green`

### 1.2 Регистрация и логин

- Запрос: `как устроены логин и регистрация?`
- Класс: `functional`
- Что проверяет:
  - удерживает ли система auth-поток на уровне entry points и handlers;
  - не смешивает ли login/register с unrelated routes.
- Ожидаемый фокус:
  - `auth`
  - `web-login`
- Текущий статус: `yellow`

### 1.3 Верификация email

- Запрос: `как работает подтверждение email?`
- Класс: `functional`
- Что проверяет:
  - выделяются ли verification routes, request objects и controllers;
  - не теряется ли связь с auth.
- Ожидаемый фокус:
  - `email-verification`
  - `auth`
- Текущий статус: `yellow`

## 2. Infrastructure / Storage

### 2.1 Подключения к серверу

- Запрос: `как храняться подключения к серверу?`
- Класс: `infrastructure-storage`
- Что проверяет:
  - может ли система найти storage model серверных подключений;
  - понимает ли связь `server -> credentials -> password/passphrase/private key`.
- Ожидаемый фокус:
  - `servers`
  - `vault`
- Ожидаемые структурные опоры:
  - `app/Models/Server.php`
  - `app/Models/ServerCredentialLink.php`
  - `app/Repositories/ServersRepository.php`
  - `app/Http/Requests/Servers/CreateServerRequest.php`
  - `app/Http/Requests/Servers/UpdateServerRequest.php`
  - `database/migrations/*servers*`
- Текущий статус: `yellow`
- Комментарий:
  - правильный домен уже определяется;
  - после graph-profile pass initial focus стал точнее;
  - в `Context Package` ещё есть лишние vault/user артефакты.

### 2.2 SSH соединения

- Запрос: `как храняться ssh соединения ?`
- Класс: `infrastructure-storage`
- Что проверяет:
  - умеет ли система поднять SSH-specific сигналы:
    - `host`
    - `port`
    - `username`
    - `password_uuid`
    - `passphrase_uuid`
    - `path_to_private_key`
    - `forwarding_ports`
- Ожидаемый фокус:
  - `servers`
  - `vault`
- Текущий статус: `yellow`
- Комментарий:
  - question routing уже правильный;
  - следующий ожидаемый прогресс связан с ещё более точным storage-topology traversal и снижением шума в context/impact.

### 2.3 Где лежат приватные ключи

- Запрос: `где в проекте обрабатываются приватные ключи и passphrase?`
- Класс: `infrastructure-storage`
- Что проверяет:
  - может ли система связывать secrets/vault layer с server connections.
- Ожидаемые структурные опоры:
  - `ServerCredentialLink`
  - request validation files
  - vault-related models/controllers/services
- Текущий статус: `yellow`

### 2.4 Где описаны порты и host

- Запрос: `где описаны host port username для серверов?`
- Класс: `infrastructure-storage`
- Что проверяет:
  - находит ли система schema/model/request-level definition полей.
- Ожидаемые структурные опоры:
  - `CreateServerRequest`
  - `UpdateServerRequest`
  - `Server`
  - migrations
- Текущий статус: `yellow`

## 3. Inventory / Localization / Metadata

### 3.1 Количество языков локализации

- Запрос: `сколько язиков локализации есть в проекте?`
- Класс: `inventory-localization`
- Что проверяет:
  - умеет ли система отвечать через структуру каталогов, а не через functional flow;
  - умеет ли считать и перечислять локали.
- Ожидаемый ответ по `slay-api`:
  - `4`
  - `en`
  - `it`
  - `ru`
  - `ua`
- Ожидаемый фокус:
  - `localization`
- Ожидаемые структурные опоры:
  - `lang/en/*`
  - `lang/it/*`
  - `lang/ru/*`
  - `lang/ua/*`
- Текущий статус: `green`
- Комментарий:
  - inventory mode уже использует отдельный graph profile вместо functional entrypoint heuristics.

### 3.2 Какие языки локализации есть

- Запрос: `какие языки локализации поддерживаются?`
- Класс: `inventory-localization`
- Что проверяет:
  - не только count, но и list-style ответы.
- Ожидаемый фокус:
  - `localization`
- Текущий статус: `green`
- Комментарий:
  - config/env questions уже идут через отдельный graph inventory profile.

### 3.3 Где лежат переводы

- Запрос: `где лежат файлы переводов?`
- Класс: `inventory-localization`
- Что проверяет:
  - directory-based navigation;
  - правильные entry points по `lang/*`.
- Ожидаемый фокус:
  - `localization`
- Текущий статус: `green`

### 3.4 Какие translation files есть

- Запрос: `какие translation файлы есть в проекте?`
- Класс: `inventory-localization`
- Что проверяет:
  - file inventory по translation dictionaries.
- Текущий статус: `green`

## 4. Generic Inventory

### 4.1 Где лежат конфиги

- Запрос: `где лежат конфиги проекта?`
- Класс: `inventory-config`
- Что проверяет:
  - умеет ли система переключаться в config/discovery mode;
  - не уходит ли в runtime controllers.
- Ожидаемый фокус:
  - `config`
  - `environment`
- Текущий статус: `green`

### 4.2 Какие env переменные используются

- Запрос: `какие env переменные использует проект?`
- Класс: `inventory-config`
- Что проверяет:
  - поиск по `env`, `process.env`, framework config helpers.
- Текущий статус: `green`

### 4.3 Где лежат миграции

- Запрос: `где лежат миграции базы данных?`
- Класс: `inventory-storage`
- Что проверяет:
  - может ли система отвечать directory-based способом.
- Текущий статус: `red`

### 4.4 Какие модели есть в проекте

- Запрос: `какие модели есть в проекте?`
- Класс: `inventory-structure`
- Что проверяет:
  - умеет ли система давать structural inventory без ухода в functional zones.
- Текущий статус: `red`

## 5. Dependency / Impact

### 5.1 Что затронет изменение авторизации

- Запрос: `что затронет изменение логики авторизации?`
- Класс: `impact`
- Что проверяет:
  - может ли `Impact` строить разумный blast radius;
  - поднимает ли зависимые routes/controllers/services/models.
- Ожидаемый фокус:
  - `auth`
  - `web-login`
- Текущий статус: `yellow`

### 5.2 Что затронет изменение хранения серверных credentials

- Запрос: `что затронет изменение хранения серверных credentials?`
- Класс: `impact`
- Что проверяет:
  - умеет ли `Impact` расширяться в storage/infrastructure domain.
- Ожидаемый фокус:
  - `servers`
  - `vault`
- Текущий статус: `yellow`

## 6. Planner-Oriented

### 6.1 Добавить поле к серверному подключению

- Запрос: `добавить description к серверному подключению`
- Класс: `planning`
- Что проверяет:
  - строится ли разумный plan по migration/model/request/repository/controller цепочке.
- Ожидаемый фокус:
  - `servers`
  - `vault`
- Текущий статус: `yellow`

### 6.2 Изменить auth flow

- Запрос: `добавить новый шаг в авторизацию`
- Класс: `planning`
- Что проверяет:
  - sequencing по routes/controllers/services/models;
  - корректное target file selection.
- Текущий статус: `yellow`

## 7. Negative / Failure Cases

### 7.1 Слишком расплывчатый вопрос

- Запрос: `как тут всё работает?`
- Класс: `failure`
- Что проверяет:
  - умеет ли система честно показать низкую уверенность;
  - не выдумывает ли слишком конкретный scope.
- Текущий статус: `yellow`

### 7.2 Вопрос о несуществующей зоне

- Запрос: `как устроен kafka consumer слой?`
- Класс: `failure`
- Что проверяет:
  - умеет ли система признать, что сильных structural опор нет.
- Текущий статус: `red`

### 7.3 Вопрос с конфликтующими доменами

- Запрос: `как связаны локализации и ssh подключения?`
- Класс: `failure`
- Что проверяет:
  - умеет ли система не склеивать два далеких домена в фальшивую картину.
- Текущий статус: `red`

## Приоритет следующего прогона

Если идти по полезности для развития системы, я бы гонял сценарии в таком порядке:

1. `как работает модуль авторизации?`
2. `как храняться подключения к серверу?`
3. `как храняться ssh соединения ?`
4. `сколько язиков локализации есть в проекте?`
5. `какие языки локализации поддерживаются?`
6. `где лежат файлы переводов?`
7. `где лежат конфиги проекта?`
8. `какие env переменные использует проект?`
9. `что затронет изменение хранения серверных credentials?`
10. `как тут всё работает?`

## Что делать дальше

Когда появляется новый интересный запрос:

1. Добавить его в эту матрицу.
2. Отнести к одному из классов.
3. Зафиксировать ожидаемый фокус.
4. Поставить статус `green/yellow/red`.
5. После улучшения системы обновить статус.
