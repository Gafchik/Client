# Branch-Aware Background Intelligence

**Статус:** Архитектурная спецификация  
**Версия:** 1.0.0  
**Зависимости:** Workspace, Repository Git Intelligence, Indexer, Graph, Research, Knowledge, Context Builder, Planner, Storage, Event System

---

## Оглавление

1. Назначение
2. Почему это необходимо
3. Архитектурный принцип
4. Уровни состояния проекта
5. Repository State Identity
6. Snapshot Model
7. Branch Overlay Model
8. Worktree Overlay Model
9. Hash Strategy
10. Incremental Reuse
11. Graph Reuse
12. Research Reuse
13. Knowledge Scoping
14. Git Branch Switching
15. Background Intelligence Pipeline
16. Interactive Question Pipeline
17. UI Requirements
18. Инвалидация
19. Производительность
20. Отказоустойчивость
21. Ограничения
22. Будущее развитие

---

## 1. Назначение

Branch-Aware Background Intelligence — это архитектурный слой, который позволяет платформе поддерживать **живое, фоновое, версионно-контекстное понимание проекта** без повторного полного исследования на каждый пользовательский вопрос.

Этот слой вводит принцип:

- проект должен быть исследован заранее;
- ветка должна рассматриваться как отдельное состояние репозитория;
- незакоммиченные изменения должны учитываться как временный overlay;
- вопрос пользователя должен выполняться поверх уже готовой модели проекта;
- дополнительное исследование допустимо только как узкий gap-fill, а не как основной сценарий.

Branch-Aware Background Intelligence не заменяет существующие модули. Он задаёт правила того, **как Workspace, Git, Indexer, Graph, Research и Knowledge должны работать совместно**, чтобы система не пересчитывала проект заново без необходимости.

---

## 2. Почему это необходимо

Если `Research` запускается полноценно на каждый вопрос, платформа получает следующие проблемы:

1. Высокая латентность ответа.
2. Избыточное повторное чтение одного и того же кода.
3. Низкая экономичность на больших репозиториях.
4. Потеря преимущества накопленного структурного понимания.
5. Риск нестабильных ответов между двумя соседними вопросами без реальных изменений в проекте.

В реальной работе пользователя проект меняется не хаотично, а в контексте:

- активной ветки;
- текущего `HEAD`;
- набора локальных изменений;
- истории предыдущих анализов.

Поэтому платформа должна мыслить не категориями “перезапустить исследование проекта”, а категориями:

- “какой snapshot уже существует?”;
- “что изменилось относительно него?”;
- “какой объём состояния можно reuse?”;
- “какие branch-specific знания уже готовы?”.

---

## 3. Архитектурный принцип

Ключевой принцип:

`ветка != новый проект`

Правильная интерпретация:

`ветка = общий repository baseline + branch overlay + worktree overlay`

Из этого следуют обязательные правила:

1. Нельзя дублировать полный graph и полный research на каждую ветку без причины.
2. Нельзя считать branch name единственным идентификатором состояния.
3. Нельзя считать локальные незакоммиченные изменения частью базового snapshot.
4. Нельзя использовать ответ LLM без явного branch/worktree context.
5. Нельзя инвалидировать всё состояние только потому, что пользователь переключил ветку.

---

## 4. Уровни состояния проекта

Состояние проекта должно делиться на три уровня.

### 4.1 Baseline State

Это наиболее стабильный слой:

- repository snapshot;
- индекс файлов;
- AST/parse cache;
- symbol extraction;
- dependency fragments;
- graph shards;
- validated structural knowledge.

Baseline State должен быть привязан к commit-level identity.

### 4.2 Branch Overlay

Это слой различий между branch baseline и текущей веткой:

- изменённые file shards;
- branch-specific graph deltas;
- branch-scoped research slices;
- branch-local knowledge;
- branch activity signals;
- branch-specific hot zones.

Branch Overlay не должен копировать весь baseline. Он должен хранить только отличия.

### 4.3 Worktree Overlay

Это самый короткоживущий слой:

- staged changes;
- unstaged changes;
- untracked files;
- deleted files;
- rename/move в рабочем дереве;
- локальные graph invalidations;
- локальные cache invalidations.

Worktree Overlay должен существовать отдельно от branch baseline и не загрязнять commit-level state до момента подтверждённого сохранения.

---

## 5. Repository State Identity

Состояние проекта должно идентифицироваться не просто `projectPath`, а составным ключом.

Обязательные компоненты identity:

1. `repositoryId`
2. `branchName`
3. `headCommit`
4. `mergeBase`
5. `worktreeFingerprint`
6. `changedPathsFingerprint`

### 5.1 Почему branch name недостаточен

Ветка `feature/auth` сегодня и та же ветка через два часа могут иметь разный `HEAD` и разный локальный diff.

Следовательно:

- один branch name не гарантирует одно и то же состояние;
- knowledge и graph нельзя привязывать только к имени ветки;
- UI обязан показывать branch и `HEAD`, а не только project name.

### 5.2 Worktree Fingerprint

Worktree fingerprint должен отражать:

- staged diff;
- unstaged diff;
- untracked files;
- deleted files;
- rename set.

Два состояния с одинаковым `HEAD`, но разным worktree fingerprint, должны считаться разными runtime contexts.

---

## 6. Snapshot Model

Snapshot — это материализованная структурная база, поверх которой строятся overlays.

Каждый snapshot должен содержать:

- repository identity;
- file manifest;
- file content hashes;
- parse cache keys;
- AST fingerprints;
- symbol fingerprints;
- dependency fingerprints;
- graph fragments;
- knowledge freshness anchors;
- createdAt / refreshedAt.

### 6.1 Snapshot types

Система должна различать:

1. `Commit Snapshot`
2. `Branch Snapshot`
3. `Worktree Snapshot`

`Commit Snapshot` — основной кандидат для долговременного reuse.  
`Branch Snapshot` — материализованный branch-aware слой, если ветка активно используется.  
`Worktree Snapshot` — временный runtime artifact.

---

## 7. Branch Overlay Model

Branch Overlay должен описывать только то, чем ветка отличается от ближайшей reuse-base.

Он должен включать:

- changed paths относительно reuse-base;
- deleted paths;
- renamed paths;
- invalidated graph shards;
- branch-local research slices;
- branch-local knowledge entries;
- branch-local diagnostics;
- branch freshness markers.

### 7.1 Reuse base

Для branch overlay возможны три уровня reuse-base:

1. exact `HEAD` snapshot;
2. snapshot по `merge-base`;
3. snapshot ближайшего совместимого ancestor state.

Exact `HEAD` reuse всегда приоритетен.  
`merge-base` reuse — основной fallback.  
Полный rescan допустим только при отсутствии пригодной базы.

---

## 8. Worktree Overlay Model

Worktree Overlay должен быть максимально дешёвым и быстрым.

Он должен включать:

- dirty files;
- changed file hashes;
- локальные parse invalidations;
- локальные graph invalidations;
- unresolved freshness drift;
- current working tree diagnostics.

### 8.1 Главное правило

Worktree Overlay не должен инициировать полный branch rebuild, если изменился только малый набор файлов.

---

## 9. Hash Strategy

Hash strategy является фундаментом переиспользования.

### 9.1 Обязательные fingerprints

Для каждого файла должны поддерживаться:

1. `File Content Hash`
2. `Parse Cache Key`
3. `AST Fingerprint`
4. `Symbol Fingerprint`
5. `Dependency Fingerprint`
6. `Subgraph Fingerprint`

### 9.2 Назначение fingerprints

`File Content Hash`  
Показывает изменение текстового содержимого файла.

`Parse Cache Key`  
Определяет пригодность повторного использования parser result.

`AST Fingerprint`  
Позволяет переиспользовать AST и выявлять эквивалентное дерево.

`Symbol Fingerprint`  
Позволяет понять, менялся ли набор символов, даже если текст файла изменился косметически.

`Dependency Fingerprint`  
Позволяет понять, менялись ли структурные связи.

`Subgraph Fingerprint`  
Позволяет понять, нужно ли пересобирать graph fragment этого файла/модуля.

### 9.3 Семантика равенства

Если:

- content hash одинаков;
- parse key одинаков;
- AST fingerprint одинаков;
- symbol fingerprint одинаков;

то файл считается структурно переиспользуемым и не требует повторного полного индексирования.

---

## 10. Incremental Reuse

Branch-aware intelligence должен по умолчанию пытаться reuse всё, что не затронуто diff.

### 10.1 Что можно reuse

1. File parse results
2. AST artifacts
3. Symbol extraction
4. Dependency fragments
5. Graph shards
6. Research slices
7. Knowledge links
8. Context building candidates

### 10.2 Что нельзя reuse без проверки

1. Results, зависящие от changed transitive dependencies
2. Runtime-sensitive findings по затронутым flows
3. Branch-scoped temporary hypotheses
4. Graph fragments, чей dependency fingerprint изменился
5. Answer artifacts прошлых run

---

## 11. Graph Reuse

Graph не должен храниться и пересчитываться как единый монолитный blob.

### 11.1 Graph должен быть шардирован

Минимальные shard-уровни:

- file shard;
- symbol group shard;
- module shard.

### 11.2 Partial invalidation

При изменении файла должны инвалидироваться:

1. file node
2. связанные symbol nodes
3. локальные dependency edges
4. derived module summaries
5. branch-local graph overlays, зависящие от этих shards

Всё остальное должно reuse.

### 11.3 Branch graph composition

Branch graph должен получаться как:

`baseline graph + branch graph delta + worktree delta`

---

## 12. Research Reuse

Research не должен каждый раз повторять общий structural discovery.

### 12.1 Background Research

Background Research должен производить reusable slices:

- entry point slices;
- module topology slices;
- runtime flow slices;
- storage topology slices;
- localization slices;
- billing slices;
- git hotspot slices.

### 12.2 Interactive Research

При пользовательском вопросе Interactive Research должен:

1. определить branch/worktree context;
2. выбрать релевантные готовые slices;
3. выполнить graph/knowledge retrieval;
4. выполнить только узкий gap-fill, если данных недостаточно.

### 12.3 Когда допустим gap-fill

Узкое доисследование допустимо только если:

- relevant slice устарел;
- relevant paths были изменены;
- confidence ниже порога;
- вопрос требует runtime path, который ещё не был материализован.

---

## 13. Knowledge Scoping

Knowledge должен быть branch-aware, но не branch-duplicated.

### 13.1 Обязательные scopes

1. `Global Knowledge`
2. `Commit Knowledge`
3. `Branch Knowledge`
4. `Run Knowledge`

### 13.2 Global Knowledge

Подходит для всех веток:

- ADR;
- архитектурные инварианты;
- подтверждённые проектные правила;
- human-approved constraints.

### 13.3 Commit Knowledge

Привязано к конкретному commit-level состоянию:

- structural findings;
- verified runtime facts;
- graph-linked conclusions.

### 13.4 Branch Knowledge

Привязано к ветке:

- временные исследовательские выводы;
- branch-local activity zones;
- branch-specific task context;
- незавершённые инженерные гипотезы.

### 13.5 Run Knowledge

Привязано к одному запуску:

- partial conclusions;
- operational diagnostics;
- временный answer synthesis context.

---

## 14. Git Branch Switching

Переключение ветки не должно означать полный restart проектного понимания.

### 14.1 При смене ветки система обязана

1. определить новый `branchName`;
2. определить новый `HEAD`;
3. вычислить `merge-base`;
4. найти лучший reuse snapshot;
5. построить invalidation set;
6. обновить overlays;
7. опубликовать branch context change event;
8. обновить UI state.

### 14.2 Приоритет reuse

1. exact snapshot по `HEAD`
2. branch snapshot
3. merge-base snapshot
4. nearest ancestor snapshot
5. full rebuild

---

## 15. Background Intelligence Pipeline

Фоновый контур должен работать непрерывно.

### 15.1 Триггеры

- project opened;
- branch changed;
- `HEAD` changed;
- worktree changed;
- completed execution;
- idle window;
- manual refresh.

### 15.2 Основные фоновые задачи

1. repository state refresh
2. incremental index plan build
3. selective reindex
4. graph shard invalidation
5. graph refresh
6. branch overlay refresh
7. background research slice refresh
8. knowledge freshness update
9. diagnostics update

### 15.3 Цель фонового контура

К моменту вопроса пользователя система уже должна иметь:

- актуальный repository context;
- актуальный graph snapshot;
- branch overlay;
- актуальные research slices;
- knowledge retrieval base.

---

## 16. Interactive Question Pipeline

При вопросе пользователя платформа должна идти не по пути “заново исследовать проект”, а по пути “использовать готовое понимание”.

### 16.1 Правильный порядок

1. Зафиксировать branch/worktree context
2. Проверить freshness relevant artifacts
3. Выбрать готовые research slices
4. Выполнить graph retrieval
5. Выполнить knowledge retrieval
6. Применить branch/worktree overlays
7. При необходимости выполнить narrow gap-fill
8. Сформировать answer/context/plan

### 16.2 Неправильный порядок

Нельзя:

1. заново сканировать весь проект;
2. заново строить весь graph;
3. заново выполнять full research;
4. только потом отвечать.

Такой путь допускается лишь как аварийный fallback.

### 16.3 Freshness semantics вопроса

Question pipeline обязан различать три режима ответа:

1. `fresh baseline`
2. `stale baseline + overlay`
3. `first-pass without baseline`

#### Fresh baseline

Если текущий `repository state` уже имеет готовый baseline, ответ должен строиться поверх него и считаться основным целевым режимом.

#### Stale baseline + overlay

Если baseline существует, но текущее branch/worktree состояние отличается, система может ответить поверх:

- последнего совместимого baseline;
- branch overlay;
- worktree overlay;
- narrow gap-fill по релевантным путям.

Но такой ответ обязан явно помечаться как менее свежий.

#### First-pass without baseline

Если baseline для данного состояния отсутствует, вопрос может запустить первый проход. Однако:

- система не должна скрывать, что baseline ещё не подготовлен;
- результат должен быть сохранён как reuse-base для следующих вопросов;
- параллельно должен нормализоваться background branch-aware state.

### 16.4 User-facing contract

Финальный answer обязан сообщать не только вывод по сути, но и freshness-контекст этого вывода:

- ответ опирается на актуальный baseline текущей ветки;
- ответ опирается на предыдущий baseline и overlay изменений;
- ответ получен в first-pass режиме без заранее подготовленного baseline.

Это особенно важно для слабых моделей и для больших репозиториев: пользователю и downstream LLM должно быть видно, насколько ответ основан на стабильном фоне, а насколько — на временном overlay.

---

## 17. UI Requirements

UI обязан делать branch-aware состояние видимым пользователю.

### 17.1 Минимальные обязательные поля

- активный проект;
- активная ветка;
- short `HEAD`;
- dirty/clean state;
- число локальных изменений;
- freshness graph;
- freshness knowledge;
- background sync status.

### 17.2 Почему это важно

Без отображения branch context пользователь не может понять:

- почему ответ отличается от вчерашнего;
- почему knowledge считается устаревшим;
- почему система требует reindex;
- к какому состоянию репозитория относится ответ.

---

## 18. Инвалидация

Инвалидация должна быть селективной.

### 18.1 Полная инвалидация допустима только если

1. отсутствует пригодный snapshot;
2. repository identity повреждён;
3. cache consistency нарушена;
4. massive rename/move делает selective reuse недостоверным.

### 18.2 Селективная инвалидация должна использовать

- changed paths;
- renamed paths;
- deleted paths;
- symbol diffs;
- dependency diffs;
- subgraph fingerprints;
- branch overlay lineage.

---

## 19. Производительность

Оптимизация должна строиться вокруг reuse-first модели.

### 19.1 Ключевые стратегии

1. merge-base reuse
2. content-hash reuse
3. AST reuse
4. graph shard reuse
5. research slice reuse
6. selective invalidation
7. background refresh вместо on-demand full recompute

### 19.2 Целевой эффект

На соседних ветках с малым diff система должна переиспользовать большую часть:

- индекса;
- graph;
- research state;
- knowledge links.

---

## 20. Отказоустойчивость

### 20.1 Если branch state не удалось определить

Система должна:

- пометить branch context как degraded;
- не удалять последний валидный snapshot;
- запретить выдачу ответа как fully-up-to-date;
- потребовать repository resync.

### 20.2 Если merge-base не найден

Система должна:

- перейти к nearest ancestor reuse, если возможно;
- иначе выполнить full rebuild.

### 20.3 Если overlay повреждён

Система должна:

- отбросить только повреждённый overlay;
- сохранить baseline snapshot;
- перестроить branch/worktree слой заново.

---

## 21. Ограничения

1. Branch-aware intelligence не отменяет необходимости background indexing.
2. Полная корректность невозможна без качественного Git state ingestion.
3. Runtime behavior не всегда полностью выводим только из structural reuse.
4. Massive refactors могут временно снижать качество selective reuse.
5. Branch overlays не должны становиться скрытым источником истины вместо baseline snapshots.

---

## 22. Будущее развитие

Без изменения базовой архитектуры должны добавляться:

1. более глубокий merge-base analysis;
2. branch hotspot intelligence;
3. co-change prediction;
4. semantic diff reuse;
5. symbol lineage across renames/moves;
6. multi-worktree awareness;
7. remote branch prefetch intelligence;
8. background precomputation для frequently used branches.

---

## Заключение

Branch-Aware Background Intelligence фиксирует главный поворот архитектуры Client:

система должна **не исследовать проект заново на каждый вопрос**, а **постоянно поддерживать живую, branch-aware, incremental модель проекта**, поверх которой пользовательские вопросы становятся дешёвыми, быстрыми и контекстно точными.

Именно Git-aware snapshots, overlays, hashes и selective reuse делают это возможным на больших реальных репозиториях.
