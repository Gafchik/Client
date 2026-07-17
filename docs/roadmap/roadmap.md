# Roadmap

Актуализация на 2026-07-17: ближайший практический фокус проекта сместился не в сторону codegen, а в сторону качества research-chat как "карманного senior full-stack". Это означает такой реальный порядок работ:

1. ускорять fast-path для обычных вопрос-ответ сценариев;
2. делать long-running agent flow понятным и устойчивым на больших репозиториях;
3. улучшать качество human-style ответа без потери доказательности;
4. только после этого расширять execution/code-writing слой.

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
- Persistent graph storage в Neo4j (первый шаг Slice 4 из `008-next-generation-architecture.md`); конфигурационные сущности (`Project`, `ProjectPath`, `Provider`) остаются в PostgreSQL, а project intelligence и graph snapshot — в Neo4j
- Question-run retrieval hardening для больших baseline-driven репозиториев:
  - direct entity/symbol/path matches больше не тонут в широком `graph-neighbor` expansion;
  - selective workspace slice теперь резервирует budget под точное сущностное ядро и только затем дозированно расширяется через graph neighbors;
  - устранён перекос `ChiroNotes` vs `AcuNotes`, найденный на живом stress-тесте magendamd.
- **Team-режим (Researcher/Critic/Observer, 2026-07-14…17)** — agentic-исследование (`packages/agentic-research`) стало основным путём research: модель сама ходит по проекту инструментами (`list_dir`/`grep_content`/`read_file`/`semantic_search`/`find_references`), независимый Critic валидирует ответ перед показом пользователю; детерминированный `packages/research` остался kill-switch fallback'ом (без выбранной команды — старое поведение без изменений).
- **Multi-path unification (2026-07-16)** — проект с несколькими физическими репозиториями (backend/frontend-web/frontend-desktop/cli) виден системе как единое целое: роль пути автоопределяется по манифестам, agentic-инструменты работают по всем корням через виртуальный путь `label/relative/path`, выпадающий список "Путь" в чате убран.
- **Convention-based FE→BE связь (2026-07-17)** — граф понимает, что `axios.post('/login')` на фронте и `Route::post('/login', ...)` на бэке — одно ребро (`packages/graph`'s `linkHttpCallsToRoutes`), без хардкода под конкретный проект.
- **PHP AST-based indexing (2026-07-17)** — извлечение классов/интерфейсов/enum/trait/методов перешло с regex на настоящий парсер (`php-parser`), с fallback на regex при ошибке разбора; попутно исправлены 3 структурных бага (implicit-public методы, методы в мультикласс-файлах, trait'ы вообще не индексировались).
- **Domain Glossary + belief reconciliation (2026-07-17)** — персистентный словарь бизнес-терминов, обновляемый от вопроса к вопросу (`domain_glossary_entries`), и сверка противоречащих друг другу фактов между запусками (`classifyFactConflict` → статус `contradicted`).
- **Hot-path/entrypoint-reachability риск и git-churn риск** — Impact Analysis больше не мерит риск только объёмом затронутых файлов: учитывает, сколько публичных эндпоинтов реально проходит через файл, и историю багфикс-коммитов.
- **Диалоговая связность (2026-07-17)** — agentic-цикл получает тему предыдущей реплики (не только список файлов), чтобы эллиптический follow-up ("дай список роутов для него") не терял тему разговора; исправлена излишняя сдача без глубокого поиска буквального термина вопроса.

### Сейчас в фокусе

Structural/knowledge-фундамент (Research, Graph, Impact, Knowledge, agentic Team-режим) закрыт и проверен на двух реальных многопутевых проектах (multi-repo `slay`, крупный монолит `magendamd` — 7955 PHP-файлов). Следующий реальный шаг продукта — **Developer + Reviewer роли** (см. `docs/architecture/010-senior-developer-capability-roadmap.md`, п. 4.3): первая реализация написания кода поверх уже накопленного контекста, вместо дальнейшего углубления research-стороны. Planner/Execution Engine остаются preview-only до этого шага.

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
