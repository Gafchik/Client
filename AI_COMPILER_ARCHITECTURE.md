# Client as AI Compiler

## 1) Executive summary

Текущий `Client` уже близок к идее AI Compiler: есть multi-agent pipeline, project memory, knowledge graph index, approvals, run lifecycle и token tracking.  
Но принятие решений все еще слишком сильно лежит на LLM (особенно в `runs.service.ts`), из-за чего слабые модели дают нестабильный результат, а токены тратятся на повторную интерпретацию проекта.

Целевая трансформация:

- превратить платформу из "чат + агенты" в **компилятор задач**;
- вынести максимум решений из LLM в детерминированные сервисы;
- дать LLM только микро-задачи с минимальным контекстом;
- сделать `Build` и `Ask` двумя независимыми режимами;
- сделать интерфейс "прозрачным процессом компиляции задачи".

---

## 2) Аудит текущей архитектуры

## 2.1 Frontend architecture (Vue)

Текущее состояние:

- Основной UX сосредоточен в одном крупном экране [`WorkspaceView.vue`](/Users/evgenii/Desktop/client/apps/web/src/views/WorkspaceView.vue).
- В одном компоненте смешаны: чат, run-control, approvals, websocket stream, polling, Knowledge Graph dialog, task replacement, toast/confirm logic.
- API-клиент плоский, без доменных boundary и без явных state-machine контрактов [`api.ts`](/Users/evgenii/Desktop/client/apps/web/src/api.ts).
- Есть полезные элементы: run status bar, approvals, граф знаний, live activity.

Проблемы:

- UI воспринимается как "чат с логами", а не как компиляция задачи по этапам.
- Нет явного разделения режимов `Build` и `Ask`.
- Нет визуальной модели "что решено детерминированно, что решает LLM".
- Сложно масштабировать UX: один giant view блокирует развитие.

Влияние на слабые модели:

- Пользователь часто вынужден уточнять руками и "перезапускать мысль" системы.
- Нет гарантированного минимального контекста на уровне UX.

## 2.2 Backend architecture (NestJS)

Текущее состояние:

- Feature-модули: `runs`, `chats`, `projects`, `teams`, `providers`, `ws`.
- Оркестрация в основном сервисе [`runs.service.ts`](/Users/evgenii/Desktop/client/apps/api/src/modules/runs/runs.service.ts) (очень большой и мульти-ответственный).
- `RunsService` выполняет: routing ролей, prompt building, agent calling, retries, approvals, file apply, command execution, test flow, memory update, final reporting.
- Есть recovery stale runs, pause/resume/cancel, approvals — сильная operational база.

Проблемы:

- **God service**: высокая связность, низкая заменяемость стратегий.
- Бизнес-решения, policy, и prompt-логика смешаны в одном runtime.
- Много heuristic fallback (это полезно), но они разбросаны и не формализованы как policy-engine.
- Повторный анализ проекта и повторная сборка контекста при каждом run.

Влияние на слабые модели:

- Система вынуждена "лечить" нестабильные ответы слабых моделей на поздних этапах, вместо профилактики на ранних.

## 2.3 UX

Текущее состояние:

- Хороший operational UX для текущей версии: live events, status, approvals, graph dialog.
- Нет explicit compile timeline (parse → plan → impact → context → execute → review → test → update knowledge).

Проблемы:

- Недостаточно "инженерного контроля" на уровне этапов компиляции.
- Нет количественных метрик уверенности/риска/полноты контекста до запуска изменений.
- История памяти и история влияния изменений не представлены как first-class UI.

## 2.4 Knowledge Graph + memory

Текущее состояние:

- `project_memory_entries` хранит `graph`, `summary`, `details`, `tags`, `relatedFiles`, `relevanceScore` [`project-memory.entity.ts`](/Users/evgenii/Desktop/client/apps/api/src/persistence/project-memory.entity.ts).
- Есть APIs для graph retrieval, dependency lookup, impact analysis [`projects.controller.ts`](/Users/evgenii/Desktop/client/apps/api/src/modules/projects/projects.controller.ts), [`projects.service.ts`](/Users/evgenii/Desktop/client/apps/api/src/modules/projects/projects.service.ts).
- Есть merge/index enrichment, coverage/unknowns, reverse relations.

Проблемы:

- Knowledge Graph обновляется в основном после run, а не как continuous index pipeline.
- Нет четкого versioned snapshot + diff strategy на уровне графа/памяти.
- Нет явного разделения fact memory vs procedural memory vs decision memory (ADR).

Влияние на слабые модели:

- Модель получает память, но не всегда "самый надежный факт" с confidence и source provenance.

## 2.5 Взаимодействие агентов и процесс выполнения

Текущее состояние:

- Реализована цепочка PM → Dev → Reviewer → Tester + orchestrator decisions.
- Есть deterministic mode detection (`diagnostics|implementation|research`) и server-side safety gates.
- Есть approvals для команд и clarifications.

Проблемы:

- Роль-роутинг и планирование все еще partially LLM-driven.
- Много этапов могут вызываться даже при низкой необходимости.
- Нет отдельного deterministic pre-planner, который до LLM решает: "какие этапы точно нужны".

## 2.6 Масштабируемость / производительность / токены

Текущее состояние:

- Есть WebSocket + polling fallback.
- Есть token accounting.
- Есть частичная оптимизация контекста (файлы, memory search, project index).

Проблемы:

- Потенциально дорогие шаги повторяются между runs.
- Нет полноценного cache hierarchy (intent cache, impact cache, context pack cache).
- Нету token budget governor как отдельного сервиса.

---

## 3) Целевая архитектура: AI Compiler

Ключевой принцип:

> LLM не должна быть умной. Умной должна быть архитектура.

LLM должна получать:

- минимальную задачу;
- минимальный verified context pack;
- строгий output contract;
- ограниченный budget и retry policy.

Все остальное — deterministic code.

## 3.1 Подсистемы (independent bounded services)

1. **Project Manager (Runtime Orchestrator)**
- Управляет lifecycle compile-job.
- Не анализирует код сам, только исполняет pipeline policy.

2. **Intent Analyzer**
- Парсит пользовательское намерение (`Build` vs `Ask`, тип задачи, scope, risk flags).
- В идеале без LLM (rule + classifier model optional fallback).

3. **Knowledge Engine**
- Единый слой знаний:
  - Knowledge Graph;
  - project index;
  - docs;
  - past task memory;
  - git history;
  - ADR.
- Выдает fact cards с provenance/confidence.

4. **Impact Analyzer**
- Строит change impact graph (impacted files/services/API/tests).
- Детерминированный graph traversal + git-aware heuristics.

5. **Context Optimizer**
- Собирает минимальный context pack по budget policy.
- Ранжирует источники по signal density.

6. **Execution Planner**
- Решает какие роли реально запускать.
- По умолчанию deterministic rule engine.
- LLM planning используется только при ambiguous scope.

7. **Developer Executor**
- Выполняет микро-TDD task (patch set), strict schema.

8. **Reviewer Executor**
- Проверяет risk hotspots + contract regressions.

9. **Tester Executor**
- Выбирает и запускает минимальный тестовый набор из Impact Analyzer.

10. **Knowledge Updater**
- Обновляет KG, memory, ADR links, task postmortem.
- Делает snapshot diff и confidence recalibration.

11. **Token Governor**
- Контролирует лимиты вызовов и контекста.
- Останавливает дорогие ветки до вызова LLM.

## 3.2 Что должно быть без LLM (обязательный deterministic слой)

- Mode detection: `Build` / `Ask`.
- Intent classification (простые классы: question, investigate, implement, explain, compare, impact, test-plan).
- Scope extraction (entities/files/modules from query + KG aliases).
- Dependency traversal и impact analysis.
- Test selection (из графа покрытия/связей).
- Context pack assembly + chunk ranking + token clipping.
- Risk scoring.
- Command safety policy.
- Retry/backoff orchestration.
- Memory dedup + conflict resolution.

LLM использовать только для:

- генерации patch content;
- сложного синтеза объяснений;
- резолюции неоднозначностей, когда deterministic слой не уверен.

---

## 4) Два независимых режима

## 4.1 Build mode

Pipeline:

1. `Intent Analyzer` → классификация задачи.
2. `Scope Resolver` → какие сущности/модули затронуты.
3. `Impact Analyzer` → зависимые компоненты, API, тесты, риск.
4. `Context Optimizer` → мини-пакет контекста для каждого исполнителя.
5. `Execution Planner` → выбор исполнителей и порядка.
6. `Developer/Reviewer/Tester` execution.
7. `Knowledge Updater` → граф, память, changelog learning.
8. `Report Synthesizer` → итог пользователю.

Правило:

- каждый этап публикует machine-readable artifacts;
- следующий этап не пересчитывает предыдущий, а использует artifact + cache key.

## 4.2 Ask mode

Pipeline:

1. `Intent Analyzer` определяет тип вопроса.
2. `Knowledge Engine` собирает facts (KG + docs + git + memory + ADR).
3. `Answer Synthesizer` формирует ответ и ссылки на источники.
4. Никакого запуска full Build pipeline.

Типы Ask queries:

- "Как работает модуль?"
- "Почему принято это решение?"
- "Где используется сервис?"
- "Какие файлы затронет изменение?"
- "Какие тесты запускать?"

---

## 5) Knowledge Engine (target design)

Knowledge Engine = единый "source-of-truth fabric":

- **Graph Store**: entities, relations, metrics, coverage.
- **Code Index**: symbol-level index + file fingerprints.
- **Doc Index**: README, архитектурные документы, API docs.
- **Task Memory**: факты из прошлых задач, outcomes, mistakes.
- **Git Intelligence**: commit lineage, hotspots, churn, blame clusters.
- **ADR Registry**: решения, альтернативы, constraints.

Каждый факт хранит:

- `source_type` (`code|git|doc|adr|task-memory`);
- `source_ref` (file+line, commit hash, ADR id);
- `confidence`;
- `updated_at`;
- `ttl_policy`.

---

## 6) Token minimization architecture

## 6.1 Главные механики

- **No full chat replay**: передавать только task + curated context pack.
- **Stage-specific context**: каждому агенту свой компактный набор.
- **Context fingerprint cache**: если scope и graph-version не изменились — reused pack.
- **Structured outputs only**: без prose-heavy prompts.
- **Single synthesis call**: объединять user-facing summarization в один финальный вызов.

## 6.2 Expected reduction

- Build path: `-40% ... -65%` tokens.
- Ask path: `-70% ... -90%` vs full agent run.
- Retry rate weak models: `-30% ... -50%` (за счет strict IO + micro-tasks).

---

## 7) Новый UX: "Task Compilation Console"

Цель UX: пользователь видит инженерный pipeline, а не "магический чат".

## 7.1 Основной экран

- **Project status bar**:
  - branch/dirty state;
  - KG coverage;
  - index freshness;
  - risk level.
- **Compilation timeline**:
  - Intent Parsed;
  - Impact Calculated;
  - Context Packed;
  - Plan Generated;
  - Execute;
  - Review;
  - Test;
  - Knowledge Updated.
- **Selected Context panel**:
  - какие файлы вошли;
  - почему вошли;
  - сколько токенов стоит каждый блок.
- **Risk panel**:
  - blast radius;
  - breaking API risk;
  - missing tests risk.
- **Action log**:
  - детальный журнал детерминированных и LLM шагов.

## 7.2 Knowledge Graph UX

- Graph explorer (entity relations).
- Dependency map per entity.
- Impact preview mode ("if change X").
- Memory timeline (когда и почему обновлен факт).

## 7.3 Ask mode UX

- Отдельная вкладка `Ask Project`.
- Быстрые query templates.
- Ответ с fact sources + confidence indicator.
- Без запуска build execution.

## 7.4 Почему текущий UX нужно менять

- Сейчас сильный operational UX, но нет "компиляционной модели".
- Новый UX снижает когнитивную нагрузку и повышает доверие: видно, почему система приняла именно это решение.

---

## 8) Improvement matrix (эффект/сложность/токены/weak-LLM quality)

| Improvement | Зачем | Эффект | Сложность | Экономия токенов | Рост качества слабых моделей |
|---|---|---|---|---|---|
| Вынести Intent Analyzer в отдельный deterministic сервис | Убрать LLM из ранней классификации | Стабильный routing Build/Ask | M | 8-12% | Высокий |
| Ввести Context Optimizer с budget policy | Минимизировать context pack | Меньше hallucination + стоимость | M | 20-35% | Очень высокий |
| Ввести Impact Analyzer как отдельный сервис | До LLM понимать blast radius | Лучше test selection и risk gating | M | 5-10% | Высокий |
| Разделить Build и Ask pipeline | Не гонять тяжелый run для вопросов | Быстрые ответы по проекту | M | 25-60% | Высокий |
| Token Governor | Ограничить дорогие ветки и retries | Контролируемая стоимость | S | 10-20% | Средний |
| Knowledge Engine как единый слой с provenance | Повысить factual accuracy | Better trust + explainability | L | 5-15% | Очень высокий |
| Stage artifact cache | Не пересчитывать одно и то же | Ускорение и дешевизна | M | 10-25% | Средний |
| Planner policy engine (детерминированный) | Не звать лишних агентов | Короче путь выполнения | M | 10-18% | Высокий |
| Symbol-aware code index | Точная выборка контекста | Меньше шум/пропуски | L | 8-20% | Высокий |
| UX Task Compilation Console | Прозрачность и контроль | Снижение повторных запросов | M | Косвенно 5-10% | Средний/Высокий |
| Memory versioning + conflict resolver | Избежать деградации памяти | Стабильное накопление знаний | M | Косвенно 3-8% | Высокий |
| ADR registry integration | Объяснять архитектурные решения | Качественный Ask ответ | S | 2-5% | Средний |

---

## 9) Suggested target service topology

`api-gateway`  
→ `compile-orchestrator`  
→ (`intent-service`, `impact-service`, `context-service`, `planner-service`)  
→ (`executor-dev`, `executor-review`, `executor-test`)  
→ `knowledge-updater`  
→ stores: (`postgres`, `graph-store`, `vector/doc index`, `artifact store`, `cache`)

Transport:

- command/event bus (NATS/Rabbit/Kafka lightweight choice).
- websocket updates from orchestrator read model.

---

## 10) Migration roadmap

## Phase 1 (2-3 weeks): stabilize without breaking product

- Выделить `IntentAnalyzerService`, `ImpactAnalyzerService`, `ContextOptimizerService` внутри текущего `apps/api`.
- Оставить текущий `RunsService` как facade, но вынести decision blocks в новые сервисы.
- Добавить cache keys: `intent_key`, `impact_key`, `context_pack_key`.

## Phase 2 (3-5 weeks): introduce Build/Ask split

- Добавить endpoint family:
  - `/compile/build`
  - `/compile/ask`
- Реализовать Ask без developer pipeline.
- Добавить UI toggle Build/Ask.

## Phase 3 (4-6 weeks): knowledge engine consolidation

- Ввести unified knowledge schema с provenance/confidence.
- Добавить ADR indexer + git intelligence worker.
- Перевести memory update на snapshot diff.

## Phase 4 (3-4 weeks): UX compiler console

- Новый timeline UI.
- Risk/context/token panels.
- Knowledge graph explorer v2.
- Memory history panel.

---

## 11) KPIs (definition of done)

- Median tokens per Build run: `-45%`.
- Ask latency p95: `< 3s` (без full pipeline).
- Retry rate weak models: `-40%`.
- Task success rate first pass: `+20%`.
- Пользовательские уточнения на задачу: `-30%`.
- KG coverage freshness SLA: `> 95%` актуальных модулей.

---

## 12) What to refactor first in current codebase

Приоритетные точки в текущем проекте:

1. Декомпозировать [`runs.service.ts`](/Users/evgenii/Desktop/client/apps/api/src/modules/runs/runs.service.ts) на orchestrator + policy services.
2. Вынести context assembly из run-loop в отдельный Context Optimizer.
3. Ввести Ask endpoint на основе [`projects.service.ts`](/Users/evgenii/Desktop/client/apps/api/src/modules/projects/projects.service.ts) graph/dependency/impact APIs.
4. Разделить `WorkspaceView` на:
  - `BuildConsoleView`,
  - `AskView`,
  - `KnowledgeGraphView`.
5. Добавить persisted compile artifacts (`intent.json`, `impact.json`, `context-pack.json`, `plan.json`) для каждого run.

---

## 13) Final architecture statement

Целевая версия `Client` — это AI Compiler, где:

- платформа решает **что делать, в каком порядке, с каким контекстом и риском**;
- LLM делает **узкий участок генерации/синтеза**;
- пользователь видит **прозрачную компиляцию задачи**;
- слабые модели работают стабильно, потому что система уменьшает пространство ошибок заранее.

