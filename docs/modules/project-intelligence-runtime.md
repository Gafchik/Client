# Project Intelligence Runtime

**Статус:** Частично реализовано; документ описывает и текущий runtime, и целевую модель  
**Версия:** 1.1.0  
**Зависимости:** Workspace, Repository Git Intelligence, Indexer, Graph, Research, Knowledge, Context Builder, Planner, Storage, Event System

## Статус реализации на 2026-07-17

Уже есть в продукте:

- background state monitor
- baseline/background-sync артефакты в Postgres
- branch/worktree-aware project state сигналы
- observer background crawl
- question-time reuse baseline вместо полного старта "с нуля" в каждом случае

Ещё не доведено до целевой архитектуры:

- полноценные branch overlays как отдельные first-class persisted сущности
- строгая стратегия invalidation/refresh для всех слоёв
- завершённый execution/runtime слой для code-writing задач

---

## Оглавление

1. Назначение
2. Почему модель "research на каждый вопрос" неверна
3. Архитектурный принцип
4. Место в общей архитектуре
5. Уровни понимания проекта
6. Baseline Project Map
7. Branch Overlay
8. Worktree Overlay
9. Committed State и Local Development State
10. Project State Detection
11. Watcher и Polling Strategy
12. Background Intelligence Pipeline
13. Question-Time Retrieval Pipeline
14. Invalidation и Refresh Rules
15. Persistence Model
16. UI и Operator Signals
17. Diagnostics и Statistics
18. Производительность
19. Отказоустойчивость
20. Ограничения
21. Будущее развитие

---

## 1. Назначение

Project Intelligence Runtime — это cross-cutting архитектурный слой, который переводит платформу из режима:

`на каждый вопрос заново исследовать проект`

в режим:

`проект уже изучен, а вопрос выполняется поверх подготовленной карты проекта и актуального Git/worktree состояния`

Этот слой существует для того, чтобы:

- поддерживать заранее собранную структурную и инженерную модель проекта;
- разделять стабильное знание о закоммиченном состоянии и временное знание о локальной разработке;
- минимизировать повторный запуск дорогих этапов `Indexer`, `Graph` и широкого `Research`;
- давать LLM уже готовое понимание проекта, а не заставлять её каждый раз заново открывать кодовую базу;
- обеспечить рабочий сценарий, в котором разработчик может изменить код локально и сразу спросить систему о совете, риске или проверке.

Project Intelligence Runtime не является новым заменяющим модулем. Он задаёт операционную модель совместной работы уже утверждённых модулей:

- `Repository Git Intelligence` отслеживает состояние репозитория;
- `Indexer` и `Graph` строят и обновляют структурную карту;
- `Knowledge` хранит долговременные инженерные выводы;
- `Research` работает в первую очередь как retrieval и synthesis слой поверх уже собранной базы;
- `Context Builder` и `Planner` используют готовое понимание проекта, а не сырую кодовую базу.

---

## 2. Почему модель "research на каждый вопрос" неверна

Полный исследовательский проход на каждый пользовательский запрос архитектурно неверен по нескольким причинам.

### 2.1 Он ломает основную ценность платформы

Если система каждый раз стартует почти с нуля, значит она не превращает проект в инженерно понятную среду, а лишь имитирует умный чат с доступом к файлам.

### 2.2 Он делает латентность неприемлемой

Для крупных монолитов или multi-path проектов повторное открытие workspace, повторный индекс и повторный широкий research делают время ответа нестабильным и дорогим.

### 2.3 Он уничтожает reuse

Структурные знания о проекте, граф зависимостей, ранее найденные entry points, hot zones, критические узлы и знания из прошлых запусков должны переиспользоваться, а не вычисляться заново.

### 2.4 Он ухудшает детерминированность

Два соседних вопроса без изменения проекта не должны приводить к двум разным исследовательским картинам только из-за случайного порядка чтения файлов или иного ранжирования evidence.

### 2.5 Он не умеет разделять виды изменений

Пользовательский вопрос может относиться к:

- стабильному закоммиченному состоянию;
- текущей ветке;
- локальным незакоммиченным изменениям;
- только что написанному методу, который ещё не попал в commit.

Полный research-per-question размывает эти уровни и не даёт чёткой модели того, что известно заранее, а что добавлено как локальный overlay.

---

## 3. Архитектурный принцип

Ключевой принцип Project Intelligence Runtime:

`вопрос не должен инициировать полное понимание проекта; вопрос должен использовать уже существующее понимание проекта`

Из этого следуют обязательные правила.

1. Полное структурное изучение проекта выполняется фоново, а не в момент диалога.
2. Текущая ветка рассматривается как отдельный runtime-контекст, но не как новый независимый проект.
3. Локальные незакоммиченные изменения рассматриваются как временный overlay, а не как часть долговременного baseline.
4. Ответ на вопрос строится поверх:
   - baseline project map;
   - branch-aware overlay;
   - worktree-aware overlay;
   - релевантных slices из `Knowledge`;
   - точечного retrieval только там, где реально есть пробел.
5. Система обязана уметь честно различать:
   - "это подтверждено baseline";
   - "это видно только в текущей ветке";
   - "это видно только в локальных незакоммиченных изменениях";
   - "для этого нужен background refresh".

---

## 4. Место в общей архитектуре

Project Intelligence Runtime должен находиться между базовыми источниками проекта и task-time модулями.

Схема взаимодействия:

```text
Workspace / Repository / Git
            |
            v
Project State Monitor
            |
            v
Background Sync Orchestrator
            |
            v
Indexer -> Graph -> Knowledge Refresh
            |
            v
Baseline Project Map
            |
     +------+------+
     |             |
     v             v
Branch Overlay   Worktree Overlay
     |             |
     +------+------+
            |
            v
Question-Time Retrieval
            |
            v
Research -> Context Builder -> Planner -> Answer / Execution
```

### 4.1 Что этот слой координирует

- обнаружение изменения Git-состояния проекта;
- определение, нужен ли новый background sync;
- разрешение, какой baseline является лучшей опорой для текущего branch/worktree состояния;
- построение overlay для локальной разработки;
- подачу downstream-модулям уже готовой project intelligence вместо "чтения проекта с нуля".

### 4.2 Что этот слой не делает

- не заменяет `Indexer`;
- не хранит AST вместо `Indexer`;
- не становится новым `Graph`;
- не принимает инженерные решения вместо `Planner`;
- не отвечает пользователю напрямую вместо `Answer Engine`.

---

## 5. Уровни понимания проекта

Понимание проекта должно быть многослойным.

### 5.1 Repository Baseline

Это слой, привязанный к конкретному commit-level состоянию.

Он должен содержать:

- file manifest;
- parse cache;
- AST cache;
- symbol index;
- dependency index;
- graph fragments;
- validated structural relations;
- базовые knowledge links;
- diagnostics последнего полного или частичного background sync.

### 5.2 Branch Runtime View

Это слой branch-specific различий по отношению к наиболее подходящему baseline.

Он должен содержать:

- branch identity;
- head commit;
- merge base;
- branch-specific changed set;
- branch-local graph deltas;
- branch-specific research slices;
- branch-scoped freshness markers.

### 5.3 Worktree Runtime View

Это слой локальной незакоммиченной разработки.

Он должен содержать:

- staged changes;
- unstaged changes;
- untracked files;
- deleted files;
- rename and move detection;
- временные symbol deltas;
- временные graph invalidation markers;
- advisory-only findings для локального кода.

### 5.4 Knowledge View

Это слой накопленных инженерных выводов, связанных с baseline, branch и историей репозитория.

Он должен различать:

- знания, подтверждённые стабильной структурой;
- знания, относящиеся к конкретной ветке;
- знания, временно выведенные по локальному overlay;
- знания, помеченные как stale после изменения baseline.

---

## 6. Baseline Project Map

Baseline Project Map — это каноническое предсобранное представление проекта, поверх которого должны выполняться пользовательские вопросы.

### 6.1 Что входит в Baseline Project Map

1. Структурный индекс файлов и символов.
2. Dependency graph на уровне файлов, символов, модулей, route, schema и других поддерживаемых сущностей.
3. Нормализованные project zones:
   - modules;
   - bounded contexts;
   - folders;
   - runtime entry points;
   - infrastructure areas;
   - configuration areas.
4. Базовые repository signals:
   - branch at build time;
   - head commit at build time;
   - merge base where applicable.
5. Базовые knowledge anchors:
   - ADR links;
   - prior findings;
   - critical nodes;
   - known risk zones.
6. Diagnostics baseline build.

### 6.2 Что Baseline Project Map не должен содержать

- временные рабочие файлы оператора;
- незакоммиченные черновики как canonical truth;
- непроверенные LLM-гипотезы;
- случайные chat-specific summaries, не прошедшие нормализацию.

### 6.3 Почему baseline должен собираться заранее

Потому что именно baseline превращает проект из набора файлов в адресуемую инженерную карту. Пока baseline не построен, платформа не обладает устойчивым пониманием проекта и вынуждена работать как упрощённый file-reader.

---

## 7. Branch Overlay

Branch Overlay — это слой различий между baseline и текущей веткой.

### 7.1 Назначение

Он нужен для сценариев, где:

- пользователь переключился на другую ветку;
- branch name тот же, но `HEAD` уже другой;
- background sync для новой ветки ещё не завершён;
- часть графа можно переиспользовать, а часть нужно обновить.

### 7.2 Что должен содержать Branch Overlay

- branch identity;
- target `HEAD`;
- merge base с reuse-baseline;
- changed paths относительно reuse-base;
- deleted paths;
- renamed and moved paths;
- branch-specific symbol diff;
- branch-specific graph delta;
- knowledge staleness markers;
- branch-local diagnostics.

### 7.3 Что нельзя делать с Branch Overlay

1. Нельзя копировать весь baseline при каждом переключении ветки.
2. Нельзя считать, что смена ветки автоматически требует full reindex всего проекта.
3. Нельзя смешивать branch overlay разных `HEAD` в один и тот же runtime artifact.

---

## 8. Worktree Overlay

Worktree Overlay — это временный слой, отражающий локальную разработку поверх текущей ветки.

### 8.1 Зачем он нужен

Он обеспечивает главный рабочий сценарий:

- разработчик локально меняет код;
- задаёт вопрос в чате;
- система отвечает с учётом ещё не закоммиченных изменений;
- при этом не разрушает baseline и не выдает локальный черновик за стабильную архитектурную истину.

### 8.2 Что входит в Worktree Overlay

- staged diff;
- unstaged diff;
- untracked files;
- deleted files;
- локальные rename/move;
- file hash delta;
- parse invalidation set;
- AST invalidation set;
- symbol delta;
- локальный graph delta;
- overlay confidence flags.

### 8.3 Особенности жизненного цикла

Worktree Overlay должен быть:

- короткоживущим;
- быстро пересчитываемым;
- дешёвым по сравнению с full baseline build;
- жёстко привязанным к текущему `worktreeFingerprint`;
- пригодным для advisory и review-сценариев;
- неканоническим по отношению к долгоживущему knowledge.

---

## 9. Committed State и Local Development State

Project Intelligence Runtime обязан жёстко разделять два разных инженерных режима.

### 9.1 Committed State

Это то, что подтверждено commit-level состоянием репозитория.

К нему относятся:

- baseline project map;
- branch snapshots, уже поднятые до commit-level state;
- knowledge, связанное с конкретным `HEAD` или merge lineage;
- стабильные graph relations.

### 9.2 Local Development State

Это то, что существует только в текущем рабочем дереве.

К нему относятся:

- незакоммиченные изменения;
- частично написанные методы;
- промежуточные refactor changes;
- локальные эксперименты;
- временные файлы и еще не оформленные решения.

### 9.3 Требование к downstream-модулям

`Research`, `Context Builder`, `Planner` и `Answer Engine` обязаны понимать происхождение факта:

- baseline-backed;
- branch-overlay-backed;
- worktree-overlay-backed.

Это необходимо, чтобы ответ мог честно сказать:

- что уже является частью проекта;
- что относится только к локальной разработке;
- где уверенность ниже из-за отсутствия commit-level стабилизации.

### 9.4 Сценарий локального совета

Пример целевого сценария:

1. Разработчик локально пишет новый метод.
2. Метод ещё не закоммичен.
3. Пользователь спрашивает систему:
   - правильно ли выбран сервис;
   - не нарушает ли метод существующий flow;
   - кого затронет изменение;
   - нет ли конфликта с текущей архитектурой.
4. Система использует:
   - baseline project map;
   - текущий worktree overlay;
   - graph traversal по затронутым узлам;
   - knowledge и ADR;
   - и даёт advisory-ответ без необходимости полного повторного исследования проекта.

---

## 10. Project State Detection

Project Intelligence Runtime должен постоянно понимать, изменилось ли состояние проекта.

### 10.1 Что должно отслеживаться

1. Активная ветка.
2. Текущий `HEAD`.
3. Merge base относительно последнего baseline или основной ветки сравнения.
4. Staged changes.
5. Unstaged changes.
6. Untracked files.
7. Deleted files.
8. Rename and move detection.
9. Изменение набора project paths внутри одного логического проекта.
10. Изменение конфигурации, влияющей на индексирование и graph semantics.

### 10.2 Repository State Identity

Состояние проекта должно идентифицироваться составным ключом:

- `projectId`
- `projectPathId`
- `repositoryId`
- `branchName`
- `headCommit`
- `mergeBase`
- `worktreeFingerprint`
- `changedPathsFingerprint`
- `configurationFingerprint`

### 10.3 Почему одного `HEAD` недостаточно

Потому что два одинаковых `HEAD` могут иметь разные локальные незакоммиченные изменения. Для advisory-режима это принципиально разные состояния.

### 10.4 Почему одного `branchName` недостаточно

Потому что одна и та же ветка может двигаться вперёд, откатываться назад, ребейзиться и иметь разные локальные diff.

---

## 11. Watcher и Polling Strategy

Система не должна полагаться только на ручной запуск sync.

### 11.1 Общий принцип

Project Intelligence Runtime должен использовать гибридную модель:

- быстрые события watcher-уровня для локального сигнала "что-то изменилось";
- периодический polling для верификации Git-состояния и устранения пропущенных событий.

### 11.2 File Watcher responsibilities

Watcher должен уметь замечать:

- изменение файлов внутри активных project paths;
- создание новых файлов;
- удаление файлов;
- массовые rename/move;
- изменение lock/config/runtime-sensitive файлов.

Watcher не должен считаться единственным источником истины, потому что:

- события могут теряться;
- массовые branch switch операции могут выглядеть как шторм изменений;
- часть Git-состояния вообще не видна обычному filesystem watcher.

### 11.3 Git Polling responsibilities

Polling должен проверять:

- branch change;
- head change;
- dirty state transition;
- staged/unstaged set change;
- untracked set change;
- merge/rebase/cherry-pick states;
- окончание или начало конфликтного состояния.

### 11.4 Когда watcher важнее

Watcher особенно важен для локального advisory-режима, где пользователь пишет код и ожидает быструю реакцию на текущие worktree changes.

### 11.5 Когда polling важнее

Polling особенно важен при:

- переключении ветки;
- изменении индекса Git без прямой правки файлов через IDE;
- восстановлении после перезапуска приложения;
- обнаружении рассинхронизации между сохранённым runtime state и фактическим состоянием репозитория.

---

## 12. Background Intelligence Pipeline

Background pipeline должен быть основным механизмом создания и обновления project intelligence.

### 12.1 Цель background sync

Цель не "ответить на вопрос", а "подготовить максимально актуальную project map для будущих вопросов".

### 12.2 Основные стадии

```text
[State Detected]
      |
      v
[Baseline Resolution]
      |
      v
[Reuse Decision]
      |
      +--> [Reuse Existing Baseline]
      |
      +--> [Partial Incremental Refresh]
      |
      +--> [Full Rebuild]
      |
      v
[Indexer Refresh]
      |
      v
[Graph Refresh]
      |
      v
[Knowledge Freshness Update]
      |
      v
[Project Intelligence Snapshot Persisted]
```

### 12.3 Подробный смысл стадий

#### State Detected

Определяется текущее branch/worktree состояние и факт его отличия от последнего известного runtime state.

#### Baseline Resolution

Система определяет, какой существующий snapshot является лучшей опорой:

- exact commit snapshot;
- branch-nearest snapshot;
- merge-base snapshot;
- last successful project-path snapshot.

#### Reuse Decision

Система выбирает стратегию:

- reuse без перестройки;
- частичное обновление по diff;
- полная пересборка.

#### Indexer Refresh

Обновляются только необходимые shards:

- file index;
- parse cache;
- AST cache;
- symbol extraction;
- dependency fragments.

#### Graph Refresh

Пересобираются только затронутые graph fragments и проводится cleanup устаревших узлов и связей.

#### Knowledge Freshness Update

Знания не пересобираются как текст заново без причины, но получают:

- freshness re-evaluation;
- stale markers;
- branch/worktree scope markers;
- linkage repair при rename/move.

#### Snapshot Persisted

Фиксируется новый baseline или branch-aware snapshot, который может обслуживать следующие вопросы без повторного full research.

---

## 13. Question-Time Retrieval Pipeline

Вопрос пользователя должен использовать уже собранную intelligence, а не инициировать её с нуля.

### 13.1 Принцип

Question pipeline должен быть lightweight по отношению к background pipeline.

### 13.2 Допустимые действия во время вопроса

1. Проверить актуальность baseline для текущего branch/worktree состояния.
2. Поднять текущий branch overlay.
3. Поднять текущий worktree overlay.
4. Выбрать релевантные graph zones.
5. Достать релевантные knowledge slices.
6. Выполнить узкий gap-fill retrieval только по тем местам, где overlay или baseline недостаточны.
7. Сформировать research answer или execution planning input.

### 13.3 Недопустимые действия во время обычного вопроса

1. Полный rescan всего проекта без явной необходимости.
2. Полный reindex всех файлов.
3. Полный graph rebuild на ровном месте.
4. Скрытый operator-невидимый full background run.

### 13.4 Textual flow

```text
User Question
      |
      v
[Resolve Active Project + Path + Branch]
      |
      v
[Load Best Baseline Snapshot]
      |
      v
[Apply Branch Overlay]
      |
      v
[Apply Worktree Overlay]
      |
      v
[Select Relevant Graph / Knowledge Slices]
      |
      v
[Narrow Retrieval Only If Needed]
      |
      v
[Research Synthesis]
      |
      v
[Context / Answer / Plan]
```

### 13.5 Что такое narrow retrieval

Это не повторный большой research. Это точечный доступ к конкретным файлам, символам или graph-fragments, если уже существующая карта не покрывает нужный локальный вопрос.

### 13.6 Приоритет точной сущности над graph-neighbor expansion

Для больших baseline-driven репозиториев narrow retrieval обязан соблюдать строгий порядок приоритета:

1. `git-scoped overlay` и локально изменённые пути;
2. прямые entity/symbol/path matches из вопроса;
3. direct graph matches по label/filePath;
4. только после этого — дозированное `graph-neighbor` expansion.

Это требование появилось после живого stress-теста на большом PHP-монолите: более graph-dense соседний домен может иметь больше связей, чем реально искомая сущность, и без отдельного budget под direct match question-run начинает отвечать не на ту feature-зону, которую спросил пользователь.

Следствие:

- selective workspace slice должен **резервировать budget** под direct matches;
- `graph-neighbor` не должен конкурировать с точной сущностью за весь retrieval budget;
- graph нужен для controlled expansion вокруг уже найденного ядра, а не для подмены сущностного retrieval.

Иными словами, правильная модель question-time retrieval:

`сначала понять, о какой сущности спрашивает пользователь -> затем расширить контекст графом`

а не:

`сначала взять самый плотный graph neighborhood -> надеяться, что нужная сущность окажется внутри него`.

---

## 14. Invalidation и Refresh Rules

Project Intelligence Runtime должен явно понимать, когда какая часть состояния устарела.

### 14.1 Что инвалидируется при разных изменениях

#### Изменение содержимого файла

Инвалидируются:

- parse cache для файла;
- AST cache для файла;
- symbols, извлечённые из файла;
- file-backed graph fragments;
- зависимые knowledge freshness links.

#### Rename или move файла

Инвалидируются:

- file identity binding на path-level;
- import/dependency anchors;
- route/config/path-based heuristics;
- file-based graph edges;
- links между knowledge и старым physical path.

При этом стабильная symbol identity по возможности должна сохраняться, если содержание и semantic identity символа не разрушены.

#### Смена ветки

Инвалидируются:

- текущий branch overlay;
- текущий worktree overlay;
- freshness status последнего baseline;
- question-time readiness для exact state.

Не обязательно инвалидировать весь baseline corpus, если существует reuse base.

#### Новый commit в текущей ветке

Инвалидируются:

- branch overlay;
- affected graph shards;
- knowledge freshness anchors, связанные с затронутыми зонами.

#### Локальные незакоммиченные изменения

Не должны разрушать baseline. Они должны только строить или обновлять worktree overlay.

### 14.2 Когда нужен forced background refresh

1. Нет пригодного baseline.
2. Изменена значимая конфигурация индексирования.
3. Слишком много затронутых зон, и overlay становится почти равен full diff.
4. Graph consistency validator не может безопасно применить partial refresh.
5. Rename/move storm делает reuse ненадёжным.

---

## 15. Persistence Model

Система должна различать, что хранится долговременно, а что существует только как runtime-layer.

### 15.1 Что хранится долговременно

- commit snapshots;
- branch snapshots для часто используемых состояний;
- file manifests;
- parse cache metadata;
- AST cache metadata;
- symbol index;
- graph fragments;
- background diagnostics;
- knowledge links и freshness markers;
- repository state lineage.

### 15.2 Что хранится ограниченно

- worktree overlays;
- temporary local symbol deltas;
- question-scoped retrieval traces;
- transient advisory diagnostics.

Эти данные должны иметь retention policy и не засорять постоянное хранилище как будто они являются канонической историей проекта.

### 15.3 Что вообще не должно становиться persistent truth

- черновые локальные артефакты без нормализации;
- speculative LLM observations;
- chat-specific summaries без evidence;
- случайные runtime caches без identity и invalidation semantics.

---

## 16. UI и Operator Signals

Пользовательский UX может оставаться chat-first, но система обязана прозрачно показывать состояние project intelligence.

### 16.1 Что должно быть видно пользователю

1. Активный проект.
2. Активный project path.
3. Текущая ветка.
4. Short `HEAD`.
5. Наличие локальных незакоммиченных изменений.
6. Freshness baseline.
7. Наличие exact baseline для текущего branch/worktree state.
8. Признак "нужна фоновая пересборка".
9. Кнопка принудительного refresh project intelligence.

### 16.2 Что должно быть видно в advanced/inspector слое

- baseline source;
- branch overlay summary;
- worktree overlay summary;
- changed paths count;
- reused vs reindexed counters;
- graph invalidation scope;
- knowledge freshness status;
- diagnostics последнего background sync.

### 16.3 Важный UX-принцип

Пользователь не обязан знать внутренние детали `Indexer`, `Graph` и `Knowledge`, но должен понимать простую правду:

- проект уже изучен;
- система знает, на какой ветке он находится;
- система видит локальные изменения;
- если знаний недостаточно, это честно показано.

---

## 17. Diagnostics и Statistics

Project Intelligence Runtime должен собирать отдельный слой операционных метрик.

### 17.1 Diagnostics

- baseline readiness;
- snapshot age;
- branch drift;
- worktree drift;
- invalidation reason;
- refresh trigger reason;
- overlay build errors;
- partial refresh failures;
- stale knowledge count;
- exact-state match availability.

### 17.2 Statistics

- количество background sync по проекту и по ветке;
- reuse hit ratio;
- full rebuild ratio;
- partial refresh ratio;
- average overlay build time;
- average question-time retrieval time;
- changed files per run;
- branch switch frequency;
- worktree churn frequency;
- stale-to-fresh transition rate.

### 17.3 Практическая цель diagnostics

Эти метрики нужны не только для observability, но и для будущей автооптимизации:

- когда пора строить branch-specific snapshot заранее;
- какие ветки требуют отдельного retention;
- где partial refresh даёт реальную экономию;
- когда вопросный pipeline слишком часто упирается в недостаток baseline.

---

## 18. Производительность

Project Intelligence Runtime должен оптимизироваться вокруг reuse.

### 18.1 Основные стратегии

1. Reuse commit-level baseline вместо полного rebuild.
2. Build branch overlay вместо дублирования project map.
3. Build worktree overlay вместо загрязнения baseline.
4. Reuse parse cache и AST cache для неизменённых файлов.
5. Reuse graph fragments для неизменённых зон.
6. Reuse knowledge slices с freshness revalidation вместо полного повторного извлечения.
7. Запуск background sync вне question path.

### 18.2 Что особенно важно для больших проектов

- selective refresh по changed paths;
- project path isolation для multi-path project model;
- dedupe одинаковых branch/worktree states;
- throttling background refresh при file-change storm;
- coalescing событий watcher и polling.

---

## 19. Отказоустойчивость

### 19.1 Если watcher пропустил изменения

Polling обязан обнаружить рассинхронизацию и инициировать корректирующий refresh.

### 19.2 Если Git временно недоступен

Система должна:

- пометить branch/worktree state как unknown;
- не утверждать freshness там, где она не подтверждена;
- по возможности использовать последний подтверждённый baseline в degraded mode.

### 19.3 Если partial refresh не удался

Система должна:

- остановить применение неполного результата как canonical truth;
- пометить snapshot как failed or incomplete;
- при необходимости перевести проект в состояние "требуется full background refresh".

### 19.4 Если worktree overlay не собран

Система должна честно сообщить, что локальные незакоммиченные изменения не учтены полностью, а advisory-answer строится только по commit/branch state.

---

## 20. Ограничения

1. Project Intelligence Runtime не может гарантировать мгновенную идеальную синхронизацию при массовых изменениях файлов.
2. Локальный overlay всегда менее стабилен, чем commit-backed baseline.
3. Некоторые language providers могут поддерживать partial overlays лучше других.
4. На очень больших monorepo branch-aware intelligence может требовать path-scoped приоритезации вместо полного покрытия всего репозитория.
5. Если пользователь работает в конфликтном merge/rebase состоянии, часть graph и knowledge выводов должна понижать confidence.

---

## 21. Будущее развитие

Архитектура должна позволять без переделки базовых принципов добавить:

1. Более глубокий semantic diff на уровне символов и API surface.
2. Cross-branch knowledge transfer с явной confidence-моделью.
3. Predictive warmup для часто используемых веток и путей.
4. Auto-refresh policy по активности разработчика и типу проекта.
5. Расширенную поддержку monorepo с несколькими репозиториями и несколькими named paths.
6. Time-aware project intelligence, где можно осознанно спрашивать не только "что сейчас", но и "что было известно на определённом commit".
7. Интеграцию с будущими `Memory` и `Execution` слоями без превращения question path в полный research pass.

---

## Заключение

Project Intelligence Runtime фиксирует фундаментальный operating model платформы:

- проект изучается заранее;
- branch и worktree состояния отслеживаются постоянно;
- baseline, branch overlay и worktree overlay существуют как разные инженерные слои;
- вопрос пользователя работает поверх уже собранной карты проекта;
- локальная разработка учитывается как временный overlay, а не как замена канонического знания.

Именно эта модель позволяет Client стать не очередным AI-чатом с доступом к файлам, а системой, которая действительно знает проект и может сопровождать разработчика в реальном процессе работы.
