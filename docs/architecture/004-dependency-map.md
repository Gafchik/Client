# 004 — Dependency Map: Карта Связей Модулей

**Статус:** Предложен
**Автор:** Архитектурный Комитет
**Дата:** 2026-07-08
**Версия:** 1.0.0
**Зависимости:** [000-overview.md](./000-overview.md), [001-domain-model.md](./001-domain-model.md), [002-storage.md](./002-storage.md), [003-event-system.md](./003-event-system.md)

---

## Оглавление

1. [Цель документа](#1-цель-документа)
2. [Карта модулей верхнего уровня](#2-карта-модулей-верхнего-уровня)
3. [Матрица зависимостей](#3-матрица-зависимостей)
4. [Контракты модулей](#4-контракты-модулей)
   - [4.1 API Gateway](#41-api-gateway)
   - [4.2 Indexer](#42-indexer)
   - [4.3 Graph](#43-graph)
   - [4.4 Knowledge](#44-knowledge)
   - [4.5 Research Engine](#45-research-engine)
   - [4.6 Impact Analysis Engine](#46-impact-analysis-engine)
   - [4.7 Context Builder](#47-context-builder)
   - [4.8 Planner](#48-planner)
   - [4.9 Execution Engine](#49-execution-engine)
   - [4.10 Workspace](#410-workspace)
   - [4.11 Provider System](#411-provider-system)
5. [Карта артефактов](#5-карта-артефактов)
   - [5.1 Жизненный цикл артефактов](#51-жизненный-цикл-артефактов)
   - [5.2 Структура артефактов](#52-структура-артефактов)
6. [Карта событий](#6-карта-событий)
   - [6.1 Матрица публикации-подписки](#61-матрица-публикации-подписки)
   - [6.2 Потоки событий для ключевых сценариев](#62-потоки-событий-для-ключевых-сценариев)
7. [Потоки данных между модулями](#7-потоки-данных-между-модулями)
   - [7.1 Главный поток обработки задачи](#71-главный-поток-обработки-задачи)
   - [7.2 Поток индексации](#72-поток-индексации)
   - [7.3 Поток обновления знаний](#73-поток-обновления-знаний)
   - [7.4 Поток перепланирования](#74-поток-перепланирования)
8. [Интерфейсы хранилищ](#8-интерфейсы-хранилищ)
   - [8.1 PostgreSQL](#81-postgresql)
   - [8.2 Neo4j](#82-neo4j)
   - [8.3 Redis](#83-redis)
   - [8.4 Vector Store](#84-vector-store)
   - [8.5 File Storage](#85-file-storage)
9. [Правила взаимодействия](#9-правила-взаимодействия)
   - [9.1 Разрешённые и запрещённые связи](#91-разрешённые-и-запрещённые-связи)
   - [9.2 Правила вызова API](#92-правила-вызова-api)
   - [9.3 Правила публикации и подписки на события](#93-правила-публикации-и-подписки-на-события)
10. [Границы транзакций и консистентности](#10-границы-транзакций-и-консистентности)
11. [Observability и мониторинг взаимодействий](#11-observability-и-мониторинг-взаимодействий)

---

## 1. Цель документа

Данный документ определяет **полную карту связей** между всеми модулями платформы Client. Он отвечает на вопросы:

- Какие модули существуют и как они связаны друг с другом?
- Какие **контракты (API)** предоставляет каждый модуль?
- Какие **артефакты** передаются между модулями?
- Какие **события** публикует и на какие подписывается каждый модуль?
- Какие **хранилища** использует каждый модуль?
- Каковы **правила взаимодействия** — что разрешено, а что запрещено?

Документ является нормативным: любое отклонение от описанных здесь связей должно быть обосновано через ADR (Architecture Decision Record).

### Связанные документы

| Документ | Содержание |
|----------|-----------|
| [000-overview.md](./000-overview.md) | Обзор архитектуры, назначение каждого модуля |
| [001-domain-model.md](./001-domain-model.md) | Доменная модель: сущности, агрегаты, жизненные циклы |
| [002-storage.md](./002-storage.md) | Архитектура хранения: БД, индексы, файлы |
| [003-event-system.md](./003-event-system.md) | Полный каталог событий и подписчиков |

---

## 2. Карта модулей верхнего уровня

```
                          ┌──────────────────────────────┐
                          │        API Gateway            │
                          │   (REST / WebSocket / CLI)    │
                          └──────────────┬───────────────┘
                                         │ TaskReceived
                                         ▼
┌──────────────┐  ┌─────────────────────────────────────────────┐
│   Indexer    │  │              Task Pipeline                   │
│              │  │                                             │
│  сканирует   │  │  ┌──────────┐   ┌───────────────┐          │
│  файлы,      │  │  │ Research │   │    Impact     │          │
│  строит AST  │──┼──│  Engine  │──▶│   Analysis    │          │
│  ────────────│  │  │          │   │    Engine     │          │
│  публикует   │  │  └────┬─────┘   └───────┬───────┘          │
│  GraphUpdate │  │       │                 │                   │
└──────┬───────┘  │       │  Research       │  Impact           │
       │          │       │  Report         │  Report           │
       │          │       ▼                 ▼                   │
       │          │  ┌──────────────────────────────────┐       │
       │          │  │        Context Builder           │       │
       │          │  │   собирает Context Package       │       │
       │          │  └──────────────┬───────────────────┘       │
       │          │                 │ Context Package           │
       │          │                 ▼                           │
       │          │  ┌──────────────────────────────────┐       │
       │          │  │            Planner               │       │
       │          │  │   строит Execution Plan          │       │
       │          │  └──────────────┬───────────────────┘       │
       │          │                 │ Execution Plan            │
       │          │                 ▼                           │
       │          │  ┌──────────────────────────────────┐       │
       │          │  │       Execution Engine           │       │
       │          │  │   выполняет шаги плана           │       │
       │          │  └──────────────┬───────────────────┘       │
       │          │                 │ Execution Report          │
       │          │                 ▼                           │
       │          │  ┌──────────────────────────────────┐       │
       │          │  │     Knowledge / Graph Update     │       │
       │          │  │   фиксация результатов           │       │
       │          │  └──────────────────────────────────┘       │
       │          └─────────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────────────────┐
│                     Storage Layer                             │
│                                                              │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌─────────────┐  │
│  │PostgreSQL│  │  Neo4j   │  │  Redis   │  │ Vector Store│  │
│  │ (relation│  │ (graph)  │  │ (cache,  │  │ (embeddings)│  │
│  │  data)   │  │          │  │  queue)  │  │             │  │
│  └──────────┘  └──────────┘  └──────────┘  └─────────────┘  │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐    │
│  │                   File Storage                        │    │
│  │     (workspace snapshots, artifacts, raw files)      │    │
│  └──────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────┘

                    ┌─────────────────────┐
                    │   Provider System   │
                    │  (LLM, Embeddings,  │
                    │   Search, Vector)   │
                    └─────────────────────┘
                              ▲
                              │ используется модулями:
                              │ Research, Context Builder,
                              │ Planner, Execution
```

### Перечень модулей

| # | Модуль | Пакет (monorepo) | Назначение |
|---|--------|------------------|-----------|
| 1 | **API Gateway** | `apps/api` | Приём задач от пользователя, маршрутизация, стриминг прогресса |
| 2 | **Indexer** | `packages/parser` | Статический анализ кода, построение AST, извлечение символов |
| 3 | **Graph** | `packages/graph` | Графовая модель кода: сущности, отношения, traversal, impact |
| 4 | **Knowledge** | `packages/knowledge` | Долговременная память: ADR, best practices, история решений |
| 5 | **Research Engine** | `packages/context` (часть) | Оркестратор исследования: сбор информации из всех источников |
| 6 | **Impact Analysis Engine** | `packages/graph` (часть) | Анализ последствий изменений: зона влияния, риски, конфликты |
| 7 | **Context Builder** | `packages/context` | Сборка контекстного пакета для LLM с приоритезацией |
| 8 | **Planner** | `packages/planner` | Декомпозиция задачи, построение DAG шагов, критерии приёмки |
| 9 | **Execution Engine** | `apps/api` (часть) | Исполнение плана: вызов инструментов, AI-тасков, валидация |
| 10 | **Workspace** | `packages/shared` | Среда выполнения: файловая система, Git, Docker, sandbox |
| 11 | **Provider System** | `packages/ai` | Абстракция над LLM, embeddings, search, vector store |

---

## 3. Матрица зависимостей

Матрица показывает, какой модуль **зависит от API** другого модуля (стрелка: строка → столбец).
**P** = зависит через публикацию событий (producer), **S** = зависит через подписку на события (subscriber), **A** = зависит через прямой вызов API.

|                    | API GW | Indexer | Graph | Knowledge | Research | Impact | Context | Planner | Execution | Workspace | Provider |
|--------------------|:------:|:-------:|:-----:|:---------:|:--------:|:------:|:-------:|:-------:|:---------:|:---------:|:--------:|
| **API Gateway**    |   —    |         |       |           |          |        |         |         |           |           |          |
| **Indexer**        |        |    —    | **A** |           |          |        |         |         |           |    **A**  |          |
| **Graph**          |        |   **S** |   —   |           |          |        |         |         |           |           |          |
| **Knowledge**      |        |         |       |     —     |          |        |         |         |           |           |          |
| **Research Engine**|  **S** |         | **A** |    **A**  |    —     |        |         |         |           |    **A**  |   **A**  |
| **Impact Analysis**|        |         | **A** |    **A**  |   **S**  |   —    |         |         |           |           |          |
| **Context Builder**|        |         | **A** |    **A**  |   **S**  |  **S** |    —    |         |           |    **A**  |          |
| **Planner**        |        |         | **A** |    **A**  |   **S**  |  **S** |  **S**  |    —    |    **S**  |           |   **A**  |
| **Execution Engine**|       |         |       |    **A**  |          |        |         |  **S**  |     —     |    **A**  |   **A**  |
| **Workspace**      |        |   **P** |       |           |          |        |         |         |           |     —     |          |
| **Provider System**|        |         |       |           |          |        |         |         |           |           |     —    |

### Анализ матрицы

**Наибольшее число входящих зависимостей (высокая связанность — риск изменения):**
1. **Graph** — 4 прямых потребителя API (Indexer, Research, Impact Analysis, Context Builder, Planner). Это оправдано: Graph — каноническая структурная модель проекта.
2. **Knowledge** — 4 прямых потребителя API (Research, Impact Analysis, Context Builder, Planner, Execution). Оправдано: Knowledge — долговременная память.
3. **Workspace** — 3 прямых потребителя API (Indexer, Research, Context Builder, Execution). Оправдано: Workspace — единая среда выполнения.

**Наибольшее число исходящих зависимостей (высокая связанность — сложность модуля):**
1. **Research Engine** — 4 API-зависимости (Graph, Knowledge, Workspace, Provider) + 1 подписка (API Gateway). Оправдано: Research — оркестратор сбора информации.
2. **Planner** — 4 API-зависимости (Graph, Knowledge, Provider) + 3 подписки (Research, Impact Analysis, Context Builder) + 1 подписка на Execution. Оправдано: Planner — центральный узел принятия инженерных решений.

**Модули без прямых API-зависимостей (наиболее независимые):**
- **API Gateway** — зависит только от системы событий (публикует TaskReceived).
- **Provider System** — не зависит ни от одного модуля, чистый адаптер.

---

## 4. Контракты модулей

### 4.1 API Gateway

#### Назначение

Единственная точка входа для пользовательских запросов. Принимает задачу, публикует событие `TaskReceived`, обеспечивает стриминг прогресса через WebSocket.

#### Предоставляемый API

| Метод | Описание |
|-------|----------|
| `submitTask(task: UserIntent)` | Принять задачу от пользователя |
| `getTaskStatus(taskId: TaskId)` | Получить статус задачи |
| `getTaskResult(taskId: TaskId)` | Получить результат выполнения |
| `subscribeToTask(taskId: TaskId)` | Подписаться на стрим событий задачи (WebSocket) |
| `approveStep(executionId, stepId)` | Подтвердить шаг, требующий human approval |
| `rejectStep(executionId, stepId, reason)` | Отклонить шаг |
| `cancelTask(taskId: TaskId)` | Отменить задачу |

#### Потребляемый API

API Gateway **не вызывает API других модулей напрямую**. Взаимодействие — только через Event Bus.

#### Публикуемые события

| Событие | Назначение |
|---------|-----------|
| `TaskReceived` | Новая задача получена |

#### Подписки на события

| Событие | Назначение |
|---------|-----------|
| `TaskCompleted` | Уведомление пользователя о завершении |
| `StepStarted`, `StepCompleted`, `StepFailed` | Стриминг прогресса пользователю |
| `ExecutionPlanned` | План готов, можно показать пользователю |
| `ResearchCompleted` | Исследование завершено |
| `ApprovalRequired` | Запрос human approval |

---

### 4.2 Indexer

#### Назначение

Статический анализ исходного кода: сканирование файловой системы, построение AST, извлечение символов и отношений.

#### Предоставляемый API

| Метод | Описание |
|-------|----------|
| `indexProject(projectPath)` | Запуск полной индексации проекта |
| `indexFiles(filePaths[])` | Индексация указанных файлов |
| `getAST(filePath)` | Получить AST-представление файла |
| `getSymbols(filePath)` | Получить извлечённые символы файла |
| `getFileDependencies(filePath)` | Получить зависимости файла |
| `registerPlugin(plugin)` | Зарегистрировать языковой плагин |
| `getIndexManifest()` | Получить манифест индекса |

#### Потребляемый API

| Модуль | Методы | Назначение |
|--------|--------|-----------|
| **Graph** | `applyUpdate(update)` | Отправка извлечённых узлов и рёбер в граф |
| **Workspace** | `readFile()`, `watchFiles()`, `getProjectStructure()` | Доступ к файловой системе |

#### Публикуемые события

| Событие | Назначение |
|---------|-----------|
| `ProjectIndexed` | Полная индексация завершена |
| `GraphUpdateRequested` | Запрос на обновление графа (содержит `GraphUpdatePackage`) |

#### Подписки на события

| Событие | Назначение |
|---------|-----------|
| `FileChanged` | Инкрементальная индексация изменённого файла |
| `ProjectSnapshotRestored` | Переиндексация при восстановлении снапшота |

---

### 4.3 Graph

#### Назначение

Каноническая графовая модель кода проекта: хранение узлов (сущностей) и рёбер (отношений), выполнение графовых запросов, анализ влияния, версионирование.

#### Предоставляемый API

**Управление графом:**

| Метод | Описание |
|-------|----------|
| `applyUpdate(update: GraphUpdatePackage)` | Применить пакет изменений к графу |
| `createSnapshot()` | Создать снапшот текущего состояния |
| `restoreSnapshot(snapshotId)` | Восстановить граф из снапшота |
| `getCurrentVersion()` | Получить текущую версию графа |
| `validate()` | Запустить проверку консистентности |

**Запросы (Query Engine):**

| Метод | Описание |
|-------|----------|
| `getNode(nodeId)` | Получить узел по ID |
| `getNodesByType(type, filters)` | Найти узлы по типу и фильтрам |
| `getEdges(sourceId, targetId, edgeType)` | Найти рёбра |
| `getDependencies(nodeId, depth?)` | Получить зависимости узла |
| `getDependents(nodeId, depth?)` | Получить обратные зависимости (кто зависит от узла) |
| `getModuleStructure(moduleId)` | Получить структуру модуля |
| `getAffectedSubgraph(nodeIds[])` | Получить подграф, затронутый изменениями |
| `findCycles(scope?)` | Найти циклические зависимости |
| `findPaths(sourceId, targetId)` | Найти пути между узлами |
| `getVersionHistory(nodeId)` | Получить историю версий узла |
| `queryGraph(query: GraphQuery)` | Выполнить произвольный графовый запрос |

#### Потребляемый API

Graph не зависит от API других модулей. Он получает обновления через события `GraphUpdateRequested` от Indexer и запросы от потребителей.

#### Публикуемые события

| Событие | Назначение |
|---------|-----------|
| `GraphUpdated` | Состояние графа изменилось |
| `GraphVersionCreated` | Создана новая версия графа |
| `ArchitectureViolation` | Обнаружено нарушение архитектурных границ |
| `GraphValidationFailed` | Проверка консистентности не пройдена |

#### Подписки на события

| Событие | Назначение |
|---------|-----------|
| `GraphUpdateRequested` | Применить пакет изменений от Indexer |

---

### 4.4 Knowledge

#### Назначение

Долговременная память системы: хранение архитектурных решений (ADR), best practices, истории изменений, внешней документации. Семантический поиск по знаниям.

#### Предоставляемый API

| Метод | Описание |
|-------|----------|
| `storeEntry(entry: KnowledgeEntry)` | Сохранить запись знаний |
| `getEntry(entryId)` | Получить запись по ID |
| `searchSemantic(query: string, filters?)` | Семантический поиск (через embeddings) |
| `searchByEntity(entityId)` | Найти знания, связанные с сущностью |
| `searchByKeywords(keywords[])` | Ключевой поиск |
| `getRelatedEntries(entryId)` | Получить связанные записи |
| `getEntriesByType(type, filters?)` | Получить записи определённого типа |
| `getVersionHistory(entryId)` | История версий записи |
| `updateEntry(entryId, update)` | Обновить запись |
| `linkToGraph(entryId, nodeIds[])` | Связать запись с узлами графа |
| `getKnowledgeStats()` | Статистика базы знаний |

#### Потребляемый API

Knowledge не зависит от API других модулей. Использует **Provider System** для embeddings и **Vector Store** для хранения.

#### Публикуемые события

| Событие | Назначение |
|---------|-----------|
| `KnowledgeUpdated` | База знаний обновлена |
| `KnowledgeEntryCreated` | Создана новая запись |
| `KnowledgeEntryUpdated` | Запись обновлена |

#### Подписки на события

| Событие | Назначение |
|---------|-----------|
| `ResearchCompleted` | Сохранение Research Report в Knowledge |
| `StepCompleted` | Сохранение извлечённых уроков |
| `ExecutionFinished` | Сохранение Execution Report |

---

### 4.5 Research Engine

#### Назначение

Оркестратор исследования: получение задачи → формулировка исследовательских вопросов → параллельный сбор информации из Graph, Knowledge, Git, AST, документации, внешних источников → формирование Research Report.

#### Предоставляемый API

| Метод | Описание |
|-------|----------|
| `research(task: UserIntent)` | Запустить исследование по задаче |
| `getResearchStatus(researchId)` | Получить статус исследования |
| `getResearchReport(researchId)` | Получить отчёт об исследовании |

#### Потребляемый API

| Модуль | Методы | Назначение |
|--------|--------|-----------|
| **Graph** | `getNode()`, `getDependencies()`, `getModuleStructure()`, `findPaths()`, `queryGraph()` | Структурные вопросы: "какие классы используют X?" |
| **Knowledge** | `searchSemantic()`, `searchByEntity()`, `getRelatedEntries()` | Поиск ADR, best practices, истории |
| **Workspace** | `readFile()`, `gitLog()`, `gitBlame()`, `gitDiff()`, `searchFiles()` | Доступ к файлам и Git |
| **Provider System** | `search(query)`, `completion(prompt)` | Внешний поиск, LLM-вопросы |

#### Публикуемые события

| Событие | Назначение |
|---------|-----------|
| `ResearchStarted` | Исследование началось |
| `ResearchCompleted` | Исследование завершено, Research Report готов |
| `ResearchQuestionGenerated` | Сформулирован исследовательский вопрос |

#### Подписки на события

| Событие | Назначение |
|---------|-----------|
| `TaskReceived` | Получение задачи для исследования |

---

### 4.6 Impact Analysis Engine

#### Назначение

Анализ последствий предполагаемых изменений: определение зоны влияния, оценка рисков, обнаружение конфликтов, прогноз сложности.

#### Предоставляемый API

| Метод | Описание |
|-------|----------|
| `analyzeImpact(researchReport)` | Запустить анализ влияния на основе Research Report |
| `getImpactReport(analysisId)` | Получить Impact Report |
| `checkConflicts(taskId)` | Проверить конфликты с активными задачами |
| `predictComplexity(affectedNodes[])` | Оценить сложность изменения |
| `getAffectedTests(nodeIds[])` | Найти затронутые тесты |

#### Потребляемый API

| Модуль | Методы | Назначение |
|--------|--------|-----------|
| **Graph** | `getAffectedSubgraph()`, `getDependents()`, `findCycles()`, `findPaths()` | Траверс графа для определения зоны влияния |
| **Knowledge** | `searchByEntity()`, `searchSemantic()` | История изменений, корреляция с прошлыми Impact Reports |

#### Публикуемые события

| Событие | Назначение |
|---------|-----------|
| `ImpactAnalysisStarted` | Анализ влияния начался |
| `ImpactAnalysisCompleted` | Impact Report готов |
| `ConflictDetected` | Обнаружен конфликт с активной задачей |

#### Подписки на события

| Событие | Назначение |
|---------|-----------|
| `ResearchCompleted` | Получение Research Report для анализа |

---

### 4.7 Context Builder

#### Назначение

Сборка контекстного пакета для LLM: приём Research Report и Impact Report, приоритезация информации, извлечение содержимого файлов, форматирование структурированного промпта.

#### Предоставляемый API

| Метод | Описание |
|-------|----------|
| `buildContext(researchReport, impactReport)` | Собрать контекстный пакет |
| `getContextPackage(contextId)` | Получить собранный пакет |
| `estimateTokens(contextRequest)` | Оценить размер контекста в токенах |
| `validateContext(content)` | Проверить контекст на переполнение |

#### Потребляемый API

| Модуль | Методы | Назначение |
|--------|--------|-----------|
| **Graph** | `queryGraph()`, `getModuleStructure()`, `getDependencies()` | Структурный контекст для включения в промпт |
| **Knowledge** | `searchSemantic()`, `getEntry()` | Релевантные ADR и best practices |
| **Workspace** | `readFile()` | Чтение содержимого файлов для включения в контекст |

#### Публикуемые события

| Событие | Назначение |
|---------|-----------|
| `ContextBuilt` | Контекстный пакет собран |
| `ContextWindowOverflow` | Контекст превышает лимиты окна модели |

#### Подписки на события

| Событие | Назначение |
|---------|-----------|
| `ResearchCompleted` | Получение Research Report |
| `ImpactAnalysisCompleted` | Получение Impact Report |

---

### 4.8 Planner

#### Назначение

Центральный модуль принятия инженерных решений: декомпозиция задачи на атомарные шаги, построение DAG с зависимостями, определение критериев приёмки, оценка рисков, итеративная корректировка плана.

#### Предоставляемый API

| Метод | Описание |
|-------|----------|
| `plan(userIntent, researchReport, impactReport, contextPackage)` | Создать Execution Plan |
| `replan(executionReport, currentPlan)` | Скорректировать план на основе результатов выполнения |
| `getPlan(planId)` | Получить план |
| `getPlanVersion(planId, version)` | Получить версию плана |
| `validatePlan(plan)` | Валидировать план на структурную целостность |
| `approvePlan(planId)` | Утвердить план (после human approval) |

#### Потребляемый API

| Модуль | Методы | Назначение |
|--------|--------|-----------|
| **Graph** | `getAffectedSubgraph()`, `getDependencies()`, `getModuleStructure()` | Структурные ограничения для построения DAG |
| **Knowledge** | `searchSemantic()`, `searchByEntity()` | Исторические планы, извлечённые уроки |
| **Provider System** | `completion(prompt)` | LLM для генерации и анализа плана |

#### Публикуемые события

| Событие | Назначение |
|---------|-----------|
| `ExecutionPlanned` | Execution Plan сформирован |
| `PlanUpdated` | План скорректирован (replan) |
| `ApprovalRequired` | План требует human approval |

#### Подписки на события

| Событие | Назначение |
|---------|-----------|
| `ResearchCompleted` | Получение Research Report |
| `ImpactAnalysisCompleted` | Получение Impact Report |
| `ContextBuilt` | Получение Context Package |
| `StepCompleted`, `StepFailed` | Обратная связь для replanning |

---

### 4.9 Execution Engine

#### Назначение

Исполнение плана: выполнение шагов (Tool Invocation, AI Tasks), валидация результатов, обработка ошибок и retry, управление чекпоинтами и роллбеками.

#### Предоставляемый API

| Метод | Описание |
|-------|----------|
| `execute(plan: ExecutionPlan, context: ExecutionContext)` | Запустить выполнение плана |
| `getExecutionStatus(executionId)` | Получить статус выполнения |
| `getStepResult(executionId, stepId)` | Получить результат шага |
| `retryStep(executionId, stepId)` | Повторить выполнение шага |
| `abort(executionId)` | Прервать выполнение |

#### Потребляемый API

| Модуль | Методы | Назначение |
|--------|--------|-----------|
| **Workspace** | `readFile()`, `writeFile()`, `executeCommand()`, `runTests()`, `createSnapshot()`, `restoreSnapshot()`, `gitCommit()`, `gitCreateBranch()` | Все операции с файловой системой и окружением |
| **Provider System** | `completion(prompt)`, `streamCompletion(prompt)` | LLM-вызовы для AI Tasks |
| **Knowledge** | `storeEntry()` | Сохранение извлечённых уроков |

#### Публикуемые события

| Событие | Назначение |
|---------|-----------|
| `ExecutionStarted` | Выполнение плана началось |
| `StepStarted` | Началось выполнение шага |
| `StepCompleted` | Шаг выполнен успешно |
| `StepFailed` | Шаг завершился ошибкой |
| `StepRolledBack` | Выполнен откат шага |
| `TestsCompleted` | Тестовый прогон завершён |
| `ExecutionFinished` | Все шаги выполнены |
| `ApprovalRequired` | Требуется human approval для шага |

#### Подписки на события

| Событие | Назначение |
|---------|-----------|
| `ExecutionPlanned` | Получение плана для выполнения |

---

### 4.10 Workspace

#### Назначение

Единая среда выполнения: файловая система, Git, Docker, терминал, sandbox, артефакты, снапшоты.

#### Предоставляемый API

**Файловая система:**

| Метод | Описание |
|-------|----------|
| `readFile(path)` | Прочитать файл |
| `writeFile(path, content)` | Записать файл |
| `deleteFile(path)` | Удалить файл |
| `moveFile(source, dest)` | Переместить файл |
| `listDirectory(path)` | Список файлов в директории |
| `searchFiles(pattern)` | Поиск файлов |
| `watchFiles(paths)` | Подписаться на изменения файлов |
| `getProjectStructure()` | Получить дерево проекта |

**Git:**

| Метод | Описание |
|-------|----------|
| `gitStatus()` | Статус репозитория |
| `gitLog(filters?)` | История коммитов |
| `gitBlame(filePath)` | Авторство строк |
| `gitDiff(from, to)` | Разница между состояниями |
| `gitCreateBranch(name)` | Создать ветку |
| `gitCommit(message)` | Создать коммит |
| `gitPush(branch)` | Отправить изменения |

**Окружение:**

| Метод | Описание |
|-------|----------|
| `executeCommand(cmd, opts?)` | Выполнить shell-команду |
| `runTests(framework, scope)` | Запустить тесты |
| `dockerBuild(image)` | Собрать Docker-образ |
| `dockerRun(container, image)` | Запустить контейнер |
| `createSandbox()` | Создать sandbox-окружение |
| `destroySandbox(sandboxId)` | Уничтожить sandbox |

**Снапшоты и артефакты:**

| Метод | Описание |
|-------|----------|
| `createSnapshot()` | Создать снапшот workspace |
| `restoreSnapshot(snapshotId)` | Восстановить из снапшота |
| `storeArtifact(key, data)` | Сохранить артефакт |
| `getArtifact(key)` | Получить артефакт |
| `listArtifacts()` | Список артефактов |

#### Потребляемый API

Workspace не зависит от API других модулей. Он работает напрямую с файловой системой, Git, Docker.

#### Публикуемые события

| Событие | Назначение |
|---------|-----------|
| `FileChanged` | Файл создан, изменён или удалён |
| `SnapshotCreated` | Создан снапшот |
| `TestsCompleted` | Тестовый прогон завершён |
| `SecurityAlert` | Потенциально опасная операция заблокирована |

#### Подписки на события

Workspace не подписывается на события других модулей. Он является чистым исполнителем команд.

---

### 4.11 Provider System

#### Назначение

Слой абстракции над внешними сервисами: LLM-провайдеры, embedding-провайдеры, поисковые системы, vector store.

#### Предоставляемый API

| Метод | Описание |
|-------|----------|
| `completion(prompt, model?, opts?)` | Выполнить LLM completion |
| `streamCompletion(prompt, model?, opts?)` | Потоковый LLM completion |
| `getEmbedding(text, model?)` | Получить embedding для текста |
| `getEmbeddings(texts[], model?)` | Получить embeddings для массива текстов |
| `search(query, opts?)` | Внешний поиск |
| `vectorSearch(vector, collection, topK)` | Поиск по векторному хранилищу |
| `vectorStore(vectors[], collection)` | Сохранить векторы |
| `listModels(type?)` | Список доступных моделей |
| `getProviderStatus()` | Статус провайдеров |

#### Потребляемый API

Provider System не зависит от API других модулей. Чистый адаптер.

#### Публикуемые события

| Событие | Назначение |
|---------|-----------|
| `ProviderRateLimited` | Достигнут лимит запросов |
| `ProviderUnavailable` | Провайдер недоступен |
| `ProviderRecovered` | Провайдер восстановился |

#### Подписки на события

Provider System не подписывается на события других модулей.

---

## 5. Карта артефактов

### 5.1 Жизненный цикл артефактов

```
UserIntent               — создаётся API Gateway при получении задачи
    │
    ▼
Research Report          — создаётся Research Engine, сохраняется в Knowledge
    │
    ▼
Impact Report            — создаётся Impact Analysis Engine на основе Research Report
    │
    ▼
Context Package          — создаётся Context Builder на основе Research + Impact Reports
    │
    ▼
Execution Plan           — создаётся Planner на основе всех вышестоящих артефактов
    │
    ▼
Execution Report         — создаётся Execution Engine по завершении выполнения
    │
    ▼
Knowledge Update         — создаётся Execution Engine, сохраняется в Knowledge
Graph Update             — создаётся Indexer (структурные изменения) / Execution Engine (новые артефакты)
```

### 5.2 Структура артефактов

#### UserIntent

| Поле | Тип | Описание |
|------|-----|----------|
| `taskId` | UUID | Уникальный идентификатор задачи |
| `description` | string | Описание задачи на естественном языке |
| `constraints` | string[] | Ограничения (язык, фреймворк, сроки) |
| `priority` | enum | Приоритет задачи |
| `scope` | ScopeFilter | Ограничение области (файлы, модули) |
| `context` | object | Дополнительный контекст от пользователя |
| `createdAt` | DateTime | Время создания |
| `createdBy` | UserId | Идентификатор пользователя |

#### Research Report

| Поле | Тип | Описание |
|------|-----|----------|
| `researchId` | UUID | Уникальный идентификатор исследования |
| `taskId` | UUID | Ссылка на задачу |
| `questions` | ResearchQuestion[] | Исследовательские вопросы и ответы |
| `foundEntities` | EntityRef[] | Найденные релевантные сущности (ссылки на Graph) |
| `relevantADRs` | ADRRef[] | Релевантные архитектурные решения |
| `history` | ChangeHistory[] | История изменений затронутых компонентов |
| `recommendations` | Recommendation[] | Рекомендации (best practices, паттерны) |
| `warnings` | Warning[] | Предупреждения о проблемах |
| `completeness` | float | Оценка полноты (0.0 — 1.0) |
| `unansweredQuestions` | string[] | Вопросы без ответа |
| `sourceReferences` | SourceRef[] | Ссылки на все источники информации |
| `crossReferences` | CrossRef[] | Перекрёстные связи между артефактами |

#### Impact Report

| Поле | Тип | Описание |
|------|-----|----------|
| `impactId` | UUID | Уникальный идентификатор |
| `researchId` | UUID | Ссылка на Research Report |
| `affectedNodes` | AffectedNode[] | Затронутые узлы графа с уровнями риска |
| `riskLevels` | RiskLevelMap | Карта уровней риска |
| `transitiveClosure` | NodeId[] | Полное транзитивное замыкание зависимостей |
| `complexityEstimate` | ComplexityEstimate | Оценка сложности задачи |
| `conflicts` | Conflict[] | Конфликтующие активные задачи |
| `recommendations` | Recommendation[] | Рекомендации по снижению риска |
| `affectedModules` | ModuleRef[] | Затронутые модули |
| `affectedTests` | TestRef[] | Затронутые тесты |

#### Context Package

| Поле | Тип | Описание |
|------|-----|----------|
| `contextId` | UUID | Уникальный идентификатор |
| `systemBlock` | PromptBlock | Системные инструкции, принципы, правила |
| `projectBlock` | PromptBlock | Архитектура, структура, ключевые абстракции |
| `operationalBlock` | PromptBlock | Содержимое затронутых файлов, сигнатуры |
| `knowledgeBlock` | PromptBlock | Релевантные ADR, best practices, примеры |
| `taskBlock` | PromptBlock | Описание задачи |
| `constraintsBlock` | PromptBlock | Ограничения и предупреждения |
| `tokenUsage` | TokenEstimate | Использованный объём токенов |
| `priorityMap` | PriorityMap | Карта приоритетов информации |

#### Execution Plan

| Поле | Тип | Описание |
|------|-----|----------|
| `planId` | UUID | Уникальный идентификатор |
| `planVersion` | integer | Версия плана |
| `taskId` | UUID | Ссылка на задачу |
| `steps` | ExecutionStep[] | Упорядоченный список шагов |
| `stepDependencies` | DependencyMap | DAG зависимостей (ребро `PRECEDES`) |
| `parallelGroups` | ParallelGroup[] | Группы параллельных шагов |
| `rollbackPlan` | RollbackPlan | План отката для каждого шага |
| `approvalPoints` | ApprovalPoint[] | Точки human approval |
| `validationRules` | ValidationRule[] | Правила валидации для шагов |
| `agentAssignments` | AgentAssignment[] | Назначение агентов на шаги |
| `toolBindings` | ToolBinding[] | Привязка инструментов к шагам |
| `retryPolicies` | RetryPolicy[] | Политики повторных попыток |
| `timeouts` | TimeoutConfig[] | Таймауты |
| `safetyBounds` | SafetyBounds | Границы безопасности |

#### Execution Report

| Поле | Тип | Описание |
|------|-----|----------|
| `executionId` | UUID | Уникальный идентификатор выполнения |
| `planId` | UUID | Ссылка на план |
| `status` | enum | `completed`, `partially_completed`, `failed`, `aborted` |
| `stepResults` | StepResult[] | Результаты выполнения каждого шага |
| `executionTrace` | TraceEntry[] | Полная трасса выполнения |
| `toolCalls` | ToolCallResult[] | Все tool calls с результатами |
| `aiTaskResults` | AITaskResult[] | Результаты AI-задач |
| `events` | EventRef[] | Опубликованные события |
| `errors` | ExecutionError[] | Ошибки |
| `rollbacks` | RollbackResult[] | Выполненные откаты |
| `approvals` | ApprovalResult[] | Пройденные точки human approval |
| `artifacts` | ArtifactRef[] | Созданные артефакты |
| `metrics` | ExecutionMetrics | Метрики выполнения |
| `knowledgeUpdates` | KnowledgeUpdateRef[] | Обновления Knowledge |

---

## 6. Карта событий

### 6.1 Матрица публикации-подписки

Полная матрица: **строки — издатели (producers), столбцы — подписчики (subscribers)**.

| Событие / Producer → Subscriber | API GW | Indexer | Graph | Knowledge | Research | Impact | Context | Planner | Execution | Workspace | Provider |
|:---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **API Gateway** | | | | | | | | | | | |
| `TaskReceived` | — | | | | ✓ | | | | | | |
| **Indexer** | | | | | | | | | | | |
| `ProjectIndexed` | | — | | | | | | | | | |
| `GraphUpdateRequested` | | | ✓ | | | | | | | | |
| **Graph** | | | | | | | | | | | |
| `GraphUpdated` | | ✓ | — | | | | | | | | |
| `GraphVersionCreated` | | | — | | | | | | | | |
| `ArchitectureViolation` | | | — | | | | | | | | |
| **Knowledge** | | | | | | | | | | | |
| `KnowledgeUpdated` | | | | — | | | | | | | |
| **Research Engine** | | | | | | | | | | | |
| `ResearchStarted` | ✓ | | | | — | | | | | | |
| `ResearchCompleted` | | | | ✓ | — | ✓ | ✓ | ✓ | | | |
| **Impact Analysis Engine** | | | | | | | | | | | |
| `ImpactAnalysisStarted` | | | | | | — | | | | | |
| `ImpactAnalysisCompleted` | | | | | | — | ✓ | ✓ | | | |
| `ConflictDetected` | ✓ | | | | | — | | | | | |
| **Context Builder** | | | | | | | | | | | |
| `ContextBuilt` | | | | | | | — | ✓ | | | |
| `ContextWindowOverflow` | ✓ | | | | | | — | | | | |
| **Planner** | | | | | | | | | | | |
| `ExecutionPlanned` | | | | | | | | — | ✓ | | |
| `PlanUpdated` | | | | | | | | — | ✓ | | |
| `ApprovalRequired` | ✓ | | | | | | | — | | | |
| **Execution Engine** | | | | | | | | | | | |
| `ExecutionStarted` | ✓ | | | | | | | | — | | |
| `StepStarted` | ✓ | | | | | | | ✓ | — | | |
| `StepCompleted` | ✓ | | | ✓ | | | | ✓ | — | | |
| `StepFailed` | ✓ | | | | | | | ✓ | — | | |
| `StepRolledBack` | | | | | | | | | — | | |
| `ExecutionFinished` | ✓ | | | ✓ | | | | | — | | |
| `TestsCompleted` | | | | | | | | | — | | |
| **Workspace** | | | | | | | | | | | |
| `FileChanged` | | ✓ | | | | | | | | — | |
| `SnapshotCreated` | | | | | | | | | ✓ | — | |
| `SecurityAlert` | ✓ | | | | | | | | | — | |
| **Provider System** | | | | | | | | | | | |
| `ProviderRateLimited` | ✓ | | | | | | | | | | — |
| `ProviderUnavailable` | ✓ | | | | | | | | | | — |

### 6.2 Потоки событий для ключевых сценариев

#### Сценарий 1: Полный цикл обработки задачи

```
TaskReceived
    │
    ▼
ResearchStarted → ResearchCompleted ──► KnowledgeUpdated
    │                                       │
    ▼                                       ▼
ImpactAnalysisStarted → ImpactAnalysisCompleted
                            │
                            ▼
                       ContextBuilt
                            │
                            ▼
                      ExecutionPlanned
                            │
                            ▼
                      ExecutionStarted
                            │
                    ┌───────┴───────┐
                    ▼               ▼
               StepStarted      StepStarted
                    │               │
                    ▼               ▼
              StepCompleted    StepCompleted
                    │               │
                    └───────┬───────┘
                            │
                            ▼
                     ExecutionFinished ──► GraphUpdated ──► KnowledgeUpdated
                            │
                            ▼
                      TaskCompleted
```

#### Сценарий 2: Обнаружение конфликта и replanning

```
ResearchCompleted → ImpactAnalysisCompleted
                        │
                        ▼
                  ConflictDetected ──► API Gateway (уведомление пользователя)
                        │
                        ▼
                  ExecutionPlanned (с учётом конфликта)
                        │
                        ▼
                  ExecutionStarted → StepCompleted → StepFailed
                                                        │
                                                        ▼
                                                  PlanUpdated (replan)
                                                        │
                                                        ▼
                                                  ExecutionStarted (продолжение)
```

---

## 7. Потоки данных между модулями

### 7.1 Главный поток обработки задачи

```
User
 │
 │ UserIntent (REST/CLI)
 ▼
API Gateway ─── TaskReceived ─── Event Bus
                                    │
                    ┌───────────────┼───────────────┐
                    ▼               ▼               ▼
              Research Engine   Impact Analysis   Context Builder
              ┌───┬───┬───┐         │                 │
              │ G │ K │ W │         │                 │
              └───┴───┴───┘         │                 │
                    │               │                 │
                    ▼               ▼                 │
              Research Report  Impact Report          │
                    │               │                 │
                    └───────┬───────┘                 │
                            │                         │
                            └─────────┬───────────────┘
                                      │
                                      ▼
                                Context Builder ─── Graph, Knowledge, Workspace
                                      │
                                      ▼
                                Context Package
                                      │
                                      ▼
                                   Planner ─── Graph, Knowledge, Provider
                                      │
                                      ▼
                                Execution Plan
                                      │
                                      ▼
                              Execution Engine ─── Workspace, Provider
                                      │
                                      ▼
                              Execution Report
                                      │
                                      ▼
                              Knowledge Update + Graph Update

Сокращения: G = Graph, K = Knowledge, W = Workspace, P = Provider System
```

### 7.2 Поток индексации

```
File System
    │
    │ FileChanged (событие от Workspace)
    ▼
Indexer
    │
    │ 1. Сканирование файлов (API Workspace: readFile)
    │ 2. Парсинг в AST
    │ 3. Извлечение символов и отношений
    │
    ▼
GraphUpdateRequested (событие в Event Bus, содержит GraphUpdatePackage)
    │
    ▼
Graph
    │ 1. Identity Resolution (сопоставление identities)
    │ 2. Применение node changes (добавление, обновление, удаление)
    │ 3. Применение edge changes
    │ 4. Consistency Validation
    │ 5. Фиксация graph version
    │
    ▼
GraphUpdated (событие)
    │
    ▼
Indexer (подтверждение применения)
```

### 7.3 Поток обновления знаний

```
Execution Engine
    │
    │ StepCompleted / ExecutionFinished
    │ (с Execution Report и извлечёнными уроками)
    ▼
Knowledge
    │
    │ 1. Извлечение KnowledgeEntry из отчёта
    │ 2. Генерация embeddings (через Provider System)
    │ 3. Сохранение в Vector Store
    │ 4. Сохранение метаданных в PostgreSQL
    │ 5. Связывание с Graph: RELATES_TO edge
    │
    ▼
KnowledgeUpdated (событие)
```

### 7.4 Поток перепланирования

```
Execution Engine ── StepFailed ──► Event Bus
                                      │
                                      ▼
                                   Planner
                                      │
                                      │ 1. Анализ причины сбоя
                                      │ 2. Запрос дополнительного контекста
                                      │    (API Graph, Knowledge, Provider)
                                      │ 3. Корректировка оставшихся шагов
                                      │ 4. Переоценка рисков
                                      │ 5. Генерация нового плана
                                      │
                                      ▼
                              PlanUpdated (событие)
                                      │
                                      ▼
                              Execution Engine (продолжение с новым планом)
```

---

## 8. Интерфейсы хранилищ

### 8.1 PostgreSQL

**Назначение:** реляционная база данных для структурированных операционных данных.

**Модули-пользователи:**

| Модуль | Таблицы/данные |
|--------|---------------|
| **API Gateway** | `tasks`, `users`, `sessions`, `task_status` |
| **Knowledge** | `knowledge_entries` (метаданные), `adr`, `knowledge_types`, `knowledge_versions` |
| **Impact Analysis** | `impact_reports`, `conflicts` |
| **Planner** | `execution_plans`, `steps`, `plan_versions` |
| **Execution Engine** | `executions`, `step_results`, `tool_calls`, `ai_tasks`, `execution_metrics` |
| **Provider System** | `provider_configs`, `api_keys`, `usage_logs` |
| **Workspace** | `snapshots`, `artifacts_metadata`, `sandboxes` |

**Правило:** каждый модуль владеет своими таблицами. Прямой доступ к таблицам другого модуля запрещён — только через API модуля.

### 8.2 Neo4j

**Назначение:** графовая база данных для структурной модели кода.

**Модули-пользователи:**

| Модуль | Операции |
|--------|---------|
| **Graph** | Единственный владелец. Все операции записи и чтения. |
| **Indexer** | Не имеет прямого доступа. Отправляет `GraphUpdatePackage` через API Graph. |
| **Research Engine** | Читает через API Graph: `getNode()`, `getDependencies()`, `queryGraph()`. |
| **Context Builder** | Читает через API Graph: `queryGraph()`, `getModuleStructure()`. |
| **Planner** | Читает через API Graph: `getAffectedSubgraph()`, `getDependencies()`. |

**Правило:** только Graph имеет прямой доступ к Neo4j. Все остальные модули используют Graph API.

### 8.3 Redis

**Назначение:** кеширование, Event Bus (Pub/Sub + Streams), очереди.

**Модули-пользователи:**

| Модуль | Использование |
|--------|--------------|
| **Все модули** | Event Bus: публикация и подписка на события |
| **Graph** | Кеш: hot nodes, hot subgraphs, query results |
| **Knowledge** | Кеш: результаты семантического поиска |
| **Context Builder** | Кеш: системные блоки контекста |
| **Provider System** | Rate limiting, кеш ответов LLM (опционально) |
| **Execution Engine** | Состояние выполнения (state machine), чекпоинты |
| **Workspace** | Статусы sandbox-контейнеров |

### 8.4 Vector Store

**Назначение:** хранение embeddings для семантического поиска (pgvector или Qdrant).

**Модули-пользователи:**

| Модуль | Операции |
|--------|---------|
| **Knowledge** | Единственный владелец. Сохранение и поиск embeddings для knowledge entries. |
| **Provider System** | Генерация embeddings (через API: `getEmbedding()`). |

**Правило:** только Knowledge имеет прямой доступ к Vector Store. Остальные модули ищут знания через Knowledge API.

### 8.5 File Storage

**Назначение:** файловая система проекта, снапшоты, артефакты.

**Модули-пользователи:**

| Модуль | Операции |
|--------|---------|
| **Workspace** | Единственный владелец. Все операции с файлами, снапшотами, артефактами. |
| **Indexer** | Читает файлы проекта через Workspace API. |
| **Research Engine** | Читает файлы и историю Git через Workspace API. |
| **Context Builder** | Читает файлы через Workspace API. |
| **Execution Engine** | Пишет и читает файлы, создаёт коммиты через Workspace API. |

**Правило:** только Workspace имеет прямой доступ к файловой системе. Остальные модули используют Workspace API.

---

## 9. Правила взаимодействия

### 9.1 Разрешённые и запрещённые связи

#### Разрешённые типы связей

1. **Прямой вызов API:** модуль A может вызывать методы модуля B, если это явно указано в разделе 4 данного документа.
2. **Публикация событий:** модуль может публиковать события, на которые подписываются другие модули.
3. **Подписка на события:** модуль может подписываться на события других модулей.
4. **Доступ к хранилищу:** модуль имеет доступ только к тем хранилищам, которые указаны в разделе 8.

#### Запрещённые типы связей

1. **Прямой доступ к таблицам другого модуля.** Если модулю A нужны данные из таблиц модуля B, он должен использовать API модуля B.
2. **Прямой доступ к файловой системе.** Только Workspace имеет прямой доступ. Остальные — через Workspace API.
3. **Прямой доступ к Neo4j.** Только Graph имеет прямой доступ. Остальные — через Graph API.
4. **Прямой доступ к Vector Store.** Только Knowledge имеет прямой доступ. Остальные — через Knowledge API.
5. **Циклические зависимости API.** Если модуль A вызывает API модуля B, модуль B не может вызывать API модуля A.
6. **Пропуск модуля в цепочке.** Context Builder не может быть вызван до Research Engine. Planner не может быть вызван до Context Builder.

#### Допустимые цепочки вызовов (call chains)

```
Допустимо:
  Research Engine → Graph API → Neo4j
  Research Engine → Knowledge API → Vector Store
  Context Builder → Graph API → Neo4j
  Execution Engine → Workspace API → File System

Запрещено:
  Research Engine → Neo4j (напрямую)
  Context Builder → File System (напрямую)
  Execution Engine → Neo4j (напрямую)
```

### 9.2 Правила вызова API

1. **Все API-вызовы асинхронны.** Ни один модуль не блокирует выполнение другого модуля синхронным вызовом.
2. **Таймауты.** Каждый API-вызов имеет таймаут. При превышении таймаута вызывающий модуль должен обработать ошибку (fallback, retry, graceful degradation).
3. **Версионирование API.** Каждый API имеет версию. При изменении контракта создаётся новая версия; старая поддерживается в течение переходного периода.
4. **Аутентификация.** Все межмодульные вызовы аутентифицированы (внутренний токен).
5. **Rate Limiting.** Каждый модуль имеет лимит на количество запросов к API другого модуля.
6. **Circuit Breaker.** При повторяющихся сбоях API-вызовов активируется Circuit Breaker, временно блокирующий вызовы к проблемному модулю.

### 9.3 Правила публикации и подписки на события

1. **События иммутабельны.** После публикации событие не может быть изменено.
2. **События версионированы.** Каждое событие имеет схему и версию. Подписчики должны поддерживать N-1 версию.
3. **Идемпотентность.** Подписчик должен корректно обрабатывать повторную доставку одного и того же события (deduplication по eventId).
4. **Порядок доставки.** События в рамках одной задачи доставляются в порядке публикации (ordering key = taskId).
5. **Dead Letter Queue.** События, которые не удалось обработать после исчерпания retry, помещаются в DLQ для ручного анализа.
6. **Запрет циклических событий.** Модуль A не должен публиковать событие, которое приведёт к публикации события модулем B, которое приведёт к вызову модуля A, который опубликует то же событие (event loop detection).

---

## 10. Границы транзакций и консистентности

### Агрегаты и границы транзакций

| Агрегат | Владелец | Хранилище | Граница транзакции |
|---------|---------|-----------|-------------------|
| **Task** | API Gateway | PostgreSQL | Вся задача (статус, метаданные) — одна транзакция |
| **Graph** | Graph | Neo4j | Один `GraphUpdatePackage` — одна транзакция |
| **Knowledge Entry** | Knowledge | PostgreSQL + Vector Store | Метаданные + embedding — атомарно |
| **Execution Plan** | Planner | PostgreSQL | План + шаги — одна транзакция |
| **Execution** | Execution Engine | PostgreSQL + Redis | Состояние шага — одна транзакция |
| **Workspace Snapshot** | Workspace | File Storage + PostgreSQL | Снапшот + метаданные — атомарно |

### Стратегии консистентности между модулями

1. **Eventual Consistency.** Состояние между модулями — eventually consistent. Например, Knowledge Updated может произойти через некоторое время после Research Completed.
2. **Compensating Actions.** При сбое в цепочке (например, Execution Failed после того, как Knowledge был частично обновлён) выполняются компенсирующие действия (откат записей Knowledge).
3. **Saga Pattern.** Длинные цепочки операций (Task → Research → Impact → Context → Plan → Execution) реализованы как Saga с компенсирующими действиями на каждом шаге.

---

## 11. Observability и мониторинг взаимодействий

### Что мониторится

1. **Latency каждого межмодульного вызова.** P50, P95, P99.
2. **Количество событий в Event Bus.** По типам, по модулям-источникам.
3. **Размер артефактов.** Research Report, Impact Report, Context Package, Execution Plan — мониторинг размера для предотвращения переполнения контекстного окна.
4. **Количество ошибок.** API errors, event processing failures, DLQ size.
5. **Состояние Circuit Breaker-ов.** Открыт/закрыт/полуоткрыт для каждой пары модулей.
6. **Использование хранилищ.** Количество запросов к PostgreSQL, Neo4j, Redis, Vector Store, File Storage.

### Трассировка (Distributed Tracing)

Каждый межмодульный вызов и каждое событие содержит `traceId` и `spanId`, связывающие всю цепочку обработки задачи. Это позволяет:

- Восстановить полный путь задачи через все модули.
- Определить узкое место в цепочке.
- Диагностировать сбои: на каком модуле и почему произошла ошибка.

### Алертинг

| Условие | Серьёзность | Действие |
|---------|------------|----------|
| Circuit Breaker открыт > 30 сек | Critical | Немедленное уведомление, автоматический failover |
| DLQ > 10 событий | High | Уведомление, ручной анализ |
| P95 latency API > 5 сек | Medium | Уведомление, анализ узкого места |
| Context Window Overflow | Medium | Уведомление, оптимизация контекста |
| Конфликт активных задач | Low | Информационное уведомление |

---

## Приложение A: Сводная таблица всех API-зависимостей

| Модуль | Зависит от API модулей |
|--------|----------------------|
| **API Gateway** | — (только Event Bus) |
| **Indexer** | Graph, Workspace |
| **Graph** | — (только Event Bus: подписка на Indexer) |
| **Knowledge** | — (только Event Bus: подписка на Research, Execution) |
| **Research Engine** | Graph, Knowledge, Workspace, Provider System |
| **Impact Analysis Engine** | Graph, Knowledge |
| **Context Builder** | Graph, Knowledge, Workspace |
| **Planner** | Graph, Knowledge, Provider System |
| **Execution Engine** | Workspace, Provider System, Knowledge |
| **Workspace** | — (прямой доступ к FS, Git, Docker) |
| **Provider System** | — (чистый адаптер) |

## Приложение B: Сводная таблица подписок на события

| Модуль | Подписывается на события |
|--------|------------------------|
| **API Gateway** | TaskCompleted, StepStarted, StepCompleted, StepFailed, ExecutionPlanned, ResearchCompleted, ApprovalRequired, ConflictDetected, ContextWindowOverflow, SecurityAlert, ProviderRateLimited, ProviderUnavailable |
| **Indexer** | FileChanged, ProjectSnapshotRestored |
| **Graph** | GraphUpdateRequested |
| **Knowledge** | ResearchCompleted, StepCompleted, ExecutionFinished |
| **Research Engine** | TaskReceived |
| **Impact Analysis Engine** | ResearchCompleted |
| **Context Builder** | ResearchCompleted, ImpactAnalysisCompleted |
| **Planner** | ResearchCompleted, ImpactAnalysisCompleted, ContextBuilt, StepCompleted, StepFailed |
| **Execution Engine** | ExecutionPlanned, PlanUpdated |
| **Workspace** | — (не подписывается) |
| **Provider System** | — (не подписывается) |

## Приложение C: Правила внесения изменений в Dependency Map

1. Любое изменение связей между модулями (новый API-вызов, новое событие, новая подписка) должно быть отражено в данном документе.
2. Изменение должно быть оформлено как ADR (Architecture Decision Record) и сохранено в Knowledge.
3. При добавлении нового модуля необходимо:
   - Добавить его в раздел 2 (Карта модулей).
   - Обновить раздел 3 (Матрица зависимостей).
   - Добавить раздел в 4 (Контракты модулей).
   - Обновить раздел 6 (Карта событий).
   - Обновить раздел 8 (Интерфейсы хранилищ).
   - Проверить раздел 9 (Правила) на отсутствие нарушений.
4. Запрещено добавление связей, которые нарушают правила раздела 9.1.