# Indexer

**Статус:** Draft  
**Автор:** Principal Engineering Specification  
**Дата:** 2026-07-17  
**Версия:** 1.1.0  
**Зависимости:** [000-overview.md](/Users/evgenii/Desktop/client/docs/architecture/000-overview.md), [001-domain-model.md](/Users/evgenii/Desktop/client/docs/architecture/001-domain-model.md), [002-storage.md](/Users/evgenii/Desktop/client/docs/architecture/002-storage.md), [003-event-system.md](/Users/evgenii/Desktop/client/docs/architecture/003-event-system.md)

---

## Оглавление

1. [Назначение](#1-назначение)
2. [Ответственность](#2-ответственность)
3. [Входные данные](#3-входные-данные)
4. [Выходные данные](#4-выходные-данные)
   - [4.6 Index Manifest](#46-index-manifest)
5. [Архитектура Indexer](#5-архитектура-indexer)
   - [5.9 Plugin API для расширений](#59-plugin-api-для-расширений)
6. [Полный Pipeline](#6-полный-pipeline)
7. [Полное индексирование](#7-полное-индексирование)
8. [Инкрементальное индексирование](#8-инкрементальное-индексирование)
   - [8.6 Подробный Pipeline Incremental Index](#86-подробный-pipeline-incremental-index)
9. [Поддержка языков](#9-поддержка-языков)
10. [AST](#10-ast)
11. [Symbol Extraction](#11-symbol-extraction)
   - [11.7 Stable Symbol IDs](#117-stable-symbol-ids)
12. [Dependency Analysis](#12-dependency-analysis)
13. [Graph Synchronization](#13-graph-synchronization)
   - [13.4 Symbol Diff перед обновлением Graph](#134-symbol-diff-перед-обновлением-graph)
14. [Производительность](#14-производительность)
   - [14.2 AST Cache и Parse Cache](#142-ast-cache-и-parse-cache)
15. [Отказоустойчивость](#15-отказоустойчивость)
   - [15.7 Diagnostics и Statistics](#157-diagnostics-и-statistics)
16. [Будущее развитие](#16-будущее-развитие)

---

## 1. Назначение

Indexer — это модуль структурного понимания кодовой базы. Его задача — превратить проект, существующий как набор файлов, директорий, конфигураций и Git-истории, в формализованное, машиночитаемое представление структуры кода, пригодное для навигации, анализа влияния, построения контекста и накопления знаний.

Если Workspace и Repository дают системе доступ к исходному материалу, то Indexer превращает этот материал в инженерную модель проекта. Он определяет, какие сущности реально существуют в коде, где они объявлены, как они связаны между собой и какие изменения в кодовой базе должны приводить к обновлению производных данных.

Главная проблема, которую решает Indexer, заключается в том, что реальный проект не является самоописательным для остальных модулей платформы. Файловая система знает только о файлах и папках. Git знает о коммитах и diff. Отдельные парсеры знают только синтаксис конкретного языка. Но ни один из этих источников сам по себе не даёт целостной картины: где находится символ, какой модуль зависит от другого, какой маршрут связан с каким контроллером, какой компонент использует какой API, какие миграции меняют какие таблицы.

Indexer является фундаментом всей платформы по трём причинам:

1. Все модули более высокого уровня опираются не на сырой код, а на структурированное представление проекта.
2. Graph не может быть консистентно построен без канонического источника структурных изменений.
3. Research, Context Builder, Planner, Impact Analysis и Knowledge теряют точность, если система не понимает текущее состояние кода на уровне сущностей и отношений.

Иными словами, Indexer — это источник структурной истины о кодовой базе. Он не принимает архитектурных решений, не меняет код и не интерпретирует бизнес-смысл изменений. Он отвечает за одно: достоверно, воспроизводимо и масштабируемо извлекать структуру проекта из его исходного состояния.

---

## 2. Ответственность

### Что входит в обязанности Indexer

- Обнаружение состава проекта: файлов, директорий, модулей, языков, конфигураций, точек входа и технических границ индексации.
- Определение, какие файлы подлежат индексации, а какие должны быть исключены по правилам проекта.
- Определение языка и соответствующего механизма анализа для каждого поддерживаемого файла.
- Построение или получение AST для поддерживаемых форматов.
- Извлечение структурных сущностей: файлов, модулей, символов, маршрутов, компонентов, схем данных, миграций и других представлений, определённых Domain Model.
- Извлечение структурных отношений: принадлежность, объявление, импорт, зависимость, наследование, реализация, композиция, вызов, использование, экспорт, маршрутизация, миграционные изменения.
- Построение индексных артефактов, достаточных для обновления Graph и повторного использования в инкрементальном режиме.
- Определение дельты между предыдущим и текущим состоянием файла или проекта.
- Публикация событий индексирования в Event Bus.
- Управление собственными кэшами, версиями артефактов индексирования и состоянием incremental pipeline.
- Фиксация ошибок индексирования, частичных деградаций и зон неизвестности.

### Что НЕ входит в обязанности Indexer

- Не хранит и не обслуживает Graph как авторитетное хранилище. Graph остаётся отдельным модулем.
- Не принимает решения о том, как именно модуль Graph будет материализовывать узлы и рёбра в Neo4j.
- Не изменяет исходный код, конфигурации проекта или Git-состояние.
- Не выполняет динамический анализ, запуск кода, тестов, контейнеров или приложений.
- Не проводит семантическое исследование внешней документации и не создаёт Knowledge.
- Не строит пользовательский контекст для LLM напрямую, а только поставляет структурные данные для этого.
- Не определяет архитектурную корректность проекта как policy engine; он лишь извлекает факты и отношения, на основе которых другие модули могут обнаруживать нарушения.
- Не является API-слоем и не определяет внешние контракты взаимодействия человека с системой.

Граница ответственности принципиальна: Indexer отвечает за извлечение фактов из кода, но не за интерпретацию этих фактов как архитектурного решения, пользовательской функции или продукта анализа.

---

## 3. Входные данные

Indexer работает не с одним источником, а с совокупностью авторитетных входов. Каждый из них отвечает на свой класс вопросов.

### 3.1 Workspace

Workspace является физическим контекстом выполнения индексирования. Из него Indexer получает:

- абсолютный путь к корню проекта;
- текущее состояние файловой системы;
- состояние рабочей копии во время Run;
- sandbox-границы доступа;
- сигналы о локальных изменениях файлов;
- информацию о временных, generated и service-директориях Workspace.

Workspace важен тем, что Indexer индексирует не абстрактный репозиторий, а конкретное состояние проекта в конкретный момент времени.

### 3.2 Git Repository

Git используется как источник истории и версионной привязки.

Из Git Repository Indexer получает:

- текущий commit hash для привязки `graph_version`;
- список изменённых файлов между версиями;
- сигналы `CommitPushed`, `CommitReverted`, `RepositorySynced`;
- информацию о rename/move, если она доступна через diff;
- возможность отличать новое полное сканирование от инкрементального обновления;
- контрольные точки для повторного воспроизведения индекса.

Git не является источником структурного содержимого сам по себе, но определяет границы изменений и обеспечивает воспроизводимость состояния.

### 3.3 Filesystem

Файловая система является первичным источником содержимого файлов и иерархии проекта.

Из Filesystem Indexer получает:

- список директорий и файлов;
- содержимое индексируемых файлов;
- метаданные файлов: путь, размер, время изменения, права доступа, тип;
- наличие symlink, специальных файлов, hidden-артефактов;
- сигналы о создании, изменении, удалении и перемещении файлов.

Filesystem является источником истины для фактического содержимого кода на момент индексации.

### 3.4 Configuration

Indexer использует конфигурацию проекта как набор правил интерпретации.

Configuration включает:

- список поддерживаемых расширений и языков;
- правила include/exclude;
- `.gitignore` и дополнительные ignore-правила платформы;
- path aliases;
- корневые namespace/module boundaries;
- настройки монорепозитория;
- карты source roots;
- framework-specific conventions;
- пороги производительности;
- политику кэширования и incremental invalidation;
- флаги включения/выключения отдельных анализаторов.

Конфигурация не меняет архитектуру Indexer, но определяет, как он должен читать проект.

### 3.5 Supported Languages

Supported Languages — это не просто список расширений, а каталог доступных Language Provider-ов, через которые Indexer понимает, как анализировать конкретный файл.

На первом этапе архитектура должна предусматривать поддержку как минимум:

- PHP
- TypeScript
- JavaScript
- Vue
- JSON
- YAML
- Markdown
- SQL
- Dockerfile
- HTML
- CSS (включая SCSS/SASS/LESS)

Также архитектура должна допускать добавление любых будущих языков без изменения ядра pipeline.

По текущему состоянию реализации HTML и CSS уже распознаются как языки на уровне Language Detector (расширения `.html`/`.htm` определяются как `html`; `.css`, `.scss`, `.sass`, `.less` — как единый `LanguageId` `css`, без отдельного различения препроцессоров). Однако полноценного Language Provider для них ещё нет: файлы этих языков корректно классифицируются и попадают в `Project Scan Snapshot` и статистику по языкам, но symbol/dependency extraction для них не выполняется — файл индексируется с пустым набором symbols и imports, аналогично любому другому пока не покрытому provider-ом формату.

---

## 4. Выходные данные

Indexer производит не один артефакт, а набор взаимосвязанных индексных представлений. Эти представления используются для публикации событий и синхронизации с Graph.

### 4.1 Базовые индексные артефакты

- `Project Scan Snapshot` — снимок состава проекта на момент сканирования.
- `File Index` — канонический реестр индексируемых файлов с их идентичностью, языком, fingerprint и статусом анализа.
- `Module Index` — представление логических модулей, пакетов, namespace или source roots.
- `Folder Index` — иерархия директорий, если она материализуется как часть графовой модели.

### 4.2 Структурные индексы кода

- `Symbol Index` — все извлечённые символы с типом, FQN, областью видимости, местоположением и версией.
- `Reference Index` — ссылки на символы и другие идентифицируемые сущности.
- `Import Index` — импорты, use/import/require/include/export отношения.
- `Dependency Index` — зависимости на уровне файла, модуля и символа.
- `Inheritance Index` — наследование, реализации интерфейсов, trait/mixin usage.
- `Call Index` — связи вызова функций, методов, хуков, handlers.
- `Type Usage Index` — использование типов в сигнатурах, полях, generic-аргументах, аннотациях, атрибутах.

### 4.3 Технологические и доменные индексы

- `Route Index` — маршруты приложения и их связь с обработчиками.
- `Component Index` — UI-компоненты, их props, slots, emits, imports и composition relations.
- `Database Index` — таблицы, колонки, миграции, схемы, ORM-модели, SQL-операции.
- `Configuration Index` — значимые конфигурационные сущности, влияющие на структуру системы.
- `Documentation Index` — структурные сущности технической документации, если они участвуют в навигации или трассировке.

### 4.4 Индексы изменений и синхронизации

- `Delta Index` — различия между предыдущей и новой индексной версией файла или группы файлов.
- `Removal Set` — список сущностей и отношений, утративших актуальность.
- `Graph Update Package` — нормализованный набор изменений, достаточный для последующей материализации в Graph.
- `Index Metrics` — статистика сканирования: количество файлов, языков, символов, ошибок, время этапов.
- `Index Diagnostics` — warnings, parser failures, unsupported files, partial extractions.

### 4.5 Событийные результаты

Indexer публикует события, но не ограничивается только ими. События являются транспортом изменений, а индексные артефакты — их инженерной основой.

Ключевые результаты:

- `IndexStarted`
- `FileIndexed`
- `FileIndexFailed`
- `IndexCompleted`
- `IndexProgressUpdated`

В будущем допустимы батчевые варианты вроде `FilesBatchIndexed`, если это не ломает общий событийный контракт системы.

### 4.6 Index Manifest

`Index Manifest` — это канонический итог каждой завершённой index session. Он не заменяет внутренние snapshots и не дублирует Graph, а служит компактным управленческим артефактом, который фиксирует: что именно было проиндексировано, в каком объёме, с каким результатом и при каких версиях аналитических компонентов.

Manifest должен формироваться как для Full Index, так и для Incremental Index.

#### Назначение Index Manifest

- зафиксировать результат конкретного запуска индексирования;
- предоставить воспроизводимую контрольную точку для следующего incremental цикла;
- позволить понять, какой набор provider-ов и правил участвовал в анализе;
- дать системе быстрый способ определить, можно ли доверять текущему index state;
- обеспечить диагностику и аудит качества индексации.

#### Что должен описывать Index Manifest

Manifest концептуально должен включать:

- идентичность index session;
- `project_id`;
- `graph_version`;
- commit hash, если он известен;
- режим индексирования: full, incremental, resync;
- временные метки начала и завершения;
- состав активных Language Provider-ов и их версии;
- summary по файлам: scanned, indexed, skipped, unsupported, failed;
- summary по сущностям: symbols, references, dependencies, removals, updates;
- summary по cache usage;
- статус завершения: success, partial, failed;
- список критических diagnostics;
- trust level текущего index state.

#### Роль Manifest в архитектуре

Index Manifest не меняет архитектуру модуля. Он усиливает уже существующую модель `Index Session Manager`, `Version Manager` и `Index State Store`, добавляя единый итоговый артефакт, на который могут опираться:

- следующий incremental цикл;
- операционные инструменты;
- отладка расхождений между кодом и Graph;
- будущие механизмы resync planning.

Manifest должен быть лёгким для чтения и достаточно стабильным по структуре, чтобы служить точкой межверсийного сравнения состояния Indexer.

---

## 5. Архитектура Indexer

Indexer проектируется как внутренний конвейер специализированных компонентов. Ни один отдельный компонент не должен знать всю систему целиком; каждый отвечает за собственный срез задачи.

### 5.1 Orchestration Layer

#### Index Coordinator

Центральный оркестратор жизненного цикла индексации.

Отвечает за:

- запуск full и incremental workflow;
- удержание текущего статуса проекта;
- координацию этапов pipeline;
- публикацию верхнеуровневых событий;
- завершение и отмену индексации;
- реакцию на `ProjectOpened`, `RepositorySynced`, `CommitPushed`, `ProjectConfigUpdated`, `ResyncRequested`.

#### Index Session Manager

Управляет понятием индексной сессии.

Отвечает за:

- уникальную идентичность запуска индексирования;
- привязку к `project_id`, `graph_version`, `correlation_id`;
- накопление статистики и диагностики;
- фиксацию частичного/успешного/ошибочного завершения.

#### Work Scheduler

Планирует порядок обработки файлов и групп файлов.

Отвечает за:

- разбиение работы на очереди;
- приоритизацию файлов;
- ограничение параллелизма;
- шардирование задач по `project_id`, `module`, `file_id`;
- backpressure и batching.

### 5.2 Discovery Layer

#### Project Scanner

Первичный обход корня проекта.

Отвечает за:

- обнаружение директорий, source roots, packages, apps, services;
- формирование карты проекта;
- нормализацию путей;
- исключение неиндексируемых областей.

#### Ignore Rules Engine

Интерпретирует правила исключения.

Отвечает за:

- `.gitignore`;
- платформенные ignore-правила;
- generated/output/vendor/build/cache директории;
- пользовательские overrides;
- защиту от индексирования временных и нерелевантных артефактов.

#### Module Boundary Resolver

Определяет логические модули проекта.

Отвечает за:

- mapping директории в `Module`;
- namespace/package-based grouping;
- поддержку монорепозиториев;
- связь `File -> Module`.

### 5.3 Language Intelligence Layer

#### Language Detector

Определяет язык файла по extension, filename, shebang, directory convention или content sniffing.

#### Language Provider Registry

Реестр всех доступных Language Provider-ов.

Отвечает за:

- поиск подходящего provider для файла;
- версионирование provider-ов;
- capability negotiation;
- graceful fallback при отсутствии поддержки.

#### Provider Capability Resolver

Определяет, какие именно функции доступны для выбранного языка:

- parser;
- symbol extractor;
- dependency analyzer;
- route analyzer;
- component analyzer;
- database analyzer;
- documentation analyzer.

### 5.4 Parsing Layer

#### Parser Manager

Управляет запуском парсеров.

Отвечает за:

- выбор parser backend;
- настройку parser options;
- контроль ошибок парсинга;
- нормализацию parser diagnostics.

#### AST Builder

Создаёт AST или получает его из language-specific parser.

#### AST Normalizer

Приводит AST разных языков к унифицированной внутренней модели навигации.

#### Parse Cache

Хранит AST и parser artifacts для повторного использования.

### 5.5 Semantic Extraction Layer

#### AST Walker

Обходит AST в детерминированном порядке и вызывает специализированные extractors.

#### Symbol Extractor

Извлекает объявления и идентичность символов.

#### Scope Builder

Формирует lexical и semantic scopes:

- file scope;
- namespace scope;
- class scope;
- function scope;
- block scope;
- template/component scope.

#### Reference Resolver

Пытается сопоставить локальные и внешние ссылки с известными сущностями:

- imports;
- fully qualified names;
- aliases;
- same-file references;
- module-level exports.

#### Dependency Analyzer

Извлекает отношения зависимости между сущностями.

#### Specialized Extractors

Набор профильных анализаторов поверх общего AST:

- Route Extractor
- Component Extractor
- Database Extractor
- Migration Extractor
- Config Extractor
- Documentation Extractor
- Framework Convention Extractor

### 5.6 Change Intelligence Layer

#### Incremental Scanner

Обрабатывает изменённые файлы и определяет, какие части индекса затронуты.

#### Fingerprint Engine

Строит fingerprint для файлов, AST и извлечённых артефактов.

#### Diff Engine

Сравнивает предыдущий и новый индекс файла.

Отвечает за:

- `symbols_added`;
- `symbols_modified`;
- `symbols_removed`;
- `edges_added`;
- `edges_removed`;
- `index_status_changed`.

#### Reindex Decision Engine

Решает, нужен ли reparse, reextract, partial refresh или full rescan.

### 5.7 Persistence and Delivery Layer

#### Artifact Writer

Сохраняет внутренние индексные артефакты в собственное состояние Indexer.

#### Index State Store

Хранилище состояния индексирования.

Содержит:

- предыдущие file fingerprints;
- provider versions;
- parse diagnostics;
- symbol snapshots;
- edge snapshots;
- incremental cursors;
- status of last successful index.

#### Version Manager

Привязывает артефакты к:

- `project_id`;
- `graph_version`;
- commit hash;
- index session id;
- provider version set.

#### Event Publisher

Публикует события в Event Bus после фиксации локального состояния Indexer.

### 5.8 Reliability and Operations Layer

#### Cache Manager

Управляет AST cache, symbol cache, fingerprint cache, provider cache.

#### Error Classifier

Разделяет ошибки на recoverable и non-recoverable.

#### Diagnostics Collector

Собирает предупреждения, деградации, parser issues и unsupported constructs.

#### Telemetry Collector

Снимает:

- latency этапов;
- hit rate кэшей;
- размер очередей;
- частоту parser failures;
- объём batch write;
- долю incremental reuse.

### 5.9 Plugin API для расширений

Для расширяемости без изменения ядра Indexer должна существовать внутренняя plugin-модель подключения новых языков и анализаторов. Речь идёт не о внешнем пользовательском API, а о контракте расширения самого модуля.

#### Назначение Plugin API

- подключение новых Language Provider-ов;
- подключение новых specialized analyzer-ов;
- подключение новых symbol kinds и relation extractors;
- декларативное описание capabilities расширения;
- управляемая загрузка расширений без переписывания orchestration layer.

#### Что должен уметь plugin-контракт

Plugin-контракт должен позволять расширению объявить:

- идентичность и версию плагина;
- тип расширения: language provider, parser adapter, extractor, analyzer, diagnostics enhancer;
- список поддерживаемых файлов или языков;
- набор capabilities;
- требования к совместимости с ядром Indexer;
- правила invalidation при обновлении плагина;
- участие в parsing, extraction, diffing или diagnostics pipeline.

#### Типы подключаемых расширений

- `Language Plugin`
  Добавляет полноценный язык.

- `Analyzer Plugin`
  Добавляет специализированный анализ поверх уже поддерживаемого языка.

- `Framework Plugin`
  Добавляет знание convention-based framework constructs.

- `Diagnostics Plugin`
  Расширяет классификацию проблем и предупреждений.

- `Index Enricher Plugin`
  Добавляет дополнительные индексные представления без изменения базового pipeline.

#### Архитектурные ограничения Plugin API

Plugin API не должен позволять расширениям:

- обходить `Index Coordinator`;
- напрямую модифицировать Graph;
- нарушать versioning index state;
- публиковать произвольные события мимо Event Publisher;
- вводить неуправляемые побочные эффекты в filesystem или repository state.

Иными словами, расширение может участвовать в вычислении индексных артефактов, но не может ломать канонический жизненный цикл Indexer.

---

## 6. Полный Pipeline

Ниже описан канонический жизненный цикл индексирования от момента открытия проекта до подготовки данных для синхронизации с Graph.

### 6.1 Сквозной сценарий

```
ProjectOpened / RepositoryCloned / ResyncRequested
        │
        ▼
Index Coordinator
        │
        ├── Загружает конфигурацию проекта
        ├── Определяет режим: Full / Incremental / Resync
        ├── Создаёт Index Session
        └── Публикует IndexStarted
        │
        ▼
Project Scanner
        │
        ├── Обходит корень проекта
        ├── Применяет Ignore Rules
        ├── Строит Project Scan Snapshot
        └── Формирует список candidate files
        │
        ▼
Language Detector + Provider Registry
        │
        ├── Для каждого файла определяется язык
        ├── Выбирается Language Provider
        └── Файл направляется в соответствующую очередь обработки
        │
        ▼
Parser Manager
        │
        ├── Загружает parser/provider capabilities
        ├── Проверяет parse cache
        ├── Строит AST
        └── Нормализует parser diagnostics
        │
        ▼
AST Normalizer + AST Walker
        │
        ├── Унифицируют обход дерева
        ├── Строят scopes
        ├── Извлекают symbols
        ├── Извлекают references
        ├── Извлекают dependencies
        ├── Извлекают framework-specific entities
        └── Формируют file-level semantic snapshot
        │
        ▼
Diff Engine / Change Intelligence
        │
        ├── Сравнивает новый snapshot с предыдущим
        ├── Выделяет additions / updates / removals
        └── Формирует Graph Update Package
        │
        ▼
Artifact Writer + Index State Store
        │
        ├── Сохраняют fingerprints
        ├── Сохраняют symbol/edge snapshots
        ├── Сохраняют diagnostics
        └── Помечают file index status
        │
        ▼
Event Publisher
        │
        ├── Публикует FileIndexed / FileIndexFailed
        ├── Обновляет IndexProgressUpdated
        └── После завершения публикует IndexCompleted
        │
        ▼
Graph Manager
        │
        ├── Получает факты об изменении структуры
        ├── Материализует узлы и рёбра
        └── Публикует GraphUpdated
```

### 6.2 Логика слоёв pipeline

Pipeline Indexer намеренно разделён на пять крупных фаз:

1. `Discovery`
2. `Language Resolution`
3. `Parsing`
4. `Semantic Extraction`
5. `Change Materialization`

Это разделение необходимо для того, чтобы:

- поддерживать разные языки без изменения ядра;
- переиспользовать промежуточные результаты;
- локализовать ошибки;
- ускорять incremental workflow;
- упрощать полные Resync.

### 6.3 Переход от файла к графовой сущности

Концептуально pipeline переводит проект между несколькими уровнями представления:

```
Filesystem Object
    -> Indexable File
    -> Language-specific Source Unit
    -> AST
    -> Semantic Snapshot
    -> Symbol/Relation Delta
    -> Graph Update Package
```

Indexer не перескакивает через уровни. Это важно для воспроизводимости, диагностики и future extensibility.

---

## 7. Полное индексирование

Полное индексирование, или `Full Index`, — это процесс построения индексного состояния проекта с нуля для выбранной версии исходного кода.

### 7.1 Когда выполняется Full Index

Full Index выполняется в следующих случаях:

- первичное открытие нового проекта;
- после `RepositoryCloned`;
- при отсутствии валидного состояния предыдущей индексации;
- после несовместимого обновления Language Provider-ов;
- после изменения правил индексации, invalidating current state;
- после `ResyncRequested`;
- после обнаружения рассинхронизации, которую невозможно безопасно устранить инкрементально.

### 7.2 Цель Full Index

Цель Full Index — получить полное, целостное и внутренне непротиворечивое представление проекта для конкретной `graph_version`.

Это означает:

- каждый индексируемый файл должен быть классифицирован;
- каждый поддерживаемый файл должен быть либо успешно проанализирован, либо иметь зафиксированный failure status;
- все извлекаемые сущности должны быть нормализованы;
- зависимости должны быть вычислены с максимально доступной точностью;
- внутреннее состояние Indexer должно быть приведено к self-consistent snapshot.

### 7.3 Этапы Full Index

#### Этап 1. Инициализация сессии

- загружается последняя конфигурация проекта;
- фиксируется `graph_version`, обычно привязанная к текущему commit hash;
- создаётся новая index session;
- очищаются или изолируются очереди incremental updates;
- активируется режим полной сборки индекса.

#### Этап 2. Полный scan проекта

- выполняется обход корня проекта;
- нормализуются пути;
- применяются ignore-правила;
- выявляются source roots, module roots, config roots;
- строится полный список indexable files.

#### Этап 3. Классификация файлов

- каждому файлу назначается язык;
- выбирается provider;
- неподдерживаемые файлы маркируются как `ignored` или `unsupported`, но не блокируют workflow;
- файл распределяется в очередь обработки по типу языка.

#### Этап 4. Parsing и semantic extraction

Для каждого файла:

- загружается содержимое;
- создаётся AST;
- строятся scopes;
- извлекаются symbols;
- извлекаются references;
- извлекаются dependencies;
- извлекаются специальные сущности языка и фреймворка;
- формируется file semantic snapshot.

#### Этап 5. Глобальная нормализация

После file-level extraction Indexer выполняет нормализацию данных на уровне проекта:

- устранение дублей идентичности;
- стабилизация canonical symbol ids;
- связывание cross-file imports и references;
- построение project-level dependency sets;
- согласование module relationships;
- формирование removal-free baseline.

#### Этап 6. Сохранение индексного baseline

Сохраняются:

- file fingerprints;
- AST fingerprints;
- semantic snapshots;
- symbol snapshots;
- edge snapshots;
- diagnostics;
- provider versions;
- module map.

#### Этап 7. Публикация итогов

- публикуются `FileIndexed` для всех успешно обработанных файлов или их batch-эквиваленты;
- публикуются `FileIndexFailed` для файлов с ошибками;
- после завершения сессии публикуется `IndexCompleted`.

### 7.4 Свойства Full Index

Полное индексирование должно обладать следующими свойствами:

- `Deterministic`: один и тот же вход должен давать эквивалентный структурный результат.
- `Restartable`: процесс можно безопасно перезапустить.
- `Partitionable`: большие проекты должны обрабатываться частями.
- `Observable`: состояние прогресса и ошибок должно быть прозрачно.
- `Version-bound`: результат жёстко привязан к конкретной версии проекта и набора provider-ов.

---

## 8. Инкрементальное индексирование

Инкрементальное индексирование, или `Incremental Index`, — это режим, при котором Indexer обновляет только затронутую часть структурного представления, не перестраивая весь проект.

### 8.1 Зачем нужен Incremental Index

Без incremental mode любая правка в одном файле потребовала бы полного сканирования проекта. Это неприемлемо для:

- активной разработки;
- больших монорепозиториев;
- интерактивного AI workflow;
- near-real-time обновления Graph;
- частых commit/pull/merge сценариев.

### 8.2 Триггеры Incremental Index

Переиндексация может запускаться из следующих триггеров:

- `FileChanged` из Workspace;
- `CommitPushed`;
- `RepositorySynced`;
- `CommitReverted`;
- `ProjectOpened`, если индекс устарел;
- `ProjectConfigUpdated`, если изменение конфигурации влияет только на часть проекта.

### 8.3 Как определяется необходимость переиндексации

Необходимость переиндексации определяется комбинацией сигналов:

#### По изменению файла

- содержимое файла изменилось;
- изменился hash/fingerprint;
- изменился размер или mtime, а fingerprint ещё не подтверждён;
- файл появился впервые;
- файл удалён;
- файл переименован или перемещён.

#### По изменению конфигурации

- изменились ignore-правила;
- добавлен новый source root;
- изменился path alias;
- обновились language settings;
- изменилась карта framework conventions.

#### По изменению инфраструктуры анализа

- обновился Language Provider;
- обновился parser backend;
- изменилась схема внутреннего semantic snapshot;
- изменилась логика extraction, делающая старое состояние неполным.

#### По обнаружению несогласованности

- отсутствует snapshot для файла;
- повреждён parse cache;
- file state новее, чем index state;
- graph_version и index state больше не согласованы;
- обнаружен conflict между rename/delete/add последовательностями.

### 8.4 Уровни решения о переиндексации

Indexer не должен принимать бинарное решение "индексировать или нет". Вместо этого он должен различать уровни обновления:

1. `No-op`
   Содержимое и интерпретация файла не изменились.

2. `Metadata Refresh`
   Меняются только file-level метаданные, не влияющие на AST и структуру.

3. `File Reparse`
   Нужен повторный парсинг конкретного файла.

4. `File Reextract`
   AST может быть reused, но semantic extraction надо пересчитать.

5. `Dependency Refresh`
   Изменения в файле требуют обновить cross-file references и edges.

6. `Module Refresh`
   Изменение задевает модульные границы или экспортную поверхность модуля.

7. `Project Partial Rescan`
   Конфигурационное изменение задевает целый сегмент проекта.

8. `Full Resync Escalation`
   Инкрементальный путь небезопасен или экономически невыгоден.

### 8.5 Incremental Pipeline

```
Trigger Event
    │
    ▼
Change Intake
    │
    ├── Собирает список affected files
    ├── Классифицирует тип изменения
    └── Проверяет index state
    │
    ▼
Reindex Decision Engine
    │
    ├── No-op
    ├── Single-file reparse
    ├── Multi-file refresh
    ├── Module-level rebuild
    └── Escalate to Full Index
    │
    ▼
Incremental Scanner
    │
    ├── Загружает previous snapshot affected files
    ├── Пересчитывает fingerprints
    ├── Строит новые AST/snapshots
    └── Передаёт пары old/new в Diff Engine
    │
    ▼
Diff Engine
    │
    ├── Выделяет removals
    ├── Выделяет additions
    ├── Выделяет modifications
    └── Строит Graph Update Package
    │
    ▼
Artifact Writer
    │
    ├── Обновляет index state только для affected scope
    └── Сохраняет invalidation markers для зависимых сущностей
    │
    ▼
Event Publisher
    │
    ├── Публикует FileIndexed / FileIndexFailed
    └── После завершения серии публикует IndexCompleted
```

### 8.6 Подробный Pipeline Incremental Index

Ниже описан более детальный путь инкрементального индексирования, начиная с момента появления сигнала об изменении и заканчивая формированием безопасного набора обновлений для Graph.

#### Шаг 1. Change Intake

Indexer принимает событие изменения и приводит его к внутренней модели affected scope.

На этом шаге:

- дедуплицируются повторяющиеся сигналы;
- объединяются быстрые последовательные изменения одного файла;
- классифицируется источник изменения: Workspace, Git, Config, Provider Update;
- формируется начальный набор candidate files.

#### Шаг 2. Scope Expansion

Затем определяется, достаточно ли обработать только исходный файл или нужно расширить scope:

- на соседние файлы модуля;
- на импортирующие файлы;
- на re-export chain;
- на route/config entry points;
- на generated semantic artifacts, если они включены в индекс.

Цель шага — не допустить пропуска cross-file structural effects.

#### Шаг 3. State Validation

Перед повторным анализом проверяется качество прежнего index state:

- существует ли previous snapshot;
- совпадает ли provider version;
- актуален ли parse cache;
- не повреждён ли symbol snapshot;
- не был ли файл уже изменён повторно после постановки в очередь.

Если доверие к локальному состоянию недостаточно, происходит эскалация уровня обновления.

#### Шаг 4. Reparse / Reuse Decision

Для каждого affected file принимается решение:

- использовать только metadata refresh;
- переиспользовать AST и пересчитать semantic layer;
- заново строить AST;
- расширить обновление до module refresh;
- отказаться от incremental path в пользу full rebuild.

#### Шаг 5. Parsing and Extraction

Файл проходит через обычные слои parsing и extraction, но только в пределах affected scope.

Результатом становится:

- новый file fingerprint;
- новый AST fingerprint;
- новый semantic snapshot;
- набор symbols, references и dependencies текущего состояния.

#### Шаг 6. Symbol Diff

Старый и новый snapshots сравниваются на уровне символов и отношений.

На этом шаге выделяются:

- stable symbols без структурного изменения;
- symbols с изменением свойств;
- symbols, исчезнувшие из текущей версии;
- новые symbols;
- relations, требующие добавления;
- relations, требующие удаления.

#### Шаг 7. Local State Commit

До публикации событий Indexer должен сначала зафиксировать собственное состояние:

- обновить file index;
- сохранить новые fingerprints;
- обновить semantic snapshots;
- сохранить diff result;
- обновить Index Manifest соответствующей сессии.

Это необходимо, чтобы повторная обработка события была идемпотентной и восстановимой.

#### Шаг 8. Event Emission

Только после фиксации локального состояния публикуются:

- `FileIndexed`, если diff успешно построен;
- `FileIndexFailed`, если анализ не дал надёжного результата;
- `IndexProgressUpdated`, если операция длинная;
- `IndexCompleted`, если серия изменений завершена.

#### Шаг 9. Post-Commit Invalidation

После фиксации изменённого scope Indexer должен запланировать или отметить:

- invalidation связанных cache entries;
- проверку affected imports/exports;
- необходимость secondary refresh для зависимых модулей;
- возможную эскалацию в partial rescan, если накопился долг неопределённости.

### 8.7 Особенности удаления, переименования и перемещения файлов/символов

Инкрементальный режим должен особенно аккуратно обрабатывать не только изменение содержимого, но и изменение идентичности расположения.

- удаление файла, которое требует публикации набора removals;
- rename, где identity файла может измениться, но часть символов остаётся логически той же;
- move между модулями, где изменяются и file node, и module edges, и иногда FQN;
- splitting/merging files, где один прошлый snapshot соотносится с несколькими новыми.

#### Удаление файла

При удалении файла Indexer должен:

- определить last-known-good snapshot файла;
- извлечь полный removal set всех symbols и relations;
- удалить file-level identity из index state;
- зафиксировать deletion в Index Manifest;
- передать вниз точный набор сущностей, подлежащих удалению из Graph.

#### Переименование файла

Переименование нельзя рассматривать только как delete + add, если логическая сущность файла и его содержимое сохраняются.

Indexer должен уметь:

- связывать old path и new path в рамках одной change session;
- оценивать, сохранилась ли symbol identity;
- разделять pure rename и rename-with-structural-change;
- корректно обновлять path-dependent identities и module bindings.

#### Перемещение файла

При перемещении файла между директориями или модулями требуется дополнительный анализ:

- изменился ли owning module;
- изменился ли namespace/FQN;
- изменились ли import paths у связанных файлов;
- нужно ли инициировать secondary reindex для потребителей.

#### Удаление символа

При исчезновении символа из файла Indexer должен удалить:

- сам symbol;
- relations, исходящие из него;
- relations, ведущие к нему, если они больше не могут быть разрешены;
- derived entities, если они были порождены только этим symbol.

#### Переименование символа

Переименование symbol — один из самых чувствительных кейсов для incremental pipeline.

Indexer должен различать:

- cosmetic rename без изменения semantics;
- rename с изменением qualified identity;
- rename, ломающий import/export contracts;
- rename внутри того же файла;
- rename с одновременным move в другой container.

#### Перемещение символа

Move symbol между файлами или контейнерами должен анализироваться как сохранение логической сущности при смене declaring context, если это подтверждается diff-моделью.

Иначе возникает ложное удаление старого symbol и ложное создание нового, что ухудшает качество Graph history и impact analysis.

### 8.8 Эскалация к Full Index

Incremental Index должен уметь сам признать собственную недостаточность.

Эскалация к Full Index требуется, когда:

- потеряно доверие к index state;
- слишком много файлов накопилось в очереди и diff дороже полного прохода;
- изменился language model/provider так, что старые snapshots недостоверны;
- проект после merge/rebase пережил массовое перемещение структуры;
- обнаружены системные ошибки extraction, влияющие на большой процент проекта.

---

## 9. Поддержка языков

Ключевой архитектурный принцип: ядро Indexer не должно содержать knowledge о конкретных языках сверх минимального механизма регистрации provider-ов.

### 9.1 Language Provider как архитектурный контракт

Каждый язык подключается через `Language Provider`. Provider — это внутренняя расширяемая единица, которая инкапсулирует всё, что специфично для данного языка или формата.

Provider описывает:

- какие файлы он умеет распознавать;
- умеет ли он строить AST;
- какие типы symbols способен извлекать;
- какие kinds dependencies поддерживает;
- знает ли он framework conventions;
- какие specialized analyzers доступны;
- какую степень точности он гарантирует.

### 9.2 Состав Language Provider

Каждый provider должен концептуально состоять из следующих частей:

- `Language Descriptor`
  Идентичность языка, расширения, file naming conventions, version compatibility.

- `Parser Adapter`
  Подключение конкретного parser backend.

- `AST Adapter`
  Приведение native AST языка к внутренней модели обхода.

- `Symbol Rules`
  Правила определения declarations и symbol identity.

- `Reference Rules`
  Правила определения ссылок, imports, exports, aliasing.

- `Dependency Rules`
  Правила извлечения зависимостей данного языка.

- `Specialized Extractors`
  Route/component/database/config analyzers, если язык этого требует.

- `Diagnostics Mapper`
  Нормализация ошибок и предупреждений парсера.

### 9.3 Роли ядра и provider-а

Ядро Indexer отвечает за:

- orchestration;
- scheduling;
- state management;
- diffing lifecycle;
- caching lifecycle;
- event publication;
- aggregation across languages.

Language Provider отвечает за:

- syntax understanding;
- AST construction strategy;
- language-specific symbol extraction;
- language-specific dependency extraction;
- framework-specific language conventions.

Это разделение позволяет добавить новый язык без изменения pipeline.

### 9.4 Требования к первым provider-ам

#### PHP Provider

Должен понимать:

- namespace;
- class/interface/trait/enum;
- methods/properties/constants;
- use/import;
- attributes/annotations;
- inheritance/implements;
- Laravel/Symfony-like route and migration conventions, если они подключены отдельными extractors.

**Текущая реализация (2026-07-17).** PHP Provider построен как двухуровневый extraction path, а не единый механизм:

- Основной путь — разбор через `php-parser` (чистая JS-реализация парсера PHP, не требующая PHP runtime в окружении Indexer). AST-разбор строит настоящее дерево классов/интерфейсов/enum/trait и их members, что даёт три улучшения точности по сравнению с прежним regex-only подходом:
  - методы корректно привязываются к своему реальному containing class/interface/enum/trait, в том числе в файлах с несколькими классами (ранее любой метод в файле приписывался первому найденному классу);
  - методы без явного модификатора видимости (implicit `public`, валидный PHP) теперь попадают в индекс — раньше они были невидимы для extraction, ориентированной на `(public|protected|private)\s+function`;
  - trait-ы индексируются как полноценные symbols (kind `class`, отдельного kind для trait в `SymbolKind` нет) — раньше они полностью пропускались.
- Fallback-путь — regex-based extraction, сохранённый в кодовой базе как есть. Он включается на любой сбой AST-разбора или AST-based extraction (parse error, неожиданная структура дерева и т.п.) и воспроизводит прежнее (менее точное) поведение вместо того, чтобы уронить файл до нуля symbols. Иными словами, ошибка нового парсера не приводит к потере данных — она деградирует до старого, проверенного пути.
- Оба пути используют один и тот же набор вспомогательных content-scanning extractors для service calls, static calls, runtime signals (заголовки запроса, `config()`/`env()`, `setLocale`) и Laravel route conventions — эти extractors не завязаны на способ построения AST и не изменились.

#### TypeScript Provider

Должен понимать:

- imports/exports;
- interfaces/types/enums/classes/functions;
- generics;
- type-only imports;
- decorators, если используются;
- module boundaries;
- React/Nest-like conventions через специализированные extractors.

#### JavaScript Provider

Должен понимать:

- ES modules;
- CommonJS;
- functions/classes/objects-as-modules;
- dynamic import как отдельный класс dependency;
- framework conventions через addons.

**Frontend HTTP-call extraction (2026-07-17).** TypeScript- и JavaScript Provider дополнительно извлекают site вызовов HTTP-клиента как отдельный symbol kind `http-call`: вызовы вида `axios.get(...)`/`this.$axios.post(...)`, вызовы клиентов, чьё имя правдоподобно указывает на HTTP-клиент (`api`, `http`, `client` — без учёта регистра), `fetch(...)` и объектную форму `axios({ method, url })`. Путь вызова нормализуется: `${id}` (JS template literal), `{id}`/`{id?}` (Laravel-style) и `:id` (vue-router-style) — все три формы приводятся к единому `:param`, чтобы один и тот же логический маршрут не давал разных symbol identity из-за разного синтаксиса плейсхолдера. Извлечение — чисто структурное: Indexer фиксирует сам факт и место вызова (symbol + `DECLARES` relation от файла), но не пытается сопоставить его с конкретным backend-маршрутом — это требует одновременного доступа к frontend- и backend-графу (часто из разных репозиториев) и относится к зоне ответственности пакета `graph` (`linkHttpCallsToRoutes`), а не Indexer.

#### Vue Provider

Должен понимать:

- single-file component structure;
- template/script/style blocks;
- props/emits/slots/composition usage;
- imports and nested component usage.

**Текущая реализация (2026-07-16/17).** Реализация Vue Provider на сегодня уже, чем целевая модель выше: extraction ограничен блоком `<script>`/`<script setup>` — `<template>` и `<style>` не анализируются, директивы шаблона и props/emits/slots из template не извлекаются. Из открывающего тега `<script>` определяется атрибут `lang`; при `lang="ts"`/`lang="typescript"` содержимое обрабатывается как TypeScript, иначе — как JavaScript, тем же extractor-ом, что и обычные `.ts`/`.js` файлы (включая frontend HTTP-call extraction выше). Номера строк извлечённых symbols смещаются на число строк перед началом script-блока, чтобы они оставались корректными относительно исходного `.vue`-файла, а не относительно вырезанной подстроки. Если в файле есть только `<script>` (например, для `defineOptions`) и отдельный `<script setup>`, обрабатывается только первый найденный блок — сознательное упрощение для MVP, так как такое сочетание в реальных Vue 3 проектах редкое. Если тега `<script>` нет вовсе, файл индексируется с пустым набором symbols.

#### JSON / YAML Provider

Используются в первую очередь для config extraction.

Должны понимать:

- schema-like structures;
- route/config/service declarations;
- dependency manifests;
- build/runtime metadata.

#### Markdown Provider

Нужен не для свободного текста, а для структурных документов проекта.

Должен понимать:

- заголовки;
- code fence references;
- documented modules/routes/components;
- ADR/documentation linking, если это включено в общую архитектуру.

#### SQL Provider

Должен извлекать:

- table definitions;
- column definitions;
- constraints;
- indexes;
- queries;
- references between tables;
- migration-like operations, если SQL используется как source of truth.

#### Dockerfile Provider

Должен извлекать:

- stages;
- base images;
- copied paths;
- exposed ports;
- entrypoint/cmd;
- build dependency hints.

#### HTML / CSS Provider

По текущему состоянию — только Language Descriptor, без Symbol Rules/Dependency Rules. HTML (`.html`, `.htm`) и CSS (`.css`, `.scss`, `.sass`, `.less` — все четыре расширения нормализуются в единый `LanguageId` `css`, отдельного различения препроцессоров нет) распознаются Language Detector-ом и корректно учитываются в статистике по языкам, но полноценного extraction (DOM-структура, селекторы, custom properties, `@import`/`@use`) пока не реализовано. Файлы этих языков проходят через тот же путь, что и любой пока не покрытый provider-ом формат: индексируются с пустым списком symbols и imports, без ошибки.

### 9.5 Добавление нового языка

Добавление нового языка должно требовать:

- регистрации нового provider-а в registry;
- объявления capability set;
- подключения parser adapter;
- описания symbol/dependency rules;
- включения в конфигурацию проекта.

Добавление нового языка не должно требовать:

- переписывания Index Coordinator;
- изменения event model;
- модификации state store schema ядра, кроме совместимого расширения;
- изменения базового incremental workflow.

---

## 10. AST

### 10.1 Что такое AST

AST, или Abstract Syntax Tree, — это структурированное представление исходного кода в форме дерева, где каждый узел представляет синтаксическую конструкцию языка, а не конкретный текстовый фрагмент как строку.

AST устраняет шум поверхностного текста:

- пробелы;
- форматирование;
- переносы строк;
- часть синтаксического сахара;
- несущественные для структуры различия записи.

Вместо этого AST фиксирует смысл синтаксической формы:

- объявление класса;
- сигнатуру функции;
- выражение вызова;
- импорт;
- атрибут;
- декларацию таблицы;
- конфигурационный ключ и значение.

### 10.2 Какие задачи решает AST в Indexer

AST является центральным промежуточным слоем Indexer и решает следующие задачи:

1. Позволяет отделить синтаксический анализ от семантического извлечения.
2. Даёт детерминированную структуру обхода для Symbol Extractor и Dependency Analyzer.
3. Позволяет извлекать сущности независимо от форматирования файла.
4. Создаёт основу для incremental diff на уровне структуры, а не только текста.
5. Позволяет локализовать ошибки парсинга и зоны частичного анализа.
6. Даёт другим модулям опосредованную возможность доверять извлечённым фактам без повторного парсинга.

### 10.3 Какие данные извлекаются из AST

Из AST Indexer извлекает:

- объявления символов;
- иерархию вложенности;
- области видимости;
- сигнатуры;
- модификаторы видимости и абстракции;
- типы параметров и возврата;
- базовые выражения вызова;
- импорты/экспорты;
- значения атрибутов/декораторов/аннотаций;
- конфигурационные структуры;
- SQL/route/component-specific constructs, если они представлены как синтаксические сущности языка.

### 10.4 Что AST не решает само по себе

AST сам по себе не гарантирует полную семантику.

Он не всегда способен без дополнительной логики определить:

- к какому именно символу относится неоднозначная ссылка;
- что означает динамически построенный вызов;
- какой runtime type скрывается за duck typing;
- какие зависимости активируются условно;
- какие framework magic relations существуют вне синтаксиса.

Поэтому AST — это основа, а не финальный результат.

### 10.5 Использование AST другими модулями

По существующей архитектуре AST не должен становиться самостоятельным авторитетным межмодульным хранилищем. Но результаты AST-анализа используются другими модулями опосредованно:

- Graph получает материализованные symbols и edges, извлечённые из AST.
- Context Builder получает структурные сущности, сигнатуры и зависимости, основанные на AST.
- Research Engine может использовать индексные факты как опору для навигации по коду.
- Impact Analysis Engine использует связи, происхождение которых находится в AST.
- Knowledge может определять устаревание знаний по затронутым AST-derived узлам.

### 10.6 Требования к работе с AST

Архитектурно AST в Indexer должно быть:

- `language-aware`;
- `versioned`;
- `cacheable`;
- `discardable`;
- `rebuildable`;
- `non-authoritative outside Indexer`.

Это означает, что AST является внутренним вычислительным артефактом Indexer, а не системой хранения знаний верхнего уровня.

---

## 11. Symbol Extraction

Symbol Extraction — это процесс выделения именованных структурных сущностей проекта из AST и связанных с ним метаданных.

### 11.1 Общие требования к symbol extraction

Для каждого символа должны быть определены, насколько это возможно:

- canonical identity;
- symbol kind;
- human-readable name;
- fully qualified name;
- declaring file;
- owning module;
- position/range;
- scope;
- modifiers;
- signature;
- parent symbol;
- version/fingerprint;
- extraction confidence.

### 11.2 Базовые виды символов

Минимальный набор symbol kinds, который архитектура должна поддерживать:

- `Project`
- `Module`
- `Folder`
- `File`
- `Class`
- `Interface`
- `Trait`
- `Enum`
- `Method`
- `Function`
- `Property`
- `Variable`
- `Constant`
- `Type`
- `Parameter`

### 11.3 Прикладные и framework-level символы

Indexer также должен уметь извлекать более прикладные сущности:

- `Route`
- `Component`
- `Event`
- `Listener`
- `Command`
- `Job`
- `Middleware`
- `Controller`
- `Service`
- `Repository`
- `Migration`
- `DatabaseTable`
- `DatabaseColumn`
- `Index`
- `Constraint`
- `Seeder`
- `Model`
- `APIEndpoint`
- `HttpCall`
- `ConfigEntry`
- `EnvironmentBinding`
- `Test`
- `TestCase`
- `Fixture`
- `DocumentationSection`

Конкретный набор зависит от доступных provider-ов и specialized extractors, но архитектура не должна ограничиваться только базовыми синтаксическими constructs.

`HttpCall` (реализованный `SymbolKind` — `http-call`) — это call-site вызова HTTP-клиента на фронтенде (см. 9.4, Frontend HTTP-call extraction), а не серверный маршрут; он представляет собой производный символ, наблюдаемый со стороны потребителя API, а не со стороны его объявления.

### 11.4 Классификация по происхождению

Символы можно разделить на несколько классов происхождения:

#### Объявляемые символы

Сущности, явно объявленные в коде:

- class;
- function;
- interface;
- enum;
- table definition.

#### Производные символы

Сущности, выводимые из convention или composite structure:

- route из атрибута/аннотации/декларации роутера;
- component из Vue/React module shape;
- migration operation из migration file;
- config entity из structured config file.

#### Агрегированные символы

Сущности, формируемые из набора синтаксических элементов:

- module;
- namespace aggregate;
- external endpoint reference;
- test suite grouping.

### 11.5 Требования к идентичности символа

Symbol identity должна быть стабильной настолько, насколько это возможно между инкрементальными обновлениями.

Идентичность должна учитывать:

- logical kind;
- qualified name;
- declaring container;
- path context;
- language semantics.

Line number не должна быть единственным идентификатором, потому что смещение строк не должно искусственно создавать новый symbol identity.

### 11.6 Требования к полноте extraction

Indexer должен стремиться к максимальной полноте, но допускается graded extraction:

- `full` — symbol извлечён со всеми необходимыми свойствами;
- `partial` — symbol извлечён, но не все свойства доступны;
- `approximate` — symbol определён эвристически;
- `unresolved` — наличие сущности зафиксировано, но точная классификация не завершена.

Такой подход лучше, чем бинарное "успех/провал", потому что он позволяет системе продолжать работу в присутствии неполной информации.

### 11.7 Stable Symbol IDs

Для качественного incremental diff и корректной синхронизации с Graph одной только текущей symbol identity недостаточно. Indexer должен оперировать понятием `Stable Symbol ID`.

#### Зачем нужен Stable Symbol ID

Stable Symbol ID нужен для того, чтобы система могла отличать:

- реальное удаление символа;
- переименование символа;
- перемещение символа;
- изменение сигнатуры существующего символа;
- появление нового, ранее не существовавшего символа.

Без стабильного идентификатора любое значимое изменение слишком легко превращается в ложную пару `remove + add`.

#### Требования к Stable Symbol ID

Stable Symbol ID должен:

- сохраняться между incremental сессиями, пока символ остаётся той же логической сущностью;
- не зависеть только от line number;
- быть устойчивым к форматированию;
- по возможности переживать rename и move, если semantic identity подтверждается;
- быть совместимым с versioned graph model.

#### На чём может основываться стабильность

Архитектурно стабильность идентификатора должна выводиться из комбинации признаков:

- symbol kind;
- declaring hierarchy;
- semantic signature;
- qualified context;
- normalized structural fingerprint;
- previous snapshot correspondence.

Это не означает одну фиксированную формулу. Важно само требование: identity должна быть достаточно устойчивой для качественного diff.

#### Поведение при потере уверенности

Если Indexer не может надёжно доказать сохранение identity, он должен:

- понизить confidence;
- зафиксировать ambiguous mapping;
- при необходимости трактовать случай как `remove + add`;
- отразить это в diagnostics.

Лучше явно признать неоднозначность, чем тихо исказить историю символа.

---

## 12. Dependency Analysis

Dependency Analysis отвечает за извлечение отношений между сущностями проекта. Он должен работать на нескольких уровнях: файл, символ, модуль, технологический артефакт.

### 12.1 Основные типы зависимостей

Indexer должен выявлять по крайней мере следующие виды зависимостей:

- импорт;
- экспорт;
- наследование;
- реализация;
- композиция;
- агрегация;
- вызов;
- типовое использование;
- использование через атрибуты/декораторы/аннотации;
- конфигурационная привязка;
- маршрутная привязка;
- компонентная композиция;
- database relation;
- внешняя API-зависимость.

### 12.2 Импорты

Import analysis должен охватывать:

- `use`, `import`, `require`, `include`, `export`, `re-export`;
- aliases;
- type-only imports;
- namespace imports;
- star imports;
- relative and absolute imports;
- package-level imports;
- configuration-driven imports.

Результат import analysis нужен для:

- file-to-file dependencies;
- symbol resolution;
- module boundary analysis;
- impact analysis.

### 12.3 Наследование

Inheritance analysis должен выявлять:

- class extends class;
- interface extends interface;
- trait/mixin usage;
- abstract base relations;
- framework base class relations.

Наследование должно фиксироваться как отдельный тип relation, а не растворяться в общем dependency set, потому что оно имеет особое значение для impact analysis и architectural rules.

### 12.4 Реализации

Implementation analysis должен выявлять:

- class implements interface;
- object/module satisfying type contract, если язык это позволяет выразить статически;
- convention-based contract realization, если provider умеет это подтверждать с приемлемой точностью.

### 12.5 Вызовы

Call analysis должен извлекать:

- function-to-function calls;
- method-to-method calls;
- constructor invocations;
- lifecycle hook calls;
- event handler bindings;
- route handler references;
- query execution points;
- API client invocations.

Для call analysis важно разделять:

- `resolved call`
- `partially resolved call`
- `dynamic/unresolved call`

Потому что реальный код часто использует динамику, которую невозможно полностью разрешить статически.

### 12.6 Использование

Usage analysis шире, чем call analysis. Он должен включать:

- type usage in signatures;
- field/property type references;
- annotations/attributes/decorators;
- generic arguments;
- template/component inclusion;
- config key references;
- ORM relation declarations;
- SQL table usage;
- environment variable consumption;
- external endpoint references.

По текущей реализации external endpoint references на фронтенде материализованы как `http-call` symbols (см. 9.4/11.3); их сопоставление с конкретным backend-маршрутом — задача Graph Synchronization на стороне пакета `graph`, а не Dependency Analysis внутри Indexer.

### 12.7 Циклические зависимости

Indexer не обязан сам выступать финальным аналитиком архитектурных нарушений, но он должен извлекать данные, достаточные для обнаружения циклов.

Для этого dependency analysis должен:

- сохранять directed edges;
- различать dependency kinds;
- позволять агрегировать зависимости на уровне module и file;
- не терять транзитивную основу графа;
- сохранять removals и additions при incremental update.

Типы циклов, которые должны быть доступны для последующего анализа:

- file-to-file cycles;
- module-to-module cycles;
- inheritance cycles;
- import cycles;
- component composition cycles;
- database/schema reference cycles, если они выражены структурно.

### 12.8 Границы точности dependency analysis

Indexer должен явно признавать ограничения статического анализа:

- reflection;
- dynamic dispatch;
- magic methods;
- dependency injection containers;
- string-based resolution;
- runtime-generated code;
- convention-over-configuration frameworks;
- SQL assembled from fragments;
- template-level indirect bindings.

Такие случаи не должны silently игнорироваться. Они должны либо классифицироваться как `unresolved dependency`, либо отмечаться diagnostic-сигналом.

---

## 13. Graph Synchronization

По существующей архитектуре Indexer не владеет Graph напрямую. Его задача — корректно и последовательно доставлять структурные изменения в виде событий и индексных артефактов.

### 13.1 Как изменения попадают в Graph

Поток синхронизации выглядит так:

```
Code / Config / Repo change
    -> Indexer re-evaluates affected scope
    -> Indexer computes structural delta
    -> Indexer persists its own state
    -> Indexer publishes FileIndexed / FileIndexFailed / IndexCompleted
    -> Graph Manager consumes event
    -> Graph materializes node/edge changes
    -> Graph publishes GraphUpdated
```

Ключевой принцип: Graph получает не текстовый diff и не AST, а структурные факты об изменениях.

### 13.2 Какие события публикуются

С точки зрения Indexer обязательны следующие события:

- `IndexStarted`
  Сообщает о начале индексации и переводит зависимые модули в режим ожидания актуализации.

- `FileIndexed`
  Основное событие синхронизации. Содержит достаточно информации о добавленных, изменённых и удалённых сущностях файла.

- `FileIndexFailed`
  Фиксирует невозможность построить достоверный структурный результат для файла.

- `IndexProgressUpdated`
  Даёт возможность наблюдать длительные операции.

- `IndexCompleted`
  Сообщает, что текущая index session завершена и её результаты готовы к использованию.

### 13.3 Что должно входить в Graph Update Package

Хотя API здесь не описывается, концептуально package должен нести:

- identity файла;
- identity затронутого модуля;
- список добавленных сущностей;
- список изменённых сущностей;
- список удалённых сущностей;
- список добавленных отношений;
- список удалённых отношений;
- fingerprints и version markers;
- diagnostics level, если анализ частичный.

### 13.4 Symbol Diff перед обновлением Graph

Непосредственно перед публикацией структурного изменения в сторону Graph должен формироваться `Symbol Diff` — канонический результат сравнения предыдущего и нового состояния affected scope.

#### Зачем нужен Symbol Diff

Symbol Diff нужен, чтобы:

- отделить extraction от materialization;
- сделать обновление Graph детерминированным;
- сократить ложные удаления и повторные создания сущностей;
- позволить incremental pipeline объяснять каждое изменение;
- поддержать идемпотентную повторную доставку событий.

#### Что включает Symbol Diff

Conceptually Symbol Diff должен содержать:

- `unchanged symbols`;
- `added symbols`;
- `modified symbols`;
- `removed symbols`;
- `moved symbols`;
- `renamed symbols`;
- `rebound symbols`, если изменилась привязка к модулю или контейнеру;
- `added relations`;
- `removed relations`;
- `diagnostic flags` для ambiguous cases.

#### Порядок построения Symbol Diff

1. Сопоставить previous и current snapshots по Stable Symbol ID.
2. Для неразрешённых случаев попытаться выполнить secondary matching по structural fingerprint.
3. Выделить реальные removals и additions.
4. Зафиксировать property-level modifications.
5. Вычислить relation delta.
6. Только после этого сформировать Graph Update Package.

#### Почему это важно

Без явного Symbol Diff Graph получает слишком грубую модель изменений. Это ведёт к:

- избыточному churn узлов;
- ухудшению качества history;
- ложным архитектурным срабатываниям;
- излишней инвалидизации downstream кэшей.

### 13.5 Как удаляются устаревшие узлы

Indexer обязан явно определять removals. Удаление устаревших узлов не должно строиться на догадке Graph.

Причины удаления:

- файл удалён;
- символ удалён из файла;
- символ больше не распознан из-за structural change;
- модульная граница изменилась;
- provider научился по-другому интерпретировать конструкцию и прежняя сущность больше не существует;
- файл стал non-indexable из-за конфигурации.

Для корректного удаления Indexer должен передавать:

- прошлую идентичность сущности;
- факт утраты актуальности;
- scope удаления;
- версию индексной сессии, подтвердившую удаление.

### 13.6 Согласованность и порядок

Для одного и того же файла или логического scope события должны обрабатываться в порядке, сохраняющем причинно-следственную целостность.

Это означает:

- изменение файла не должно быть материализовано раньше удаления его предыдущих сущностей;
- два конкурентных `FileIndexed` для одного файла должны сериализоваться;
- `IndexCompleted` не должен публиковаться до фиксации локального состояния Indexer по всем файлам сессии.

### 13.7 Частичная деградация синхронизации

Если часть файлов успешно проиндексирована, а часть нет, система не должна терять успешный результат. Вместо этого:

- успешные `FileIndexed` публикуются;
- проблемные файлы публикуют `FileIndexFailed`;
- `IndexCompleted` фиксирует partial completion;
- Graph и другие модули работают с наилучшим доступным структурным состоянием.

---

## 14. Производительность

Производительность Indexer определяет, насколько платформа пригодна для больших проектов и интерактивной разработки. Архитектура должна изначально предполагать высокую стоимость parsing и semantic extraction.

### 14.1 Кэширование

Indexer должен использовать многоуровневое кэширование:

- `File Fingerprint Cache`
  Позволяет быстро определять отсутствие изменений.

- `Parse Cache`
  Позволяет переиспользовать AST, если содержимое и parser version не изменились.

- `Semantic Snapshot Cache`
  Позволяет повторно использовать результаты extraction при неизменной структуре.

- `Provider Capability Cache`
  Позволяет не вычислять повторно routing к provider-ам.

- `Module Resolution Cache`
  Ускоряет mapping `path -> module`.

Кэш должен быть version-aware. Любое изменение provider-а, parser-а или extraction rules должно уметь инвалидировать соответствующий слой.

### 14.2 AST Cache и Parse Cache

Хотя в документе уже зафиксирована важность кэширования, AST Cache и Parse Cache требуют отдельной детализации, потому что именно они определяют экономику incremental pipeline.

#### AST Cache

`AST Cache` хранит результат синтаксического разбора файла в форме внутреннего AST-артефакта, пригодного для повторного semantic traversal.

AST Cache должен:

- быть привязан к fingerprint содержимого файла;
- учитывать версию parser backend;
- учитывать language/provider version;
- хранить статус полноты AST: full, partial, invalid;
- поддерживать быструю проверку пригодности к reuse.

AST Cache нужен для сценариев, где:

- текст файла не изменился;
- изменились только extraction rules;
- нужно повторно вычислить symbols/dependencies без повторного parse.

#### Parse Cache

`Parse Cache` шире, чем AST Cache. Он включает все parser-derived артефакты, которые полезны для повторного использования:

- AST;
- token stream, если он нужен parser-у;
- normalized diagnostics;
- parser metadata;
- structural fingerprints, вычисленные на parse stage.

#### Разделение AST Cache и Parse Cache

Разделение важно по следующим причинам:

- AST — основной семантический артефакт;
- parse artifacts могут быть полезны даже если сам AST нельзя полностью переиспользовать;
- invalidation policy у разных parser-derived данных может различаться;
- часть provider-ов может возвращать не одно дерево, а набор промежуточных representation.

#### Требования к инвалидизации

AST Cache и Parse Cache должны инвалидироваться при:

- изменении file content;
- изменении parser version;
- изменении provider version;
- изменении parser options;
- смене language mode;
- обнаружении corruption;
- изменении include context, если оно влияет на parse semantics.

#### Роль в производительности

Грамотно спроектированные AST Cache и Parse Cache позволяют:

- сократить количество expensive parse operations;
- снизить latency incremental index;
- уменьшить CPU pressure на больших проектах;
- поддержать secondary extraction без повторного чтения файла.

### 14.3 Параллельное индексирование

Архитектура должна поддерживать параллельную обработку файлов, но с контролем порядка там, где это важно.

Параллелизм допустим:

- между независимыми файлами;
- между разными модулями;
- между файлами разных языков;
- между parsing и extraction worker-ами.

Параллелизм ограничен:

- внутри одной цепочки событий для конкретного файла;
- при materialization order одного logical scope;
- при обновлении shared incremental state без синхронизации.

### 14.4 Инкрементальное обновление

Incremental mode является главным механизмом производительности. Архитектура должна минимизировать:

- число файлов, требующих полного reparse;
- число межфайловых пересчётов;
- стоимость recomputing unchanged scopes;
- объём событий и batch writes.

### 14.5 Повторное использование AST

AST reuse должен считаться одним из ключевых оптимизационных механизмов.

Повторное использование возможно, если:

- содержимое файла не изменилось;
- parser version не изменилась;
- language config не изменилась;
- AST schema не изменилась.

Если AST можно переиспользовать, но extraction rules изменились, следует пересчитывать semantic layer поверх существующего AST.

### 14.6 Батчевые операции

Для больших проектов Indexer должен уметь:

- батчировать `FileIndexed`;
- агрегировать index writes;
- батчировать invalidation state;
- уменьшать число мелких транзакций локального state store;
- по возможности передавать Graph update packages сериями.

Batching должен быть управляемым. Слишком крупные batch-и вредят latency и recovery granularity.

### 14.7 Memory and I/O discipline

Архитектура должна избегать модели "загрузить весь проект в память".

Необходимо:

- потоковое чтение списков файлов;
- ограничение числа одновременных AST в памяти;
- сброс промежуточных структур после фиксации;
- раздельные лимиты для parsing и semantic extraction.

### 14.8 Наблюдаемость производительности

Должны измеряться:

- время полного индекса;
- время incremental update;
- время парсинга по языкам;
- hit rate кэшей;
- доля файлов, потребовавших full reparse;
- размер event backlog;
- число partial failures;
- время от `FileChanged` до `FileIndexed`.

---

## 15. Отказоустойчивость

Indexer должен исходить из того, что проект в реальной жизни неидеален: код может быть сломан, конфигурация неполной, а внешние зависимости временно недоступны.

### 15.1 Если файл поврежден

Повреждённый файл не должен останавливать всю индексацию.

Ожидаемое поведение:

- файл маркируется как failed или partially parsed;
- фиксируется parser diagnostic;
- публикуется `FileIndexFailed`;
- остальные файлы продолжают обрабатываться;
- предыдущий успешный snapshot файла может сохраняться как last-known-good, но должен быть явно помечен как potentially stale.

### 15.2 Если язык не поддерживается

Неподдерживаемый язык — это штатный сценарий расширяемой системы.

Ожидаемое поведение:

- файл классифицируется как `unsupported`;
- он не ломает pipeline;
- диагностика фиксирует отсутствие provider-а;
- проект может быть частично проиндексирован по поддерживаемым языкам;
- при последующем добавлении provider-а такой файл должен естественно попасть в следующий цикл индексации.

### 15.3 Если парсер завершился ошибкой

Ошибка парсера должна проходить через Error Classifier.

Возможные сценарии:

- `recoverable parser error`
  Например, временно битый файл в активной разработке. Индексация продолжается, файл помечается failed.

- `provider-level failure`
  Например, сбой адаптера конкретного языка. Индексация продолжается для остальных языков, а affected scope получает degraded status.

- `systemic parser failure`
  Например, массовый отказ после обновления parser backend. Это повод для перевода сессии в degraded mode или эскалации к administrative attention.

### 15.4 Если Graph временно недоступен

Graph не должен считаться обязательным для завершения внутреннего анализа Indexer.

Ожидаемое поведение:

- Indexer завершает собственную работу и фиксирует локальное состояние;
- события публикуются в Event Bus;
- если downstream delivery в Graph задерживается, это проблема обработки событий, а не самой индексации;
- Indexer не должен терять вычисленные structural deltas только потому, что Graph временно недоступен;
- при необходимости система повторно доставляет события по стандартной механике Event Bus.

### 15.5 Если поврежден локальный state Indexer

При подозрении на corruption state store:

- affected scope переводится в режим untrusted state;
- incremental path для него отключается;
- запускается partial rebuild или full resync;
- старое состояние не должно silently использоваться.

### 15.6 Graceful degradation

Общий принцип отказоустойчивости:

- лучше выдать частично неполный, но диагностируемый результат, чем полностью остановить систему;
- любая деградация должна быть наблюдаемой;
- каждое решение о fallback должно быть явным и воспроизводимым;
- при утрате доверия к инкрементальному состоянию должна быть предусмотрена эскалация к Full Index.

### 15.7 Diagnostics и Statistics

Diagnostics и Statistics должны рассматриваться как обязательная часть инженерного результата индексирования, а не как вторичный operational garnish.

#### Diagnostics

Diagnostics фиксируют качественные проблемы анализа. Они должны покрывать:

- parser errors;
- partial parse warnings;
- unsupported language notices;
- unresolved references;
- ambiguous symbol mappings;
- cache corruption signals;
- provider compatibility warnings;
- degraded incremental decisions;
- graph sync risk markers.

Diagnostics должны быть классифицированы по уровням, например:

- info;
- warning;
- error;
- critical.

Также diagnostics должны иметь scope:

- project-level;
- module-level;
- file-level;
- symbol-level;
- session-level.

#### Statistics

Statistics фиксируют количественный результат индексирования.

Минимально должны собираться:

- число scanned files;
- число indexed files;
- число skipped files;
- число unsupported files;
- число failed files;
- число extracted symbols;
- число added/modified/removed symbols;
- число extracted relations;
- объём removals;
- cache hit/miss ratios;
- среднее и p95 время parsing;
- среднее и p95 время extraction;
- среднее и p95 время diff calculation;
- длительность полной index session;
- длительность incremental session.

#### Связь с Index Manifest

Итоговые diagnostics и statistics должны входить в `Index Manifest` как summary-слой, тогда как детальные данные могут храниться во внутренних артефактах Indexer.

#### Назначение для системы

Diagnostics и Statistics нужны не только для наблюдаемости, но и для принятия решений самим Indexer:

- можно ли доверять incremental state;
- нужен ли partial rescan;
- есть ли regressions после обновления provider-а;
- требуется ли эскалация к Full Index;
- где находятся хронически проблемные зоны проекта.

---

## 16. Будущее развитие

Архитектура Indexer должна быть рассчитана на расширение без изменения фундаментальной схемы работы.

### 16.1 Что должно легко добавляться

- новые языки;
- новые parser backends;
- новые symbol kinds;
- новые dependency kinds;
- новые framework-specific analyzers;
- новые extractors для конфигурации, маршрутов, БД, UI, инфраструктуры;
- новые режимы incremental invalidation;
- новые виды индекса для доменно-специфичных проектов;
- новые эвристики разрешения ссылок;
- новые источники структурных фактов, если они не ломают модель авторитетности кода.

### 16.2 Что не должно требовать изменения архитектуры

Следующие эволюции должны укладываться в существующий каркас:

- подключение Rust, Go, Python, Java, C#, Kotlin и любых будущих языков;
- поддержка новых frontend-framework conventions;
- извлечение новых типов событий и job-обработчиков;
- расширение database extraction до NoSQL schema descriptors;
- появление richer documentation extraction;
- переход на более мощные parser-движки;
- введение более точной symbol identity normalization.

### 16.3 Эволюция без переписывания ядра

Архитектура считается удачной, если при росте платформы меняются:

- provider-ы;
- extractors;
- capability sets;
- invalidation rules;
- diagnostics taxonomy;

но не меняются базовые принципы:

- pipeline от source к semantic snapshot;
- separation between Indexer and Graph;
- event-driven synchronization;
- versioned incremental state;
- provider-based language extensibility.

### 16.4 Стратегический результат

В зрелом состоянии Indexer должен стать не "парсером файлов", а стабильной вычислительной подсистемой структурной интерпретации проекта. Он должен уметь масштабироваться по размеру проекта, разнообразию языков и сложности фреймворков, не теряя при этом трёх ключевых качеств:

- детерминированность;
- наблюдаемость;
- расширяемость.

Именно это делает его подходящим фундаментом для всей остальной платформы.
