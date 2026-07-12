# Roadmap

## Текущий трек

### MVP Slice 1 — Structural Intelligence Loop

Статус: **в работе**

### Уже закрыто

- Monorepo foundation
- API orchestration baseline
- Web operator console baseline
- Workspace bootstrap
- Full index MVP
- Graph build MVP
- Research MVP
- Impact Analysis MVP
- Central Knowledge artifact storage
- Run history per project
- Pipeline stages in UI
- Diagnostics and ignored paths in UI
- Project-aware artifact viewer
- Context Builder MVP
- Context Package viewer
- Planner MVP
- Execution Plan viewer
- Safe execution preview
- Large-project performance pass
- Backward compatibility for old run artifacts
- Frontend error boundary and fallback screen
- Widget-level guards и soft-fallback на уровне панелей
- Functional Research MVP поверх structural pipeline
- Context Builder Evolution pass с explainable ranking
- Graph core evolution toward persistent canonical model
- Persistent graph storage в Neo4j (первый шаг Slice 4 из `008-next-generation-architecture.md`); PostgreSQL выведен из проекта, Project/Provider перенесены на Neo4j

### Сейчас в фокусе

- Углубление functional understanding в Research
- Дальнейшее выравнивание Graph с утверждённой архитектурой
- Углубление Planner
- Подготовка controlled execution runtime
- Усиление контрактов данных между API, артефактами и UI
- Продолжение Slice 4 (`008-next-generation-architecture.md`): переход от единого перезаписываемого graph snapshot к snapshot+overlay модели по коммитам; content-addressing индексатора по git blob hash

## Следующие этапы

### 1. Context Builder Evolution

- model-aware token budgeting;
- semantic reranking;
- knowledge-aware candidate fusion;
- ещё меньше нерелевантного контекста.

### 1.5 Functional Research Evolution

- точнее выделять feature-level intent;
- лучше определять реальные entry points;
- устойчивее распознавать side effects и data flows;
- связывать structural facts с functional meaning.

### 1.6 Graph Semantics Evolution

- richer relation semantics вместо одного плоского `REFERENCES`;
- module-aware и symbol-aware query helpers для Research, Impact и Planner;
- подготовка query surface к будущему persistent graph storage;
- усиление entry-point, dependency и ownership traversal без смены утверждённой архитектуры.

### 2. Planner Evolution

- richer decomposition;
- better dependency mapping;
- rollback-aware planning;
- stronger approval checkpoints.

### 3. Controlled Execution Runtime

- переход от preview к реальным ограниченным действиям;
- sandbox-safe change application;
- post-execution reindex;
- graph/knowledge refresh loop.

### 4. Frontend Reliability Evolution

- stronger UI data validation;
- унификация пользовательских текстов и summary артефактов на русском языке;
- better recovery UX after partial API/data failures.
