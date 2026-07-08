# 005 — Contract Gaps and Integration Notes

**Статус:** Audit Note  
**Автор:** Principal Architecture Review  
**Дата:** 2026-07-08  
**Версия:** 1.0.0  
**Зависимости:** [000-overview.md](/Users/evgenii/Desktop/client/docs/architecture/000-overview.md), [001-domain-model.md](/Users/evgenii/Desktop/client/docs/architecture/001-domain-model.md), [003-event-system.md](/Users/evgenii/Desktop/client/docs/architecture/003-event-system.md), [004-dependency-map.md](/Users/evgenii/Desktop/client/docs/architecture/004-dependency-map.md), [impact-analysis.md](/Users/evgenii/Desktop/client/docs/modules/impact-analysis.md), [knowledge.md](/Users/evgenii/Desktop/client/docs/modules/knowledge.md), [workspace.md](/Users/evgenii/Desktop/client/docs/modules/workspace.md)

---

## 1. Назначение

Этот документ фиксирует **незакрытые архитектурные контракты, расхождения и интеграционные пробелы**, обнаруженные после появления спецификаций:

- `Impact Analysis Engine`
- `Knowledge`
- `Workspace`

Документ **не переписывает архитектуру** и **не исправляет** существующие документы. Его задача — сделать расхождения явными до проектирования следующих модулей, чтобы новые спецификации не начали опираться на разные версии истины.

---

## 2. Область аудита

Проверялись следующие классы контрактов:

- событийные контракты;
- ownership contracts;
- artifact flow contracts;
- versioning contracts;
- implied API contracts;
- orchestration terminology.

Основное внимание уделено связке:

`Impact Analysis -> Knowledge -> Workspace -> Indexer -> Graph -> Context Builder -> Planner -> Execution`

---

## 3. Что считать contract gap

В этом документе contract gap — это один из следующих случаев:

- модульная спецификация требует событие, не зафиксированное в глобальной event model;
- модульная спецификация меняет publisher/subscriber semantics уже утверждённого события;
- модуль опирается на API или owner, который ещё не закреплён отдельной спецификацией;
- два документа используют разные термины для одного orchestration role;
- downstream-модуль уже требует поведение, которого upstream-контракт ещё явно не гарантирует.

---

## 4. Findings

### 4.1 Event Contract Mismatch: `WorkspaceMerged`

В `workspace.md` событие `WorkspaceMerged` трактуется как сигнал не только для `Indexer`, но также для `Execution Engine`, `Graph`, `Knowledge`, `Snapshot Manager` и `Repository Bridge`.

В утверждённом `003-event-system.md` подписчики `WorkspaceMerged` ограничены:

- `Repository Manager`
- `Indexer`
- `Snapshot Manager`

Это означает, что `workspace.md` фактически расширяет глобальный orchestration contract, не обновляя event-system как авторитетный документ событий.

**Статус:** Critical gap  
**Риск:** следующие модули начнут ссылаться на разные версии pipeline merge/reindex/update.  
**Текущее безопасное толкование:** authoritative contract остаётся за `003-event-system.md`, а `workspace.md` следует трактовать как intent-level детализацию, требующую явной нормализации позже.

---

### 4.2 Event Contract Mismatch: `KnowledgeStalenessUpdated`

`workspace.md` описывает цепочку, в которой после `GraphUpdated` модуль `Knowledge` публикует событие `KnowledgeStalenessUpdated`.

В `003-event-system.md` такого события нет. Утверждённые события `Knowledge`:

- `KnowledgeCreated`
- `KnowledgeUpdated`
- `KnowledgeDeprecated`
- `KnowledgeLinkedToGraph`
- `ADR*`

Это создаёт новый незафиксированный event contract для downstream-потребителей, прежде всего для `Context Builder`.

**Статус:** Critical gap  
**Риск:** расхождение event-driven invalidation semantics между `Knowledge`, `Context Builder` и будущим `Memory`.  
**Текущее безопасное толкование:** staleness lifecycle считается внутренней обязанностью `Knowledge`, пока отдельное событие не закреплено глобально.

---

### 4.3 Terminology Gap: `Workspace Manager` vs `Workspace Coordinator`

В `003-event-system.md` издатель workspace-событий указан как `Workspace Manager`.

В `workspace.md` publisher-ом событий указан `Workspace Coordinator`, а также отдельные внутренние компоненты вроде `Merge Manager`, `Cleanup Manager`, `Snapshot Manager`.

Это не обязательно конфликт по смыслу, но на уровне архитектурного словаря остаётся неясность:

- `Workspace Manager` — внешний модуль;
- `Workspace Coordinator` — внутренний orchestration component;
- или это два разных уровня именования одного и того же владельца событий.

**Статус:** Medium gap  
**Риск:** последующие документы начнут смешивать internal components и external emitters.  
**Текущее безопасное толкование:** `Workspace Manager` считать внешним архитектурным publisher role, а `Coordinator` — внутренней реализационной декомпозицией.

---

### 4.4 Event Vocabulary Gap: `TaskReceived`

`impact-analysis.md` использует происхождение `User Intent` через событие `TaskReceived`.

В утверждённом `003-event-system.md` такого события нет в каталоге task events.

Это означает, что narrative vocabulary и canonical event catalog пока не совпадают.

**Статус:** Medium gap  
**Риск:** документы начнут ссылаться на разные входные trigger-события task pipeline.  
**Текущее безопасное толкование:** `TaskReceived` считать narrative alias, а не canonical event name.

---

### 4.5 Implied API Contract: `Knowledge API`

`impact-analysis.md` и `knowledge.md` уже предполагают развитый `Knowledge API`:

- retrieval by entity;
- semantic retrieval;
- related entries lookup;
- historical impact lookup;
- freshness-aware ranking.

При этом `Knowledge` как модульная спецификация появилась только сейчас, а upstream архитектурные документы ещё не фиксировали это как отдельный module contract на интеграционном уровне.

**Статус:** Important gap  
**Риск:** `Research`, `Impact Analysis`, `Context Builder`, `Planner` начнут закладывать несовместимые ожидания к retrieval semantics.  
**Текущее безопасное толкование:** считать retrieval capabilities обязательной частью будущего stable `Knowledge` contract.

---

### 4.6 Implied API Contract: `Workspace API`

`impact-analysis.md` использует `Workspace` как источник:

- repository metadata;
- git history access;
- workspace diagnostics;
- project structure;
- file reads.

Тем самым `Impact Analysis` уже опирается на `Workspace` не только как execution sandbox, но и как read-side project state facade.

Это разумно, но повышает архитектурную роль `Workspace` ещё до окончательного согласования его read/write boundaries с `Repository`, `Storage` и `Execution`.

**Статус:** Important gap  
**Риск:** read-responsibility `Workspace` разрастётся и начнёт перетягивать на себя функции repository facade.  
**Текущее безопасное толкование:** `Workspace` может быть read-side operational facade, но authoritative owner repository history остаётся за `Repository`.

---

### 4.7 Integration Contract Gap: `Execution Engine` Becomes De Facto Required

`workspace.md` жёстко привязывает rollback, approval points, merge decision and run lifecycle к `Execution Engine`.

Таким образом, даже если `execution-engine.md` ранее рассматривался как документ с не до конца подтверждённым governance-статусом, теперь он фактически становится обязательным upstream-модулем для:

- `Workspace`
- `Knowledge`
- `Impact Analysis` indirectly through active tasks / execution state

**Статус:** Important gap  
**Риск:** дальнейшие документы будут считать `Execution Engine` fully approved, хотя это не было отдельно зафиксировано в раннем audit trail.  
**Текущее безопасное толкование:** считать `Execution Engine` operationally mandatory, даже если governance-status требовал отдельного подтверждения.

---

### 4.8 Artifact Boundary Gap: `Artifact Storage` vs `Knowledge`

`knowledge.md` последовательно различает:

- полный артефакт как immutable source;
- извлечённое из него производное знание.

Это сильная граница, но теперь она требует стабильного контракта с artifact storage layer:

- что хранится целиком;
- что только индексируется;
- что считается source of truth для retrievability;
- как lineage связывает artifact и derived knowledge.

В `overview` и `storage` это задано концептуально, но после появления `knowledge.md` контракт стал существенно более строгим.

**Статус:** Medium gap  
**Риск:** будущие `Memory` и `Execution` могут начать хранить “полезные выдержки” в обход canonical artifact/knowledge separation.  
**Текущее безопасное толкование:** full artifact остаётся artifact, Knowledge хранит только promoted engineering knowledge plus references.

---

## 5. Canonical Interim Rules

До появления следующих стабилизирующих спецификаций нужно придерживаться таких временных правил:

1. **При конфликте event semantics приоритет у `003-event-system.md`.**
2. **При конфликте structural ownership приоритет у `001-domain-model.md` и `004-dependency-map.md`.**
3. **Новые события, не перечисленные в `003-event-system.md`, считаются internal/not-yet-canonical.**
4. **`Knowledge API` и `Workspace API` считать допустимыми implied contracts, но не расширять их дальше без отдельной фиксации.**
5. **`Execution Engine` считать operational dependency, даже если governance discussion по нему исторически была не завершена.**

---

## 6. Что это значит для следующих модулей

### 6.1 Для `Provider System`

`Provider System` не должен:

- брать на себя knowledge retrieval semantics;
- подменять event orchestration;
- вводить собственные lifecycle события без проверки на совместимость с `003-event-system.md`.

### 6.2 Для `Execution Engine`

`Execution Engine` должен быть спроектирован с учётом того, что:

- `Workspace` уже зафиксировал зависимость на deterministic execution;
- rollback/approval/merge semantics уже partially implied;
- нужно аккуратно свести terminology `Execution`, `Run`, `Workspace`, `PlanStep`.

### 6.3 Для `Memory`

`Memory` нельзя проектировать так, чтобы он:

- дублировал retrieval responsibilities `Knowledge`;
- подменял artifact lineage;
- вводил собственный staleness lifecycle, конкурирующий с `Knowledge`.

---

## 7. Рекомендуемые действия перед следующими крупными спецификациями

Следующий безопасный порядок:

1. Зафиксировать этот audit note как reference для последующих документов.
2. При проектировании `Provider System` не устранять эти gaps silently, а учитывать их как ограничения.
3. Перед полноценным `Memory` сделать ещё один короткий cross-doc audit:
   - `Knowledge`
   - `Workspace`
   - `Execution Engine`
   - `Provider System`

---

## 8. Заключение

Архитектура остаётся целостной, но после появления `Impact Analysis`, `Knowledge` и `Workspace` она вошла в фазу, где **модульные документы начали формировать более точные интеграционные ожидания, чем глобальные базовые документы успели явно закрепить**.

Это нормальная стадия роста архитектуры. Риск возникает не из-за самих новых спецификаций, а из-за того, что незакрытые контракты легко начинают жить в нескольких версиях сразу.

Назначение этого документа — не “чинить” архитектуру задним числом, а удержать единый инженерный контекст до появления следующих модулей и review-циклов.
