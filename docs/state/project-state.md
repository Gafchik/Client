# Project State

**Дата обновления:** 2026-07-13  
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
- Chat-first UI product pass первого уровня завершён:
  - добавлена отдельная продуктовая спецификация `docs/modules/chat-ui.md`;
  - главный экран перестроен вокруг спокойного ежедневного сценария `выбрал проект -> задал вопрос -> прочитал ответ`;
  - верхняя панель упрощена, слева оставлена история диалога, справа `Inspector` открывается только по требованию;
  - на главной поверхности оставлены только `Project`, `Path`, `Provider`, `Model`, статус проекта, чат и composer;
  - шумные технические панели убраны из primary UX и переведены во вторичный слой.
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
- Главный chat-ответ упрощён до LLM-подобного UX:
  - в основном bubble теперь доминирует нормальный человеко-читаемый ответ, а не report dump;
  - на главной поверхности сохранены только компактные блоки `Ответ`, `Impact`, `Context`, `Plan`;
  - сохранены `Ограничения`, `План реализации` и действия `Почему я так ответил`, `Открыть исследование`, `Посмотреть план`, `Execution preview`;
  - из основного ответа убраны raw evidence lists, provenance dump и избыточные технические сводки.
- Frontend chat runtime согласован с новым UX:
  - исправлен класс ошибок, при котором результат предыдущего run мог визуально попасть в новое сообщение;
  - теперь UI показывает ответ только если `result.runId` совпадает с активным `runStatus.runId`;
  - это уменьшает риск ложного ответа при быстрых последовательных вопросах.
- Главный пользовательский UX упрощён до минимального chat-first сценария:
  - на основном экране оставлены только выбор проекта, выбор провайдера, выбор модели и чат;
  - operator-facing сводки, подсказки и вторичные панели убраны с главной поверхности;
  - инженерные артефакты остаются доступны через `Inspector` как secondary/debug surface.
- Branch-aware background intelligence переведён из чистой архитектурной идеи в рабочий MVP-слой:
  - `RepositorySnapshot` теперь содержит `stateFingerprint`, `worktreeFingerprint`, `branchFingerprint`;
  - knowledge-артефакты и `PipelineRunResult` умеют хранить `backgroundState`;
  - API `/api/project` теперь возвращает текущее Git-состояние и рассчитанное branch-aware состояние проекта;
  - UI показывает текущую ветку, short HEAD, freshness, sync status, changed file count и baseline source;
  - добавлена кнопка принудительной пересборки branch-aware project intelligence;
  - чат теперь явно коммуницирует, что ответ строится поверх уже собранного понимания проекта, а не как “пустой” stateless запуск.
- GUI разделён на отдельные пользовательские страницы:
  - `Чат` для общения с проектом;
  - `Провайдеры` для CRUD управления LLM/runtime providers;
  - `Проекты` для CRUD управления проектами.
- Введена постоянная модель `Project` с несколькими именованными путями:
  - один проект может содержать несколько `project paths`;
  - каждый путь имеет собственное имя (`backend`, `frontend`, `billing` и т.д.);
  - API и UI уже поддерживают хранение и редактирование такой структуры;
  - чат умеет выбирать сохранённый проект из списка и выбирать конкретный path-контур из выпадающего списка;
  - backend теперь уважает явно выбранный `projectPath`, а не молча подменяет его первым путём проекта.
- Pipeline разделён на два режима исполнения:
  - `background-sync` для отдельной фоновой пересборки project intelligence;
  - `question-run` для ответа на вопрос поверх последнего baseline и текущего branch/worktree состояния.
- Chat UX начал отходить от full-research-per-question модели:
  - обычный вопрос запускается как `question-run`;
  - принудительная пересборка запускается как отдельный `background-sync`;
  - интерфейс помечает, когда фон устарел или отсутствует, и рекомендует обновить baseline вместо скрытого полного перезапуска.
- `question-run` получил первый реальный lightweight execution path:
  - repository snapshot теперь может строиться без полного открытия проекта;
  - candidate paths для вопроса собираются из Git changed set, task tokens и baseline runtime cache;
  - для вопроса используется узкий workspace overlay по релевантным путям, если это безопасно;
  - это уменьшает объём повторного чтения проекта до запуска research/context/answer слоёв.
- Добавлен первый авто-режим фоновой синхронизации:
  - `/api/project` теперь сообщает о текущем `activeBackgroundRun`, если пересборка уже идёт;
  - фронт автоматически запускает `background-sync`, когда baseline устарел или отсутствует;
  - пользователь видит в чате живой статус фоновой пересборки и Git-aware состояние проекта.
- Auto background sync усилен branch/worktree-aware дедупликацией:
  - backend теперь умеет сопоставлять `background-sync` с конкретным `repository.stateFingerprint`;
  - если для того же exact branch/worktree состояния уже существует `queued` или `running` фоновый sync, новый sync не создаётся;
  - `/api/project` теперь возвращает `baselineInfo`, чтобы UI понимал, есть ли уже готовый baseline именно для текущего Git state;
  - чат показывает не только freshness, но и readiness baseline для exact state, чтобы оператор видел, нужен ли реальный пересбор или система уже может безопасно переиспользовать имеющееся понимание проекта.
- Knowledge artifact compatibility выровнен с branch-aware runtime:
  - `saveKnowledgeArtifacts()` теперь сохраняет полный `project` и `knowledge` блоки в том же формате, который ожидает loader;
  - `loadPipelineRunArtifact()` умеет восстановить `project` и `knowledge` даже для старых укороченных артефактов;
  - это устраняет ситуацию, когда `recentRuns` видны в UI, но `latestRun` не поднимается обратно в `/api/project`;
  - baseline/runtime reuse слой снова может опираться на сохранённый последний run как на нормальный источник истины, а не только на catalog metadata.
- Research усилен для behavioral-вопросов о локализации:
  - вопросы вида `как выбирается локаль ответа` больше не должны маршрутизироваться как простой localization inventory;
  - введено разделение между `inventory-localization` и runtime-поведением локали;
  - research теперь поднимает сигналы `middleware`, `request headers`, `config/env fallback`, `locale setup`.
  - runtime extraction усилен отдельно от inventory extraction:
    - `entryPoints` теперь приоритизируют middleware, HTTP/request слой, config locale fallback и runtime locale setters;
    - `primaryEntities` теперь штрафуют plain `lang/*` и translation-only файлы, если вопрос относится к поведению запроса;
    - `sideEffects` и `dataSources` теперь сначала объясняют request-header -> locale-set -> config fallback chain, а не список translation directories.
- Backend env bootstrap усилен:
  - API теперь ищет `.env` не только в текущем рабочем каталоге, но и выше по дереву;
  - это устраняет падение backend при запуске из workspace-подпакета, когда иначе выбиралась дефолтная БД `client` вместо `ai_agent_team`.
- Answer Engine переведён в evidence-locked режим для чувствительных diagnostic/runtime сценариев:
  - live LLM synthesis теперь получает более жёсткий prompt contract и запрет на недоказанные framework-guess факты;
  - введена post-validation проверка LLM-ответа против evidence corpus;
  - при выходе модели за рамки доказанных данных система откатывается к deterministic fallback answer;
  - пользовательский ответ теперь честно фиксирует только подтверждённые runtime-факты и явно помечает, что недоказанные гипотезы исключены.
- ~~Semantic coverage расширен на Magenda billing rollback/history сценарии~~ / ~~Billing rollback ranking усилен против Magenda-specific шума~~ / ~~Lightweight question overlay усилен для billing rollback сценариев~~ — **полностью удалено 2026-07-13**, см. раздел "Устранение project-specific оверфита" ниже. Эти три пункта на протяжении нескольких сессий описывали хардкод одного реального бэкенда (`magendamd_backend`) прямо в shared-пакетах (`indexer`, `graph`, `research`, `context`, `ai`) — literal PHP-имена (`BillController`, `ToGeneratedBillAction`, `BillHistory`, `was_been_rollback_to_generated`), literal пути (`/containers/billing/bill/`, `v1/billing/bill/{bill}/rollback/generated`). Это прямо нарушало продуктовый принцип "приложение полезно для любого проекта, а не только для того, на котором тестировали" — оставлено в истории лога намеренно вычеркнутым, а не удалено, чтобы не потерять след регрессии.
- Зафиксирован следующий архитектурный шаг для масштабирования продукта:
  - добавлена cross-cutting спецификация `docs/modules/branch-aware-intelligence.md`;
  - в ней формализована модель `baseline snapshot + branch overlay + worktree overlay`;
  - закреплено, что вопрос пользователя не должен запускать full research проекта, а должен работать поверх уже подготовленного branch-aware state;
  - закреплены `Repository State Identity`, hash strategy, graph shard reuse, research slice reuse и branch-scoped knowledge как целевой operating model.
- Зафиксирован следующий уровень operating model поверх branch-aware слоя:
  - добавлена спецификация `docs/modules/project-intelligence-runtime.md`;
  - в ней формализовано, что проект должен быть изучен заранее через `background sync`, а не в момент каждого вопроса;
  - жёстко разделены `Baseline Project Map`, `Branch Overlay` и `Worktree Overlay`;
  - закреплено различие между `Committed State` и `Local Development State`;
  - зафиксирована гибридная модель `watcher + polling` для отслеживания branch/worktree изменений;
- Research / Answer provenance layer усилен:
  - `ResearchReport` теперь разделяет `baselineFindings`, `overlayFindings` и общее `evidenceSummary`;
  - каждое ключевое evidence теперь маркируется как `baseline`, `overlay` или `structural`;
  - question-answer слой начал явно отличать committed baseline факты от локальных незакоммиченных worktree-фактов;
  - `Inspector -> Research` показывает происхождение фактов, чтобы оператор видел, что относится к канонической карте проекта, а что существует только в локальной разработке;
  - это приближает систему к целевому режиму: чат отвечает поверх уже собранного понимания проекта и только дозаполняет локальный overlay, а не делает “полный ресерч с нуля” на каждый вопрос.
- `Question Run` ещё сильнее сдвинут в baseline-first модель:
  - перед открытием файлов вопрос теперь сначала строит `question workspace plan` из `baseline graph`, `baseline index`, `Git changed set` и task tokens;
  - если graph/index seed достаточно плотный, чат открывает только `task-relevant + graph-neighbor + overlay` пути;
  - если seed слабый, система открывает маленький `baseline discovery slice` из `routes/config/controllers/services/models/middlewares`, а не полный проект;
  - полный workspace остаётся только последним fallback-сценарием;
  - это ещё сильнее приближает продукт к целевой модели: проект изучается заранее в фоне, а вопрос только навигирует по уже собранной карте и локальному overlay.
- Answer-first UX усилен provenance-слоем на главном экране:
  - основной chat-ответ теперь сразу показывает, является ли вывод `Baseline First` или `Baseline + Overlay`;
  - рядом с ответом отображается компактная provenance summary по `baseline / overlay / structural` фактам;
  - пользователь больше не обязан открывать `Inspector`, чтобы понять, опирается ли ответ на локальные незакоммиченные изменения;
  - `Inspector` остаётся deep-debug surface, но базовая честность происхождения ответа вынесена прямо в primary chat UX.
- Runtime UX усилен состоянием готовности проекта:
  - в верхней runtime-панели теперь есть отдельный статус готовности `Фон проекта актуален` / `Нужен background sync` / `Ответ будет с локальным overlay`;
  - тот же смысл дублируется в системной заметке текстом, чтобы пользователь понимал качество текущего ответа ещё до запуска вопроса;
  - это делает branch-aware operating model видимой с первого взгляда: когда система уже знает проект, когда ей нужен фоновый sync, и когда ответ будет частично опираться на локальную незакоммиченную разработку.
- Chat UX получил более явный operational loop вокруг background sync:
  - на главном экране теперь отдельно показывается, идёт ли фоновый sync прямо сейчас, требуется ли он, или baseline уже достаточно хорош для немедленного вопроса;
  - пользователь видит не только качество текущего baseline, но и состояние самого фонового процесса: `already syncing` / `refresh recommended` / `safe to ask now`;
  - это уменьшает ощущение “чёрного ящика” и объясняет, когда ждать новый фон, а когда можно спокойно работать поверх уже собранной карты проекта.
- Answer UX усилен инженерной структурой ответа:
  - в основном сообщении AI теперь есть отдельные блоки `Подтверждено`, `Не подтверждено` и `Проверить вручную`;
  - эти блоки строятся из deterministic evidence, unknowns, provenance и operational warnings, а не из свободной генерации;
  - это делает ответ удобнее для практической инженерной работы: видно, что уже доказано, где есть пробелы и какие проверки стоит сделать руками в коде или runtime.
- Спецификация `Answer Engine` актуализирована под фактический MVP:
  - `Answer Package` теперь явно фиксирует `confirmedFacts`, `unconfirmedFacts`, `manualChecks`;
  - chat-first ответ больше не ограничивается только `summary/explanation/warnings`, а уже отражает инженерную структуру доказанности прямо в основном сообщении;
  - это выравнивает текущую реализацию с документацией и снижает риск архитектурного дрейфа между spec и кодом.
  - question pipeline закреплён как lightweight retrieval поверх уже собранной project intelligence, а не как скрытый full research pass.
- Реализация branch-aware runtime усилена в сторону committed-baseline модели:
  - `background-sync` теперь рассматривается как источник только committed baseline, а не любого последнего run;
  - baseline identity переведена на `headFingerprint`, чтобы локальные незакоммиченные изменения не создавали ложные baseline-кандидаты;
  - dirty worktree больше не должен автоматически запускать committed background sync;
  - локальные изменения теперь явно трактуются как `worktree overlay`, а не как причина пересобрать baseline;
  - API получил polling-first `Project State Monitor`, который фоново отслеживает branch/head drift по сохранённым проектам и запускает auto-sync только для чистого `HEAD`;
  - UI начал отдельно показывать `Worktree` и committed baseline readiness, чтобы оператор видел разницу между фоном проекта и текущей локальной разработкой.
- Добавлен отдельный операторский режим `hard-resync`:
  - это ручной full-pass запуск через UI-кнопку `Хард ресинк`;
  - он не подменяет committed baseline-модель `background-sync`;
  - в отличие от обычного фонового sync, `hard-resync` может использоваться как страховочный полный ресерч вручную;
  - `hard-resync` намеренно не зависит от live LLM-вызова и сохраняет артефакты даже без провайдера;
  - обычный `question-run` остаётся answer-first контуром, а `background-sync` и `hard-resync` — режимами подготовки/переcборки project intelligence.
- Главная chat-first поверхность очищена от дублирующих rebuild-действий:
  - `Обновить` оставлен только как refresh текущего project state в UI;
  - ручной rebuild на главной панели теперь один — `Хард ресинк`;
  - `background-sync` остаётся внутренним и автоматическим committed-baseline механизмом.
- `question-run` дополнительно усилен в сторону graph-first retrieval:
  - selective candidate set теперь опирается не только на task tokens, Git changed set и previous index;
  - в него начали попадать file paths, подтверждённые предыдущим graph state;
  - для matched graph-узлов теперь автоматически подтягиваются соседние file-backed узлы, что уменьшает зависимость question path от грубого structural fallback.
- `question-run` ещё сильнее смещён в сторону baseline-driven narrowing:
  - structural fallback-paths теперь подключаются только если graph seed и repository-scoped seed оказались слишком слабыми;
  - при плотном graph seed question runtime должен открывать именно graph-relevant overlay, а не широкий набор типовых директорий;
  - research report теперь явно сообщает, работал ли вопрос в `graph-first` режиме или был вынужден частично добирать candidate set через fallback.
- Сделан первый шаг целевой архитектуры `008-next-generation-architecture.md` (Slice 4 — Persistent Structural Foundation):
  - конфигурационные сущности проекта **остаются в PostgreSQL**: `Project`, `ProjectPath`, `Provider`, `knowledge_catalog`, `project_facts` живут в Postgres и инициализируются через `apps/api/src/postgres-client.ts`;
  - добавлен `apps/api/src/graph-store.ts` — первый персистентный слой для `GraphState`: после стадии `graph` в pipeline снапшот узлов и рёбер сохраняется в Neo4j (`GraphNode`/`RELATES`) и переживает перезапуск API-процесса;
  - тем самым фактическая модель хранения теперь чётко разделена:
    - **PostgreSQL** = проекты, пути, провайдеры и metadata/runtime catalog;
    - **Neo4j graph** = project intelligence и структурная карта кода;
  - это устраняет главный зафиксированный архитектурный разрыв MVP — Graph был in-memory и не персистентным (см. `002-storage.md` и предыдущую версию раздела "Что пока ограничено");
  - важное уточнение: это ещё не полная snapshot+overlay модель по коммитам из `008`, раздел 6.2 — сейчас Neo4j хранит один актуальный срез на projectId, который полностью перезаписывается на каждый успешный run; runtime graph queries (`packages/graph`) по-прежнему выполняются над in-memory структурой текущего run, а не читают напрямую из Neo4j;
  - persistence в Neo4j намеренно неблокирующая: сбой записи графа не должен прерывать pipeline run (см. `persistGraphSnapshotSafely` в `apps/api/src/pipeline-runner.ts`);
  - `/api/health` теперь возвращает `neo4jConnected` и `postgresConnected` для быстрой диагностики обоих слоёв хранения.
- Frontend получил проходной ремонт навигации и визуальной согласованности после регрессии, замеченной при ручном тестировании:
  - добавлен настоящий client-side роутинг (`react-router-dom`): `/chat`, `/chat/:runId`, `/projects`, `/providers` — URL теперь всегда отражает текущий экран и конкретный открытый run, включая поддержку прямых ссылок (deep link) и навигации назад/вперёд браузера;
  - кнопка `Новый чат` в истории раньше не имела обработчика и не делала ничего — теперь она сбрасывает текущий диалог и переводит на `/chat`;
  - добавлено явное пустое состояние `Сначала добавь проект` на главном экране чата, если у пользователя ещё нет ни одного сохранённого проекта, с прямым CTA `Добавить проект`, ведущим на `/projects` — раньше при отсутствии проектов пользователь видел пустые выпадающие списки без объяснения, что делать;
  - кнопка отправки вопроса теперь дизейблится и явно поясняет `Сначала выбери проект`, если проект не выбран, вместо разрешения отправить вопрос в пустоту;
  - исправлены отсутствующие CSS-классы, из-за которых часть интерфейса рендерилась без стилей: `.chat-suggestions` (подсказки вопросов в пустом состоянии чата) и восстановлены рабочие классы `ErrorBoundary` (использовал `.shell/.panel/.panel-form/.actions`, которых не существовало в `styles.css` — теперь использует реальные классы `app-shell/settings-card/action-row`);
  - удалён неиспользуемый (осиротевший от предыдущего рефакторинга) код: JS-функции `buildAnswerProvenanceSummary`, `buildAnswerProvenanceLabel`, `shortCommit`, `backgroundFreshnessLabel`, `backgroundSyncLabel`, `baselineSourceLabel` и CSS-классы `.runtime-pill`, `.system-note`, `.provenance-card`, `.provenance-chip`, `.answer-sections`, `.answer-section-card`, `.empty-grid`, `.empty-state`, `.compact-stack`, `.composer-status`, `.runtime-meta`, `.runtime-inline-button`, `.app-sidebar`, `.sidebar-card`, `.provider-card` — определялись, но нигде не рендерились/не применялись, создавая ложное ощущение недостроенного интерфейса при чтении кода;
  - подпись состояния рабочего дерева в composer переведена на человекочитаемый лейбл (`worktreeStatusLabel`) вместо сравнения технического enum-значения напрямую в JSX.

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
22. хранить и показывать branch-aware background state проекта как часть runtime-контракта между Git, Knowledge, API и UI.
23. выполнять принудительную пересборку project intelligence из UI без ручного редактирования конфигурации или прямого вызова backend endpoint.
24. хранить проекты в PostgreSQL как отдельные сущности с `1:N` именованными путями.
25. управлять проектами и провайдерами через отдельные страницы GUI, а не через перегруженный основной экран чата.
26. различать `background-sync` и `question-run` как отдельные runtime-режимы в API, knowledge artifacts и UI.
27. автоматически поднимать фоновую пересборку project intelligence при устаревшем или отсутствующем baseline.
28. отвечать через подключённый live LLM runtime поверх `Research -> Impact -> Context -> Plan`, а при ошибке провайдера честно откатываться к deterministic fallback answer.
29. использовать новый спокойный chat shell как основную пользовательскую поверхность вместо старого перегруженного operator-facing экрана.

## Что пока ограничено

- Indexer пока поддерживает только часть форматов на практическом уровне:
  - TypeScript
  - JavaScript
  - JSON
  - Markdown
- Остальные языки архитектурно предусмотрены, но ещё не реализованы полноценно.
- Graph теперь персистентен между перезапусками процесса (Neo4j, см. раздел "Что уже реализовано"), но это пока единый актуальный срез на проект (полная перезапись при каждом run), а не snapshot+overlay модель по коммитам из `008-next-generation-architecture.md`. Version layer и полноценный Cypher-driven query engine поверх Neo4j ещё не реализованы — runtime-запросы графа (`packages/graph`) по-прежнему работают над in-memory структурой текущего run.
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
- Provider/runtime контур уже выполняет реальные live-вызовы модели, но пока ещё ограничен по observability и runtime-governance:
  - нет полноценного cost dashboard;
  - нет rich rate-limit analytics по провайдерам и моделям;
  - нет отдельного provider health/history слоя уровня production runtime platform.
- Chat-first UX уже показывает branch-aware readiness проекта, но сами question-time исследования всё ещё запускают полный pipeline run; следующий шаг — отделить background refresh от лёгкого question answering поверх готового state.
- Проект пока использует первый путь сохранённого `Project` как активный runtime-root для чата; полноценная multi-path orchestration внутри одного общего branch-aware run ещё не реализована.
- `question-run` уже отделён от `background-sync` по runtime-контракту, но semantic lightweight path пока остаётся MVP-уровня: он всё ещё использует тот же базовый pipeline и пока не заменён полноценным overlay-native research engine.
- Lightweight question path уже сужает workspace, но `Research`, `Impact` и `Context` всё ещё работают поверх прежних модулей и пока не имеют отдельного overlay-native semantic движка с branch-scoped memory slices.
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
- Mutation/runtime loop по-прежнему отсутствует:
  - MVP пока сознательно не пишет код и не вносит изменения в проект;
  - `Execution Preview` остаётся превью-поверхностью, а не реальным executor-слоем;
  - post-change orchestration остаётся следующей фазой, а не частью текущего MVP.
- Live answer runtime уже работает, но сам answer-слой ещё требует усиления:
  - follow-up continuity между сообщениями остаётся слабой;
  - формулировки ответа ещё не всегда достаточно “человеческие” на больших и шумных репозиториях;
  - `Inspector` всё ещё остаётся техническим и требует дальнейшего product pass;
  - нужны дополнительные quality passes для реальных кейсов на больших PHP-репозиториях.
- Навигация получила настоящий client-side роутинг (`/chat`, `/chat/:runId`, `/projects`, `/providers`), но остаётся минимальной:
  - нет отдельных URL для конкретного `projectId`/`providerId` (переключение проекта/провайдера не отражается в адресной строке);
  - `Новый чат` не создаёт отдельную сущность диалога — это просто сброс текущего локального состояния UI, полноценной модели "нескольких параллельных чатов" не существует;
  - страницы `/projects` и `/providers` остаются формами CRUD без собственной вложенной маршрутизации (например, отдельного URL на редактирование конкретного проекта).
- Найден и исправлен критический баг доверия к проекту (2026-07-12): `POST /api/pipeline/run` ранее тихо откатывался на `appRootPath` (директорию, где запущен сам backend-процесс), если ни `projectId`, ни `projectPath` не резолвились в валидный проект — вместо явной ошибки. Это могло приводить к тому, что ответ формировался по совершенно другому, не выбранному пользователем проекту, без какого-либо сигнала об этом в интерфейсе. Исправлено:
  - `/api/pipeline/run` теперь явно отвечает `400`/`404`, если проект не резолвится, вместо молчаливого fallback;
  - фронтенд (`submitPipelineRun`, `triggerBackgroundSync`) больше не отправляет запрос без валидного `selectedProjectId`/`projectPath`;
  - имя проекта теперь явно показывается и в сообщении пользователя, и в ответе ассистента в чате (`UserTaskMessage`, `AssistantRunMessage`) — чтобы рассинхронизация состояния была видна сразу, а не только через Inspector.
- Устранение project-specific оверфита (2026-07-13): обнаружена и полностью удалена ветка `billingRollbackFocus` — параллельный, захардкоженный под один реальный бэкенд (`magendamd_backend`) путь анализа, накопившийся за несколько предыдущих сессий и пронизывавший 5 пакетов (`indexer`, `graph`, `research`, `context`, `ai`, суммарно ~800 строк). Найдено при разборе жалобы пользователя на формулировку одного конкретного ответа. Удалено целиком; domain-detection для billing-вопросов остался только через уже существующий generic-механизм `INTENT_PROFILES`. Живой прогон на magendamd_backend после удаления подтвердил, что качество результата не пострадало (нужный код по-прежнему находится первым по релевантности). Подробности и разбор по пакетам — `docs/architecture/010-senior-developer-capability-roadmap.md`, раздел 7.
- Тон ответа дочищен (2026-07-13): из `packages/research` убраны оставшиеся "отчёт-генераторские" формулировки в findings/summary (внутренний жаргон вида "эвристики отдали приоритет модулю", бессмысленная для пользователя мета-информация про детерминированность/воспроизводимость research-отчёта) — заменены на разговорные формулировки того же уровня детализации.
- Найден и исправлен баг избыточного срабатывания evidence-locked режима (2026-07-13): `buildUnknowns` (`packages/research`) считал два чисто служебных сигнала о ходе research ("Selective workspace limit достигнут" от indexer'а, "graph seed недостаточно плотный") эпистемической неуверенностью в ответе, из-за чего `shouldForceEvidenceLockedMode` почти всегда принудительно отключал LLM-синтез в пользу deterministic fallback — независимо от реального объёма evidence. Подтверждено вживую: вопрос с 12 evidence-элементами уходил в deterministic fallback только из-за одной служебной заметки о графе. Исправлено — оба сигнала убраны из `unknowns`, там остались только признаки реальной неуверенности (нет evidence, нет модуля, реальные сбои индексации и т.п.).
- Ручной стресс-тест на magendamd_backend (2026-07-13) вскрыл и позволил починить баг поиска по составным PascalCase-именам (`DataEntry`, `LastVisitReminder`): камелкейс-разбиение таких имён на фрагменты ("data"+"entry") добавляло каждый фрагмент как независимый токен, а короткий общий фрагмент ("data") совпадает с путём `Containers/*/Data/...` практически любого контейнера в этой Laravel-кодовой базе — реальный файл тонул в сотнях случайных совпадений и не проходил ни в отбор кандидатных файлов для question-run (`buildQuestionWorkspacePlan`, `apps/api/src/pipeline-runner.ts`), ни в финальный скоринг evidence (`scoreText`, `packages/shared` + `packages/research`). Исправлено на обоих уровнях: фрагменты одного составного слова теперь матчатся только все сразу (AND-группой), а не по одному — добавлена `scoreTextGroups` рядом с `scoreText` (generic-фикс, применим к любому проекту с составными именами сущностей, ничего специфичного под magenda). Живой прогон подтвердил резкое улучшение: вопрос про `DataEntry` — с 0 релевантных файлов до top-1 совпадения (`Clinic.dataEntry`, score 98); вопрос про `LastVisitReminder` — с 0 до 7 из 12 evidence-элементов из нужного контейнера.
- Тем же стресс-тестом (2026-07-13) найден и исправлен второй, более глубокий перекос question-run retrieval для больших baseline-driven репозиториев: точная сущность `ChiroNotes` могла проигрывать соседнему домену `AcuNotes` не из-за токенизации, а из-за порядка сборки selective workspace slice. До фикса `buildQuestionWorkspacePlan()` слишком рано и слишком широко вливал `graphNeighborPaths` в `primaryPaths`, поэтому более связанный в графе домен успевал занять бюджет candidate paths раньше, чем прямые token/symbol/path matches по редкой, но точной сущности. Исправлено на уровне алгоритма, а не точечного hotfix:
  - direct matches (`previousSymbolMatchedPaths`, `graphMatchedPaths`, `tokenMatchedPaths`, `previousIndexPaths`) сначала объединяются в отдельное опорное ядро;
  - question-run теперь резервирует обязательный budget под это direct-match ядро;
  - `graph-neighbor` expansion больше не конкурирует с точной сущностью на равных, а добавляется дозированно и только как controlled expansion вокруг уже найденного ядра;
  - Git-scoped overlay по-прежнему остаётся самым ранним источником candidate paths, но graph перестал подменять собой сущностный retrieval.
  Это выравнивает question-run под реальную цель продукта: сначала точно понять, о какой сущности/фиче спрашивает пользователь, и только потом расширять инженерный контекст графом. Фикс сделан generic-образом в `apps/api/src/pipeline-runner.ts`, без project-specific логики под magenda.
- Chat/runtime long-run UX усилен для больших репозиториев (2026-07-13): найдено, что пользовательский сценарий "проект долго думает" ломался не только из-за тяжёлого pipeline, но и из-за поведения фронтенда. `pollPipelineStatus()` (`apps/web/src/App.tsx`) считал любой timeout или кратковременный сетевой сбой polling-запроса фатальным падением run и показывал ошибку уровня "сервер завис", хотя сам backend-run мог продолжать нормально выполняться. Исправлено:
  - transient timeout/network ошибки polling-а теперь считаются временными и не переводят чат в failed-state;
  - polling продолжает ждать status endpoint и сохраняет живой thinking-state вместо ложного "pipeline упал";
  - во время активного run заблокированы composer textarea и environment selectors/top-nav, чтобы UX соответствовал режиму "AI-агент сейчас исследует проект" и пользователь не создавал конкурирующие смены проекта/провайдера/пути во время одного thinking-цикла.
  Это не отменяет необходимость дальнейшей работы над long-running pipeline на больших репозиториях, но уже убирает класс ложных timeout-падений на стороне chat UX и приближает продукт к целевому agent-like поведению.
- Research retrieval усилен exact-entity слоем (2026-07-13): поверх уже сделанных token-group и graph-neighbor правок добавлен отдельный first-class сигнал "точная сущность из вопроса". `packages/research/src/index.ts` теперь извлекает entity hints из составных/характерных имён (`ChiroNotes`, `LastVisitReminder`, похожие feature/class/symbol names) и протаскивает их через scoring файлов, символов, route-узлов и module-узлов. Практический смысл:
  - редкая точная сущность больше не растворяется в общем token/profile mix;
  - symbol/file, где сущность совпадает целиком или почти целиком, получают сильный приоритет ещё до LLM-синтеза;
  - retrieval становится ближе к поведению сильного разработчика-исследователя: сначала поднять exact feature/class/entity, потом уже расширять картину модулями, графом и общими structural hints.
  Фикс generic, не привязан к одному проекту и особенно полезен для больших кодовых баз с множеством соседних доменных сущностей.
- Research evidence ranking получил file-aware diversification pass (2026-07-13): top evidence больше не набирается простым `sort(score) -> slice(12)`. В `packages/research/src/index.ts` добавлен отдельный отборщик `selectTopEvidence()`, который старается сначала собрать несколько независимых file-backed anchors, а не забить верх списка несколькими средними совпадениями из одного и того же файла. Это делает answer/pлан/impact устойчивее:
  - evidence чаще покрывает несколько разных structural опор, а не один перегретый файл;
  - reasoning лучше имитирует поведение сильного разработчика, который ищет подтверждение в нескольких местах системы;
  - downstream слои (`findings`, `confidence`, `Answer Engine`, validation) получают более разнообразный и менее "туннельный" набор доказательств.

## Новая декларативная система классификации вопросов (2026-07-10)

Добавлена полностью новая архитектура классификации вопросов в пакет `packages/research`:

### QuestionTypeRegistry (`question-types.ts`)
- **12 типов вопросов**: `existence`, `schema`, `location`, `flow`, `configuration`, `inventory`, `impact`, `why`, `comparison`, `fix`, `history`, `unknown`
- Декларативная регистрация через `registerQuestionType()` — новые типы добавляются без изменения кода
- Паттерны матчинга с весами, required/exclude keywords
- Каждый тип имеет дефолтные search profiles и contextual profiles для уточнения

### SearchProfileRegistry (`search-profiles.ts`)
- **5 профилей поиска**: `storage-topology`, `config-inventory`, `entrypoint-traversal`, `localization-inventory`, `broad-scan`
- Цели поиска (`SearchGoal`) с приоритетами, паттернами, путями, ограничениями и контекстуальными ключами
- Декларативная регистрация через `registerSearchProfile()`
- Фильтрация целей по контексту вопроса

### QuestionClassifier (`question-classifier.ts`)
- Единая точка входа: `classify(question, input?) → ClassificationResult`
- Объединяет QuestionTypeRegistry + SearchProfileRegistry
- Возвращает: questionType, confidence, searchProfiles[], searchGoals[], reasoning, contextKeys[]
- Специфичные правила для известных комбинаций (Google OAuth, Redis, WebSocket, Model schema, Auth existence)

### Новые Intent Profiles в Research (`index.ts`)
Добавлены 4 новых профиля намерений:
- **model-schema** — модели, схемы, сущности, поля, отношения (belongsTo, hasMany, morphMany и т.д.)
- **auth-inventory** — Google OAuth, Socialite, провайдеры авторизации
- **websocket-inventory** — WebSocket, Pusher, Laravel Echo, broadcast, channels, realtime
- **redis-inventory** — Redis, cache, session, queue, jobs, workers

### Новые функции классификации и бустинга
- `isModelSchemaQuestion()`, `isAuthInventoryQuestion()`, `isWebsocketInventoryQuestion()`, `isRedisInventoryQuestion()`
- File/symbol/route boost/penalty функции для каждого нового профиля
- Интеграция в `runResearch()` scoring loops

### Преимущества новой архитектуры
1. **Расширяемость** — новые типы вопросов и профили поиска добавляются декларативно
2. **Чёткое разделение** — Question Type (семантика) → Search Profiles (стратегия) → Search Goals (конкретные цели)
3. **Контекстуальность** — профили адаптируются под доменные ключи в вопросе
4. **Наблюдаемость** — `reasoning` в ClassificationResult показывает полную цепочку принятия решения
5. **Замена старой системы** — заменяет `classifyIntent()` + `buildInitialSearchPlan()` на единый типизированный pipeline

### Критический баг обнаружен и исправлен (2026-07-12): `\b` не работает с кириллицей

Обнаружено при разборе реального сбоя ответа (вопрос на русском ушёл в `broad-unknown` вместо точной классификации): в JavaScript `\w` (и, следовательно, `\b` — граница слова) по умолчанию покрывает только латиницу, цифры и `_` — кириллица в `\w` не входит. Из-за этого **все** русскоязычные ключевые слова во всех паттернах `QuestionTypeRegistry` (`где`, `почему`, `есть ли`, `как настроен` и т.д.) фактически никогда не совпадали через `\b(...)\b/i` — единственная причина, почему что-то иногда матчилось, — случайное соседство с латинским словом в смешанной RU/EN фразе. Практически любой чисто русский вопрос проваливался в fallback `unknown` → `intentClass: "broad-unknown"` → broad repository scan, что и производило избыточно длинные, шаблонные, слабо релевантные ответы независимо от того, насколько узким был реальный вопрос пользователя.

Исправлено в `QuestionTypeRegistry.classify()` (`packages/research/src/question-types.ts`): добавлена unicode-aware трансляция `\b` → explicit lookaround-граница (`(?:(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_])|(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_]))`, флаг `u`), кэшируемая по паттерну, без переписывания самих regex-источников. Дополнительно расширен паттерн `flow` (добавлены формы "в каком случае", "при каких условиях", "надо подтвердить" и т.п.) и паттерн `configuration` (словоформы "настроена/настроено" через `[а-яё]*` — тот же `\w`-пробел существует и в квантификаторах суффиксов, не только в `\b`). Проверено на 8 репрезентативных русскоязычных вопросах разных типов — все теперь классифицируются корректно вместо falling back в `unknown`.

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

- стабилизировать `question-run` на больших репозиториях, чтобы вопрос действительно работал поверх готового baseline + overlay, а не ощущался как скрытый full research;
- дожать качество `Research` на реальных рабочих кейсах, особенно для behavioral/runtime вопросов и нестандартных enterprise-архитектур;
- почистить `Impact`, чтобы он не раздувал answer scope нерелевантными файлами и соседними доменами;
- усилить `Context Builder`, чтобы в `Context Package` попадал только действительно полезный материал под текущий вопрос и token budget;
- сделать `Planner` практически полезным как инженерный план реализации, а не просто как формально корректную структуру;
- отполировать финальный `Answer`, чтобы он читался как сильный ответ AI-помощника, а не как технический отчёт;
- продолжить branch-aware background intelligence:
  - углубить baseline reuse;
  - усилить lightweight overlay для локальных незакоммиченных изменений;
  - довести hard resync / background sync / question-run до полностью понятной и устойчивой модели;
- продолжить staged runtime для больших репозиториев:
  - углубить `incremental index plan` до symbol-aware incremental index и AST reuse;
  - углубить `graph invalidation plan` до partial graph refresh поверх предыдущего graph state;
  - вынести retention/cleanup policy в конфигурационный слой;
  - усилить data-shape validation между API, сохранёнными артефактами и UI.
