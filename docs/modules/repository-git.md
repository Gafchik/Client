# Repository Git Intelligence

**Статус:** Спецификация модуля  
**Версия:** 1.0.0  
**Зависимости:** Event System, Storage Architecture, Workspace, Indexer, Graph, Research, Impact Analysis, Context Builder, Planner, Execution Engine, Knowledge

---

## Оглавление

1. [Назначение](#1-назначение)
2. [Ответственность](#2-ответственность)
3. [Входные данные](#3-входные-данные)
4. [Выходные данные](#4-выходные-данные)
5. [Архитектура модуля](#5-архитектура-модуля)
6. [Repository Model](#6-repository-model)
7. [Working State Model](#7-working-state-model)
8. [History Intelligence Model](#8-history-intelligence-model)
9. [Git Provider System](#9-git-provider-system)
10. [Интеграция с Workspace](#10-интеграция-с-workspace)
11. [Интеграция с Indexer и Graph](#11-интеграция-с-indexer-и-graph)
12. [Интеграция с Research](#12-интеграция-с-research)
13. [Интеграция с Planner](#13-интеграция-с-planner)
14. [Интеграция с Execution Engine](#14-интеграция-с-execution-engine)
15. [Интеграция с Knowledge](#15-интеграция-с-knowledge)
16. [Pipeline работы модуля](#16-pipeline-работы-модуля)
17. [События](#17-события)
18. [Versioning и Snapshot](#18-versioning-и-snapshot)
19. [Производительность](#19-производительность)
20. [Отказоустойчивость](#20-отказоустойчивость)
21. [Ограничения](#21-ограничения)
22. [Будущее развитие](#22-будущее-развитие)

---

## 1. Назначение

### 1.1 Что такое Repository Git Intelligence

Repository Git Intelligence — это модуль, который превращает Git-репозиторий из простого механизма хранения версий в **исторический и операционный источник инженерных знаний** для всей платформы.

Если `Graph` отвечает на вопрос:

`Как проект устроен сейчас?`

то Repository Git Intelligence отвечает на вопросы:

- как проект пришёл к текущему состоянию;
- какие части системы менялись вместе;
- какие зоны являются нестабильными;
- какие изменения сейчас находятся в рабочем дереве;
- какой commit, branch и merge context являются базой для текущего анализа;
- почему конкретный файл или модуль считается рискованным;
- кто и когда последний раз менял критическую область;
- какие rename, move и split происходили исторически.

### 1.2 Почему модуль существует

Без Git-подсистемы платформа видит только статический снимок проекта. Этого недостаточно для инженерной работы высокого качества, потому что реальное понимание проекта всегда имеет два измерения:

- **структурное** — как код и зависимости устроены сейчас;
- **историческое** — как и почему эти зависимости появились, менялись и ломались.

Именно историческое измерение позволяет:

- понимать активную зону разработки;
- отличать стабильные области от горячих;
- находить причины регрессий;
- оценивать риск конфликтов;
- строить rollback и checkpoint стратегии;
- объяснять, почему связанные файлы должны анализироваться вместе.

### 1.3 Какие задачи решает модуль

Repository Git Intelligence решает следующие классы задач:

1. Нормализация текущего Git-состояния проекта.
2. Выявление изменённой зоны проекта на уровне файлов, путей и структурных сущностей.
3. Предоставление исторического контекста для `Research`, `Impact Analysis` и `Planner`.
4. Поддержка безопасного выполнения через checkpoints, rollback base и run-scoped change tracking.
5. Формирование исторических сигналов для `Knowledge`.
6. Декуплинг платформы от конкретного Git backend через Provider System.

### 1.4 Чем модуль отличается от Graph

`Graph` — это каноническая модель **текущих** зависимостей проекта.

Repository Git Intelligence:

- не хранит AST;
- не подменяет `Graph`;
- не является структурной моделью проекта;
- не определяет зависимости сам по себе;
- не выступает каноническим источником текущей структуры.

Он поставляет:

- revision context;
- change context;
- commit lineage;
- rename and blame context;
- churn and co-change signals;
- rollback and branch safety signals.

То есть `Graph` моделирует текущее устройство, а Git Intelligence моделирует **эволюцию и текущее состояние репозитория как носителя изменений**.

### 1.5 Чем модуль отличается от Knowledge

`Knowledge` хранит инженерные выводы, ADR, explanations и накопленные знания.

Repository Git Intelligence не хранит объяснения как таковые. Он хранит и вычисляет:

- факты Git-состояния;
- исторические цепочки;
- change patterns;
- provenance signals.

`Knowledge` может использовать эти сигналы для фиксации выводов вроде:

- "этот модуль часто меняется вместе с billing";
- "эта зона нестабильна последние 3 месяца";
- "этот компонент связан с историей багов rollback/status generation".

Но сами первичные Git-факты принадлежат Git-подсистеме.

### 1.6 Принцип архитектурной позиции

Git должен жить не как случайная утилита внутри `Research` и не как деталь `Workspace`.

Правильная позиция модуля:

- `Workspace` отвечает за файловую среду выполнения;
- `Graph` отвечает за текущую структурную модель;
- `Repository Git Intelligence` отвечает за историческое и операционное состояние репозитория;
- `Research`, `Planner`, `Execution Engine` и `Knowledge` используют его как фундаментальный источник.

Иными словами, Git — это не вспомогательный tool call, а **отдельный слой инженерного понимания проекта**.

---

## 2. Ответственность

### 2.1 Что входит в ответственность модуля

1. Определение текущего repository context:
   - активная ветка;
   - `HEAD`;
   - upstream;
   - merge base;
   - repository root;
   - dirty state.
2. Выявление рабочего состояния дерева:
   - staged changes;
   - unstaged changes;
   - untracked files;
   - deleted files;
   - renamed files;
   - moved files.
3. Построение нормализованной модели diff.
4. Построение нормализованной модели commit history.
5. Предоставление file history, rename history и blame history.
6. Определение co-change сигналов и hot zones.
7. Предоставление signals для частичного индексирования и selective analysis.
8. Поддержка checkpoint и rollback base для `Execution Engine` и `Workspace`.
9. Определение run-scoped changed set:
   - что было изменено до запуска;
   - что изменено в рамках текущего запуска;
   - что появилось после запуска как внешний дрейф.
10. Публикация repository events.
11. Подготовка производных исторических сигналов для `Knowledge`.
12. Абстрагирование конкретного Git backend через provider layer.

### 2.2 Что не входит в ответственность модуля

1. Модуль не парсит код и не строит AST.
2. Модуль не заменяет `Indexer`.
3. Модуль не заменяет `Graph`.
4. Модуль не принимает архитектурные решения.
5. Модуль не изменяет код сам по себе.
6. Модуль не выполняет задачи вместо `Execution Engine`.
7. Модуль не формирует `Research Report`, `Impact Report` или `Execution Plan` как финальные артефакты.
8. Модуль не хранит долгоживущие инженерные интерпретации вместо `Knowledge`.
9. Модуль не должен быть единственным источником истины о rename/move на уровне символов; символная идентичность остаётся в зоне `Indexer` и `Graph`.
10. Модуль не должен напрямую управлять UI.

---

## 3. Входные данные

### 3.1 Git Repository

Основной вход модуля — локальный Git-репозиторий проекта.

Из него извлекаются:

- refs;
- objects;
- index state;
- commit graph;
- tags;
- working tree state;
- rename and diff metadata.

### 3.2 Workspace Context

Модуль получает от `Workspace`:

- путь к активной рабочей директории;
- run context;
- base revision;
- информацию о sandbox boundaries;
- сведения о временных snapshot и checkpoint.

### 3.3 Project Metadata

Используется для:

- привязки repository state к `projectId`;
- разделения нескольких репозиториев;
- поддержки monorepo и multi-repository сценариев;
- определения политики сканирования истории.

### 3.4 Configuration

Конфигурация определяет:

- глубину исторического анализа;
- retention cache для diff/blame/history;
- лимиты по объёму history traversal;
- правила анализа submodules;
- правила анализа tags и release branches;
- допустимые provider backends;
- правила redaction для чувствительных данных.

### 3.5 Manual Decisions и ADR

ADR и manual decisions нужны для связывания Git-сигналов с архитектурными событиями:

- какой commit реализовал ADR;
- какие модули были затронуты архитектурным изменением;
- когда история изменений противоречит текущим архитектурным ожиданиям.

### 3.6 Diagnostics

Модуль должен учитывать:

- повреждённый Git index;
- detached HEAD;
- shallow clone;
- недоступный remote;
- частично доступную историю;
- сбои rename detection;
- ограничения sandbox на git operations.

---

## 4. Выходные данные

### 4.1 Repository Snapshot

Нормализованный снимок состояния репозитория на момент анализа:

- `repositoryId`
- `rootPath`
- `branch`
- `headCommit`
- `upstream`
- `mergeBase`
- `isDirty`
- `isDetachedHead`
- `hasUnmergedPaths`
- `hasUntrackedFiles`
- `snapshotTimestamp`

### 4.2 Working Tree Change Set

Нормализованный набор текущих изменений:

- staged files;
- unstaged files;
- untracked files;
- deleted files;
- renamed files;
- moved files;
- binary files;
- ignored-but-relevant anomalies.

### 4.3 Diff Intelligence Package

Пакет сведений для downstream-модулей:

- path-level diff;
- file-level change type;
- approximate change magnitude;
- rename confidence;
- file pairing old/new path;
- branch divergence signals;
- overlap with current plan scope.

### 4.4 History Intelligence Package

Набор исторических сигналов:

- file history;
- symbol-associated file lineage;
- commit clusters;
- co-change neighborhoods;
- hotspot markers;
- instability markers;
- ownership hints;
- release ancestry;
- suspected regression origin windows.

### 4.5 Repository Diagnostics

Диагностика качества и полноты:

- history completeness;
- rename confidence;
- blame completeness;
- shallow clone warnings;
- dirty tree severity;
- unmerged state blockers;
- remote divergence markers.

### 4.6 Repository Events

Модуль публикует события для:

- `Indexer`;
- `Graph`;
- `Research`;
- `Planner`;
- `Execution Engine`;
- `Knowledge`.

### 4.7 Derived Historical Signals for Knowledge

Производные сигналы, пригодные для накопления:

- frequently co-changed modules;
- stable zones;
- hot zones;
- ownership concentration;
- rollback-prone areas;
- release-critical surfaces.

---

## 5. Архитектура модуля

```
Repository Git Intelligence
├── Repository Coordinator
├── Repository Provider Manager
├── Working Tree Inspector
├── Revision Resolver
├── Diff Analyzer
├── Rename and Move Detector
├── History Traversal Engine
├── Blame and Provenance Resolver
├── Co-change Analyzer
├── Hotspot Analyzer
├── Change Scope Mapper
├── Checkpoint Manager
├── Rollback Base Resolver
├── Diagnostics Manager
├── Cache Manager
├── Event Publisher
└── Knowledge Signal Exporter
```

### 5.1 Repository Coordinator

Центральный оркестратор модуля. Отвечает за:

- жизненный цикл repository scan;
- координацию provider calls;
- консолидацию snapshot, diff и history data;
- публикацию unified repository intelligence package.

### 5.2 Repository Provider Manager

Абстрагирует backend:

- локальный Git CLI;
- libgit-style engine;
- remote-integrated providers;
- будущие SaaS-провайдеры.

### 5.3 Working Tree Inspector

Отвечает за текущее состояние дерева:

- dirty state;
- staged/unstaged split;
- untracked;
- merge conflicts;
- file presence drift.

### 5.4 Revision Resolver

Определяет:

- branch;
- `HEAD`;
- parent commits;
- merge base;
- divergence относительно upstream;
- base revision для run и reindex.

### 5.5 Diff Analyzer

Нормализует изменения в пригодный для системы пакет:

- added;
- modified;
- deleted;
- renamed;
- copied;
- mode-changed;
- binary-changed.

### 5.6 Rename and Move Detector

Отвечает за устойчивое сопоставление:

- старого и нового пути;
- move внутри модуля;
- move между модулями;
- rename без изменения содержания;
- rename с частичной переработкой файла.

### 5.7 History Traversal Engine

Выполняет исторические запросы:

- commit lineage;
- file history;
- path ancestry;
- change windows;
- release ancestry;
- commit neighborhoods.

### 5.8 Blame and Provenance Resolver

Нужен для ответов типа:

- кто последний менял этот файл;
- кто менял эту строку;
- какой commit внёс это поведение;
- какое изменение вероятно стало причиной регрессии.

### 5.9 Co-change Analyzer

Строит исторические сигналы совместных изменений:

- какие файлы часто меняются вместе;
- какие модули образуют change cluster;
- какие области исторически связаны, хотя не очевидно связаны структурно.

### 5.10 Hotspot Analyzer

Оценивает:

- churn;
- volatility;
- частоту изменений;
- скопление конфликтов;
- риск нестабильности.

### 5.11 Change Scope Mapper

Преобразует file-level Git signals в пригодную карту для `Indexer` и `Graph`:

- candidate files for reindex;
- affected folders;
- likely affected modules;
- potential structural invalidation scope.

### 5.12 Checkpoint Manager

Поддерживает:

- pre-execution repository checkpoint;
- checkpoint lineage;
- run-scoped delta registration;
- post-execution reconciliation.

### 5.13 Rollback Base Resolver

Определяет безопасную точку возврата:

- base commit;
- stable snapshot;
- merge-safe recovery point;
- user-visible recovery marker.

### 5.14 Diagnostics Manager

Оценивает корректность Git-данных и выставляет trust level для downstream-модулей.

### 5.15 Knowledge Signal Exporter

Преобразует производные исторические сигналы в форму, пригодную для долговременного накопления в `Knowledge`.

---

## 6. Repository Model

### 6.1 Repository как доменная сущность

В архитектуре Client `Repository` — это не просто путь на диске, а инженерная сущность со следующими аспектами:

- identity;
- root path;
- VCS type;
- active revision context;
- history availability;
- provider binding;
- workspace bindings;
- project bindings.

### 6.2 Repository Identity

Идентичность репозитория должна быть стабильной и не зависеть только от абсолютного пути.

Она должна учитывать:

- canonical root;
- VCS identity;
- provider identity;
- remote origin fingerprints;
- project binding.

Это нужно, чтобы:

- перенос рабочей копии не порождал новый logical repository;
- `Knowledge` и `Graph` могли устойчиво ссылаться на тот же репозиторий;
- история запусков не дробилась из-за смены локального пути.

### 6.3 Repository Boundaries

Модуль обязан уметь определять:

- корень репозитория;
- границы monorepo;
- вложенные Git repositories;
- submodules;
- внешние зависимости вне репозитория;
- рабочую область текущего проекта внутри монорепозитория.

### 6.4 Revision Context

Repository model должен хранить:

- active branch;
- `HEAD`;
- target upstream;
- merge base;
- ahead/behind signals;
- detached head state;
- active tag context, если применимо.

---

## 7. Working State Model

### 7.1 Почему рабочее состояние важно

Для платформы недостаточно знать только commit history. Нужно понимать текущее рабочее дерево, потому что пользователь может:

- уже изменить файлы локально;
- иметь staged, но не committed изменения;
- находиться в середине merge;
- иметь незакоммиченные эксперименты;
- держать важные untracked файлы.

Если система проигнорирует это, `Planner` и `Execution Engine` построят небезопасный план.

### 7.2 Слои текущего состояния

Working state model обязан различать:

1. `HEAD state`
2. `Index state`
3. `Working tree state`
4. `Run-local mutations`
5. `External drift after run start`

### 7.3 Типы изменений

Нужно различать:

- added;
- modified;
- deleted;
- renamed;
- moved;
- copied;
- binary changed;
- permission changed;
- conflict state.

### 7.4 Run-scoped change ownership

Система должна уметь отделять:

- изменения, существовавшие до запуска;
- изменения, сделанные текущим запуском;
- внешние изменения, появившиеся после старта запуска.

Это критично для:

- безопасного rollback;
- корректного post-run diff;
- точного повторного индексирования;
- объяснимого отчёта пользователю.

---

## 8. History Intelligence Model

### 8.1 История как источник знаний

История нужна не только для просмотра коммитов. Она должна давать инженерные сигналы.

Ключевые типы сигналов:

- change frequency;
- co-change;
- author concentration;
- recent instability;
- regression windows;
- release proximity;
- architectural churn;
- rename lineage.

### 8.2 File History

Для каждого значимого файла модуль должен уметь восстановить:

- историю изменений;
- rename lineage;
- периоды высокой активности;
- ближайшие связанные изменения;
- активных авторов;
- коммиты, влияющие на текущую форму файла.

### 8.3 Module History

История должна агрегироваться и на уровне модуля:

- сколько раз модуль менялся;
- какие подмодули менялись совместно;
- насколько модуль стабилен;
- какие релизы его затрагивали;
- какие соседние модули исторически с ним сцеплены.

### 8.4 Change Clusters

Исторический кластер изменений — это группа файлов или модулей, которые часто изменяются вместе.

Это важно, потому что:

- структурная зависимость не всегда показывает operational coupling;
- historical co-change может выявить скрытую связность;
- `Research` и `Planner` могут расширять зону анализа не только по `Graph`, но и по Git-сигналам.

### 8.5 Regression Origin Windows

Модуль должен поддерживать понятие окна вероятного происхождения дефекта:

- между каким стабильным revision и текущим revision произошёл сбой;
- какие коммиты затрагивали связанную область;
- какие авторы и ветки участвовали;
- были ли rename/move, скрывающие реальное происхождение кода.

Это особенно важно для запросов типа:

- "почему перестал работать rollback bill status generate";
- "кто и когда затронул эту логику";
- "какая серия изменений могла принести регрессию".

---

## 9. Git Provider System

### 9.1 Цель Provider System

Git-подсистема не должна жёстко зависеть от одного способа доступа к репозиторию.

Нужна provider-архитектура, чтобы остальные модули использовали стабильный контракт, а не конкретный Git backend.

### 9.2 Базовые provider-классы

Система должна поддерживать как минимум следующие классы провайдеров:

- `Local Git Provider`
- `Remote Metadata Provider`
- `Hosting Platform Provider`
- `Composite Repository Provider`

### 9.3 Local Git Provider

Отвечает за:

- локальный status;
- local diff;
- local history;
- local blame;
- local branch graph;
- local rename detection.

Это основной provider для MVP и локальной работы.

### 9.4 Remote Metadata Provider

Нужен для получения данных, которые полезны, но не всегда выражены локально:

- default branch;
- protected branches;
- remote divergence;
- remote tags;
- release metadata.

### 9.5 Hosting Platform Provider

Должен позволять подключать:

- GitHub
- GitLab
- Bitbucket
- Azure DevOps

без изменения логики `Research`, `Planner`, `Execution Engine` и `Knowledge`.

### 9.6 Composite Provider

Позволяет объединять:

- локальный Git как источник текущего состояния;
- hosting-platform provider как источник release/PR metadata;
- будущие enterprise-интеграции.

### 9.7 Provider Independence Principle

Ни один downstream-модуль не должен знать, откуда именно пришёл Git-сигнал.

Он должен получать:

- нормализованный repository snapshot;
- diff package;
- history package;
- diagnostics.

---

## 10. Интеграция с Workspace

### 10.1 Разделение ролей

`Workspace` и Repository Git Intelligence тесно связаны, но не совпадают.

`Workspace` отвечает за:

- изоляцию;
- файловую среду;
- sandbox;
- lifecycle run.

Repository Git Intelligence отвечает за:

- repository state;
- commit lineage;
- diff awareness;
- rollback base;
- repository-safe checkpoints.

### 10.2 Что Git-модуль получает от Workspace

- путь к workspace copy;
- base revision;
- run identifier;
- scope boundaries;
- checkpoint lifecycle signals.

### 10.3 Что Workspace получает от Git-модуля

- безопасную базовую revision;
- dirty state before run;
- merge risk signals;
- changed set;
- rollback anchors;
- repository drift warnings.

### 10.4 Почему Git не должен жить внутри Workspace

Если встроить Git внутрь `Workspace` как внутреннюю деталь, система потеряет:

- переиспользуемость Git-сигналов другими модулями;
- исторические запросы вне сценария выполнения;
- единый источник repository intelligence;
- возможность развивать Git как knowledge-dimension платформы.

Поэтому Git должен быть самостоятельным модулем с отдельной ответственностью.

---

## 11. Интеграция с Indexer и Graph

### 11.1 Как Git помогает Indexer

Git-модуль должен поставлять `Indexer` сигналы для:

- полного индексирования;
- инкрементального индексирования;
- selective reindex;
- rename-aware reindex;
- move-aware invalidation.

### 11.2 Candidate Set для переиндексации

На основе Git-данных формируется:

- список изменённых файлов;
- список удалённых файлов;
- пары `oldPath -> newPath`;
- зоны возможной structural invalidation;
- признаки того, что безопаснее сделать full reindex.

### 11.3 Как Git помогает Graph

`Graph` не должен хранить всю историю Git, но может использовать производные сигналы:

- `lastChangedAt`
- `recentChurnLevel`
- `coChangeClusterId`
- `hotspotFlag`
- `activeDevelopmentFlag`
- `historicalOwnershipHint`

Это не превращает `Graph` в Git-базу. Это лишь обогащает текущую структурную модель историческими маркерами.

### 11.4 Rename, Move и Structural Continuity

Git-подсистема предоставляет file-level continuity, а `Indexer` и `Graph` решают continuity на уровне символов.

Разделение обязанностей:

- Git определяет, что файл, вероятно, был перемещён или переименован;
- `Indexer` определяет, какие символы внутри него сохранили идентичность;
- `Graph` применяет update без дублирования и orphan nodes.

---

## 12. Интеграция с Research

### 12.1 Когда Research обязан использовать Git

`Research` должен обращаться к Git-подсистеме, когда вопрос требует:

- исторического контекста;
- анализа недавних изменений;
- поиска причин регрессии;
- поиска активной зоны разработки;
- исследования уже изменённых файлов;
- объяснения, почему модули меняются вместе;
- понимания авторства и происхождения поведения.

### 12.2 Какие типы исследований усиливаются Git-данными

- historical research;
- regression analysis;
- change-intent discovery;
- active-zone research;
- impact validation by recent history;
- architectural drift detection.

### 12.3 Graph + Git в Research

Research должен объединять два взгляда:

- `Graph`: что связано сейчас;
- `Git`: что менялось вместе исторически и что меняется сейчас.

Это позволяет отвечать не только:

- "что связано?"

но и:

- "почему это разумно исследовать вместе?";
- "почему эта зона считается рискованной?";
- "какая серия изменений могла это сломать?".

### 12.4 Когда одного Graph недостаточно

Одного `Graph` недостаточно, когда:

- ошибка появилась недавно;
- важны staged/unstaged изменения;
- нужно понять regression window;
- structural relation отсутствует, но есть strong co-change pattern;
- файл был переименован и его история скрыта для path-only анализа.

---

## 13. Интеграция с Planner

### 13.1 Что Planner должен получать

`Planner` должен получать:

- dirty workspace markers;
- changed scope before planning;
- merge conflict risk;
- branch divergence risk;
- hot zone markers;
- co-change neighborhoods;
- rollback anchors;
- unstaged/staged overlap with plan scope.

### 13.2 Как Git влияет на планирование

Git-сигналы влияют на:

- выбор безопасной последовательности шагов;
- необходимость human approval;
- блокировку выполнения при конфликтном состоянии;
- планирование rollback;
- оценку риска изменения нестабильной зоны;
- выделение validation scope.

### 13.3 Планирование поверх существующих локальных изменений

Если пользователь уже изменил релевантные файлы, `Planner` должен:

- отметить это как риск;
- не предполагать чистое исходное состояние;
- при необходимости сузить mutation scope;
- в опасных сценариях запрашивать явное подтверждение.

### 13.4 Merge Conflict Awareness

Planner должен учитывать:

- насколько ветка ушла от upstream;
- не находятся ли target files в активной зоне конфликтов;
- не менялись ли те же файлы недавно в соседних ветках или релизной линии, если такая информация доступна.

---

## 14. Интеграция с Execution Engine

### 14.1 Что Execution Engine получает от Git-модуля

- pre-run repository snapshot;
- rollback base;
- checkpoint anchors;
- changed-set ownership tracking;
- post-step diff summaries;
- drift detection.

### 14.2 Checkpoint перед изменениями

Перед началом мутаций `Execution Engine` обязан зафиксировать repository checkpoint через Git-подсистему.

Checkpoint нужен для:

- безопасного возврата;
- сравнения до/после;
- фиксации факта внешнего дрейфа;
- объяснимого execution report.

### 14.3 Rollback

Git-модуль должен обеспечивать не сам rollback plan, а repository-safe primitives для него:

- к чему откатываться;
- какие файлы были изменены текущим run;
- были ли внешние изменения, мешающие чистому откату;
- возможен ли чистый rollback или нужен human intervention.

### 14.4 Post-run reconciliation

После завершения run Git-модуль должен помочь определить:

- что именно изменил текущий run;
- какие изменения были уже до него;
- были ли файлы затронуты извне;
- нужно ли инициировать reindex и graph refresh.

---

## 15. Интеграция с Knowledge

### 15.1 Что должно попадать в Knowledge

В `Knowledge` должны попадать не сырые Git-логи, а производные устойчивые знания:

- часто совместно изменяемые модули;
- исторически нестабильные зоны;
- ownership patterns;
- зоны повышенного риска регрессий;
- release-critical pathways;
- участки кода с длинной историей rename/move.

### 15.2 Что не должно механически копироваться в Knowledge

Не нужно без фильтра сохранять:

- полный commit history;
- сырые diff;
- полные blame results;
- transient branch state.

Это увеличит шум и разрушит границы между оперативным Git-состоянием и долговременными знаниями.

### 15.3 Knowledge Enrichment

Git-сигналы особенно полезны для накопления таких знаний:

- какие модули склонны ломаться вместе;
- где чаще всего возникают rollback-сценарии;
- какие зоны команда трогает осторожно;
- где архитектурные решения расходятся с историческим поведением команды.

---

## 16. Pipeline работы модуля

### 16.1 Полный pipeline

```text
[Repository Discovery]
        ↓
[Provider Resolution]
        ↓
[Revision Context Resolution]
        ↓
[Working Tree Inspection]
        ↓
[Diff Normalization]
        ↓
[Rename/Move Resolution]
        ↓
[History Traversal]
        ↓
[Co-change / Hotspot Analysis]
        ↓
[Change Scope Mapping]
        ↓
[Diagnostics Evaluation]
        ↓
[Repository Intelligence Package]
        ↓
[Downstream Distribution]
```

### 16.2 Repository Discovery

На этом этапе определяется:

- является ли путь Git-репозиторием;
- где его корень;
- не является ли проект частью монорепозитория;
- есть ли вложенные репозитории или submodules.

### 16.3 Provider Resolution

Выбирается набор providers, способных обслужить данный сценарий:

- локальный provider;
- remote metadata provider;
- hosting platform provider.

### 16.4 Revision Context Resolution

Определяются:

- branch;
- `HEAD`;
- upstream;
- merge base;
- divergence;
- detached state.

### 16.5 Working Tree Inspection

Собирается текущее operational state:

- staged;
- unstaged;
- untracked;
- deleted;
- conflicts.

### 16.6 Diff Normalization

Все изменения приводятся к единой внутренней форме, пригодной для:

- `Indexer`;
- `Graph`;
- `Research`;
- `Planner`;
- `Execution Engine`.

### 16.7 Rename and Move Resolution

На этом этапе определяется continuity файла через rename/move.

### 16.8 History Traversal

Выполняется исторический анализ в пределах настроенного окна:

- по файлам;
- по модулям;
- по revision chain;
- по release anchor, если нужно.

### 16.9 Co-change / Hotspot Analysis

Строятся производные historical signals.

### 16.10 Change Scope Mapping

Git-сигналы переводятся в scope для:

- инкрементального индексирования;
- impact expansion;
- planning constraints;
- validation scope.

### 16.11 Diagnostics Evaluation

Определяется, можно ли доверять собранной истории полностью, частично или только текущему состоянию дерева.

### 16.12 Downstream Distribution

Готовый пакет распределяется по потребителям:

- `Workspace`
- `Indexer`
- `Graph`
- `Research`
- `Planner`
- `Execution Engine`
- `Knowledge`

---

## 17. События

Модуль должен публиковать, как минимум, следующие события:

- `RepositoryDiscovered`
- `RepositorySnapshotCreated`
- `RepositoryDirtyStateDetected`
- `RepositoryDiffCalculated`
- `RepositoryRenameDetected`
- `RepositoryHistoryAnalyzed`
- `RepositoryHotspotsUpdated`
- `RepositoryCheckpointCreated`
- `RepositoryRollbackBaseResolved`
- `RepositoryDriftDetected`
- `RepositoryDiagnosticsRaised`

### 17.1 События для переиндексации

Отдельный класс событий должен использоваться для `Indexer`:

- `RepositoryChangedSetReady`
- `RepositoryIncrementalIndexSuggested`
- `RepositoryFullReindexSuggested`

### 17.2 События для безопасного выполнения

Для `Execution Engine` и `Planner` важны:

- `RepositoryConflictedStateDetected`
- `RepositoryUnsafeForMutation`
- `RepositoryHumanApprovalRequired`

---

## 18. Versioning и Snapshot

### 18.1 Repository Snapshot

Repository snapshot — это зафиксированное Git-состояние, которое используется как опорная точка анализа или выполнения.

Он должен включать:

- branch context;
- `HEAD`;
- merge base;
- dirty tree markers;
- changed set summary;
- timestamp;
- run linkage.

### 18.2 Checkpoint lineage

Checkpoint-цепочка нужна, чтобы понимать:

- с какой базы стартовал run;
- какой diff был до начала мутаций;
- что изменилось после каждого значимого этапа;
- какой rollback anchor остаётся валидным.

### 18.3 Relation to Workspace Snapshot

`Workspace Snapshot` и `Repository Snapshot` не совпадают.

- `Workspace Snapshot` фиксирует состояние рабочей файловой среды;
- `Repository Snapshot` фиксирует Git-состояние и revision context.

Они должны быть связаны, но не смешаны.

---

## 19. Производительность

### 19.1 Кэширование

Модуль должен кэшировать:

- revision context;
- status results;
- diff normalization results;
- rename detection results;
- file history windows;
- blame fragments;
- hotspot aggregates.

### 19.2 Инкрементальный пересчёт

Повторный анализ не должен каждый раз заново обходить всю историю.

Нужно поддерживать:

- reuse по `HEAD`;
- reuse по `merge base`;
- ограничение исторического окна;
- selective history traversal только для релевантных путей.

### 19.3 Batch processing

Запросы по множеству файлов должны выполняться пакетно, особенно для:

- history lookup;
- co-change analysis;
- blame aggregation.

### 19.4 Large Repository Strategy

Для больших репозиториев модуль должен уметь:

- быстро строить cheap repository snapshot;
- отдельно углубляться только в релевантные пути;
- ограничивать expensive history traversal;
- отдавать partial historical confidence вместо блокировки всего pipeline.

---

## 20. Отказоустойчивость

### 20.1 Повреждённый Git-репозиторий

Если репозиторий повреждён:

- модуль публикует критическую диагностику;
- downstream-модули получают пониженный trust level;
- mutation flow блокируется;
- read-only structural flow может продолжаться только при явном допуске архитектуры.

### 20.2 Detached HEAD

Detached HEAD не является фатальной ошибкой, но должен понижать уверенность в planning и release context.

### 20.3 Shallow Clone

При shallow clone:

- исторические сигналы считаются частичными;
- co-change и regression windows могут быть неполными;
- `Research` обязан видеть это ограничение.

### 20.4 Недоступный remote

Если remote недоступен:

- локальный Git-state остаётся рабочим;
- remote-derived metadata становится partial;
- execution и research не должны аварийно останавливаться, если remote не критичен для текущего сценария.

### 20.5 Ошибка rename detection

Если rename/move нельзя определить надёжно:

- continuity confidence понижается;
- `Indexer` и `Graph` получают более консервативный invalidation scope;
- система предпочитает безопасный reindex вместо рискованной оптимизации.

### 20.6 Merge conflict state

При конфликтном состоянии:

- `Planner` и `Execution Engine` обязаны получить blocking signal;
- mutation без human approval запрещается.

---

## 21. Ограничения

1. Модуль не гарантирует идеальную реконструкцию истории символа без поддержки со стороны `Indexer` и `Graph`.
2. Модуль не должен подменять `Knowledge` интерпретацией истории.
3. Модуль не должен тащить полный Git history в оперативный контекст без relevance filtering.
4. Модуль не должен блокировать весь pipeline, если недоступны только вторичные remote signals.
5. Модуль не должен смешивать run-local change tracking с пользовательскими внешними изменениями.
6. Модуль не должен позволять `Execution Engine` незаметно мутировать репозиторий без checkpoint и rollback base.

---

## 22. Будущее развитие

Архитектура модуля должна позволять без её пересмотра добавлять:

- новые Git-hosting providers;
- PR/MR intelligence;
- release intelligence;
- code ownership intelligence;
- semantic commit classification;
- incident-to-commit linking;
- production issue correlation;
- richer co-change graph export;
- historical risk scoring;
- blame-to-knowledge enrichment;
- multi-repository task orchestration;
- submodule-aware planning;
- branch policy awareness;
- deployment and release linkage.

Главный принцип развития:

Repository Git Intelligence должен оставаться **историческим и операционным измерением проекта**, дополняющим `Graph`, `Research`, `Planner` и `Knowledge`, но не размывающим их ответственность.
