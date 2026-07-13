# Self-Validating Answer Pipeline

**Статус:** Proposed  
**Автор:** Principal Architecture Specification  
**Дата:** 2026-07-10  
**Версия:** 1.0.0  
**Зависимости:** [000-overview.md](/Users/evgenii/Desktop/client/docs/architecture/000-overview.md), [003-event-system.md](/Users/evgenii/Desktop/client/docs/architecture/003-event-system.md), [research.md](/Users/evgenii/Desktop/client/docs/modules/research.md), [impact-analysis.md](/Users/evgenii/Desktop/client/docs/modules/impact-analysis.md), [context-builder.md](/Users/evgenii/Desktop/client/docs/modules/context-builder.md), [planner.md](/Users/evgenii/Desktop/client/docs/modules/planner.md), [answer-engine.md](/Users/evgenii/Desktop/client/docs/modules/answer-engine.md), [project-intelligence-runtime.md](/Users/evgenii/Desktop/client/docs/modules/project-intelligence-runtime.md), [provider-system.md](/Users/evgenii/Desktop/client/docs/modules/provider-system.md)

---

## 1. Назначение

Этот документ описывает следующий этап развития `Client`: добавление слоя самопроверки перед финальным формированием ответа.

Цель слоя:

- не позволять `Answer Engine` слишком уверенно отвечать на основе неполного или шумного `Research`;
- не превращать LLM в самостоятельного исследователя проекта;
- сохранить детерминированность инженерного исследования;
- использовать модель только как критика качества уже собранных артефактов;
- не позволять `Validator` слепо наследовать уверенность `Research`;
- при необходимости запускать узкий `Focused Research`, а не полный повтор pipeline.

Новый подход вводит управляемый цикл:

`Research -> Evidence Validation -> Focused Research -> Re-Validation -> Answer Preparation -> Answer Engine`

Это не новая философия платформы. Это усиление последней мили качества между детерминированным исследованием и пользовательским ответом.

---

## 2. Какая проблема решается

Текущий pipeline уже умеет:

- исследовать проект;
- строить `Impact`;
- собирать `Context`;
- готовить `Plan`;
- формировать финальный ответ.

Однако между `Research` и `Answer Engine` остаётся фундаментальный разрыв.

### 2.1 Наблюдаемая проблема

Если `Research`:

- выбрал не самый сильный набор evidence;
- собрал часть релевантных сигналов, но пропустил ключевой;
- захватил шумный соседний домен;
- дал частично правильную, но не достаточно фокусную картину;

то `Answer Engine` всё равно часто пытается выдать связный и уверенный ответ.

### 2.2 Почему это опасно

Возникает худший класс ошибки:

- не полностью ложный ответ;
- не полностью правильный ответ;
- инженерно правдоподобный;
- уверенно звучащий;
- с низкой практической полезностью.

Такой ответ опаснее честного `insufficient data`, потому что:

- вводит разработчика в ложное чувство понимания;
- увеличивает время на ручную проверку;
- подрывает доверие к системе;
- делает слабые модели визуально “умными”, но фактически ненадёжными.

### 2.3 Почему нельзя решить это прямым усилением LLM

Мы сознательно не хотим:

- давать LLM доступ к проекту;
- просить модель “ещё раз самой поискать”;
- позволять ей ходить по файлам, Graph или Git;
- превращать final-answer модель в скрытый `Research Engine`.

Это нарушит базовые принципы Client:

- детерминированность;
- traceability;
- controllable context;
- отделение исследования от ответа.

---

## 3. Зачем нужен Self-Validating Answer Pipeline

Self-Validating Answer Pipeline нужен, чтобы ввести между `Research` и `Answer Engine` формальный слой проверки достаточности доказательств.

Он должен отвечать на вопросы:

- достаточно ли current evidence для уверенного ответа;
- нет ли противоречий между findings;
- не слишком ли широкая зона анализа;
- какие critical gaps мешают ответить;
- какой именно `Focused Research` стоит дозапустить;
- когда evidence уже достаточно, чтобы передавать задачу в `Answer Preparation`.

Это делает ответ не просто “сгенерированным”, а **доказательно допущенным к генерации**.

Критически важно:

- `Research confidence` не является источником истины для `Validator`;
- `Research confidence` является только одним из входных сигналов;
- `Validator` обязан самостоятельно ответить на вопрос:
  - "Если бы мне дали только этот question packet и эти артефакты, смог бы я честно и уверенно ответить пользователю?"

Если ответ отрицательный, Validator обязан:

- не соглашаться с upstream уверенным confidence автоматически;
- не пытаться угадать missing answer;
- определить минимально необходимый следующий refinement step или остановку.

---

## 4. Позиция в существующей архитектуре

Новый слой должен встраиваться между существующими стадиями и не переписывать уже утверждённые модули.

### 4.1 Текущий pipeline

`Question -> Research -> Impact -> Context Builder -> Planner -> Answer Engine`

### 4.2 Целевой pipeline

`Question -> Research -> Impact -> Context Summary -> Evidence Validation -> Focused Research Loop -> Answer Preparation -> Answer Engine`

### 4.3 Принцип встраивания

Новый слой:

- не заменяет `Research`;
- не заменяет `Impact`;
- не заменяет `Context Builder`;
- не заменяет `Planner`;
- не заменяет `Answer Engine`;
- не создаёт альтернативный route обхода существующих модулей.

Он является **quality gate and refinement loop** перед финальным answer synthesis.

### 4.4 Архитектурная роль

Новый слой должен рассматриваться как:

- post-research validation layer;
- focused refinement orchestrator;
- pre-answer quality gate.

---

## 5. Новые внутренние этапы

Для поддержки нового поведения в pipeline появляются следующие новые внутренние этапы.

### 5.1 Evidence Validation

Проверяет достаточность текущего набора артефактов для ответа на вопрос данного типа.

### 5.2 Focused Research Planning

Преобразует замечания Validator в детерминированный набор действий для узкого доисследования.

### 5.3 Focused Research Execution

Запускает только ограниченные research profiles или targeted traversal-операции.

### 5.4 Re-Validation

Повторно оценивает refined evidence после focused research.

### 5.5 Validation Gate

Принимает одно из решений:

- `ready-for-answer`;
- `needs-focused-research`;
- `insufficient-but-answerable`;
- `stop-with-limits`.

### 5.6 Answer Preparation

Запускается только после успешного прохождения validation gate.
Именно сюда попадает уже проверенный и при необходимости уточнённый набор evidence.

---

## 6. Новая high-level схема

```text
Question
    ->
Research
    ->
Impact
    ->
Context Summary
    ->
Evidence Validation
    ->
Validation Result
    ->
Focused Research Planning (if needed)
    ->
Focused Research Execution
    ->
Re-Validation
    ->
Validation Gate
    ->
Answer Preparation
    ->
Answer Engine
```

Важно:

- `Context Summary` здесь не означает новый `Context Builder`;
- это значит компактное summary уже собранного контекста для Validator;
- Validator никогда не получает raw project access.

---

## 7. Границы ответственности

### 7.1 Что входит в новый слой

- проверка достаточности evidence;
- выявление contradictions, gaps и overreach;
- независимая оценка answer readiness поверх всех доступных сигналов, а не только поверх upstream confidence;
- рекомендации по focused refinement;
- orchestration ограниченного цикла `Validation -> Focused Research`;
- финальное решение, можно ли переходить к `Answer Preparation`.

### 7.2 Что не входит

- прямое чтение файлов проекта моделью;
- самостоятельный обход Graph моделью;
- изменение логики `Research`;
- замена `Impact`;
- замена `Context Builder`;
- замена `Planner`;
- формирование финального пользовательского ответа.

### 7.3 Ключевое правило

LLM в этом слое является **критиком артефактов**, а не **исследователем проекта**.

Дополнительное правило:

`Validator` не наследует доверие к `Research Result` автоматически.

Он оценивает:

- качество structural anchors;
- полноту причинной цепочки;
- достаточность подтверждений;
- наличие конфликтов;
- качество diagnostics;
- соответствие answer type и текущего evidence set.

---

## 8. Контракт между этапами

Новый слой требует формального контракта между стадиями.

### 8.1 Input Contract: Validation Input

Validator должен получать только:

- `Question`;
- `Question Type`;
- `Research Result`;
- `Impact Summary`;
- `Context Summary`;
- `Diagnostics`;
- `Background State`, если он materially влияет на достоверность;
- `Validation Iteration Metadata`.

При этом:

- `Research confidence`;
- `Impact confidence`;
- `Context confidence`;

не являются готовым verdict для `Validator`.

Они передаются как сигналы, но не как основание автоматически разрешать переход к ответу.

### 8.2 Output Contract: Validation Result

Validator должен возвращать:

- validation status;
- confidence-in-answer-readiness;
- список gaps;
- список contradictions;
- список missing confirmations;
- recommended actions;
- recommended focused research profile;
- stop condition recommendation;
- short rationale.

Result обязан отражать **собственную оценку достаточности evidence**, даже если она расходится с upstream confidence signals.

### 8.3 Execution Contract: Focused Research Request

Validation layer не запускает arbitrary research.

Он может выдать только ограниченный запрос на:

- конкретный focused profile;
- ограниченный набор focus zones;
- ограничённый traversal scope;
- ограничённый max iteration budget.

### 8.4 Gate Contract: Answer Readiness

`Answer Preparation` может быть запущен только если validation gate вернул один из допустимых итогов:

- `ready-for-answer`;
- `partial-answer-allowed`.

---

## 9. Что получает Validator

Validator получает не проект, а специально подготовленный validation packet.

### 9.1 Question

В packet входит:

- исходный текст вопроса;
- нормализованный `Question Type`;
- optional previous turn context;
- признак follow-up или first question.

### 9.2 Research Result

Validator должен получать из `Research`:

- summary;
- functional summary;
- findings;
- evidence;
- entry points;
- primary entities;
- affected modules;
- unknowns;
- confidence;
- query profile;
- evidence provenance summary.

`Research confidence` здесь нужен только как дополнительный сигнал о внутренней самооценке upstream stage.

Он не должен трактоваться как:

- доказательство достаточности;
- автоматический readiness score;
- разрешение на переход к `Answer Preparation`.

### 9.3 Impact Summary

Validator получает:

- impact summary;
- affected files count;
- affected modules count;
- risk markers;
- validation scope summary;
- confidence.

Полный `Impact Report` передавать не обязательно.

`Impact confidence` также является сигналом, а не готовым verdict.

### 9.4 Context Summary

Validator получает только answer-relevant summary:

- selected chunk count;
- major focus zones;
- functional highlights;
- ranking summary;
- token budget summary;
- context confidence.

Validator не должен видеть raw chunks целиком, если они не нужны для validation task.

`Context confidence` отражает качество curating-stage, но не подменяет оценку answer sufficiency.

### 9.5 Diagnostics

Validator получает:

- index coverage issues;
- parsing diagnostics;
- graph warnings;
- repository freshness issues;
- branch/worktree caveats;
- prior focused research failures, если они были.

### 9.6 Iteration Metadata

Validator должен знать:

- номер итерации validation loop;
- что уже проверялось;
- какие focused actions уже запускались;
- какие из них ничего не дали;
- remaining validation budget.

---

## 10. Что возвращает Validator

Результат Validator должен быть строго структурирован и пригоден для downstream orchestration.

### 10.1 Обязательные поля

- `validationStatus`;
- `readinessScore`;
- `directAnswerFeasibility`;
- `evidenceSufficiency`;
- `contradictionLevel`;
- `gapSummary`;
- `recommendedActions`;
- `recommendedResearchProfile`;
- `recommendedStopReason`, если applicable;
- `validatorRationale`.

### 10.2 Validation Rationale

Rationale должен отвечать на вопросы:

- почему текущий evidence достаточен или недостаточен;
- какие пробелы являются блокирующими;
- какой именно refinement даст наибольший выигрыш;
- почему не нужен полный rerun.

Если Validator расходится с `Research confidence`, rationale обязан явно объяснить:

- почему высокий upstream confidence не принят;
- или почему сравнительно низкий upstream confidence не мешает уже сейчас ответить.

### 10.3 Direct Answer Feasibility

Validator обязан отдельно отвечать:

- можно ли уже сформулировать direct answer;
- можно ли только partial answer;
- нельзя ли пока отвечать вообще.

Это нужно, потому что хороший `Answer Engine` требует ясного `answer readiness`, а не только общего confidence.

### 10.4 Evidence Sufficiency Model

Validator должен оценивать answer readiness минимум по следующим осям:

- соответствие evidence типу вопроса;
- наличие direct-answer-grade structural anchors;
- полнота ключевой причинной или функциональной цепочки;
- качество evidence, а не только его количество;
- наличие unresolved contradictions;
- наличие critical diagnostics, снижающих доверие к картине;
- graph coverage в релевантной зоне;
- наличие или отсутствие critical runtime/config gaps;
- согласованность между `Research`, `Impact`, `Context Summary` и diagnostics.

Итоговый verdict должен быть derived именно из этой совокупности факторов.

---

## 11. Validation Results

Система должна поддерживать фиксированный набор validation outcomes.

### 11.1 `ready-for-answer`

Текущий evidence достаточен для формирования сильного ответа.

Используется, когда:

- direct answer подтверждаем;
- contradictions не блокируют вывод;
- remaining unknowns не ломают основной ответ.
- available anchors и quality evidence действительно соответствуют question type.

### 11.2 `partial-answer-allowed`

Текущий evidence недостаточен для сильного полного ответа, но достаточен для честного ограниченного ответа.

Используется, когда:

- direct answer можно дать с caveat;
- critical uncertainty явно сформулирована;
- дополнительный focused research не даст значительного выигрыша в рамках бюджета.

### 11.3 `needs-focused-research`

Текущий evidence недостаточен, но есть ясный следующий узкий шаг, который может улучшить качество ответа.

Используется, когда:

- gap локализуем;
- refinement ограничен;
- повторный focused research экономически оправдан.

### 11.4 `contradictory-evidence`

Собранные артефакты содержат несовместимые сигналы.

Используется, когда:

- findings конфликтуют;
- evidence подтверждает несколько конкурирующих трактовок;
- branch/worktree overlay materially ломает вывод.

### 11.5 `insufficient-evidence`

Данных недостаточно, и focused refinement в рамках допустимого бюджета не обещает сильного улучшения.

### 11.6 `validator-unavailable`

Модель-критик или validation layer недоступны.

В этом случае система должна:

- не падать;
- либо переходить в deterministic degraded path;
- либо честно формировать answer с пониженным trust level.

---

## 12. Recommended Actions

Validator не должен возвращать свободный текст вроде “поищи ещё что-нибудь”.
Он обязан возвращать действия из контролируемого словаря.

### 12.1 Structural Traversal Actions

- `run-entrypoint-traversal`
- `run-reverse-dependency-check`
- `run-call-chain-expansion`
- `run-inheritance-expansion`
- `run-interface-implementation-check`

### 12.2 Functional Focus Actions

- `check-middleware-chain`
- `check-route-controller-binding`
- `check-oauth-provider-binding`
- `check-runtime-locale-resolution`
- `check-history-guard-flow`

### 12.3 Configuration Actions

- `check-config-file`
- `check-env-fallback`
- `check-service-provider-registration`
- `check-framework-binding`

### 12.4 Persistence and Data Actions

- `check-model-relation`
- `check-schema-touchpoints`
- `check-repository-usage`
- `check-db-storage-location`

### 12.5 Scope Adjustment Actions

- `narrow-to-entrypoint`
- `narrow-to-module`
- `narrow-to-runtime-path`
- `drop-noisy-neighbor-zone`

### 12.6 Stop / Escalation Actions

- `allow-partial-answer`
- `stop-with-insufficient-evidence`
- `request-background-refresh`
- `request-runtime-logs`

Важно:

- каждая action должна быть трассируемой;
- каждая action должна маппиться на один или несколько существующих research profiles или refinement primitives;
- Validator не может придумывать произвольные команды вне словаря.

---

## 13. Focused Research

Focused Research — это не новый full research.
Это ограниченный refinement run поверх уже существующих артефактов.

### 13.1 Основная идея

Focused Research должен:

- использовать текущий `Research Result` как baseline;
- брать только один или несколько validated refinement actions;
- расширять evidence строго в нужной зоне;
- не перерасходовать pipeline budget;
- не превращаться в скрытый full scan.

### 13.2 Что может делать Focused Research

- повторно обойти конкретный entrypoint;
- открыть дополнительные structural neighbors;
- проверить конкретную config/runtime цепочку;
- углубить traversal в конкретный module family;
- расширить evidence вокруг already identified entity;
- перепроверить critical contradiction.

### 13.3 Что он не должен делать

- заново сканировать весь проект;
- пересобирать весь graph без причины;
- запускать broad repository scan;
- спрашивать модель, куда идти по проекту без ограничения;
- переписывать исходный `Research` произвольно.

### 13.4 Результат Focused Research

Focused Research должен возвращать:

- additional evidence;
- refined findings;
- resolved contradictions, если они устранены;
- remaining gaps;
- refinement diagnostics;
- delta относительно предыдущего research state.

---

## 14. Цикл Validation -> Focused Research

### 14.1 Базовый цикл

1. Выполняется обычный `Research`.
2. На его основе строится validation packet.
3. Validator возвращает один из validation results.
4. Если результат `needs-focused-research`, формируется focused research request.
5. Выполняется узкий refinement run.
6. Формируется новый validation packet с учётом delta.
7. Validator оценивает refined state повторно.
8. Цикл повторяется до достижения stop condition.

### 14.2 Важное правило

Каждая новая итерация должна быть уже предыдущей:

- меньше по scope;
- точнее по цели;
- яснее по expected gain.

Система не должна крутиться вокруг одного и того же broad uncertainty.

### 14.3 Сохранение traceability

Каждая итерация должна сохранять:

- кто инициировал refinement;
- какой action был выбран;
- какие diagnostics были до и после;
- что реально изменилось в evidence;
- почему цикл остановился.

---

## 15. Когда цикл должен останавливаться

Цикл должен завершаться при достижении одного из следующих условий.

### 15.1 Success Stop

Validator вернул `ready-for-answer`.

### 15.2 Partial Stop

Validator вернул `partial-answer-allowed`, и policy допускает честный ограниченный ответ.

### 15.3 No-Gain Stop

Последний `Focused Research`:

- не добавил новых meaningful evidence;
- не уменьшил contradictions;
- не повысил readiness materially.

### 15.4 Budget Stop

Достигнут лимит:

- по числу итераций;
- по token budget;
- по latency budget;
- по provider budget.

### 15.5 Scope Stop

Требуемый следующий шаг уже выходит за разрешённый `Focused Research` и фактически становится новым full research.

### 15.6 Freshness Stop

Выяснилось, что:

- baseline устарел;
- branch/head drift слишком велик;
- current project state требует background refresh вместо refinement loop.

---

## 16. Как избежать бесконечных циклов

Это обязательное требование.

### 16.1 Hard Iteration Cap

Для одного question-run должен существовать жёсткий максимум validation iterations.

Рекомендуемое правило для MVP:

- не более 2 refinement-итераций после исходного research.

### 16.2 No-Repeat Rule

Нельзя повторять один и тот же `recommended action`, если:

- он уже был выполнен;
- не дал meaningful delta;
- входные условия не изменились.

### 16.3 Minimum Gain Threshold

Повторный цикл допустим только если предыдущий refinement дал хотя бы один из эффектов:

- новый strong evidence;
- устранение contradiction;
- narrowing direct answer ambiguity;
- measurable improvement in answer readiness.

### 16.4 Action Budget

На одну итерацию должен действовать лимит числа actions.

Validator не должен выдавать:

- длинный список “проверить всё подряд”;
- десяток refinement instructions;
- расплывчатый набор пожеланий.

Рекомендуемое правило:

- 1 primary action;
- максимум 2 secondary actions.

### 16.5 Escalation to Honest Stop

Если цикл не дал существенного улучшения, система должна:

- остановиться;
- сохранить trace;
- перейти в `partial-answer-allowed` или `insufficient-evidence`;
- не симулировать прогресс.

---

## 17. Использование разных моделей

Новый слой должен быть model-agnostic, но при этом специально рассчитан на использование более дешёвых моделей в роли критика.

### 17.1 Базовый принцип

Validator-модель не должна:

- писать пользовательский ответ;
- быть stylistically strong;
- уметь программировать;
- уметь читать репозиторий напрямую.

От неё требуется только:

- оценивать достаточность evidence;
- замечать contradictions и gaps;
- выбирать из контролируемого словаря refinement actions.

Это делает validator role хорошим кандидатом для дешёвых моделей.

### 17.2 Возможные runtime patterns

#### Pattern A

- `NVIDIA / Nemotron` — Validator
- `GPT` — Final Answer

Подходит, когда:

- нужна дешёвая массовая self-check стадия;
- финальный ответ требует сильного synthesis quality.

#### Pattern B

- `DeepSeek` — Validator
- `NVIDIA` — Final Answer

Подходит, когда:

- приоритетом является стоимость;
- answer UX допустимо пока держать более простым;
- главная ценность — не стиль ответа, а quality gate перед ним.

#### Pattern C

- `DeepSeek` — Validator
- `GPT` — Final Answer

Подходит, когда:

- нужен сильный критик с лучшей reasoning stability;
- финальный ответ должен быть качественным и user-friendly.

#### Pattern D

- `GPT mini / cheap GPT tier` — Validator
- `GPT larger tier` — Final Answer

Подходит, когда:

- хочется унифицировать provider family;
- важна предсказуемость response schema;
- acceptable provider multiplier still fits budget.

### 17.3 Model Capability Requirements for Validator

Validator-модель должна:

- стабильно работать по structured prompt;
- возвращать controlled schema;
- не галлюцинировать arbitrary actions;
- уметь выбирать best-next-check из ограниченного набора;
- быть дешёвой enough для per-question usage.

### 17.4 Model Capability Requirements for Final Answer

Final Answer модель должна:

- хорошо следовать `Answer Brief`;
- уметь писать human-friendly инженерный ответ;
- не пересказывать pipeline;
- выдерживать answer-first UX.

### 17.5 Failure Isolation

Сбой validator-модели не должен блокировать весь pipeline навсегда.

Допустимые degraded paths:

- fallback на deterministic validation heuristics;
- single-pass answer with stronger caveats;
- operator-facing warning, что self-validation слой был пропущен.

---

## 18. Как встроить это без переписывания текущего pipeline

Ключевое требование: новый слой должен быть additive, а не disruptive.

### 18.1 Что остаётся неизменным

- `Research` остаётся детерминированным источником инженерных знаний;
- `Impact` остаётся отдельной аналитической стадией;
- `Context Builder` остаётся curating-модулем;
- `Planner` остаётся decision/planning слоем;
- `Answer Engine` остаётся user-facing answer слоем.

### 18.2 Что добавляется

- validation packet assembly;
- evidence validator;
- focused research planner;
- focused research execution loop;
- answer readiness gate;
- answer preparation on top of validated evidence.

### 18.3 Где должен жить orchestration слой

Предпочтительно новый слой должен жить как orchestration extension внутри question-run pipeline, а не как отдельный верхнеуровневый модуль платформы.

Причины:

- он не является новым автономным domain owner;
- он обслуживает только answer quality path;
- он работает поверх уже существующих артефактов;
- ему не нужен собственный graph, storage или knowledge ownership.

### 18.4 Integration boundary with Answer Engine

`Answer Engine` не должен сам решать, достаточно ли evidence.

Он должен получать:

- либо `validated answer-ready packet`;
- либо `partial answer packet`;
- либо stop reason.

Это устраняет текущую проблему, когда answer synthesis вынужден сам “верить” raw research artifacts.

---

## 19. Контракты новых артефактов

### 19.1 Validation Packet

Временный артефакт для Validator.

Содержит:

- user question;
- question type;
- condensed research;
- condensed impact;
- condensed context;
- diagnostics;
- iteration state.

### 19.2 Validation Result

Артефакт решения Validator.

Содержит:

- verdict;
- readiness score;
- gaps;
- contradictions;
- recommended actions;
- stop signals;
- rationale.

### 19.3 Focused Research Request

Артефакт запроса на refinement.

Содержит:

- target profile;
- allowed actions;
- focus zones;
- expected gain;
- iteration number;
- safety/budget constraints.

### 19.4 Validated Answer Packet

Артефакт, который передаётся в `Answer Preparation`.

Содержит:

- validated evidence set;
- allowed answer scope;
- confidence ceiling;
- mandatory caveats;
- answer readiness verdict.

---

## 20. Validation policy

### 20.1 Validator не должен отвечать на вопрос пользователя

Он не формирует user-facing answer.
Он не пишет “Да, Google auth есть”.
Он оценивает, можно ли такую фразу уже честно сформулировать downstream слою.

Он также не должен говорить:

- "Research confidence высокий, значит можно отвечать";
- "Research confidence низкий, значит отвечать нельзя".

Он обязан принимать собственное решение на основе всей validation packet.

### 20.2 Validator не должен изобретать новые факты

Он может:

- сомневаться;
- сравнивать;
- находить gaps;
- рекомендовать, где стоит усилить deterministic research.

Он не может:

- добавлять новые project facts;
- делать framework guesses;
- формулировать undocumented architectural truths.

Он может не согласиться с выводом `Research`, если считает, что:

- evidence недостаточно;
- отсутствует ключевой тип подтверждения;
- найденные anchors не соответствуют типу вопроса;
- diagnostics materially ослабляют достоверность картины.

### 20.3 Validator не должен расширять scope без разрешения

Если answer требует full rescan или fundamentally new exploration path, validator обязан:

- остановить focused loop;
- вернуть `request-background-refresh` или `stop-with-insufficient-evidence`.

---

## 21. Performance considerations

Новый слой улучшает качество, но добавляет latency и token cost.

Поэтому он должен быть экономным.

### 21.1 Lightweight First

Validator должен получать condensed packet, а не все upstream payloads целиком.

### 21.2 Focused Instead of Full

Любой refinement должен быть:

- targeted;
- bounded;
- cheaper than full research rerun.

### 21.3 Budget-aware Orchestration

Для question-run должны существовать лимиты:

- max validator passes;
- max refinement passes;
- max added token budget;
- max added latency.

### 21.4 Reuse

Если предыдущая validation iteration уже установила:

- что определённый action бесполезен;
- что определённый contradiction unresolved;
- что current branch state unchanged;

эти знания должны переиспользоваться в рамках текущего run.

---

## 22. Отказоустойчивость

### 22.1 Если Validator недоступен

Система должна:

- либо перейти в deterministic validation fallback;
- либо сформировать answer с пониженным trust mode;
- либо честно сообщить, что self-validation слой пропущен.

### 22.2 Если Focused Research failed

Система не должна зацикливаться.
Она должна:

- зафиксировать failure;
- уменьшить remaining budget;
- либо попробовать альтернативную validated action;
- либо остановиться.

### 22.3 Если Validation и Research конфликтуют

Приоритет фактов остаётся за deterministic artifacts.

Validator может сказать:

- “этого недостаточно”;
- “это противоречиво”;
- “это не готово для ответа”.

Но он не может переписать `Research Result` как источник истины.

---

## 23. Migration Plan

Внедрение должно идти поэтапно.

### 23.1 Phase 1 — Validation Packet and Passive Critique

Добавить:

- assembly `Validation Packet`;
- passive validator;
- сохранение `Validation Result` без влияния на pipeline.

Цель:

- измерить качество critique;
- понять частые gaps;
- не менять runtime поведение ответа.

### 23.2 Phase 2 — Soft Gate

Добавить:

- предупреждение answer layer, если validator считает evidence weak;
- optional operator-visible flag;
- recommendation trace without automatic refinement.

Цель:

- проверить ценность validation без orchestration complexity.

### 23.3 Phase 3 — Focused Research Loop

Добавить:

- controlled `needs-focused-research`;
- execution ограниченного refinement;
- re-validation;
- hard iteration cap.

Цель:

- улучшить answer readiness до ответа пользователю.

### 23.4 Phase 4 — Answer Readiness Gate

Сделать validation обязательным quality gate для selected question types:

- diagnostic;
- configuration behavior;
- existence with weak evidence;
- high-risk impact questions.

### 23.5 Phase 5 — Model Routing Policy

Добавить configurable validator/final-answer model routing:

- cheap validator + strong answer model;
- same provider family;
- provider-specific fallback policies.

### 23.6 Phase 6 — Full Integration with Answer Brief

Передавать в `Answer Engine` не raw pipeline artifacts, а validated answer packet / answer brief pair.

Это завершит переход от:

- `Research-trusting answer synthesis`

к:

- `validated evidence driven answer synthesis`.

---

## 24. Ограничения

Новый слой не решает автоматически все проблемы качества ответа.

### 24.1 Что он не исправит

- плохой `Research`, если deterministic layer системно не умеет найти нужную зону;
- плохой Graph coverage;
- сломанный Index;
- отсутствие branch freshness;
- слабый `Answer Engine`, который потом всё равно плохо пишет.

### 24.2 Что он реально улучшает

- уменьшает ложную уверенность;
- увеличивает шанс targeted refinement перед ответом;
- лучше отделяет “можно отвечать” от “данных пока мало”;
- делает weak models полезными как critics;
- снижает количество посредственных, но уверенных ответов.

---

## 25. Критерии успеха

Новый слой считается успешным, если после внедрения:

- уменьшается доля answer-first ответов, которые потом оказываются инженерно бесполезными;
- растёт доля вопросов, где система либо усиливает evidence перед ответом, либо честно останавливается;
- падает число broad / noisy ответов при тех же upstream artifacts;
- снижается зависимость качества final answer от завышенного или заниженного `Research confidence`;
- дешёвые модели реально становятся полезными как critic layer;
- final answer quality становится заметно стабильнее без превращения LLM в свободного исследователя проекта.

---

## 26. Итог

Self-Validating Answer Pipeline — это не попытка сделать LLM умнее проекта.

Это попытка сделать последний этап pipeline честнее и надёжнее:

- сначала проверить, достаточно ли у нас оснований отвечать;
- при необходимости узко доисследовать;
- и только потом формировать пользовательский ответ.

Тем самым Client сохраняет свою фундаментальную архитектурную идею:

- исследование остаётся детерминированным;
- модель не “гуляет по проекту”;
- ответ формируется только после controlled quality gate;
- слабые модели начинают приносить инженерную пользу как слой самокритики, а не как источник истины.
