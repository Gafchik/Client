# Graph

**Статус:** Draft  
**Автор:** Principal Engineering Specification  
**Дата:** 2026-07-17  
**Версия:** 1.1.0  
**Зависимости:** [000-overview.md](/Users/evgenii/Desktop/client/docs/architecture/000-overview.md), [001-domain-model.md](/Users/evgenii/Desktop/client/docs/architecture/001-domain-model.md), [002-storage.md](/Users/evgenii/Desktop/client/docs/architecture/002-storage.md), [003-event-system.md](/Users/evgenii/Desktop/client/docs/architecture/003-event-system.md), [indexer.md](/Users/evgenii/Desktop/client/docs/modules/indexer.md)

---

## Оглавление

1. [Назначение](#1-назначение)
2. [Ответственность](#2-ответственность)
3. [Входные данные](#3-входные-данные)
4. [Выходные данные](#4-выходные-данные)
5. [Архитектура Graph](#5-архитектура-graph)
6. [Graph Model](#6-graph-model)
7. [Node Types](#7-node-types)
8. [Edge Types](#8-edge-types)
9. [Identity](#9-identity)
10. [Graph Updates](#10-graph-updates)
11. [Versioning](#11-versioning)
12. [Traversal Engine](#12-traversal-engine)
13. [Query Engine](#13-query-engine)
14. [Производительность](#14-производительность)
15. [Consistency](#15-consistency)
16. [Будущее развитие](#16-будущее-развитие)

---

## 1. Назначение

Graph — это центральное структурное представление проекта. Он существует для того, чтобы превратить разрозненные факты о файлах, символах, модулях, маршрутах, компонентах, миграциях, знаниях и артефактах в каноническую модель зависимостей проекта.

Graph нужен потому, что сама кодовая база не предоставляет удобного способа отвечать на структурные вопросы высокого уровня:

- какие сущности зависят от данного интерфейса;
- какие файлы и модули будут затронуты изменением метода;
- где находятся циклы;
- какие элементы принадлежат модулю;
- какие ADR, задачи и артефакты связаны с конкретной частью системы;
- какой путь зависимости ведёт от изменённого класса к документации, тестам, миграциям и runtime-элементам.

Graph существует не как техническая оптимизация, а как обязательный структурный слой платформы. Без него остальные модули были бы вынуждены каждый раз заново собирать картину связей из исходных артефактов проекта, что делает систему дорогой, медленной и плохо воспроизводимой.

Graph решает следующие классы задач:

1. Централизация структурной модели проекта.
2. Выполнение traversal и dependency queries.
3. Анализ влияния изменений.
4. Поиск путей и достижимости.
5. Выявление архитектурных аномалий и циклов.
6. Связывание кода с более высокоуровневыми сущностями: ADR, Task, Artifact, Knowledge links.
7. Поддержка контекстных и исследовательских запросов других модулей.

### Чем Graph отличается от AST

Graph не является AST.

AST — это язык-специфичное синтаксическое представление отдельного файла или source unit. Оно отражает структуру записи кода и используется Indexer как внутренний вычислительный слой.

Graph, напротив:

- является межфайловой и межмодульной моделью;
- агрегирует сущности из разных языков и источников;
- выражает отношения зависимости, а не синтаксическую вложенность как таковую;
- нормализует структурные факты в каноническую модель проекта;
- живёт дольше одной parsing session и версионируется как состояние проекта.

Если AST отвечает на вопрос "как записан данный файл", то Graph отвечает на вопрос "как устроен и связан весь проект".

### Чем Graph отличается от Knowledge

Graph не является Knowledge.

Knowledge хранит смысловые, исторические и объясняющие знания:

- почему было принято архитектурное решение;
- какие best practices применимы;
- какие альтернативы рассматривались;
- какие выводы были сделаны по результатам исследования.

Graph хранит не объяснения, а структурные факты и отношения:

- кто кому принадлежит;
- кто кого вызывает;
- кто от кого зависит;
- кто с чем связан.

Между ними существует мост, но не смешение:

- Knowledge может ссылаться на Graph;
- Graph может содержать узлы и связи, представляющие структурную привязку Knowledge;
- но Graph не заменяет текст, версионность и семантическую жизнь Knowledge.

### Что Graph не является

- не AST;
- не физическая база данных;
- не исходный код;
- не Knowledge base;
- не движок принятия архитектурных решений;
- не система исполнения задач.

Graph — это каноническая модель зависимостей проекта, а не её конкретное хранилище или низкоуровневая реализация.

---

## 2. Ответственность

### Что входит в ответственность Graph

- Поддержание канонической модели узлов и связей проекта.
- Приём структурных изменений от Indexer как единственного источника структурных изменений кода.
- Материализация сущностей и отношений в нормализованную graph-модель.
- Поддержание идентичности узлов и рёбер между версиями.
- Предоставление traversal и dependency query возможностей.
- Поддержание module-level, file-level и symbol-level отношений.
- Поддержание связей с ADR, Task, Artifact и другими сущностями, которым разрешено иметь структурное представление в Graph.
- Версионирование graph state по отношению к версии проекта.
- Обнаружение структурной неконсистентности и сигнализация о ней.
- Поддержание snapshot и rollback-ready представлений graph state.
- Публикация событий `GraphUpdated`, `NodeCreated`, `NodeRemoved`, `EdgeCreated`, `EdgeRemoved`, `GraphVersionCreated`.

### Что категорически не входит

- Graph не парсит исходный код и не строит AST.
- Graph не определяет структурные изменения самостоятельно; он принимает их от Indexer.
- Graph не изменяет файлы, репозиторий, конфигурацию или Workspace.
- Graph не хранит объясняющее знание вместо Knowledge.
- Graph не является продуктовой или пользовательской бизнес-моделью.
- Graph не выполняет задачи, тесты, build или runtime analysis.
- Graph не должен напрямую обходить Indexer и забирать факты из исходного кода вне протокола обновлений.
- Graph не должен принимать произвольные внешние мутации, нарушающие каноническую цепочку `Indexer -> Graph Update -> Graph`.

Ключевая граница: Graph владеет структурной моделью, но не владеет происхождением структурных фактов кода. Их происхождение — Indexer.

---

## 3. Входные данные

Graph получает данные из нескольких классов входов, но не все они равны по авторитетности.

### 3.1 Graph Update Packages от Indexer

Это основной вход Graph для структурных изменений кода.

Через Graph Update Packages Graph получает:

- новые узлы;
- изменения свойств существующих узлов;
- удаление устаревших узлов;
- новые рёбра;
- удаление рёбер;
- сведения о rename, move, merge, split;
- version markers;
- diagnostics level для частичных обновлений.

Для кода и его производных структурных сущностей Indexer является единственным каноническим источником изменений.

### 3.2 Project Metadata

Graph использует project-level metadata для:

- определения границ проекта;
- привязки graph state к `project_id`;
- маркировки корневого узла `Project`;
- понимания режимов проекта: монорепозиторий, multi-module, multi-language;
- разделения графов разных проектов.

### 3.3 Repository Metadata

Repository metadata нужна для:

- привязки graph version к commit hash;
- понимания branch/revision context;
- обработки rename/move, если они выражены на уровне репозитория;
- связывания graph history с repository history.

### 3.4 Manual Decisions (ADR)

Graph получает структурные сигналы о существовании ADR и их связях:

- узлы ADR;
- связи ADR между собой;
- связи ADR с кодовыми сущностями;
- статусы supersedes или replacement relations, если они выражены в структурной форме.

Важно: содержимое ADR остаётся в Knowledge, но Graph хранит структурную привязку ADR к проекту.

### 3.5 Configuration

Graph использует configuration для:

- правил query filtering;
- разрешённых типов узлов и связей;
- политики version retention;
- политики snapshot management;
- включения/отключения отдельных graph capabilities;
- совместимости с language- и framework-level extensions.

### 3.6 Неструктурные, но допустимые входы

Допустимы также структурированные сигналы от модулей, которым архитектурно разрешено иметь graph-представление:

- Task metadata;
- Artifact metadata;
- Knowledge link metadata;
- execution trace links, если они представлены как структурные узлы или рёбра;
- manual graph annotations, если они проходят через утверждённый протокол.

Эти входы не конкурируют с Indexer. Они относятся к некодовым частям модели проекта.

---

## 4. Выходные данные

Graph предоставляет не сырой доступ к внутреннему состоянию, а набор структурных возможностей для остальных модулей.

### 4.1 Traversal

Graph предоставляет traversal над канонической моделью:

- обход соседей;
- обход родителей;
- обход детей;
- traversal по типам связей;
- traversal с ограничением глубины;
- traversal внутри module boundary;
- traversal через mixed code/knowledge/task links, если это разрешено.

### 4.2 Dependency Queries

Graph должен уметь отвечать на вопросы вроде:

- от каких сущностей зависит данный узел;
- какие сущности зависят от него;
- есть ли связь между двумя узлами;
- какие модули импортируют данный модуль;
- где используются данные таблицы, маршруты, компоненты, интерфейсы.

### 4.3 Impact Queries

Graph должен поддерживать анализ зоны влияния:

- что может быть затронуто изменением узла;
- какие тесты связаны с этим классом;
- какие маршруты и компоненты опираются на изменяемый модуль;
- какие ADR и Artifact связаны с affected subgraph;
- какие downstream зависимости находятся в зоне риска.

### 4.4 Reachability

Graph должен предоставлять ответы на вопросы достижимости:

- достижим ли один узел из другого;
- есть ли путь между модулями;
- существует ли цепочка зависимости до конкретного runtime entry point;
- есть ли выход из module boundary.

**См. также 12.6:** реализованная функция `computeEntrypointReachability` отвечает на конкретную разновидность этого вопроса — «из скольких публичных маршрутов достижим данный файл» — через bounded BFS от каждого route-узла.

### 4.5 Module Relations

Graph должен уметь извлекать:

- связи между модулями;
- ownership внутри модуля;
- экспортную поверхность модуля;
- входящие и исходящие зависимости модуля;
- циклы между модулями;
- layered relations.

### 4.6 Symbol Relations

Graph должен предоставлять:

- связи class/method/function/component/route;
- связи file-to-symbol и symbol-to-file;
- inheritance и implementation tree;
- call graph;
- usage graph;
- code-to-database и code-to-config bindings.

### 4.7 Derived Structural Views

Graph должен уметь отдавать:

- subgraph для контекста;
- impact slice;
- module slice;
- route slice;
- database slice;
- documentation/ADR-linked slice;
- historical slice для конкретной graph version.

---

## 5. Архитектура Graph

Graph проектируется как самостоятельный модуль с набором внутренних компонентов, каждый из которых отвечает за собственную часть жизненного цикла графа.

### 5.1 Graph Coordinator

Главный оркестратор модуля.

Отвечает за:

- управление жизненным циклом graph session;
- приём update batches;
- координацию apply/validate/publish pipeline;
- переключение между current, snapshot и resync режимами;
- публикацию graph events.

### 5.2 Update Intake Manager

Отвечает за:

- приём Graph Update Packages;
- дедупликацию повторных структурных обновлений;
- классификацию update type;
- batching и ordering входящих изменений;
- защиту от нарушения causality.

### 5.3 Node Manager

Отвечает за:

- создание узлов;
- обновление свойств узлов;
- удаление устаревших узлов;
- управление node labels;
- контроль допустимых transition состояний узла.

### 5.4 Edge Manager

Отвечает за:

- создание рёбер;
- обновление edge properties;
- удаление рёбер;
- проверку типов отношений;
- контроль direction и multiplicity.

### 5.5 Identity Manager

Отвечает за:

- стабильную идентичность узлов;
- дедупликацию;
- merge policy;
- matching rename/move/split/merge scenarios;
- канонизацию identity across versions.

### 5.6 Version Manager

Отвечает за:

- привязку graph state к `graph_version`;
- history of graph versions;
- snapshot pointers;
- rollback metadata;
- resync boundaries.

### 5.7 Traversal Engine

Отвечает за:

- навигацию по графу;
- dependency traversal;
- reachability traversal;
- path-oriented traversal;
- cycle-oriented structural walk;
- impact traversal.

### 5.8 Query Engine

Отвечает за:

- подготовку query-oriented projections;
- специализированные запросы для Research, Context Builder, Planner;
- фильтрацию по version и scope;
- aggregation поверх traversal results;
- module and symbol relation lookups.

### 5.9 Consistency Validator

Отвечает за:

- проверку инвариантов модели;
- обнаружение отсутствующих обязательных связей;
- обнаружение конфликтующей идентичности;
- обнаружение нарушений referential integrity;
- подтверждение готовности graph version к публикации.

### 5.10 Integrity Checker

Отвечает за:

- периодические structural health checks;
- выявление orphan nodes;
- выявление dangling edges;
- проверку completeness после batch update;
- сигнализацию о corrupted state.

### 5.11 Graph Snapshot Manager

Отвечает за:

- формирование snapshot состояния graph;
- хранение snapshot metadata;
- reuse snapshot for rollback and recovery;
- управление incremental and stable graph snapshots.

### 5.12 Garbage Collector

Отвечает за:

- очистку устаревших промежуточных версий;
- удаление obsolete graph fragments;
- pruning старых временных артефактов;
- поддержание политики retention.

### 5.13 Merge and Reconciliation Manager

Отвечает за:

- обработку rename/move/merge/split cases;
- reconciliation между old and new graph state;
- conflict resolution для ambiguous update cases;
- минимизацию ложного churn узлов и рёбер.

### 5.14 Diagnostics and Statistics Manager

Отвечает за:

- накопление statistics по обновлениям graph;
- фиксацию нарушений инвариантов;
- формирование operational diagnostics;
- подготовку summary для observability и recovery.

### 5.15 Access Boundary Layer

Отвечает за:

- изоляцию внутренней модели Graph от модулей-потребителей;
- version-aware access;
- capability-based query exposure;
- недопущение несанкционированных структурных мутаций извне.

---

## 6. Graph Model

Graph Model — это каноническое описание того, из каких сущностей и отношений состоит структурная модель проекта.

### 6.1 Node

Node представляет одну сущность проекта в графе.

Node должен иметь:

- стабильную идентичность;
- тип;
- метку для человека;
- набор свойств;
- ссылку на происхождение;
- привязку к версии графа;
- статус актуальности;
- допустимые structural relations.

Node не является записью конкретной базы данных. Это логическая единица graph-модели.

### 6.2 Edge

Edge представляет направленное структурное отношение между двумя node.

Edge должен иметь:

- тип relation;
- source node;
- target node;
- direction;
- свойства;
- multiplicity semantics;
- версионный контекст;
- origin metadata.

### 6.3 Properties

Properties делятся на несколько классов:

#### Identity Properties

- canonical id;
- external/reference id;
- stable id;
- source key;
- version markers.

#### Structural Properties

- path;
- FQN;
- module id;
- symbol signature;
- relation location;
- declared visibility;
- symbol modifiers.

#### Operational Properties

- created_at version;
- updated_at version;
- graph_version;
- graph_version_until, если поддерживается историческое окно;
- confidence;
- diagnostics markers.

#### Domain-linked Properties

- route method/path;
- database table/column metadata;
- artifact type;
- ADR status;
- task status link;
- component role metadata.

### 6.4 Identity

Каждый node и edge должен иметь identity, позволяющую:

- uniquely distinguish entity within project context;
- переживать incremental updates;
- связывать исторические версии одной логической сущности;
- предотвращать дублирование;
- безопасно выполнять rename/move reconciliation.

Подробнее identity описана в отдельном разделе.

### 6.5 Labels

Labels используются для классификации узлов и, при необходимости, для secondary grouping.

Примеры label semantics:

- `Project`
- `Module`
- `File`
- `Class`
- `Method`
- `Route`
- `Component`
- `ADR`
- `Artifact`
- `TaskLink`
- `KnowledgeLink`

Labels должны быть типизированными, расширяемыми и не должны конфликтовать друг с другом по семантике.

### 6.6 Relationship Types

Relationship types описывают семантику связи. Они должны быть:

- дискретными;
- типизированными;
- направленными;
- совместимыми с traversal semantics;
- пригодными для version-aware updates.

### 6.7 Direction

Direction в Graph обязательна. Даже если связь кажется симметричной, её canonical representation должна иметь направление.

Направление нужно для:

- dependency reasoning;
- parent/child traversal;
- impact propagation;
- module boundary analysis;
- query determinism.

### 6.8 Multiplicity

Graph должен поддерживать семантику multiplicity:

- one-to-one;
- one-to-many;
- many-to-one;
- many-to-many.

Multiplicity важна не как storage detail, а как structural invariant:

- один `Method` принадлежит одному declaring container;
- один `File` может содержать много symbols;
- один `Module` может зависеть от многих modules;
- один `ADR` может относиться к многим nodes.

### 6.9 Source Attribution

Каждый узел и ребро должен иметь source attribution:

- `Indexer`;
- `Knowledge`;
- `Execution`;
- `Manual structural input`, если такое разрешено.

Это необходимо, чтобы понимать происхождение структурного факта и не смешивать кодовые и некодовые отношения.

---

## 7. Node Types

Ниже перечислены канонические типы узлов, которые Graph должен поддерживать как минимум на уровне архитектуры.

### 7.1 Core Project Nodes

#### Project

Корневой узел проекта.

Назначение:

- задаёт границу graph space;
- служит корнем ownership и containment;
- связывает graph с `project_id`.

#### Repository

Структурное представление репозитория как контейнера version-bound состояния.

Назначение:

- связывать graph с repository metadata;
- выражать revision context;
- поддерживать multi-repository future scenarios.

**Реализовано (2026-07-16/17), пунктиром:** кросс-репозиторный охват в реальности собирается не в `packages/graph`, а в вызывающем коде — `apps/api/src/pipeline-runner.ts`'s `buildCrossRepoStructuralData`. Для каждого затронутого НЕ-первичного корня строится отдельный selective workspace/index/graph по touched-файлам, `relativePath` релейблится префиксом `${label}/` до индексации (чтобы `stableId`, который никогда не хеширует абсолютный путь корня, не столкнул id символов между репозиториями со схожей структурой директорий), после чего получившиеся nodes/edges вливаются в основной граф обычной конкатенацией массивов. Само `packages/graph` про множественность корней ничего не знает — оно строит граф из того workspace/index, который ему передали. Первичный корень при этом не релейблится — судя по всему, осознанная асимметрия, но за подробностями этого решения нужно смотреть в сам `pipeline-runner.ts`, не в этот модуль.

#### Module

Логическая единица проектной структуры.

Назначение:

- группировка файлов и символов;
- модульный traversal;
- анализ зависимостей на уровне модуля;
- фиксация модульных границ.

#### Folder

Иерархический контейнер файловой системы.

Назначение:

- навигация по структуре проекта;
- связь с physical layout;
- support для folder-based ownership.

#### File

Узел файла как контейнера структурных сущностей.

Назначение:

- связывать кодовые symbols с физическим расположением;
- поддерживать file-level queries;
- быть опорной точкой для change application.

### 7.2 Language and Symbol Nodes

#### Class

Представляет класс как самостоятельную единицу проектной модели.

#### Interface

Представляет контракт, реализуемый другими узлами.

#### Trait

Представляет mixin-like reusable behavior construct.

#### Enum

Представляет перечисление как тип и как набор допустимых значений.

#### Method

Представляет метод класса или интерфейса.

#### Function

Представляет свободную функцию.

#### Property

Представляет поле, свойство, member slot или аналогичную структурную единицу.

#### Constant

Представляет константу как адресуемую структурную единицу.

#### Type

Представляет type alias, DTO-like declaration или другой именованный тип.

#### Parameter

Представляет параметр сигнатуры, если модель проекта требует адресуемости на этом уровне.

### 7.3 Application Structure Nodes

#### Component

UI-компонент или аналогичная композиционная единица интерфейса.

#### Route

Маршрут или endpoint binding между входным запросом и обработчиком.

#### HTTP Call

**Реализовано (2026-07-17):** узел сайта вызова HTTP-эндпоинта из фронтенда — конкретное место в JS/TS/Vue-коде, где вызывается backend-маршрут (например, `axios.post('/login')`). Экстрактор живёт в `packages/indexer`; Graph материализует такой символ как обычный узел с `kind: "http-call"` наравне с любым другим символом (`mapSymbolKindToGraphKind` в `packages/graph/src/index.ts` маппит `symbolKind: "http-call"` напрямую в одноимённый node kind, без специальной обработки). Label строится по тому же соглашению, что и у Route — `"METHOD /path"`, но с плейсхолдерами в синтаксисе фронтенд-фреймворка (`:param`), а не PHP-роутера (`{param}`). См. 8.10 о том, как эти узлы связываются с Route.

#### Event

Событие прикладного уровня, если оно извлекается как structural entity.

#### Listener

Структурный обработчик события.

#### Middleware

Промежуточная pipeline-единица запроса или обработки.

#### Controller

Если проект требует отдельной semantic классификации контроллеров сверх обычных классов, такой тип должен быть поддерживаем как специализация.

#### Service

Аналогично контроллеру, service node может быть domain-specialized classification поверх class node.

### 7.4 Data and Persistence Nodes

#### Migration

Структурная единица изменения схемы данных.

#### DatabaseTable

Представление таблицы базы данных.

#### DatabaseColumn

Представление колонки таблицы.

#### Index

Структурное представление database index.

#### Constraint

Structural constraint node для PK/FK/unique/check-like constructs.

#### Model

ORM-level представление сущности данных, если это извлекается как отдельный structural node.

### 7.5 Documentation and Knowledge-adjacent Nodes

#### ADR

Структурное представление архитектурного решения.

Назначение:

- связывать код и принятые решения;
- поддерживать supersession chains;
- участвовать в context assembly.

#### Knowledge Link

Не Knowledge document целиком, а structural node или anchor, связывающий graph with knowledge space.

Назначение:

- точка привязки знаний к subgraph;
- структурная навигация из Graph в Knowledge.

#### Documentation

Документационный узел, если документы включаются в структурную навигацию проекта.

### 7.6 Task and Execution-adjacent Nodes

#### Task Link

Структурная привязка задачи к части графа.

Назначение:

- связывать work item с affected subgraph;
- поддерживать traceability.

#### Artifact

Структурное представление immutable artifact.

Назначение:

- связывать результат выполнения с graph version;
- support traceability между задачами, кодом и результатами.

#### Execution Plan

Если execution plan нужен как graph-level structural entity, он должен быть представлен как узел отдельного типа.

#### Execution Step

Представляет конкретный шаг исполнения в traceability graph.

### 7.7 Infrastructure and External Nodes

#### APIEndpoint

Внешний API endpoint, с которым взаимодействует проект.

#### ExternalResource

Внешний ресурс, если он структурно привязан к проекту.

#### Provider

Провайдер как инфраструктурная сущность, если нужен graph-level linkage.

### 7.8 Future-compatible Nodes

Архитектура должна допускать добавление новых node types:

- Feature;
- Package;
- Namespace;
- Test Suite;
- Environment Binding;
- Config Entry;
- Queue;
- Job;
- Command;
- Policy;
- Schema;
- Workspace Anchor.

Добавление нового типа узла не должно ломать существующую graph-модель, если соблюдены правила identity, labeling и relation typing.

---

## 8. Edge Types

Graph должен поддерживать богатую типизацию отношений. Ниже перечислены канонические edge types и их семантика.

### 8.1 Structural Ownership and Containment

#### OWNS

Описывает ownership relation верхнеуровневой сущности:

- `Project OWNS Module`
- `Repository OWNS Project slice`

#### BELONGS_TO

Описывает relation принадлежности:

- `File BELONGS_TO Module`
- `Method BELONGS_TO Class`
- `Class BELONGS_TO File`

#### CONTAINS

Описывает containment relation:

- `Folder CONTAINS Folder`
- `Folder CONTAINS File`

### 8.2 Dependency and Usage Relations

#### DEPENDS_ON

Общая зависимость между узлами, чаще всего на уровне module, package или subsystem.

#### USES

Нестрогое использование одной сущности другой без более узкой классификации.

#### IMPORTS

Фиксирует import/include/use/export relation на уровне файла или модуля.

#### REFERENCES

Фиксирует структурную ссылку, которая не обязательно означает runtime dependency.

#### LINKS_TO

Более слабая структурная связь между разными типами graph entities.

### 8.3 Type and Inheritance Relations

#### IMPLEMENTS

Класс или аналогичная сущность реализует контракт.

#### EXTENDS

Наследование или hierarchy extension.

#### MIXES_IN

Trait/mixin/composition-based structural reuse relation.

#### DEFINES

Связь контейнера с определяемой в нём сущностью, если это полезно отделять от `BELONGS_TO`.

### 8.4 Runtime and Behavioral Relations

#### CALLS

Описывает relation вызова.

#### READS

Описывает чтение данных или свойства.

#### WRITES

Описывает запись в данные, состояние или storage-related target.

#### CREATES

Описывает создание экземпляра, объекта, записи или артефакта.

#### RETURNS

Описывает relation возврата значимого структурного типа, если система моделирует его явно.

### 8.5 Event-driven Relations

#### EMITS

Узел публикует событие.

#### LISTENS

Узел слушает событие.

#### HANDLES

Узел обрабатывает запрос, route, event или command.

### 8.6 Data and Persistence Relations

#### MIGRATES

Migration изменяет table/schema object.

#### READS_FROM

Узел читает данные из storage-like entity.

#### WRITES_TO

Узел записывает данные в storage-like entity.

#### GENERATES

Узел порождает другой структурный объект:

- execution step generates artifact;
- code generator generates file.

### 8.7 Traceability Relations

#### RELATES_TO

Слабая, но осмысленная семантическая связь.

#### AFFECTS

Потенциальное влияние одного узла на другой.

#### PRODUCES

Шаг или run produce artifact or code outcome.

#### SUPERSEDES

Новая версия или решение замещает прежнее.

#### PRECEDES

Определяет последовательность или ordering relation.

### 8.8 Conflict and Integrity Relations

#### CONFLICTS_WITH

Описывает structural или task-level конфликт.

#### DUPLICATES

Может использоваться для фиксации выявленного дублирования, если это включено в graph semantics.

### 8.9 Edge Direction and Semantics

Для каждого edge type архитектура должна однозначно определить:

- source semantics;
- target semantics;
- допустимые source node types;
- допустимые target node types;
- multiplicity expectations;
- whether relation is strong or weak;
- whether relation participates in impact traversal.

### 8.10 Реализовано (2026-07-17): линковка HTTP-вызовов с маршрутами

Route-узлы (из PHP-роутера, label вида `GET /users/{id}`) и HTTP Call узлы (из фронтендового JS/TS/Vue, label вида `GET /users/:param`) индексируются полностью независимо друг от друга — часто в буквально разных физических репозиториях, разными экстракторами. Ни один из них не знает о существовании другого на момент индексации, поэтому связать их можно только постфактум, когда обе стороны уже присутствуют в одном и том же графе.

Для этого экспортируется `linkHttpCallsToRoutes(graph)` (`packages/graph/src/index.ts`). Функция не вызывается автоматически внутри `buildGraph` — это осознанно: `buildGraph` строит граф одного workspace/index, а связывание имеет смысл только после того, как secondary-репозитории уже смержены в основной граф (см. 7.1). Вызывающая сторона (`apps/api/src/pipeline-runner.ts`) вызывает её один раз явно, сразу после любого cross-repo merge — и для team-mode, и для legacy deterministic пути.

Механика: оба label'а нормализуются общей функцией `normalizeRouteLikeLabel` — метод приводится к верхнему регистру, синтаксис плейсхолдеров обоих фреймворков (`{id}`, `:id`) схлопывается к единому `:param`, задвоенные и завершающий слэши убираются. Совпавшие по нормализованному label пары route/http-call получают ребро `CALLS` (`http-call -> route`) с детерминированным `stableId`, что делает функцию идемпотентной при повторном вызове на графе, где такие рёбра уже есть.

Ценность этого шага в том, что он не требует отдельного traversal-кода: `getFileDependents`/`getSymbolDependents` уже умеют ходить по `CALLS`-рёбрам (см. 12.1, 12.6). Как только `linkHttpCallsToRoutes` добавила `CALLS` между конкретным вызовом и конкретным маршрутом, оба этих запроса начинают прозрачно прослеживать влияние через границу фронтенд/бэкенд — просто потому что `CALLS` уже входит в их список отслеживаемых типов рёбер, без единой новой строчки traversal-логики.

---

## 9. Identity

Стабильная идентичность — центральное условие существования Graph как канонической модели.

### 9.1 Требования к identity узлов

Identity узла должна:

- быть уникальной в рамках проекта и типа сущности;
- быть достаточно стабильной между версиями;
- позволять сопоставлять исторические версии одной логической сущности;
- не опираться только на path или line numbers;
- поддерживать rename и move, если логическая сущность сохраняется.

### 9.2 Требования к identity рёбер

Identity edge должна зависеть от:

- relation type;
- canonical source identity;
- canonical target identity;
- structural qualifiers, если они важны;
- version context.

### 9.3 Как предотвращается дублирование

Graph должен предотвращать дублирование за счёт:

- централизованного `Identity Manager`;
- canonical node key generation;
- matching against existing active nodes;
- merge rules;
- consistency validation before final commit;
- uniqueness policy within active graph version.

### 9.4 Stable Identity и исторические версии

Необходимо различать:

- logical identity;
- active versioned instance;
- historical lineage.

Это позволяет одновременно иметь:

- текущую актуальную сущность;
- историческую запись о предыдущем состоянии;
- непрерывную цепочку идентичности между версиями.

### 9.5 Как работают merge

Merge нужен, когда несколько входных изменений указывают на одну и ту же логическую сущность.

Graph должен поддерживать merge в сценариях:

- rename with preserved identity;
- move with preserved semantic role;
- provider improvement, когда новая интерпретация объединяет раньше раздробленные сущности;
- reconciliation между temporary duplicate candidates.

Merge не должен silently ломать history. Он обязан:

- сохранять lineage;
- явно фиксировать source mapping;
- не терять связанные edges;
- пересчитывать ownership and dependency bindings детерминированно.

### 9.6 Ambiguous Identity

Если identity не может быть надёжно разрешена, Graph должен:

- пометить случай как ambiguous;
- не выполнять разрушительный merge без достаточного подтверждения;
- сохранить diagnostics;
- при необходимости использовать более безопасный сценарий add/remove вместо ложного merge.

---

## 10. Graph Updates

Graph Updates — это управляемый процесс перевода входного structural delta в новый graph state.

### 10.1 Общий принцип

Graph не должен интерпретировать произвольный diff текста или AST. Он применяет только нормализованные структурные изменения.

Общий порядок:

1. принять update package;
2. упорядочить изменения;
3. сопоставить identities;
4. применить node changes;
5. применить edge changes;
6. провести validation;
7. зафиксировать graph version state;
8. опубликовать graph events.

### 10.2 Добавление

При добавлении:

- создаются новые nodes;
- назначаются labels и properties;
- связываются mandatory ownership relations;
- добавляются incoming/outgoing edges;
- валидируется отсутствие duplicate active identity.

### 10.3 Удаление

При удалении:

- удаляются или деактивируются устаревшие node instances текущей версии;
- удаляются связанные edges, утратившие актуальность;
- проверяется, не появились ли orphan fragments;
- фиксируется lineage удаления.

### 10.4 Rename

Rename не должен автоматически трактоваться как delete + add.

Graph должен:

- попытаться сохранить logical identity;
- обновить label, naming properties и path/FQN-related fields;
- пересчитать affected edges;
- сохранить continuity history.

### 10.5 Move

Move требует:

- обновления containment and ownership relations;
- возможного обновления module bindings;
- пересмотра path-based или namespace-based properties;
- проверки, сохраняется ли logical identity.

### 10.6 Merge

При merge:

- объединяются duplicate или converging entities;
- edges переносятся на canonical target;
- historical lineage сохраняется;
- consistency validator подтверждает отсутствие broken references.

### 10.7 Split

При split одна прежняя logical entity превращается в несколько новых graph entities.

Graph должен:

- завершить lifecycle старой structural version;
- создать новые nodes;
- перераспределить edges и ownership;
- сохранить traceability split event.

### 10.8 Batch Update

Graph должен уметь применять изменения batch-ами.

Batch update нужен для:

- коммитов с множеством файлов;
- full index ingestion;
- resync;
- массовых модульных изменений.

Batch update должен поддерживать:

- ordering внутри scope;
- grouping связанных изменений;
- partial validation;
- rollback on failed batch.

### 10.9 Rollback

Rollback нужен для:

- отката невалидного batch;
- восстановления после partial corruption;
- отката к предыдущему snapshot;
- отказоустойчивой обработки failed update session.

Rollback не должен зависеть от повторного парсинга кода; он должен быть возможен на основе graph versioning и snapshots.

---

## 11. Versioning

Versioning превращает Graph из текущей картинки в воспроизводимую структурную историю проекта.

### 11.1 Версии Graph

Каждая версия Graph должна быть привязана к конкретной версии проекта, обычно выраженной через commit hash или эквивалентный repository revision marker.

Graph version должна фиксировать:

- project scope;
- source revision;
- snapshot lineage;
- applied update set;
- validation status.

### 11.2 Snapshot

Graph Snapshot — это зафиксированное представление graph state на определённый момент.

Snapshot нужен для:

- быстрого восстановления;
- rollback;
- reproducibility;
- fast bootstrap for query consumers;
- comparison between versions.

### 11.3 Rollback

Rollback должен уметь:

- возвращать active pointer к предыдущей валидной graph version;
- отменять failed update session;
- восстанавливать consistency после частичного применения batch;
- сохранять audit trail rollback operation.

### 11.4 Resync

Resync — это полная перестройка Graph из авторитетных источников структурных данных.

Resync требуется при:

- утрате доверия к graph consistency;
- несовместимом обновлении Indexer/Graph semantics;
- смене model rules;
- повреждении state;
- необходимости полного reconciliation.

### 11.5 История изменений

Graph должен хранить не только актуальное состояние, но и историю изменений:

- какие узлы были добавлены;
- какие были обновлены;
- какие были удалены;
- как сущность пережила rename или move;
- какие edges появились или исчезли.

### 11.6 Active и Historical Views

Архитектура должна различать:

- active graph view;
- historical versioned view;
- snapshot view;
- resync-in-progress view, если он нужен для operational safety.

### 11.7 GraphVersionCreated

Создание новой graph version является отдельным завершённым структурным фактом и должно быть observable через событие `GraphVersionCreated`.

---

## 12. Traversal Engine

Traversal Engine отвечает за навигацию по графу как по канонической модели зависимостей.

### 12.1 Поиск зависимостей

Traversal Engine должен уметь искать:

- прямые зависимости;
- обратные зависимости;
- зависимости по определённым типам рёбер;
- зависимости внутри модульных границ;
- смешанные dependency chains.

### 12.2 Поиск родителей

Graph должен уметь находить родителей сущности:

- declaring container;
- owning module;
- containing file;
- higher structural scope;
- parent in hierarchy.

### 12.3 Поиск детей

Graph должен уметь находить дочерние сущности:

- symbols внутри file/class/module;
- nodes, принадлежащие parent entity;
- structural descendants по containment или ownership.

### 12.4 Поиск путей

Traversal Engine должен поддерживать path-oriented traversal:

- кратчайший структурный путь;
- один или несколько допустимых путей;
- typed path search;
- path search within bounded scope;
- path search across code-to-knowledge/code-to-task links.

### 12.5 Поиск циклов

Graph должен поддерживать cycle-oriented traversal:

- file cycles;
- module cycles;
- import cycles;
- dependency cycles;
- inheritance cycles;
- mixed structural cycles.

### 12.6 Поиск зон влияния

Impact traversal должен позволять находить:

- downstream affected nodes;
- related tests;
- related routes/components;
- affected modules;
- related ADR and artifacts;
- border of affected subgraph.

**Реализовано (2026-07-17): `computeEntrypointReachability`.** Баг в файле, через который реально проходит десяток публичных маршрутов, — это принципиально другой класс риска, чем тот же баг в файле, куда ведёт только один малоиспользуемый admin-маршрут; одного структурного счётчика «затронуто N файлов» для такого различия недостаточно. `computeEntrypointReachability(graph, maxDepth = 4)` (`packages/graph/src/index.ts`) делает это различие явным: adjacency-карта исходящих рёбер строится один раз для всего графа, затем от каждого route-узла отдельно выполняется BFS по обычным структурным рёбрам — не только по `CALLS`, поскольку маршрут обычно доходит до настоящей логики через цепочку `REFERENCES`/`BELONGS_TO`/`CONTAINS` (через контроллер), раньше, чем встретится хоть одно `CALLS`-ребро. Глубина обхода ограничена `maxDepth`, чтобы стоимость не росла вместе с размером графа. Результатом является `Map<filePath, Set<routeLabel>>` — для каждого достигнутого файла собирается множество различных публичных маршрутов, из которых он достижим. Эту функцию использует другой пакет, `packages/impact-analysis`, как сигнал риска «hot path»; сама Graph не знает и не должна знать, как этот сигнал интерпретируется downstream.

### 12.7 Ограничения traversal

Traversal Engine не должен:

- выполнять произвольную бизнес-интерпретацию;
- подменять собой Query Engine;
- оперировать невалидным graph state без явной деградации;
- зависеть от знания конкретного языка на уровне AST semantics.

---

## 13. Query Engine

Query Engine превращает graph model и traversal capabilities в формы, полезные для модулей-потребителей.

### 13.1 Общие виды запросов

Graph должен поддерживать как минимум следующие классы запросов:

- node lookup;
- edge lookup;
- relation lookup;
- dependency lookup;
- ownership lookup;
- impact lookup;
- path lookup;
- cycle lookup;
- reachability lookup;
- version-aware lookup;
- subgraph extraction.

### 13.2 Что должен уметь получать Research

Research Engine должен уметь получать:

- связанную структурную область задачи;
- module and symbol neighborhood;
- paths between important entities;
- связанные ADR links;
- affected subgraph;
- architectural hotspots;
- evidence of coupling and boundaries.

### 13.3 Что должен уметь получать Context Builder

Context Builder должен уметь получать:

- minimal relevant subgraph для конкретной задачи;
- ownership chain сущности;
- direct and indirect dependencies;
- related files/modules/components/routes;
- graph-aligned structural context для сборки prompt/package.

### 13.4 Что должен уметь получать Planner

Planner должен уметь получать:

- список затронутых модулей;
- dependencies between work areas;
- sequencing hints через structural constraints;
- конфликтующие области;
- related artifacts and task links;
- graph evidence for impact-driven plan decomposition.

### 13.5 Query Scope Control

Query Engine должен поддерживать:

- фильтрацию по graph version;
- фильтрацию по node types;
- фильтрацию по relation types;
- module-scoped queries;
- depth-limited queries;
- historical queries;
- active-only queries.

### 13.6 Query Reliability

Если graph state частично деградирован, Query Engine должен уметь:

- помечать результат как partial;
- возвращать diagnostics вместе с query outcome;
- не выдавать полную достоверность там, где её нет;
- поддерживать fail-open или fail-safe режим в зависимости от класса запроса.

---

## 14. Производительность

Graph должен быть спроектирован как постоянно обновляемая и часто запрашиваемая структурная система.

### 14.1 Batch Update

Batch updates нужны для:

- high-throughput ingestion from Indexer;
- full index population;
- module-wide changes;
- resync.

Batching должно уменьшать накладные расходы без потери точности rollback и validation.

### 14.2 Lazy Loading

Graph должен поддерживать lazy-oriented materialization доступа:

- не все представления subgraph должны собираться заранее;
- traversal slices могут строиться по запросу;
- historical views могут загружаться выборочно;
- expensive projections должны вычисляться по необходимости.

### 14.3 Cache

Graph должен использовать кэширование для:

- hot node lookups;
- hot subgraphs;
- repeated dependency queries;
- module relation views;
- version pointers;
- query result summaries.

Cache должен быть tightly linked with `GraphUpdated` invalidation semantics.

### 14.4 Snapshot Reuse

Snapshot reuse должен использоваться для:

- быстрого bootstrap;
- rollback;
- partial rebuild;
- version comparison;
- recovery after transient failures.

### 14.5 Incremental Update

Incremental update — главный performance mode Graph.

Graph должен минимизировать:

- полную перестройку активной версии;
- unnecessary node churn;
- повторное materialization unchanged subgraph;
- массовую инвалидизацию без причины.

### 14.6 Memory Optimization

Graph архитектурно должен избегать моделей, требующих полной загрузки всего проекта в оперативное представление для каждого запроса.

Необходимы:

- scope-bounded traversal;
- selective projections;
- bounded in-memory update windows;
- reuse of immutable snapshots where possible.

### 14.7 Query Cost Discipline

Graph должен различать:

- cheap local queries;
- medium cross-module queries;
- expensive path/cycle queries;
- historical multi-version queries.

Это нужно для правильной операционной политики и observability.

---

## 15. Consistency

Consistency — это способность Graph оставаться канонической структурной моделью даже при частых инкрементальных обновлениях, сбоях и частичной деградации.

### 15.1 Основные инварианты

Graph обязан соблюдать по крайней мере следующие инварианты:

- каждый active node имеет валидную identity;
- не существует двух active nodes с конфликтующей canonical identity в одном проекте и одной graph version;
- каждое active edge ссылается на существующие узлы;
- mandatory ownership relations присутствуют;
- direction relation соответствует типу edge;
- graph version state не публикуется как active до завершения validation;
- structural provenance узлов и рёбер не теряется;
- updates применяются в корректном порядке относительно scope.

### 15.2 Как обнаруживаются повреждения

Повреждения могут выявляться через:

- failed validation при apply;
- periodic integrity checks;
- orphan node detection;
- dangling edge detection;
- duplicate identity detection;
- inconsistency between graph version markers;
- missing mandatory relation detection;
- mismatch between snapshot metadata и active view.

### 15.3 Как выполняется восстановление

Recovery должен поддерживать несколько уровней:

#### Local Repair

Исправление ограниченного участка graph state:

- удаление dangling edges;
- восстановление ownership relations;
- recompute ограниченного subgraph.

#### Version Rollback

Возврат к предыдущей валидной graph version.

#### Snapshot Restore

Восстановление из согласованного graph snapshot.

#### Full Resync

Полная перестройка Graph из Indexer-produced structural source of truth.

### 15.4 Поведение при частичной деградации

Если часть Graph недостоверна, система не должна silently притворяться полностью консистентной.

Graph должен:

- маркировать degraded scope;
- выдавать diagnostics;
- ограничивать trusted query modes, если нужно;
- позволять остальной части graph продолжать работу.

### 15.5 Роль Consistency Validator

Consistency Validator должен быть обязательным этапом между update application и публикацией новой активной graph version.

Без validation graph превращается из канонической модели в вероятностную структуру, что для платформы недопустимо.

---

## 16. Будущее развитие

Архитектура Graph должна быть рассчитана на расширение без смены базовой модели.

### 16.1 Что должно добавляться без изменения архитектуры Graph

- новые node types;
- новые edge types;
- новые version-aware query modes;
- новые traversal projections;
- новые traceability relations;
- новые infrastructure and runtime structural nodes;
- новые bridge-relations к Knowledge, Task, Artifact, Provider space;
- richer historical views;
- richer validation rules;
- richer impact-oriented slices.

### 16.2 Что должно масштабироваться без переписывания Graph

- увеличение числа языков;
- рост размера проекта;
- монорепозитории;
- множественные модули и bounded contexts;
- больше типов структурных сущностей;
- больше частоты инкрементальных обновлений;
- больше downstream query consumers.

### 16.3 Что не должно меняться

Следующие принципы должны оставаться неизменными:

- Indexer остаётся единственным источником структурных изменений кода;
- Graph остаётся канонической моделью зависимостей проекта;
- Knowledge не подменяет Graph, а Graph не подменяет Knowledge;
- Graph не равен AST;
- Graph не равен физической базе данных;
- versioned, validated, queryable structural model остаётся ядром модуля.

### 16.4 Стратегический результат

Зрелый Graph должен стать тем модулем, через который вся платформа понимает проект как связанную систему, а не как набор файлов.

Он должен обеспечивать:

- устойчивую идентичность сущностей;
- воспроизводимую историю структурных изменений;
- быстрый доступ к зависимостям и зонам влияния;
- чёткое разделение с AST, Knowledge и storage layer;
- возможность расти вместе с проектом и платформой без архитектурного перелома.

Именно в этом качестве Graph становится фундаментом для Research, Context Builder, Planner, Impact Analysis и всех последующих модулей, которым нужна не просто информация о коде, а каноническая структурная модель проекта.
