# Test Scenarios

**Дата обновления:** 2026-07-09  
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

## Benchmark Projects

- `slay-api` — базовый рабочий Laravel-like проект для быстрых функциональных и inventory проверок.
- `magendamd_backend` — основной stress-benchmark для больших PHP/enterprise проектов с нестандартной container-style архитектурой.
- Для `magendamd_backend` оценивается не только точность, но и latency полного pipeline на большом дереве проекта.
- Для `magendamd_backend` large-repository режим считается обязательной частью наблюдаемого поведения pipeline.

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

### 3.5 Как выбирается локаль ответа

- Запрос: `как в проекте выбирается локаль ответа?`
- Класс: `functional-runtime-locale`
- Benchmark project: `slay-api`
- Что проверяет:
  - отличает ли система runtime locale flow от inventory переводов;
  - поднимает ли middleware, header и default fallback;
  - не уходит ли в `lang/*` как в главную точку ответа.
- Ожидаемый ответ по `slay-api`:
  - локаль читается из header `X-Locale`;
  - если header отсутствует или значение невалидно, используется `LocaleEnum::defaultLocale()`;
  - locale выставляется через `App::setLocale(...)`;
  - middleware подключен в API pipeline через `bootstrap/app.php`.
- Ожидаемые структурные опоры:
  - `app/Http/Middleware/LocaleMiddleware.php`
  - `bootstrap/app.php`
  - `app/Enums/LocaleEnum.php`
- Текущий статус: `yellow`
- Комментарий:
  - на успешных прогонах `Research` уже уходит в runtime locale flow, а не в чистый inventory;
  - strongest evidence уже держится за `LocaleMiddleware`, `LocaleMiddleware.handle`, `LocaleEnum`;
  - `final answer` стал опираться на middleware/header/fallback chain;
  - `research.entryPoints` и `primaryEntities` всё ещё частично загрязняются localization inventory, поэтому кейс пока не `green`.

### 3.6 Где задаётся default locale

- Запрос: `где задается дефолтная локаль?`
- Класс: `functional-runtime-locale`
- Benchmark project: `slay-api`
- Что проверяет:
  - может ли система выделить fallback locale как runtime decision, а не как список translation-файлов.
- Ожидаемые структурные опоры:
  - `app/Http/Middleware/LocaleMiddleware.php`
  - `app/Enums/LocaleEnum.php`
- Текущий статус: `yellow`
- Комментарий:
  - routing-эвристика для `default locale` уже усилена, чтобы вопрос шёл в runtime-поведение, а не в inventory переводов;
  - полная ручная перепроверка после последней правки ещё требуется, поэтому статус пока не повышается.

### 3.7 Как подключен LocaleMiddleware

- Запрос: `где подключен LocaleMiddleware?`
- Класс: `functional-runtime-locale`
- Benchmark project: `slay-api`
- Что проверяет:
  - умеет ли система находить bootstrap/API middleware registration.
- Ожидаемые структурные опоры:
  - `bootstrap/app.php`
  - `app/Http/Middleware/LocaleMiddleware.php`
- Текущий статус: `yellow`

### 3.8 Какой header влияет на локаль

- Запрос: `какой header влияет на локаль ответа?`
- Класс: `functional-runtime-locale`
- Benchmark project: `slay-api`
- Что проверяет:
  - поднимает ли система именно request runtime flow, а не translation inventory;
  - находит ли конкретный входной header и fallback поведение.
- Ожидаемый ответ по `slay-api`:
  - используется header `X-Locale`;
  - при отсутствии или невалидном значении берётся `LocaleEnum::defaultLocale()`.
- Ожидаемые структурные опоры:
  - `app/Http/Middleware/LocaleMiddleware.php`
  - `app/Enums/LocaleEnum.php`
- Текущий статус: `yellow`

## 4. Billing / Runtime Flow

### 4.1 Как происходит rollback bill в generated

- Запрос: `Как происходит ролбек била в статус generated?`
- Класс: `functional-billing-rollback`
- Benchmark project: `magendamd_backend`
- Что проверяет:
  - ведёт ли система вопрос в runtime billing flow, а не в произвольные generated/biller зоны;
  - поднимает ли route -> controller -> action -> history chain;
  - понимает ли, что rollback должен сохранять историю статусов.
- Ожидаемый ответ по `magendamd_backend`:
  - route `POST v1/billing/bill/{bill}/rollback/generated` ведёт в `BillController::rollbackGenerated`;
  - controller вызывает `ToGeneratedBillAction->run($bill)`;
  - action переводит bill в статус `GENERATED`, удаляет `billDocument`, обновляет bill и создаёт `BillHistory`;
  - после этого controller обновляет bill metrics/listing и возвращает `BillResource`.
- Ожидаемые структурные опоры:
  - `app/src/Containers/Billing/Bill/UI/API/Routes/RouteProvider.php`
  - `app/src/Containers/Billing/Bill/UI/API/Controllers/BillController.php`
  - `app/src/Containers/Billing/Bill/Actions/ToGeneratedBillAction.php`
  - `app/src/Containers/Billing/BillHistory/Actions/CreateBillHistoryAction.php`
  - `app/src/Containers/Billing/Bill/Support/BillHistoryDocumentSyncResolver.php`
- Текущий статус: `yellow`
- Комментарий:
  - на успешных прогонах semantic focus уже уходит в `billing` вместо `broad-unknown`;
  - candidate paths и answer уже поднимают route -> controller -> `ToGeneratedBillAction` -> `CreateBillHistoryAction`;
  - текущий главный блокер уже не только качество семантики, а нестабильность `question-run` на большом репозитории: отдельные запуски могут зависать слишком рано и не доходить до полного отчёта;
  - evidence и entry points ещё иногда загрязняются соседними `billing/biller/migration` артефактами.

### 4.2 Что делает ToGeneratedBillAction

- Запрос: `что делает ToGeneratedBillAction?`
- Класс: `functional-billing-action`
- Benchmark project: `magendamd_backend`
- Что проверяет:
  - может ли система распознать class-name based intent;
  - удерживает ли answer на уровне конкретного action, а не broad generated-поиска;
  - связывает ли action с bill status и BillHistory.
- Ожидаемый ответ по `magendamd_backend`:
  - action переводит bill в `GENERATED`;
  - удаляет связанный `billDocument`;
  - обновляет статус bill;
  - создаёт новую запись `BillHistory`.
- Ожидаемые структурные опоры:
  - `app/src/Containers/Billing/Bill/Actions/ToGeneratedBillAction.php`
  - `app/src/Containers/Billing/BillHistory/Actions/CreateBillHistoryAction.php`
  - `app/src/Containers/Billing/Bill/Models/Bill.php`
- Текущий статус: `yellow`
- Комментарий:
  - этот кейс важен как regression на class-name aware routing;
  - после усиления camelCase/class-name tokenization вопрос уже лучше удерживается на конкретном action;
  - до `green` не хватает двух вещей: стабильного завершения large-repository run и более чистого runtime evidence без шумных соседних billing-символов.

## 5. Regression Notes

- Runtime locale и billing rollback используются как обязательные regression cases для lightweight question pipeline поверх baseline graph/index cache.
- Цель этих сценариев:
  - не запускать полный research заново на каждый вопрос;
  - открывать только task-relevant slice;
  - строить ответ из уже собранной структуры проекта и минимального overlay.
- Для large-repository сценариев baseline lookup должен опираться на lightweight metadata из knowledge catalog, а не на чтение всех больших run-артефактов целиком.
- Question-run не должен зависеть от доступности project/provider storage, если оператор явно передал `projectPath`, `providerBaseUrl`, `providerModel`, `providerApiKey`.
- Текущий отдельный системный риск:
  - для `magendamd_backend` большой `question-run` всё ещё может зависать слишком рано, до записи полноценного persisted status/result;
  - значит следующий фокус разработки должен быть не только на semantic routing, но и на стабилизации ранних фаз large-repository pipeline.
- Что уже усилено технически:
  - запуск `question-run` переведён в более безопасный async-start режим, чтобы `runId` и начальный status успевали стабильно отдаваться наружу;
  - между тяжёлыми фазами pipeline добавлены короткие event-loop yield точки, чтобы большие репозитории меньше “морозили” `/status` и внешний чатовый UX;
  - после этой правки нужен отдельный ручной регрессионный прогон на `magendamd_backend`.

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

## 4.5 Slay Functional / Security Cases

### 4.5.1 Как работает web-login ticket

- Запрос: `как работает web-login ticket?`
- Класс: `functional`
- Benchmark project: `slay-api`
- Что проверяет:
  - умеет ли система связать controller + service + cache TTL + claim flow.
- Ожидаемый ответ по `slay-api`:
  - `ticket` и `state` генерируются в `WebLoginTicketService`;
  - ticket кладётся в cache на `2` минуты;
  - `claim` читает запись через `Cache::pull`, проверяет `state` и создаёт `webLogin` token.
- Ожидаемые структурные опоры:
  - `app/Http/Controllers/WebLoginController.php`
  - `app/Services/WebLoginTicketService.php`
  - `routes/api/web-login/routes.php`
- Текущий статус: `yellow`

### 4.5.2 Как хранятся серверные credentials

- Запрос: `как хранятся серверные credentials?`
- Класс: `infrastructure-storage`
- Benchmark project: `slay-api`
- Что проверяет:
  - может ли система правильно объяснить связь `Server -> ServerCredentialLink -> Password`.
- Ожидаемый ответ по `slay-api`:
  - сервер хранит `host/port/username/path_to_private_key`;
  - password/passphrase не лежат напрямую в `servers`;
  - они связываются через `ServerCredentialLink` и lookup по `Password.uuid`.
- Ожидаемые структурные опоры:
  - `app/Repositories/ServersRepository.php`
  - `app/Models/Server.php`
  - `app/Models/ServerCredentialLink.php`
  - `app/Models/Password.php`
- Текущий статус: `yellow`

### 4.5.3 Где валидируются server password_uuid и passphrase_uuid

- Запрос: `где валидируются password_uuid и passphrase_uuid для сервера?`
- Класс: `infrastructure-storage`
- Benchmark project: `slay-api`
- Что проверяет:
  - поднимает ли система request-layer validation и vault access checks.
- Ожидаемые структурные опоры:
  - `app/Http/Requests/Servers/CreateServerRequest.php`
  - `app/Http/Requests/Servers/UpdateServerRequest.php`
- Текущий статус: `yellow`

### 4.5.4 Как устроен vault crypto bootstrap

- Запрос: `как инициализируется vault crypto профиль?`
- Класс: `functional-security`
- Benchmark project: `slay-api`
- Что проверяет:
  - умеет ли система связать request validation, vault config и crypto bootstrap flow.
- Ожидаемые структурные опоры:
  - `app/Http/Requests/Vault/InitializeVaultCryptoRequest.php`
  - `config/vault.php`
  - `routes/api/vault-crypto/routes.php`
- Текущий статус: `yellow`

### 4.5.5 Как проверяется подписка пользователя

- Запрос: `как проверяется подписка пользователя?`
- Класс: `functional`
- Benchmark project: `slay-api`
- Что проверяет:
  - поднимает ли система middleware-level access control для billing/subscription.
- Ожидаемые структурные опоры:
  - `app/Http/Middleware/EnsureUserIsSubscribed.php`
  - `bootstrap/app.php`
  - `lang/*/billing.php`
- Текущий статус: `yellow`

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

## 5.3 Magenda Billing / Runtime Cases

### 5.3.1 Как происходит ролбек била в статус generated

- Запрос: `как происходит ролбек била в статус generated?`
- Класс: `functional-billing-rollback`
- Benchmark project: `magendamd_backend`
- Что проверяет:
  - идёт ли система в узкий billing rollback flow вместо broad scan;
  - поднимает ли route/controller/action/history chain.
- Ожидаемый ответ по `magendamd_backend`:
  - route `POST {bill}/rollback/generated` ведёт в `BillController::rollbackGenerated`;
  - controller вызывает `ToGeneratedBillAction->run($bill)`;
  - action выставляет статус `GENERATED`, удаляет `billDocument`, патчит bill и создаёт новый `BillHistory`;
  - после этого controller refresh-ит bill list metrics и возвращает `BillResource`.
- Ожидаемые структурные опоры:
  - `app/src/Containers/Billing/Bill/UI/API/Routes/RouteProvider.php`
  - `app/src/Containers/Billing/Bill/UI/API/Controllers/BillController.php`
  - `app/src/Containers/Billing/Bill/Actions/ToGeneratedBillAction.php`
  - `app/src/Containers/Billing/BillHistory/Actions/CreateBillHistoryAction.php`
- Текущий статус: `yellow`
- Комментарий:
  - успешные прогоны уже показывали переход из `broad-unknown` в `functional-flow` с доминирующим модулем `billing`;
  - route/controller/action/history chain уже поднимается заметно лучше;
  - для уверенного `green` нужен стабильный run на большом репозитории без раннего зависания и с более чистым evidence set.

### 5.3.2 Где описан route rollback generated

- Запрос: `где описан route rollback generated bill?`
- Класс: `functional-billing-rollback`
- Benchmark project: `magendamd_backend`
- Что проверяет:
  - умеет ли система поднять route file и конкретный controller action.
- Ожидаемый ответ по `magendamd_backend`:
  - `POST {bill}/rollback/generated` в `Billing/Bill/UI/API/Routes/RouteProvider.php`
  - handler: `BillController::rollbackGenerated`
- Текущий статус: `yellow`

### 5.3.3 Что делает ToGeneratedBillAction

- Запрос: `что делает ToGeneratedBillAction?`
- Класс: `functional-billing-rollback`
- Benchmark project: `magendamd_backend`
- Что проверяет:
  - может ли система объяснить state transition на уровне action.
- Ожидаемый ответ по `magendamd_backend`:
  - получает `GENERATED` status id;
  - удаляет `billDocument`;
  - патчит `bill_status_id` и `bill_sent_date`;
  - создаёт `BillHistory`.
- Текущий статус: `yellow`

### 5.3.4 Как создается BillHistory при смене статуса

- Запрос: `как создается BillHistory при смене статуса bill?`
- Класс: `functional-billing-history`
- Benchmark project: `magendamd_backend`
- Что проверяет:
  - умеет ли система держать focus на `CreateBillHistoryAction`.
- Ожидаемые структурные опоры:
  - `app/src/Containers/Billing/BillHistory/Actions/CreateBillHistoryAction.php`
  - `app/src/Containers/Billing/BillHistory/Events/BillHistoryCreated.php`
- Текущий статус: `yellow`

### 5.3.5 Как определяется граница history для документов bill

- Запрос: `как определяется boundary для bill history documents?`
- Класс: `functional-billing-history`
- Benchmark project: `magendamd_backend`
- Что проверяет:
  - поднимает ли система `BillHistoryDocumentSyncResolver`.
- Ожидаемый ответ по `magendamd_backend`:
  - сначала ищется anchor history по набору sync-статусов;
  - если anchor нет, ищется latest `GENERATED` history;
  - boundary возвращается как `{history_id, operator}`.
- Ожидаемые структурные опоры:
  - `app/src/Containers/Billing/Bill/Support/BillHistoryDocumentSyncResolver.php`
- Текущий статус: `yellow`

### 5.3.6 Почему rollbackDraft запрещен после rollback_to_generated

- Запрос: `почему rollbackDraft запрещен если bill уже rollback_to_generated?`
- Класс: `functional-billing-rollback`
- Benchmark project: `magendamd_backend`
- Что проверяет:
  - видит ли система guard в `BillController::rollbackDraft`.
- Ожидаемый ответ по `magendamd_backend`:
  - controller проверяет `$bill->was_been_rollback_to_generated`;
  - если флаг true, возвращает `403` и сообщение `not_can_move_to_unbilled`.
- Ожидаемые структурные опоры:
  - `BillController::rollbackDraft`
  - `Bill::was_been_rollback_to_generated`
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

## 8. Multi-turn Dialogue

Проверяет `conversationId`-механику (см. `docs/state/project-state.md`, запись "Многоходовой диалог"): follow-up-вопрос в том же диалоге должен переиспользовать evidence/dominantModule предыдущей реплики, а не начинать research с нуля.

### 8.1 Follow-up про email-верификацию после Google auth

- Запрос (реплика 1): `Есть ли авторизация через Google?`
- Запрос (реплика 2, тот же `conversationId`): `нужно ли при регистрации через гугл подтверждать имейл?`
- Класс: `multi-turn`
- Benchmark project: `slay-api`
- Что проверяет:
  - переносится ли evidence первой реплики во вторую (`research.evidenceSummary.conversationCount`);
  - удерживается ли `dominantModule` между репликами;
  - не зависит ли механика переноса от выбора модели (перенос evidence — детерминированный код, не LLM-вызов).
- Ожидаемый результат:
  - реплика 2: `turnIndex: 1`, `evidenceSummary.conversationCount >= 1`;
  - evidence с `origin: "conversation"` содержит явную ссылку на вопрос предыдущей реплики в `reason`;
  - `dominantModule` реплики 2 совпадает с репликой 1 (`auth`).
- Текущий статус: `green`
- Комментарий:
  - живой прогон 2026-07-14 подтвердил на трёх моделях (`nvidia/nemotron-3-ultra`, `google/gemini-3.1-flash-lite`, `openai/gpt-5.4-mini`) идентичный результат переноса evidence (2 файла: `success_google.blade.php`, `create_google_accounts_table.php` migration) — подтверждает, что механика не зависит от модели;
  - итоговый `answer.answerMode` на этом конкретном вопросе — `clarification-needed` (вопрос действительно затрагивает сразу auth и email-verification зоны) — это не баг диалоговой механики, а отдельное, корректное срабатывание `detectResearchAmbiguity`.

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

## Новый Regression Pack

После каждого усиления `Research` обязательно прогонять минимум эти вопросы:

1. `Как в проекте выбирается локаль ответа?`
2. `где задается дефолтная локаль?`
3. `какой header влияет на локаль ответа?`
4. `как работает web-login ticket?`
5. `как хранятся серверные credentials?`
6. `Как происходит ролбек била в статус generated?`
7. `где описан route rollback generated bill?`
8. `что делает ToGeneratedBillAction?`
9. `как создается BillHistory при смене статуса bill?`
10. `почему rollbackDraft запрещен если bill уже rollback_to_generated?`

## Что делать дальше

Когда появляется новый интересный запрос:

1. Добавить его в эту матрицу.
2. Отнести к одному из классов.
3. Зафиксировать ожидаемый фокус.
4. Поставить статус `green/yellow/red`.
5. После улучшения системы обновить статус.
