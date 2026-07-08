# Impact Analysis Engine

**Статус:** Спецификация
**Автор:** Архитектурный Комитет
**Дата:** 2026-07-08
**Версия:** 1.0.0
**Зависимости:** [000-overview.md](../architecture/000-overview.md), [001-domain-model.md](../architecture/001-domain-model.md), [003-event-system.md](../architecture/003-event-system.md), [004-dependency-map.md](../architecture/004-dependency-map.md), [graph.md](./graph.md), [research.md](./research.md), [context-builder.md](./context-builder.md), [planner.md](./planner.md)

---

## Оглавление

1. [Назначение](#1-назначение)
2. [Ответственность](#2-ответственность)
3. [Входные данные](#3-входные-данные)
4. [Выходные данные](#4-выходные-данные)
5. [Архитектура модуля](#5-архитектура-модуля)
6. [Типы анализа влияния](#6-типы-анализа-влияния)
7. [Полный Pipeline](#7-полный-pipeline)
8. [Определение starting point изменения](#8-определение-starting-point-изменения)
9. [Использование Graph](#9-использование-graph)
10. [Использование Research](#10-использование-research)
11. [Использование Knowledge](#11-использование-knowledge)
12. [Dependency Traversal](#12-dependency-traversal)
13. [Blast Radius](#13-blast-radius)
14. [Risk Analysis](#14-risk-analysis)
15. [Conflict Detection](#15-conflict-detection)
16. [Validation Scope](#16-validation-scope)
17. [Impact Report](#17-impact-report)
18. [Confidence Model](#18-confidence-model)
19. [Versioning и Reuse](#19-versioning-и-reuse)
20. [Производительность](#20-производительность)
21. [Отказоустойчивость](#21-отказоустойчивость)
22. [Ограничения](#22-ограничения)
23. [Будущее развитие](#23-будущее-развитие)

---

## 1. Назначение

### Что такое Impact Analysis Engine

Impact Analysis Engine — это обязательный модуль в конвейере обработки задачи, расположенный **между Research Engine и Context Builder**. Его единственная задача — определить **все последствия предполагаемого изменения до того, как изменение будет спланировано**.

Impact Analysis Engine не пишет код. Он не принимает финальных инженерных решений. Он не предлагает, *как* решать задачу. Он отвечает на вопрос: **«Что будет затронуто, если мы начнём это менять?»**

### Почему он обязателен между Research и Planner

```
Research Engine                    Impact Analysis Engine               Planner
─────────────────                  ────────────────────────             ─────────
"Что существует?"        ──►        "Что будет затронуто?"     ──►      "Как это сделать?"
Какие файлы, классы,               Какие зависимости,                  План действий,
модули, ADR, история?              риски, конфликты?                   шаги, агенты
```

- **Research** отвечает на вопросы *«что есть в системе?»*: находит сущности, собирает историю, извлекает ADR, описывает текущее состояние.
- **Planner** отвечает на вопрос *«как реализовать изменение?»*: декомпозирует задачу, строит DAG шагов, назначает агентов.
- **Impact Analysis** заполняет критический разрыв между ними: *«что будет затронуто изменением?»*

Без Impact Analysis Planner вынужден либо строить план на неполной информации о последствиях, либо выполнять анализ влияния самостоятельно — что размывает его ответственность и создаёт риск пропуска критических зависимостей.

### Какие задачи решает

1. **Определение зоны поражения (Blast Radius):** какие модули, файлы, классы, функции, таблицы, API, маршруты будут затронуты.
2. **Обнаружение скрытых зависимостей:** транзитивные зависимости, которые не очевидны из прямого просмотра кода.
3. **Оценка рисков:** архитектурные, регрессионные, интеграционные, data/schema, concurrency риски.
4. **Обнаружение конфликтов:** пересечения с другими активными задачами, конфликты по файлам, символам, модулям, миграциям.
5. **Формирование Validation Scope:** что нужно будет проверить после изменения — тесты, модули, API, документация.
6. **Оценка сложности и уверенности:** насколько сложным будет изменение, насколько мы уверены в анализе.

### Чем отличается от Research

| Аспект | Research Engine | Impact Analysis Engine |
|--------|----------------|----------------------|
| **Вопрос** | «Что существует в системе?» | «Что будет затронуто изменением?» |
| **Направление** | От задачи → к сущностям | От сущностей → к последствиям |
| **Результат** | Research Report (найденные сущности, ADR, история) | Impact Report (зона влияния, риски, конфликты) |
| **Глубина** | Широкий поиск: файлы, символы, документация, Git | Глубокий траверс: зависимости, транзитивные связи |
| **Использование Graph** | Точечные запросы: найти сущность, найти модуль | Массовый траверс: affected subgraph, transitive closure |
| **Работа с рисками** | Предупреждения о найденных проблемах | Систематическая оценка всех классов риска |
| **Конфликты** | Не анализирует | Активно ищет пересечения с другими задачами |

### Чем отличается от Graph

| Аспект | Graph | Impact Analysis Engine |
|--------|-------|----------------------|
| **Роль** | Каноническая структурная модель проекта | Потребитель Graph, интерпретатор для конкретного изменения |
| **Хранение** | Хранит узлы и рёбра | Не хранит ничего постоянно (кроме Impact Report) |
| **Запросы** | Предоставляет общие traversal API | Формулирует конкретные impact-запросы к Graph |
| **Интерпретация** | Не интерпретирует — отдаёт данные как есть | Интерпретирует: превращает traversal results в риски, конфликты, рекомендации |
| **Знание о задачах** | Не знает о задачах | Знает о контексте задачи и активных задачах |
| **Историчность** | Хранит версии графа | Коррелирует текущий граф с историческими Impact Reports |

Impact Analysis Engine использует Graph как **источник структурной истины**, но добавляет к этому:
- знание о контексте задачи (Research Report);
- знание о других активных задачах;
- знание об исторических инцидентах и рисках (Knowledge);
- интерпретацию traversal results в терминах рисков и конфликтов.

---

## 2. Ответственность

### Что входит в ответственность

1. **Приём Research Report** и извлечение из него предполагаемых точек изменения (starting entities).
2. **Нормализация change intent:** преобразование пользовательского описания задачи в структурные starting points.
3. **Определение starting entities:** точное установление узлов Graph, которые будут изменены напрямую.
4. **Траверс зависимостей:** обход прямых, обратных, транзитивных зависимостей от starting entities.
5. **Построение affected set:** полного множества затронутых узлов Graph — файлов, классов, функций, модулей, таблиц, API, маршрутов.
6. **Оценка Blast Radius:** классификация масштаба влияния (малый, средний, высокий), глубина и ширина распространения.
7. **Оценка рисков:** формирование risk markers по всем классам риска.
8. **Обнаружение конфликтов:** поиск пересечений affected set с активными задачами и текущим состоянием проекта.
9. **Формирование Validation Scope:** определение, какие тесты, модули, API должны быть проверены после изменения.
10. **Оценка уверенности (confidence):** количественная и качественная оценка полноты и достоверности анализа.
11. **Формирование Impact Report:** структурированного документа, передаваемого в Context Builder и Planner.
12. **Версионирование Impact Report:** привязка к graph version, commit hash, research id.
13. **Диагностика:** явное указание на неполноту, неопределённость, источники ошибок.

### Что НЕ входит в ответственность

1. **Написание кода.** Impact Analysis Engine не генерирует и не модифицирует исходный код.
2. **Принятие инженерных решений.** Impact Analysis Engine не решает, *как* реализовать изменение — это задача Planner.
3. **Построение плана.** Impact Analysis Engine не строит Execution Plan.
4. **Сборка контекста для LLM.** Impact Report передаётся в Context Builder, который самостоятельно собирает Context Package.
5. **Валидация кода.** Impact Analysis Engine не выполняет тесты и не проверяет корректность кода — он лишь определяет, *что нужно будет проверить*.
6. **Управление задачами.** Impact Analysis Engine не создаёт и не назначает задачи — он лишь обнаруживает конфликты между существующими.
7. **Хранение графа.** Impact Analysis Engine не хранит структурную модель — он только читает Graph.
8. **Парсинг кода.** Impact Analysis Engine не анализирует исходный код напрямую — он полагается на Graph и Research.
9. **Поиск информации.** Impact Analysis Engine не выполняет research — он получает готовый Research Report.
10. **Приоритезация задач.** Impact Analysis Engine не решает, какая задача важнее при конфликте — это задача Planner и Human Approval.

---

## 3. Входные данные

### 3.1 User Intent

| Поле | Источник | Назначение |
|------|----------|-----------|
| `taskId` | API Gateway → Event `TaskReceived` | Идентификатор задачи |
| `description` | `UserIntent.description` | Описание предполагаемого изменения на естественном языке |
| `constraints` | `UserIntent.constraints` | Ограничения (язык, фреймворк, область) |
| `scope` | `UserIntent.scope` | Ограничение области (файлы, модули) |
| `priority` | `UserIntent.priority` | Приоритет задачи |

### 3.2 Research Report (обязательный)

Предоставляется Research Engine через событие `ResearchCompleted`.

| Поле | Назначение |
|------|-----------|
| `foundEntities` | Найденные релевантные сущности — кандидаты в starting entities |
| `relevantADRs` | Архитектурные решения, относящиеся к затрагиваемой области |
| `history` | История изменений затронутых файлов (частота, авторы, связанные задачи) |
| `recommendations` | Рекомендации Research по подходам и паттернам |
| `warnings` | Предупреждения Research о потенциальных проблемах |
| `completeness` | Оценка полноты исследования (0.0–1.0) |
| `unansweredQuestions` | Вопросы без ответа — потенциальные источники неопределённости |
| `sourceReferences` | Ссылки на источники — файлы, документация, внешние ресурсы |
| `crossReferences` | Перекрёстные связи — что ещё Research считает связанным |

### 3.3 Graph (обязательный)

Предоставляется модулем Graph через API (прямой вызов).

| Запрос | Назначение |
|--------|-----------|
| `getNode(nodeId)` | Получение узла для верификации starting entity |
| `getDependents(nodeId, depth)` | Обратные зависимости: кто зависит от узла |
| `getDependencies(nodeId, depth)` | Прямые зависимости: от чего зависит узел |
| `getAffectedSubgraph(nodeIds[])` | Подграф, затронутый изменениями |
| `findPaths(sourceId, targetId)` | Пути между узлами |
| `findCycles(scope?)` | Циклические зависимости в affected set |
| `getModuleStructure(moduleId)` | Структура модуля для оценки module-level impact |
| `queryGraph(query: GraphQuery)` | Произвольный графовый запрос |
| `getCurrentVersion()` | Текущая версия графа |

### 3.4 Knowledge (обязательный)

Предоставляется модулем Knowledge через API.

| Запрос | Назначение |
|--------|-----------|
| `searchByEntity(entityId)` | Исторические Impact Reports, связанные с сущностью |
| `searchSemantic(query, filters)` | Семантический поиск: прошлые инциденты, риски, регрессии |
| `getRelatedEntries(entryId)` | ADR и best practices, связанные с затронутыми модулями |

### 3.5 Repository Metadata

Предоставляется Workspace API.

| Запрос | Назначение |
|--------|-----------|
| `gitLog(filters)` | История коммитов — частота изменений в affected files |
| `gitBlame(filePath)` | Авторство — кто чаще всего менял файл |
| `gitDiff(from, to)` | Разница между состояниями — что уже изменилось с момента последнего Impact Report |

### 3.6 Workspace State

Предоставляется Workspace API.

| Запрос | Назначение |
|--------|-----------|
| `getProjectStructure()` | Дерево проекта для привязки affected set к файловой системе |
| `readFile(filePath)` | Текущее содержимое affected files для верификации |

### 3.7 Configuration

| Параметр | Назначение |
|----------|-----------|
| `maxTraversalDepth` | Максимальная глубина траверса зависимостей |
| `riskThresholds` | Пороги для классификации рисков (low/medium/high/critical) |
| `blastRadiusThresholds` | Пороги для классификации масштаба влияния |
| `confidenceThresholds` | Минимально допустимый confidence для продолжения |
| `conflictDetectionRules` | Правила определения конфликтов |
| `validationScopeRules` | Правила формирования validation scope |

### 3.8 Active Tasks / Project State

Предоставляется API Gateway и Execution Engine.

| Источник | Данные |
|----------|--------|
| `API Gateway: listActiveTasks()` | Список активных задач с их affected sets |
| `Execution Engine: getActiveExecutions()` | Текущие выполнения и их планы |
| `Graph: getActiveTaskBindings()` | Связи задач с узлами графа |

### 3.9 Historical Impact Reports

Предоставляется Knowledge API.

| Запрос | Назначение |
|--------|-----------|
| `searchByEntity(entityId, type=ImpactReport)` | Прошлые Impact Reports для тех же сущностей |
| `searchSemantic(query, type=ImpactReport)` | Семантически близкие Impact Reports |

### 3.10 Diagnostics

| Источник | Данные |
|----------|--------|
| `Graph: getDiagnostics()` | Диагностика Graph: degraded scopes, validation failures |
| `Indexer: getIndexManifest()` | Статус индексации: устаревшие файлы, parser failures |
| `Workspace: getDiagnostics()` | Состояние workspace: конфликты, блокировки |

---

## 4. Выходные данные

### 4.1 Impact Report (главный результат)

Полная структура описана в разделе [17. Impact Report](#17-impact-report). Кратко:

**Impact Report** — это структурированный документ, содержащий:

- **Summary** — краткое резюме анализа
- **Change Intent** — нормализованное описание изменения
- **Starting Entities** — узлы Graph, которые будут изменены напрямую
- **Affected Entities** — полное множество затронутых узлов
- **Dependency Paths** — пути распространения влияния
- **Blast Radius** — классификация масштаба влияния
- **Risks** — risk markers по всем классам риска
- **Conflicts** — обнаруженные конфликты
- **Validation Scope** — что нужно проверить после изменения
- **Unknowns** — неопределённости и пробелы
- **Confidence** — оценка уверенности
- **Source References** — ссылки на источники
- **Version Metadata** — версионирование

### 4.2 Risk Markers

Risk Marker — это атомарная запись об одном риске:

| Поле | Тип | Описание |
|------|-----|----------|
| `markerId` | UUID | Уникальный идентификатор |
| `riskType` | enum | Тип риска (architectural, regression, integration, schema, concurrency, hidden-dependency, security, performance) |
| `severity` | enum | Серьёзность (low, medium, high, critical) |
| `source` | Reference | Источник риска: узел графа, отношение, файл |
| `description` | string | Человеко-читаемое описание |
| `evidence` | Evidence[] | Доказательства: traversal path, historical incident, ADR |
| `mitigation` | string | Рекомендация по снижению риска |
| `confidence` | float | Уверенность в оценке (0.0–1.0) |

### 4.3 Affected Entities

Affected Entity — запись об одном затронутом узле:

| Поле | Тип | Описание |
|------|-----|----------|
| `nodeId` | NodeId | Идентификатор узла в Graph |
| `nodeType` | NodeType | Тип узла (class, function, file, module, table, route, ...) |
| `affectionType` | enum | `direct` (изменяется напрямую) или `indirect` (затронут через зависимости) |
| `distance` | integer | Расстояние от ближайшей starting entity (0 = starting entity) |
| `dependencyPath` | Path | Кратчайший путь зависимости от starting entity |
| `riskLevel` | enum | Уровень риска для этого узла |
| `reason` | string | Почему узел считается затронутым |

### 4.4 Dependency Expansion Results

Результаты обхода зависимостей:

| Поле | Тип | Описание |
|------|-----|----------|
| `directDependencies` | NodeId[] | Прямые зависимости starting entities |
| `directDependents` | NodeId[] | Обратные зависимости: кто зависит от starting entities |
| `transitiveClosure` | NodeId[] | Полное транзитивное замыкание |
| `expansionDepth` | integer | Достигнутая глубина траверса |
| `stoppedEarly` | boolean | Был ли траверс остановлен до исчерпания |
| `stopReason` | string | Причина остановки (maxDepth, timeout, cycle) |

### 4.5 Conflict Markers

| Поле | Тип | Описание |
|------|-----|----------|
| `conflictId` | UUID | Уникальный идентификатор |
| `conflictType` | enum | Тип конфликта (file, symbol, module, migration, infrastructure, plan-state) |
| `conflictingTaskId` | TaskId | Задача, с которой обнаружен конфликт |
| `sharedEntity` | NodeId | Общая затронутая сущность |
| `description` | string | Описание конфликта |
| `severity` | enum | Серьёзность |
| `resolutionHint` | string | Рекомендация по разрешению |

### 4.6 Validation Recommendations

| Поле | Тип | Описание |
|------|-----|----------|
| `recommendationId` | UUID | Уникальный идентификатор |
| `type` | enum | Тип проверки (test, manual, integration, performance, security, migration) |
| `scope` | ScopeSpec | Область проверки: узлы, файлы, модули |
| `priority` | enum | Приоритет проверки |
| `estimatedEffort` | string | Оценка трудозатрат |
| `reason` | string | Обоснование |

### 4.7 Suggested Verification Scope

Обобщённая структура того, что требует проверки:

| Категория | Содержание |
|-----------|-----------|
| **Tests** | Список тестовых файлов/сьютов, которые должны быть запущены |
| **Modules** | Модули, требующие верификации после изменения |
| **API Endpoints** | API-маршруты, которые могут быть затронуты |
| **Database** | Таблицы, схемы, миграции |
| **Documentation** | ADR и документы, требующие обновления |
| **Configuration** | Конфигурационные файлы, переменные окружения |

---

## 5. Архитектура модуля

```
Impact Analysis Engine
│
├── Impact Coordinator          — оркестратор: управляет pipeline, принимает решения о ветвлении
│
├── Change Intent Interpreter    — преобразует UserIntent + Research Report в нормализованный Change Intent
│   ├── Intent Normalizer        — нормализация описания задачи
│   ├── Entity Extractor         — извлечение starting entities из Research Report
│   └── Ambiguity Resolver       — разрешение неоднозначностей (с эскалацией)
│
├── Scope Resolver               — определяет границы анализа (какие модули, файлы, типы узлов)
│   ├── Scope Normalizer         — приведение scope-ограничений к формату Graph
│   └── Scope Validator          — проверка корректности scope
│
├── Dependency Traversal Engine  — обходит Graph для построения affected set
│   ├── Direct Dependency Walker — прямые зависимости от starting entities
│   ├── Reverse Dependency Walker— обратные зависимости ("кто зависит от X")
│   ├── Transitive Closure Builder— построение транзитивного замыкания
│   ├── Ownership Chain Walker   — обход цепочек владения
│   ├── Inheritance Chain Walker — обход иерархий наследования
│   ├── Import Chain Walker      — обход цепочек импортов
│   ├── Call Chain Walker        — обход call graphs
│   ├── Schema Dependency Walker — обход зависимостей схем данных
│   ├── Route Propagation Walker — обход маршрутов API
│   └── Cycle Detector           — обнаружение циклов в affected set
│
├── Risk Evaluator               — оценивает риски на основе affected set
│   ├── Architectural Risk Analyzer
│   ├── Regression Risk Analyzer
│   ├── Integration Risk Analyzer
│   ├── Schema Risk Analyzer
│   ├── Concurrency Risk Analyzer
│   ├── Hidden Dependency Analyzer
│   ├── Security Risk Analyzer
│   └── Performance Risk Analyzer
│
├── Conflict Detector            — ищет конфликты с активными задачами
│   ├── File Conflict Analyzer
│   ├── Symbol Conflict Analyzer
│   ├── Module Conflict Analyzer
│   ├── Migration Conflict Analyzer
│   ├── Infrastructure Conflict Analyzer
│   └── Plan-State Conflict Analyzer
│
├── Blast Radius Estimator       — классифицирует масштаб влияния
│   ├── Depth Estimator          — оценка глубины распространения
│   ├── Width Estimator          — оценка ширины распространения
│   ├── Critical Node Identifier — выделение критических узлов
│   └── Scale Classifier         — классификация: small / medium / large / critical
│
├── Validation Scope Builder     — формирует рекомендации по проверке
│   ├── Test Scope Builder       — определение затронутых тестов
│   ├── Module Verification Builder— модули, требующие верификации
│   ├── API Verification Builder — API-маршруты для проверки
│   ├── Schema Verification Builder— схемы для проверки
│   └── Documentation Scope Builder— документы для обновления
│
├── Historical Correlator        — сопоставляет текущий анализ с историческими
│   ├── Past Impact Report Matcher
│   ├── Regression Pattern Detector
│   ├── Risk Hotspot Detector
│   └── Knowledge Conflict Resolver
│
├── Confidence Estimator         — оценивает уверенность анализа
│   ├── Completeness Checker
│   ├── Source Quality Evaluator
│   ├── Ambiguity Quantifier
│   └── Confidence Aggregator
│
├── Report Builder               — собирает Impact Report
│   ├── Summary Generator
│   ├── Section Compiler
│   └── Format Validator
│
├── Version Manager              — управляет версионированием
│   ├── Version Binder           — привязка к graph version, commit hash
│   ├── Reuse Decider            — определение возможности переиспользования
│   └── Invalidation Manager     — управление устареванием
│
└── Diagnostics and Statistics Manager— собирает диагностику и статистику
    ├── Degradation Detector
    ├── Performance Collector
    └── Quality Reporter
```

---

## 6. Типы анализа влияния

### 6.1 Structural Impact

**Что анализируется:** структурные связи между сущностями кода.

**Типы связей:**
- `CONTAINS` — класс содержит метод, модуль содержит класс
- `INHERITS` — наследование
- `IMPLEMENTS` — реализация интерфейса
- `OWNS` — владение (модуль владеет файлом)

**Результат:** множество структурно-зависимых узлов, которые могут потребовать изменений при модификации starting entities (например, изменение сигнатуры метода в базовом классе затрагивает всех наследников).

### 6.2 Symbol Impact

**Что анализируется:** использование символов (переменных, функций, классов, типов).

**Типы связей:**
- `REFERENCES` — ссылка на символ
- `CALLS` — вызов функции/метода
- `IMPORTS` — импорт символа
- `USES_TYPE` — использование типа
- `INSTANTIATES` — создание экземпляра

**Результат:** множество узлов, которые используют изменяемый символ и могут потребовать обновления (например, переименование переменной затрагивает все места её использования).

### 6.3 File Impact

**Что анализируется:** файлы, которые будут затронуты изменением.

**Связи:**
- `CONTAINS` — файл содержит символы
- `IMPORTS` — файл импортирует из другого файла
- `DEPENDS_ON` — файл зависит от другого файла

**Результат:** список файлов, которые потребуется модифицировать, и файлов, которые могут быть косвенно затронуты (например, изменение экспорта в файле A затрагивает все файлы, импортирующие этот экспорт).

### 6.4 Module Impact

**Что анализируется:** уровень модулей и bounded contexts.

**Связи:**
- `DEPENDS_ON` — модуль зависит от другого модуля
- `IMPORTS_FROM` — модуль импортирует из другого модуля
- `OWNS` — модуль владеет сущностями

**Результат:** список модулей, затронутых изменением, и оценка нарушения модульных границ (например, изменение в модуле A требует изменений в модуле B — проверка на нарушение архитектурных правил).

### 6.5 API Impact

**Что анализируется:** API-контракты — публичные интерфейсы, маршруты, endpoints.

**Связи:**
- `EXPOSES` — модуль/класс предоставляет API
- `CALLS` — вызов API-метода
- `DEPENDS_ON` — клиент зависит от API
- `ROUTES_TO` — маршрут ведёт к обработчику

**Результат:** список API-контрактов, которые могут быть нарушены изменением, и клиентов, которых это затронет.

### 6.6 Schema Impact

**Что анализируется:** схемы данных — таблицы, колонки, миграции.

**Связи:**
- `REFERENCES` — внешний ключ
- `READS` / `WRITES` — сущность читает/пишет данные
- `MIGRATES` — миграция изменяет схему
- `DEPENDS_ON` — таблица зависит от другой таблицы

**Результат:** список таблиц и колонок, которые будут затронуты, и миграций, которые могут конфликтовать.

### 6.7 Runtime-adjacent Impact

**Что анализируется:** компоненты, которые не связаны статически, но взаимодействуют во время выполнения.

**Связи:**
- `CONFIGURES` — конфигурация связывает компоненты
- `EVENT_SUBSCRIBES` — подписка на события
- `QUEUE_PRODUCES` / `QUEUE_CONSUMES` — очереди сообщений
- `SCHEDULES` — планировщик задач

**Результат:** runtime-зависимости, которые не видны на уровне статического анализа, но могут быть нарушены изменением.

### 6.8 Test Impact

**Что анализируется:** тесты, которые могут быть затронуты изменением.

**Связи:**
- `TESTS` — тест проверяет сущность
- `COVERS` — тест покрывает файл/модуль
- `IMPORTS` — тест импортирует изменяемый код

**Результат:** список тестов, которые должны быть запущены после изменения, с оценкой вероятности падения.

### 6.9 Documentation Impact

**Что анализируется:** документы, ADR, спецификации, которые могут устареть после изменения.

**Связи:**
- `DESCRIBES` — документ описывает сущность
- `RELATES_TO` — документ относится к модулю
- `REFERENCES` — документ ссылается на сущность

**Результат:** список документов и ADR, которые могут потребовать обновления.

### 6.10 Configuration Impact

**Что анализируется:** конфигурационные файлы, переменные окружения, feature flags.

**Связи:**
- `CONFIGURES` — конфигурация управляет компонентом
- `DEPENDS_ON` — компонент зависит от конфигурации

**Результат:** список конфигурационных параметров, которые могут быть затронуты.

### 6.11 Cross-task Conflict Impact

**Что анализируется:** пересечения с другими активными задачами.

**Связи:**
- `AFFECTS_SAME` — две задачи затрагивают одну и ту же сущность
- `DEPENDS_ON_SAME` — две задачи зависят от одного компонента
- `BLOCKS` — одна задача блокирует другую

**Результат:** список конфликтов между текущей задачей и другими активными задачами.

---

## 7. Полный Pipeline

```
                           ┌─────────────────────┐
                           │  ResearchCompleted   │
                           │  (событие)           │
                           └──────────┬──────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      IMPACT ANALYSIS PIPELINE                       │
│                                                                     │
│  ┌───────────────────────┐                                          │
│  │ 1. Request Reception  │  Получение Research Report,              │
│  │    & Validation       │  валидация входных данных                │
│  └───────────┬───────────┘                                          │
│              │                                                       │
│              ▼                                                       │
│  ┌───────────────────────┐                                          │
│  │ 2. Change Intent      │  Нормализация: что именно                │
│  │    Normalization      │  предполагается изменить                 │
│  └───────────┬───────────┘                                          │
│              │                                                       │
│              ▼                                                       │
│  ┌───────────────────────┐                                          │
│  │ 3. Starting Entities  │  Привязка change intent                  │
│  │    Resolution         │  к конкретным узлам Graph                │
│  └───────────┬───────────┘                                          │
│              │                                                       │
│              ├── starting entities не определены ──► Эскалация      │
│              │                                       (возврат в      │
│              │                                       Research)       │
│              ▼                                                       │
│  ┌───────────────────────┐                                          │
│  │ 4. Scope Definition   │  Определение границ анализа:             │
│  │                       │  модули, файлы, типы узлов               │
│  └───────────┬───────────┘                                          │
│              │                                                       │
│              ▼                                                       │
│  ┌───────────────────────┐                                          │
│  │ 5. Dependency         │  Траверс Graph:                          │
│  │    Traversal          │  - прямые зависимости                    │
│  │                       │  - обратные зависимости                  │
│  │                       │  - транзитивное замыкание                │
│  │                       │  - ownership chains                      │
│  │                       │  - inheritance chains                    │
│  │                       │  - import chains                         │
│  │                       │  - call chains                           │
│  │                       │  - schema dependencies                   │
│  │                       │  - route propagation                     │
│  └───────────┬───────────┘                                          │
│              │                                                       │
│              ▼                                                       │
│  ┌───────────────────────┐                                          │
│  │ 6. Affected Set       │  Построение полного                      │
│  │    Construction       │  множества затронутых узлов              │
│  └───────────┬───────────┘                                          │
│              │                                                       │
│              ▼                                                       │
│  ┌───────────────────────┐                                          │
│  │ 7. Blast Radius       │  Классификация масштаба:                 │
│  │    Estimation         │  - глубина                              │
│  │                       │  - ширина                              │
│  │                       │  - критические узлы                     │
│  └───────────┬───────────┘                                          │
│              │                                                       │
│              ▼                                                       │
│  ┌───────────────────────┐                                          │
│  │ 8. Risk Evaluation    │  Оценка рисков:                          │
│  │                       │  - архитектурные                        │
│  │                       │  - регрессионные                        │
│  │                       │  - интеграционные                       │
│  │                       │  - schema                               │
│  │                       │  - concurrency                          │
│  │                       │  - hidden dependencies                  │
│  └───────────┬───────────┘                                          │
│              │                                                       │
│              ▼                                                       │
│  ┌───────────────────────┐                                          │
│  │ 9. Conflict           │  Поиск конфликтов:                       │
│  │    Detection          │  - с активными задачами                  │
│  │                       │  - по файлам                            │
│  │                       │  - по символам                         │
│  │                       │  - по модулям                          │
│  │                       │  - по миграциям                        │
│  └───────────┬───────────┘                                          │
│              │                                                       │
│              ▼                                                       │
│  ┌───────────────────────┐                                          │
│  │ 10. Validation Scope  │  Определение:                            │
│  │     Construction      │  - затронутых тестов                     │
│  │                       │  - модулей для верификации               │
│  │                       │  - API для проверки                      │
│  │                       │  - документов для обновления             │
│  └───────────┬───────────┘                                          │
│              │                                                       │
│              ▼                                                       │
│  ┌───────────────────────┐                                          │
│  │ 11. Historical        │  Корреляция с прошлыми                   │
│  │     Correlation       │  Impact Reports, инцидентами,            │
│  │                       │  известными рисками                      │
│  └───────────┬───────────┘                                          │
│              │                                                       │
│              ▼                                                       │
│  ┌───────────────────────┐                                          │
│  │ 12. Confidence        │  Оценка уверенности:                     │
│  │     Estimation        │  - полнота данных                        │
│  │                       │  - качество источников                   │
│  │                       │  - уровень неопределённости              │
│  └───────────┬───────────┘                                          │
│              │                                                       │
│              ├── confidence ниже порога ──► Эскалация               │
│              │                              (возврат в Research     │
│              │                              или запрос              │
│              │                              переиндексации)          │
│              ▼                                                       │
│  ┌───────────────────────┐                                          │
│  │ 13. Report Assembly   │  Сборка финального                       │
│  │     & Versioning      │  Impact Report с версионированием        │
│  └───────────┬───────────┘                                          │
│              │                                                       │
│              ▼                                                       │
│  ┌───────────────────────┐                                          │
│  │ 14. Publication       │  Публикация Impact Report                │
│  │                       │  через событие                           │
│  │                       │  ImpactAnalysisCompleted                 │
│  └───────────────────────┘                                          │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### Шаг 1: Request Reception & Validation

- Получение Research Report из события `ResearchCompleted`.
- Извлечение UserIntent (taskId, description, constraints, scope).
- Валидация: проверка, что Research Report не пуст, содержит `foundEntities`, имеет `completeness > 0`.
- Проверка доступности Graph: запрос `getCurrentVersion()`.
- Проверка актуальности Graph Version относительно Research Report.
- Если входные данные недостаточны — запрос дополнительного исследования (событие `ResearchRequested`).

### Шаг 2: Change Intent Normalization

- Извлечение из Research Report информации о том, *что* предполагается изменить.
- Нормализация: приведение разрозненных описаний (entity refs, file refs, module refs, символов) к единому формату Change Intent.
- Выделение: какие сущности изменяются (modify), какие добавляются (add), какие удаляются (remove).
- Если change intent неоднозначен — фиксация ambiguity, переход к шагу 3 с пометкой "ambiguous".

### Шаг 3: Starting Entities Resolution

- Для каждой сущности из Change Intent — поиск соответствующего узла в Graph.
- Верификация: существует ли узел, активен ли он в текущей версии графа.
- Если узел не найден — попытка разрешения через Research (file refs, symbol names).
- Если starting entities не удаётся определить однозначно — эскалация: возврат в Research с запросом уточнения.
- Формирование списка `startingEntities` с confidence для каждой.

### Шаг 4: Scope Definition

- На основе constraints задачи, Research Report и starting entities определение границ анализа.
- Какие модули анализировать (только затронутые, все зависимые, весь проект).
- Какие типы узлов включать (все, только structural, только API, без тестов).
- Максимальная глубина траверса.
- Если scope невозможно определить однозначно — используется conservative scope (шире).

### Шаг 5: Dependency Traversal

Детально в разделе [12. Dependency Traversal](#12-dependency-traversal).

- Обход прямых зависимостей: от starting entities → к тем, от кого они зависят.
- Обход обратных зависимостей: от starting entities → к тем, кто зависит от них.
- Построение транзитивного замыкания: итеративный обход до исчерпания или достижения maxDepth.
- Обход ownership chains: кто владеет starting entities, кем владеют starting entities.
- Обход inheritance chains: родители, наследники, реализуемые интерфейсы.
- Обход import chains: что импортирует, кто импортирует.
- Обход call chains: кто вызывает, кого вызывает.
- Обход schema dependencies: внешние ключи, миграции.
- Обход route propagation: API-маршруты.
- Обнаружение циклов в affected set.

### Шаг 6: Affected Set Construction

- Объединение результатов всех traversal walkers.
- Дедупликация (один узел может быть достигнут разными путями).
- Классификация каждого узла: `direct` (starting entity), `indirect` (через зависимости).
- Расчёт distance от ближайшей starting entity.
- Сохранение dependency path для каждого indirect узла.

### Шаг 7: Blast Radius Estimation

Детально в разделе [13. Blast Radius](#13-blast-radius).

- Подсчёт глубины: максимальное distance в affected set.
- Подсчёт ширины: количество узлов на каждом уровне distance.
- Выделение критических узлов: узлы с наибольшим количеством dependents, узлы на архитектурных границах.
- Классификация: small / medium / large / critical.

### Шаг 8: Risk Evaluation

Детально в разделе [14. Risk Analysis](#14-risk-analysis).

- Для каждого узла affected set и каждого типа риска — проверка критериев.
- Если критерий выполняется — создание risk marker.
- Агрегация risk markers, устранение дубликатов.
- Классификация severity.

### Шаг 9: Conflict Detection

Детально в разделе [15. Conflict Detection](#15-conflict-detection).

- Получение списка активных задач (API Gateway).
- Для каждой активной задачи — получение её affected set (из её Impact Report).
- Пересечение текущего affected set с affected sets активных задач.
- Проверка конфликтов по файлам, символам, модулям, миграциям.
- Проверка конфликтов plan-state (текущее состояние workspace vs план).

### Шаг 10: Validation Scope Construction

Детально в разделе [16. Validation Scope](#16-validation-scope).

- Поиск тестов, связанных с узлами affected set (через `TESTS` edges).
- Определение модулей, требующих верификации.
- Определение API endpoints для проверки.
- Определение схем данных для проверки.
- Определение документов для обновления.

### Шаг 11: Historical Correlation

Детально в разделе [11. Использование Knowledge](#11-использование-knowledge).

- Поиск прошлых Impact Reports для тех же сущностей.
- Поиск известных risk hotspots.
- Поиск регрессионных паттернов.
- Если исторические данные противоречат текущему анализу — фиксация расхождения.

### Шаг 12: Confidence Estimation

Детально в разделе [18. Confidence Model](#18-confidence-model).

- Оценка полноты входных данных.
- Оценка качества Graph (validation status, degraded scopes).
- Оценка определённости starting entities.
- Оценка покрытия traversal.
- Агрегация в общий confidence score.

### Шаг 13: Report Assembly & Versioning

- Сборка всех разделов Impact Report.
- Привязка версий: graph version, commit hash, research id, timestamp.
- Валидация структуры отчёта.

### Шаг 14: Publication

- Публикация события `ImpactAnalysisCompleted` с Impact Report.
- Сохранение Impact Report в Knowledge.
- Если confidence ниже порога — публикация с явным предупреждением.

---

## 8. Определение starting point изменения

### Как модуль понимает, что именно предполагается изменить

Impact Analysis Engine не интерпретирует пользовательский запрос самостоятельно. Он получает уже обработанный Research Report, который содержит:

- **foundEntities** — список сущностей, которые Research определил как релевантные задаче.
- **sourceReferences** — ссылки на конкретные файлы, строки, символы.
- **recommendations** — рекомендуемые области изменения.
- **warnings** — предупреждения о потенциальных проблемных областях.

Change Intent Interpreter извлекает из Research Report все упоминания сущностей и формирует **нормализованный Change Intent**:

```
Change Intent = {
    taskId,
    description (нормализованное),
    proposedChanges: [
        {
            type: MODIFY | ADD | REMOVE,
            target: EntityRef,     // ссылка на сущность из Research
            confidence: float,     // насколько Research уверен, что эта сущность будет изменена
            reason: string         // почему Research считает, что это starting point
        }
    ],
    ambiguities: [
        {
            description: string,   // что неясно
            candidates: EntityRef[] // возможные варианты
        }
    ]
}
```

### Как извлекаются starting nodes из Research Report

Для каждого `EntityRef` из Change Intent выполняется:

1. **Поиск в Graph по идентификатору** (если Research предоставил явный nodeId).
2. **Поиск по FQN** (fully qualified name) — если Research указал имя класса/функции.
3. **Поиск по file + symbol** — если Research указал файл и символ внутри него.
4. **Поиск по module + role** — если Research указал модуль и роль сущности.
5. **Семантический поиск** — если явные идентификаторы отсутствуют, используется семантическое сопоставление описания с узлами Graph.

Результат: для каждого proposed change — один или несколько узлов Graph, которые являются starting entities.

### Как трактуются ambiguous change requests

Если Change Intent содержит ambiguities (неоднозначности), возможны сценарии:

**Сценарий A: Неоднозначность разрешима локально.**
- Impact Analysis выбирает все candidate entities как starting points.
- В Impact Report явно указывается, что starting set расширен из-за неоднозначности.
- Confidence снижается пропорционально количеству кандидатов.

**Сценарий B: Неоднозначность существенна.**
- Impact Analysis Engine не может определить, *какие именно* сущности будут изменены.
- Pipeline приостанавливается на шаге 3.
- Публикуется событие `ResearchRequested` с запросом уточнения.
- Impact Report не формируется до разрешения.

**Сценарий C: Консервативный анализ.**
- Если конфигурация разрешает консервативный режим, в starting entities включаются все candidate entities.
- Impact Report помечается как `conservative` (расширенный starting set).
- Confidence снижается.

### Как поступать, если starting entities не удаётся определить точно

**Приоритетный порядок действий:**

1. **Запросить уточнение у Research.** Если Research не смог определить starting entities — возврат с запросом дополнительного исследования.
2. **Расширить starting set.** Если неясно, какая из нескольких сущностей является точкой изменения — включить все, пометить как ambiguous.
3. **Использовать Knowledge.** Проверить, были ли аналогичные задачи в прошлом и какие сущности они затрагивали.
4. **Эскалировать.** Если ни один из подходов не даёт acceptable confidence — остановить pipeline, опубликовать `ImpactAnalysisFailed` с указанием причины.

**Критическое правило:** Impact Analysis Engine никогда не должен угадывать starting entities. Если starting entities не определены с acceptable confidence, он обязан отказаться от продолжения и сообщить об этом.

---

## 9. Использование Graph

### Какие graph queries использует Impact Analysis

Impact Analysis Engine является интенсивным потребителем Graph API. Он не имеет прямого доступа к Neo4j — все запросы выполняются через Graph API.

**Основные классы запросов:**

#### Node Lookup (шаг 3: Starting Entities Resolution)
```
Graph.getNode(nodeId)
Graph.getNodesByType(type, filters)
```

#### Dependency Lookup (шаг 5: Dependency Traversal)
```
Graph.getDependencies(nodeId, depth)     // прямые зависимости
Graph.getDependents(nodeId, depth)       // обратные зависимости
```

#### Subgraph Extraction (шаг 6: Affected Set)
```
Graph.getAffectedSubgraph(nodeIds[])     // affected subgraph
Graph.getModuleStructure(moduleId)       // структура модуля
```

#### Path Finding (шаг 5: анализ путей)
```
Graph.findPaths(sourceId, targetId)      // пути между узлами
```

#### Cycle Detection (шаг 5: обнаружение циклов)
```
Graph.findCycles(scope?)                 // циклы в affected set
```

#### General Query (для нестандартных запросов)
```
Graph.queryGraph(query: GraphQuery)      // произвольный запрос
```

### Какие связи обходятся

При траверсе Impact Analysis Engine проходит по всем типам рёбер, определённым в Graph:

| Тип связи | Направление траверса | Что даёт |
|-----------|---------------------|----------|
| `CONTAINS` | В обе стороны | Структурные родители и дети |
| `INHERITS` | В обе стороны | Родители и наследники |
| `IMPLEMENTS` | В обе стороны | Интерфейсы и реализации |
| `IMPORTS` | В обе стороны | Что импортирует, кто импортирует |
| `CALLS` | В обе стороны | Вызовы и вызывающие |
| `REFERENCES` | В обе стороны | Ссылки на символ и ссылающиеся |
| `DEPENDS_ON` | В обе стороны | Общие зависимости |
| `OWNS` | В обе стороны | Владельцы и owned entities |
| `EXPOSES` | От источника | Кто предоставляет API |
| `TESTS` | От источника | Какие тесты проверяют |
| `MIGRATES` | В обе стороны | Миграции и связанные таблицы |
| `RELATES_TO` | В обе стороны | Связи с Knowledge, ADR |

### Как строится dependency neighborhood

**Dependency Neighborhood** — это множество узлов на расстоянии 1–2 от starting entities, включающее:

1. **Прямые соседи (distance = 1):**
   - Все узлы, на которые непосредственно указывают рёбра от starting entities.
   - Все узлы, которые указывают на starting entities.

2. **Близкие соседи (distance = 2):**
   - Узлы, связанные с прямыми соседями.
   - Это нужно для выявления паттернов: например, если starting entity — класс, его методы (distance 1) и вызывающие их классы (distance 2).

3. **Структурные родители:**
   - Владеющие модули, содержащие файлы, родительские классы.

4. **Структурные дети:**
   - Методы, поля, внутренние классы, дочерние модули.

### Как считается транзитивное влияние

1. **Начало:** starting entities помещаются в очередь с distance = 0.
2. **Итерация:** для каждого узла в очереди:
   - Запрашиваются все соседи (зависимости + dependents).
   - Если сосед ещё не посещён, он добавляется с distance = текущий distance + 1.
3. **Остановка:**
   - Достигнут `maxTraversalDepth`.
   - Очередь пуста (все достижимые узлы посещены).
   - Достигнут лимит времени (`traversalTimeout`).
4. **Результат:** множество `affectedNodes` с distance и dependency path.

### Какие ограничения есть у Graph как источника

1. **Graph может быть неполным.** Если индексация не завершена или есть parser failures, часть узлов может отсутствовать. Impact Analysis должен проверять Graph diagnostics перед началом траверса.
2. **Graph содержит статические связи.** Runtime-зависимости (event bus, dependency injection, dynamic imports) могут отсутствовать. Impact Analysis должен учитывать это в confidence.
3. **Graph версионирован.** Impact Analysis должен использовать актуальную версию графа, соответствующую текущему состоянию workspace.
4. **Graph не содержит внешних зависимостей.** Зависимости от внешних пакетов (npm, composer) могут быть представлены ограниченно.
5. **Graph не оценивает важность связей.** Все рёбра равнозначны с точки зрения Graph. Impact Analysis должен самостоятельно интерпретировать значимость связей (например, `CALLS` между модулями разного уровня важнее, чем `REFERENCES` внутри одного файла).
6. **Graph не знает о задачах.** Graph не имеет понятия "активная задача" или "планируемое изменение". Impact Analysis должен самостоятельно сопоставлять affected set с другими задачами.

---

## 10. Использование Research

### Как Research Report направляет анализ

Research Report предоставляет контекст, который управляет границами и фокусом анализа:

#### Findings (найденные сущности)
- Определяют starting entities (см. раздел 8).
- Сужают scope: если Research нашёл релевантные сущности только в модулях A и B, анализ не должен без необходимости расширяться на модуль C.

#### Evidence (доказательства)
- Подтверждают или опровергают гипотезы о starting entities.
- Если Research предоставил сильные evidence (например, точные ссылки на строки кода), starting entities resolution получает высокий confidence.
- Если evidence слабые — confidence снижается.

#### Affected Modules (определённые Research)
- Задают границы scope: анализ должен как минимум покрыть модули, указанные Research.
- Если Impact Analysis обнаруживает, что изменение затрагивает модули за пределами указанных Research — это фиксируется как расхождение и может быть признаком неполноты Research.

#### Unknowns (неотвеченные вопросы Research)
- Каждый unanswered question из Research Report — потенциальный источник неопределённости.
- Impact Analysis должен проверить, затрагивает ли неизвестное область анализа.
- Если да — confidence снижается, unknown переносится в Impact Report.

#### Confidence (оценка полноты Research)
- `researchReport.completeness` непосредственно влияет на `impactReport.confidence`.
- Если Research completeness ниже порога — Impact Analysis может запросить дополнительное исследование.

### Когда Research недостаточен и нужен возврат

**Критерии недостаточности Research:**

1. **Не удаётся определить starting entities** (см. раздел 8).
2. **Research completeness < минимального порога** (конфигурируется).
3. **Research не покрывает модули, которые Impact Analysis определил как критические.**
4. **Unanswered questions Research прямо относятся к affected entities.**
5. **Research Report противоречит текущему состоянию Graph** (например, Research ссылается на удалённый узел).

**Действия при недостаточности:**

1. Публикация события `ResearchRequested` с указанием:
   - Какие вопросы требуют уточнения.
   - Какие сущности не удалось разрешить.
   - Какие модули требуют дополнительного исследования.
2. Если конфигурация разрешает — формирование partial Impact Report с пометкой `insufficient_research`.
3. Если конфигурация требует полный Research — остановка pipeline.

---

## 11. Использование Knowledge

### Как используются прошлые Impact Reports

Исторические Impact Reports — один из ключевых источников для Historical Correlator:

1. **Поиск по сущностям:** для каждой starting entity запрашиваются прошлые Impact Reports, в которых эта сущность фигурировала.
2. **Сопоставление affected sets:** сравнение текущего affected set с прошлыми для тех же сущностей — выявление расхождений.
3. **Оценка стабильности:** если сущность часто фигурирует в Impact Reports с высоким риском — это индикатор risk hotspot.
4. **Извлечение паттернов:** если прошлые задачи с аналогичным affected set приводили к проблемам — повышение риска.

### Как используются Execution Reports

1. **Анализ исходов:** если прошлые изменения тех же сущностей приводили к регрессиям, ошибкам, откатам — это источник регрессионного риска.
2. **Сложность:** если прошлые изменения были сложными (много шагов, долгое выполнение) — повышение complexity estimate.
3. **Неудачные попытки:** если были rollbacks или failed executions для тех же сущностей — critical risk marker.

### Как используются ADR

1. **Архитектурные ограничения:** если ADR устанавливает правила для затрагиваемого модуля (например, "модуль A не должен зависеть от модуля B") — проверка, не нарушает ли изменение эти правила.
2. **История решений:** почему модуль был спроектирован именно так — может объяснить неочевидные зависимости.
3. **Migration guides:** если ADR содержит инструкции по миграции — они могут быть включены в Validation Scope.

### Как используются historical incidents

1. **Известные проблемные области:** если Knowledge содержит записи об инцидентах, связанных с affected entities — повышение риска.
2. **Регрессионные паттерны:** если определённый тип изменения регулярно вызывает проблемы (например, изменение схемы БД) — формирование специфического risk marker.
3. **Частота изменений:** если сущность часто фигурирует в инцидентах — пометка как risk hotspot.

### Как используются known risky areas

1. **Risk hotspots:** Knowledge может содержать явные пометки "high risk area" для определённых модулей или файлов.
2. **Границы bounded contexts:** изменения на границах модулей автоматически получают architectural risk marker.
3. **Shared infrastructure:** изменения в shared модулях (общие библиотеки, утилиты) автоматически получают широкий blast radius.

### Как используются recurring regressions

1. **Поиск паттернов:** если Knowledge содержит записи вида "изменение X в модуле Y приводит к регрессии Z" — автоматическое создание risk marker при обнаружении аналогичного изменения.
2. **Предиктивная аналитика:** если текущий affected set похож на affected set прошлой задачи, которая привела к регрессии — повышение regression risk.

### Как оценивается актуальность исторических данных

1. **Возраст:** данные старше N версий графа или старше M дней получают пониженный вес.
2. **Версия графа:** если исторический Impact Report был создан для другой версии графа, его применимость ограничена.
3. **Изменения сущности:** если сущность была существенно изменена с момента прошлого Impact Report, исторические данные могут быть неактуальны.
4. **Размер расхождения:** если текущий affected set существенно отличается от исторического, доверие к историческим данным снижается.

### Как разрешаются противоречия между current Graph и historical Knowledge

1. **Graph — канонический источник структурной истины.** Если Graph говорит, что зависимость существует, а исторический Impact Report утверждает обратное — приоритет у Graph.
2. **Knowledge — источник контекстной истины.** Если Knowledge говорит, что изменение в этом месте опасно, но Graph показывает простую структуру — приоритет у Knowledge (исторический опыт).
3. **Явное документирование противоречия.** Все расхождения между Graph и Knowledge фиксируются в Impact Report с объяснением и влиянием на confidence.
4. **Эскалация при критических противоречиях.** Если расхождение существенно влияет на анализ — запрос на уточнение (ResearchRequested или ручная проверка).

---

## 12. Dependency Traversal

### Общие принципы

Dependency Traversal — это процесс обхода графа от starting entities для построения полного affected set. Impact Analysis Engine не реализует алгоритмы траверса самостоятельно — он формулирует запросы к Graph API и интерпретирует результаты.

Траверс выполняется в обоих направлениях:
- **Forward** (прямые зависимости): от starting entities к тем, от кого они зависят. "Если изменить X, что ещё потребуется изменить, потому что X от этого зависит?"
- **Backward** (обратные зависимости): от starting entities к тем, кто зависит от них. "Если изменить X, что может сломаться, потому что это зависит от X?"

### Прямые зависимости (Forward Dependencies)

**Вопрос:** "От чего зависит starting entity? Что она использует?"

**Обходимые типы рёбер:**
- `IMPORTS` → файлы/модули, которые импортируются
- `CALLS` → вызываемые функции/методы
- `REFERENCES` → используемые символы
- `INHERITS` → родительский класс
- `IMPLEMENTS` → реализуемый интерфейс
- `DEPENDS_ON` → общие зависимости
- `USES_TYPE` → используемые типы
- `READS` / `WRITES` → таблицы, колонки

**Значение для Impact Analysis:**
- Если starting entity зависит от X, и X также требуется изменить — X становится частью affected set.
- Если starting entity зависит от X, но X не требует изменения — X всё равно попадает в affected set как потенциально затронутый (изменение starting entity может потребовать адаптации использования X).

### Обратные зависимости (Backward Dependents)

**Вопрос:** "Кто зависит от starting entity? Кого затронет изменение?"

**Обходимые типы рёбер:**
- `IMPORTS` (reverse) → кто импортирует starting entity
- `CALLS` (reverse) → кто вызывает starting entity
- `REFERENCES` (reverse) → кто ссылается на starting entity
- `INHERITS` (reverse) → наследники
- `IMPLEMENTS` (reverse) → кто реализует (если starting entity — интерфейс)
- `DEPENDS_ON` (reverse) → кто зависит от starting entity
- `EXPOSES` (reverse) → кто предоставляет API (если starting entity — API-клиент)
- `TESTS` (reverse) → какие тесты проверяют starting entity

**Значение для Impact Analysis:**
Это основной источник affected set. Каждый dependent — кандидат на поломку при изменении starting entity. Чем больше dependents, тем выше blast radius и regression risk.

### Транзитивные зависимости (Transitive Closure)

**Вопрос:** "Если изменение распространяется через dependents, кто зависит от dependents?"

**Процесс:**
1. Начало: starting entities → уровень 0.
2. Уровень 1: все прямые dependents.
3. Уровень 2: все dependents уровня 1.
4. ... продолжается до maxDepth или исчерпания.

**Ограничения:**
- `maxTraversalDepth` — максимальная глубина (по умолчанию: 5 для dependents, 3 для dependencies).
- `traversalTimeout` — максимальное время траверса.
- `maxAffectedNodes` — максимальный размер affected set (защита от комбинаторного взрыва).

**Значение для Impact Analysis:**
Транзитивное замыкание показывает полную зону потенциального влияния. Даже если изменение напрямую затрагивает только один класс, транзитивно оно может затронуть десятки зависимых модулей.

### Ownership Chains

**Вопрос:** "Кто владеет starting entity? Кем владеет starting entity?"

**Обходимые типы рёбер:**
- `OWNS` (вверх) → модуль, который владеет файлом; файл, который владеет классом
- `CONTAINS` (вниз) → методы внутри класса; классы внутри файла
- `OWNS` (вниз, если starting entity — модуль) → все файлы модуля

**Значение для Impact Analysis:**
Изменение любой сущности внутри owned scope может потребовать изменений на уровне владельца (например, изменение метода может потребовать обновления документации класса).

### Inheritance Chains

**Вопрос:** "Кто является родителем? Кто является наследником?"

**Обходимые типы рёбер:**
- `INHERITS` (вверх) → родительские классы, интерфейсы
- `INHERITS` (вниз) → дочерние классы
- `IMPLEMENTS` (вверх/вниз) → интерфейсы и их реализации

**Значение для Impact Analysis:**
Изменение сигнатуры метода в базовом классе автоматически затрагивает всех наследников. Это один из главных источников regression risk.

### Import Chains

**Вопрос:** "Какие файлы импортируют starting entity? Что импортирует starting entity?"

**Обходимые типы рёбер:**
- `IMPORTS` (в обе стороны)

**Значение для Impact Analysis:**
Изменение экспорта в файле A может потребовать изменений во всех файлах, которые его импортируют. Цепочки импортов могут быть длинными — A импортирует B, B импортирует C, изменение в C затрагивает A.

### Call Chains

**Вопрос:** "Кто вызывает starting entity? Кого вызывает starting entity?"

**Обходимые типы рёбер:**
- `CALLS` (в обе стороны)

**Значение для Impact Analysis:**
Изменение сигнатуры функции затрагивает всех, кто её вызывает. Цепочки вызовов показывают, как изменение распространяется по коду во время выполнения.

### Schema Dependencies

**Вопрос:** "Какие таблицы связаны с затрагиваемыми? Какие миграции взаимодействуют?"

**Обходимые типы рёбер:**
- `REFERENCES` (foreign keys) → связанные таблицы
- `READS` / `WRITES` → кто работает с данными
- `MIGRATES` → миграции

**Значение для Impact Analysis:**
Изменение схемы таблицы может потребовать изменений в миграциях, моделях, API, тестах. Нарушение внешнего ключа — критический риск.

### Route/Component/Module Propagation

**Вопрос:** "Какие маршруты API затрагиваются? Как изменение распространяется по модулям?"

**Обходимые типы рёбер:**
- `ROUTES_TO` → обработчики маршрутов
- `EXPOSES` → API endpoints
- `DEPENDS_ON` (на уровне модулей) → межмодульные зависимости

**Значение для Impact Analysis:**
Изменение внутренней логики может затронуть API-контракты. Нарушение модульных границ — архитектурный риск.

---

## 13. Blast Radius

### Что такое blast radius

**Blast Radius** — это метрика, характеризующая масштаб и характер распространения изменений. Она отвечает не только на вопрос "сколько узлов затронуто", но и "насколько глубоко и широко распространяется влияние, какие критические компоненты задеты".

Blast Radius состоит из трёх измерений:
1. **Depth (глубина):** максимальное расстояние от starting entity до наиболее удалённого затронутого узла.
2. **Width (ширина):** количество узлов на каждом уровне глубины и общее количество затронутых узлов.
3. **Criticality (критичность):** доля критических узлов в affected set.

### Как определяется малая, средняя и высокая зона влияния

Классификация основана на комбинации depth, width и criticality.

#### Малый Blast Radius (Small)

| Параметр | Значение |
|----------|----------|
| Depth | ≤ 2 |
| Total affected nodes | ≤ 20 |
| Affected modules | 1 |
| Critical nodes | 0 |

**Характеристика:** изменение локализовано в пределах одного модуля. Не затрагивает API, схемы данных, shared компоненты. Низкий риск непредвиденных последствий.

**Примеры:** изменение внутренней реализации метода, рефакторинг приватного класса.

#### Средний Blast Radius (Medium)

| Параметр | Значение |
|----------|----------|
| Depth | 3–5 |
| Total affected nodes | 21–100 |
| Affected modules | 2–5 |
| Critical nodes | ≤ 2 |

**Характеристика:** изменение затрагивает несколько модулей. Может потребовать изменений в API или схеме данных. Умеренный риск непредвиденных последствий.

**Примеры:** изменение публичного API класса, используемого в нескольких модулях; добавление поля в таблицу БД.

#### Высокий Blast Radius (High)

| Параметр | Значение |
|----------|----------|
| Depth | 6+ |
| Total affected nodes | 101–500 |
| Affected modules | 6+ |
| Critical nodes | 3+ |

**Характеристика:** изменение затрагивает значительную часть системы. Требует координации между командами. Высокий риск каскадных сбоев.

**Примеры:** изменение сигнатуры базового класса с сотнями наследников; миграция схемы данных с внешними ключами.

#### Критический Blast Radius (Critical)

| Параметр | Значение |
|----------|----------|
| Depth | Не ограничено (включая транзитивное замыкание всей системы) |
| Total affected nodes | 500+ |
| Affected modules | Большинство модулей проекта |
| Critical nodes | Много |

**Характеристика:** изменение затрагивает практически всю систему. Требует архитектурного решения. Максимальный риск.

**Примеры:** изменение core-абстракции, используемой всей системой; изменение протокола взаимодействия между всеми сервисами.

### Как оценивается глубина и ширина распространения изменения

**Глубина (depth):**
- Вычисляется как максимальное `distance` среди всех узлов affected set.
- Учитывает направление: forward depth и backward depth считаются отдельно.
- Максимальная глубина ограничена `maxTraversalDepth`.

**Ширина (width):**
- Вычисляется как количество узлов на каждом уровне distance.
- Анализируется распределение: если ширина резко растёт на уровне 2 и остаётся большой на уровне 3 — это признак широкого влияния.
- Ширина на уровне 0 (starting entities) — характеризует размер самого изменения.

**Плотность (density):**
- Отношение количества рёбер к количеству узлов в affected subgraph.
- Высокая плотность означает сильную связанность affected set — больше вероятность каскадных эффектов.

### Как выделяются критические узлы и высокорисковые области

Критические узлы — это узлы, изменение которых имеет непропорционально большие последствия:

**Признаки критического узла:**
1. **High fan-out:** узел имеет более N dependents (N конфигурируется, по умолчанию 20).
2. **Архитектурная граница:** узел находится на границе модуля или bounded context.
3. **Shared infrastructure:** узел принадлежит shared модулю (utils, common, core).
4. **API surface:** узел является публичным API (экспортируемый класс, endpoint).
5. **Schema entity:** узел является таблицей или колонкой с внешними ключами.
6. **Historical hotspot:** узел часто фигурирует в прошлых инцидентах.
7. **Базовый класс/интерфейс:** узел имеет множество наследников или реализаций.

**High-risk areas:**
- Области, содержащие несколько критических узлов.
- Области с высокой плотностью связей.
- Области, где транзитивное замыкание резко расширяется.
- Области на стыке нескольких модулей.

---

## 14. Risk Analysis

### Источники риска

Risk Evaluator анализирует affected set и формирует risk markers на основе:

1. **Структурных характеристик affected set:** размер, глубина, связанность, наличие критических узлов.
2. **Типов затронутых сущностей:** API, схема данных, базовая абстракция.
3. **Исторических данных:** прошлые инциденты, регрессии, сложность аналогичных задач.
4. **Модульных границ:** пересечение модульных границ, нарушение архитектурных правил.
5. **Состояния системы:** активные задачи, незавершённые миграции, устаревший индекс.

### Типы риска

#### 1. Архитектурный риск (Architectural Risk)

**Определение:** риск нарушения архитектурных принципов, модульных границ, установленных ADR.

**Когда возникает:**
- Изменение пересекает границу bounded context.
- Изменение создаёт новую зависимость между модулями.
- Изменение нарушает правило, установленное ADR (например, "модуль A не должен импортировать модуль B").
- Изменение foundational abstraction (базовый класс, core interface, shared utility).

**Как формируется risk marker:**
- Проверка affected set на наличие межмодульных зависимостей.
- Проверка, не затрагивает ли изменение shared/critical модули.
- Сопоставление с ADR и архитектурными правилами.
- Если starting entity — базовая абстракция с широким fan-out → high архитектурный риск.

**Severity factors:**
- Количество пересекаемых модульных границ.
- Является ли затрагиваемая сущность foundational.
- Противоречит ли изменение существующим ADR.

#### 2. Регрессионный риск (Regression Risk)

**Определение:** риск того, что изменение сломает существующую функциональность.

**Когда возникает:**
- Изменение публичного API.
- Изменение сигнатуры метода/функции.
- Изменение схемы данных.
- Высокий fan-out: много dependents.
- Исторические данные показывают регрессии для аналогичных изменений.

**Как формируется risk marker:**
- Подсчёт количества dependents для каждого starting entity.
- Поиск тестов, покрывающих affected entities.
- Сопоставление с историческими регрессиями из Knowledge.
- Оценка: если количество dependents > порога → high регрессионный риск.

**Severity factors:**
- Количество dependents.
- Наличие/отсутствие тестового покрытия.
- Историческая частота регрессий.

#### 3. Интеграционный риск (Integration Risk)

**Определение:** риск нарушения взаимодействия между компонентами, сервисами, модулями.

**Когда возникает:**
- Изменение затрагивает API-контракты.
- Изменение затрагивает формат данных, используемый несколькими компонентами.
- Изменение затрагивает event-протоколы или очереди сообщений.
- Изменение в модуле, от которого зависят многие другие модули.

**Как формируется risk marker:**
- Проверка affected set на наличие `EXPOSES` рёбер.
- Проверка, является ли starting entity API-контрактом.
- Анализ цепочек зависимостей, пересекающих модульные границы.
- Если downstream dependents находятся в других модулях → integration risk.

**Severity factors:**
- Количество downstream модулей.
- Является ли контракт версионированным.
- Наличие интеграционных тестов.

#### 4. Schema/Data Risk

**Определение:** риск потери или повреждения данных, нарушения целостности схемы.

**Когда возникает:**
- Изменение схемы таблицы (добавление/удаление колонок, изменение типов).
- Миграции, конфликтующие с другими миграциями.
- Изменение, затрагивающее внешние ключи.
- Изменение логики чтения/записи данных.

**Как формируется risk marker:**
- Проверка affected set на наличие schema entities (таблицы, колонки).
- Проверка наличия незавершённых миграций в affected area.
- Анализ `READS`/`WRITES` связей.
- Если изменение затрагивает foreign key → critical schema risk.

**Severity factors:**
- Наличие внешних ключей.
- Объём данных в затрагиваемых таблицах.
- Наличие незавершённых миграций.

#### 5. Concurrency/Conflict Risk

**Определение:** риск конфликта с другими активными задачами или параллельными изменениями.

**Когда возникает:**
- Другая активная задача изменяет те же файлы/символы.
- Другая активная задача выполняет миграции в той же области.
- Несколько задач изменяют shared dependencies.

**Как формируется risk marker:**
- Conflict Detector находит пересечения (см. раздел 15).
- Если пересечение обнаружено → concurrency risk marker.
- Severity зависит от типа и серьёзности конфликта.

#### 6. Hidden Dependency Risk

**Определение:** риск, связанный с зависимостями, которые не отражены или слабо отражены в Graph.

**Когда возникает:**
- Runtime-зависимости (event bus, DI container).
- Зависимости через конфигурацию.
- Неявные зависимости через соглашения (naming conventions).
- Зависимости, не обнаруженные Indexer (parser failures, unsupported language).

**Как формируется risk marker:**
- Проверка diagnostics Indexer: есть ли parser failures в affected area.
- Проверка Knowledge: есть ли записи о hidden dependencies для affected modules.
- Если affected area содержит конфигурационные файлы → риск скрытых зависимостей.
- Всегда moderate риск при наличии DI, event bus, dynamic imports.

#### 7. Security Risk

**Определение:** риск нарушения безопасности.

**Когда возникает:**
- Изменение кода аутентификации/авторизации.
- Изменение кода валидации входных данных.
- Изменение кода, работающего с чувствительными данными.
- Изменение конфигурации безопасности.

**Как формируется risk marker:**
- Проверка affected set на наличие security-related сущностей.
- Проверка Knowledge на наличие security ADR для affected area.

#### 8. Performance Risk

**Определение:** риск деградации производительности.

**Когда возникает:**
- Изменение в критическом по производительности коде (hot path).
- Изменение запросов к базе данных.
- Изменение алгоритмов с высокой сложностью.
- Добавление синхронных операций в асинхронный контекст.

**Как формируется risk marker:**
- Проверка Knowledge на наличие performance characteristics affected area.
- Если affected set включает БД-запросы или циклы с большим fan-out → performance risk.

### Как формируются risk markers

Каждый risk marker содержит:

1. **Тип риска** (architectural, regression, integration, schema, concurrency, hidden-dependency, security, performance).
2. **Severity** (low, medium, high, critical) — на основе severity factors.
3. **Source** (узел графа или группа узлов, являющихся источником риска).
4. **Evidence** — доказательства: traversal path (для regression), количество dependents (для regression), нарушение ADR (для architectural), конфликтующие задачи (для concurrency).
5. **Mitigation** — рекомендация по снижению риска.
6. **Confidence** — уверенность в оценке риска (зависит от completeness Graph, Research, исторических данных).

---

## 15. Conflict Detection

### Конфликты между активными задачами

Conflict Detector проверяет, не пересекается ли текущий affected set с affected sets других активных задач.

**Процесс:**
1. Получение списка активных задач (API Gateway).
2. Для каждой активной задачи — получение Impact Report (из Knowledge или напрямую).
3. Пересечение affected sets: `currentAffectedSet ∩ taskAffectedSet`.
4. Если пересечение не пусто — конфликт.

### Конфликты по файлам

**Что проверяется:** пересечение на уровне файлов.

**Критерии конфликта:**
- Две задачи изменяют один и тот же файл.
- Задачи изменяют разные части одного файла, но в overlapping областях (один и тот же класс, функция).

**Severity:**
- `high` — обе задачи изменяют один и тот же файл.
- `medium` — задачи изменяют разные файлы в одном модуле.
- `low` — задачи изменяют файлы в разных модулях, но с общей зависимостью.

**Resolution hint:**
- "Требуется координация между задачами."
- "Рекомендуется последовательное выполнение."
- "Рекомендуется разделение файла перед изменениями."

### Конфликты по символам

**Что проверяется:** пересечение на уровне символов (классов, функций, переменных).

**Критерии конфликта:**
- Две задачи изменяют один и тот же символ.
- Одна задача изменяет символ, другая — его dependents.

**Severity:**
- `critical` — обе задачи изменяют один и тот же символ.
- `high` — задачи изменяют взаимозависимые символы.
- `medium` — задачи изменяют символы в одном классе/файле.

### Конфликты по модулям

**Что проверяется:** пересечение на уровне модулей.

**Критерии конфликта:**
- Две задачи работают в одном модуле.
- Задачи работают в разных модулях с сильной связанностью.

**Severity:**
- `high` — задачи работают в одном bounded context.
- `medium` — задачи работают в связанных модулях.

### Конфликты по миграциям

**Что проверяется:** пересечение на уровне миграций базы данных.

**Критерии конфликта:**
- Две задачи создают миграции для одной таблицы.
- Миграции имеют конфликтующие изменения (например, одна добавляет колонку, другая удаляет).

**Severity:**
- `critical` — конфликтующие миграции для одной таблицы.
- `high` — миграции для связанных таблиц (foreign key).
- `medium` — миграции для разных таблиц в одной БД.

### Конфликты по shared infrastructure

**Что проверяется:** пересечение на уровне общей инфраструктуры.

**Критерии конфликта:**
- Две задачи изменяют shared модули (common, utils, core).
- Две задачи изменяют конфигурационные файлы.
- Две задачи изменяют Docker-конфигурацию, CI/CD.

**Severity:**
- `high` — изменение shared модуля с широким использованием.
- `medium` — изменение конфигурации.

### Конфликты между plan-ами и текущим состоянием проекта

**Что проверяется:** расхождение между планируемым изменением и текущим состоянием workspace.

**Критерии конфликта:**
- Starting entity была изменена с момента последней индексации.
- Файл, который планируется изменить, уже изменён (грязный workspace).
- Graph version не соответствует workspace state.

**Severity:**
- `high` — workspace state расходится с Graph.
- `medium` — незакоммиченные изменения в affected files.

**Resolution hint:**
- "Рекомендуется завершить текущие изменения перед началом задачи."
- "Требуется переиндексация проекта."

---

## 16. Validation Scope

### Что нужно проверить после изменения

Validation Scope Builder формирует структурированный список проверок, необходимых после выполнения изменения. Это не план тестирования (Plan тестирования строится Planner), а именно список *что должно быть проверено*.

### Какие тесты потенциально затронуты

**Определение:**
- Поиск всех тестовых узлов, связанных с affected entities через ребро `TESTS`.
- Включение тестов, которые покрывают прямые и косвенные dependents.
- Включение тестов, которые исторически падали при аналогичных изменениях (из Knowledge).

**Результат:**
- Список тестовых файлов/сьютов.
- Приоритет: `must-run` (тесты, напрямую связанные с изменяемыми сущностями), `should-run` (тесты dependents), `may-run` (тесты соседних компонентов).
- Оценка вероятности падения: на основе historical данных и характера изменения.

### Какие модули требуют верификации

**Определение:**
- Модули, содержащие affected entities.
- Модули, зависящие от affected modules.
- Shared модули, затронутые изменением.

**Результат:**
- Список модулей с указанием типа требуемой верификации:
  - `full` — полная проверка модуля (изменение внутри модуля).
  - `integration` — проверка интеграции с изменённым модулем.
  - `smoke` — базовая проверка (модуль затронут косвенно).

### Какие API/маршруты/таблицы должны быть перепроверены

**API Endpoints:**
- Все маршруты, связанные с affected entities через `ROUTES_TO`.
- Все маршруты, потребляющие affected API.

**Базы данных:**
- Таблицы, затронутые изменением схемы.
- Таблицы, связанные через foreign keys.
- Миграции, которые должны быть выполнены или проверены.

**Результат:**
- Список endpoints с ожидаемым поведением.
- Список таблиц с требуемыми проверками целостности.

### Какие документы и ADR нужно учитывать

- ADR, связанные с affected modules — проверка, не противоречит ли изменение принятым решениям.
- ADR, которые могут потребовать обновления после изменения.
- Документация API, которая может устареть.
- Спецификации, которые могут потребовать пересмотра.

---

## 17. Impact Report

### Полная структура Impact Report

```yaml
ImpactReport:
  # Идентификация
  impactId: UUID
  taskId: UUID
  researchId: UUID
  graphVersion: string
  commitHash: string
  createdAt: DateTime
  createdBy: ComponentId ("ImpactAnalysisEngine")
  reportVersion: integer

  # 1. Summary
  summary:
    briefDescription: string              # Краткое описание изменения (1-2 предложения)
    overallRiskLevel: enum                # low | medium | high | critical
    blastRadiusCategory: enum             # small | medium | large | critical
    totalAffectedNodes: integer
    totalAffectedModules: integer
    totalConflicts: integer
    confidence: float                     # 0.0 – 1.0
    recommendation: enum                  # proceed | proceed_with_caution | replan | additional_research_needed

  # 2. Change Intent
  changeIntent:
    description: string                   # Нормализованное описание изменения
    type: enum                            # modify | add | remove | mixed
    proposedChanges:
      - type: enum                        # modify | add | remove
        target: EntityRef
        confidence: float                 # Уверенность Research в этом change item
        reason: string
    ambiguities:
      - description: string
        candidates: EntityRef[]
        impactOnAnalysis: string

  # 3. Starting Entities
  startingEntities:
    - nodeId: NodeId
      nodeType: NodeType
      name: string
      file: FilePath
      module: ModuleId
      resolutionMethod: enum              # direct_match | fqn_lookup | file_symbol_lookup | semantic_match
      resolutionConfidence: float         # 0.0 – 1.0
      isAmbiguous: boolean
      alternativeNodes: NodeId[]          # Если неоднозначность

  # 4. Affected Entities
  affectedEntities:
    - nodeId: NodeId
      nodeType: NodeType
      name: string
      file: FilePath
      module: ModuleId
      affectionType: enum                 # direct | indirect
      distance: integer                   # 0 = starting entity
      dependencyPath:                     # Кратчайший путь от starting entity
        - from: NodeId
          to: NodeId
          edgeType: EdgeType
      riskLevel: enum                     # low | medium | high | critical
      reason: string                      # Почему включён в affected set

  # 5. Dependency Paths
  dependencyPaths:
    directDependencies: NodeId[]          # Прямые зависимости (forward)
    directDependents: NodeId[]            # Обратные зависимости (backward)
    transitiveClosure: NodeId[]           # Полное замыкание
    keyPaths:                             # Наиболее важные пути
      - path: NodeId[]
        significance: string              # Почему этот путь важен
        riskImplication: string

  # 6. Blast Radius
  blastRadius:
    category: enum                        # small | medium | large | critical
    depth:
      forward: integer
      backward: integer
      max: integer
    width:
      byLevel:
        - level: integer
          nodeCount: integer
          criticalNodeCount: integer
      total: integer
    density: float                        # edges / nodes в affected subgraph
    criticalNodes:
      - nodeId: NodeId
        criticalityReason: enum           # high_fan_out | architectural_boundary | shared_infrastructure | api_surface | schema_entity | historical_hotspot | base_class
        dependentsCount: integer

  # 7. Risks
  risks:
    - markerId: UUID
      riskType: enum                      # architectural | regression | integration | schema | concurrency | hidden_dependency | security | performance
      severity: enum                      # low | medium | high | critical
      source:
        nodeIds: NodeId[]
        edgeIds: EdgeId[]                 # Опционально
      description: string
      evidence:
        - type: enum                      # traversal_path | historical_incident | adr_violation | conflict | parser_failure | missing_coverage
          reference: string
      mitigation: string                  # Рекомендация
      confidence: float                   # 0.0 – 1.0

  # 8. Conflicts
  conflicts:
    - conflictId: UUID
      conflictType: enum                  # file | symbol | module | migration | infrastructure | plan_state
      conflictingTaskId: TaskId
      conflictingTaskDescription: string
      sharedEntities: NodeId[]
      description: string
      severity: enum                      # low | medium | high | critical
      resolutionHint: string
      detectedAt: DateTime

  # 9. Validation Scope
  validationScope:
    tests:
      mustRun: TestRef[]                  # Обязательные тесты
      shouldRun: TestRef[]                # Рекомендуемые тесты
      mayRun: TestRef[]                   # Опциональные тесты
      estimatedFailureProbability: float  # 0.0 – 1.0
    modules:
      - moduleId: ModuleId
        verificationType: enum            # full | integration | smoke
        reason: string
    apiEndpoints:
      - endpoint: string
        expectedBehavior: string
        riskOfBreakage: enum              # low | medium | high
    database:
      - table: string
        verificationType: enum            # schema_integrity | data_integrity | migration_check
        reason: string
    documentation:
      - entryId: EntryId
        type: enum                        # adr | spec | api_doc
        action: enum                      # review | update | archive
        reason: string

  # 10. Unknowns
  unknowns:
    - description: string                 # Что неизвестно
      source: enum                        # research_gap | graph_incompleteness | parser_failure | ambiguous_intent | missing_historical_data
      impactOnAnalysis: string            # Как это влияет на достоверность
      mitigation: string                  # Что можно сделать

  # 11. Confidence
  confidence:
    overall: float                        # 0.0 – 1.0
    breakdown:
      startingEntitiesConfidence: float
      graphCompleteness: float
      researchCompleteness: float
      knowledgeAvailability: float
      traversalCompleteness: float
    limitingFactors:
      - factor: string
        impact: float                     # На сколько снижает confidence

  # 12. Source References
  sourceReferences:
    - sourceType: enum                    # graph | research | knowledge | workspace | config
      reference: string
      version: string
      accessedAt: DateTime
      reliability: enum                   # high | medium | low

  # 13. Version Metadata
  versionMetadata:
    reportVersion: integer
    graphVersion: string
    commitHash: string
    researchId: UUID
    previousReportId: UUID | null         # Если основан на предыдущем
    supersededReportIds: UUID[]           # Какие отчёты заменены
    generatedBy: string                   # "ImpactAnalysisEngine v1.0.0"
    generationDuration: integer           # ms
```

---

## 18. Confidence Model

### Как оценивается уверенность анализа

Confidence — это агрегированная оценка того, насколько полным и достоверным является Impact Report. Она вычисляется как взвешенная композиция нескольких факторов.

### Факторы, из которых складывается confidence

#### 1. Starting Entities Confidence (вес: высокий)

**Что оценивается:** насколько точно определены starting entities.

**Влияющие факторы:**
- `resolutionMethod`: `direct_match` (высокий confidence) vs `semantic_match` (низкий).
- `isAmbiguous`: если есть альтернативные узлы — снижение.
- `resolutionConfidence` из Research Report.

**Расчёт:** среднее `resolutionConfidence` по всем starting entities.

#### 2. Graph Completeness (вес: высокий)

**Что оценивается:** насколько полон Graph для affected area.

**Влияющие факторы:**
- Graph diagnostics: есть ли degraded scopes в affected area.
- Validation status: прошёл ли Graph валидацию.
- Indexer status: есть ли parser failures в affected files.
- Возраст индекса: время с последней полной индексации.

**Расчёт:**
- Если Graph validated без ошибок в affected area → 1.0.
- Если есть degraded scopes → пропорционально доле degraded узлов.
- Если есть parser failures → снижение на коэффициент.

#### 3. Research Completeness (вес: средний)

**Что оценивается:** насколько полон Research Report.

**Влияющие факторы:**
- `researchReport.completeness`.
- Количество `unansweredQuestions`, относящихся к affected area.
- Наличие `sourceReferences` для всех starting entities.

**Расчёт:** на основе `researchReport.completeness`, скорректированного на релевантность unanswered questions.

#### 4. Knowledge Availability (вес: средний)

**Что оценивается:** доступность и актуальность исторических данных.

**Влияющие факторы:**
- Наличие прошлых Impact Reports для affected entities.
- Актуальность исторических данных (возраст).
- Наличие ADR для affected modules.

**Расчёт:** отношение доступных исторических записей к ожидаемым.

#### 5. Traversal Completeness (вес: средний)

**Что оценивается:** был ли траверс завершён или остановлен.

**Влияющие факторы:**
- `stoppedEarly`: был ли траверс остановлен до исчерпания.
- `stopReason`: `maxDepth` (умеренное снижение), `timeout` (сильное снижение), `maxNodes` (сильное снижение).
- Глубина траверса относительно конфигурированного максимума.

**Расчёт:**
- Если траверс завершён естественно → 1.0.
- Если остановлен по maxDepth → 0.9.
- Если остановлен по timeout → 0.5.
- Если остановлен по maxNodes → 0.6.

#### 6. Историческая согласованность (вес: низкий)

**Что оценивается:** согласуется ли текущий анализ с историческими данными.

**Влияющие факторы:**
- Противоречия между Graph и Knowledge.
- Расхождения между текущим affected set и прошлыми.

**Расчёт:** 1.0 если нет противоречий; снижается при их наличии.

### Агрегация в overall confidence

```
overallConfidence = weighted_average([
    (startingEntitiesConfidence, 0.30),
    (graphCompleteness,           0.30),
    (researchCompleteness,        0.15),
    (knowledgeAvailability,       0.10),
    (traversalCompleteness,       0.10),
    (historicalConsistency,       0.05)
])
```

### Факторы, снижающие confidence

| Фактор | Влияние | Что делать |
|--------|---------|-----------|
| **Неполный Graph** | Сильное | Запросить переиндексацию |
| **Устаревший индекс** | Сильное | Запросить переиндексацию |
| **Ambiguous intent** | Сильное | Запросить уточнение Research |
| **Unsupported language** | Среднее | Пометить как partial |
| **Parser failures** | Среднее | Пометить affected files |
| **Missing historical data** | Слабое | Пометить, но продолжать |
| **Conflicts between sources** | Среднее | Зафиксировать, снизить confidence |

### Когда модуль обязан явно сообщить, что анализ неполный

Impact Analysis Engine обязан явно указать на неполноту в следующих случаях:

1. **`overallConfidence < confidenceThreshold.low`** (конфигурируется). Impact Report публикуется с `recommendation: additional_research_needed`.
2. **Траверс остановлен принудительно** (`stoppedEarly = true`). Указывается в summary и unknowns.
3. **Есть degraded scopes в affected area.** Каждый degraded scope — отдельный unknown.
4. **Есть parser failures в affected files.** Список файлов включается в unknowns.
5. **Starting entities определены с низким confidence.** Указывается в change intent.
6. **Есть противоречия между Graph и Knowledge.** Фиксируется в unknowns.

**Критическое правило:** Impact Report никогда не должен скрывать неполноту или создавать ложное впечатление полноты. Если есть сомнения — они должны быть явно выражены.

---

## 19. Versioning и Reuse

### Versioning Impact Report

Каждый Impact Report имеет номер версии (`reportVersion`), увеличивающийся с каждым пересмотром для одной задачи. Новая версия создаётся при:
- Replanning (Planner запросил пересмотр).
- Изменении scope задачи.
- Обновлении Graph (переиндексация изменила affected area).
- Обнаружении новых конфликтов.

### Связь с Graph Version

Каждый Impact Report привязан к конкретной версии Graph (`graphVersion`). Это критически важно:
- Если Graph обновился, прошлый Impact Report может быть невалидным.
- При сравнении Impact Reports разных версий Graph необходимо учитывать структурные изменения.
- Impact Report, созданный для устаревшей версии Graph, не может быть использован без проверки актуальности.

### Связь с commit hash

Каждый Impact Report привязан к `commitHash` — состоянию репозитория на момент анализа. Это позволяет:
- Восстановить контекст анализа.
- Проверить, не изменился ли код с момента анализа.
- Сравнить ожидаемый affected set с фактическим после выполнения задачи.

### Reuse исторического Impact Analysis

**Когда переиспользование возможно:**

1. **Та же задача, тот же Graph version.** Если задача была приостановлена и возобновлена без изменений в коде — Impact Report можно переиспользовать.
2. **Аналогичная задача для тех же сущностей.** Если новый Impact Report строится для тех же starting entities и Graph не изменился — можно использовать прошлый affected set как baseline.
3. **Incremental impact analysis.** Если Graph обновился незначительно, можно переиспользовать части прошлого affected set, пересчитав только изменившиеся части (см. раздел 20).

**Когда переиспользование НЕ допускается:**

1. **Graph version изменилась.** Структурные изменения могли добавить или удалить зависимости.
2. **Workspace state изменился.** Файлы были изменены, переименованы, удалены.
3. **Появились новые активные задачи.** Конфликтная ситуация могла измениться.
4. **Research Report обновился.** Новые findings могут изменить starting entities.
5. **Impact Report помечен как `partial` или имеет низкий confidence.** Неполный анализ нельзя переиспользовать.
6. **Прошлый Impact Report старше N дней** (конфигурируется). Данные могли устареть даже при совпадении версий.

### Invalidation правил

Impact Report считается невалидным и должен быть пересоздан, если:

1. **Graph version изменилась.** Автоматическая инвалидация.
2. **Commit hash изменился.** Автоматическая инвалидация.
3. **Research Report обновлён.** Автоматическая инвалидация.
4. **Обнаружены новые конфликты.** Частичная инвалидация (только conflict section).
5. **Confidence упал ниже порога.** Инвалидация с запросом пересчёта.
6. **Обнаружена ошибка в предыдущем анализе.** Инвалидация с mandatory пересчётом.

### Когда прошлый Impact Report нельзя переиспользовать

Категорически нельзя переиспользовать Impact Report, если:
- Он создан для другой задачи.
- Он создан более N дней назад (независимо от версий).
- Он был помечен как `invalid` или `superseded`.
- Он имеет `overallConfidence < минимального порога`.
- Graph был перестроен (resync) с момента создания отчёта.

---

## 20. Производительность

### Incremental Analysis

При незначительных изменениях (обновление Graph в одном модуле, небольшое изменение scope) Impact Analysis Engine должен минимизировать пересчёт:

**Стратегия:**
1. **Определить изменившиеся starting entities.** Только те, которые затронуты обновлением Graph или изменением Research.
2. **Пересчитать affected set только для изменившихся starting entities.**
3. **Объединить с неизменившейся частью предыдущего affected set.**
4. **Пересчитать риски и конфликты только для изменённой части.**

**Ограничения:**
- Incremental mode допустим только если structural changes < порога (конфигурируется, по умолчанию 20% affected nodes).
- Если изменений больше порога — полный пересчёт.

### Reuse Graph Traversals

**Стратегия кеширования traversal results:**

1. **Кешировать результаты `getAffectedSubgraph(startingEntities)`** для комбинации (starting entities × graph version). Если те же starting entities запрашиваются повторно для той же версии графа — использовать закешированный результат.
2. **Кешировать результаты traversal walkers** (dependency paths, transitive closure) отдельно.
3. **Время жизни кеша:** до изменения graph version.

### Cache Affected Sets

**Стратегия:**

1. Кешировать affected set для каждой starting entity индивидуально.
2. При анализе новой задачи проверять, есть ли закешированные affected sets для её starting entities.
3. Объединять закешированные affected sets, пересчитывая только пересечения.
4. Инвалидация кеша: при изменении graph version.

### Batch Graph Queries

**Стратегия:**

1. Вместо последовательных запросов `getDependencies(nodeId)` для каждого узла — использовать batch-запросы.
2. `getAffectedSubgraph(nodeIds[])` — один запрос вместо N.
3. `getModuleStructure(moduleIds[])` — массовый запрос.

**Выгода:** снижение network overhead, меньше обращений к Neo4j.

### Partial Recomputation

**Стратегия:**

1. Если изменение затрагивает только определённые типы анализа (например, только schema impact при изменении миграции), пересчитывать только соответствующие секции.
2. Структурный анализ может быть переиспользован, если starting entities не изменились.
3. Risk analysis может быть пересчитан частично (только для изменившихся affected nodes).

### Reuse Historical Patterns

**Стратегия:**

1. Если тот же affected set (или его значительная часть) уже анализировался в прошлом — переиспользовать risk markers, validation scope, conflict patterns.
2. Не копировать слепо: проверять актуальность каждого переиспользованного элемента.
3. Источник: Historical Correlator, Knowledge API.

---

## 21. Отказоустойчивость

### Что делать, если Graph недоступен

**Симптом:** `Graph.getCurrentVersion()` возвращает ошибку или таймаут.

**Действия:**
1. Повторная попытка (retry) с экспоненциальной задержкой (до 3 попыток).
2. Если после retry Graph недоступен:
   - Публикация `ImpactAnalysisFailed` с `reason: graph_unavailable`.
   - Pipeline приостанавливается.
   - **Запрещено** продолжать анализ без Graph.
3. Если доступен fallback (закешированный снапшот Graph) — использование с пометкой `graph_source: snapshot`, confidence снижается.

### Что делать, если Research неполный

**Симптом:** `researchReport.completeness < порога`, множество unanswered questions.

**Действия:**
1. Оценка: затрагивают ли unanswered questions affected area.
2. Если нет — продолжение с пометкой о неполноте, confidence снижается.
3. Если да:
   - Если `completeness < criticalThreshold` — публикация `ResearchRequested`, pipeline приостанавливается.
   - Если `completeness >= criticalThreshold` — продолжение с `recommendation: proceed_with_caution`, unknowns заполняются.

### Что делать, если starting entities не разрешаются

**Симптом:** после всех методов разрешения (direct match, FQN, file+symbol, semantic) starting entities не определены.

**Действия:**
1. Публикация `ResearchRequested` с указанием, какие именно сущности не удалось разрешить.
2. Pipeline приостанавливается.
3. **Запрещено** продолжать анализ с пустым starting set.
4. **Запрещено** угадывать starting entities.

### Что делать, если есть противоречия между Graph и Workspace

**Симптом:** Graph показывает одну структуру, Workspace (файловая система) — другую (например, файл существует на диске, но отсутствует в Graph).

**Действия:**
1. Запрос переиндексации (`ProjectIndexRequested`).
2. Если переиндексация невозможна немедленно — продолжение с пометкой `graph_workspace_mismatch`, confidence сильно снижается.
3. Затронутые файлы помечаются в unknowns.
4. Если расхождение критично (starting entity не найдена в Graph, но существует в Workspace) — pipeline приостанавливается.

### Что делать, если historical data отсутствуют

**Симптом:** Knowledge API не возвращает прошлых Impact Reports, ADR, исторических данных для affected entities.

**Действия:**
1. Это не блокирует анализ.
2. Confidence снижается (knowledgeAvailability = 0).
3. В Impact Report указывается: `knowledgeAvailability: none`.
4. Risk analysis выполняется без historical correlation — риски могут быть недооценены.

### Что делать, если активные задачи не могут быть проверены

**Симптом:** API Gateway недоступен или не возвращает список активных задач.

**Действия:**
1. Повторная попытка.
2. Если после retry список активных задач недоступен:
   - Conflict detection пропускается.
   - В Impact Report: `conflicts: unavailable` с указанием причины.
   - Confidence снижается.
   - `recommendation: proceed_with_caution` (невозможно гарантировать отсутствие конфликтов).

### Что делать, если confidence слишком низкий

**Симптом:** `overallConfidence < confidenceThreshold.low`.

**Действия:**
1. Если `overallConfidence < минимально допустимого` (конфигурируется, по умолчанию 0.3) — **остановка pipeline**.
2. Публикация `ImpactAnalysisFailed` с указанием причин низкого confidence.
3. Если confidence в диапазоне [low, medium) — публикация Impact Report с `recommendation: additional_research_needed`.
4. Pipeline может быть продолжен только после ручного подтверждения (Human Approval).

---

## 22. Ограничения

### Когда Impact Analysis обязан отказаться от уверенного вывода

Impact Analysis Engine обязан явно указать в Impact Report, что вывод не является уверенным, в следующих случаях:

1. **`overallConfidence < 0.7`.** Summary помечается: "Данный анализ основан на неполных данных."
2. **Наличие `unknowns` с `impactOnAnalysis: critical`.** Указывается в summary.
3. **Траверс остановлен принудительно.** Указывается: "Affected set может быть неполным."
4. **Есть degraded scopes в Graph.** Указывается: "Следующие области графа повреждены и не анализировались: ..."
5. **Есть parser failures в affected files.** Указывается: "Следующие файлы не были полностью проанализированы: ..."

### Когда Impact Analysis обязан пометить анализ как partial

Анализ помечается как `partial` (неполный), если:

1. **Траверс остановлен по `maxDepth`, `timeout` или `maxNodes`.** Affected set может быть больше.
2. **Есть unanswered questions Research, прямо относящиеся к affected area.**
3. **Graph имеет degraded scopes в affected area.**
4. **Historical data недоступны, но ожидались.**
5. **Workspace state расходится с Graph для affected area.**

**Partial-анализ:**
- Не блокирует pipeline.
- Явно указывается в summary и metadata.
- Confidence снижается.
- `recommendation` должно быть не выше `proceed_with_caution`.

### Когда Impact Analysis обязан запросить повторное исследование

Повторное исследование запрашивается через событие `ResearchRequested`, если:

1. **Starting entities не разрешаются.**
2. **Research completeness < критического порога.**
3. **Research не покрывает модули, определённые как критические Impact Analysis.**
4. **Unanswered questions Research критичны для анализа.**
5. **Research Report противоречит Graph (сущность не существует).**

### Когда Impact Analysis обязан инициировать повторную индексацию

Повторная индексация запрашивается через событие `ProjectIndexRequested`, если:

1. **Graph version устарела (workspace state изменился).**
2. **Есть parser failures в affected files.**
3. **Есть degraded scopes в affected area.**
4. **Graph validation failed для affected subgraph.**

### Когда Impact Analysis обязан остановить передачу результата в Planner без явного warning

**Критические условия остановки:**

1. **Graph недоступен.**
2. **Starting entities не определены.**
3. **`overallConfidence < минимально допустимого порога` (по умолчанию 0.3).**
4. **Обнаружены критические конфликты, требующие ручного разрешения** (конфигурируется).

**При остановке:**
- Публикуется `ImpactAnalysisFailed`.
- Impact Report не передаётся в Context Builder и Planner.
- Pipeline приостанавливается до разрешения причины.

---

## 23. Будущее развитие

### Что должно легко добавляться без изменения архитектуры

#### Новые типы связей

При добавлении новых edge types в Graph (например, `EVENT_PUBLISHES`, `CONFIGURES`) Impact Analysis Engine должен поддерживать их без архитектурных изменений:
- Новый edge type добавляется в конфигурацию traversal walkers.
- Risk Evaluator получает новый анализатор для специфического типа связи.
- Никакие другие компоненты не требуют изменений.

#### Новые типы риска

Risk Evaluator должен быть расширяемым:
- Новый анализатор риска регистрируется как плагин.
- Анализатор получает affected set и возвращает risk markers.
- Risk markers нового типа включаются в Impact Report без изменения его структуры.

#### Новые conflict analyzers

Conflict Detector должен быть расширяемым:
- Новый анализатор конфликтов регистрируется как плагин.
- Например: "Deployment Conflict Analyzer" для конфликтов деплоя.
- Conflict markers нового типа включаются в Impact Report.

#### Runtime-aware analyzers

При развитии Graph в сторону runtime-модели:
- Добавление анализаторов для event-driven зависимостей.
- Добавление анализаторов для очередей сообщений.
- Добавление анализаторов для dynamic dependency injection.
- Всё это — новые плагины к Dependency Traversal Engine и Risk Evaluator.

#### Test impact analyzers

При развитии тестовой инфраструктуры:
- Более глубокая интеграция с test runners.
- Предиктивная аналитика: "какие тесты упадут с вероятностью X%".
- История падений тестов для affected entities.

#### Infra impact analyzers

При расширении платформы:
- Анализ влияния на Docker-контейнеры.
- Анализ влияния на Kubernetes-конфигурацию.
- Анализ влияния на CI/CD pipeline.
- Анализ влияния на мониторинг и алертинг.

### Стратегический вектор развития

Impact Analysis Engine должен эволюционировать от **реактивного анализатора** ("что будет затронуто, если изменить X") к **предиктивной системе** ("с вероятностью Y изменение X вызовет проблему Z, основанную на исторических данных, структурном анализе и машинном обучении").

При этом базовый контракт остаётся неизменным:
- Impact Analysis Engine не пишет код.
- Impact Analysis Engine не принимает инженерных решений.
- Impact Analysis Engine остаётся обязательным звеном между Research и Planner.
- Impact Report остаётся основным выходным артефактом.

---

## Приложение A: События Impact Analysis Engine

| Событие | Направление | Назначение |
|---------|------------|-----------|
| `ImpactAnalysisStarted` | Публикация | Анализ влияния начался |
| `ImpactAnalysisCompleted` | Публикация | Impact Report готов |
| `ImpactAnalysisFailed` | Публикация | Анализ не может быть завершён |
| `ConflictDetected` | Публикация | Обнаружен конфликт с активной задачей |
| `ResearchRequested` | Публикация | Запрос дополнительного исследования |
| `ProjectIndexRequested` | Публикация | Запрос переиндексации |
| `ResearchCompleted` | Подписка | Получение Research Report |

## Приложение B: Конфигурационные параметры

| Параметр | По умолчанию | Описание |
|----------|-------------|----------|
| `maxTraversalDepth` | 5 (dependents), 3 (dependencies) | Максимальная глубина траверса |
| `traversalTimeout` | 30 сек | Таймаут траверса |
| `maxAffectedNodes` | 5000 | Максимальный размер affected set |
| `blastRadiusThresholds.small` | depth ≤ 2, nodes ≤ 20 | Порог малого blast radius |
| `blastRadiusThresholds.medium` | depth ≤ 5, nodes ≤ 100 | Порог среднего blast radius |
| `blastRadiusThresholds.critical` | nodes ≥ 500 | Порог критического blast radius |
| `confidenceThreshold.high` | 0.8 | Высокий confidence |
| `confidenceThreshold.medium` | 0.5 | Средний confidence |
| `confidenceThreshold.low` | 0.3 | Низкий confidence — остановка pipeline |
| `criticalDependentsCount` | 20 | Количество dependents для пометки узла как критического |
| `historicalDataMaxAge` | 90 дней | Максимальный возраст исторических данных |
| `incrementalChangeThreshold` | 0.2 (20%) | Порог изменений для incremental mode |
| `retryAttempts` | 3 | Количество повторных попыток |
| `retryDelay` | exponential: 1с, 2с, 4с | Задержка между попытками |