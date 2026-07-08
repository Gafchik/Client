# Planner

**Статус:** Draft  
**Автор:** Principal Engineering Specification  
**Дата:** 2026-07-08  
**Версия:** 1.0.0  
**Зависимости:** [000-overview.md](/Users/evgenii/Desktop/client/docs/architecture/000-overview.md), [001-domain-model.md](/Users/evgenii/Desktop/client/docs/architecture/001-domain-model.md), [002-storage.md](/Users/evgenii/Desktop/client/docs/architecture/002-storage.md), [003-event-system.md](/Users/evgenii/Desktop/client/docs/architecture/003-event-system.md), [graph.md](/Users/evgenii/Desktop/client/docs/modules/graph.md), [research.md](/Users/evgenii/Desktop/client/docs/modules/research.md), [context-builder.md](/Users/evgenii/Desktop/client/docs/modules/context-builder.md)

---

## Оглавление

1. [Назначение Planner](#1-назначение-planner)
2. [Ответственность](#2-ответственность)
3. [Входные данные](#3-входные-данные)
4. [Выходные данные](#4-выходные-данные)
5. [Архитектура Planner](#5-архитектура-planner)
6. [Planning Pipeline](#6-planning-pipeline)
7. [Task Decomposition](#7-task-decomposition)
8. [Dependency Analysis](#8-dependency-analysis)
9. [Risk Analysis](#9-risk-analysis)
10. [Execution Strategy Selection](#10-execution-strategy-selection)
11. [Agent Assignment Strategy](#11-agent-assignment-strategy)
12. [Parallel Execution Planning](#12-parallel-execution-planning)
13. [Sequential Execution Planning](#13-sequential-execution-planning)
14. [Rollback Planning](#14-rollback-planning)
15. [Validation Before Execution](#15-validation-before-execution)
16. [Plan Versioning](#16-plan-versioning)
17. [Plan Optimization](#17-plan-optimization)
18. [Replanning](#18-replanning)
19. [Failure Recovery](#19-failure-recovery)
20. [Human Approval Points](#20-human-approval-points)
21. [Ограничения](#21-ограничения)
22. [Будущее развитие](#22-будущее-развитие)

---

## 1. Назначение Planner

Planner — это центральный модуль принятия инженерных решений в рамках выполнения задачи. Его задача — преобразовать пользовательское намерение и уже подготовленные входные артефакты в детерминированный, воспроизводимый, безопасный и верифицируемый `Execution Plan`.

Planner не пишет код, не вызывает LLM напрямую и не исследует проект вместо Research Engine. Он работает на следующем уровне абстракции: принимает уже собранные инженерные знания и структурированный контекст и на их основе определяет, **что именно, в каком порядке, с какими зависимостями, какими исполнителями и с какими проверками должно быть сделано**.

### Зачем нужен Planner

Без Planner система была бы вынуждена переходить от исследования напрямую к исполнению. Это создаёт сразу несколько критических проблем:

- отсутствует детерминированная декомпозиция задачи;
- нет формализованного порядка шагов;
- риски не учитываются до исполнения;
- параллелизм не контролируется;
- откат не планируется заранее;
- критерии готовности шагов остаются неявными;
- любое изменение контекста ломает воспроизводимость выполнения.

Planner нужен для того, чтобы между "мы поняли задачу" и "мы начали менять проект" существовал полноценный инженерный этап принятия решений о безопасном, проверяемом и трассируемом пути выполнения.

### Что такое Planner в архитектуре

Planner — это модуль формирования плана, а не модуль реализации.

Он:

- принимает структурированные входные артефакты;
- разбивает задачу на подзадачи;
- определяет зависимости между подзадачами;
- выбирает стратегию исполнения;
- определяет последовательность и параллелизм;
- назначает исполнителей;
- определяет rollback и validation точки;
- формирует итоговый `Execution Plan`.

### Какой должен быть результат Planner

Результат работы Planner должен быть:

- полностью детерминированным;
- воспроизводимым;
- версионируемым;
- пригодным для пошагового исполнения;
- пригодным для replanning;
- пригодным для аудита;
- связанным с входными артефактами и породившим его контекстом.

---

## 2. Ответственность

### Что входит в ответственность

- Приём всех обязательных planning inputs.
- Преобразование задачи в инженерно исполнимую структуру шагов.
- Декомпозиция задачи на phases, steps и substeps.
- Выявление зависимостей между шагами.
- Анализ рисков на уровне плана.
- Выбор стратегии исполнения.
- Определение возможностей параллельного выполнения.
- Определение обязательной последовательности выполнения.
- Назначение исполнителей и ролей.
- Планирование validation и acceptance checkpoints.
- Планирование rollback strategy.
- Формирование версионируемого `Execution Plan`.
- Реакция на изменения контекста и результаты исполнения.
- Replanning при изменении ситуации.

### Что не входит

- Planner не пишет код.
- Planner не вызывает LLM напрямую.
- Planner не проводит исследование вместо Research Engine.
- Planner не выполняет impact analysis вместо соответствующего модуля.
- Planner не изменяет проект.
- Planner не исполняет шаги самостоятельно.
- Planner не подменяет человеческое архитектурное решение, если задача требует approval.

### Архитектурная граница

Planner принимает инженерные решения о способе выполнения задачи, но не исполняет эти решения сам. Его выход — план, а не изменение системы.

---

## 3. Входные данные

Planner не начинает работу с нуля. Он получает набор обязательных и дополнительных артефактов.

### 3.1 User Intent / Task Request

Содержит:

- исходную задачу пользователя;
- ограничения;
- приоритет;
- дополнительные условия;
- scope запроса.

### 3.2 Research Report

Даёт Planner:

- карту релевантной области;
- findings;
- risks;
- affected modules;
- unknowns;
- recommendations;
- confidence.

### 3.3 Impact Report

Является обязательным входом для оценки последствий изменения.

Даёт Planner:

- затронутые сущности;
- транзитивную зону влияния;
- конфликты;
- риск-профиль потенциальных изменений;
- рекомендации по осторожности исполнения.

### 3.4 Context Package

Даёт Planner:

- подготовленный, сжатый, релевантный контекст;
- критичные code fragments;
- architecture and knowledge snippets;
- task framing;
- operational constraints.

### 3.5 Graph-derived Structural Inputs

Planner должен иметь доступ к graph-level данным через уже собранные артефакты или запросы согласованного scope:

- module relations;
- dependency slices;
- ownership structure;
- constraint-relevant paths;
- links to ADR and artifacts.

### 3.6 Knowledge History

Дополнительный вход:

- прошлые execution plans;
- historical lessons;
- предыдущие failures;
- related ADR;
- known good patterns and anti-patterns.

### 3.7 Configuration

Используется для:

- policy constraints;
- executor capabilities;
- approval rules;
- risk thresholds;
- parallelism limits;
- rollback rules.

### 3.8 Execution Feedback Inputs

Для replanning Planner получает:

- step completion reports;
- step failure reports;
- validation failures;
- updated context signals;
- graph/knowledge changes, если они влияют на оставшийся план.

---

## 4. Выходные данные

Выходом Planner является `Execution Plan`.

### 4.1 Что такое Execution Plan

`Execution Plan` — это детерминированное, версионированное, структурированное описание того:

- какие шаги должны быть выполнены;
- в каком порядке;
- какими исполнителями;
- с какими зависимостями;
- с какими критериями приёмки;
- с какими rollback и validation механизмами;
- при каких условиях требуется replanning или human approval.

### 4.2 Что должен содержать Execution Plan

Execution Plan должен включать:

- plan identity;
- plan version;
- task identity;
- provenance of inputs;
- phases;
- steps;
- dependency graph;
- execution ordering;
- agent assignments;
- validation gates;
- rollback strategy;
- approval points;
- risk markers;
- replanning rules;
- execution metadata.

### 4.3 Свойства хорошего Execution Plan

Execution Plan должен быть:

- исполнимым;
- однозначным;
- безопасным;
- проверяемым;
- воспроизводимым;
- минимально достаточным;
- адаптируемым при контролируемом replanning;
- пригодным для traceability.

---

## 5. Архитектура Planner

Planner должен быть разбит на специализированные внутренние компоненты.

### 5.1 Plan Coordinator

Главный оркестратор planning lifecycle.

Отвечает за:

- запуск planning session;
- координацию этапов;
- публикацию planning results;
- запуск replanning;
- завершение planning cycle.

### 5.2 Intent Interpreter

Преобразует входную задачу в planning intent:

- change request;
- refactoring task;
- migration task;
- research-follow-up implementation;
- architecture-sensitive modification.

### 5.3 Decomposition Engine

Отвечает за разбиение задачи на phases, steps и atomic substeps.

### 5.4 Dependency Resolver

Отвечает за:

- выявление dependency graph между шагами;
- определение `PRECEDES`;
- обнаружение hard and soft constraints;
- serial/parallel eligibility.

### 5.5 Risk Evaluator

Отвечает за:

- risk scoring;
- critical path warnings;
- rollback complexity;
- conflict awareness;
- unstable-zone detection.

### 5.6 Strategy Selector

Выбирает execution strategy:

- safe incremental;
- broad refactor;
- migration-first;
- schema-first;
- config-first;
- test-first-like planning modes, если они поддерживаются политикой.

### 5.7 Agent Assignment Engine

Определяет, какие роли и какие run types нужны для каждого шага:

- developer;
- reviewer;
- specialist;
- validator;
- human checkpoint.

### 5.8 Parallelization Planner

Отвечает за:

- выделение независимых веток;
- ограничение unsafe parallelism;
- sequencing barriers;
- merge points.

### 5.9 Sequential Flow Planner

Отвечает за:

- strict ordering;
- prerequisite gates;
- phase transitions;
- irreversible step ordering.

### 5.10 Rollback Planner

Отвечает за:

- rollback boundaries;
- safe revert points;
- fallback path planning;
- recovery prerequisites.

### 5.11 Validation Gate Manager

Формирует:

- pre-execution validation;
- step-level validation;
- phase-level validation;
- completion criteria.

### 5.12 Plan Version Manager

Отвечает за:

- plan lineage;
- version increments;
- superseded plans;
- comparison between plan revisions;
- traceability to context and reports.

### 5.13 Plan Optimizer

Отвечает за:

- сокращение лишних шагов;
- упрощение DAG;
- устранение redundant validations;
- оптимизацию agent allocation;
- снижение риска без потери полноты.

### 5.14 Replanning Engine

Отвечает за controlled replanning при:

- step failure;
- changed context;
- new approval outcome;
- invalidated assumptions.

### 5.15 Human Approval Manager

Отвечает за:

- выделение approval points;
- приостановку unsafe execution path;
- интеграцию human decision outcomes обратно в план.

---

## 6. Planning Pipeline

Planning Pipeline — это управляемый жизненный цикл от входных артефактов до готового `Execution Plan`.

### 6.1 Получение planning request

Planner получает запрос на планирование в контексте конкретной task.

Фиксируются:

- `task_id`;
- source artifacts;
- current graph/knowledge/context lineage;
- planning mode;
- policy constraints.

### 6.2 Проверка полноты входов

До начала планирования Planner обязан убедиться, что обязательные входы присутствуют:

- Research Report;
- Impact Report;
- Context Package;
- User Intent.

Если чего-то не хватает, планирование не начинается.

### 6.3 Нормализация inputs

Inputs приводятся к единой внутренней planning model:

- objectives;
- constraints;
- affected scope;
- risks;
- dependencies;
- unknowns;
- required outcomes.

### 6.4 Формирование planning objective

Planner должен явно определить:

- что считается выполнением задачи;
- какие результаты обязательны;
- какие ограничения недопустимо нарушать;
- какой scope plan должен покрыть.

### 6.5 Task Decomposition

Задача разбивается на фазы и шаги.

### 6.6 Dependency Modeling

Для шагов строится dependency graph:

- hard dependencies;
- soft dependencies;
- optional dependencies;
- synchronization barriers.

### 6.7 Risk and Strategy Evaluation

Planner оценивает:

- где safest order;
- какие ветки лучше развести;
- какие шаги требуют rollback planning;
- где нужен human approval;
- какие execution strategies минимизируют риск.

### 6.8 Agent Assignment

Для каждого шага назначается роль или набор ролей, необходимых для исполнения и проверки.

### 6.9 Plan Optimization

После построения чернового плана он оптимизируется:

- объединяются эквивалентные шаги;
- удаляются redundant transitions;
- уточняется parallelism;
- усиливаются validation points.

### 6.10 Final Validation

План проверяется на:

- полноту;
- детерминированность;
- отсутствие циклов;
- совместимость с constraints;
- исполнимость;
- наличие rollback and approval markers.

### 6.11 Plan Publication

После успешной валидации:

- создаётся новая версия `Execution Plan`;
- план передаётся downstream;
- публикуется planning event;
- traceability фиксируется в системе.

---

## 7. Task Decomposition

Task Decomposition — центральная функция Planner.

### 7.1 Общий принцип декомпозиции

Planner должен разбивать задачу не по тексту пользовательского запроса, а по инженерным единицам выполнения.

Декомпозиция должна учитывать:

- структуру affected scope;
- dependency boundaries;
- risk boundaries;
- rollback boundaries;
- validation boundaries;
- agent capabilities.

### 7.2 Уровни декомпозиции

Planner должен использовать как минимум три уровня:

1. `Phase`
   Крупная логическая стадия выполнения.

2. `Step`
   Исполнимая инженерная единица.

3. `Substep`
   Внутреннее уточнение шага, если это нужно для детерминированности.

### 7.3 Принципы качественной декомпозиции

Хорошая декомпозиция должна:

- быть полной относительно цели;
- не дробить задачу бессмысленно;
- не объединять независимые критические действия в один шаг;
- выделять безопасные validation boundaries;
- оставлять возможность selective replanning.

### 7.4 Как Planner разбивает задачу на подзадачи

Planner должен разбивать задачу на подзадачи на основании:

- логической последовательности изменения системы;
- структурных зависимостей между модулями и сущностями;
- необходимости подготовительных шагов;
- наличия обязательных миграций, конфигов, тестов, документации;
- границ безопасного отката;
- различия ролей исполнителей.

Обычно decomposition следует принципу:

- сначала подготовить prerequisites;
- затем изменить core affected units;
- затем согласовать зависимые участки;
- затем выполнить validation and stabilization;
- затем завершить traceability and close-out tasks.

### 7.5 Типы подзадач

Подзадачи могут относиться к разным классам:

- structural change;
- schema/data preparation;
- interface or contract update;
- implementation update;
- config update;
- tests and validation;
- documentation and artifact finalization;
- cleanup and consolidation.

### 7.6 Граница атомарности

Шаг должен быть достаточно атомарным, чтобы:

- иметь понятный expected outcome;
- иметь проверяемый результат;
- быть откатываемым;
- быть независимо перепланируемым при провале.

---

## 8. Dependency Analysis

Planner должен уметь анализировать зависимости между шагами, а не только между кодовыми сущностями.

### 8.1 Типы planning dependencies

- hard dependency;
- soft dependency;
- ordering dependency;
- validation dependency;
- data/schema dependency;
- approval dependency;
- artifact dependency.

### 8.2 Откуда берутся зависимости

Зависимости выводятся из:

- Impact Report;
- Graph structure;
- Research findings;
- configuration constraints;
- execution policy;
- rollback needs.

### 8.3 Hard dependencies

Hard dependency означает, что шаг B невозможен без завершения шага A.

Примеры:

- migration before code relying on new schema;
- interface update before implementation alignment;
- prerequisite config before runtime usage.

### 8.4 Soft dependencies

Soft dependency означает, что последовательность желательна для снижения риска, но не всегда технически обязательна.

### 8.5 Dependency graph

Planner должен формировать DAG зависимостей между шагами.

Этот DAG:

- определяет legal execution order;
- запрещает циклический plan;
- позволяет вычислять parallelizable branches;
- является основой для replanning.

### 8.6 Как Planner определяет зависимости между подзадачами

Planner определяет зависимости через анализ:

- prerequisite artifacts;
- required prior state changes;
- shared mutable scope;
- module coupling;
- schema/code ordering;
- validation barriers;
- approval gates.

Если два шага меняют один и тот же sensitive scope, Planner должен по умолчанию считать их зависимыми, пока не доказана безопасность параллельности.

---

## 9. Risk Analysis

Risk Analysis нужен, чтобы Execution Plan был не просто корректным, но и безопасным.

### 9.1 Источники риска

- широкий impact scope;
- high-coupling modules;
- historical instability;
- stale or low-confidence research findings;
- schema changes;
- config-sensitive paths;
- external integration touchpoints;
- unresolved unknowns.

### 9.2 Что Planner оценивает

Planner должен оценивать:

- вероятность неудачи шага;
- стоимость отката;
- ширину зоны поражения;
- критичность шага для общей задачи;
- вероятность cascading failures;
- необходимость human approval.

### 9.3 Risk markers в плане

Каждый шаг должен иметь risk metadata:

- low;
- medium;
- high;
- critical.

### 9.4 Риск и порядок выполнения

Высокорисковые шаги не обязательно нужно делать позже. Иногда их следует делать раньше, чтобы:

- быстро проверить feasibility;
- не строить большой downstream plan поверх ложной предпосылки;
- ограничить wasted effort.

Planner должен выбирать порядок не по простоте, а по безопасной полезности.

---

## 10. Execution Strategy Selection

Planner должен выбирать общую стратегию исполнения, а не только список шагов.

### 10.1 Возможные стратегии

- incremental safe change;
- branch-by-branch execution;
- schema-first;
- contract-first;
- implementation-first;
- validation-heavy strategy;
- rollback-priority strategy.

### 10.2 Что влияет на выбор стратегии

- тип задачи;
- ширина impact scope;
- risk profile;
- dependency structure;
- availability of rollback;
- required approvals;
- consumer environment constraints.

### 10.3 Как Planner выбирает последовательность выполнения

Последовательность определяется не линейно "по списку", а из сочетания:

- hard dependencies;
- risk ordering;
- rollback safety;
- validation points;
- parallel execution opportunities;
- need for early confidence-building steps.

Правильная последовательность:

- минимизирует риск каскадной поломки;
- максимально рано проверяет ключевые assumptions;
- сохраняет возможность безопасно остановиться;
- создаёт чёткие контрольные точки.

---

## 11. Agent Assignment Strategy

Planner должен явно определять, какие исполнители нужны для шагов.

### 11.1 Какие роли могут назначаться

- Developer-oriented executor;
- Reviewer-oriented executor;
- Validation-oriented executor;
- Specialist executor, если политика поддерживает специализированные роли;
- Human approver.

### 11.2 Как Planner назначает исполнителей

Назначение должно учитывать:

- тип шага;
- риск шага;
- необходимость независимой проверки;
- required capabilities;
- необходимость разделения разработки и проверки.

### 11.3 Правила назначения

- шаги изменения кода требуют исполнителя разработки;
- high-risk шаги требуют review/validation role;
- approval-sensitive шаги требуют human checkpoint;
- cross-module or architecture-sensitive changes требуют усиленного review.

### 11.4 Agent assignment и traceability

Execution Plan должен явно содержать:

- назначенную роль;
- ожидания от роли;
- входы и выходы для этой роли;
- критерии завершения шага.

---

## 12. Parallel Execution Planning

Planner должен уметь находить безопасный параллелизм.

### 12.1 Что можно выполнять параллельно

Параллельно могут выполняться шаги, которые:

- не имеют hard dependency;
- не меняют один и тот же sensitive scope;
- не конкурируют за один rollback boundary;
- не требуют результатов друг друга;
- не создают ambiguity для последующего merge of outcomes.

### 12.2 Как Planner определяет возможность параллельного выполнения

Planner должен проверять:

- disjoint affected scope;
- отсутствие shared mutable targets;
- отсутствие ordering constraints;
- независимость validation outcomes;
- допустимость later convergence.

### 12.3 Parallel branches

Параллельные ветки должны быть явными ветками DAG, а не неформальным "можно делать одновременно".

Для каждой параллельной ветки нужны:

- start condition;
- completion condition;
- join point;
- merge validation.

### 12.4 Ограничения параллелизма

Planner не должен планировать параллельность, если:

- shared scope высокорисковый;
- rollback слишком сложен;
- результат одной ветки вероятно влияет на assumptions другой;
- нет уверенности в merge safety.

---

## 13. Sequential Execution Planning

Последовательное исполнение не менее важно, чем параллельное.

### 13.1 Когда шаги обязаны быть последовательными

- при hard dependencies;
- при schema/code ordering;
- при shared mutable scope;
- при critical validation gates;
- при approval checkpoints;
- при rollback-sensitive transitions.

### 13.2 Barrier steps

Planner должен использовать barrier steps, после которых:

- проверяется состояние;
- принимается решение о продолжении;
- допускается replanning;
- оценивается rollback feasibility.

### 13.3 Безопасная последовательность

Безопасная последовательность должна:

- готовить систему к изменению;
- затем выполнять core modification;
- затем согласовывать зависимые элементы;
- затем проверять;
- затем завершать.

---

## 14. Rollback Planning

Rollback Planning должен быть встроен в план с самого начала.

### 14.1 Зачем нужен rollback plan

Без rollback planning Execution Plan остаётся хрупким:

- неудачный шаг может оставить систему в промежуточном состоянии;
- replanning становится хаотичным;
- high-risk changes становятся операционно неприемлемыми.

### 14.2 Что должен определить rollback plan

- где находятся rollback boundaries;
- какие шаги обратимы;
- какие шаги необратимы или дороговосстановимы;
- какие checkpoints нужны до опасных шагов;
- какие fallback пути допустимы.

### 14.3 Rollback strategies

Planner должен различать:

- local rollback;
- phase rollback;
- plan pause and hold;
- forward-fix strategy вместо отката, если откат хуже.

### 14.4 Rollback и порядок шагов

Порядок выполнения должен учитывать не только путь вперёд, но и путь назад.

Если шаг трудно откатываем, Planner должен:

- либо переместить его после дополнительных validation gates;
- либо заранее подготовить fallback;
- либо вынести его в human approval point.

---

## 15. Validation Before Execution

Перед передачей плана в Execution Planner обязан провести финальную проверку.

### 15.1 Что должно быть валидировано

- все обязательные входы присутствуют;
- план покрывает цель задачи;
- шаги имеют ясные outcomes;
- DAG не содержит циклов;
- все critical dependencies отражены;
- есть rollback and validation gates;
- approval points выделены;
- назначены исполнители;
- нет явной architectural contradiction.

### 15.2 Acceptance criteria

Для каждого шага должны быть определены критерии завершения:

- observable outcome;
- validation mechanism;
- failure signal;
- required artifact or state change.

### 15.3 Почему эта проверка обязательна

Если план попадает в Execution без финальной валидации, downstream модуль получает не инженерный план, а недоопределённый набор пожеланий.

---

## 16. Plan Versioning

Execution Plan должен быть версионируемым артефактом.

### 16.1 Что должно версионироваться

- сам план;
- его шаги;
- dependency graph;
- risk annotations;
- assignments;
- validation gates;
- rollback definitions;
- approval points.

### 16.2 Что связывает версия плана

Каждая версия плана должна быть привязана к:

- task;
- research report version;
- impact report version;
- context package version;
- graph/knowledge context;
- reason for plan generation or replanning.

### 16.3 Superseded plans

Если план изменён, старая версия не должна переписываться.

Нужно сохранять:

- superseded plan;
- reason for supersession;
- differences in structure;
- связь между версиями.

### 16.4 Детерминированность и versioning

Детерминированность означает, что при одинаковых входах и одинаковой policy configuration Planner должен производить эквивалентный план.

Versioning нужен, чтобы это свойство можно было проверять и аудировать.

---

## 17. Plan Optimization

Planner должен не только строить план, но и улучшать его.

### 17.1 Цели оптимизации

- уменьшить лишние шаги;
- сократить unnecessary serial work;
- уменьшить risk exposure;
- усилить early validation;
- сократить wasteful agent switching;
- уменьшить rollback complexity.

### 17.2 Что можно оптимизировать

- grouping steps;
- sequencing;
- parallel branches;
- assignment efficiency;
- validation placement;
- approval placement.

### 17.3 Ограничение оптимизации

Оптимизация не должна:

- ломать детерминированность;
- скрывать риски;
- убирать safety gates;
- жертвовать traceability;
- размывать ownership шагов.

---

## 18. Replanning

Planner должен поддерживать controlled replanning.

### 18.1 Когда нужен replanning

- step failure;
- changed context;
- changed graph or knowledge assumptions;
- new approval outcome;
- discovered hidden dependency;
- new risk information.

### 18.2 Что можно перепланировать

- отдельный step;
- ветку плана;
- оставшуюся фазу;
- весь оставшийся plan.

### 18.3 Принципы replanning

- не перепланировать без причины;
- сохранять уже подтверждённые части плана;
- не терять traceability между старым и новым планом;
- пересчитывать только затронутую область, если это безопасно;
- явно указывать причину replanning.

### 18.4 Как Planner реагирует на изменение контекста или провал шага

Planner должен:

1. определить, какая часть плана затронута;
2. проверить, остаются ли валидными предыдущие assumptions;
3. локализовать scope replanning;
4. пересчитать зависимости и риски;
5. сформировать новую версию плана или plan fragment;
6. зафиксировать lineage between plan versions.

---

## 19. Failure Recovery

Failure Recovery описывает поведение Planner после неудачи исполнения или планирования.

### 19.1 Классы сбоев

- planning failure before publication;
- execution step failure;
- validation failure;
- rollback failure;
- approval rejection;
- context invalidation.

### 19.2 Стратегии восстановления

- retry same step with same plan;
- retry same step with refined context;
- replan remaining branch;
- rollback and re-enter planning;
- reject task pending human clarification.

### 19.3 Когда recovery не должен быть автоматическим

Автоматическое recovery недопустимо, если:

- failure architecture-sensitive;
- rollback unclear;
- conflicting constraints unresolved;
- task may violate approved architecture;
- repeated failure indicates hidden unknown.

### 19.4 Planner и безопасное восстановление

Planner должен выбирать recovery path так, чтобы:

- не накапливать хаотические локальные исправления;
- не размывать traceability;
- не продолжать выполнение по уже недостоверному плану.

---

## 20. Human Approval Points

Planner обязан уметь выделять места, где нужен человек.

### 20.1 Когда требуется human approval

- архитектурный выбор;
- изменение high-risk critical scope;
- необратимый migration-like шаг;
- изменение, нарушающее привычные safety thresholds;
- конфликт между несколькими допустимыми стратегиями;
- недостаток данных для уверенного продолжения.

### 20.2 Что делает Planner в точке approval

Planner не принимает решение сам. Он должен:

- явно остановить unsafe branch;
- сформулировать decision point;
- описать варианты и последствия;
- пометить plan как waiting for approval;
- продолжить только после явного outcome.

### 20.3 Approval и Execution Plan

Approval point должен быть first-class элементом плана, а не комментарий на полях.

Он должен иметь:

- reason;
- blocking scope;
- possible outcomes;
- downstream effects on plan.

---

## 21. Ограничения

Planner обязан строго соблюдать архитектурные ограничения.

### 21.1 Planner не должен

- писать код;
- вызывать LLM напрямую;
- исследовать проект вместо Research Engine;
- игнорировать Impact Report;
- исполнять изменения;
- silently принимать архитектурное решение за человека.

### 21.2 Когда Planner обязан отклонить планирование

Planner должен выпускать rejection, если:

- недостаточно входных артефактов;
- задача противоречит утверждённой архитектуре;
- риск неприемлем без approval;
- контекст недостаточен для детерминированного плана;
- dependencies не могут быть надёжно определены;
- rollback невозможно разумно спланировать для критичных шагов.

### 21.3 Почему ограничения критичны

Если Planner выйдет за свои границы, архитектура системы размоется:

- Research потеряет роль поставщика знания;
- Execution потеряет роль исполнителя;
- human approval исчезнет там, где он нужен;
- traceability станет ложной.

---

## 22. Будущее развитие

Архитектура Planner должна допускать расширение без изменения базовой роли модуля.

### 22.1 Что должно легко добавляться

- новые planning strategies;
- richer risk models;
- richer agent role taxonomy;
- more advanced rollback templates;
- specialized approval policies;
- plan linting and quality scoring;
- cross-task planning awareness;
- dependency heuristics for new module types.

### 22.2 Что не должно меняться

Следующие принципы должны оставаться неизменными:

- Planner не пишет код;
- Planner не вызывает LLM напрямую;
- Planner принимает решения о плане, а не о реализации;
- Execution Plan остаётся детерминированным и версионируемым;
- planning остаётся отдельным этапом между контекстом и исполнением;
- human approval остаётся обязательным там, где архитектура этого требует.

### 22.3 Стратегический результат

Зрелый Planner должен стать модулем, который превращает инженерно понятную задачу в безопасный, последовательный, исполнимый и проверяемый путь изменений.

Он должен уметь:

- разбивать задачу на качественные подзадачи;
- определять зависимости между ними;
- выбирать порядок и параллелизм;
- назначать исполнителей;
- готовить rollback и validation gates;
- реагировать на изменение контекста и сбои;
- выпускать финальный `Execution Plan`, который можно выполнить, проверить и воспроизвести.

Именно в этом качестве Planner становится центральным модулем инженерного управления выполнением задачи в рамках утверждённой архитектуры.
