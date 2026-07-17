# Answer Engine

**Статус:** Draft  
**Автор:** Principal Engineering Specification  
**Дата:** 2026-07-17  
**Версия:** 1.2.0  
**Зависимости:** [000-overview.md](/Users/evgenii/Desktop/client/docs/architecture/000-overview.md), [001-domain-model.md](/Users/evgenii/Desktop/client/docs/architecture/001-domain-model.md), [002-storage.md](/Users/evgenii/Desktop/client/docs/architecture/002-storage.md), [003-event-system.md](/Users/evgenii/Desktop/client/docs/architecture/003-event-system.md), [research.md](/Users/evgenii/Desktop/client/docs/modules/research.md), [impact-analysis.md](/Users/evgenii/Desktop/client/docs/modules/impact-analysis.md), [context-builder.md](/Users/evgenii/Desktop/client/docs/modules/context-builder.md), [planner.md](/Users/evgenii/Desktop/client/docs/modules/planner.md), [provider-system.md](/Users/evgenii/Desktop/client/docs/modules/provider-system.md), [execution-engine.md](/Users/evgenii/Desktop/client/docs/modules/execution-engine.md), [repository-git.md](/Users/evgenii/Desktop/client/docs/modules/repository-git.md), [knowledge.md](/Users/evgenii/Desktop/client/docs/modules/knowledge.md)

---

## Оглавление

1. [Назначение](#1-назначение)
2. [Ответственность](#2-ответственность)
3. [Входные данные](#3-входные-данные)
4. [Выходные данные](#4-выходные-данные)
5. [Позиция в архитектуре](#5-позиция-в-архитектуре)
6. [Типы пользовательских запросов](#6-типы-пользовательских-запросов)
7. [Режимы ответа](#7-режимы-ответа)
8. [Архитектура модуля](#8-архитектура-модуля)
9. [Полный Answer Pipeline](#9-полный-answer-pipeline)
10. [Потребление внутренних артефактов](#10-потребление-внутренних-артефактов)
11. [Answer Synthesis](#11-answer-synthesis)
12. [Evidence, Confidence и Unknowns](#12-evidence-confidence-и-unknowns)
13. [Progress UX и Inspector Model](#13-progress-ux-и-inspector-model)
14. [Conversation Continuity и Follow-up](#14-conversation-continuity-и-follow-up)
15. [Производительность](#15-производительность)
16. [Отказоустойчивость](#16-отказоустойчивость)
17. [Ограничения](#17-ограничения)
18. [Будущее развитие](#18-будущее-развитие)

---

## 1. Назначение

Answer Engine — это модуль, который превращает внутренние инженерные результаты платформы в человеческий ответ для пользователя.

Его задача — не исследовать проект, не строить контекст, не принимать инженерные решения и не исполнять изменения, а **выдать наружу лучший возможный ответ по задаче**, используя уже собранные внутренними модулями знания.

### Что такое Answer Engine

Answer Engine — это пользовательский слой интерпретации и выдачи результата.

Внутри платформы уже существуют:

- `Research Report`;
- `Impact Report`;
- `Context Package`;
- `Execution Plan`;
- `Execution Preview`;
- `Repository Git Intelligence`;
- `Knowledge`.

Но эти артефакты являются внутренними инженерными сущностями. Пользователь в большинстве сценариев не хочет читать Research Report или разбираться в графе зависимостей. Пользователь хочет получить ответ на вопрос:

- почему система ведёт себя так;
- где находится причина;
- что именно затронуто;
- какой безопасный план изменений подготовлен;
- чего системе не хватает для уверенного ответа.

Именно эту задачу и решает Answer Engine.

### Почему он существует

Если показывать пользователю внутренние артефакты как основной результат, возникает несколько проблем:

- пользователь вынужден разбираться во внутренней архитектуре платформы;
- даже хороший research остаётся "сырьём", а не итоговым ответом;
- слабые модели не получают чёткой задачи на формирование итогового вывода;
- UI превращается в инженерную консоль вместо простого чата;
- возникает разрыв между "система всё поняла" и "пользователь получил полезный ответ".

Answer Engine устраняет этот разрыв.

### Какая основная идея модуля

Вся сложная архитектура платформы должна работать **для ответа**, а не **вместо ответа**.

Снаружи продукт должен ощущаться как простой диалог:

1. пользователь выбирает проект;
2. пользователь выбирает модель;
3. пользователь пишет задачу или вопрос;
4. система внутренне выполняет полный pipeline;
5. пользователь получает финальный ответ по существу.

При этом:

- `Research`, `Impact`, `Context`, `Plan` остаются обязательными внутренними слоями;
- они не исчезают;
- но они перестают быть главным пользовательским результатом;
- они становятся основой для Answer Engine.

### Пример пользовательского ожидания

Пользователь не должен видеть первым экраном:

- "Research completed";
- "5 findings";
- "8 focus zones";
- "12 selected chunks";
- "Execution plan generated".

Вместо этого он должен увидеть:

"Причина, по которой ответ иногда не совпадает с локализацией, скорее всего связана с middleware локали. Если приходит header `X-Lang`, локаль переключается. Если header отсутствует, используется default locale. По исследованным данным проблемные запросы не содержат этот header."

А уже затем, по желанию, пользователь может открыть:

- evidence;
- confidence;
- связанные файлы;
- plan;
- diagnostics.

### Чем Answer Engine не является

Answer Engine:

- не заменяет `Research Engine`;
- не заменяет `Context Builder`;
- не заменяет `Planner`;
- не заменяет `Execution Engine`;
- не является "чатом ради чата";
- не является generic LLM wrapper;
- не является хранилищем знаний;
- не является UI-компонентом сам по себе.

Это **прикладной модуль ответа**, который опирается на результаты всей платформы.

---

## 2. Ответственность

### Что входит

- Приём пользовательского запроса в chat-oriented UX.
- Определение типа ожидаемого ответа.
- Оркестрация использования внутренних артефактов для ответа.
- Выбор режима ответа: explanation, diagnosis, plan summary, refusal, insufficient-data response и т.д.
- Формирование финального answer payload для пользователя.
- Формирование user-facing summary без раскрытия лишней внутренней кухни.
- Включение evidence, confidence и unknowns в управляемом виде.
- Подготовка compact progress updates для UI.
- Подготовка Inspector-facing ссылок на внутренние артефакты.
- Обеспечение того, чтобы ответ был:
  - понятным человеку;
  - обоснованным;
  - связанным с реальными артефактами;
  - воспроизводимым;
  - согласованным с внутренним состоянием run.
- Поддержка follow-up запросов внутри того же conversational context.

### Что не входит

- Answer Engine не проводит исследование вместо `Research Engine`.
- Answer Engine не строит `Context Package` вместо `Context Builder`.
- Answer Engine не принимает инженерные решения вместо `Planner`.
- Answer Engine не исполняет изменения.
- Answer Engine не меняет Graph, Knowledge, Repository или Workspace.
- Answer Engine не должен "угадывать" недостающие факты.
- Answer Engine не должен генерировать уверенный ответ, если internal evidence не поддерживает его.
- Answer Engine не должен подменять собой reasoning pipeline.

### Принцип границы ответственности

Внутренние модули отвечают за инженерную истину и подготовку артефактов.

Answer Engine отвечает за то, чтобы эта истина была выдана пользователю в правильной форме.

---

## 3. Входные данные

Answer Engine не работает изолированно. Он получает не только пользовательскую реплику, но и весь набор внутренних артефактов, если они были произведены upstream pipeline.

### 3.1 User Request

Базовый вход:

- текст запроса;
- выбранный проект;
- выбранная модель;
- текущий conversational run;
- user-facing preferences, если они есть;
- режим задачи: question / explain / diagnose / plan / execute / compare / inspect.

### 3.2 Research Report

Research Report является главным содержательным источником ответа.

Из него Answer Engine получает:

- findings;
- evidence;
- affected modules;
- entry points;
- functional summary;
- primary entities;
- data sources;
- unknowns;
- confidence;
- query profile.

### 3.3 Impact Report

Impact нужен не для каждого ответа, но обязателен там, где пользователь спрашивает:

- что затронуто;
- где причина побочного эффекта;
- что сломается при изменении;
- насколько рискованна правка;
- какие зоны проекта связаны с наблюдаемым поведением.

Из него извлекаются:

- affected files;
- affected symbols;
- risks;
- conflicts;
- validation scope;
- blast radius markers;
- impact confidence.

### 3.4 Context Package

Context Package нужен как curated evidence set для модели, которая будет синтезировать окончательный ответ.

Он даёт:

- приоритизированные structural chunks;
- functional highlights;
- focus zones;
- ranking rationale;
- token-bounded context;
- curated fragments, пригодные для inference.

### 3.5 Planner Output

Planner нужен в случаях, когда пользователь спрашивает:

- как исправить проблему;
- какой безопасный план изменений подготовлен;
- что будет сделано дальше;
- можно ли выполнить задачу безопасно;
- какие шаги потребуются.

Из Planner Answer Engine получает:

- plan summary;
- target modules;
- target files;
- planning notes;
- execution strategy;
- dependency chains;
- approval points;
- rollback signals.

### 3.6 Execution Preview

Используется для ответа в стиле:

- "что ты собираешься менять";
- "покажи безопасный план";
- "что будет затронуто";
- "какие действия разрешены";
- "что будет проверено".

### 3.7 Repository Git Intelligence

Используется в вопросах:

- почему это поведение проявляется только иногда;
- кто и когда менял эту зону;
- какие файлы недавно менялись вместе;
- есть ли локальные незакоммиченные изменения;
- есть ли риск, что причина в текущей ветке или изменениях.

Источники:

- branch;
- HEAD;
- merge base;
- changed files;
- rename detection;
- repository diagnostics;
- future historical signals.

### 3.8 Knowledge

Используется для:

- поиска уже известных объяснений;
- повторного использования прошлых conclusions;
- извлечения ADR и project conventions;
- сопоставления текущего ответа с накопленным знанием.

### 3.9 Optional Runtime Signals

В будущем Answer Engine должен уметь использовать и дополнительные runtime-oriented сигналы:

- application logs;
- request traces;
- environment markers;
- diagnostics artifacts;
- external incidents.

На текущем этапе это должен быть optional input, а не обязательная зависимость.

### 3.10 Project Scope Directive (multi-repo проекты)

Реализовано (`classifyProjectScopeDirective`, packages/ai/src/index.ts).

Для multi-path проектов (несколько физических репозиториев с ролями вида `backend`/`frontend`/`gui`) пользователь может ограничить область поиска прямо в тексте задачи, без отдельного UI: "не трогай бэкенд", "работаем только над фронтом", "ищи только в gui". Это не regex-парсинг, а отдельный дешёвый LLM-вызов, потому что смешанные include/exclude формулировки в одном предложении ("работаем только над фронтом, бэк не трогаем") regex обрабатывает плохо.

Механизм двухступенчатый:

1. Дешёвый keyword pre-filter (`SCOPE_TRIGGER_PATTERN` + прямое совпадение с лейблами root'ов проекта) решает, стоит ли вообще звать классификатор — для single-repo проектов и для большинства обычных вопросов вызов пропускается полностью.
2. Если триггер найден, один LLM-вызов возвращает `{restricted: boolean, allowedLabels: string[]}`.

Вызывающий код (`apps/api/src/pipeline-runner.ts`) использует результат, чтобы сузить `projectRoots` до `effectiveProjectRoots` ещё до вызова agentic research — вся остальная часть pipeline (observer hints, known facts, glossary, сам research call) видит уже уменьшённый список root'ов и не знает, что произошло сужение scope. Пустой результат или результат, включающий все root'а, трактуется как "ограничения нет".

### 3.11 Semantic Embeddings (для code search в packages/knowledge)

Реализовано (`embedTexts`, packages/ai/src/index.ts).

Отдельная тонкая функция, которая дергает `/embeddings` endpoint провайдера (OpenAI-совместимый формат: `{data: [{embedding, index}]}`) через тот же `performProviderRequest`, что и chat-вызовы. Answer Engine это напрямую не использует — функция существует как provider-access примитив для feature semantic code search, которая живёт в packages/knowledge (code-embeddings.ts). packages/ai отвечает только за сам HTTP-вызов к провайдеру, не за индекс и не за хранение embeddings.

---

## 4. Выходные данные

Главный результат Answer Engine — не внутренний артефакт, а **Answer Package**.

### 4.1 Answer Package

`Answer Package` должен содержать:

- `answerId`;
- `runId`;
- `projectId`;
- `requestId`;
- `answerMode`;
- `summary` — основной человеческий ответ;
- `explanation` — развёрнутая версия ответа;
- `evidenceHighlights`;
- `confirmedFacts` — компактный список того, что подтверждено evidence и runtime/graph-backed сигналами;
- `unconfirmedFacts` — компактный список того, что не подтверждено или ограничено unknowns/freshness;
- `manualChecks` — что стоит проверить руками в коде, runtime или Git/worktree состоянии;
- `confidence`;
- `unknowns`;
- `warnings`;
- `nextActions`;
- `inspectorLinks`;
- `artifactRefs`;
- `createdAt`.

### 4.2 User-facing Response

Это то, что реально показывается в чате:

- короткий понятный ответ;
- при необходимости 2-5 ключевых bullets;
- optional explanation;
- optional блок `Подтверждено`;
- optional блок `Не подтверждено`;
- optional блок `Проверить вручную`;
- optional warning;
- optional "что дальше";
- optional CTA:
  - "Открыть детали";
  - "Показать evidence";
  - "Посмотреть план";
  - "Продолжить";
  - "Выполнить".

### 4.3 Inspector References

Answer Engine не должен тащить в сам ответ все артефакты. Вместо этого он должен отдавать ссылки на:

- Research;
- Impact;
- Context;
- Plan;
- Execution Preview;
- Git;
- Diagnostics;
- Knowledge evidence.

### 4.4 Progress Updates

Для chat UX модуль должен формировать промежуточные user-facing обновления:

- "Исследую проект...";
- "Проверяю связанные модули...";
- "Собираю контекст для ответа...";
- "Подготовил объяснение и evidence...";

Это отдельный тип выхода, отличный от финального ответа.

---

## 5. Позиция в архитектуре

Answer Engine не меняет утверждённую архитектуру.

Он добавляется **поверх уже существующей цепочки**, а не вместо неё.

### Канонический поток для вопроса

```text
User Request
    ->
Research Engine
    ->
Impact Analysis
    ->
Context Builder
    ->
Answer Engine
    ->
Chat Response
```

### Канонический поток для change-oriented задачи

```text
User Request
    ->
Research Engine
    ->
Impact Analysis
    ->
Context Builder
    ->
Planner
    ->
Answer Engine
    ->
User Approval / Execution
```

### Ключевой архитектурный принцип

`Research`, `Impact`, `Context`, `Plan` — это internal artifacts.  
`Answer` — это external artifact.

### Почему это важно

Один и тот же pipeline может обслуживать две разные аудитории:

- систему и downstream modules;
- человека в чате.

Answer Engine нужен именно как слой преобразования между этими уровнями.

---

## 6. Типы пользовательских запросов

Answer Engine обязан понимать не только текст запроса, но и **какой именно ответ ожидает человек**.

Ключевая проблема текущей реализации состоит в том, что разные вопросы часто получают почти одинаковую report-shaped форму. В результате:

- existence-вопрос получает диагностический отчёт;
- location-вопрос получает длинный пересказ findings;
- how-вопрос получает dump артефактов вместо объяснения;
- простой yes/no вопрос перегружается impact, plan и provenance narrative.

После рефакторинга Answer Engine должен сначала определять **question type**, и только потом решать:

- какой ответ считать прямым;
- какие артефакты действительно релевантны;
- что показать в основном сообщении;
- что увести в Inspector.

### 6.1 Existence Query

Примеры:

- "гугл авторизация есть?"
- "в проекте есть websocket?"
- "используется ли Redis?"

Ожидаемый результат:

- прямой ответ `да / нет / недостаточно данных`;
- 1-2 предложения подтверждённого объяснения;
- 2-4 strongest entry points или structural anchors;
- только потом ссылки на код и ограничения.

### 6.2 Location Query

Примеры:

- "где хранится ssh соединение?"
- "где выбирается локаль?"
- "в каком месте создаётся bill history?"

Ожидаемый результат:

- прямой ответ "искать нужно здесь";
- список конкретных файлов, классов, таблиц, методов;
- краткая роль каждого элемента;
- опционально зона влияния, если она действительно полезна.

### 6.3 Flow Query

Примеры:

- "как работает модуль авторизации?"
- "как происходит rollback bill в generated?"
- "как проходит callback Google OAuth?"

Ожидаемый результат:

- короткая цепочка вида `A -> B -> C`;
- объяснение механики человеческим языком;
- entry points;
- ключевые задействованные сущности;
- только потом deeper evidence.

### 6.4 Configuration Query

Примеры:

- "как выбирается локаль ответа?"
- "откуда берётся default язык?"
- "какой env влияет на это поведение?"

Ожидаемый результат:

- прямой вывод о конфигурационном механизме;
- fallback / precedence chain;
- где это задаётся;
- какие условия меняют поведение.

### 6.5 Diagnostic Query

Примеры:

- "почему иногда приходит неверный ответ?"
- "почему rollback не работает?"
- "почему не применяется локаль?"

Ожидаемый результат:

- наиболее вероятная подтверждённая причина;
- 1-2 supporting mechanisms;
- чего не хватает для окончательного вывода;
- какие проверки дадут strongest confirmation.

### 6.6 Impact Query

Примеры:

- "что затронет изменение локали?"
- "какие модули затронет правка rollback?"
- "что может сломаться при изменении OAuth flow?"

Ожидаемый результат:

- краткий вывод о blast radius;
- affected zones;
- риски;
- validation scope;
- только при необходимости plan-oriented continuation.

### 6.7 Change Plan Query

Примеры:

- "как безопасно исправить это?"
- "что нужно поменять для поддержки нового языка?"
- "какой план изменений подготовлен?"

Ожидаемый результат:

- короткий engineering conclusion;
- план действий по шагам;
- scope изменений;
- риски;
- approval markers.

### 6.8 Comparative Query

Примеры:

- "чем отличается старый flow от нового?"
- "почему в одной ветке работает, а в другой нет?"

Ожидаемый результат:

- summary отличий;
- что именно меняется;
- какие факты относятся к branch/worktree overlay;
- confidence и unknowns.

Реализовано как отдельная категория `"compare"` в `classifyQuestionShape` (см. 8.1) — распознаётся по паттернам вида "чем отличается", "в чём разница", "difference between", "compared to", "versus".

### 6.9 Insufficient-data Query

Система обязана уметь отвечать:

- "недостаточно данных для уверенного вывода";
- "нужен background sync";
- "нужны runtime-логи";
- "нужен более узкий вопрос";
- "нужна другая зона кода".

Это полноценный тип ответа, а не ошибка.

---

## 7. Режимы ответа

Тип вопроса и presentation mode должны быть разделены.

- `Question Type` отвечает на вопрос: "что именно хочет узнать пользователь?"
- `Answer Mode` отвечает на вопрос: "в какой форме лучше выдать результат?"

Один и тот же `Question Type` может завершиться разными `Answer Modes`.

### 7.1 Direct Answer

Используется для:

- existence;
- location;
- простых flow-вопросов;
- configuration-вопросов с короткой причинной цепочкой.

Форма:

- сначала прямой ответ;
- потом краткое объяснение;
- потом supporting facts.

### 7.2 Guided Explanation Answer

Используется, когда:

- механизм важнее yes/no;
- пользователю нужно понять flow;
- нужно аккуратно провести через 2-4 шага логики.

Форма:

- короткий вывод;
- причинная цепочка;
- где искать код;
- optional caveat.

### 7.3 Diagnostic Answer

Используется, когда:

- вопрос задан как "почему";
- есть конкурирующие причины;
- нужна честная инженерная гипотеза, а не окончательный приговор.

Форма:

- наиболее вероятная причина;
- почему система так считает;
- что подтверждено;
- чего не хватает.

### 7.4 Impact Summary Answer

Используется для вопросов о последствиях изменения.

Форма:

- краткий blast-radius вывод;
- основные затронутые зоны;
- риски;
- validation emphasis.

### 7.5 Plan Summary Answer

Используется для change-oriented задач.

Форма:

- engineering conclusion;
- 3-7 шагов;
- scope;
- риски и approval.

### 7.6 Clarifying / Narrowing Answer

Это не "задать пустой вопрос пользователю", а controlled response:

- "найдены две конкурирующие зоны";
- "вопрос слишком широкий";
- "нужен более узкий scope";
- "могу продолжить от конкретного entry point".

### 7.7 Insufficient-data Answer

Используется, когда проблема не в политике безопасности, а в нехватке данных.

Форма:

- что именно сейчас нельзя утверждать;
- почему;
- какой следующий шаг устранит ограничение.

### 7.8 Refusal / Safety Answer

Используется, когда:

- задача противоречит policy;
- execution запрещён;
- нет оснований для опасного действия.

### 7.9 Answer-with-Inspector

Это presentation contract по умолчанию:

- чат показывает direct answer;
- Inspector содержит full engineering detail;
- основной чат не должен выглядеть как Research Report.

---

## 8. Архитектура модуля

После рефакторинга Answer Engine должен быть устроен как **двухслойный преобразователь**:

1. из внутренних артефактов в answer-oriented semantic brief;
2. из semantic brief в user-facing ответ.

Главный принцип:

- внутренние артефакты не должны попадать в чат напрямую;
- LLM не должна видеть pipeline как "текст, который надо пересказать";
- пользовательский ответ должен собираться из специально подготовленного answer-facing representation.

### 8.1 Question Type Resolver

Определяет:

- `Question Type`;
- primary user intent;
- ожидаемый first-line answer shape;
- нужен ли прямой yes/no;
- нужен ли flow explanation;
- нужен ли impact;
- нужен ли plan.

Resolver не принимает инженерные решения вместо upstream модулей.
Он только определяет ответную форму.

### 8.2 Artifact Selector

Выбирает, какие внутренние артефакты реально нужны для текущего вопроса.

Например:

- для existence-вопроса Planner обычно не нужен;
- для location-вопроса Execution Preview не нужен;
- для configuration-вопроса Impact может быть вторичен;
- для impact/fix-вопроса Planner и Impact становятся обязательными.

### 8.3 Evidence Synthesizer

Это новый обязательный внутренний слой рефакторинга.

Он не создаёт новых инженерных истин.
Он нормализует уже готовые истины в answer-facing форму.

Его задача:

- убрать нерелевантные findings;
- отделить essential facts от explainability noise;
- выбрать только те evidence, которые помогают ответить именно на вопрос пользователя;
- отделить direct answer facts от supporting facts.

### 8.4 Answer Brief Builder

Это главный новый внутренний контракт модуля.

`Answer Brief` — промежуточное представление между pipeline artifacts и финальным ответом.

Он должен содержать:

- `questionType`;
- `answerMode`;
- `directAnswer`;
- `directAnswerConfidence`;
- `answerStatus`: answered / partial / insufficient / refused;
- `coreExplanation`;
- `supportingFacts`;
- `topEntryPoints`;
- `topCodeReferences`;
- `impactSummary`, если релевантен;
- `riskSummary`, если релевантен;
- `planSummary`, если релевантен;
- `unknownsThatMatter`;
- `userWarnings`;
- `inspectorTargets`.

Именно `Answer Brief`, а не `Research Report`, должен становиться входом для LLM synthesis и deterministic fallback.

### 8.5 Answer Strategy Resolver

Выбирает final response strategy на пересечении:

- `Question Type`;
- полноты evidence;
- confidence;
- необходимости concise vs guided answer;
- необходимости warning-first или insufficient-data output.

### 8.6 Response Composer

Формирует пользовательский ответ по жёсткому правилу:

1. сначала direct answer;
2. потом краткое объяснение;
3. потом supporting facts;
4. только затем impact / risks / plan, если они действительно нужны.

Response Composer обязан уметь:

- deterministic composition;
- LLM-assisted composition;
- graceful fallback между ними.

### 8.7 Confidence Presenter

Отвечает за:

- корректное отображение уверенности;
- снижение категоричности при слабом evidence;
- маркировку meaningful unknowns;
- объяснение, почему ответ partial или limited.

### 8.8 Progress Narrator

Преобразует внутренний pipeline status в user-facing progress.

Не:

- "Research completed";
- "Impact generated";
- "Context built";

А:

- "Проверяю, есть ли подтверждение в коде";
- "Собираю ключевые точки входа";
- "Готовлю короткий ответ и ссылки на код".

### 8.9 Inspector Linker

Формирует связь между answer brief и глубокими артефактами.

Основной ответ должен ссылаться в Inspector только по тем зонам, которые реально участвовали в direct answer.

### 8.10 Conversation State Adapter

Удерживает continuity между:

- предыдущими вопросами;
- последним run;
- уже собранными артефактами;
- follow-up запросами.

Для follow-up вопросов адаптер обязан понимать:

- был ли уже дан direct answer;
- что пользователь сейчас уточняет: location, cause, impact или plan;
- нужно ли расширить brief, а не пересобирать всю presentation-форму с нуля.

---

## 9. Полный Answer Pipeline

Ниже описан канонический процесс от пользовательского вопроса до финального ответа после refactor.

### 9.1 Высокоуровневая схема

```text
User Message
    ->
Question Type Resolution
    ->
Internal Pipeline Trigger / Reuse
    ->
Artifact Selection
    ->
Evidence Synthesizer
    ->
Answer Brief Builder
    ->
Answer Strategy Resolution
    ->
Response Composition
    ->
Answer Validation
    ->
Chat Response
    ->
Inspector Links
```

### 9.2 Шаг 1. Приём запроса

Система принимает:

- user message;
- project selection;
- model selection;
- active conversation state;
- optional existing run context.

### 9.3 Шаг 2. Определение типа вопроса

На этом шаге классифицируется:

- existence / location / flow / configuration / diagnostic / impact / plan / compare;
- нужен ли direct answer;
- нужен ли plan-aware режим;
- нужен ли diagnostic framing;
- можно ли ответить кратко;
- требуется ли follow-up reuse.

Это отдельный шаг, потому что именно он определяет форму ответа.

### 9.4 Шаг 3. Получение upstream artifacts

Answer Engine сам не выполняет upstream-работу, но инициирует или ожидает:

- Research;
- Impact;
- Context;
- Planner, если он действительно нужен.

### 9.5 Шаг 4. Отбор релевантных артефактов

После завершения pipeline модуль выбирает:

- какие findings релевантны direct answer;
- какие evidence реально подтверждают вывод;
- какие risks нужны именно для этого типа вопроса;
- какие unknowns materially влияют на ответ;
- какие данные надо увести в Inspector.

### 9.6 Шаг 5. Evidence Synthesis

На этом шаге внутренние инженерные артефакты преобразуются в answer-facing факты:

- `direct answer facts`;
- `supporting facts`;
- `code anchors`;
- `impact facts`;
- `plan facts`;
- `confidence limiters`.

Именно здесь должна исчезать большая часть "pipeline vocabulary".

### 9.7 Шаг 6. Построение Answer Brief

На этом шаге формируется нормализованный `Answer Brief`.

Это обязательный внутренний checkpoint:

- если brief плохой, ответ будет плохим;
- если brief прямой и чистый, даже слабая модель даст заметно лучший пользовательский результат.

### 9.8 Шаг 7. Композиция ответа

На этом этапе формируется пользовательская форма:

- `direct answer`;
- `short explanation`;
- `supporting facts`;
- `where to look`;
- `impact`, если нужен;
- `risks`, если нужны;
- `plan`, если нужен;
- `limitations`, если они materially влияют на ответ.

### 9.9 Шаг 8. Валидация ответа

Проверяется:

- direct answer не противоречит ли evidence;
- не попали ли в direct answer слова из pipeline instead of user answer;
- не просочились ли нерелевантные sections;
- не скрыты ли критичные unknowns;
- не завышена ли уверенность;
- не обещает ли answer действие, которого pipeline не подготовил.

### 9.10 Шаг 9. Выдача ответа

Пользователь получает:

- answer-first output;
- сначала смысл, потом доказательства;
- Inspector как вторичный канал глубины.

---

## 10. Потребление внутренних артефактов

Answer Engine должен не просто "читать" артефакты, а понимать их роль в пользовательском ответе.

### 10.1 Как используется Research

Research — это главный источник объяснения.

Из него должны извлекаться:

- functional summary как базовая narrative line;
- findings как основные выводы;
- evidence как подтверждения;
- unknowns как обязательные ограничения;
- confidence как базовый confidence floor.

### 10.2 Как используется Impact

Impact нужен для ответов про последствия, зоны влияния и риски.

Он не должен перегружать простой explanation query, если пользователь не спрашивал о последствиях.

### 10.3 Как используется Context

Context нужен не как то, что показывается пользователю, а как curated basis для inference-модели.

Пользователь обычно не должен видеть:

- token budget;
- ranking summary;
- selected chunks.

Но именно они могут лежать в основе хорошего ответа.

### 10.4 Как используется Plan

Plan нужен, когда ответ должен включать:

- "что нужно менять";
- "в каком порядке";
- "какие риски";
- "почему нужен approval".

Plan не должен принудительно показываться для чисто explanatory queries.

### 10.5 Как используется Git

Git должен усиливать ответы вида:

- "это поведение появилось недавно";
- "эта зона активно менялась";
- "локально есть незакоммиченные изменения";
- "причина может быть связана с текущей веткой".

### 10.6 Как используется Knowledge

Knowledge нужен для:

- reuse предыдущих объяснений;
- усиления consistency;
- извлечения ADR, если вопрос касается архитектурного решения;
- поиска уже известных проблем и соглашений.

---

## 11. Answer Synthesis

Это центральная функция модуля.

После рефакторинга она должна быть построена вокруг принципа:

**сначала ответ на вопрос, потом доказательства и инженерная глубина.**

### 11.1 Что должен содержать хороший ответ

Хороший answer-first output должен отвечать на четыре вопроса:

1. Каков прямой ответ на вопрос пользователя.
2. Почему система так считает.
3. Где это подтверждается в коде или структуре проекта.
4. Что важно знать дальше, если нужен deeper analysis или изменение.

### 11.2 Каноническая структура ответа

По умолчанию ответ должен собираться из слоёв:

1. `Direct Answer`
2. `Short Explanation`
3. `Supporting Facts`
4. `Where To Look`
5. `Impact / Risks / Plan` — только если релевантно
6. `Limitations / Unknowns` — только если materially влияют на вывод

### 11.3 Принцип минимальной достаточности

Пользовательский ответ не должен становиться dump всех findings.

Нужно показывать только:

- прямой ответ;
- 1 ведущую причинную цепочку;
- 2-4 strongest confirmations;
- только действительно важные ограничения;
- следующий полезный шаг.

### 11.4 Принцип answer-before-report

Следующие данные не должны открывать ответ:

- provenance counts;
- baseline/overlay narrative;
- token budget;
- ranking summary;
- focus zones;
- structural anchors как primary sentence;
- impact summary, если вопрос не про impact.

Они могут существовать:

- внутри brief;
- внутри Inspector;
- внутри warnings;
- как debug/debugging surface.

Но не как first user-visible answer line.

### 11.5 Intent-specific composition rules

#### Existence

Форма:

- `Да / Нет / Недостаточно данных`
- короткое подтверждение
- точки входа

Пример:

```text
Да.

В проекте реализована авторизация через Google OAuth.
Вход начинается в `initGoogleAuth()`, а обработка успешного callback идёт через `callbackGoogleAuth()`.
```

#### Location

Форма:

- "это находится здесь"
- 2-5 ссылок на код
- краткая роль каждого элемента

#### Flow

Форма:

- короткая цепочка
- объяснение механики
- entry points

#### Configuration

Форма:

- прямой вывод о precedence / fallback
- откуда берётся значение
- при каких условиях оно меняется

#### Diagnostic

Форма:

- наиболее вероятная причина
- подтверждённый механизм
- what is missing

#### Impact

Форма:

- краткий blast-radius вывод
- affected zones
- риски

#### Plan

Форма:

- conclusion
- шаги
- scope
- риски

### 11.6 Deterministic fallback rules

Fallback-режим не должен просто пересобирать report sections.

Даже без LLM deterministic answer обязан:

- сначала сформулировать direct answer;
- затем дать condensed explanation;
- затем показать only the most relevant evidence;
- не начинать с file path, confidence phrase или provenance sentence.

### 11.7 LLM synthesis rules

LLM должна получать не сырые pipeline artifacts, а `Answer Brief`.

Prompt synthesis обязан быть устроен так, чтобы модель:

- не видела research dump как основную narrative основу;
- не была вынуждена писать универсальный шестисекционный техотчёт;
- не повторяла одинаковую форму для всех типов вопросов;
- понимала, какой direct answer нужен первым абзацем.

### 11.8 Что запрещено

Answer Engine не должен:

- изображать guess как факт;
- скрывать слабую уверенность;
- выдавать plan как уже выполненное изменение;
- обещать окончательную причину при конкурентном evidence;
- начинать ответ с `Наиболее сильное подтверждение находится в ...`;
- начинать ответ с baseline/overlay/provenance технической формулировки;
- принудительно включать impact и plan в каждый ответ;
- утопить ответ в названиях внутренних артефактов.

---

## 12. Evidence, Confidence и Unknowns

Ответ без evidence становится недоверяемым.  
Ответ без unknowns становится опасно самоуверенным.

После рефакторинга эти элементы должны быть встроены не в report-shape, а в answer-shape.

### 12.1 Evidence Model

Evidence в пользовательском ответе должен быть:

- кратким;
- прямым;
- связанным с вопросом;
- выводимым из реальных артефактов;
- разделённым на `answer-driving` и `supporting`.

`Answer-driving evidence` — это факты, без которых нельзя сформулировать direct answer.

`Supporting evidence` — это факты, которые усиливают доверие, но не должны перегружать первый экран ответа.

### 12.2 Confidence Model

Answer confidence должен строиться из:

- research confidence;
- impact confidence, если impact вообще использовался;
- полноты answer-driving evidence;
- согласованности между selected artifacts;
- отсутствия конкурирующих трактовок;
- актуальности branch/head/worktree state;
- количества unknowns, которые materially влияют на direct answer.

### 12.3 Unknowns

Unknowns обязательны, когда:

- evidence неполон;
- есть конкурирующие гипотезы;
- нет runtime logs;
- baseline устарел или отсутствует;
- не хватает части проекта;
- локальные изменения могут искажать вывод.

Но в чат должны попадать только `unknowns that matter`.

Запрещено тащить в основной ответ весь сырый список unknowns, если он не влияет на основной вывод.

### 12.4 Правило честной неопределённости

Если система не может уверенно ответить, она обязана сказать:

- чего именно не хватает;
- какой кусок direct answer остаётся неподтверждённым;
- какой следующий шаг закроет этот пробел;
- можно ли продолжить автоматически.

---

## 13. Progress UX и Inspector Model

Это одна из ключевых архитектурных идей модуля.

### 13.1 Внешний UX должен быть answer-first

Пользователь не должен быть обязан понимать:

- что такое Research Report;
- что такое Context Package;
- что такое Execution Plan;
- чем отличается Graph от Knowledge.

Для него продукт должен оставаться:

- проект;
- модель;
- чат;
- ответ.

### 13.2 Главный экран не должен выглядеть как инженерный отчёт

Даже если pipeline богат, чат не должен первым экраном показывать:

- provenance summary;
- internal confidence explanation;
- evidence dump;
- file inventory;
- planner notes;
- long cautionary report.

Снаружи пользователь должен сначала видеть:

- прямой ответ;
- короткое пояснение;
- 2-4 подтверждения;
- понятную кнопку на глубину.

### 13.3 Pipeline остаётся видимым, но вторичным

Пользователь может видеть, что система:

- исследует проект;
- собирает подтверждения;
- формирует ответ;

но не обязан читать внутренние артефакты.

### 13.4 Inspector

Все глубокие детали должны быть унесены в `Inspector`.

Inspector должен быть:

- secondary surface;
- optional;
- expert-oriented;
- linked from answer, а не наоборот.

### 13.5 Что должно оставаться в основном сообщении

- direct answer;
- short explanation;
- strongest supporting facts;
- уровень уверенности;
- предупреждение, если оно materially влияет на вывод;
- action button или follow-up CTA.

### 13.6 Что должно уходить в Inspector

- full findings;
- evidence lists;
- affected files;
- graph summaries;
- context chunks;
- planner notes;
- diagnostics;
- git scope;
- raw unknowns;
- provenance details;
- baseline/overlay technical narrative.

---

## 14. Conversation Continuity и Follow-up

Client должен ощущаться как разговор, а не как отдельные несвязанные runs.

### 14.1 Follow-up запросы

Answer Engine должен поддерживать продолжение:

- "покажи, где именно это находится";
- "а как это исправить?";
- "а почему только иногда?";
- "а что будет, если поменять default locale?".

### 14.2 Reuse последнего run

Если предыдущий run всё ещё релевантен, Answer Engine должен уметь:

- использовать уже собранные артефакты;
- не повторять полный research без необходимости;
- запрашивать selective refresh только для нужных зон.

### 14.3 Контроль устаревания

Reuse запрещён, если:

- проект сменился;
- Git state существенно изменился;
- run слишком старый;
- новый вопрос требует другого scope;
- confidence прошлого ответа уже недостаточен.

---

## 15. Производительность

Answer Engine находится на критическом user-facing пути, поэтому должен быть быстрым.

### 15.1 Что нужно оптимизировать

- reuse внутреннего pipeline, когда это возможно;
- reuse context fragments;
- reuse already-synthesized evidence sets;
- минимизацию лишних Planner-вызовов для simple question queries;
- компактное progress reporting;
- задержку между завершением research и выдачей ответа.

### 15.2 Стратегии

- answer-mode-aware orchestration;
- lazy loading Inspector data;
- partial artifact reuse;
- conversation-level cache;
- structured answer template reuse;
- отказ от unnecessary plan generation для purely explanatory tasks.

### 15.3 Важное правило

Пользовательская отзывчивость должна оптимизироваться не за счёт пропуска research, а за счёт:

- reuse;
- selective scope;
- better orchestration;
- правильной подачи progress.

---

## 16. Отказоустойчивость

### 16.1 Если Research неполон

Answer Engine не должен падать. Он должен:

- понизить confidence;
- показать insufficient-data answer;
- предложить следующий шаг.

### 16.2 Если часть артефактов недоступна

Например:

- нет Planner;
- нет Git snapshot;
- Context частично деградировал;
- отсутствуют diagnostics.

Модуль должен:

- переключиться в supported answer mode;
- не показывать сломанную внутреннюю структуру пользователю;
- сохранить честность ответа.

### 16.3 Если модель недоступна

Если inference provider недоступен, система должна уметь:

- выдать fallback summary из deterministic internal artifacts;
- сообщить, что LLM synthesis деградировал;
- не потерять инженерный результат run.

### 16.4 Если confidence слишком низок

Должен быть сформирован controlled insufficient-confidence response, а не искусственно уверенный answer.

---

## 17. Ограничения

Answer Engine обязан знать свои границы.

### 17.1 Он не создаёт истину

Если Research или Graph ошиблись, Answer Engine не может "магически" исправить это сам по себе.

### 17.2 Он зависит от качества upstream pipeline

Плохой research почти неизбежно ведёт к плохому answer.

### 17.3 Он не должен делать вид, что runtime-наблюдение уже существует

Если логи, traces или live diagnostics не подключены, модуль не должен изображать их наличие.

### 17.4 Он не должен превращать внутреннюю архитектуру в пользовательскую обязанность

Даже если система построила много внутренних артефактов, это не означает, что пользователь должен их читать.

### 17.5 Он не должен обрушивать UX из-за внутренних деталей

Внутренняя сложность должна оставаться внутренней.

---

## 18. Будущее развитие

Архитектура Answer Engine должна позволять развитие без изменения его фундаментальной роли.

### 18.1 Что должно легко добавляться

- model-specific answer styles;
- streaming answers;
- voice / multimodal answer surfaces;
- richer evidence citations;
- log-aware diagnostics;
- trace-aware runtime explanations;
- answer critique / self-check pass;
- multi-turn memory integration;
- answer personalization;
- localized answer generation;
- side-by-side compare answers;
- mutation-aware answer previews;
- execution outcome explanations;
- post-change answer refresh.

### 18.2 Ключевой принцип будущего развития

Какими бы сложными ни стали:

- Graph;
- Knowledge;
- Repository Git;
- Planner;
- Execution;
- Provider System;

пользовательский опыт должен становиться **проще**, а не сложнее.

Answer Engine — это именно тот слой, который обязан удерживать эту простоту.

### 18.3 Итоговая роль модуля

В зрелой архитектуре Client:

- `Research` отвечает за понимание;
- `Context Builder` отвечает за упаковку;
- `Planner` отвечает за решение;
- `Execution` отвечает за действие;
- `Answer Engine` отвечает за то, чтобы человек получил правильный ответ в правильной форме.

Именно поэтому Answer Engine должен стать обязательным пользовательским слоем платформы, а не факультативной UI-надстройкой.
