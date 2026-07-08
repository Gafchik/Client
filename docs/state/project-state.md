# Project State

**Дата обновления:** 2026-07-08  
**Текущий этап:** MVP / Slice 1

## Что уже реализовано

- Базовый monorepo foundation на `apps/api`, `apps/web`, `packages/*`.
- Рабочий структурный pipeline первого контура:
  - `Workspace`
  - `Index`
  - `Graph`
  - `Repository Git Intelligence`
  - `Research`
  - `Impact`
  - `Context`
  - `Planner`
  - `Knowledge`
- Русскоязычный chat-first интерфейс:
  - основной экран теперь ведёт себя как простой диалог по задаче;
  - каждый пользовательский запрос автоматически создаёт внутренний `Run`;
  - прогресс pipeline показывается inline внутри AI-сообщения;
  - детальные инженерные артефакты вынесены в правый `Inspector`.
- Центральное хранение артефактов внутри проекта `client`, а не внутри внешних тестируемых репозиториев.
- Сохранение истории запусков по каждому анализируемому проекту.
- Просмотр сохранённых запусков в UI.
- Project-aware отображение текущего анализируемого проекта.
- Отображение стадий pipeline, ignored paths, diagnostics, Git-состояния и execution preview в UI.
- История и сохранённые run-артефакты доступны через chat shell и `Inspector`.
- Context Builder MVP с первым `Context Package`.
- Context Builder Evolution pass:
  - введены priority-based candidate selection и token estimate;
  - functional facts получают обязательный приоритет в контексте;
  - добавлены ranking summary и объяснение причин попадания фрагментов;
  - нерелевантные test/docs/config candidates штрафуются, если задача их явно не требует;
  - context builder начал собирать пакет вокруг focus zones и functional groups, а не только вокруг отдельных файлов и evidence-совпадений;
  - добавлена pruning-логика для focus zones, чтобы слабые соседние домены не загрязняли контекст без прямого подтверждения entry points и file scope.
  - добавлен баланс между functional facts и structural anchors, чтобы контекст не превращался в чисто текстовое summary без route/controller/request/file опор;
  - добавлено обязательное покрытие active focus zones хотя бы одной сильной структурной опорой на зону;
  - добавлены ограничения на переизбыток фрагментов из одной зоны и на слабые кандидаты вне focus zones.
  - добавлен query-profile-aware ranking для `entrypoint-traversal`, `storage-topology`, `localization-inventory`, `config-inventory`, `broad-scan`;
  - context package теперь умеет жёстче отбрасывать нерелевантные runtime/controller/config/localization файлы в зависимости от типа вопроса.
- Planner MVP с детерминированным `Execution Plan`.
- Planner evolution pass:
  - plan стал учитывать `dominantModule`, `entryPoints`, `affectedFiles`, `validationScope`;
  - появился richer deterministic planning shape с `targetModules`, `targetFiles`, `planningNotes` и step-level scope/outputs;
  - planner теперь умеет выбирать `sequential` или `hybrid` стратегию по ширине scope и рискам;
  - planner начал использовать graph-backed dependency chains для порядка workstreams и объяснения sequence;
  - planner эволюционировал от module-only sequencing к file/symbol-backed sequencing для Laravel/PHP и других детальных graph-связей;
  - planner начал группировать workstreams в более инженерно полезные зоны (`routes`, `controllers`, `services`, `models`, `requests`, `enums`) вместо избыточной дробности по отдельным файлам;
  - planner начал нормализовать названия workstreams и удалять лишний шум из dependency chains для лучшей читаемости operator-facing плана;
  - planner начал протягивать semantic prefixes через связанные auth/web-login файлы, чтобы workstreams были ближе к реальным functional zones.
  - planner стал учитывать `queryProfileKey` при выборе execution strategy и больше не предлагает лишний hybrid flow для storage/config/localization/broad сценариев;
  - planner начал выделять дополнительные workstream-группы для `repositories`, `migrations`, `config`, `localization`, `servers`, `vault`.
- Impact evolution pass:
  - impact начал расширять scope через file dependencies/dependents, а не только через прямых соседей evidence-узлов.
  - impact стал query-profile-aware: functional, storage, localization, config и broad вопросы теперь расширяют scope по разным правилам;
  - risk markers начали учитывать тип вопроса, а inventory-вопросы перестали принудительно раздуваться до runtime-like blast radius.
- Safe execution preview без реальной модификации проекта.
- Первый controlled execution runtime без модели:
  - добавлен отдельный runtime contract layer;
  - фиксируются allowed write files, blocked write zones, scope guards, approval checks и refresh plan;
  - execution по-прежнему запрещён без отдельного mutation/runtime слоя и human approval.
- Functional Research MVP:
  - `Research Report` теперь включает functional summary;
  - выделяются entry points, primary entities, side effects и data sources;
  - functional facts прокидываются в `Context Package` и отображаются в UI.
  - research-side фильтрация affected modules стала строже и перестала без прямого подтверждения затягивать соседние домены вроде `billing` в auth-сценарии.
  - добавлены отдельные research-режимы для `infrastructure/storage`, `inventory/localization` и `inventory/config-env`, чтобы система умела не только объяснять flow, но и отвечать на вопросы о хранении, конфигурации и структурном составе проекта.
  - добавлен явный `intent -> strategy -> query profile` routing layer внутри Research;
  - добавлен `broad-unknown` fallback, чтобы слишком широкие вопросы не маскировались под точный auth-flow и вместо этого переводились в broad repository scan с пониженной уверенностью.
- Graph core evolution pass:
  - runtime graph расширен до `repository/module/folder/file/code nodes`;
  - добавлены типизированные code nodes вместо одного обобщённого `symbol`;
  - появились derived module relations и graph query helpers под будущий persistent graph storage;
  - graph начал различать richer structural semantics: `CALLS`, `USES`, `EXTENDS`, `IMPLEMENTS`, а не только плоские `REFERENCES`;
  - query layer теперь умеет отдавать module dependency neighbors, file dependencies/dependents, symbol dependencies/dependents, entry-point neighbors и relation summaries для downstream-модулей.
  - добавлен profile-driven graph query слой для `entrypoint-traversal`, `storage-topology`, `localization-inventory`, `config-inventory`, `broad-scan`;
  - Research теперь использует эти graph seed-наборы не только как metadata-label, а как реальный источник initial focus и structural boosting при сборе evidence.
  - module labeling стал более универсальным: container-style, localization-, database- и route-oriented структуры теперь нормализуются в общие structural zones, а не завязаны на один проект.
- Performance-pass для больших проектов:
  - лёгкий project overview scan без чтения содержимого файлов;
  - исключение тяжёлых директорий вроде `vendor`;
  - ограничение на слишком большие файлы;
  - снят повторный полный rescan после завершения run.
  - workspace теперь дополнительно игнорирует шумные runtime/build директории больших PHP-монолитов (`storage`, `bootstrap/cache`, `generated`, `pub/static`, `var`, `logs`);
  - indexer для PHP получил более дешёвый line-number lookup и pre-collected property types, чтобы heavy files не деградировали из-за повторных `slice/split` и повторного regex-поиска по всему файлу.
  - введён `large-repository` профиль в workspace summary как первый шаг к fast-first staged pipeline для очень больших репозиториев;
  - API и UI теперь явно показывают, когда full run выполняется в режиме большого репозитория.
- Backward compatibility для старых run-артефактов без `Context Package`, `Execution Plan` и `Execution Preview`.
- Frontend reliability pass:
  - `ErrorBoundary`;
  - fallback screen вместо белого экрана;
  - runtime failure logging в browser console;
  - widget-level guards и мягкая деградация отдельных панелей при неполных или старых артефактах;
  - добавлена нормализация API-payload для provider/catalog ответов, чтобы UI не падал на частично пустых массивах.
- Архитектурный слой исторического repository intelligence формализован отдельной спецификацией:
  - `docs/modules/repository-git.md`
  - Git закреплён как самостоятельный источник инженерных знаний, а не как вспомогательная утилита внутри `Research` или `Workspace`;
  - зафиксировано разделение:
    - `Graph` отвечает за текущее структурное состояние;
    - `Repository Git Intelligence` отвечает за историческое и operational состояние репозитория;
    - `Research`, `Planner`, `Execution Engine` и `Knowledge` должны использовать оба измерения совместно.
- Реализован `Repository Git Intelligence MVP`:
  - добавлен пакет `packages/repository-git`;
  - pipeline теперь строит реальный `repository snapshot` перед индексированием;
  - сохраняются `branch`, `HEAD`, `merge base`, `working tree changed set`, `repository diagnostics`;
  - UI показывает Git-состояние, change scope и repository diagnostics;
  - knowledge artifacts теперь включают repository layer как часть run context.
- Large-repository fast-first evolution продолжена:
  - добавлен `selective workspace open`;
  - large-repository pipeline теперь может использовать Git changed set как seed для частичного чтения проекта;
  - index manifest теперь различает `full` и `selective` режимы;
  - API stage details показывают, когда large repository был обработан через selective scan вместо полного прохода.
- Pipeline execution flow усилен:
  - запуск пайплайна переведён в фоновый job-runner;
  - `POST /api/pipeline/run` больше не держит HTTP-запрос до конца полного анализа;
  - добавлен polling статуса выполнения через отдельный status endpoint;
  - UI показывает текущий этап выполнения и больше не зависит от одного длинного синхронного HTTP-ответа.
- Runtime status durability усилена:
  - `PipelineRunStatus` теперь сохраняется на диск внутри `.client`;
  - переходы между стадиями больше не живут только в памяти процесса;
  - long-running анализы стали устойчивее к операторскому наблюдению и последующей отладке.
  - API при старте теперь поднимает сохранённые pipeline statuses обратно в runtime;
  - endpoint статуса умеет читать persisted status даже после потери in-memory состояния.
- Partial stage artifacts добавлены в runtime status:
  - `PipelineRunStatus` теперь содержит `partialArtifacts`;
  - промежуточные результаты `workspace`, `repository`, `index`, `graph`, `research`, `impact`, `context`, `plan`, `execution preview`, `execution runtime` публикуются по мере готовности;
  - UI показывает промежуточные артефакты до завершения всего pipeline.
- Frontend runtime hardening усилен:
  - все ключевые API-запросы UI теперь имеют client-side timeout через `AbortController`;
  - polling статуса больше не может держать кнопку запуска в вечной загрузке при умершем backend-процессе;
  - добавлен ручной сброс зависшего запуска в интерфейсе.
- Runtime continuation / cleanup / invalidation MVP добавлены:
  - при старте API незавершённые `queued/running` run помечаются как прерванные и получают безопасный `resume-from-start` semantics;
  - для `pipeline-status` добавлен retention cleanup по возрасту файлов;
  - pipeline теперь строит `graph invalidation plan` на основе предыдущего run и текущего Git changed set;
  - large/small runs теперь различают `full-refresh` и `partial-invalidation` как часть runtime plan.
- Incremental reuse layer усилен:
  - pipeline теперь строит отдельный `incremental index plan`;
  - этот план учитывает previous run, Git changed set и selective candidate paths;
  - `incrementalIndex` и `graphInvalidation` теперь сохраняются в финальном knowledge run artifact;
  - UI показывает operator-facing сигналы: `incremental-index` и `graph invalidation`.
- Stateful incremental reuse layer переведён из orchestration-only в runtime-capable состояние:
  - knowledge run artifact теперь хранит полноценный `runtime cache` с полным `index` и `graph`, а не только summary;
  - `Indexer` научен переиспользовать неизменённые файлы из предыдущего run по `content hash` и `file path`;
  - `IndexManifest` теперь фиксирует `parse cache`, `AST cache`, `symbol diff`, reused/reindexed/deleted counters;
  - введены `stableSymbolId`, `parseCacheKey`, `astFingerprint` как базовые runtime-сигналы повторного использования;
  - `incremental index plan` теперь различает `changed`, `deleted`, `renamed`, `reusable` paths;
  - `Graph` получил первый partial refresh поверх предыдущего graph state с удалением устаревших file-backed узлов и сохранением неизменённых зон.
- Provider runtime config временно усилен операционным env-слоем:
  - локальный `.env` может задавать `CLIENT_PROVIDER_BASE_URL`, `CLIENT_PROVIDER_MODEL`, `CLIENT_PROVIDER_API_KEY`;
  - API использует эти значения как fallback, если оператор не передал provider credentials из UI;
  - это временный мост для MVP-тестов;
  - целевая архитектура остаётся прежней: provider credentials должны жить в отдельном provider-слое и управляться через интерфейс, а не через постоянный env-only workflow.
- Provider-контур переведён на постоянное хранение:
  - в проект добавлен Docker-first PostgreSQL контур для конфигурации provider-ов;
  - API получил CRUD слой `providers` поверх PostgreSQL;
  - таблица `providers` инициализируется автоматически на старте API;
  - `env` теперь является bootstrap/fallback-слоем, а не целевым источником истины;
  - реализация выровнена под Docker Postgres database `ai_agent_team`.
- Зафиксирован важный контракт provider/runtime слоя:
  - `Provider` хранит endpoint и credential layer, но не хранит выбранную модель;
  - `Model` является runtime-параметром конкретного запуска;
  - backend запрашивает provider-side model catalog через `GET /models`;
  - UI использует catalog-driven выбор модели вместо provider-level model field;
  - при недоступности каталога используется fallback-модельный список;
  - для текущего тестового runtime дефолтной рекомендованной моделью установлен `nvidia/nemotron-3-ultra`.
- Зафиксирован следующий user-facing архитектурный слой:
  - добавлена спецификация `Answer Engine`;
  - Answer Engine должен превращать внутренние артефакты (`Research`, `Impact`, `Context`, `Plan`) в человеко-понятный ответ;
  - chat UX должен оставаться answer-first, а `Inspector` — вторичным expert/debug surface.
- Live answer runtime усилен operational safety-контуром:
  - добавлены timeout для внешнего LLM-вызова;
  - добавлены retry/backoff для transient ошибок и `429/5xx`;
  - учитывается `Retry-After`, если провайдер его возвращает;
  - при ошибке провайдера система обязана отдавать deterministic fallback answer вместо падения run.
- Главный пользовательский UX упрощён до минимального chat-first сценария:
  - на основном экране оставлены только выбор проекта, выбор провайдера, выбор модели и чат;
  - operator-facing сводки, подсказки и вторичные панели убраны с главной поверхности;
  - инженерные артефакты остаются доступны через `Inspector` как secondary/debug surface.
- Research усилен для behavioral-вопросов о локализации:
  - вопросы вида `как выбирается локаль ответа` больше не должны маршрутизироваться как простой localization inventory;
  - введено разделение между `inventory-localization` и runtime-поведением локали;
  - research теперь поднимает сигналы `middleware`, `request headers`, `config/env fallback`, `locale setup`.
- Backend env bootstrap усилен:
  - API теперь ищет `.env` не только в текущем рабочем каталоге, но и выше по дереву;
  - это устраняет падение backend при запуске из workspace-подпакета, когда иначе выбиралась дефолтная БД `client` вместо `ai_agent_team`.

## Текущее состояние MVP Slice 1

Система уже умеет:

1. принять путь к проекту;
2. открыть файловую структуру проекта в read-first режиме;
3. выполнить full index по поддерживаемым типам файлов;
4. построить упрощённый graph;
5. сформировать `Research Report`;
6. сформировать `Impact Report`;
7. сохранить результат как knowledge artifact;
8. показать результат, стадии и диагностику в web UI.
9. открыть сохранённый run и повторно просмотреть его артефакты без нового запуска.
10. собрать первый `Context Package` из `Graph + Research + Knowledge`.
11. построить первый `Execution Plan`.
12. показать safe execution preview с границами разрешённых действий.
13. показать первую функциональную картину затронутой зоны проекта, а не только структурные совпадения.
14. объяснить, почему именно эти контекстные фрагменты были выбраны и какие были отброшены.
15. запускать long-running pipeline в фоне через job-runner и наблюдать за ним через polling статуса.
16. сохранять `PipelineRunStatus` и `partialArtifacts` на диск внутри `.client` и восстанавливать их после рестарта API.
17. строить `incremental index plan` и `graph invalidation plan` на основе прошлого run и текущего Git changed set.
18. переиспользовать runtime cache предыдущего запуска на уровне `index` и `graph`.
19. хранить provider-конфигурации в PostgreSQL и выбирать runtime-модель отдельно от provider-record.
20. работать через chat-first UX, где сложный pipeline скрыт за простым диалогом, а глубинные артефакты открываются через `Inspector`.
21. готовить `Answer Package` как отдельный run-артефакт и использовать его как основной пользовательский результат.

## Что пока ограничено

- Indexer пока поддерживает только часть форматов на практическом уровне:
  - TypeScript
  - JavaScript
  - JSON
  - Markdown
- Остальные языки архитектурно предусмотрены, но ещё не реализованы полноценно.
- Graph пока реализован как in-memory canonical structure MVP-уровня, без отдельного постоянного graph storage.
- Graph уже ближе к канонической модели из доки, но persistent storage, snapshot/version layer и полноценный query engine ещё не реализованы.
- Research и Impact пока rule-based и deterministic; functional understanding уже начато эвристиками, но ещё не опирается на полноценную semantic model.
- Research уже начал использовать graph-derived entry points и module relation summaries, но всё ещё остаётся эвристическим и требует дальнейшего углубления semantic layer.
- Research теперь частично graph-profile-driven на уровне seed selection, но всё ещё нуждается в более глубоком semantic traversal и снижении шума внутри близких доменов.
- Research уже уверенно различает несколько классов вопросов (`functional`, `infrastructure`, `localization`, `config/env`), но всё ещё нуждается в дальнейшем semantic routing и лучшей защите от остаточного шума внутри близких доменных зон.
- Research/Impact/Context/Planner теперь используют общие structural path helpers, но всё ещё нуждаются в более глубоком semantic понимании нестандартных enterprise-архитектур.
- Context Builder уже использует priority-based ranking и explainable selection, но пока без model-aware tokenization и без полноценного semantic reranking.
- Context Builder стал zone-aware и лучше отражает functional grouping, но пока без model-aware tokenization и без полноценного semantic reranking.
- Context Builder уже умеет удерживать баланс между summary и structural anchors, но пока не строит model-specific chunk shapes и не использует semantic deduplication на уровне смысла.
- Context Builder теперь учитывает query profile Research как фильтр против нерелевантных файлов, но всё ещё нуждается в semantic chunking и в более точном token budgeting под конкретные модели.
- Planner теперь строит richer graph-backed deterministic plan, но всё ещё без полноценного execution runtime, rollback orchestration и live replanning.
- Planner уже чувствителен к типу исследовательского профиля, но ещё не использует формальный rollback-plan и pre-execution blocking rules по confidence/unknowns.
- Execution layer теперь имеет safe preview и controlled runtime contract, но всё ещё без фактической мутации файлов.
- Provider runtime config уже собирается и сохраняется вместе с запуском, но фактический live-вызов модели ещё не подключён.
- История запусков пока строится из локально сохранённых JSON-артефактов.
- Фронт уже защищён от полного белого экрана и основных partial-data сбоев, но всё ещё требует дальнейшего hardening:
  - нет автоматического reconnect/backoff policy;
  - нет stage-level streaming через SSE/WebSocket;
  - `Inspector` пока открывает итоговые артефакты run, а не отдельные persisted stage-scoped snapshots.
- Large-repository профиль уже помечается системно, но сам pipeline всё ещё выполняется как один full run и требует дальнейшего staged/incremental разбиения.
- Git уже встроен как runtime subsystem первого уровня, но пока ещё не участвует глубоко в:
  - настоящем incremental reindex на повторных прогонах;
  - regression origin analysis;
  - co-change / hotspot intelligence;
  - rollback-aware planner logic;
  - historical enrichment research и knowledge.
- Selective large-repository режим уже есть, но пока он остаётся cheap-first эвристикой:
  - seed строится по Git changed set, path-token match и structural fallback;
  - ещё нет настоящего symbol-aware partial graph invalidation;
  - ещё нет persisted incremental cache между запусками.
- Async job-runner уже убирает блокировку API на длинных прогонах, но пока:
  - выполняется внутри одного процесса;
  - ещё не умеет полноценный resume после рестарта через восстановление in-flight job execution;
  - не стримит частичные артефакты по стадиям, а только статус и финальный результат.
- Status persistence уже есть, но пока:
  - статус сохраняется как snapshot, а не как event log;
  - cleanup / retention policy пока зафиксирована в коде, а не вынесена в конфигурацию;
  - нет полноценного resume незавершённого execution после рестарта процесса, есть только восстановление наблюдаемого status state.
- Resume / cleanup / invalidation уже есть как first MVP, но пока:
  - `resume` реализован как безопасный `restart-from-start`, а не как продолжение с середины стадии;
  - `graph invalidation plan` пока формируется эвристически по changed set и previous run, без symbol-level dependency diff.
- Incremental reuse уже есть как path-level orchestration, но пока:
- persisted reuse теперь уже есть на уровне file/index/graph runtime cache, но пока:
  - reuse работает по file-level content hash, а не по полноценному symbol-level semantic diff;
  - AST cache зафиксирован в runtime contract и manifest, но ещё не вынесен в отдельное постоянное cache-хранилище;
  - graph partial refresh уже materialize-ится поверх прошлого state, но пока без тонкой symbol-edge invalidation и без dedicated graph snapshot/version store.
- Partial artifacts уже есть, но пока:
  - они живут внутри snapshot статуса, а не как отдельные stage-scoped artifacts;
  - UI показывает их как прогресс-обзор, но ещё не умеет полноценно открывать каждую промежуточную стадию как отдельный сохранённый артефакт;
  - нет deduplication и retention policy для промежуточных payload.
- Frontend polling уже защищён от бесконечного ожидания, но пока:
  - нет автоматического reconnect/backoff policy;
  - нет различения между кратковременной сетевой ошибкой и реальной смертью backend;
  - сброс зависшего запуска пока ручной, а не policy-driven.
- Live LLM runtime пока отсутствует:
  - полноценный mutation/runtime loop всё ещё не подключён;
  - live model orchestration только начинается с answer synthesis слоя;
  - token accounting, cost accounting и richer provider observability ещё не доведены до отдельного subsystem уровня.
- Answer-first response layer пока описан архитектурно, но ещё не реализован в runtime:
  - follow-up continuity и conversational answer reuse ещё не materialized;
  - Inspector всё ещё остаётся довольно техническим и требует дальнейшего product pass.

## Где хранятся артефакты

Артефакты хранятся централизованно внутри:

`/Users/evgenii/Desktop/client/.client/knowledge/projects/<project-key>/`

Это сделано специально, чтобы:

- не загрязнять тестируемые проекты служебными файлами;
- хранить историю запусков в одном месте;
- поддерживать проектно-изолированную историю run-артефактов.

## Матрица тестирования

Для ручной проверки качества `Research -> Impact -> Context -> Plan` добавлена единая матрица сценариев:

`/Users/evgenii/Desktop/client/docs/state/test-scenarios.md`

Она нужна, чтобы:

- не придумывать тестовые запросы заново;
- проверять прогресс по одним и тем же кейсам;
- видеть, какие классы вопросов уже проходят (`green`), а какие ещё слабы (`yellow` / `red`).

## Ближайший следующий шаг

Следующий этап после текущего MVP expansion pass:

- подключить первый реальный live LLM runtime поверх уже готового provider/model слоя;
- реализовать `Answer Engine` как user-facing answer synthesis layer поверх внутреннего pipeline;
- передавать во внешний inference runtime `Research + Impact + Context + Plan` вместо чисто локального preview-контура;
- начать controlled execution runtime вместо одного preview-слоя;
- добавить фактический mutation executor поверх уже готовых scope guard и write boundary;
- подготовить post-change reindex, graph refresh и knowledge refresh orchestration как исполняемый runtime flow;
- продолжить staged pipeline для больших репозиториев: cheap-first workspace/index path, потом selective deep analysis;
- углубить functional research, чтобы feature-level understanding было точнее и менее эвристическим;
- добавить model-aware token budgeting и semantic reranking в Context Builder;
- углубить Context Builder до graph-backed dependency expansion внутри query profile, а не только path/rule-based ranking;
- продолжить graph-core evolution до richer relation semantics, snapshot/version layer и query surface, пригодных для будущего DB-backed graph storage;
- продолжить перенос Research с file/content heuristics на более явный graph-first traversal и query-profile-specific expansion;
- развить `Repository Git Intelligence` от MVP к operational/historical subsystem:
  - связать Git change scope с planner safety rules;
  - добавить historical signals для research и impact;
  - добавить rollback anchors и run-scoped mutation ownership;
  - начать co-change и hotspot анализ.
- следующий инфраструктурный шаг для runtime:
  - вынести тяжёлые стадии из одного процесса при необходимости;
  - углубить `resume` от restart-from-start до stage-aware continuation;
  - вынести retention и cleanup policy в конфигурационный слой;
  - углубить `incremental index plan` до symbol-aware incremental index и AST reuse;
  - углубить `graph invalidation plan` до partial graph refresh поверх предыдущего graph state;
  - разнести partial artifacts в отдельные stage-scoped persisted artifacts;
  - усилить data-shape validation между API, сохранёнными артефактами и UI.
