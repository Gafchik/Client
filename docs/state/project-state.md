# Project State

**Дата обновления:** 2026-07-08  
**Текущий этап:** MVP / Slice 1

## Что уже реализовано

- Базовый monorepo foundation на `apps/api`, `apps/web`, `packages/*`.
- Рабочий структурный pipeline:
  - `Workspace`
  - `Index`
  - `Graph`
  - `Research`
  - `Impact`
  - `Knowledge`
- Русскоязычный операторский интерфейс для первого контура.
- В операторском интерфейсе добавлен runtime-config слой для будущего AI provider integration:
  - `Base URL провайдера`
  - `Название модели`
  - `API ключ`
  - значения проходят через UI, API и knowledge artifacts как будущий execution/provider runtime input.
- Центральное хранение артефактов внутри проекта `client`, а не внутри внешних тестируемых репозиториев.
- Сохранение истории запусков по каждому анализируемому проекту.
- Просмотр сохранённых запусков в UI.
- Отображение стадий pipeline в UI.
- Отображение ignored paths и diagnostics в UI.
- Project-aware отображение текущего анализируемого проекта.
- Расширенный artifacts viewer для сохранённых run-артефактов.
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
- Performance-pass для больших проектов:
  - лёгкий project overview scan без чтения содержимого файлов;
  - исключение тяжёлых директорий вроде `vendor`;
  - ограничение на слишком большие файлы;
  - снят повторный полный rescan после завершения run.
- Backward compatibility для старых run-артефактов без `Context Package`, `Execution Plan` и `Execution Preview`.
- Frontend reliability pass:
  - `ErrorBoundary`;
  - fallback screen вместо белого экрана;
  - runtime failure logging в browser console;
  - widget-level guards и мягкая деградация отдельных панелей при неполных или старых артефактах.

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
- Context Builder уже использует priority-based ranking и explainable selection, но пока без model-aware tokenization и без полноценного semantic reranking.
- Context Builder стал zone-aware и лучше отражает functional grouping, но пока без model-aware tokenization и без полноценного semantic reranking.
- Context Builder уже умеет удерживать баланс между summary и structural anchors, но пока не строит model-specific chunk shapes и не использует semantic deduplication на уровне смысла.
- Context Builder теперь учитывает query profile Research как фильтр против нерелевантных файлов, но всё ещё нуждается в semantic chunking и в более точном token budgeting под конкретные модели.
- Planner теперь строит richer graph-backed deterministic plan, но всё ещё без полноценного execution runtime, rollback orchestration и live replanning.
- Planner уже чувствителен к типу исследовательского профиля, но ещё не использует формальный rollback-plan и pre-execution blocking rules по confidence/unknowns.
- Execution layer пока представлен только safe preview, без фактической мутации файлов.
- Provider runtime config уже собирается и сохраняется вместе с запуском, но фактический live-вызов модели ещё не подключён.
- История запусков пока строится из локально сохранённых JSON-артефактов.
- Фронт теперь защищён от полного белого экрана и от большинства partial-data сбоев на уровне отдельных виджетов, но всё ещё требует дальнейшего hardening UI-flow.

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

- начать controlled execution runtime вместо одного preview-слоя;
- добавить deterministic scope guard и write boundary перед фактической мутацией файлов;
- подготовить post-change reindex, graph refresh и knowledge refresh orchestration;
- усилить data-shape validation между API, сохранёнными артефактами и UI.
- углубить functional research, чтобы feature-level understanding было точнее и менее эвристическим.
- добавить model-aware token budgeting и semantic reranking в Context Builder.
- углубить Context Builder до graph-backed dependency expansion внутри query profile, а не только path/rule-based ranking.
- продолжить graph-core evolution до уровня, удобного для переноса в БД.
- продолжить graph-core evolution до richer relation semantics, snapshot/version layer и query surface, пригодных для будущего DB-backed graph storage.
- продолжить перенос Research с file/content heuristics на более явный graph-first traversal и query-profile-specific expansion.
