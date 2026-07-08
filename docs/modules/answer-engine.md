# Answer Engine

**Статус:** Draft  
**Автор:** Principal Engineering Specification  
**Дата:** 2026-07-08  
**Версия:** 1.0.0  
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

Answer Engine должен понимать не только текст вопроса, но и **ожидаемый класс ответа**.

### 6.1 Explanation Query

Примеры:

- "как работает модуль авторизации?"
- "почему здесь локализация иногда не совпадает?"
- "откуда берётся этот статус?"

Ожидаемый результат:

- объяснение поведения системы;
- указание причинной цепочки;
- перечисление ключевых файлов или сущностей;
- confidence и unknowns.

### 6.2 Diagnostic Query

Примеры:

- "почему иногда приходит неверный ответ?"
- "почему rollback не работает?"
- "почему не применяется локаль?"

Ожидаемый результат:

- наиболее вероятная причина;
- подтверждающие evidence;
- условия воспроизведения;
- альтернативные гипотезы;
- чего не хватает для окончательного вывода.

### 6.3 Inventory Query

Примеры:

- "сколько языков локализации есть в проекте?"
- "какие провайдеры подключены?"
- "какие миграции затрагивают пользователей?"

Ожидаемый результат:

- компактный список;
- summary counts;
- optional structure;
- confidence.

### 6.4 Change Plan Query

Примеры:

- "как безопасно исправить это?"
- "что нужно поменять для поддержки нового языка?"
- "какой план изменений подготовлен?"

Ожидаемый результат:

- человеческая сводка плана;
- scope изменений;
- риски;
- approval markers;
- optional execution CTA.

### 6.5 Comparative Query

Примеры:

- "чем отличается старый flow от нового?"
- "почему в одной ветке работает, а в другой нет?"

Ожидаемый результат:

- сравнение источников;
- difference summary;
- structural delta;
- confidence.

### 6.6 Insufficient-data Query

Система обязана уметь отвечать:

- "недостаточно данных для уверенного вывода";
- "нужно повторное индексирование";
- "нужны runtime-логи";
- "нужен другой scope".

Это полноценный тип ответа, а не ошибка.

---

## 7. Режимы ответа

Тип запроса не всегда совпадает с типом выдачи. Один и тот же вопрос может завершиться разными answer modes.

### 7.1 Direct Answer

Короткий ответ по сути с минимальным количеством дополнительных деталей.

Используется, когда:

- confidence высок;
- причинная цепочка короткая;
- evidence однозначен;
- запрос явно informational.

### 7.2 Diagnostic Answer

Ответ с гипотезой, подтверждениями, неизвестными зонами и следующими шагами проверки.

Используется, когда:

- пользователь спрашивает "почему";
- evidence неполон;
- есть несколько вероятных причин.

### 7.3 Plan Summary Answer

Ответ с акцентом на план действий, риски и scope изменений.

Используется для change-oriented задач.

### 7.4 Clarifying Answer

Не должен быть пустым вопросом к пользователю.

Это ответ формата:

- "Я нашёл две конкурирующие зоны";
- "недостаточно данных для точного вывода";
- "могу продолжить, если уточним X".

### 7.5 Refusal / Safety Answer

Используется, когда:

- задача противоречит policy;
- нет достаточного обоснования для опасного действия;
- не пройдены approval gates;
- execution запрещён.

### 7.6 Answer-with-Inspector

Это не отдельный тип reasoning, а presentation mode:

- краткий ответ в чате;
- глубокая детализация в `Inspector`.

Это должен быть default UX mode для Client.

---

## 8. Архитектура модуля

Answer Engine должен быть разбит на внутренние компоненты.

### 8.1 Request Intent Resolver

Определяет:

- тип пользовательского запроса;
- ожидаемый режим ответа;
- требуется ли plan summary;
- нужен ли diagnostic style;
- нужен ли follow-up context.

### 8.2 Artifact Selector

Выбирает, какие внутренние артефакты действительно нужны для ответа.

Например:

- для inventory-вопроса может не понадобиться Planner;
- для explanation-вопроса может не понадобиться Execution Preview;
- для change-task без explanation может не понадобиться полная diagnostic narrative.

### 8.3 Answer Strategy Resolver

Выбирает стратегию синтеза ответа:

- concise answer;
- evidence-first answer;
- diagnosis answer;
- plan summary answer;
- insufficient-data answer.

### 8.4 Response Synthesizer

Собирает:

- summary;
- explanation;
- caveats;
- next steps;
- inspector references.

### 8.5 Evidence Distiller

Упрощает внутренние findings до user-facing evidence.

Он должен уметь превращать:

- graph neighbors;
- focus zones;
- module intents;
- planner notes;

в форму, понятную человеку.

### 8.6 Confidence Presenter

Отвечает за:

- корректное отображение уверенности;
- снижение категоричности при слабом evidence;
- маркировку unknowns;
- объяснение, почему ответ ограничен.

### 8.7 Progress Narrator

Преобразует внутренний pipeline status в user-facing progress.

Не "Stage #4 completed", а:

- "Проверяю, какие модули связаны с проблемой";
- "Собираю подтверждения из кода и Git";
- "Подготавливаю объяснение".

### 8.8 Inspector Linker

Формирует отображаемые ссылки и привязки между ответом и внутренними артефактами.

### 8.9 Conversation State Adapter

Удерживает continuity между:

- предыдущими вопросами;
- последним run;
- уже собранными артефактами;
- follow-up запросами.

---

## 9. Полный Answer Pipeline

Ниже описан канонический процесс от пользовательского вопроса до финального ответа.

### 9.1 Высокоуровневая схема

```text
User Message
    ->
Intent Resolution
    ->
Internal Pipeline Trigger
    ->
Research / Impact / Context / Plan (when needed)
    ->
Artifact Selection
    ->
Answer Strategy Resolution
    ->
Answer Synthesis
    ->
Confidence / Unknowns Pass
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

### 9.3 Шаг 2. Классификация намерения

Определяется:

- informational или change-oriented запрос;
- нужен ли diagnostic режим;
- нужен ли Planner;
- нужен ли execution preview;
- нужен ли Git-aware режим;
- нужен ли follow-up reuse.

### 9.4 Шаг 3. Запуск внутреннего pipeline

Answer Engine сам не выполняет upstream-работу, но инициирует или ожидает:

- Research;
- Impact;
- Context;
- Planner, если необходим.

### 9.5 Шаг 4. Выбор артефактов

После завершения pipeline модуль выбирает:

- какие findings попадут в answer;
- какие risks должны быть показаны;
- какие unknowns обязательны;
- какие structural references важны;
- какие детали увести в Inspector.

### 9.6 Шаг 5. Синтез ответа

На этом этапе формируется:

- summary;
- основная причинная цепочка;
- ключевые подтверждения;
- caveats;
- next actions.

### 9.7 Шаг 6. Валидация ответа

Проверяется:

- не противоречит ли answer внутренним артефактам;
- не скрыты ли критичные unknowns;
- не завышена ли уверенность;
- не просочились ли ненужные внутренние технические детали;
- не обещает ли ответ действие, которое pipeline реально не подготовил.

### 9.8 Шаг 7. Выдача ответа

Пользователь получает:

- понятный answer-first output;
- progress превращается в completed answer state;
- Inspector остаётся вторичным каналом детализации.

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

### 11.1 Что должен содержать хороший ответ

Хороший answer-first output должен отвечать на четыре вопроса:

1. Что, скорее всего, происходит.
2. Почему система так считает.
3. Насколько это уверенно.
4. Что делать дальше, если нужна глубина или изменение.

### 11.2 Каноническая структура ответа

По умолчанию ответ должен собираться из слоёв:

1. `Direct Summary`
2. `Reasoning Summary`
3. `Evidence Highlights`
4. `Unknowns / Caveats`
5. `Next Actions`

### 11.3 Принцип минимальной достаточности

Пользовательский ответ не должен становиться свалкой всех findings.

Нужно показывать только:

- наиболее значимую причинную цепочку;
- 2-5 сильных подтверждений;
- важные ограничения;
- следующий полезный шаг.

### 11.4 Пример диагностического ответа

Канонический диагностический ответ должен выглядеть примерно так:

```text
Наиболее вероятная причина в слое выбора локали.

По исследованным данным локаль устанавливается middleware, которое читает входящий header.
Если header присутствует, локаль переключается. Если его нет, используется default locale.
Проблемные ответы совпадают со сценарием, где header отсутствует или не доходит до этого middleware.

Уверенность: средняя.
Чего не хватает: runtime logs конкретных запросов и подтверждения order цепочки middleware.
```

### 11.5 Что запрещено

Answer Engine не должен:

- изображать guess как факт;
- скрывать слабую уверенность;
- выдавать plan как уже выполненное изменение;
- обещать, что причина найдена окончательно, если evidence конкурентный;
- утопить ответ в названиях внутренних артефактов.

---

## 12. Evidence, Confidence и Unknowns

Ответ без evidence становится недоверяемым.  
Ответ без unknowns становится опасно самоуверенным.

### 12.1 Evidence Model

Evidence в пользовательском ответе должен быть:

- кратким;
- прямым;
- связанным с вопросом;
- выводимым из реальных артефактов.

### 12.2 Confidence Model

Answer confidence должен строиться из:

- research confidence;
- impact confidence, если используется;
- полноты structural evidence;
- согласованности между источниками;
- наличия или отсутствия runtime contradictions;
- давности и актуальности данных.

### 12.3 Unknowns

Unknowns обязательны, когда:

- evidence неполон;
- есть конкурирующие гипотезы;
- нет runtime logs;
- Graph или Index устарели;
- не хватает части проекта;
- локальные изменения могут искажать картину.

### 12.4 Правило честной неопределённости

Если система не может уверенно ответить, она обязана сказать:

- чего именно не хватает;
- какой следующий шаг нужен;
- можно ли продолжить автоматически;
- где находится ограничение.

---

## 13. Progress UX и Inspector Model

Это одна из ключевых архитектурных идей модуля.

### 13.1 Внешний UX должен быть answer-first

Пользователь не должен быть обязан понимать:

- что такое Research Report;
- что такое Context Package;
- что такое Execution Plan;
- чем отличается Graph от Knowledge.

Для него продукт должен быть:

- проект;
- модель;
- чат;
- ответ.

### 13.2 Pipeline остаётся видимым, но вторичным

Пользователь может видеть, что система "думает":

- исследует проект;
- собирает подтверждения;
- формирует ответ;

но не обязан читать внутренние артефакты.

### 13.3 Inspector

Все глубокие детали должны быть унесены в `Inspector`.

Inspector должен быть:

- secondary surface;
- optional;
- expert-oriented;
- linked from answer, а не наоборот.

### 13.4 Что должно оставаться в основном сообщении

- summary answer;
- ключевая причина;
- уровень уверенности;
- предупреждение, если нужно;
- action button или follow-up CTA.

### 13.5 Что должно уходить в Inspector

- full findings;
- evidence lists;
- affected files;
- graph summaries;
- context chunks;
- planner notes;
- diagnostics;
- git scope;
- raw unknowns.

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
