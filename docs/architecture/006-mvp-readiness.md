# 006 — MVP Readiness and Implementation Gate

**Статус:** Readiness Gate  
**Автор:** Principal Architecture Review  
**Дата:** 2026-07-08  
**Версия:** 1.0.0  
**Зависимости:** [000-overview.md](/Users/evgenii/Desktop/client/docs/architecture/000-overview.md), [001-domain-model.md](/Users/evgenii/Desktop/client/docs/architecture/001-domain-model.md), [002-storage.md](/Users/evgenii/Desktop/client/docs/architecture/002-storage.md), [003-event-system.md](/Users/evgenii/Desktop/client/docs/architecture/003-event-system.md), [004-dependency-map.md](/Users/evgenii/Desktop/client/docs/architecture/004-dependency-map.md), [005-contract-gaps.md](/Users/evgenii/Desktop/client/docs/architecture/005-contract-gaps.md), [indexer.md](/Users/evgenii/Desktop/client/docs/modules/indexer.md), [graph.md](/Users/evgenii/Desktop/client/docs/modules/graph.md), [research.md](/Users/evgenii/Desktop/client/docs/modules/research.md), [impact-analysis.md](/Users/evgenii/Desktop/client/docs/modules/impact-analysis.md), [context-builder.md](/Users/evgenii/Desktop/client/docs/modules/context-builder.md), [planner.md](/Users/evgenii/Desktop/client/docs/modules/planner.md), [knowledge.md](/Users/evgenii/Desktop/client/docs/modules/knowledge.md), [workspace.md](/Users/evgenii/Desktop/client/docs/modules/workspace.md), [provider-system.md](/Users/evgenii/Desktop/client/docs/modules/provider-system.md), [execution-engine.md](/Users/evgenii/Desktop/client/docs/modules/execution-engine.md)

---

## 1. Назначение

Этот документ фиксирует, **достаточна ли текущая архитектурная база для начала реализации MVP**, и если да, то:

- какие модули считаются обязательными и уже достаточно определёнными;
- какие расхождения принимаются как допустимые для MVP;
- какие проблемы остаются, но не блокируют старт разработки;
- где проходит `stop-doc point`;
- какой первый implementation slice должен быть реализован.

Документ **не добавляет новую архитектуру**. Он выполняет роль **implementation gate**: после него команда либо продолжает писать спецификации, либо осознанно переходит в реализацию.

---

## 2. Определение MVP в контексте проекта

Для проекта Client MVP — это **не вся будущая интеллектуальная платформа**, а минимально жизнеспособная система, которая уже умеет:

1. открыть проект;
2. построить структурное представление кода;
3. провести исследование по задаче;
4. оценить влияние изменений;
5. собрать релевантный контекст;
6. построить детерминированный план;
7. выполнить его в изолированной среде;
8. обновить Graph и Knowledge;
9. сохранить traceability всей цепочки.

Иначе говоря, MVP — это первый **замкнутый вертикальный цикл**:

`Project -> Index -> Graph -> Research -> Impact -> Context -> Plan -> Execute -> Reindex -> Knowledge Update`

---

## 3. Что уже считается достаточно спроектированным

### 3.1 Базовые архитектурные документы

Следующие документы считаются достаточными для старта MVP-реализации:

- `000-overview.md`
- `001-domain-model.md`
- `002-storage.md`
- `003-event-system.md`
- `004-dependency-map.md`
- `005-contract-gaps.md`

Они уже задают:

- vision и high-level pipeline;
- каноническую domain model;
- storage boundaries;
- event-driven contract;
- dependency map;
- список допущенных contract gaps.

### 3.2 Основные функциональные модули

Следующие модульные спецификации считаются достаточными для MVP:

- `indexer.md`
- `graph.md`
- `research.md`
- `impact-analysis.md`
- `context-builder.md`
- `planner.md`
- `knowledge.md`
- `workspace.md`
- `provider-system.md`

### 3.3 Execution Layer

`execution-engine.md` существует и уже достаточно зрелый, чтобы считаться **MVP-usable**, но с оговорками по event vocabulary и governance alignment.

Это означает:

- **для MVP реализация допустима**;
- **для post-MVP архитектурной консолидации нужен alignment pass**;
- **новый большой документ перед реализацией не требуется**.

---

## 4. MVP Readiness Matrix

| Область | Статус | Комментарий | Blocking for MVP |
|--------|--------|-------------|------------------|
| Overview / Vision | Ready | Архитектурная рамка зафиксирована | No |
| Domain Model | Ready | Сущности и ownership определены | No |
| Storage | Ready | Persistent/transient/computed слои определены | No |
| Event System | Ready with accepted gaps | Канонический контракт есть, есть несколько локальных расхождений | No |
| Indexer | Ready | Полный structural ingestion contract есть | No |
| Graph | Ready | Каноническая structural model определена | No |
| Research | Ready | Граница ответственности и pipeline зафиксированы | No |
| Impact Analysis | Ready | Обязательный контракт между Research и Planner закрыт | No |
| Context Builder | Ready | Context packaging layer определён | No |
| Planner | Ready | Decision/planning layer определён | No |
| Knowledge | Ready | Long-term engineering memory contract достаточен | No |
| Workspace | Ready with accepted gaps | Execution sandbox и lifecycle зафиксированы | No |
| Provider System | Ready | External capability abstraction достаточна | No |
| Execution Engine | Ready with accepted gaps | Реализуемо для MVP, но vocabulary требует later cleanup | No |
| Memory | Deferred | Не нужен для первого вертикального цикла | No |

---

## 5. Что остаётся незакрытым, но допустимо для MVP

### 5.1 Event Vocabulary Drift around Execution

Остаются расхождения между:

- `ExecutionStarted` / `ExecutionFinished` в overview/event-system;
- `EXECUTION_STARTED` / `EXECUTION_COMPLETED` / `EXECUTION_FAILED` / `EXECUTION_ABORTED` в execution-engine narrative.

Это **не блокирует MVP**, если при реализации команда примет одно правило:

- canonical wire-level contract следует `003-event-system.md`;
- internal naming execution runtime может быть приведён позже.

### 5.2 Workspace Event Expansion

`workspace.md` описывает более богатую downstream реакцию на `WorkspaceMerged`, чем currently canonical event catalog.

Это **не блокирует MVP**, если:

- канонические subscribers берутся из `003-event-system.md`;
- дополнительные реакции трактуются как implementation-local orchestration, а не как новые глобальные guarantees.

### 5.3 Knowledge Staleness Event

`KnowledgeStalenessUpdated` не зафиксирован в глобальном event catalog.

Это **не блокирует MVP**, если staleness recalculation остаётся внутренним поведением `Knowledge`, а внешний runtime не требует отдельного канонического события на первом этапе.

### 5.4 Implied APIs

`Knowledge API` и `Workspace API` уже de facto существуют как архитектурные ожидания.

Это **не блокирует MVP**, потому что их минимальная реализация может быть сделана как internal service boundary без отдельной public API formalization.

---

## 6. Что сознательно НЕ входит в MVP

Следующие области должны быть **отложены**, чтобы не расползтись до бесконечного проектирования:

- `Memory` как отдельный модуль;
- organization-wide knowledge reuse;
- cross-project knowledge transfer;
- multimodal execution flows;
- advanced ML-based provider routing;
- distributed execution workers;
- advanced replay/debug infrastructure beyond minimum traceability;
- global marketplace/providers ecosystem;
- deep autonomous replanning beyond controlled Planner loop;
- богатые enterprise policy layers, если они не нужны для первого пилота.

Ключевой принцип:

**MVP должен доказать, что контекст и структурное знание позволяют слабым или средним моделям работать с реальным проектом лучше, чем без этой инфраструктуры.**

---

## 7. Stop-Doc Point

`Stop-doc point` наступает **после этого документа**.

Это означает:

1. новые крупные модульные спецификации **не обязательны до начала реализации**;
2. любые новые архитектурные документы теперь должны быть либо:
   - implementation-driven;
   - bug-driven;
   - inconsistency-driven;
   - post-MVP evolution docs.

До старта MVP **не нужно** дополнительно проектировать:

- `Memory`
- расширенные governance documents
- новые infrastructure mega-specs

Исключение:

- если в ходе baseline review найдётся критическая архитектурная дыра, реально блокирующая сборку первого вертикального slice.

На текущий момент такой дыры **не обнаружено**.

---

## 8. MVP Implementation Gate

Перед началом реализации должны быть выполнены только следующие шаги:

1. привести рабочее дерево `git` к осознанному baseline commit;
2. зафиксировать текущий пакет архитектурных документов как implementation baseline;
3. определить первый vertical slice;
4. зафиксировать список MVP acceptance criteria;
5. начать код, а не новые крупные спецификации.

---

## 9. Первый Vertical Slice

Первый implementation slice должен быть **не “всё сразу”**, а минимально замкнутый контур.

Рекомендуемый первый slice:

### Slice A — Structural Understanding Loop

Цель:

- открыть локальный проект;
- выполнить full index;
- построить graph state;
- выполнить простой research query;
- построить impact report для заранее ограниченного change request;
- сохранить результаты в knowledge.

Что должно войти:

- Project open
- Workspace read-only bootstrap
- Indexer full index
- Graph build/update
- Research over Graph + files
- Impact Analysis over Graph + Knowledge
- Knowledge ingestion for reports

Что пока может НЕ входить:

- полноценное execution of code changes;
- agent orchestration;
- merge/discard lifecycle;
- multi-agent parallel execution;
- provider fallback richness beyond minimum viable implementation.

### Slice B — Controlled Planning Loop

Следующий после Slice A:

- Context Builder
- Planner
- deterministic `Execution Plan`
- без реального code-writing execution или с очень ограниченным dry-run mode.

### Slice C — Safe Execution Loop

Третий:

- Workspace mutable lifecycle
- Execution Engine
- Provider System live routing
- limited file changes
- reindex + graph update + knowledge refresh

Такой порядок снижает риск:

- сначала доказать structural intelligence;
- потом decision pipeline;
- только затем controlled mutation of codebase.

---

## 10. MVP Acceptance Criteria

MVP считается достигнутым, если система умеет:

1. принять проект и построить его структурное представление;
2. ответить на инженерный вопрос по проекту не только через raw files, но через Graph/Knowledge-aware pipeline;
3. построить `Research Report`;
4. построить `Impact Report`;
5. собрать task-relevant `Context Package`;
6. построить детерминированный `Execution Plan`;
7. выполнить по крайней мере ограниченный безопасный execution path в isolated workspace;
8. обновить `Graph` после изменений;
9. обновить `Knowledge` после завершения цикла;
10. сохранить traceability цепочки `Intent -> Research -> Impact -> Context -> Plan -> Execution -> Graph/Knowledge update`.

---

## 11. Что блокирует реализацию прямо сейчас

На данный момент implementation phase блокируют **не архитектурные документы**, а только организационные шаги:

- baseline commit текущего rewrite-состояния;
- явная фиксация, что execution vocabulary differences accepted for MVP;
- выбор первого implementation slice.

То есть архитектурный блокер отсутствует.

---

## 12. Execution Engine Status for MVP

`Execution Engine` получает статус:

**Approved for MVP Implementation with Accepted Alignment Debt**

Это означает:

- документ достаточно подробный, чтобы начать реализацию;
- известные расхождения по naming/event vocabulary зафиксированы и приняты;
- отдельный rewrite этого документа **не требуется до старта MVP**.

Alignment debt, который остаётся post-MVP:

- приведение execution event names к canonical event model;
- уточнение границ между execution runtime naming и global architectural naming;
- возможная нормализация связки `Execution Engine <-> Workspace <-> Event System`.

---

## 13. Recommended Next Action

Следующее действие после этого документа:

**не писать новый большой архитектурный документ, а переходить к implementation planning.**

Практический порядок:

1. baseline commit;
2. MVP cut line;
3. implementation roadmap;
4. first vertical slice breakdown;
5. start coding.

---

## 14. Заключение

Архитектурная фаза достигла достаточной зрелости для старта MVP.

Ключевой результат текущего этапа:

- структурные модули описаны;
- reasoning pipeline описан;
- execution boundaries описаны;
- integration risks выявлены и зафиксированы;
- критических архитектурных пробелов, требующих ещё одного большого design cycle до реализации, не осталось.

Следовательно, **правильное решение сейчас — остановить расширение архитектурных документов и перейти к MVP implementation phase**.
