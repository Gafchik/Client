# 007 — MVP Cut Line

**Статус:** Implementation Boundary  
**Автор:** Principal Architecture Review  
**Дата:** 2026-07-08  
**Версия:** 1.0.0  
**Зависимости:** [006-mvp-readiness.md](/Users/evgenii/Desktop/client/docs/architecture/006-mvp-readiness.md), [000-overview.md](/Users/evgenii/Desktop/client/docs/architecture/000-overview.md), [004-dependency-map.md](/Users/evgenii/Desktop/client/docs/architecture/004-dependency-map.md), [005-contract-gaps.md](/Users/evgenii/Desktop/client/docs/architecture/005-contract-gaps.md)

---

## 1. Назначение

Этот документ фиксирует жёсткую границу MVP:

- что **обязательно** должно войти в первую рабочую версию;
- что **сознательно исключается**;
- какой vertical slice реализуется первым;
- какие долги допускаются временно;
- где команда должна остановить расширение scope.

`007-mvp-cut-line.md` — это не архитектурная спецификация нового модуля, а **практический фильтр решений во время реализации**.

---

## 2. MVP Goal

Цель MVP:

**доказать, что система может дать AI-модели качественно лучший результат на реальном проекте за счёт структурного понимания кода, инженерного знания и контролируемого pipeline, а не только за счёт силы модели.**

MVP не должен доказывать всё будущее платформы.

MVP должен доказать только одно:

**AI может работать с проектом лучше, потому что проект сам стал машиночитаемым, структурированным и traceable.**

---

## 3. Что обязательно входит в MVP

### 3.1 Platform Core

- Project registration / open
- Readable Workspace bootstrap
- Full Index
- Graph build/update
- Research pipeline
- Impact Analysis pipeline
- Knowledge ingestion for reports
- Context Builder
- Planner
- Provider System
- Controlled Execution path
- Reindex after changes
- Graph refresh
- Knowledge refresh

### 3.2 Data and Traceability

- Task-level traceability
- Artifact lineage
- Graph version binding
- Knowledge version binding
- Event-driven flow для ключевых стадий
- Basic diagnostics and health signals

### 3.3 Minimal UI

UI обязателен в MVP, но только как **operator console**.

В MVP UI должен уметь:

- открыть / выбрать проект;
- создать задачу;
- запустить pipeline;
- показать статус этапов;
- показать `Research Report`;
- показать `Impact Report`;
- показать `Execution Plan`;
- показать execution status/result;
- показать базовую structural/project summary.

---

## 4. Что НЕ входит в MVP

Следующие вещи **не должны** задерживать первую реализацию:

- отдельный `Memory` модуль;
- cross-project knowledge reuse;
- organization-wide knowledge graph;
- продвинутый graph explorer;
- красивый product-grade UI;
- rich collaboration workflows;
- distributed execution workers;
- advanced multi-agent orchestration;
- sophisticated replanning loops;
- ML-based provider routing;
- enterprise policy matrix beyond what already necessary;
- multimodal capabilities;
- marketplace/providers ecosystem;
- full autonomous coding loop без жёстких ограничений.

---

## 5. Первый Vertical Slice

Первый vertical slice должен быть:

## Slice 1 — Structural Intelligence Loop

### Входит

- Project open
- Workspace bootstrap в read-first режиме
- Full index
- Graph creation
- Research по задаче
- Impact analysis по задаче
- Knowledge save для Research/Impact artifacts
- Minimal UI для запуска и просмотра результатов

### Не входит

- реальное изменение файлов;
- merge/discard lifecycle;
- полноценный execution runtime;
- approval workflow;
- planner-driven code mutation.

### Почему именно этот slice

Потому что он доказывает самую важную часть продукта:

**система действительно понимает проект и умеет построить инженерный контекст лучше, чем голая модель по raw файлам.**

---

## 6. Второй Vertical Slice

## Slice 2 — Planning Loop

### Входит

- Context Builder
- Planner
- Deterministic Execution Plan
- UI-представление plan/result chain

### Не входит

- реальный code-writing execution;
- сложный rollback orchestration;
- multi-run concurrency.

### Цель

Доказать, что из `Research + Impact + Knowledge + Graph` система может строить **проверяемый и воспроизводимый план**, а не просто summary.

---

## 7. Третий Vertical Slice

## Slice 3 — Controlled Execution Loop

### Входит

- Provider System live usage
- Execution Engine safe mode
- ограниченные file changes
- isolated Workspace mutation
- reindex after execution
- graph update
- knowledge update

### Цель

Замкнуть первый полный end-to-end контур:

`Task -> Research -> Impact -> Context -> Plan -> Execute -> Reindex -> Graph/Knowledge refresh`

---

## 8. UI Cut Line

UI для MVP должен быть **операторским, а не маркетинговым**.

### Обязательные экраны

1. **Projects**
   - список проектов
   - открыть / добавить проект

2. **Project Workspace / Console**
   - состояние проекта
   - статус индексации
   - базовая structural summary

3. **Task Runner**
   - ввод задачи
   - запуск pipeline
   - статус этапов

4. **Artifacts Viewer**
   - Research Report
   - Impact Report
   - Execution Plan
   - Execution Result

### Необязательные для MVP

- graph visualization editor
- knowledge browser as standalone product area
- team dashboards
- provider admin cockpit
- fancy live collaboration

---

## 9. Accepted MVP Debt

Для MVP допускаются следующие долги:

1. Event vocabulary drift around execution layer.
2. Internal-only events, не вынесенные ещё в canonical event catalog.
3. Ограниченный execution mode вместо полного orchestration richness.
4. Базовый UI без polished UX.
5. Частичная observability, если ключевая traceability уже есть.
6. Ограниченный набор языков/анализаторов в первой реализации.

Но **не допускаются**:

- нарушение source-of-truth boundaries;
- смешение Graph и Knowledge;
- bypass Workspace при code mutation;
- execution без traceability;
- provider usage в обход Provider System.

---

## 10. Scope Kill Rules

Во время реализации любая фича должна быть исключена из MVP, если она:

1. не нужна для первого замкнутого vertical slice;
2. не усиливает structural understanding loop;
3. не нужна для controlled execution;
4. добавляет complexity без прямого доказательства core value;
5. требует проектирования `Memory` до завершения MVP.

---

## 11. MVP Success Criteria

MVP считается успешным, если система:

1. может открыть реальный проект;
2. построить graph-осмысленную структурную модель;
3. выполнить research по инженерной задаче;
4. построить impact report;
5. сохранить knowledge-артефакты;
6. построить context package;
7. построить deterministic execution plan;
8. в controlled mode выполнить ограниченный execution path;
9. обновить graph и knowledge после изменений;
10. показать весь этот путь через минимальный UI.

---

## 12. Decision Rule After Each Slice

После каждого slice задаётся только один вопрос:

**Стало ли видно, что контекст и структурное понимание реально усиливают работу модели?**

Если ответ:

- **да** → идём к следующему slice;
- **нет** → сначала устраняем архитектурный или implementation gap, не расширяя scope.

---

## 13. Заключение

MVP cut line зафиксирован.

С этого момента любое решение в разработке должно проверяться против простого критерия:

**помогает ли это собрать первый работающий контур понимания проекта и контролируемого выполнения, или это уже premature expansion.**

Если это expansion — это не MVP.
