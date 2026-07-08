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
- Impact evolution pass:
  - impact начал расширять scope через file dependencies/dependents, а не только через прямых соседей evidence-узлов.
- Safe execution preview без реальной модификации проекта.
- Functional Research MVP:
  - `Research Report` теперь включает functional summary;
  - выделяются entry points, primary entities, side effects и data sources;
  - functional facts прокидываются в `Context Package` и отображаются в UI.
- Graph core evolution pass:
  - runtime graph расширен до `repository/module/folder/file/code nodes`;
  - добавлены типизированные code nodes вместо одного обобщённого `symbol`;
  - появились derived module relations и graph query helpers под будущий persistent graph storage;
  - graph начал различать richer structural semantics: `CALLS`, `USES`, `EXTENDS`, `IMPLEMENTS`, а не только плоские `REFERENCES`;
  - query layer теперь умеет отдавать module dependency neighbors, file dependencies/dependents, symbol dependencies/dependents, entry-point neighbors и relation summaries для downstream-модулей.
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
- Context Builder уже использует priority-based ranking и explainable selection, но пока без model-aware tokenization и без полноценного semantic reranking.
- Context Builder стал zone-aware и лучше отражает functional grouping, но пока без model-aware tokenization и без полноценного semantic reranking.
- Planner теперь строит richer graph-backed deterministic plan, но всё ещё без полноценного execution runtime, rollback orchestration и live replanning.
- Execution layer пока представлен только safe preview, без фактической мутации файлов.
- История запусков пока строится из локально сохранённых JSON-артефактов.
- Фронт теперь защищён от полного белого экрана и от большинства partial-data сбоев на уровне отдельных виджетов, но всё ещё требует дальнейшего hardening UI-flow.

## Где хранятся артефакты

Артефакты хранятся централизованно внутри:

`/Users/evgenii/Desktop/client/.client/knowledge/projects/<project-key>/`

Это сделано специально, чтобы:

- не загрязнять тестируемые проекты служебными файлами;
- хранить историю запусков в одном месте;
- поддерживать проектно-изолированную историю run-артефактов.

## Ближайший следующий шаг

Следующий этап после текущего MVP expansion pass:

- начать отдельный evolution pass по Planner;
- подготовить controlled execution runtime вместо одного preview-слоя.
- углубить planner до dependency-aware и graph-backed sequencing на уровне реальных structural relations.
- продолжить углубление planner от первых file/symbol-backed chains к более плотному route/controller/service/request sequencing перед controlled execution runtime.
- усилить data-shape validation между API, сохранёнными артефактами и UI.
- углубить functional research, чтобы feature-level understanding было точнее и менее эвристическим.
- добавить model-aware token budgeting и semantic reranking в Context Builder.
- продолжить graph-core evolution до уровня, удобного для переноса в БД.
- продолжить graph-core evolution до richer relation semantics, snapshot/version layer и query surface, пригодных для будущего DB-backed graph storage.
