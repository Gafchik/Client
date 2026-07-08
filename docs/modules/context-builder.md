# Context Builder

**Статус:** Draft  
**Автор:** Principal Engineering Specification  
**Дата:** 2026-07-08  
**Версия:** 1.0.0  
**Зависимости:** [000-overview.md](/Users/evgenii/Desktop/client/docs/architecture/000-overview.md), [001-domain-model.md](/Users/evgenii/Desktop/client/docs/architecture/001-domain-model.md), [002-storage.md](/Users/evgenii/Desktop/client/docs/architecture/002-storage.md), [003-event-system.md](/Users/evgenii/Desktop/client/docs/architecture/003-event-system.md), [indexer.md](/Users/evgenii/Desktop/client/docs/modules/indexer.md), [graph.md](/Users/evgenii/Desktop/client/docs/modules/graph.md), [research.md](/Users/evgenii/Desktop/client/docs/modules/research.md)

---

## Оглавление

1. [Назначение Context Builder](#1-назначение-context-builder)
2. [Ответственность](#2-ответственность)
3. [Входные данные](#3-входные-данные)
4. [Выходные данные](#4-выходные-данные)
5. [Архитектура модуля](#5-архитектура-модуля)
6. [Pipeline построения контекста](#6-pipeline-построения-контекста)
7. [Правила отбора информации](#7-правила-отбора-информации)
8. [Ranking релевантности](#8-ranking-релевантности)
9. [Token Budget Strategy](#9-token-budget-strategy)
10. [Context Compression](#10-context-compression)
11. [Chunk Selection](#11-chunk-selection)
12. [Dependency Expansion](#12-dependency-expansion)
13. [Conflict Resolution](#13-conflict-resolution)
14. [Context Validation](#14-context-validation)
15. [Context Versioning](#15-context-versioning)
16. [Reuse Context Cache](#16-reuse-context-cache)
17. [Производительность](#17-производительность)
18. [Ограничения](#18-ограничения)
19. [Будущее развитие](#19-будущее-развитие)

---

## 1. Назначение Context Builder

Context Builder — это модуль, который превращает результаты исследования и связанные структурные данные проекта в оптимальный `Context Package` для LLM.

Его задача — не исследовать проект, не анализировать влияние, не принимать решения и не писать код, а собрать лучший возможный набор информации для конкретного запроса к модели с учётом:

- цели запроса;
- актуального состояния проекта;
- ограничений по токенам;
- доступных источников знания;
- релевантности информации.

### Почему Context Builder существует

Даже если система уже умеет:

- исследовать проект через Research Engine;
- понимать структуру через Graph;
- хранить знания через Knowledge;
- читать файлы через Workspace;

это ещё не означает, что она умеет эффективно использовать эти данные в LLM.

LLM не может получить весь проект целиком без потери качества. Ей нужен:

- отобранный контекст;
- правильно ранжированный контекст;
- сжатый контекст;
- структурированный контекст;
- контекст, который помещается в окно модели и не засорён нерелевантными данными.

Именно эту задачу и решает Context Builder.

### Что делает Context Builder в общей архитектуре

Context Builder:

- получает исследовательский и структурный результат от upstream модулей;
- выбирает только то, что реально нужно для текущей задачи;
- раскладывает информацию по слоям важности;
- сжимает и нормализует материал;
- собирает финальный `Context Package`;
- проверяет его на валидность и лимиты модели;
- публикует результат downstream модулям.

### Что Context Builder не делает

- не принимает инженерных решений;
- не определяет план реализации;
- не исследует проект заново;
- не является источником истины о структуре кода;
- не является knowledge store;
- не интерпретирует задачу как execution plan.

Он действует как модуль упаковки и оптимизации контекста.

---

## 2. Ответственность

### Что входит в ответственность

- Приём запроса на сборку контекста.
- Определение типа контекста и цели потребителя.
- Агрегация входных артефактов.
- Отбор только релевантной информации.
- Ранжирование информации по важности.
- Расширение context scope по зависимостям, если это необходимо.
- Контроль token budget.
- Сжатие и нормализация контента.
- Исключение нерелевантных, устаревших и конфликтующих данных.
- Формирование финального `Context Package`.
- Валидация результата перед передачей LLM или downstream module.
- Кэширование и повторное использование контекстных фрагментов.

### Что не входит

- Context Builder не принимает решений о реализации.
- Context Builder не определяет архитектурный выбор.
- Context Builder не пишет код.
- Context Builder не проводит самостоятельное исследование вместо Research Engine.
- Context Builder не выполняет impact analysis.
- Context Builder не изменяет проект, Graph, Knowledge или Repository.
- Context Builder не должен "догадываться" о фактах в отсутствие подтверждённых источников.

### Архитектурная граница

Context Builder отвечает не за знание как таковое, а за упаковку знания в форму, пригодную для эффективной передачи модели.

---

## 3. Входные данные

Context Builder принимает несколько типов входов, каждый из которых служит своей задаче.

### 3.1 User Request

User Request определяет intent контекста.

Он отвечает на вопросы:

- для чего строится контекст;
- какой класс задач стоит перед системой;
- что требуется от downstream consumer;
- какие ограничения и приоритеты задал пользователь.

### 3.2 Research Report

Research Report — основной смысловой вход для Context Builder.

Из него извлекаются:

- summary задачи;
- findings;
- evidence;
- affected modules;
- risks;
- unknowns;
- confidence;
- recommendations по дальнейшему анализу.

### 3.3 Graph

Graph используется как каноническая структурная модель проекта.

Из Graph Context Builder получает:

- структурный subgraph;
- ownership chains;
- dependency neighborhood;
- relevant files/modules/classes/routes/components;
- graph-linked ADR/artifact/task nodes;
- traversal-based expansion candidates.

### 3.4 Knowledge

Knowledge используется как долговременная память.

Из него Context Builder получает:

- релевантные ADR;
- прошлые Research Reports;
- best practices;
- historical lessons;
- ранее сохранённые external documentation fragments;
- project-specific explanations.

### 3.5 ADR

ADR рассматриваются отдельно как источник архитектурных ограничений и принятых решений.

Они особенно важны для:

- планирования;
- architecture-sensitive изменений;
- задач, где нарушение существующих решений недопустимо.

### 3.6 Workspace

Workspace используется как источник фактического содержимого файлов.

Через Workspace Context Builder получает:

- содержимое релевантных файлов;
- chunk-и файлов;
- конфигурационные файлы;
- текущее локальное состояние, если оно входит в scope.

### 3.7 Repository

Repository нужен для history-aware контекстов.

Используется для:

- recent changes summaries;
- blame-aware hints;
- historical diffs;
- context around unstable areas.

### 3.8 Configuration

Configuration используется для:

- понимания лимитов модели;
- правил include/exclude;
- project-specific context policies;
- выбора compression policy;
- настройки ranking and expansion rules.

---

## 4. Выходные данные

Выходом Context Builder является `Context Package`.

### 4.1 Что такое Context Package

`Context Package` — это структурированный, version-aware, token-budgeted набор информации, подготовленный для передачи LLM или модулю-потребителю.

Он должен быть:

- релевантным текущей задаче;
- ограниченным по объёму;
- воспроизводимым;
- объяснимым;
- пригодным для аудита;
- связанным с версиями исходных источников.

### 4.2 Что должен содержать Context Package

Context Package концептуально включает:

- system-level instructions block;
- task block;
- project context block;
- structural context block;
- code/context chunks;
- knowledge/ADR block;
- risks and unknowns block;
- source references;
- token usage metadata;
- context confidence metadata.

### 4.3 Качества хорошего Context Package

Хороший Context Package:

- не содержит нерелевантных файлов;
- не выходит за token budget;
- не теряет критичных ограничений;
- не смешивает conflicting facts без маркировки;
- не передаёт модели лишний шум;
- позволяет downstream consumer быстро выйти на нужный operational mode.

---

## 5. Архитектура модуля

Context Builder должен быть разбит на внутренние специализированные компоненты.

### 5.1 Context Coordinator

Центральный оркестратор модуля.

Отвечает за:

- запуск сборки контекста;
- управление pipeline;
- координацию источников;
- публикацию `ContextBuilt` и related events.

### 5.2 Context Intent Resolver

Определяет, какой именно тип контекста нужен:

- research-follow-up context;
- planning context;
- execution context;
- review context;
- architecture discussion context.

### 5.3 Source Aggregator

Собирает все входные артефакты в нормализованный internal context graph.

### 5.4 Relevance Ranker

Отвечает за ranking информации по релевантности и критичности.

### 5.5 Dependency Expander

Отвечает за controlled expansion релевантного subgraph и связанных источников.

### 5.6 Chunk Selector

Выбирает конкретные фрагменты файлов, документов и knowledge entries, которые попадут в контекст.

### 5.7 Token Budget Manager

Отвечает за:

- расчёт доступного окна;
- reserve policy;
- распределение токенов между блоками;
- выявление overflow risks.

### 5.8 Compression Engine

Отвечает за:

- summarization-aware compression;
- deduplication;
- structural pruning;
- normalization of repeated content.

### 5.9 Conflict Resolver

Отвечает за обработку конфликтующих данных:

- stale vs current;
- graph vs file;
- knowledge vs ADR;
- summary vs raw evidence.

### 5.10 Validation Engine

Проверяет:

- полноту обязательных блоков;
- отсутствие overflow;
- соответствие типу контекста;
- source consistency;
- отсутствие грубых нерелевантных включений.

### 5.11 Context Version Manager

Отвечает за:

- version tagging;
- traceability to graph/knowledge/repository state;
- reproducibility metadata.

### 5.12 Context Cache Manager

Отвечает за:

- reuse кэшируемых контекстных фрагментов;
- invalidation;
- cache lookup;
- assembly from reusable pieces.

### 5.13 Diagnostics and Statistics Manager

Отвечает за:

- context build diagnostics;
- token usage stats;
- ranking diagnostics;
- cache efficiency metrics.

---

## 6. Pipeline построения контекста

Pipeline Context Builder должен быть детерминированным, управляемым и объяснимым.

### 6.1 Получение запроса на контекст

Контекст может строиться для:

- Planner;
- Execution;
- review-oriented consumer;
- follow-up research;
- system-driven retry.

На входе фиксируются:

- `project_id`;
- consumer type;
- task intent;
- target model configuration;
- available upstream artifacts.

### 6.2 Определение intent и shape контекста

Context Builder определяет:

- для кого строится контекст;
- какие блоки обязательны;
- какой уровень детализации нужен;
- сколько токенов доступно;
- какие источники приоритетны.

### 6.3 Нормализация входных источников

Все входы приводятся к общей внутренней форме:

- user request summary;
- research findings;
- graph slices;
- knowledge bundles;
- ADR set;
- workspace file candidates;
- repository history hints.

### 6.4 Первичный отбор кандидатов

На этом этапе формируется множество `context candidates`:

- candidate files;
- candidate chunks;
- candidate graph entities;
- candidate knowledge entries;
- candidate ADR;
- candidate repository evidence.

### 6.5 Ranking релевантности

Каждому кандидату назначается score на основе:

- прямой релевантности задаче;
- proximity к affected scope;
- source authority;
- freshness;
- dependency centrality;
- contribution to decision-free execution context.

### 6.6 Dependency Expansion

После первичного ranking выполняется controlled expansion:

- прямые зависимости;
- declaring/owning containers;
- callers/callees;
- adjacent modules;
- linked ADR;
- required config and schema fragments.

Expansion должен быть ограниченным и оправданным.

### 6.7 Token Budget Allocation

Token Budget Manager распределяет budget между блоками:

- system block;
- task block;
- structural block;
- code chunks;
- knowledge/ADR block;
- warnings/unknowns block.

### 6.8 Chunk Selection и Compression

Отбираются лучшие chunks и при необходимости сжимаются:

- через deduplication;
- через summarization;
- через replacement full file -> focused chunks;
- через removal of low-value context.

### 6.9 Conflict Resolution

Если обнаружены противоречия:

- выбирается более авторитетный и более свежий источник;
- конфликт маркируется;
- в контекст попадает не всё подряд, а управляемый конфликт-aware representation.

### 6.10 Сборка Context Package

После отбора, ranking и compression формируется конечная структура:

- instructions;
- task framing;
- structural context;
- code context;
- knowledge/ADR context;
- risks/unknowns;
- metadata.

### 6.11 Validation

Validation Engine проверяет:

- соблюдение budget;
- отсутствие missing mandatory blocks;
- адекватность coverage;
- допустимость confidence;
- отсутствие грубо нерелевантных включений.

### 6.12 Публикация и кэширование

После успешной валидации:

- создаётся `Context Package`;
- публикуется `ContextBuilt`;
- сохраняются cacheable fragments;
- сохраняется traceability metadata.

---

## 7. Правила отбора информации

Context Builder должен следовать строгим правилам отбора.

### 7.1 Включать только task-relevant данные

Любой элемент контекста должен иметь объяснимую связь с:

- задачей;
- affected scope;
- обязательными architectural constraints;
- required implementation context.

### 7.2 Не включать файлы "на всякий случай"

Файл не должен попадать в контекст только потому, что:

- находится рядом;
- кажется похожим;
- когда-то был связан с модулем;
- может пригодиться гипотетически.

Нужна явная релевантность или обоснованная dependency expansion.

### 7.3 Отдавать предпочтение минимально достаточному объёму

Если можно включить:

- не весь файл, а chunk;
- не весь ADR, а релевантный fragment;
- не весь report, а findings summary;

следует включать минимально достаточный объём.

### 7.4 Не передавать модели нерелевантный шум

Нельзя перегружать контекст:

- старыми unrelated reports;
- соседними модулями без связи;
- длинными файлами без полезных участков;
- повторяющимися snippets;
- дублирующими explanation blocks.

### 7.5 Сохранять ограничения и unknowns

Информация о рисках, ограничениях и unresolved unknowns должна считаться high-value context и не должна выпадать только из-за меньшей "текстовой полезности".

---

## 8. Ranking релевантности

Ranking — это механизм, определяющий, что войдёт в контекст при ограниченном budget.

### 8.1 Что влияет на ranking

На ranking влияют:

- прямое совпадение с user intent;
- принадлежность к affected modules;
- graph proximity;
- mention frequency в Research Report;
- связь с risks or unknowns;
- source authority;
- freshness;
- dependency criticality;
- architectural importance.

### 8.2 Приоритетные классы информации

В общем случае наиболее высокий приоритет имеют:

1. User Request и обязательные системные инструкции.
2. Findings и affected scope из Research Report.
3. Критичные code chunks из affected files.
4. Structural graph context, необходимый для понимания dependencies.
5. Актуальные ADR и critical knowledge.
6. Risks and unknowns.
7. Supporting historical or secondary context.

### 8.3 Снижение приоритета

Пониженный приоритет получают:

- stale knowledge without validation;
- large files with low local relevance;
- historical context без прямой связи с задачей;
- peripheral dependencies;
- duplicate evidence.

### 8.4 Ranking и consumer type

Ranking должен зависеть от типа downstream consumer:

- Planner нуждается в более широком reasoning context;
- Execution нуждается в более конкретных file/chunk details;
- review-oriented consumer нуждается в risk and constraint context;
- architecture discussion требует большего веса ADR и structural rationale.

---

## 9. Token Budget Strategy

Token Budget Strategy — центральный механизм модуля.

### 9.1 Зачем нужна стратегия бюджета

Context Builder всегда работает в условиях ограниченного окна модели. Даже очень большие окна не снимают проблему:

- нерелевантный контекст ухудшает качество;
- лишние токены увеличивают latency и стоимость;
- переполнение окна делает пакет непригодным;
- слишком широкий контекст снижает фокус модели.

### 9.2 Что входит в token budget

Budget должен учитывать:

- system instructions;
- user request;
- context package body;
- reserved space for model output;
- safety margin;
- provider-specific formatting overhead.

### 9.3 Расчёт доступного окна

Context Builder должен сначала определить:

- nominal context window модели;
- hard maximum;
- recommended safe usable budget;
- reserved output budget;
- reserved retry/debug margin.

Использовать весь theoretical maximum нельзя. Нужен operational safe budget.

### 9.4 Распределение бюджета между блоками

Budget должен распределяться между категориями:

- fixed mandatory block;
- task framing;
- structural context;
- code chunks;
- knowledge and ADR;
- risks and unknowns;
- metadata and references.

Распределение должно быть configurable и зависеть от типа контекста.

### 9.5 Приоритет budget allocation

При нехватке токенов Context Builder должен урезать context в таком порядке:

1. убрать peripheral historical context;
2. сократить secondary knowledge;
3. заменить full files на targeted chunks;
4. сжать supporting explanations;
5. оставить неизменными critical instructions, task framing, ключевые chunks и critical risks.

### 9.6 Overflow handling

Если контекст не помещается:

- запускается compression pipeline;
- повторно считается ranking;
- выполняется aggressive pruning low-value content;
- если и это недостаточно, публикуется overflow diagnostic.

### 9.7 Как Context Builder укладывается в лимит токенов

Практически Context Builder должен использовать многослойный подход:

1. Никогда не начинать с полного набора данных.
2. Сначала отобрать candidate set по relevance.
3. Затем выделить минимально достаточные chunks.
4. Затем распределить budget по блокам.
5. Затем выполнить compression and deduplication.
6. Затем повторно измерить token cost.
7. Затем удалить наименее ценные элементы до достижения safe threshold.

Контекст должен собираться под budget, а не "после факта" урезаться случайным образом.

---

## 10. Context Compression

Compression нужен не для того, чтобы "сжать любой ценой", а для того, чтобы сохранить максимум полезности при ограниченном бюджете.

### 10.1 Виды compression

Context Builder должен поддерживать:

- structural compression;
- textual compression;
- evidence deduplication;
- summary substitution;
- chunk narrowing;
- block-level pruning.

### 10.2 Structural compression

Structural compression означает:

- заменить большой subgraph на его объяснимое summary;
- включать ownership chain вместо множества вторичных соседей;
- давать компактную dependency map вместо полного traversal dump.

### 10.3 Textual compression

Textual compression означает:

- извлечение только релевантных секций документа;
- укороченные summaries;
- elimination of repeated explanations;
- normalization of repeated naming noise.

### 10.4 Compression без потери критичных данных

Нельзя сжимать за счёт удаления:

- ограничений;
- unknowns;
- ключевых code fragments;
- принятых ADR;
- critical risk warnings.

### 10.5 Compression stages

Compression должен работать по стадиям:

1. deduplication;
2. replacement full -> chunk;
3. replacement raw -> summary;
4. removal of low-priority support content;
5. final tightening.

---

## 11. Chunk Selection

Chunk Selection отвечает за выбор конкретных фрагментов контента.

### 11.1 Почему chunk selection важен

Для большинства задач модели не нужен целый файл. Ей нужны:

- сигнатуры;
- важные участки реализации;
- связанный конфиг;
- relevant tests;
- linked documentation fragments.

### 11.2 Источники chunks

Chunks могут происходить из:

- source files;
- config files;
- documentation;
- ADR;
- research findings;
- historical artifacts.

### 11.3 Критерии выбора chunk

Chunk должен иметь:

- прямую связь с задачей;
- структурную или смысловую relevance;
- достаточную локальную завершённость;
- минимальный шум;
- объяснимую роль в контексте.

### 11.4 Не допускать случайного попадания нерелевантных файлов

Чтобы не включать нерелевантные файлы, Chunk Selector должен опираться на:

- ranking;
- graph-based adjacency rules;
- research-derived affected scope;
- explicit exclusion rules;
- diagnostics о stale or low-trust sources.

### 11.5 Chunk granularity

Гранулярность должна быть управляемой:

- слишком мелкие chunks теряют смысл;
- слишком большие chunks съедают budget.

Нужен balance между:

- semantic completeness;
- token cost;
- local relevance.

---

## 12. Dependency Expansion

Dependency Expansion нужен для того, чтобы модель получила не только target entity, но и достаточный окружающий structural context.

### 12.1 Что расширяется

Расширяться могут:

- owning files and modules;
- callers and callees;
- imported dependencies;
- implemented interfaces;
- extended classes;
- related config/schema routes;
- linked ADR and knowledge entries.

### 12.2 Когда expansion нужен

Expansion нужен, если без него:

- кодовый fragment неясен;
- dependency path оборван;
- task затрагивает contract boundary;
- нужен execution-relevant surrounding context;
- research findings указывают на critical adjacency.

### 12.3 Когда expansion нельзя делать бесконтрольно

Нельзя бесконечно раздувать контекст через граф соседей.

Expansion должен быть:

- bounded;
- ranked;
- budget-aware;
- purpose-specific.

### 12.4 Правило остановки expansion

Expansion должен останавливаться, если:

- дальнейшие соседи уже не увеличивают практическую полезность;
- token cost растёт быстрее, чем полезность;
- consumer type не требует более широкого scope;
- unknowns лучше выразить явно, чем пытаться включить всё окружение.

---

## 13. Conflict Resolution

Context Builder должен уметь работать с конфликтующими данными.

### 13.1 Типы конфликтов

- Graph vs Workspace;
- Knowledge vs current code;
- old ADR vs superseding ADR;
- historical artifact vs current structure;
- research summary vs raw file evidence.

### 13.2 Общие правила разрешения

При конфликте приоритет должен определяться:

- актуальностью;
- source authority;
- version alignment;
- directness of evidence.

### 13.3 Приоритет источников при конфликте

В общем случае:

1. current direct file evidence;
2. current valid Graph;
3. accepted актуальный ADR;
4. актуальный Research Report;
5. historical reports and older knowledge;
6. generic documentation.

### 13.4 Что делать, если конфликт неразрешим

Если конфликт неразрешим автоматически:

- он должен быть явно отражён в Context Package;
- confidence должен быть снижен;
- в контекст должен попасть conflict note;
- downstream consumer не должен получать видимость ложной однозначности.

---

## 14. Context Validation

Context Validation — это обязательный этап перед публикацией контекста.

### 14.1 Что проверяется

Validation должен проверять:

- укладывается ли контекст в token budget;
- присутствуют ли обязательные блоки;
- не попали ли внутрь явно нерелевантные файлы;
- есть ли у critical blocks source backing;
- не потеряны ли risks and unknowns;
- соответствует ли context shape типу downstream consumer.

### 14.2 Семантическая валидация

Помимо token-level проверки нужна семантическая:

- есть ли task framing;
- есть ли affected scope;
- есть ли structural context;
- есть ли code evidence, если оно требуется;
- есть ли architectural constraints, если они релевантны.

### 14.3 Validation outcome

Результат валидации должен быть одним из:

- valid;
- valid with warnings;
- invalid due to overflow;
- invalid due to missing critical context;
- invalid due to conflicting unresolved sources.

---

## 15. Context Versioning

Context Package должен быть version-aware и traceable.

### 15.1 Что должно версионироваться

Context Package должен ссылаться на:

- graph version;
- knowledge version or snapshot;
- repository revision;
- research report version;
- configuration version;
- target model profile.

### 15.2 Зачем нужно versioning

Versioning нужно для:

- reproducibility;
- audit;
- debugging bad model outputs;
- cache correctness;
- understanding why именно такой контекст был собран.

### 15.3 Context lineage

Нужно уметь восстановить:

- из каких источников был собран контекст;
- какие версии источников использовались;
- какие chunks были выбраны;
- какие блоки были отброшены;
- какие diagnostics были зафиксированы.

---

## 16. Reuse Context Cache

Context Cache нужен для ускорения повторных похожих сборок.

### 16.1 Что можно переиспользовать

Переиспользоваться могут:

- stable architecture blocks;
- module summaries;
- validated ADR bundles;
- frequently used structural slices;
- file chunk summaries;
- consumer-specific context templates.

### 16.2 Что нельзя безусловно переиспользовать

Нельзя blindly reuse:

- контекст, привязанный к устаревшей graph version;
- контекст после `GraphUpdated` без revalidation;
- stale knowledge bundles;
- context built for another consumer type;
- context с unresolved conflicts без перепроверки.

### 16.3 Invalidation

Cache должен инвалидироваться при:

- `GraphUpdated`;
- `KnowledgeUpdated`;
- `ContextInvalidated`;
- repository revision change;
- relevant configuration change;
- ADR supersession;
- research report update.

### 16.4 Reuse policy

Reuse должен быть fragment-based, а не только whole-package-based. Это позволяет пересобирать итоговый пакет из частично стабильных блоков.

---

## 17. Производительность

Context Builder должен быть быстрым, потому что он находится на пути к LLM execution.

### 17.1 Основные механизмы производительности

- context cache;
- reusable structural slices;
- pre-ranked stable fragments;
- chunk-level reuse;
- bounded dependency expansion;
- budget-first selection.

### 17.2 Снижение стоимости сборки

Стоимость сборки должна уменьшаться за счёт:

- не чтения лишних файлов;
- не построения полного subgraph при локальной задаче;
- повторного использования validated summaries;
- раннего pruning нерелевантных кандидатов.

### 17.3 Параллельность

Могут выполняться параллельно:

- graph slice retrieval;
- knowledge bundle lookup;
- file chunk retrieval;
- token estimation for independent blocks;
- cache lookups.

### 17.4 Метрики производительности

Должны измеряться:

- время сборки контекста;
- cache hit rate;
- средний объём токенов;
- частота overflow;
- число отброшенных кандидатов;
- доля reused fragments;
- доля сжатия от исходного candidate set.

---

## 18. Ограничения

Context Builder обязан знать свои границы.

### 18.1 Когда Context Builder не может собрать хороший контекст

Это происходит, если:

- отсутствует Research Report или он недостаточен;
- graph state недостоверен;
- critical files недоступны;
- budget слишком мал для обязательных блоков;
- источники критически конфликтуют;
- не удаётся определить consumer intent.

### 18.2 Когда нужно сообщить о проблеме upstream

Context Builder должен сигнализировать upstream или orchestration layer, если:

- требуется повторное исследование;
- нужен новый graph slice;
- knowledge conflict мешает сборке;
- token budget невыполним для текущего типа задачи;
- отсутствуют обязательные входы.

### 18.3 Чего Context Builder не должен делать

- не должен сам решать инженерную задачу;
- не должен проводить исследование вместо Research;
- не должен silently подменять неизвестное догадкой;
- не должен передавать LLM избыточный проектный шум;
- не должен скрывать unresolved conflicts.

---

## 19. Будущее развитие

Архитектура Context Builder должна допускать развитие без изменения его фундаментальной роли.

### 19.1 Что должно легко добавляться

- новые ranking policies;
- новые compression policies;
- новые chunking strategies;
- новые consumer types;
- model-specific context profiles;
- richer conflict policies;
- richer token budgeting heuristics;
- cross-project reusable context blocks.

### 19.2 Что не должно меняться

Даже в будущем должны сохраняться следующие принципы:

- Context Builder не исследует проект;
- Context Builder не принимает решений;
- Context Builder не пишет код;
- Context Builder собирает лучший возможный `Context Package`;
- token budget и relevance остаются центральными ограничениями;
- Graph, Knowledge и Research остаются основными upstream источниками.

### 19.3 Стратегический результат

Зрелый Context Builder должен стать модулем, который обеспечивает передачу в LLM не "максимума данных", а "максимума полезного контекста".

Он должен уметь:

- объединять Graph, Knowledge и Research в единый пакет;
- удерживать контекст в пределах модели;
- не допускать попадания нерелевантных файлов;
- делать context assembly воспроизводимой и объяснимой;
- повышать качество всех downstream LLM-driven действий системы.

Именно поэтому Context Builder становится критическим мостом между инженерным знанием системы и эффективной работой модели.
