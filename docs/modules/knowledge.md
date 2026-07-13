# Knowledge — Долговременная Инженерная Память Системы

**Статус:** Спецификация
**Автор:** Архитектурный Комитет
**Дата:** 2026-07-08
**Версия:** 1.0

---

## Оглавление

1. [Назначение](#1-назначение)
2. [Ответственность](#2-ответственность)
3. [Входные данные](#3-входные-данные)
4. [Выходные данные](#4-выходные-данные)
5. [Архитектура модуля](#5-архитектура-модуля)
6. [Модель Knowledge](#6-модель-knowledge)
7. [Типы знаний](#7-типы-знаний)
8. [Knowledge Ingestion Pipeline](#8-knowledge-ingestion-pipeline)
9. [Knowledge Extraction Rules](#9-knowledge-extraction-rules)
10. [Связь с Graph](#10-связь-с-graph)
11. [Связь с Artifacts](#11-связь-с-artifacts)
12. [Versioning](#12-versioning)
13. [Freshness и Staleness](#13-freshness-и-staleness)
14. [Retrieval Model](#14-retrieval-model)
15. [Search and Ranking](#15-search-and-ranking)
16. [Knowledge Quality](#16-knowledge-quality)
17. [Conflict Resolution](#17-conflict-resolution)
18. [Knowledge Governance](#18-knowledge-governance)
19. [Diagnostics and Statistics](#19-diagnostics-and-statistics)
20. [Производительность](#20-производительность)
21. [Отказоустойчивость](#21-отказоустойчивость)
22. [Ограничения](#22-ограничения)
23. [Будущее развитие](#23-будущее-развитие)
24. [Чёткое разделение Knowledge и Memory](#24-чёткое-разделение-knowledge-и-memory)
25. [Заключение](#25-заключение)

---

## 1. Назначение

### 1.1 Что такое Knowledge

Knowledge — это **долговременная инженерная память системы Client**. Это канонический модуль накопления, версионирования, поиска, актуализации и переиспользования инженерных знаний о проекте.

Knowledge не является простым хранилищем документов. Это система, которая:
- **Классифицирует** входящую информацию по типам инженерных знаний.
- **Извлекает** из артефактов только то, что является ценным инженерным выводом.
- **Версионирует** знания, отслеживая их эволюцию.
- **Связывает** знания с графом кода (Graph), артефактами, задачами и решениями.
- **Отслеживает актуальность** знаний по мере эволюции кодовой базы.
- **Предоставляет retrieval API** для downstream-модулей (Research, Impact Analysis, Context Builder, Planner).

### 1.2 Почему Knowledge существует

Без Knowledge система Client обречена на **амнезию**: каждая задача решается с нуля, каждый Research не использует результаты предыдущих исследований, каждый Planner не знает о ранее принятых архитектурных решениях, каждый Developer Agent повторяет ошибки, которые уже были совершены и задокументированы.

Knowledge существует, потому что:
1. **Инженерный интеллект накапливается.** Результат Research по задаче A содержит выводы, которые критичны для задачи B, выполняемой через месяц.
2. **Архитектурные решения должны быть зафиксированы и доступны.** ADR, принятый сегодня, определяет ограничения для всех будущих задач.
3. **Best practices извлекаются из опыта.** Успешный паттерн, применённый в трёх задачах, должен быть формализован и предлагаться автоматически.
4. **Ошибки не должны повторяться.** Если Execution Report содержит lessons learned, они должны быть доступны при планировании аналогичных задач.
5. **Контекстная релевантность.** Knowledge позволяет Context Builder включать в контекст не всё подряд, а только релевантные данному модулю/задаче знания.

### 1.3 Какие задачи решает Knowledge

| Задача | Описание |
|--------|----------|
| **Накопление** | Сохранение инженерных выводов из всех артефактов системы |
| **Версионирование** | Отслеживание эволюции знаний, связь с версиями графа и коммитами |
| **Связывание** | Построение сети связей знание→граф, знание→артефакт, знание→задача |
| **Поиск** | Полнотекстовый, семантический и гибридный поиск по всем знаниям |
| **Актуализация** | Отслеживание устаревания знаний при изменении кодовой базы |
| **Переиспользование** | Предоставление релевантных знаний downstream-модулям |
| **Управление качеством** | Оценка confidence, выявление конфликтов, защита от шума |

### 1.4 Чем Knowledge отличается от Graph

**Graph — это представление кода.** Graph хранит Node (классы, методы, файлы, модули) и Edge (CALLS, EXTENDS, DEPENDS_ON, IMPORTS). Graph отвечает на вопрос **"как устроен код"**.

**Knowledge — это накопленный опыт о коде.** Knowledge хранит ADR, best practices, результаты исследований, lessons learned. Knowledge отвечает на вопрос **"что мы знаем о коде и как с ним работать"**.

| Аспект | Graph | Knowledge |
|--------|-------|-----------|
| **Природа данных** | Структурное представление кода | Инженерные выводы и опыт |
| **Источник** | Indexer (автоматически из кода) | Research, Execution, ADR, пользователь |
| **Связь с реальностью** | Прямая: отражает текущий код | Косвенная: отражает выводы о коде |
| **Частота обновления** | При каждом изменении файла | При завершении задач, Research, ADR |
| **Устаревание** | Сразу при изменении кода | Постепенное, требует обнаружения |
| **Пример содержимого** | `Class UserController CALLS UserService.createUser()` | `UserController должен валидировать входные данные до вызова UserService` |

**Критическое правило:** Graph не должен хранить Knowledge-контент. Knowledge не должен дублировать структурную информацию Graph. Knowledge Link связывает знание с узлом графа, но не копирует сам узел.

### 1.5 Чем Knowledge отличается от Research

**Research — это оркестратор исследования для конкретной задачи.** Research собирает информацию из Graph, Knowledge, Git, документации и внешних источников для ответа на вопрос "что нужно знать, чтобы решить эту задачу".

**Knowledge — это хранилище результатов прошлых исследований.** Knowledge предоставляет Research исторические Research Reports, ADR, best practices — чтобы Research не начинал с нуля.

| Аспект | Research | Knowledge |
|--------|----------|-----------|
| **Роль** | Активный сборщик информации | Пассивное хранилище опыта |
| **Жизненный цикл** | Существует в рамках задачи | Существует постоянно |
| **Потребляет Knowledge?** | Да, как источник | Нет |
| **Сохраняет в Knowledge?** | Да, Research Report → Knowledge | — |

**Критическое правило:** Knowledge не заменяет Research, а сохраняет и организует его результаты. Research — это процесс, Knowledge — это память о результатах процесса.

### 1.6 Чем Knowledge отличается от Context Builder

**Context Builder — это сборщик контекста для LLM.** Он агрегирует Research Report, Impact Report, Knowledge, Graph-данные и формирует оптимизированный контекст, который помещается в окно модели.

**Knowledge — это один из источников для Context Builder.** Context Builder запрашивает у Knowledge релевантные знания и включает их в контекст.

| Аспект | Context Builder | Knowledge |
|--------|-----------------|-----------|
| **Роль** | Сборщик и оптимизатор контекста | Источник исторических знаний |
| **Что производит** | Context Package (для LLM) | Knowledge Search Results |
| **Куда передаёт** | Planner → Execution Plan | Context Builder, Research, Impact Analysis |

**Критическое правило:** Knowledge не является Context Cache. Context Cache живёт в Redis и оптимизирован под быстрое включение в промпт. Knowledge живёт в PostgreSQL + векторном хранилище и оптимизирован под долговременное хранение и семантический поиск.

### 1.7 Чем Knowledge отличается от будущего Memory

Этот вопрос детально раскрыт в разделе [24. Чёткое разделение Knowledge и Memory](#24-чёткое-разделение-knowledge-и-memory). Кратко:

- **Knowledge** — инженерная, проверяемая, переиспользуемая память проекта: ADR, best practices, research results.
- **Memory** (будущий) — вероятно, будет включать диалоговую историю, пользовательские предпочтения, сессионный контекст, персональные настройки.

---

## 2. Ответственность

### 2.1 Что входит в ответственность Knowledge

| # | Ответственность | Описание |
|---|-----------------|----------|
| 1 | **Ingestion** | Приём и обработка входящих артефактов: Research Reports, Execution Reports, Impact Reports, ADR, User Decisions |
| 2 | **Extraction** | Извлечение knowledge-worthy content из артефактов: findings, conclusions, patterns, lessons learned |
| 3 | **Classification** | Классификация знаний по типам: Architectural, Operational, Historical, Execution, Risk, etc. |
| 4 | **Normalization** | Приведение знаний к единой структуре Knowledge Entry |
| 5 | **Deduplication** | Обнаружение и разрешение дубликатов: merge, supersede или link |
| 6 | **Linking** | Связывание знаний с Graph (Node/Edge), артефактами, задачами, ADR |
| 7 | **Versioning** | Управление версиями знаний: immutable history, lineage, superseded tracking |
| 8 | **Freshness Tracking** | Отслеживание актуальности знаний при изменении кодовой базы |
| 9 | **Staleness Detection** | Реакция на GraphUpdated, NodeDeleted, FileIndexed — выявление устаревших знаний |
| 10 | **Retrieval** | Предоставление API для поиска и извлечения знаний |
| 11 | **Search** | Полнотекстовый, семантический и гибридный поиск |
| 12 | **Ranking** | Ранжирование результатов по релевантности, свежести, confidence |
| 13 | **Quality Evaluation** | Оценка confidence каждого знания, верификация evidence, выявление шума |
| 14 | **Conflict Detection** | Обнаружение противоречий между знаниями, между знанием и Graph, между знанием и ADR |
| 15 | **Governance** | Управление правами создания, trusted sources, promotion/deprecation правил |
| 16 | **Diagnostics** | Статистика: coverage, stale ratio, retrieval hit rate, quality distribution |

### 2.2 Что категорически НЕ входит в ответственность Knowledge

| # | НЕ-ответственность | Где это должно быть |
|---|---------------------|---------------------|
| 1 | Хранение структурного представления кода | Graph |
| 2 | Индексация и парсинг файлов | Indexer |
| 3 | Сбор информации для конкретной задачи | Research Engine |
| 4 | Принятие инженерных решений | Planner |
| 5 | Сборка контекста для LLM | Context Builder |
| 6 | Выполнение задач (генерация кода) | Execution Engine |
| 7 | Анализ влияния для конкретной задачи | Impact Analysis Engine |
| 8 | Хранение диалоговой истории или сессионного контекста | Будущий Memory |
| 9 | Хранение временного кэша контекстов | Context Cache (Redis) |
| 10 | Управление Git-репозиторием | Workspace / Repository Manager |
| 11 | Хранение полных текстов всех артефактов | Artifact Storage |
| 12 | Подмена архитектурных правил | Architecture Guard (часть Graph) |
| 13 | Автоматическое исправление кода при устаревании знаний | Execution Engine |
| 14 | Принудительное обновление Graph | Graph Manager |

---

## 3. Входные данные

### 3.1 Общая классификация входов

Knowledge получает данные из трёх основных каналов:

1. **События системы** (Event Bus) — Knowledge подписывается на события из утверждённой событийной модели (`003-event-system.md`).
2. **Прямые вызовы API** — модули могут напрямую запрашивать Knowledge для retrieval.
3. **Системные триггеры** — периодические проверки freshness, resync.

### 3.2 Research Reports

| Характеристика | Описание |
|----------------|----------|
| **Откуда приходит** | Research Engine, через событие `ResearchCompleted` |
| **Что является авторитетным** | Research Report, сформированный Research Engine. Авторитетность определяется confidence research-а |
| **Что сохраняется как знание** | Findings (ключевые находки), Conclusions (выводы), Evidence (доказательства с привязкой к Graph), Identified modules, Unknowns (явно зафиксированные пробелы), Recommendations |
| **Что сохраняется только как reference** | Полный текст Research Report → Artifact Storage. Knowledge сохраняет ссылку и извлечённые Knowledge Entries |
| **Что может быть отклонено** | Research Report с confidence ниже порогового (без явного запроса пользователя). Промежуточные результаты Research (ResearchStarted, ResearchProgress), если Research не завершён |

### 3.3 Impact Reports

| Характеристика | Описание |
|----------------|----------|
| **Откуда приходит** | Impact Analysis Engine, через событие `ImpactAnalysisCompleted` |
| **Что является авторитетным** | Impact Report, сформированный Impact Analysis Engine |
| **Что сохраняется как знание** | Risk markers (как Risk Knowledge с привязкой к модулям), Conflict markers, Blast radius analysis, Critical nodes identified, Validation scope |
| **Что сохраняется только как reference** | Полный Impact Report → Artifact Storage. Affected entities list (это данные Graph, не Knowledge) |
| **Что может быть отклонено** | Impact Report для отменённой задачи. Impact Report без связанного Research Report (неполный пайплайн) |

### 3.4 Execution Plans

| Характеристика | Описание |
|----------------|----------|
| **Откуда приходит** | Planner, через событие `ExecutionPlanned` |
| **Что является авторитетным** | Execution Plan, утверждённый Planner |
| **Что сохраняется как знание** | Стратегия декомпозиции (как Best Practice при повторяемости), Acceptance criteria (как Architectural Constraint), Выявленные архитектурные ограничения (как Architectural Knowledge) |
| **Что сохраняется только как reference** | Полный Execution Plan → Artifact Storage. DAG шагов (это execution-specific, не переиспользуемое знание) |
| **Что может быть отклонено** | Execution Plan, который не привёл к выполнению (TaskCancelled). Execution Plan без Execution Report |

### 3.5 Execution Reports

| Характеристика | Описание |
|----------------|----------|
| **Откуда приходит** | Execution Engine, через событие `TaskCompleted` |
| **Что является авторитетным** | Execution Report, сформированный Execution Engine |
| **Что сохраняется как знание** | Lessons Learned (ключевой источник), Patterns applied, Problems encountered и их resolution, Validation results, Test coverage findings, Performance implications |
| **Что сохраняется только как reference** | Полный Execution Report → Artifact Storage. Список изменённых файлов (это данные Indexer/Graph), Логи выполнения |
| **Что может быть отклонено** | Execution Report для failed task (сохраняется как negative knowledge — что пошло не так). Execution Report без изменений кода (no-op) |

### 3.6 ADR (Architecture Decision Records)

| Характеристика | Описание |
|----------------|----------|
| **Откуда приходит** | Пользователь, Planner (как proposed ADR), или система (как автоматически сгенерированный ADR) |
| **Что является авторитетным** | ADR в статусе Accepted. Proposed и Deprecated ADR хранятся, но с соответствующими статусами |
| **Что сохраняется как знание** | Полный ADR → Architectural Knowledge. Title, Context, Decision, Consequences, Alternatives — как структурированные Knowledge Entries |
| **Что сохраняется только как reference** | N/A — ADR это канонический Knowledge-документ |
| **Что может быть отклонено** | ADR без достаточного контекста. ADR, противоречащий Accepted ADR без явного superseding |

### 3.7 User Decisions

| Характеристика | Описание |
|----------------|----------|
| **Откуда приходит** | Пользовательский ввод через API/Frontend |
| **Что является авторитетным** | Явное решение пользователя (например, выбор между альтернативами, предоставленными Planner) |
| **Что сохраняется как знание** | Decision Record: что выбрано, из каких альтернатив, с каким обоснованием |
| **Что сохраняется только как reference** | Контекст диалога, в котором принято решение → будущий Memory |
| **Что может быть отклонено** | Неявные предпочтения (implicit preferences) → Memory, не Knowledge |

### 3.8 Project Metadata

| Характеристика | Описание |
|----------------|----------|
| **Откуда приходит** | Project Manager, через событие `ProjectInitialized` или `ProjectOpened` |
| **Что является авторитетным** | Метаданные проекта: язык, фреймворк, зависимости, структура |
| **Что сохраняется как знание** | Project Knowledge: технологический стек, architectural style, ключевые зависимости, версии |
| **Что сохраняется только как reference** | Полный package.json / Cargo.toml / etc. → Graph/Indexer |
| **Что может быть отклонено** | N/A — метаданные проекта всегда сохраняются как baseline knowledge |

### 3.9 Graph References

| Характеристика | Описание |
|----------------|----------|
| **Откуда приходит** | Graph Manager, через события `GraphUpdated`, `GraphVersionCreated`, `NodeCreated`, `NodeDeleted` |
| **Что является авторитетным** | Текущее состояние Graph (Neo4j) |
| **Что сохраняется как знание** | **Ничего.** Graph References — это не знания, а контекст для связывания. Knowledge использует их для: (a) привязки знаний к узлам, (b) проверки freshness, (c) инвалидации устаревших связей |
| **Что сохраняется только как reference** | Graph Node ID, Graph Version ID — сохраняются внутри Knowledge Link |
| **Что может быть отклонено** | N/A — Graph References не сохраняются как Knowledge |

### 3.10 Task Metadata

| Характеристика | Описание |
|----------------|----------|
| **Откуда приходит** | Task Manager, через события `TaskReceived`, `TaskCompleted`, `TaskRejected` |
| **Что является авторитетным** | Task ID, статус, тип задачи |
| **Что сохраняется как знание** | Task type patterns (при достаточной повторяемости могут стать Best Practices), Task rejection reasons (negative knowledge) |
| **Что сохраняется только как reference** | Task ID — для traceability knowledge→task |
| **Что может быть отклонено** | Task description text (если не содержит инженерно ценных выводов) |

### 3.11 Repository History

| Характеристика | Описание |
|----------------|----------|
| **Откуда приходит** | Git (через Workspace) при выполнении Research |
| **Что является авторитетным** | Git log, blame, diff |
| **Что сохраняется как знание** | **Ничего напрямую.** Git history используется Research для формирования Research Report, после чего Knowledge extracts |
| **Что сохраняется только как reference** | Commit hash — для связи Knowledge Entry с состоянием кода на момент создания |
| **Что может быть отклонено** | Полный git log → не сохраняется в Knowledge |

### 3.12 Documentation Fragments

| Характеристика | Описание |
|----------------|----------|
| **Откуда приходит** | Research Engine (из внутренней документации), External Search (из внешней документации) |
| **Что является авторитетным** | Внутренняя документация проекта (docs/) |
| **Что сохраняется как знание** | Ключевые выводы, цитаты с атрибуцией (External Reference Knowledge), обновления документации после выполнения задачи |
| **Что сохраняется только как reference** | URL / путь к документу |
| **Что может быть отклонено** | Полный текст внешней документации (copyright, volume). Документация, не релевантная проекту |

### 3.13 External Findings

| Характеристика | Описание |
|----------------|----------|
| **Откуда приходит** | Research Engine (через Provider System → Search Provider) |
| **Что является авторитетным** | Результаты внешнего поиска, атрибутированные и проверенные Research Engine |
| **Что сохраняется как знание** | External Reference Knowledge: источник, релевантный вывод, дата получения, confidence |
| **Что сохраняется только как reference** | URL источника |
| **Что может быть отклонено** | Непроверенные данные. Низкокачественные источники. SEO-спам. Данные без атрибуции |

### 3.14 Diagnostics

| Характеристика | Описание |
|----------------|----------|
| **Откуда приходит** | Все модули (через систему мониторинга) |
| **Что является авторитетным** | Системная диагностика: ошибки индексации, ошибки провайдеров, ошибки выполнения |
| **Что сохраняется как знание** | Повторяющиеся ошибки как Operational Knowledge (например, "Parser некорректно обрабатывает TypeScript 5.4 AST"). Системные ограничения |
| **Что сохраняется только как reference** | N/A — diagnostics не сохраняется как артефакт |
| **Что может быть отклонено** | Единичные ошибки без паттерна. Transient errors |

### 3.15 Configuration

| Характеристика | Описание |
|----------------|----------|
| **Откуда приходит** | Системная конфигурация (API, Admin) |
| **Что является авторитетным** | Настройки провайдеров, лимиты, правила governance |
| **Что сохраняется как знание** | Configuration decisions (почему выбран конкретный провайдер, почему установлен конкретный лимит) |
| **Что сохраняется только как reference** | Config values (сохраняются в Configuration Store) |
| **Что может быть отклонено** | Secrets, credentials, API keys |

---

## 4. Выходные данные

### 4.1 Knowledge Documents

Полный Knowledge Document — агрегированное представление знания, включающее все версии, связи, оценки качества. Предоставляется по запросу downstream-модуля.

**Структура Knowledge Document:**
- `knowledge_id` — уникальный идентификатор
- `knowledge_type` — тип знания (Architectural, Operational, Historical, etc.)
- `current_version` — текущая версия и её содержимое
- `version_history` — история всех версий
- `graph_links` — связи с узлами Graph
- `artifact_links` — связи с артефактами
- `task_lineage` — цепочка задач, которые привели к созданию/обновлению
- `freshness_status` — current | potentially_stale | stale | superseded
- `confidence` — overall confidence score
- `related_knowledge` — связанные Knowledge Entries
- `conflicts` — известные конфликты с другими знаниями

### 4.2 ADR Registry

Полный реестр всех Architectural Decision Records с фильтрацией по статусу (Accepted, Proposed, Deprecated, Superseded), модулю, временному диапазону.

### 4.3 Historical Decisions

Хронология принятых решений (как ADR, так и пользовательских), сгруппированная по модулям и архитектурным слоям. Включает traceability decision→task→code.

### 4.4 Best Practices

Извлечённые и формализованные Best Practices, ранжированные по:
- Частоте успешного применения
- Recency
- Релевантности запрашиваемому модулю/задаче

### 4.5 Lessons Learned

Извлечённые уроки из Execution Reports, сгруппированные по:
- Типу задачи
- Затронутому модулю
- Типу проблемы (performance, security, architectural, testing)

### 4.6 Prior Research Retrieval

Результаты поиска по историческим Research Reports:
- Research Report summaries, релевантные текущему исследованию
- Findings и Conclusions из предыдущих Research
- Unknowns (ранее выявленные пробелы, возможно, уже заполненные)

### 4.7 Prior Impact Retrieval

Результаты поиска по историческим Impact Reports:
- Ранее выявленные risk markers для затрагиваемых модулей
- Blast radius из предыдущих задач в этих же модулях
- Conflict markers

### 4.8 Prior Execution Retrieval

Результаты поиска по историческим Execution Reports:
- Как решались аналогичные задачи ранее
- Какие паттерны применялись
- Какие ошибки возникали и как были исправлены

### 4.9 Risk History

Историческая информация о рисках:
- Какие модули наиболее рискованны (по историческим Impact Reports)
- Какие типы изменений наиболее часто приводят к проблемам
- Накопленная статистика по типам рисков

### 4.10 Linked Knowledge References

По запросу к Graph Node → все Knowledge Entries, связанные с этим узлом (через Knowledge Link).

### 4.11 Freshness / Staleness Signals

Для каждого Knowledge Entry:
- `freshness_score` — числовая оценка актуальности (0.0–1.0)
- `staleness_reason` — причина устаревания (graph_changed, time_passed, adr_superseded, etc.)
- `last_validated_at` — когда знание последний раз проверялось на актуальность
- `stale_since` — с какого момента знание считается потенциально устаревшим

### 4.12 Knowledge Search Results

Структурированные результаты поиска, включающие:
- Ranked list of Knowledge Entries
- Freshness и confidence для каждого
- Links to graph, artifacts, related knowledge
- Warnings для stale или conflict-flagged записей

---

## 5. Архитектура модуля

### 5.1 Визуальная структура

```
Knowledge Module
│
├─── Knowledge Coordinator
│    │  Центральный координатор модуля
│    │  • Принимает события из Event Bus
│    │  • Маршрутизирует запросы к внутренним компонентам
│    │  • Оркестрирует ingestion pipeline
│    │  • Управляет жизненным циклом Knowledge Entries
│    │
│    ├─── Ingestion Manager
│    │    │  Управляет приёмом входящих артефактов
│    │    │  • Валидация входящих данных
│    │    │  • Определение, подлежит ли артефакт extraction
│    │    │  • Управление очередью ingestion (batch/stream)
│    │    │  • Retry логика при сбоях ingestion
│    │    │
│    │    ├─── Ingestion Validator
│    │    │    • Проверка completeness артефакта
│    │    │    • Проверка соответствия схеме
│    │    │    • Отклонение невалидных артефактов
│    │    │
│    │    └─── Ingestion Queue
│    │         • Приоритезация ingestion
│    │         • Batch grouping
│    │         • Backpressure management
│    │
│    ├─── Knowledge Normalizer
│    │    │  Приводит входящие данные к единой структуре
│    │    │  • Извлечение полей из разных типов входов
│    │    │  • Приведение к Knowledge Entry schema
│    │    │  • Обработка неструктурированных текстов
│    │    │
│    │    ├─── Field Extractor
│    │    │    • Извлечение title, summary, content из артефакта
│    │    │    • Определение primary entity
│    │    │    • Выделение ключевых утверждений
│    │    │
│    │    └─── Schema Mapper
│    │         • Mapping полей артефакта → Knowledge Entry
│    │         • Обработка missing fields
│    │         • Default value assignment
│    │
│    ├─── Knowledge Classifier
│    │    │  Классифицирует знания по типам
│    │    │  • Определение knowledge_type
│    │    │  • Определение domain area
│    │    │  • Определение scope (project, module, file, symbol)
│    │    │
│    │    ├─── Type Classifier
│    │    │    • Architectural vs Operational vs Historical classification
│    │    │    • Multi-label classification для гибридных знаний
│    │    │
│    │    └─── Scope Classifier
│    │         • Определение уровня: project-wide, module, file, symbol
│    │         • Связывание с project/module иерархией
│    │
│    ├─── Knowledge Linker
│    │    │  Связывает знания с Graph, артефактами, задачами
│    │    │  • Создание Knowledge Link
│    │    │  • Разрешение ссылок на Graph Node/Edge
│    │    │  • Поддержание bidirectional traceability
│    │    │
│    │    ├─── Graph Linker
│    │    │    • Связывание knowledge → graph node/edge
│    │    │    • Определение affected nodes
│    │    │    • Публикация KnowledgeLinkedToGraph
│    │    │
│    │    ├─── Artifact Linker
│    │    │    • Связывание knowledge → artifact
│    │    │    • Отслеживание artifact lineage → knowledge lineage
│    │    │
│    │    └─── Task Linker
│    │         • Связывание knowledge → task → run
│    │         • Построение task lineage для знаний
│    │
│    ├─── Version Manager
│    │    │  Управляет версиями Knowledge Entry
│    │    │  • Создание новых версий
│    │    │  • Immutable history
│    │    │  • Supersede/deprecate логика
│    │    │
│    │    ├─── Version Creator
│    │    │    • Создание новой версии при обновлении
│    │    │    • Сохранение diff между версиями
│    │    │    • Инкремент version number
│    │    │
│    │    ├─── Lineage Tracker
│    │    │    • Отслеживание цепочки версий
│    │    │    • Связь с Graph Version, Commit Hash
│    │    │    • Связь с Task/Run lineage
│    │    │
│    │    └─── Supersede Manager
│    │         • Логика замещения: старый knowledge → новый
│    │         • Сохранение связи superseded_by / supersedes
│    │         • Управление статусами Superseded, Deprecated
│    │
│    ├─── Freshness Manager
│    │    │  Управляет актуальностью знаний
│    │    │  • Расчёт freshness_score
│    │    │  • Реакция на события GraphUpdated, NodeDeleted
│    │    │  • Периодические проверки freshness
│    │    │
│    │    ├─── Freshness Calculator
│    │    │    • Расчёт базового freshness на основе времени
│    │    │    • Модификаторы: graph_links_valid, adr_status, artifact_age
│    │    │    • Вычисление partially stale
│    │    │
│    │    └─── Staleness Detector
│    │         • Подписка на GraphUpdated → проверка linked nodes
│    │         • Подписка на NodeDeleted → пометка связанных знаний
│    │         • Подписка на FileIndexed → проверка affected symbols
│    │         • Определение конкретной причины устаревания
│    │
│    ├─── Retrieval Engine
│    │    │  Предоставляет API для извлечения знаний
│    │    │  • Обработка retrieval запросов
│    │    │  • Координация search strategies
│    │    │  • Фильтрация и ранжирование результатов
│    │    │
│    │    ├─── Query Parser
│    │    │    • Разбор retrieval запроса
│    │    │    • Определение retrieval strategy
│    │    │    • Извлечение фильтров (type, freshness, confidence, scope)
│    │    │
│    │    ├─── Retrieval Strategies
│    │    │    • by graph link
│    │    │    • by task type
│    │    │    • by artifact lineage
│    │    │    • by semantic similarity
│    │    │    • by recency
│    │    │    • by confidence
│    │    │    • by knowledge type
│    │    │    • by project scope
│    │    │    • by decision scope
│    │    │
│    │    └─── Result Aggregator
│    │         • Объединение результатов из разных стратегий
│    │         • Дедупликация результатов
│    │         • Формирование финального Retrieval Result
│    │
│    ├─── Search Engine
│    │    │  Реализует поисковые возможности
│    │    │  • Полнотекстовый поиск
│    │    │  • Семантический поиск
│    │    │  • Hybrid retrieval
│    │    │
│    │    ├─── Full-Text Searcher
│    │    │    • Поиск по PostgreSQL full-text search (tsvector)
│    │    │    • Фразовый поиск
│    │    │    • Фильтрация по метаданным
│    │    │
│    │    ├─── Semantic Searcher
│    │    │    • Векторный поиск (pgvector / external vector store)
│    │    │    • Генерация embedding для запроса
│    │    │    • ANN (approximate nearest neighbor) поиск
│    │    │
│    │    └─── Hybrid Aggregator
│    │         • Объединение full-text и semantic результатов
│    │         • Reciprocal Rank Fusion (RRF)
│    │         • Weighted scoring
│    │
│    ├─── Vectorization Manager
│    │    │  Управляет векторными представлениями знаний
│    │    │  • Генерация embedding для Knowledge Entry
│    │    │  • Обновление embedding при version change
│    │    │  • Управление embedding store lifecycle
│    │    │
│    │    ├─── Embedding Generator
│    │    │    • Вызов Embedding Provider
│    │    │    • Подготовка текста для embedding (summary-focused)
│    │    │    • Batch генерация для эффективности
│    │    │
│    │    └─── Embedding Store
│    │         • Хранение embedding (pgvector)
│    │         • Индексация для ANN поиска
│    │         • Удаление/пометка deprecated embedding
│    │
│    ├─── Conflict Resolver
│    │    │  Обнаруживает и управляет конфликтами знаний
│    │    │  • Обнаружение противоречий
│    │    │  • Классификация конфликтов
│    │    │  • Сохранение, не скрытие конфликтов
│    │    │
│    │    ├─── Conflict Detector
│    │    │    • Сравнение нового знания с существующими
│    │    │    • Проверка на противоречия Knowledge vs Knowledge
│    │    │    • Проверка Knowledge vs Graph
│    │    │    • Проверка Knowledge vs ADR
│    │    │
│    │    └─── Conflict Registry
│    │         • Хранение активных конфликтов
│    │         • История разрешения конфликтов
│    │         • Conflict-aware retrieval (предупреждение consumers)
│    │
│    ├─── Governance Manager
│    │    │  Управляет политиками knowledge lifecycle
│    │    │  • Правила создания знания
│    │    │  • Trusted sources
│    │    │  • Promotion/deprecation правила
│    │    │
│    │    ├─── Trust Authority
│    │    │    • Определение trusted sources
│    │    │    • Validation requirements
│    │    │    • Auto-promotion rules
│    │    │
│    │    └─── Lifecycle Policy Engine
│    │         • Правила promotion: temporary → persistent
│    │         • Правила deprecation: stale → deprecated
│    │         • Правила deletion: deprecated → archived
│    │
│    ├─── Knowledge Quality Evaluator
│    │    │  Оценивает качество каждого Knowledge Entry
│    │    │  • Расчёт confidence score
│    │    │  • Проверка evidence requirements
│    │    │  • Выявление шума
│    │    │
│    │    ├─── Confidence Calculator
│    │    │    • Оценка на основе источника
│    │    │    • Оценка на основе evidence quality
│    │    │    • Оценка на основе corroboration
│    │    │
│    │    └─── Noise Detector
│    │         • Выявление низкоинформативных записей
│    │         • Анализ на duplicate/trivial содержание
│    │         • Рекомендации по очистке
│    │
│    └─── Diagnostics and Statistics Manager
│         │  Собирает и предоставляет статистику модуля
│         │
│         ├─── Metrics Collector
│         │    • Счётчики knowledge entries
│         │    • Coverage statistics
│         │    • Performance metrics
│         │
│         └─── Health Reporter
│              • Stale ratio
│              • Ingestion error rate
│              • Retrieval hit rate
│              • Quality score distribution
```

### 5.2 Взаимодействие компонентов

```
Event Bus → Knowledge Coordinator → Ingestion Manager → Ingestion Validator
                                                              │
                                                              ▼
                                                  Ingestion Queue → Knowledge Normalizer
                                                                          │
                                                                          ▼
                                                                  Knowledge Classifier
                                                                          │
                                                                          ▼
                                                                  Knowledge Quality Evaluator
                                                                          │
                                                                          ▼
                                                                  Knowledge Linker ──────┐
                                                                          │                │
                                                              ┌───────────┴───────────┐    │
                                                              ▼                       ▼    │
                                                      Version Manager          Vectorization │
                                                              │                 Manager     │
                                                              ▼                       │    │
                                                      Conflict Resolver  ◄──────────┘    │
                                                              │                            │
                                                              ▼                            │
                                                      Freshness Manager                   │
                                                              │                            │
                                                              ▼                            │
                                                      Knowledge Store ◄───────────────────┘
                                                      (PostgreSQL + pgvector)
```

---

## 6. Модель Knowledge

### 6.1 Knowledge Entry — атомарная единица знания

**Knowledge Entry** — это минимальная, самодостаточная единица знания в системе. Это не весь артефакт, а извлечённый из него инженерный вывод.

**Identity:**
- `knowledge_entry_id` — уникальный идентификатор (UUID)
- `knowledge_document_id` — идентификатор Knowledge Document, к которому относится Entry (один Document может содержать несколько Entry)
- `created_at`, `created_by`, `origin_artifact_id`

**Lifecycle:**
```
Extracted → Draft → Validated → Active → Superseded/Deprecated → Archived
                │                            │
                └── Rejected                 └── (keep for history)
```

**Ownership:**
- Принадлежит Knowledge Module
- Связан с проектом (`project_id`)
- Может быть связан с Task/Run через Task Linker
- Не привязан к пользователю (системное знание)

**Versioning:**
- Каждая Knowledge Entry имеет `version_number` (1..N)
- Все версии immutable — хранятся в истории
- `is_current_version` флаг указывает на активную версию
- При изменении создаётся новая версия, старая помечается `is_current_version = false`

**Relation to Task/Run/Project:**
- Связь через Task Link: `knowledge_entry_id → task_id → run_id`
- Связь с проектом: прямой `project_id`
- Одно знание может быть связано с несколькими задачами (повторное применение)

**Relation to Graph:**
- Связь через Knowledge Link: `knowledge_entry_id → graph_node_id` с типом связи (`RELATES_TO`, `DOCUMENTS`, `CONSTRAINS`, etc.)
- Одно знание может быть связано с несколькими узлами графа

**Relation to Artifacts:**
- Связь через Artifact Link: `knowledge_entry_id → artifact_id` с указанием `derived_from`
- Оригинальный артефакт хранится в Artifact Storage
- Knowledge Entry содержит derived knowledge, не копию

### 6.2 Knowledge Document

**Knowledge Document** — агрегирующая сущность, объединяющая связанные Knowledge Entries.

**Identity:**
- `knowledge_document_id` — уникальный идентификатор
- `title` — человекочитаемое название
- `knowledge_type` — основной тип знания
- `primary_scope` — project/module/file/symbol

**Содержит:**
- Один или несколько Knowledge Entries (например, Research Report → 5 Entries: 3 Findings, 1 Conclusion, 1 Recommendation)
- Метаданные: created_at, updated_at, version, freshness, confidence
- Связи с артефактом-источником

**Lifecycle:**
```
Created → Enriched → Maintained → Superseded → Archived
```

### 6.3 ADR (Architecture Decision Record)

**ADR — специализированный тип Knowledge Document.**

**Identity:**
- `adr_id` — уникальный идентификатор
- `adr_number` — порядковый номер (ADR-0001, ADR-0002)
- `title`, `status`, `created_at`, `superseded_by`

**Структура ADR соответствует стандарту:**
- **Title** — краткое название решения
- **Status** — Proposed, Accepted, Deprecated, Superseded
- **Context** — технический и бизнес-контекст
- **Decision** — само решение
- **Consequences** — последствия (позитивные и негативные)
- **Alternatives** — рассмотренные альтернативы и причины отказа

**Lifecycle:**
```
Proposed → Accepted → Deprecated → Superseded
                        │
                        └── (может оставаться Accepted «навсегда»)
```

**Relation to Graph:**
- ADR имеет соответствующий узел в Graph типа `ADR`
- Связь с другими узлами: `ADR --RELATES_TO--> Module`, `ADR --CONSTRAINS--> Class`
- Knowledge не дублирует Graph-узел, а связывается через KnowledgeLink

**Relation to Artifacts:**
- ADR сам является артефактом (сохраняется в Artifact Storage как Markdown)
- Knowledge хранит структурированную версию ADR как Knowledge Entry

### 6.4 Historical Finding

**Результат исследования, сохранённый для будущего переиспользования.**

**Identity:**
- `finding_id` — уникальный идентификатор
- `research_report_id` — связь с Research Report
- `finding_type` — structural, behavioral, dependency, risk, opportunity

**Содержание:**
- Finding statement (чёткое утверждение)
- Evidence (доказательства с атрибуцией)
- Confidence (уверенность Research в этом finding)
- Related Graph Nodes (если применимо)

**Lifecycle:**
- Создаётся при ResearchCompleted
- Может быть superseded новым Research
- Может быть помечен как stale при GraphUpdated

### 6.5 Best Practice

**Извлечённый и формализованный успешный паттерн.**

**Identity:**
- `best_practice_id` — уникальный идентификатор
- `derived_from_tasks` — задачи, из которых извлечён
- `application_count` — сколько раз успешно применён

**Содержание:**
- Practice statement (формализованный совет)
- Applicability conditions (когда применять)
- Examples (из каких задач, с какими результатами)
- Counter-indications (когда НЕ применять)

**Lifecycle:**
- Извлекается при обнаружении повторяющегося паттерна (≥3 успешных применений)
- Может быть оспорен новым Execution Report (conflict detection)
- Обновляется при каждом новом успешном применении

### 6.6 Lesson Learned

**Извлечённый урок из выполненной задачи (позитивный или негативный).**

**Identity:**
- `lesson_learned_id` — уникальный идентификатор
- `derived_from_execution` — Execution Report ID
- `lesson_type` — success, failure, caution, insight

**Содержание:**
- Lesson statement
- Context (в какой ситуации возник)
- Consequence (что произошло)
- Recommendation (что делать/не делать в будущем)

**Lifecycle:**
- Создаётся при TaskCompleted
- Может быть обобщён в Best Practice при повторяемости
- Может быть superseded

### 6.7 Decision Record

**Зафиксированное решение пользователя или системы.**

**Identity:**
- `decision_id` — уникальный идентификатор
- `decision_source` — user / planner / automated
- `decision_context` — task или adr

**Содержание:**
- Decision statement
- Alternatives considered
- Rationale
- Impact assessment

### 6.8 Execution Insight

**Инженерный вывод, извлечённый из Execution Report.**

Отличается от Lesson Learned тем, что фокусируется на **технических деталях выполнения**, а не на обобщённых уроках.

**Содержание:**
- Технический подход (как именно была решена задача)
- Инструменты и паттерны
- Возникшие технические проблемы и их resolution
- Метрики (производительность, покрытие тестами)

### 6.9 Research Insight

**Инженерный вывод, извлечённый из Research Report.**

**Содержание:**
- Что было исследовано
- Что обнаружено
- Какие пробелы остались
- Рекомендации для следующих Research

### 6.10 Impact Insight

**Инженерный вывод, извлечённый из Impact Report.**

**Содержание:**
- Выявленные риски для модуля
- Критические узлы в blast radius
- Типовые паттерны распространения изменений

### 6.11 External Knowledge Reference

**Ссылка на внешний источник с извлечённым знанием.**

**Identity:**
- `external_ref_id` — уникальный идентификатор
- `source_url` — URL источника
- `source_type` — документация, статья, issue, RFC
- `retrieved_at` — дата получения

**Содержание:**
- Извлечённый вывод
- Цитата с атрибуцией
- Confidence (external sources have inherently lower confidence)

### 6.12 Derived Knowledge

**Знание, созданное не из артефакта, а на основе других Knowledge Entries.**

Например:
- Обобщение трёх Lessons Learned в Best Practice
- Вывод о системной проблеме на основе нескольких Execution Insights
- Cross-module architectural constraint

### 6.13 Deprecated Knowledge

**Знание, статус которого изменён на Deprecated.**

- Сохраняется для истории
- Не предлагается в retrieval results (без явного запроса)
- Имеет указание причины deprecation и ссылку на замещающее знание (superseded_by)

### 6.14 Superseded Knowledge

**Знание, замещённое новым знанием.**

- Старая версия сохраняется immutable
- Новая версия содержит ссылку supersedes → старая версия
- Старая версия содержит ссылку superseded_by → новая версия

---

## 7. Типы знаний

### 7.1 Architectural Knowledge

| Характеристика | Описание |
|----------------|----------|
| **Назначение** | Хранение архитектурных решений, ограничений, принципов |
| **Происхождение** | ADR, Planner decisions, User decisions |
| **Срок актуальности** | До superseding новым ADR или архитектурным изменением |
| **Типичные consumers** | Planner, Context Builder, Impact Analysis, Research |

**Примеры:**
- "Модуль UserService должен быть единственной точкой доступа к данным пользователей"
- "Все API-контроллеры должны следовать паттерну Request → Validation → Service → Response"
- "База данных — PostgreSQL 15, миграции через Prisma"

### 7.2 Project Knowledge

| Характеристика | Описание |
|----------------|----------|
| **Назначение** | Хранение метаданных и структуры проекта |
| **Происхождение** | Project Metadata, Indexer (через Graph) |
| **Срок актуальности** | При изменении структуры проекта |
| **Типичные consumers** | Research, Context Builder, Planner |

**Примеры:**
- Технологический стек: TypeScript + React + Express + PostgreSQL
- Структура монорепозитория: apps/api, apps/web, packages/*
- Ключевые зависимости: Prisma ORM, Redis для кэширования

### 7.3 Operational Knowledge

| Характеристика | Описание |
|----------------|----------|
| **Назначение** | Хранение операционных практик и системных ограничений |
| **Происхождение** | Execution Reports, Diagnostics, Configuration |
| **Срок актуальности** | При изменении конфигурации или инфраструктуры |
| **Типичные consumers** | Execution (Developer Agent), Context Builder |

**Примеры:**
- "Размер контекстного окна модели: 128K токенов"
- "Parser некорректно обрабатывает TypeScript 5.4 decorators"
- "Redis требуется для кэширования контекстов, минимальная версия 7.0"

### 7.4 Historical Knowledge

| Характеристика | Описание |
|----------------|----------|
| **Назначение** | Хранение истории принятых решений и их последствий |
| **Происхождение** | ADR history, Task history, Execution Reports |
| **Срок актуальности** | Не устаревает (исторические данные) |
| **Типичные consumers** | Research, Context Builder (для понимания контекста) |

**Примеры:**
- "ADR-0003: Переход с REST на GraphQL — rejected после исследования (причина: недостаточная зрелость экосистемы)"
- "Задача #142: Попытка миграции на ESM — failed из-за несовместимости с Jest"

### 7.5 Execution Knowledge

| Характеристика | Описание |
|----------------|----------|
| **Назначение** | Хранение знаний о том, как выполняются задачи |
| **Происхождение** | Execution Reports, Lessons Learned |
| **Срок актуальности** | При изменении технического подхода или инструментов |
| **Типичные consumers** | Execution (Developer Agent), Planner |

**Примеры:**
- "При добавлении нового API-endpoint необходимо: (1) создать Zod-схему, (2) добавить тесты в integration/, (3) обновить API-документацию"
- "Ошибка: при изменении Prisma-схемы без регенерации клиента возникают runtime-ошибки типов"

### 7.6 Validation Knowledge

| Характеристика | Описание |
|----------------|----------|
| **Назначение** | Хранение знаний о валидации и тестировании |
| **Происхождение** | Execution Reports, Test Results |
| **Срок актуальности** | При изменении тестовой инфраструктуры |
| **Типичные consumers** | Execution (Reviewer Agent), Planner |

**Примеры:**
- "Integration-тесты требуют запущенного Docker-контейнера с PostgreSQL"
- "Минимальное покрытие тестами для новых модулей: 80%"

### 7.7 Risk Knowledge

| Характеристика | Описание |
|----------------|----------|
| **Назначение** | Хранение знаний о рисках и уязвимых местах |
| **Происхождение** | Impact Reports, Execution Reports, Diagnostics |
| **Срок актуальности** | При изменении структуры затрагиваемого кода |
| **Типичные consumers** | Impact Analysis, Planner, Context Builder |

**Примеры:**
- "Модуль AuthService: высокий риск ошибок безопасности при любых изменениях"
- "Изменение схемы БД в таблице users: каскадное влияние на 12 модулей"

### 7.8 Framework Knowledge

| Характеристика | Описание |
|----------------|----------|
| **Назначение** | Хранение знаний о фреймворках и библиотеках проекта |
| **Происхождение** | Research Reports, External Findings |
| **Срок актуальности** | При обновлении версий фреймворков |
| **Типичные consumers** | Research, Execution, Planner |

**Примеры:**
- "Prisma v5: новый API для relation filters (заменяет previous подход)"
- "React 18: Concurrent Features не используются в проекте из-за несовместимости с legacy-компонентами"

### 7.9 Domain Knowledge

| Характеристика | Описание |
|----------------|----------|
| **Назначение** | Хранение знаний о предметной области проекта |
| **Происхождение** | Research Reports, User Decisions, External Findings |
| **Срок актуальности** | При изменении бизнес-требований |
| **Типичные consumers** | Research, Planner, Context Builder |

**Примеры:**
- "Бизнес-правило: скидка не может превышать 50% от базовой цены"
- "Домен: multi-tenant SaaS, tenant изоляция через PostgreSQL Row-Level Security"

### 7.10 External Reference Knowledge

| Характеристика | Описание |
|----------------|----------|
| **Назначение** | Хранение знаний из внешних источников с атрибуцией |
| **Происхождение** | External Search (через Research), Documentation Fragments |
| **Срок актуальности** | Зависит от источника; рекомендуется перепроверка |
| **Типичные consumers** | Research, Execution |

**Примеры:**
- "OpenAI documentation (2026-06): function calling теперь поддерживает strict mode для JSON Schema"
- "RFC 9110: HTTP Semantics — обновлённые правила кэширования"

### 7.11 Temporary-to-Persistent Promoted Knowledge

| Характеристика | Описание |
|----------------|----------|
| **Назначение** | Знания, которые изначально созданы как временные, но повышены до постоянных |
| **Происхождение** | Lessons Learned → Best Practice, Research Insight → Architectural Knowledge |
| **Срок актуальности** | Как у целевого типа |
| **Типичные consumers** | Все модули |

**Promotion Criteria:**
- Подтверждено ≥3 задачами
- Не оспорено другими Execution Reports
- Имеет достаточный confidence
- Прошло Governance validation

---

## 8. Knowledge Ingestion Pipeline

### 8.1 Полная диаграмма Pipeline

```
Входной артефакт (Research Report, Execution Report, ADR, etc.)
    │
    ▼
[1. Приём артефакта]
    │  Ingestion Manager получает артефакт через Event Bus или API
    │  Ingestion Validator проверяет completeness и schema
    │
    ├── Невалидный → Rejected (логгируется, не сохраняется)
    │
    ▼ Валидный
[2. Классификация]
    │  Knowledge Classifier определяет:
    │  • knowledge_type (Architectural, Operational, ...)
    │  • scope (project, module, file, symbol)
    │  • domain area
    │
    ▼
[3. Нормализация]
    │  Knowledge Normalizer приводит к Knowledge Entry schema:
    │  • title, summary, content
    │  • primary entity
    │  • ключевые утверждения (ключевые предложения)
    │
    ▼
[4. Extraction — выделение knowledge-worthy content]
    │  Применяются Extraction Rules (см. раздел 9):
    │  • Выделение findings, conclusions, patterns
    │  • Отделение шума от инженерно ценных выводов
    │  • Определение, что должно остаться просто Artifact
    │
    ├── Нечего извлекать → Artifact-only (сохраняется только reference)
    │
    ▼ Есть что извлекать
[5. Дедупликация]
    │  Проверка на дубликаты:
    │  • Exact match → merge или skip
    │  • Semantic duplicate → link как related или supersede
    │  • Partial overlap → update существующего или create new
    │
    ▼
[6. Связывание]
    │  Knowledge Linker:
    │  • Graph Linker: связь с graph nodes/edges
    │  • Artifact Linker: связь с artifact-источником
    │  • Task Linker: связь с task/run
    │
    ▼
[7. Versioning]
    │  Version Manager:
    │  • Если новый Knowledge Entry → v1
    │  • Если обновление существующего → новая версия (vN+1)
    │  • Старая версия помечается is_current_version=false
    │  • Строится lineage
    │
    ▼
[8. Freshness Assignment]
    │  Freshness Manager вычисляет:
    │  • initial_freshness = 1.0 (новое знание считается свежим)
    │  • freshness_ttl — на основе knowledge_type
    │  • graph_version_stamp — текущая версия Graph
    │
    ▼
[9. Quality Evaluation]
    │  Quality Evaluator:
    │  • Рассчитывает confidence score
    │  • Проверяет evidence requirements
    │  • Обнаруживает потенциальный шум
    │
    ▼
[10. Сохранение]
    │  • Knowledge Entry → PostgreSQL
    │  • Embedding → pgvector (через Vectorization Manager)
    │  • Knowledge Links → PostgreSQL
    │  • Conflict detection (сравнение с существующими)
    │
    ▼
[11. Публикация событий]
    │  • KnowledgeCreated (для нового)
    │  • KnowledgeUpdated (для обновлённого)
    │  • KnowledgeLinkedToGraph (после связывания)
    │  • KnowledgeConflictDetected (если обнаружен конфликт)
    │
    ▼
[12. Подписчики реагируют]
       • Vector Storage: генерирует/обновляет embedding
       • Graph Manager: создаёт Node KNOWLEDGE + RELATES_TO
       • Context Builder: включает в будущие контексты
       • Research Engine: может использовать для текущего Research
```

### 8.2 Batch vs Streaming Ingestion

**Batch Ingestion** — используется при:
- Первичной инициализации проекта (загрузка исторических ADR)
- Resync (после перестройки Graph)
- Массовом импорте

**Streaming Ingestion** — основной режим:
- Событие → Ingestion Queue → Pipeline
- Один артефакт за раз
- Приоритезация: ADR > Execution Report > Research Report > Impact Report

### 8.3 Ingestion Error Handling

| Тип ошибки | Действие |
|------------|----------|
| **Артефакт невалидный** | Reject, логгировать, опубликовать IngestionError (для диагностики) |
| **Graph недоступен** | Сохранить без Graph Link, запланировать retry линковки |
| **Vector Store недоступен** | Сохранить без embedding, запланировать retry векторизации |
| **Частичный extraction** | Сохранить что извлечено, пометить как partial, запланировать review |
| **Duplicate detection error** | Сохранить с пометкой potential_duplicate, запланировать manual review |

---

## 9. Knowledge Extraction Rules

### 9.1 Что достойно сохранения как Knowledge

Knowledge-worthy content — это информация, которая соответствует **всем** следующим критериям:

| Критерий | Описание |
|-----------|----------|
| **Инженерная ценность** | Содержит выводы, которые могут быть переиспользованы в будущих задачах |
| **Структурируемость** | Может быть сформулировано как чёткое утверждение/правило/вывод |
| **Переиспользуемость** | Применимо не только к текущей задаче, но и к будущим |
| **Проверяемость** | Может быть верифицировано через evidence (Graph, test results, etc.) |
| **Специфичность** | Относится к конкретному модулю/паттерну/решению, а не общая фраза |

**Примеры knowledge-worthy контента:**

| Источник | Извлекается как Knowledge |
|----------|--------------------------|
| Research Report | "Модуль PaymentService имеет неявную зависимость от UserService через SharedEvents — не отражено в Graph" |
| Execution Report | "При изменении Prisma-схемы необходимо вручную запускать `prisma generate` перед запуском тестов" |
| Impact Report | "Изменение в UserService.createUser имеет blast radius, затрагивающий 8 модулей, включая NotificationService (неожиданно)" |
| ADR | "Решение: использовать PostgreSQL Row-Level Security для tenant-изоляции вместо application-level фильтрации" |

### 9.2 Что НЕ должно сохраняться как Knowledge

| Тип контента | Почему не сохраняется |
|--------------|----------------------|
| **Структурная информация о коде** | Это ответственность Graph. Например: "UserService имеет метод createUser" → Graph |
| **Тривиальные наблюдения** | Не содержат инженерной ценности. Например: "В проекте используется TypeScript" |
| **Промежуточные рабочие состояния** | Временные артефакты: DAG шагов, draft ADR, intermediate Research results |
| **Логи и отладочная информация** | Не являются знанием о проекте |
| **Дословные копии внешней документации** | Copyright, объём. Knowledge сохраняет вывод с атрибуцией |
| **Диалоговая история** | Это ответственность будущего Memory |
| **Конфигурационные значения** | Хранятся в Configuration Store. Knowledge хранит rationale выбора конфигурации |
| **Генерализированные утверждения без evidence** | "Лучше использовать функциональный подход" без контекста — шум |

### 9.3 Что должно остаться просто Artifact

| Артефакт | Хранится как | Knowledge extracted? |
|----------|--------------|---------------------|
| Полный Research Report | Artifact Storage | Да: Findings, Conclusions, Recommendations |
| Полный Impact Report | Artifact Storage | Да: Risk markers, Critical nodes, Validation scope |
| Полный Execution Plan | Artifact Storage | Да: Strategy patterns, Architectural constraints |
| Полный Execution Report | Artifact Storage | Да: Lessons learned, Patterns applied, Problems resolved |
| Полный ADR | Artifact Storage + Knowledge | Да (полностью) |
| Промежуточный Research Result | Только если ResearchCompleted | Нет |
| DAG шагов | Artifact Storage (часть Execution Plan) | Нет |
| Лог выполнения | Artifact Storage | Нет |

### 9.4 Как отделять шум от инженерно ценных выводов

**Алгоритм фильтрации шума:**

1. **Проверка специфичности:** Относится ли утверждение к конкретной сущности (модулю, классу, паттерну) или это общее утверждение?
2. **Проверка actionable:** Можно ли на основе этого утверждения принять решение в будущей задаче?
3. **Проверка новизны:** Содержит ли утверждение новую информацию по сравнению с уже существующими знаниями?
4. **Проверка верифицируемости:** Можно ли подтвердить или опровергнуть утверждение через Graph, тесты, код?
5. **Проверка долговечности:** Будет ли утверждение релевантно через месяц/год?

Утверждение, не проходящее минимум 3 из 5 проверок, считается шумом и не сохраняется как Knowledge.

### 9.5 Как извлекать Lessons Learned

**Из Execution Report извлекаются lessons learned:**

1. **Идентификация проблемы:** Что пошло не так (или что пошло особенно хорошо)?
2. **Контекст:** В каком модуле/задаче это произошло?
3. **Причина:** Почему это произошло?
4. **Решение:** Как это было исправлено (или использовано)?
5. **Обобщение:** Может ли этот урок быть применён к другим модулям?

**Пример извлечения:**

Из Execution Report: "При добавлении нового поля в User модель, тесты упали в 5 других модулях, потому что изменился конструктор User"

→ Lesson Learned: "Модель User имеет широкий конструктор без параметров по умолчанию. При добавлении поля — использовать Optional с дефолтным значением, либо фабричный метод."

### 9.6 Как извлекать Repeatable Best Practices

**Best Practice извлекается при обнаружении повторяющегося паттерна:**

1. **Порог повторяемости:** ≥3 успешных применений в разных задачах
2. **Формализация:** Абстрагирование от конкретных задач к общему принципу
3. **Верификация:** Проверка, что паттерн не противоречит существующим ADR
4. **Promotion:** Повышение из Lessons Learned в Best Practice

### 9.7 Как извлекать Validated Architectural Constraints

**Архитектурное ограничение извлекается, когда:**

1. **ADR явно устанавливает ограничение** → Architectural Knowledge
2. **Повторяющиеся нарушения в Execution Reports** → система извлекает implicit constraint (например, "Изменение схемы БД требует миграции — подтверждено проблемами в 5 задачах")
3. **Impact Analysis выявляет критическую зависимость** → Risk Knowledge

### 9.8 Защита от превращения Knowledge в "свалку всего подряд"

**Механизмы защиты:**

| Механизм | Описание |
|----------|----------|
| **Extraction threshold** | Не всё из артефакта извлекается — только knowledge-worthy |
| **Confidence gate** | Низкий confidence → Draft, не попадает в retrieval без запроса |
| **Noise detection** | Тривиальные, дублирующие, неспецифичные утверждения отфильтровываются |
| **Staleness pruning** | Устаревшие знания не предлагаются в результатах поиска |
| **Governance approval** | Критические Architectural Knowledge требуют validation |
| **Quality scoring** | Регулярная оценка качества, удаление низкокачественных знаний |
| **Duplicate detection** | Новые знания сравниваются с существующими перед сохранением |
| **Volume monitoring** | Алерт при аномальном росте числа Knowledge Entries |

---

## 10. Связь с Graph

### 10.1 Принципы связи Knowledge ↔ Graph

Связь Knowledge с Graph основана на утверждённой архитектуре:

- **Graph** — хранит структурное представление кода: Node, Edge.
- **Knowledge** — хранит инженерные знания о коде, но не сам код.
- **Knowledge Link** — связь между Knowledge Entry и Graph Node/Edge.
- **Graph не хранит само знание.** Узел KNOWLEDGE в Graph содержит только: ID знания, тип знания, ссылку на Knowledge Entry. Контент — только в Knowledge.
- **Knowledge не дублирует Graph.** Knowledge не хранит список методов класса или структуру зависимостей — это ответственность Graph.

### 10.2 Knowledge Link

**Knowledge Link** — это связь между Knowledge Entry и целевой сущностью Graph.

**Структура Knowledge Link:**
- `link_id` — уникальный идентификатор связи
- `knowledge_entry_id` — ID Knowledge Entry
- `knowledge_version` — версия Knowledge Entry, к которой относится связь
- `target_type` — NODE или EDGE
- `target_id` — ID узла или ребра в Graph
- `link_type` — тип связи (RELATES_TO, DOCUMENTS, CONSTRAINS, AFFECTS, EXEMPLIFIES, DERIVED_FROM)
- `graph_version_stamp` — версия Graph, на момент создания связи
- `created_at` — когда связь создана
- `is_valid` — актуальна ли связь (инвалидируется при изменении target)

**Типы Knowledge Link:**

| Link Type | Описание | Пример |
|-----------|----------|--------|
| `RELATES_TO` | Знание относится к узлу | ADR-0003 RELATES_TO Module:AuthService |
| `DOCUMENTS` | Знание документирует узел | Best Practice DOCUMENTS Class:UserController |
| `CONSTRAINS` | Знание накладывает ограничение | Architectural Knowledge CONSTRAINS Module:PaymentService |
| `AFFECTS` | Знание описывает влияние на узел | Risk Knowledge AFFECTS Class:DatabaseAdapter |
| `EXEMPLIFIES` | Узел является примером знания | Best Practice EXEMPLIFIES Class:WellStructuredService |
| `DERIVED_FROM` | Знание извлечено из анализа узла | Research Insight DERIVED_FROM Module:NotificationService |

### 10.3 Какие сущности Graph могут быть целями знания

| Graph Entity | Может быть целью Knowledge Link? | Пример |
|--------------|----------------------------------|--------|
| **Module Node** | Да | "Модуль Auth должен быть stateless" |
| **Class Node** | Да | "UserController должен валидировать входные данные" |
| **Method/Function Node** | Да | "createUser должен проверять уникальность email" |
| **File Node** | Да | "Файл prisma/schema.prisma — канонический источник схемы БД" |
| **Database Table Node** | Да | "Таблица users: пароли хранятся только в виде bcrypt hash" |
| **API Route Node** | Да | "POST /api/users требует role=admin" |
| **ADR Node** | Да | Связь ADR с модулем, который он затрагивает |
| **Edge (CALLS)** | Да | "Вызов UserService→EmailService должен быть асинхронным" |
| **Edge (DEPENDS_ON)** | Да | "Зависимость от библиотеки jsonwebtoken должна быть версии 9+" |
| **Task Node** | Да | Знание, порождённое задачей |
| **Run Node** | Да | Execution Insight |

### 10.4 Traceability Knowledge → Graph

**Прямая traceability:**
```
Knowledge Entry
    └── Knowledge Link (RELATES_TO, DOCUMENTS, etc.)
          └── Graph Node / Edge
```

**Обратная traceability:**
```
Graph Node
    └── INCOMING Knowledge Links
          └── Knowledge Entries
```

**Traceability через Graph Query:**
Пользователь Graph API может запросить: "все Knowledge Entries, связанные с Module:AuthService" — Knowledge предоставляет через Retrieval by Graph Link.

### 10.5 Обработка устаревания знаний после GraphUpdated

Событие `GraphUpdated` — ключевой триггер для Knowledge. После получения события:

1. **Staleness Detector** извлекает список изменённых узлов (`affected_nodes`) из события
2. Для каждого изменённого узла:
   - Поиск всех Knowledge Links, указывающих на этот узел
   - Для каждого Knowledge Entry:
     - Если изменение существенное (изменение сигнатуры, удаление метода) → пометить как `potentially_stale`
     - Если изменение несущественное (добавление комментария, форматирование) → сохранить `fresh`
     - Опубликовать `KnowledgeStaleDetected`
3. **Freshness Manager** пересчитывает `freshness_score` для затронутых знаний
4. Если узел удалён (`NodeDeleted`) → все связанные Knowledge Entries помечаются `stale`

**Правило:** Knowledge не пытается автоматически "исправить" знание после GraphUpdated. Knowledge фиксирует потенциальное устаревание и предоставляет downstream-модулям актуальную информацию. Решение о переисследовании принимает Planner или Research.

### 10.6 Как Knowledge НЕ должен подменять Graph

| Правило | Нарушение (запрещено) | Правильное поведение |
|---------|----------------------|---------------------|
| Knowledge не хранит структуру | "Класс UserService имеет методы: createUser, findById, updateUser" | Это в Graph. Knowledge может хранить: "createUser требует транзакции" |
| Knowledge не хранит списки зависимостей | "UserService зависит от EmailService, NotificationService" | Это в Graph (Edge DEPENDS_ON). Knowledge может хранить: "Зависимость от EmailService критична для транзакций" |
| Knowledge не дублирует метрики Graph | "UserService: 15 методов, 230 строк" | Это в Graph. Knowledge может хранить: "UserService: тенденция к God Object, требует декомпозиции" |

### 10.7 Как Graph НЕ должен хранить само знание вместо Knowledge

| Правило | Нарушение (запрещено) | Правильное поведение |
|---------|----------------------|---------------------|
| Graph не хранит Knowledge-контент | Graph Node KNOWLEDGE с полем `content: "UserService должен быть stateless"` | Graph Node KNOWLEDGE содержит `knowledge_id`, `knowledge_type`. Контент — только в Knowledge |
| Graph не дублирует ADR | Graph Node ADR с полным текстом решения | Graph Node ADR содержит ссылку на Knowledge ADR |
| Graph не хранит выводы Research | Graph Node RESEARCH с findings | Graph Node RESEARCH — ссылка на Research Report в Knowledge |

---

## 11. Связь с Artifacts

### 11.1 Модель Artifact Link

**Artifact Link** — связь между Knowledge Entry и артефактом, из которого (или в связи с которым) создано знание.

**Типы связей Knowledge → Artifact:**

| Тип связи | Описание |
|-----------|----------|
| `DERIVED_FROM` | Knowledge Entry извлечён из этого артефакта |
| `REFERENCES` | Knowledge Entry ссылается на этот артефакт |
| `UPDATED_BY` | Knowledge Entry обновлён на основе этого артефакта |
| `SUPERSEDED_BY_ARTIFACT` | Артефакт содержит более новую версию знания |

### 11.2 Research Report

| Аспект | Описание |
|--------|----------|
| **Хранится ли как есть?** | Да — Research Report сохраняется в Artifact Storage как полный документ |
| **Извлекается ли производное знание?** | Да — Findings, Conclusions, Recommendations, Unknowns → Knowledge Entries |
| **Связь артефакта и знания** | `Knowledge Entry --DERIVED_FROM--> Research Report Artifact` |
| **Traceability** | `Research Report → Findings (Knowledge) → Future Research → New Research Report` |

### 11.3 Impact Report

| Аспект | Описание |
|--------|----------|
| **Хранится ли как есть?** | Да — Impact Report сохраняется в Artifact Storage |
| **Извлекается ли производное знание?** | Да — Risk markers, Critical nodes, Validation scope → Risk/Architectural Knowledge |
| **Связь артефакта и знания** | `Risk Knowledge --DERIVED_FROM--> Impact Report Artifact` |
| **Traceability** | `Impact Report → Risk Knowledge → Future Impact Analysis → New Impact Report` |

### 11.4 Execution Plan

| Аспект | Описание |
|--------|----------|
| **Хранится ли как есть?** | Да — Execution Plan сохраняется в Artifact Storage |
| **Извлекается ли производное знание?** | Ограниченно: стратегии декомпозиции, acceptance criteria → Best Practice (при повторяемости) |
| **Связь артефакта и знания** | `Best Practice --DERIVED_FROM--> Execution Plan Artifact (если паттерн повторяется)` |
| **Traceability** | `Execution Plan → (при повторяемости) → Best Practice → Future Planner` |

### 11.5 Execution Report

| Аспект | Описание |
|--------|----------|
| **Хранится ли как есть?** | Да — Execution Report сохраняется в Artifact Storage |
| **Извлекается ли производное знание?** | Да — Lessons Learned, Patterns applied, Problems/Resolutions → Execution Knowledge, Lessons Learned |
| **Связь артефакта и знания** | `Lesson Learned --DERIVED_FROM--> Execution Report Artifact` |
| **Traceability** | `Execution Report → Lesson Learned → (при повторяемости) → Best Practice → Future Execution` |

### 11.6 ADR

| Аспект | Описание |
|--------|----------|
| **Хранится ли как есть?** | Да — ADR хранится и как Artifact (Markdown), и как Knowledge Entry (структурированно) |
| **Извлекается ли производное знание?** | ADR **сам является** Knowledge Entry (Architectural Knowledge) |
| **Связь артефакта и знания** | `ADR Knowledge Entry --REFERENCES--> ADR Artifact (Markdown)` |
| **Traceability** | `ADR → Architectural Knowledge → Planner, Impact Analysis` |

### 11.7 Context Package

| Аспект | Описание |
|--------|----------|
| **Хранится ли как есть?** | Нет — Context Package временный, хранится в Context Cache (Redis) |
| **Извлекается ли производное знание?** | Нет — Context Package это transient data для LLM |
| **Связь артефакта и знания** | Нет — Context Package не сохраняется как Knowledge |

### 11.8 User Decisions

| Аспект | Описание |
|--------|----------|
| **Хранится ли как есть?** | Decision Record сохраняется как Knowledge Entry |
| **Извлекается ли производное знание?** | Может быть повышено до Architectural Knowledge при значимости |
| **Связь артефакта и знания** | `Decision Record --REFERENCES--> Task (контекст решения)` |
| **Traceability** | `User Decision → Decision Record → Planner, Future Decisions` |

### 11.9 Общая Traceability Artifact → Knowledge → Future Task

```
Artifact (Research Report)
    │
    └── DERIVED_FROM → Knowledge Entry (Finding)
                            │
                            ├── используется Research Engine при новом Research
                            │       └── новый Research Report
                            │
                            ├── используется Context Builder
                            │       └── Context Package → Planner → Execution Plan
                            │
                            └── используется Impact Analysis
                                    └── Impact Report → Risk Knowledge
                                            └── будущая Impact Analysis
```

---

## 12. Versioning

### 12.1 Принципы Versioning

**Knowledge Entry версионируется как immutable log:**
- Каждая версия — неизменяемая запись
- При обновлении создаётся новая версия
- Старая версия сохраняется с `is_current_version = false`
- Полная история доступна через `knowledge_entry_id`

### 12.2 Immutable vs Mutable части Knowledge Entry

| Часть | Мутабельность | Описание |
|-------|--------------|----------|
| `knowledge_entry_id` | Immutable | Не меняется между версиями |
| `version_number` | Increment-only | 1 → 2 → 3... |
| `content`, `title`, `summary` | Immutable per version | Изменение → новая версия |
| `confidence_score` | Mutable (но version-tracked) | Может меняться при новых evidence |
| `freshness_score` | Mutable (динамический) | Пересчитывается при событиях |
| `status` | Mutable | Draft → Active → Superseded → Deprecated |
| `graph_links` | Version-specific | Привязаны к конкретной версии |
| `artifact_links` | Mutable (добавление) | Можно добавить новые DERIVED_FROM связи |
| `metadata` | Partially mutable | created_at — immutable, updated_at — mutable |

### 12.3 Superseded Knowledge

**Supersede — замещение старого знания новым.**

Правила superseding:
- Новая версия содержит ссылку `supersedes: [knowledge_entry_id, version_number]`
- Старая версия помечается `status = Superseded`, содержит `superseded_by: [new_knowledge_entry_id, new_version]`
- Superseded знание не удаляется — хранится для истории
- В результатах поиска superseded знания подавляются (если не запрошены явно)

**Когда supersede, а когда create new:**
- Если новое знание **уточняет** существующее → supersede (новая версия)
- Если новое знание **опровергает** существующее → supersede с conflict marker
- Если новое знание о **другом аспекте** той же сущности → создать отдельное знание, link как related

### 12.4 Deprecated Knowledge

**Deprecation — пометка знания как более не рекомендованного к использованию.**

Отличие от Superseded:
- **Superseded:** есть конкретное замещающее знание
- **Deprecated:** знание устарело, но замещающего знания нет

**Причины deprecation:**
- Знание более не релевантно (удалён модуль, изменён стек)
- Знание признано ошибочным
- Знание не используется и не проверялось длительное время

### 12.5 Lineage

**Lineage Knowledge Entry отслеживает полную цепочку происхождения:**

```
Knowledge Entry (v3) [current]
    │ supersedes
    ▼
Knowledge Entry (v2) [superseded]
    │ supersedes
    ▼
Knowledge Entry (v1) [superseded]
    │ derived_from
    ▼
Artifact: Research Report #42
    │ derived_from
    ▼
Task #42
```

### 12.6 Связь с Graph Version

Каждая версия Knowledge Entry сохраняет `graph_version_stamp` — версию Graph, на основе которой создано знание.

При `GraphUpdated`:
- Если `graph_version_stamp` знания меньше текущей версии Graph
- И связанные узлы изменились
- → Знание помечается `potentially_stale`

### 12.7 Связь с Commit Hash

Каждая версия Knowledge Entry сохраняет `commit_hash` — хэш коммита, на котором основано знание.

**Использование:**
- Точное определение состояния кода на момент создания знания
- Возможность checkout и верификации
- Связь с Git blame для определения, кто изменил затронутый код

### 12.8 Связь с Task / Run / Artifact Lineage

```
Knowledge Entry v1
    │ derived_from
    ▼
Artifact: Execution Report
    │ produced_by
    ▼
Run #15
    │ part_of
    ▼
Task #42
```

При повторном использовании знания в Task #78:
```
Knowledge Entry v1 (updated)
    │ used_in
    ▼
Task #78 → Run #31 → Execution Report → (обновление Knowledge)
```

### 12.9 Rollback и Resync

**Rollback версии Knowledge Entry:**
- Не откатывает версию, а создаёт **новую версию** с контентом предыдущей
- Причина rollback сохраняется в metadata
- Пример: v3 создана ошибочно → v4 = копия v2 с metadata `rollback_from: v3, reason: ...`

**Resync после перестройки Graph:**
- Все Knowledge Entries с `graph_version_stamp < текущая версия Graph` → помечаются `potentially_stale`
- Знания с `graph_version_stamp = текущая версия Graph` → сохраняют статус
- Инициируется массовая проверка freshness

---

## 13. Freshness и Staleness

### 13.1 Почему знание стареет

Знание стареет, потому что кодовая база эволюционирует, а знание отражает состояние на момент создания. Причины устаревания:

| Причина | Механизм устаревания |
|---------|---------------------|
| **Изменение связанного кода** | GraphUpdated → связанные узлы изменены → знание может быть более не точным |
| **Удаление связанного кода** | NodeDeleted → знание о несуществующей сущности → stale |
| **Смена архитектурного решения** | ADR superseded/deprecated → Architectural Knowledge более не актуально |
| **Новые Research данные** | Новый Research Report опровергает предыдущий Finding |
| **Временной фактор** | Знание не проверялось долгое время → freshness снижается |
| **Изменение внешних зависимостей** | External Knowledge Reference → внешний источник мог измениться |
| **Изменение инструментов/стека** | Project Knowledge о версиях фреймворков устаревает при обновлении |

### 13.2 Как определяется Freshness

**Freshness Score** — числовая оценка (0.0–1.0), где 1.0 = полностью актуально.

**Базовая формула Freshness:**

```
freshness_score = base_freshness × graph_link_factor × time_factor × evidence_factor
```

| Фактор | Описание | Вес |
|--------|----------|-----|
| **base_freshness** | Начальная свежесть: 1.0 для нового знания | — |
| **graph_link_factor** | 1.0 если все связанные узлы не изменились; 0.8 если есть несущественные изменения; 0.5 если существенные изменения; 0.2 если узлы удалены | Высокий |
| **time_factor** | 1.0 если знание создано <7 дней назад; 0.9 для <30 дней; 0.7 для <90 дней; 0.5 для <365 дней; 0.3 для >365 дней | Средний |
| **evidence_factor** | 1.0 если подтверждено ≥3 задачами; 0.8 если 2 задачами; 0.6 если 1 задачей; 0.4 если не подтверждено | Средний |

### 13.3 Как определяется Staleness

**Staleness — бинарный или градиентный статус.**

| Статус | Freshness Score | Описание |
|--------|----------------|----------|
| **fresh** | ≥0.8 | Знание актуально |
| **potentially_stale** | 0.5–0.8 | Знание может быть неактуальным — требуется проверка |
| **stale** | 0.3–0.5 | Знание устарело — использовать с осторожностью |
| **definitely_stale** | <0.3 | Знание определённо неактуально — не использовать |

### 13.4 Какие события влияют на устаревание

| Событие | Влияние на Freshness |
|---------|---------------------|
| **GraphUpdated** | Пересчёт graph_link_factor для всех Knowledge Entries, связанных с affected_nodes |
| **NodeDeleted** | graph_link_factor → 0.2 для связанных знаний, если нет других связей |
| **NodeCreated** | Не влияет на существующие знания напрямую |
| **GraphVersionCreated** | Все знания с graph_version_stamp < предыдущая версия графа → проверка |
| **ADRUpdated** | Связанные Architectural Knowledge → проверка на superseding |
| **ResearchCompleted** | Если новый Research противоречит существующему Finding → пометка конфликта |
| **TaskCompleted** | Если Execution Report подтверждает знание → evidence_factor повышается |
| **Время** | Периодический пересчёт time_factor |

### 13.5 Как влияет GraphUpdated

При получении `GraphUpdated(affected_nodes)`:

1. Для каждого узла в `affected_nodes` → поиск всех Knowledge Links
2. Оценка типа изменения:
   - **Minor** (добавление комментария, форматирование) → graph_link_factor остаётся 1.0
   - **Moderate** (изменение реализации метода, добавление метода) → graph_link_factor = 0.8
   - **Major** (изменение сигнатуры, изменение типа возврата) → graph_link_factor = 0.5
   - **Breaking** (удаление метода, удаление класса, изменение API) → graph_link_factor = 0.2
3. Пересчёт freshness_score
4. Если freshness_score < 0.5 → KnowledgeStaleDetected

### 13.6 Как влияет смена архитектурного решения

При `ADRUpdated(status = Superseded)` или `ADRDeprecated`:

1. Поиск всех Knowledge Entries, ссылающихся на этот ADR
2. Если ADR superseded новым ADR:
   - Architectural Knowledge, основанное на старом ADR → помечается `superseded`
   - Связанные Operational/Risk знания → помечаются `potentially_stale`
3. Если ADR deprecated без замены:
   - Связанные знания → `stale`

### 13.7 Как влияет изменение кода без подтверждения старых выводов

**Периодическая проверка (cron):**
- Для всех Knowledge Entries, где `last_validated_at < [30 дней]` и `graph_version_stamp < текущая версия Graph`
- Если связанные узлы в Graph изменились → freshness снижается
- Если знание не имеет связанных узлов (orphan) и не подтверждено → freshness снижается по time_factor

### 13.8 Partially Stale Knowledge

**Знание может быть частично устаревшим:**

Пример: "UserService должен быть stateless и использовать Redis для кэширования"
- Stateless-часть: связанный узел UserService изменился → эта часть potentially_stale
- Redis-часть: связанный узел RedisConfig не изменился → эта часть fresh

**Реализация Partially Stale:**
- Knowledge Entry содержит массив `staleness_segments`: для каждой части знания указан свой freshness_score
- Retrieval возвращает overall freshness (минимальный среди segments) и предупреждение о частичном устаревании

### 13.9 Как Consumers должны видеть степень актуальности

**Retrieval Result включает:**

```
{
  knowledge_entry: { ... },
  freshness: {
    score: 0.65,
    status: "potentially_stale",
    staleness_reasons: [
      {
        type: "graph_changed",
        node_id: "node_123",
        change_type: "major",
        description: "UserService.createUser signature changed"
      },
      {
        type: "time_passed",
        last_validated_at: "2026-04-01T..."
      }
    ],
    partially_stale: [
      { segment: "stateless_requirement", freshness: 0.4 },
      { segment: "redis_caching", freshness: 0.9 }
    ]
  }
}
```

---

## 14. Retrieval Model

### 14.1 Принципы Retrieval

**Retrieval Model** определяет, как downstream-модули запрашивают и получают знания из Knowledge.

**Общие принципы:**
1. **Pull-based:** Downstream-модуль явно запрашивает Knowledge
2. **Context-aware:** Retrieval учитывает контекст запроса (task type, target module, scope)
3. **Freshness-filtered:** По умолчанию stale/superseded знания не возвращаются
4. **Ranked:** Результаты ранжированы по релевантности, свежести, confidence

### 14.2 Retrieval Strategies

#### 14.2.1 Retrieval by Graph Link

Запрос: "Все Knowledge Entries, связанные с Graph Node X"

**Параметры:**
- `target_node_id` — ID узла в Graph
- `link_types` — фильтр по типам связей (RELATES_TO, CONSTRAINS, DOCUMENTS, etc.)
- `include_transitive` — включать ли знания, связанные с соседними узлами

**Используют:** Impact Analysis, Context Builder, Research

#### 14.2.2 Retrieval by Task Type

Запрос: "Best Practices и Lessons Learned для задач типа 'add API endpoint'"

**Параметры:**
- `task_type` — категория задачи
- `knowledge_types` — Architectural, Execution, Best Practice, Lesson Learned

**Используют:** Planner, Execution (Developer Agent)

#### 14.2.3 Retrieval by Artifact Lineage

Запрос: "Все знания, производные от Research Report #42"

**Параметры:**
- `artifact_id` — ID артефакта
- `traversal_depth` — глубина обхода lineage (derived_from → derived_from → ...)

**Используют:** Research (для проверки предыдущих результатов)

#### 14.2.4 Retrieval by Semantic Similarity

Запрос: "Знания, семантически похожие на этот текст/задачу"

**Параметры:**
- `query_text` — текст запроса
- `similarity_threshold` — минимальный порог схожести (0.7 по умолчанию)
- `max_results` — ограничение по количеству

**Используют:** Research, Context Builder, Planner

#### 14.2.5 Retrieval by Recency

Запрос: "Самые свежие знания о модуле X"

**Параметры:**
- `time_range` — временной диапазон (7d, 30d, 90d, all)
- `sort_by` — recency, relevance

**Используют:** Context Builder (для включения актуального контекста)

#### 14.2.6 Retrieval by Confidence

Запрос: "Только high-confidence знания для архитектурного решения"

**Параметры:**
- `min_confidence` — минимальный confidence score (0.8 по умолчанию для критических решений)
- `knowledge_types` — фильтр по типам

**Используют:** Planner (для критических решений)

#### 14.2.7 Retrieval by Knowledge Type

Запрос: "Все Architectural Knowledge, относящиеся к модулю Auth"

**Параметры:**
- `knowledge_types` — Architectural, Risk, Best Practice, etc.
- `scope_filter` — project, module, file, symbol

**Используют:** Все модули

#### 14.2.8 Retrieval by Project Scope

Запрос: "Все знания уровня module для модуля UserService"

**Параметры:**
- `scope` — project, module, file, symbol
- `scope_id` — конкретный идентификатор (module_id, file_path, symbol_id)

**Используют:** Impact Analysis, Context Builder

#### 14.2.9 Retrieval by Decision Scope

Запрос: "Все ADR и решения, связанные с базой данных"

**Параметры:**
- `decision_domain` — database, api, architecture, security, etc.
- `include_superseded` — включать ли superseded ADR

**Используют:** Planner, Research

### 14.3 Retrieval для конкретных Consumers

#### 14.3.1 Retrieval для Research

**Контекст:** Research Engine формирует исследовательские вопросы о задаче.

**Что запрашивает:**
- Prior Research Retrieval: Research Reports и Findings по похожим задачам
- ADR Registry: архитектурные решения, релевантные модулям задачи
- Historical Decisions: история решений в затрагиваемых модулях
- Retrieval by Graph Link: знания, связанные с модулями из задачи

**Цель:** Дать Research Engine отправную точку — что уже известно о задаче, что уже исследовано, какие решения приняты.

#### 14.3.2 Retrieval для Impact Analysis

**Контекст:** Impact Analysis Engine анализирует зону влияния изменения.

**Что запрашивает:**
- Risk History: исторические риски для затрагиваемых модулей
- Prior Impact Retrieval: blast radius из предыдущих задач в этих же модулях
- Retrieval by Graph Link: Architectural Knowledge и Constraints, связанные с affected nodes

**Цель:** Обогатить Impact Report историческими данными о рисках и известных ограничениях.

#### 14.3.3 Retrieval для Context Builder

**Контекст:** Context Builder собирает контекст для LLM.

**Что запрашивает:**
- Retrieval by Semantic Similarity: знания, релевантные Research Report и задаче
- Retrieval by Recency: самые свежие знания о затрагиваемых модулях
- Retrieval by Confidence: high-confidence Best Practices и Architectural Knowledge
- Linked Knowledge References: знания, непосредственно связанные с affected nodes

**Цель:** Включить в контекст релевантные исторические знания, не перегружая окно модели.

#### 14.3.4 Retrieval для Planner

**Контекст:** Planner строит Execution Plan.

**Что запрашивает:**
- ADR Registry: все принятые архитектурные решения
- Retrieval by Decision Scope: решения в релевантных доменах
- Lessons Learned: уроки из аналогичных задач
- Best Practices: проверенные паттерны для типа задачи

**Цель:** Обеспечить Planner полной картиной архитектурных ограничений и проверенных подходов.

#### 14.3.5 Retrieval для будущих модулей

**Принцип:** Retrieval API спроектирован как стабильный контракт. Новые модули могут использовать любую комбинацию retrieval strategies. Knowledge не должен знать о конкретных consumers, кроме как через API-контракт.

---

## 15. Search and Ranking

### 15.1 Search Architecture

```
Query
  │
  ├──→ Full-Text Searcher (PostgreSQL tsvector)
  │     │  • Лексический поиск
  │     │  • Фразовый поиск
  │     │  • Фильтрация по метаданным
  │     │
  │     └──→ Full-Text Results (TF-IDF ranked)
  │
  ├──→ Semantic Searcher (pgvector / Vector Store)
  │     │  • Embedding generation (query → vector)
  │     │  • ANN (Approximate Nearest Neighbor)
  │     │  • Cosine similarity
  │     │
  │     └──→ Semantic Results (similarity ranked)
  │
  └──→ Hybrid Aggregator
        │  • Reciprocal Rank Fusion (RRF)
        │  • Weighted scoring
        │  • Deduplication
        │
        └──→ Merged Results → Ranking Engine → Final Results
```

### 15.2 Полнотекстовый поиск

**Реализация:** PostgreSQL full-text search (tsvector/tsquery)

**Индексация:**
- `tsvector` на полях: `title`, `summary`, `content`
- Поддержка языков: English, Russian (конфигурация `english`, `russian`)
- Автоматическое обновление tsvector через GIN index

**Когда эффективен:**
- Точные запросы ("postgresql row level security")
- Поиск по ключевым словам и терминам
- Запросы с известной технической терминологией

### 15.3 Семантический поиск

**Реализация:** pgvector с embedding от Embedding Provider

**Процесс:**
1. Query → Embedding Provider → query_vector
2. query_vector → pgvector ANN index → nearest neighbors
3. Cosine similarity ≥ threshold (0.7 по умолчанию)

**Когда эффективен:**
- Нечёткие запросы ("как мы решали проблему с авторизацией?")
- Поиск концептуально похожих знаний
- Запросы на естественном языке

### 15.4 Hybrid Retrieval

**Reciprocal Rank Fusion (RRF):**

```
RRF_score(d) = Σ (1 / (k + rank_i(d)))
```
где:
- `d` — документ (Knowledge Entry)
- `rank_i(d)` — ранг документа в i-том поисковом методе
- `k` — константа сглаживания (обычно 60)

**Веса методов:**
- Full-text: вес 0.4
- Semantic: вес 0.6 (если query — естественный язык)
- Full-text: вес 0.6, Semantic: вес 0.4 (если query — технический)

### 15.5 Ranking Relevance

**Итоговый ranking score:**

```
final_score = w1 × retrieval_score + w2 × freshness_score + w3 × confidence_score + w4 × graph_relevance_score
```

| Фактор | Вес по умолчанию | Описание |
|--------|-----------------|----------|
| `retrieval_score` | 0.35 | RRF score из поиска |
| `freshness_score` | 0.25 | Актуальность знания |
| `confidence_score` | 0.25 | Уверенность в знании |
| `graph_relevance_score` | 0.15 | Степень связи с графом (0 если нет связей, 1 если прямая связь с affected nodes) |

### 15.6 Freshness-Aware Ranking

**Freshness влияет на ranking двумя способами:**
1. Непосредственно через `freshness_score` в формуле ranking
2. Stale знания (freshness < 0.3) исключаются из результатов по умолчанию

**Staleness penalty:**
- `potentially_stale`: penalty 0.2 к итоговому score
- `stale`: исключение (или penalty 0.5, если явно запрошены)

### 15.7 Confidence-Aware Ranking

**Confidence влияет на ranking:**
1. Через `confidence_score` в формуле ranking
2. Низкий confidence (<0.5) → knowledge помечается как `low_confidence` в результатах
3. Критические Architectural Knowledge с низким confidence → warning потребителю

### 15.8 Architecture-Priority Ranking

**Architectural Knowledge имеет приоритет при ranking:**
- ADR → буст 1.3× к retrieval_score
- Architectural Knowledge → буст 1.2×
- Best Practice → буст 1.1×
- Lesson Learned → без буста
- External Knowledge Reference → penalty 0.9×

**Правило:** Если задача затрагивает модуль, для которого есть ADR — ADR должен быть в топе результатов.

### 15.9 Suppression of Obsolete Knowledge

**Автоматически подавляются:**
- Superseded знания (если не запрошены явно)
- Deprecated знания
- Stale знания (freshness < 0.3)
- Low-confidence знания при запросе с `min_confidence > confidence`

**Не подавляются, но помечаются:**
- Potentially stale знания — возвращаются с предупреждением
- Знания с активными конфликтами — возвращаются с conflict marker

### 15.10 Conflict-Aware Ranking

**Знания с обнаруженными конфликтами:**
- Ранжируются ниже (penalty 0.2)
- Помечаются `has_active_conflicts: true`
- В результатах предоставляется ссылка на конфликтующее знание
- Потребитель (Planner, Context Builder) сам решает, использовать ли конфликтующее знание

---

## 16. Knowledge Quality

### 16.1 Критерии качественного знания

**Качественное знание — это знание, которое проходит все следующие проверки:**

| Критерий | Описание | Проверка |
|----------|----------|----------|
| **Точность (Accuracy)** | Соответствует реальному состоянию проекта | Сравнение с Graph, проверка evidence |
| **Полнота (Completeness)** | Содержит достаточно контекста для понимания | Проверка наличия: title, summary, context, content |
| **Ясность (Clarity)** | Сформулировано чётко, без двусмысленности | Лингвистические проверки |
| **Проверяемость (Verifiability)** | Может быть подтверждено через evidence | Наличие ссылок на Graph, тесты, артефакты |
| **Переиспользуемость (Reusability)** | Применимо к будущим задачам | Оценка специфичности и обобщённости |
| **Актуальность (Freshness)** | Соответствует текущему состоянию кода | Freshness score ≥ 0.7 |
| **Непротиворечивость (Consistency)** | Не противоречит другим знаниям | Conflict detection |

### 16.2 Confidence Knowledge-Entry

**Confidence Score** — агрегированная оценка уверенности в знании (0.0–1.0).

**Факторы Confidence:**

| Фактор | Вес | Описание |
|--------|-----|----------|
| **Source Trust** | 0.30 | Доверие к источнику: ADR > Execution Report > Research Report > External |
| **Evidence Quality** | 0.30 | Наличие и качество evidence: graph_link, test_results, multiple_sources |
| **Corroboration** | 0.20 | Подтверждение другими знаниями или задачами |
| **Specificity** | 0.10 | Насколько конкретно утверждение (не общая фраза) |
| **Age Factor** | 0.10 | Возраст знания (новизна как фактор confidence) |

**Шкала Confidence:**

| Уровень | Score | Описание |
|---------|-------|----------|
| **High** | ≥0.8 | Можно использовать для принятия архитектурных решений |
| **Medium** | 0.5–0.8 | Можно использовать как рекомендацию |
| **Low** | 0.3–0.5 | Только как справочная информация, с предупреждением |
| **Unreliable** | <0.3 | Не использовать без дополнительной верификации |

### 16.3 Evidence Requirements

**Минимальные evidence requirements по типу знания:**

| Тип знания | Минимальный evidence |
|------------|---------------------|
| **Architectural Knowledge** | ADR reference или ≥2 Graph Links + тесты |
| **Best Practice** | ≥3 Execution Reports, подтверждающих успешность |
| **Lesson Learned** | Execution Report reference + конкретный outcome |
| **Research Insight** | Research Report reference + Graph Links |
| **Risk Knowledge** | Impact Report reference + Graph Links |
| **External Knowledge** | Source URL + retrieval date + explicit confidence reduction |

**Evidence validation:**
1. Проверка, что ссылки на Graph актуальны (узлы существуют)
2. Проверка, что ссылки на артефакты валидны
3. Проверка, что Execution Report содержит подтверждение (для Best Practice)

### 16.4 Traceability Requirements

**Каждое Knowledge Entry должно обеспечивать traceability:**

| Traceability | Описание |
|--------------|----------|
| **Source Traceability** | Откуда произошло знание: artifact_id, task_id, adr_id |
| **Subject Traceability** | К чему относится: graph_node_id, module_id, file_path |
| **Decision Traceability** | На основе какого решения: adr_id, decision_id |
| **Version Traceability** | Полная история версий с изменениями |
| **Usage Traceability** | В каких задачах использовалось (task_ids) |

### 16.5 Anti-Hallucination Rules

**Knowledge должен защищаться от галлюцинаций (неверных выводов, сгенерированных LLM):**

| Правило | Описание |
|---------|----------|
| **No evidence, no knowledge** | Знание без evidence (хотя бы одной ссылки на Graph, артефакт или тест) получает confidence < 0.5 |
| **Source attribution обязательна** | Каждое знание должно указывать источник |
| **LLM-generated ≠ authoritative** | Знание, извлечённое из LLM-ответа, маркируется как `source_confidence: derived_from_llm` с понижением confidence |
| **Contradiction with Graph = staleness** | Если знание противоречит текущему состоянию Graph, оно помечается stale |
| **Unverifiable claims flagged** | Непроверяемые утверждения ("возможно", "вероятно") снижают confidence |

### 16.6 Anti-Duplication Rules

| Правило | Описание |
|---------|----------|
| **Exact duplicate → merge** | Если новое знание идентично существующему — не создавать новое, обновить evidence существующего |
| **Near-duplicate → link** | Если знания очень похожи — связать как related, не дублировать |
| **Same subject, different aspect → separate** | Разные аспекты одной сущности — разные Knowledge Entries |
| **Duplicate detection pre-save** | Перед сохранением проверять на semantic dedup |

### 16.7 Anti-Noise Rules

| Правило | Описание |
|---------|----------|
| **Specificity gate** | Знание должно быть специфичным (относиться к конкретному модулю, паттерну, решению) |
| **Actionability gate** | Знание должно быть actionable — позволять принять решение в будущем |
| **Information density gate** | Короткие, тривиальные утверждения ("UserService важен") — reject |
| **Volume monitoring** | Аномальный рост Knowledge Entries → алерт, проверка качества ingestion |

### 16.8 Why-This-Knowledge-Exists Principle

**Каждое Knowledge Entry должно иметь явно задокументированную причину существования:**

- `origin_reason` — почему это знание было создано (task, adr, research, user_decision, derived)
- `creation_context` — в каком контексте (task description summary, adr context)
- `intended_use` — для каких будущих ситуаций предназначено

---

## 17. Conflict Resolution

### 17.1 Принцип: хранить конфликт, а не скрывать его

**Фундаментальный принцип Knowledge Conflict Resolution:**

> Система не должна автоматически разрешать конфликты между знаниями, удаляя или скрывая одно из них. Вместо этого, Knowledge **обнаруживает конфликт, классифицирует его, сохраняет обе стороны и предоставляет conflict-aware retrieval**.

Причина: автоматическое разрешение инженерных противоречий — это архитектурное решение, которое может принимать только Planner или пользователь.

### 17.2 Конфликт между знаниями (Knowledge vs Knowledge)

**Определение:** Два Knowledge Entry, относящиеся к одному subject (модуль, класс, паттерн), содержат противоречащие утверждения.

**Пример:**
- Knowledge A (ADR-0003): "UserService должен быть stateless"
- Knowledge B (Execution Insight #78): "UserService хранит состояние сессии в Redis — это допустимо"

**Действия Knowledge:**
1. Обнаружить семантическое противоречие (semantic contradiction detection)
2. Создать Conflict Record: `{ type: "knowledge_vs_knowledge", entries: [A, B], detected_at, severity }`
3. Связать оба Knowledge Entry с Conflict Record
4. Понизить ranking для обоих (conflict penalty)
5. Опубликовать `KnowledgeConflictDetected`
6. **Не удалять, не скрывать** ни одно из знаний

### 17.3 Конфликт между старым и новым знанием

**Определение:** Новая версия Knowledge Entry противоречит предыдущей версии.

**Действия Knowledge:**
1. При version update — semantic сравнение с предыдущей версией
2. Если обнаружено противоречие:
   - Новая версия создаётся с `supersedes: [old_version_id]`
   - Conflict Record создаётся, если противоречие не разрешено (например, разные источники дают разные выводы)
   - Старая версия не удаляется

### 17.4 Конфликт Graph vs Knowledge

**Определение:** Knowledge Entry содержит утверждение, которое противоречит текущему состоянию Graph.

**Пример:**
- Knowledge: "UserController имеет метод createUser"
- Graph: Node UserController.deleteUser существует, Node UserController.createUser — нет (был удалён)

**Действия Knowledge:**
1. При GraphUpdated → Staleness Detector проверяет связанные знания
2. Если Graph противоречит Knowledge → `staleness_reason = "graph_contradiction"`
3. Freshness score → 0.2 (definitely_stale)
4. Conflict Record создаётся
5. Опубликовать `KnowledgeStaleDetected`

### 17.5 Конфликт ADR vs Execution History

**Определение:** ADR устанавливает архитектурное правило, но Execution Reports показывают, что правило систематически нарушается.

**Пример:**
- ADR-0005: "Все API-запросы должны проходить через API Gateway"
- Execution Reports: 5 последних задач добавили прямые вызовы между сервисами

**Действия Knowledge:**
1. При TaskCompleted → сравнение с релевантными ADR
2. Если обнаружено систематическое расхождение (≥3 tasks) → Conflict Record
3. Конфликт: ADR vs Execution Reality
4. Опубликовать `KnowledgeConflictDetected` (severity: HIGH — архитектурное расхождение)

### 17.6 Конфликт External Knowledge vs Project Reality

**Определение:** External Knowledge Reference содержит утверждение, которое не соответствует реальности проекта.

**Пример:**
- External Knowledge: "Prisma v5 поддерживает миграции без блокировок"
- Project Reality: В проекте миграции Prisma вызывают блокировки таблиц

**Действия Knowledge:**
1. При сопоставлении External Knowledge с Execution Reports → detection
2. Conflict Record с severity MEDIUM
3. External Knowledge помечается `confidence_reduced: true`

### 17.7 Conflict Between Multiple Historical Reports

**Определение:** Два Research Report или Impact Report по одной и той же теме содержат противоречащие выводы.

**Действия Knowledge:**
1. При сравнении нового Research Report с историческими → semantic comparison
2. Если противоречие обнаружено → Conflict Record
3. Оба Finding сохраняются, связываются с Conflict Record
4. При retrieval — оба возвращаются с пометкой конфликта

### 17.8 Conflict Record Structure

```
ConflictRecord {
  conflict_id: UUID
  conflict_type: "knowledge_vs_knowledge" | "old_vs_new" |
                 "graph_vs_knowledge" | "adr_vs_execution" |
                 "external_vs_reality" | "historical_reports"
  entries: [knowledge_entry_id, ...]  // конфликтующие записи
  severity: "critical" | "high" | "medium" | "low"
  description: string  // описание противоречия
  detected_at: timestamp
  detected_by: "ingestion" | "staleness_detector" | "periodic_check"
  status: "active" | "resolved" | "acknowledged"
  resolution: {  // если разрешён
    resolved_by: "planner" | "user" | "new_evidence"
    resolution_note: string
    winning_entry: knowledge_entry_id  // какое знание признано верным
    resolved_at: timestamp
  }
}
```

---

## 18. Knowledge Governance

### 18.1 Кто имеет право создавать знание

| Источник | Право создавать? | Условия |
|----------|-----------------|---------|
| **Research Engine** | Да | Автоматически при ResearchCompleted |
| **Impact Analysis Engine** | Да | Автоматически при ImpactAnalysisCompleted |
| **Planner** | Ограниченно | Только ADR (proposed) и Architectural Constraints |
| **Execution Engine** | Да | Автоматически при TaskCompleted |
| **User** | Да | Через API (ADR, Decisions) |
| **System (Diagnostics)** | Да | Только Operational Knowledge |
| **External (непроверенный источник)** | Нет | Только через Research Engine |

### 18.2 Trusted Sources

**Trusted Sources — источники, знания от которых принимаются без дополнительной валидации:**

| Источник | Trust Level | Примечание |
|----------|-------------|------------|
| **ADR (Accepted)** | Full trust | Архитектурное решение принято |
| **Execution Report (Success)** | High trust | Подтверждено тестами и review |
| **Research Report (High confidence)** | Medium trust | Требует evidence |
| **Execution Report (Failed)** | Medium trust | Negative knowledge — ценно, но контекстуально |
| **Impact Report** | Medium trust | Зависит от качества Graph |
| **User Decision** | High trust | Пользователь явно принял решение |
| **External Source** | Low trust | Всегда с пониженным confidence |

### 18.3 Какие источники требуют Validation

| Тип знания | Требует валидации? | Процесс валидации |
|------------|-------------------|-------------------|
| **Architectural Knowledge (не из ADR)** | Да | Проверка Planner или User |
| **Best Practice (новый)** | Да | ≥3 подтверждения из Execution Reports |
| **External Reference Knowledge** | Да | Всегда помечается как low confidence |
| **Research Insight (low confidence)** | Да | Проверка при следующем Research |
| **Derived Knowledge** | Да | Двойная проверка derivation logic |

### 18.4 Когда знание должно быть Promoted

| Promotion | Условия |
|-----------|---------|
| **Draft → Active** | Прошёл Quality Gate (confidence ≥ 0.5, есть evidence) |
| **Lesson Learned → Best Practice** | ≥3 успешных применения в разных задачах |
| **Research Insight → Architectural Knowledge** | Подтверждено ADR или ≥3 задачами |
| **Temporary → Persistent** | ≥3 подтверждения актуальности, прошло ≥30 дней |

### 18.5 Когда знание должно быть Deprecated

| Условие Deprecation | Действие |
|---------------------|----------|
| **Связанный код удалён** (NodeDeleted) | Deprecate immediately |
| **Знание опровергнуто новым Research** | Deprecate with superseded_by |
| **ADR отменён** | Deprecate связанные Architectural Knowledge |
| **Freshness < 0.2 в течение >90 дней** | Deprecate (без автоматического удаления) |
| **Не используется ≥1 год** | Предложить к deprecation (manual review) |

### 18.6 Когда знание нельзя использовать без Warning

| Условие | Warning |
|---------|---------|
| **Freshness < 0.5** | "Это знание может быть устаревшим. Связанный код изменился." |
| **Confidence < 0.5** | "Низкая уверенность в этом знании. Рекомендуется верификация." |
| **Active Conflict** | "Это знание имеет неразрешённый конфликт с другим знанием. Ознакомьтесь с обеими сторонами." |
| **Derived Knowledge без прямой evidence** | "Это знание является производным. Проверьте исходные данные." |
| **External Reference** | "Внешний источник. Актуальность не гарантирована." |

### 18.7 Как защищаться от мусорного Knowledge Ingestion

| Механизм защиты | Описание |
|-----------------|----------|
| **Extraction Threshold** | Не каждый артефакт порождает Knowledge — только knowledge-worthy |
| **Quality Gate** | Knowledge Entries с confidence < 0.3 сохраняются как Draft, не индексируются |
| **Duplicate Detection** | Жёсткая проверка на дубликаты перед сохранением |
| **Noise Filter** | Тривиальные/неспецифичные утверждения отсекаются |
| **Volume Rate Limiting** | Максимум N новых Knowledge Entries в час (защита от runaway extraction) |
| **Governance Review Queue** | Architectural Knowledge (не из ADR) требует approval |
| **Periodic Cleanup** | Автоматический deprecation для stale > 180 дней |
| **Source Validation** | Непроверенные источники → пониженный confidence |

---

## 19. Diagnostics and Statistics

### 19.1 Ключевые метрики

| Метрика | Описание | Порог алерта |
|---------|----------|-------------|
| **Total Knowledge Entries** | Общее количество Knowledge Entries | Аномальный рост >200% в день |
| **Active Knowledge Entries** | Записи со статусом Active | — |
| **Draft Knowledge Entries** | Записи, ожидающие validation | >10% от total |
| **Superseded Ratio** | Доля superseded знаний | >30% → возможно, слишком агрессивное superseding |
| **Deprecated Ratio** | Доля deprecated знаний | >20% → нужна очистка |
| **Stale Ratio** | Доля знаний с freshness < 0.5 | >30% → кризис актуальности |
| **Orphaned Knowledge Links** | Knowledge Links, указывающие на удалённые Graph Nodes | >0 → требуют внимания |
| **Duplicate Clusters** | Группы семантически дублирующих знаний | >5 в кластере → проблема dedup |
| **Retrieval Hit Rate** | Доля retrieval запросов с непустым результатом | <50% → плохое покрытие |
| **Avg Retrieval Precision** | Relevancy retrieved results | <0.6 → проблема ranking |
| **Ingestion Error Rate** | Доля проваленных ingestion | >5% → проблема |
| **Avg Ingestion Time** | Среднее время обработки артефакта | >5 сек → проблема производительности |
| **Confidence Distribution** | Распределение знаний по confidence | >20% low confidence → проблема качества |

### 19.2 Coverage by Module

**Метрика покрытия знаний по модулям проекта:**

```
Module: AuthService
  Architectural Knowledge: 3
  Risk Knowledge: 2
  Best Practices: 1
  Lessons Learned: 5
  Execution Insights: 12
  Total: 23

Module: PaymentService
  Architectural Knowledge: 1
  Risk Knowledge: 5
  Lessons Learned: 2
  Total: 8
```

**Алерт:** Модули с нулевым покрытием при высокой частоте изменений → рекомендация исследовать.

### 19.3 Staleness Tracking

| Метрика | Описание |
|---------|----------|
| **Stale Knowledge Count** | Количество знаний со статусом stale |
| **Staleness Reasons Distribution** | `graph_changed` vs `time_passed` vs `adr_superseded` vs `node_deleted` |
| **Avg Time to Staleness** | Среднее время от создания до пометки stale |
| **Staleness by Module** | Какие модули имеют больше всего устаревших знаний |

### 19.4 Retrieval Statistics

| Метрика | Описание |
|---------|----------|
| **Retrieval Requests by Consumer** | Research vs Impact Analysis vs Context Builder vs Planner |
| **Retrieval Requests by Strategy** | Graph Link vs Semantic vs Recency vs Task Type |
| **Avg Retrieval Time** | Время ответа на retrieval запрос |
| **Top Queried Modules** | Модули с наибольшим числом retrieval запросов |
| **Zero-Result Queries** | Запросы без результатов (пробелы в знаниях) |

### 19.5 Quality Score Distribution

**Распределение Knowledge Entries по Quality Score (гистограмма):**
- 0.0–0.2: Критически низкое качество
- 0.2–0.4: Низкое качество
- 0.4–0.6: Среднее качество
- 0.6–0.8: Хорошее качество
- 0.8–1.0: Отличное качество

**Алерт:** Сдвиг распределения влево → системная проблема ingestion/extraction.

### 19.6 Health Dashboard

**Доступные через API Knowledge диагностические данные:**
- Текущее состояние всех Knowledge Entries
- Активные конфликты
- Статистика freshness
- Статистика retrieval
- Ingestion pipeline health
- Error log (последние N ошибок)

---

## 20. Производительность

### 20.1 Caching

| Cache Level | Что кэшируется | TTL | Invalidation |
|-------------|---------------|-----|-------------|
| **Retrieval Result Cache** | Результаты частых retrieval запросов | 5 мин | KnowledgeUpdated, GraphUpdated |
| **Freshness Score Cache** | Предвычисленные freshness scores | 1 мин | GraphUpdated, NodeDeleted |
| **Graph Link Cache** | Knowledge Links для частозапрашиваемых узлов | 10 мин | KnowledgeLinkedToGraph, NodeDeleted |
| **ADR Registry Cache** | Полный реестр ADR | 30 мин | ADRUpdated |
| **Embedding Cache** | Embedding для частозапрашиваемых Knowledge Entries | Persistent (in pgvector) | KnowledgeUpdated |

### 20.2 Vector Index Reuse

- **pgvector IVFFlat/HNSW index:** Индекс обновляется инкрементально при добавлении новых embedding
- **Не перестраивать индекс при каждом новом Knowledge Entry:** использовать `lists` parameter для баланса speed/recall
- **Периодический REINDEX:** раз в сутки или при добавлении >10% новых знаний

### 20.3 Batch Ingestion

- При первичной инициализации или resync: группировка артефактов в batch-ы
- Batch size: 50–100 артефактов
- Параллельная обработка в пределах batch
- Последовательная обработка batch-ей

### 20.4 Dedup Reuse

- **Semantic Dedup Cache:** Хранение embedding существующих Knowledge Entries для быстрой проверки на дубликаты
- **Exact Match Index:** Bloom filter для быстрой проверки на точные дубликаты
- **Lazy Dedup:** Полная semantic dedup только при ingestion, не при retrieval

### 20.5 Lazy Hydration

- **Knowledge Entry в retrieval results:** возвращается `knowledge_entry_id` + `summary` + метаданные
- **Полный content:** загружается только при явном запросе (lazy hydration)
- **Graph Links:** загружаются лениво (только если запрошены)
- **Version History:** загружается лениво

### 20.6 Incremental Freshness Recalculation

- При GraphUpdated: пересчитывается freshness только для Knowledge Entries, связанных с affected_nodes
- Не пересчитывать все знания при каждом изменении Graph
- Периодическая полная проверка (cron, daily) для time_factor обновления

### 20.7 Link-Level Invalidation

- При NodeDeleted: инвалидируются только Knowledge Links, указывающие на удалённый узел
- Не инвалидировать всё знание, если часть линков всё ещё валидна (partially stale)
- Восстановление линков при перестроении Graph (если удалённый узел был пересоздан)

### 20.8 Archive Strategy for Old Knowledge

- **Superseded знания старше 1 года:** перемещение в cold storage (archive table)
- **Deprecated знания старше 6 месяцев:** перемещение в cold storage
- **Archive table:** не индексируется для полнотекстового/семантического поиска
- **Retrieval из archive:** только при явном запросе с `include_archived=true`

---

## 21. Отказоустойчивость

### 21.1 Graph недоступен

**Сценарий:** При ingestion или retrieval Graph API не отвечает (timeout, connection error).

**Действия:**
- **Ingestion:** Сохранить Knowledge Entry без Graph Links. Запланировать retry линковки (exponential backoff: 1min, 5min, 15min, 1h). Пометка `pending_graph_link: true`.
- **Retrieval:** Вернуть результаты без Graph Links. Предупредить потребителя: `graph_unavailable: true`.
- **Staleness Detection:** Пропустить цикл staleness detection. Накопить pending GraphUpdated события.
- **Recovery:** При восстановлении Graph → обработать все pending линковки и staleness checks.

### 21.2 Vector Store недоступен

**Сценарий:** pgvector extension или внешний Vector Store недоступен.

**Действия:**
- **Ingestion:** Сохранить Knowledge Entry без embedding. Запланировать retry векторизации. Пометка `pending_embedding: true`.
- **Retrieval:** Использовать только полнотекстовый поиск. Предупредить: `semantic_search_unavailable: true, using_fallback: fulltext`.
- **Recovery:** При восстановлении — batch генерация embedding для всех pending записей.

### 21.3 Ingestion частично провалился

**Сценарий:** При ingestion артефакта часть extraction/classification/линковки не удалась.

**Действия:**
- **Partial Save:** Сохранить что удалось извлечь. Пометка `partial_extraction: true`.
- **Failed Components Log:** Записать, какие шаги pipeline провалились и почему.
- **Retry Strategy:** Автоматический retry для recoverable errors (timeout, connection). Manual review для non-recoverable (validation error, schema mismatch).
- **Не блокировать остальной pipeline:** Ошибка ingestion одного артефакта не должна блокировать обработку других.

### 21.4 Невозможно связать знание с Graph

**Сценарий:** Knowledge Linker не может найти целевой Graph Node (например, Research ссылается на модуль, которого нет в Graph).

**Действия:**
- Сохранить знание без Knowledge Link
- Link attempt record: `{ target: "Module:X", reason: "node_not_found", attempt_time }`
- Периодический retry: при GraphUpdated или NodeCreated для целевого типа
- Предоставить администратору список unresolved links

### 21.5 Knowledge Conflict не может быть разрешён

**Сценарий:** Обнаружен конфликт между знаниями, но автоматическое разрешение невозможно.

**Действия:**
- Сохранить Conflict Record со статусом `active`
- Связать обе стороны конфликта
- Опубликовать `KnowledgeConflictDetected`
- Потребители видят конфликт и принимают решение (Planner, User)
- **Не удалять, не скрывать** ни одно из конфликтующих знаний

### 21.6 Freshness не может быть рассчитан

**Сценарий:** Freshness Manager не может определить актуальность (нет данных о связанных узлах, Graph недоступен).

**Действия:**
- Пометка `freshness: unknown`
- Использовать time_factor только (как базовую оценку)
- При retrieval: возвращать с warning `freshness_unknown: true`
- Запланировать пересчёт при восстановлении

### 21.7 Часть исторических артефактов отсутствует

**Сценарий:** Artifact Storage не содержит артефакт, на который ссылается Knowledge Entry (артефакт удалён, повреждён).

**Действия:**
- Пометка Knowledge Link: `artifact_missing: true`
- Сохранить знание (оно всё ещё ценно, даже без исходного артефакта)
- Понизить confidence (отсутствует прямой evidence)
- Предупредить при retrieval

---

## 22. Ограничения

### 22.1 Когда Knowledge обязан отказаться от Promotion

| Ситуация | Действие |
|----------|----------|
| **Confidence < 0.5** | Не promoted из Draft в Active |
| **Нет evidence** | Не promoted до Best Practice |
| **Противоречит ADR** | Не promoted; создать Conflict Record |
| **Противоречит 3+ Execution Reports** | Не promoted; пометить как оспоренное |
| **Не прошло Governance validation** | Не promoted; вернуть на доработку |

### 22.2 Когда Knowledge обязан пометить знание как Low Confidence

| Ситуация | Действие |
|----------|----------|
| **Источник — непроверенный External** | Low confidence (max 0.4) |
| **Отсутствует evidence** | Low confidence (max 0.3) |
| **Единственный источник — LLM** | Low confidence (max 0.4) |
| **Знание основано на устаревшем Graph** | Понизить confidence |
| **Обнаружено противоречие с другим знанием** | Понизить confidence для обоих |
| **Артефакт-источник отсутствует** | Понизить confidence |

### 22.3 Когда Knowledge обязан сохранить Knowledge Only as Reference

| Ситуация | Действие |
|----------|----------|
| **Артефакт не содержит извлекаемых выводов** | Сохранить reference, не создавать Knowledge Entry |
| **Информация чисто структурная** | Сохранить reference, делегировать Graph |
| **Информация дублирует существующее знание** | Сохранить reference, не дублировать |
| **Временные/промежуточные данные** | Сохранить reference, не promoted до Persistent |

### 22.4 Когда Knowledge обязан пометить запись как Stale или Partial

| Ситуация | Действие |
|----------|----------|
| **GraphUpdated — связанные узлы изменились** | Stale (или potentially_stale) |
| **NodeDeleted — связанный узел удалён** | Stale |
| **ADR superseded** | Связанные знания → Stale |
| **Время > TTL без проверки** | Time-based staleness |
| **Часть связей валидна, часть — нет** | Partially Stale |

### 22.5 Когда Knowledge обязан не отдавать знание без Warning downstream-модулю

| Ситуация | Warning |
|----------|---------|
| **Freshness < 0.5** | "Знание может быть устаревшим" |
| **Confidence < 0.5** | "Низкая уверенность — рекомендуется верификация" |
| **Active Conflict** | "Есть неразрешённый конфликт" |
| **External Reference** | "Внешний источник — актуальность не гарантирована" |
| **Derived Knowledge** | "Производное знание — проверьте исходные данные" |
| **Partial Extraction** | "Знание извлечено частично" |

---

## 23. Будущее развитие

### 23.1 Принципы расширения

**Все перечисленные ниже возможности должны добавляться БЕЗ изменения утверждённой архитектуры Knowledge.** Модуль спроектирован так, чтобы новые типы знаний, retrieval strategies, ranking factors добавлялись через конфигурацию или плагины, а не через изменение ядра.

### 23.2 Новые типы знаний

**Планируемые, но не реализуемые сейчас:**
- **Performance Knowledge** — знания о производительности (бенчмарки, bottlenecks)
- **Security Knowledge** — знания о безопасности (уязвимости, mitigation)
- **Compliance Knowledge** — знания о соответствии стандартам (GDPR, SOC2)
- **Testing Knowledge** — знания о тестовых стратегиях и coverage patterns

**Как добавить:** Добавить в Knowledge Classifier новый `knowledge_type`, определить extraction rules, обновить retrieval filters.

### 23.3 Новые Retrieval Strategies

**Планируемые:**
- **Retrieval by Impact Pattern** — "какие знания применимы при изменении типа X в модуле Y"
- **Retrieval by Code Similarity** — "знания, релевантные коду, похожему на этот diff"
- **Retrieval by Team/Persona** — "знания, релевантные конкретной роли в команде"
- **Cross-Module Retrieval** — "знания о взаимодействии модуля A и модуля B"

### 23.4 Новые Ranking Factors

**Планируемые:**
- **Personalization Ranking** — учёт предпочтений конкретного пользователя (из Memory)
- **Task Success Prediction** — ранжирование на основе исторической успешности применения знания
- **Context Fit Ranking** — ранжирование на основе того, насколько знание вписывается в текущий Context Package
- **Team Consensus Ranking** — ранжирование на основе того, сколько членов команды подтвердили знание

### 23.5 Новые Freshness Models

**Планируемые:**
- **ML-based Freshness Prediction** — предсказание вероятности устаревания на основе истории изменений модуля
- **Dependency-Aware Freshness** — учёт транзитивного влияния изменений (изменился зависимый модуль → знание о зависящем модуле тоже partially stale)
- **Confidence Decay Model** — разная скорость decay для разных knowledge_type

### 23.6 Cross-Project Knowledge Reuse

**Планируемое:**
- Organisation-level Knowledge Base — общие ADR и Best Practices между проектами
- Knowledge Sharing Protocol — безопасный экспорт/импорт знаний между проектами
- Cross-Project Pattern Detection — обнаружение одинаковых паттернов в разных проектах

**Границы Knowledge при этом НЕ меняются:** Knowledge остаётся проектно-привязанным. Cross-project — это отдельный уровень (Organisation Knowledge), который строится поверх проектных Knowledge.

### 23.7 Organization-Wide Knowledge

**Планируемое:**
- Organisation Best Practices
- Organisation ADR (архитектурные решения уровня компании)
- Organisation Technology Radar (разрешённые/рекомендованные технологии)

### 23.8 External Curated Knowledge Packs

**Планируемое:**
- Pre-built Knowledge Packs для популярных фреймворков (React, Prisma, Express)
- Сообщество: Knowledge Packs от других команд
- Verified Pack System: проверенные и подписанные пакеты знаний

### 23.9 Future Bridge to Memory

**Планируемое:**
- Memory сможет использовать Knowledge как один из источников (например, "какие Architectural Knowledge связаны с текущим диалогом")
- Knowledge **не будет** хранить диалоговую историю — это ответственность Memory
- Knowledge **не будет** хранить пользовательские предпочтения — это ответственность Memory
- Чёткая граница: Knowledge → Memory API (pull), Memory → Knowledge API (pull)

**Детально граница описана в разделе 24.**

---

## 24. Чёткое разделение Knowledge и Memory

### 24.1 Почему этот раздел обязателен

**Memory — это будущий модуль системы Client.** Его архитектура ещё не определена, его ответственность ещё не зафиксирована. Однако уже сейчас нужно провести границы так, чтобы:

1. Knowledge не "раздулся" до состояния Memory заранее
2. Архитектуру не пришлось переписывать при добавлении Memory
3. Разработчики Memory имели чёткое понимание, что НЕ должно быть в Memory (потому что это в Knowledge)

### 24.2 Что Knowledge хранит vs что будет хранить Memory

| Аспект | Knowledge | Memory (будущий) |
|--------|-----------|-----------------|
| **Инженерные выводы** | Да (ADR, Best Practices, Lessons Learned) | Нет |
| **Проверяемые знания о проекте** | Да (с evidence, traceability) | Нет |
| **Структурированные знания** | Да (классификация, версионирование) | Частично |
| **Диалоговая история** | Нет | Да (основная ответственность) |
| **Пользовательские предпочтения** | Нет | Да ("пользователь предпочитает функциональный стиль") |
| **Сессионный контекст** | Нет | Да ("в текущей сессии обсуждается модуль Auth") |
| **Персональные настройки** | Нет | Да |
| **Conversation Summaries** | Нет | Да |
| **Task-specific временные данные** | Нет | Возможно (контекст незавершённой задачи) |

### 24.3 Почему Knowledge не должен становиться Memory заранее

1. **Разные цели:** Knowledge — накопление и переиспользование инженерных знаний. Memory — персонализация и контекстуализация взаимодействия.
2. **Разные модели данных:** Knowledge — Knowledge Entry с версионированием, evidence, graph links. Memory — скорее всего, диалоговые деревья, сессии, эпизоды.
3. **Разные паттерны доступа:** Knowledge — retrieval по инженерным критериям. Memory — retrieval по времени, сессии, релевантности диалогу.
4. **Разные требования к persistence:** Knowledge — долговременное (годы). Memory — среднесрочное (дни-месяцы для диалогов, возможно дольше для предпочтений).
5. **Разные требования к поиску:** Knowledge — полнотекстовый + семантический по инженерному содержанию. Memory — поиск по диалоговому контексту, хронологии.

### 24.4 Границы, которые нужно провести уже сейчас

| Граница | Knowledge | Memory |
|---------|-----------|--------|
| **Что хранить?** | Только инженерные, проверяемые, переиспользуемые знания | Всё остальное: диалоги, предпочтения, сессии |
| **Как связывать?** | Knowledge ↔ Graph, Knowledge ↔ Artifacts | Memory ↔ Knowledge (pull), Memory ↔ User, Memory ↔ Session |
| **Как версионировать?** | Immutable version history | TBD (вероятно, другая модель) |
| **Как ранжировать?** | Freshness + Confidence + Graph Relevance | TBD (вероятно, personalization + recency) |
| **Как извлекать?** | Из артефактов (Research Report, Execution Report) | Из диалогов, действий пользователя, сессий |
| **API контракт** | Knowledge API: retrieval, search, ingestion | Memory API: TBD, но Knowledge API — стабильный контракт |

### 24.5 Почему Context Cache, Artifact History, Conversation History и Knowledge — это разные слои

```
┌─────────────────────────────────────────────┐
│              Context Cache (Redis)           │  Transient, short-lived
│         Оптимизирован под быструю сборку     │  TTL: минуты-часы
│              контекста для LLM               │
└─────────────────────────────────────────────┘
                      ▲
                      │ built from
                      ▼
┌─────────────────────────────────────────────┐
│           Artifact History (Artifact Store)  │  Persistent, raw
│       Полные тексты всех артефактов:        │  TTL: годы
│  Research Reports, Execution Reports, ADR   │
└─────────────────────────────────────────────┘
                      ▲
                      │ extracts
                      ▼
┌─────────────────────────────────────────────┐
│           Knowledge (PostgreSQL + pgvector)  │  Persistent, curated
│     Извлечённые инженерные знания:          │  TTL: годы (с версиями)
│   Findings, Best Practices, ADR, Lessons    │
└─────────────────────────────────────────────┘
                      ▲
                      │ informs
                      ▼
┌─────────────────────────────────────────────┐
│         Conversation History (Memory)        │  Persistent, contextual
│     Диалоги, предпочтения, сессии           │  TTL: месяцы-годы
│          (будет спроектирован позже)         │
└─────────────────────────────────────────────┘
```

**Ключевой принцип:** Ни один слой не подменяет другой. Context Cache не хранит знания. Knowledge не хранит полные артефакты. Memory не будет хранить инженерные выводы.

---

## 25. Заключение

### Почему Knowledge — обязательный слой накопленного инженерного интеллекта

Система Client без Knowledge — это система, которая **каждый раз начинает с нуля**. Даже самый мощный Research Engine, самый точный Impact Analysis Engine и самый умный Planner останутся **краткоживущими и забывчивыми**, если результаты их работы не накапливаются, не версионируются и не переиспользуются.

**Knowledge решает фундаментальную проблему амнезии в AI-ассистированной разработке:**

1. **Без Knowledge** Research Engine исследует одни и те же модули заново для каждой задачи.
2. **Без Knowledge** Planner не знает о ранее принятых архитектурных решениях и либо нарушает их, либо переоткрывает заново.
3. **Без Knowledge** Developer Agent повторяет ошибки, которые уже были совершены и задокументированы.
4. **Без Knowledge** Context Builder не может включить исторический контекст — только текущее состояние кода.
5. **Без Knowledge** система не учится на своих ошибках и успехах.

**Knowledge — это не просто "хранилище документов". Это активный слой системы, который:**

- **Классифицирует** и структурирует инженерный опыт
- **Связывает** знания с графом кода — обеспечивая traceability от вывода до строки кода
- **Отслеживает актуальность** — предотвращая использование устаревших знаний
- **Ранжирует** знания по confidence и релевантности — защищая downstream-модули от шума
- **Версионирует** — сохраняя полную историю эволюции знаний о проекте
- **Обнаруживает конфликты** — не скрывая противоречия, а предоставляя их для осознанного решения

**Knowledge делает систему Client системой, которая со временем становится умнее, а не просто исполняет задачи.** Каждая выполненная задача, каждое исследование, каждое архитектурное решение — это инвестиция в будущую эффективность системы.

**Без Knowledge Client — это инструмент. С Knowledge — это инженерный партнёр с памятью.**

---

**Статус:** Спецификация утверждена Архитектурным Комитетом.

**Следующие шаги:** Детальная спецификация Memory (будущий модуль) с учётом границ, определённых в данной спецификации.

**Связанные документы:**
- `docs/architecture/000-overview.md` — Общая архитектура (раздел 4.3 Knowledge)
- `docs/architecture/001-domain-model.md` — Domain Model (сущность 2.16 Knowledge)
- `docs/architecture/002-storage.md` — Storage Architecture (PostgreSQL + pgvector)
- `docs/architecture/003-event-system.md` — Event System (Knowledge Events)
- `docs/architecture/004-dependency-map.md` — Dependency Map
- `docs/modules/graph.md` — Graph Module
- `docs/modules/research.md` — Research Engine
- `docs/modules/context-builder.md` — Context Builder
- `docs/modules/planner.md` — Planner
- `docs/modules/impact-analysis.md` — Impact Analysis Engine