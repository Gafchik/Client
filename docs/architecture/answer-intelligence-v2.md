# Answer Intelligence V2

**Статус:** Proposed  
**Автор:** Principal Engineering Specification  
**Дата:** 2026-07-10  
**Версия:** 1.1.0  
**Зависимости:** [self-validating-answer-pipeline.md](/Users/evgenii/Desktop/client/docs/architecture/self-validating-answer-pipeline.md), [claim-pipeline.md](/Users/evgenii/Desktop/client/docs/architecture/claim-pipeline.md), [000-overview.md](/Users/evgenii/Desktop/client/docs/architecture/000-overview.md), [answer-engine.md](/Users/evgenii/Desktop/client/docs/modules/answer-engine.md), [research.md](/Users/evgenii/Desktop/client/docs/modules/research.md), [impact-analysis.md](/Users/evgenii/Desktop/client/docs/modules/impact-analysis.md), [context-builder.md](/Users/evgenii/Desktop/client/docs/modules/context-builder.md), [planner.md](/Users/evgenii/Desktop/client/docs/modules/planner.md), [project-intelligence-runtime.md](/Users/evgenii/Desktop/client/docs/modules/project-intelligence-runtime.md)

---

## 1. Назначение

Этот документ описывает следующий эволюционный шаг для последнего слоя answer pipeline.

Цель:

- сделать `Answer Engine` самостоятельным инженерным интерпретатором;
- уменьшить слепое доверие к upstream `Research`;
- не переписывать `Research`, `Impact`, `Context Builder` или `Planner`;
- не менять внешний API и не ломать текущий chat UX;
- усилить reasoning именно в последней миле между validated artifacts и final answer.

Ключевая идея:

`Answer Engine` должен работать не как форматировщик summary/findings, а как **инженер, который проверяет, какие claims из текущих материалов реально допустимы к ответу**.

---

## 2. Какая проблема остаётся после Self-Validating Pipeline

`Self-Validating Answer Pipeline` уже добавил полезный слой:

- проверку sufficiency evidence;
- focused research loop;
- readiness gate перед ответом.

Но этого недостаточно.

Даже после successful validation последний слой всё ещё может:

- брать narrative из `Research` почти как готовую истину;
- переносить upstream framing в финальный ответ;
- не различать direct-answer facts и supporting facts;
- не проверять, соответствует ли итоговый claim именно вопросу пользователя;
- превращать `validated` pipeline в красиво оформленный, но всё ещё upstream-shaped answer.

Именно эту зону и закрывает `Answer Intelligence V2`.

---

## 3. Наблюдения по текущему состоянию

Ниже перечислены слабые места, подтверждённые текущими документами и реализацией.

### 3.1 Answer Engine всё ещё не строит ни Claim Pipeline, ни реальный Answer Brief

Документация уже требует:

- `Question Type Resolver`;
- `Claim Pipeline`;
- `Evidence Synthesizer`;
- `Answer Brief Builder`;
- `Answer Validation`.

Но в runtime этого промежуточного слоя пока нет.  
Текущий код переходит почти напрямую из pipeline artifacts в `AnswerPackage`.  
См. [packages/ai/src/index.ts](/Users/evgenii/Desktop/client/packages/ai/src/index.ts).

Следствие:

- финальный ответ строится из `research.functionalSummary`, `research.summary`, `research.findings`, `impact.summary`, `plan.summary`;
- answer layer не удерживает отдельную модель claims, обязательств доказательства, support levels и rejection reasons;
- downstream answer reasoning остаётся артефактно-зависимым, а не question-driven.

### 3.2 Deterministic answer по-прежнему в основном пересобирает upstream narrative

Сейчас:

- `buildDeterministicSummary()` часто возвращает `research.functionalSummary` или `research.summary`;
- `buildHowItWorksSection()` напрямую разворачивает `entryPoints`, `dataSources`, `findings`;
- `buildImpactSection()` и `buildPlanSection()` добавляются как почти готовые upstream summaries;
- `buildAnswerPrompt()` передаёт модели сырые блоки `Research / Impact / Context / Plan`.

Это делает последний слой очень близким к formatter-mode, а не к claim-evaluation mode.

### 3.3 Question typing слишком эвристичен и может ошибочно определять answer shape

Текущий `resolveQuestionType()` построен на простых keyword heuristics.  
См. [packages/ai/src/index.ts](/Users/evgenii/Desktop/client/packages/ai/src/index.ts).

Критичный пример:

- вопрос `как в проекте выбирается локаль ответа?`
- содержит `как`
- поэтому рано уходит в `flow`
- хотя по смыслу это `configuration/runtime precedence`

Следствие:

- Answer Engine может ожидать не тот proof shape;
- validation и composition работают в неверной answer frame;
- final answer усиливает не тот аспект evidence.

### 3.4 Validator оценивает quality gate, но не формирует claim model

Текущий validation layer хорошо отвечает на вопрос:

- достаточно ли evidence в целом;
- стоит ли запускать focused research;
- есть ли крупные gaps.

Но он почти не отвечает на вопрос:

- **какой именно direct claim можно сделать**;
- **какой claim нельзя делать**;
- **какой кусок ответа поддержан напрямую, а какой только косвенно**.

`ValidatedAnswerPacket` сейчас хранит:

- `directAnswerAllowed`;
- `confidenceCeiling`;
- `mandatoryCaveats`;
- `validatedEvidence`.

Этого мало для настоящего claim-first answer reasoning.

### 3.5 Нет отдельной проверки соответствия evidence самому вопросу

Сейчас система умеет проверить:

- число anchors;
- freshness;
- diagnostics;
- наличие entry points;
- отдельные domain-specific gaps.

Но не хватает answer-level question/evidence alignment:

- отвечает ли evidence именно на asked question;
- не сдвинулся ли ответ в соседний поддомен;
- не подменён ли вопрос про причину вопросом про устройство;
- не выдаётся ли broad architectural summary вместо local direct answer.

### 3.6 Нет нормальной работы с competing interpretations

Сейчас contradictions определяются грубо:

- stale/missing freshness;
- большой overlay;
- diagnostics;
- частично эвристичные summary markers.

Но нет явной answer-level модели для случаев:

- есть две plausible цепочки;
- evidence подтверждает наличие механизма, но не подтверждает, что именно он объясняет observed problem;
- есть direct location, но нет direct causality;
- есть route/controller/action, но нет proof of runtime branch selection.

### 3.7 Post-answer validation слишком слабая

Сейчас post-check LLM ответа в основном ловит blacklist-style hallucinations.  
См. `validateProviderAnswer()` в [packages/ai/src/index.ts](/Users/evgenii/Desktop/client/packages/ai/src/index.ts).

Она полезна, но недостаточна:

- не проверяет каждое direct claim;
- не проверяет unsupported causality claims;
- не различает supported vs overstated wording;
- не видит, когда модель сместила основной answer focus.

### 3.8 Confidence остаётся aggregate, а не claim-level

Сейчас confidence строится как среднее из:

- `research.confidence`;
- `impact.confidence`;
- `context.confidence`;
- затем ограничивается validation ceiling.

Это даёт общий score, но не отвечает на более важный вопрос:

- насколько уверен direct answer;
- насколько уверен causal explanation;
- насколько уверен recommended plan;
- какие части ответа weaker than others.

### 3.9 Последний слой всё ещё слишком охотно тащит impact/plan

По спецификации:

- impact и plan должны быть conditionally relevant;
- answer должен быть answer-first.

Но deterministic explanation сейчас почти всегда строится как multi-section technical answer, даже если вопрос был:

- existence;
- location;
- short configuration;
- narrow runtime lookup.

Это увеличивает шум и маскирует слабость direct answer.

### 3.10 Domain-specific heuristics есть, но общего answer intelligence нет

Сейчас уже есть специальные weighting-хуки для:

- locale behavior;
- billing rollback.

Это помогло конкретным regression cases, но не решает общую архитектурную проблему:

- reasoning всё ещё не general-purpose;
- логика пока patch-driven, а не claim-driven;
- новые классы вопросов будут снова требовать частных исключений.

---

## 4. Какие ложные ответы ещё возможны

### 4.1 Ложный direct answer на косвенном evidence

Система может ответить уверенно, если:

- есть несколько сильных anchors рядом;
- но нет прямого подтверждения именно тому claim, который спрашивал пользователь.

Пример класса ошибки:

- найден route и controller;
- но не найдено подтверждение фактического выбора runtime branch;
- ответ всё равно звучит как окончательный.

### 4.2 Правильная зона, но неверный тип вывода

Система может попасть в правильный модуль, но выдать:

- flow вместо configuration answer;
- explanation вместо diagnosis;
- architecture overview вместо direct location;
- general mechanism вместо observed cause.

### 4.3 Смещение в соседний домен

Если `Research` привёл близкие, но не answer-driving evidence, Answer Engine пока недостаточно хорошо умеет сказать:

- это релевантно соседне;
- это supporting only;
- это нельзя делать основой direct answer.

### 4.4 Overclaim при partial evidence

Даже при `partial-answer-allowed` есть риск, что итоговая формулировка будет звучать сильнее, чем допускает evidence.

### 4.5 Формально правдивый, но practically misleading ответ

Самый опасный класс ошибки:

- текст не содержит явной лжи;
- все отдельные элементы где-то рядом подтверждены;
- но главный вывод не соответствует реальной потребности вопроса.

Именно этот класс и делает Answer Engine похожим на formatter, а не на инженера.

---

## 5. Цель Answer Intelligence V2

После внедрения нового слоя последний mile должен уметь:

1. понять, какой именно direct answer нужен;
2. выделить обязательства доказательства для этого ответа;
3. оценить evidence не по общему quality score, а по покрытию этих обязательств;
4. отделить:
   - direct-answer facts;
   - supporting facts;
   - noisy but nearby facts;
   - unresolved alternatives;
5. сформулировать только те claims, которые реально поддержаны;
6. отправить в additional refinement только те gaps, которые блокируют direct answer;
7. валидировать финальный answer уже как набор claims, а не просто как красиво написанный summary.

---

## 6. Архитектурный принцип

Новый слой не меняет глобальный pipeline.

Остаётся:

`Research -> Impact -> Context -> Validation -> Focused Research -> Answer Engine`

Меняется внутренняя структура самого `Answer Engine`.

Новый принцип:

`Validated artifacts -> Question Contract -> Claim Pipeline -> Answer Brief V2 -> Final Answer`

---

## 7. Новые внутренние этапы Answer Engine

### 7.1 Question Contract Builder

Это первый обязательный шаг answer-layer.

Он должен построить внутренний `Question Contract`:

- `questionType`;
- `primaryIntent`;
- `expectedDirectAnswerShape`;
- `targetEntityOrMechanism`;
- `proofObligations`;
- `disallowedExtrapolations`.

Примеры `proof obligations`:

- **existence**: нужен хотя бы один direct structural/runtime anchor и один supporting location/mechanism anchor;
- **location**: нужен exact code/storage location, а не просто related module;
- **flow**: нужен entry point и хотя бы минимальная causal chain;
- **configuration**: нужен precedence/fallback source, а не просто config directory;
- **diagnostic**: нужен supported cause hypothesis + explicit missing confirmation list.

### 7.2 Claim Pipeline

`Claim Pipeline` считается финальной архитектурой последней мили и является фундаментом `Answer Intelligence V2`.

Он принимает validated artifacts и производит:

- `candidate claims`;
- `claim evidence links`;
- `claim support levels`;
- `validated claim set`;
- `rejected / unsafe claims`;
- `claim-level caveats`.

Главный принцип:

`Answer Brief` не создаёт истину сам.  
Он только организует уже провалидированные claims для выдачи пользователю.

### 7.3 Evidence Audit

Новый answer-facing слой поверх уже готовых artifacts.

Он не создаёт новых facts.
Он классифицирует текущие факты.

Выход:

- `directEvidence`;
- `supportingEvidence`;
- `indirectEvidence`;
- `noiseCandidates`;
- `missingObligations`;
- `competingInterpretations`;
- `stalenessRisks`;
- `overlayRisks`.

Ключевое правило:

evidence оценивается не по общей силе, а по тому, **закрывает ли оно proof obligation конкретного claim в рамках конкретного вопроса**.

### 7.4 Claim Candidate Builder

Из audited evidence строятся не сразу paragraphs, а `Claim Candidates`:

- `directClaim`;
- `supportingClaims[]`;
- `rejectedClaims[]`;
- `claimCaveats[]`.

Для каждого claim фиксируется:

- supportedBy;
- supportType: direct / supporting / inferred;
- confidenceBand;
- blockingGaps.

`Claim Candidate Builder` не отвечает пользователю. Он строит промежуточные инженерные единицы, пригодные для claim-level validation.

### 7.5 Claim Validator

Это обязательный post-claim шаг.

Он проверяет:

- каждый direct claim имеет direct или explicitly caveated support;
- causality не выдана как факт, если есть только adjacency;
- wording strength соответствует support level;
- unsupported claims не просочились из upstream summary;
- question intent не был silently shifted.

Результат этого шага — `Validated Claim Set`.

### 7.6 Answer Brief V2

Это обязательный внутренний контракт последнего слоя.

`Answer Brief V2` должен содержать:

- `questionContract`;
- `answerStatus`: answered / partial / insufficient;
- `directClaim`;
- `directClaimSupportLevel`;
- `supportingClaims`;
- `rejectedOrUnsafeClaims`;
- `whereToLook`;
- `impactIfRelevant`;
- `planIfRelevant`;
- `materialUnknowns`;
- `manualChecks`;
- `inspectorTargets`;
- `wordingConstraints`.

Главный принцип:

и deterministic fallback, и LLM synthesis должны работать **не от `Research Report`, а от `Validated Claim Set -> Answer Brief V2`**.

### 7.7 Answer Strategy Resolver

Выбирает форму ответа не по одному `questionType`, а по пересечению:

- `questionContract`;
- `directClaimSupportLevel`;
- `competingInterpretations`;
- `materialUnknowns`;
- `validationStatus`.

Например:

- `answered`
- `answered-with-caveat`
- `partial-direct-answer`
- `insufficient-for-direct-answer`
- `narrowing-needed`

### 7.8 Final Response Composer

Только на этом шаге собирается пользовательский текст.

Порядок обязан быть:

1. direct answer;
2. 1 ведущая explanation line;
3. 2-4 supporting confirmations;
4. where to look;
5. impact/plan только если они реально нужны;
6. material limitations.

---

## 8. Что именно меняется в reasoning

### 8.1 От aggregate confidence к proof-obligation coverage

Сейчас вопрос часто оценивается через общий readiness/confidence.  
Новый слой должен смотреть на coverage:

- какой obligation закрыт;
- какой obligation закрыт только косвенно;
- какой obligation не закрыт вовсе.

### 8.2 От `research summary -> answer` к `claims -> validated claim set -> answer`

Сейчас answer часто происходит так:

`research.functionalSummary` -> user answer

Должно стать:

`user asks X`  
`answer requires claims A/B/C`  
`evidence supports only A and B`  
`C не попадает в validated claim set или остаётся caveated`

### 8.3 От one-shot narrative к scoped claim discipline

Последний слой должен уметь говорить:

- `это подтверждено`;
- `это правдоподобно, но не доказано`;
- `это связано, но не является ответом на ваш вопрос`;
- `это нельзя утверждать по текущим данным`.

### 8.4 От heuristic answer mode к contractual answer mode

Question typing должен стать не просто классификатором слов, а builder-ом proof contract.

---

## 9. Focused Research integration без изменения архитектуры

`Answer Intelligence V2` не переписывает existing validation loop.

Он только делает более качественный answer-layer input в этот loop и claim-level gate после него.

### 9.1 Когда Answer Engine должен инициировать дополнительное уточнение

Последний слой должен инициировать additional refinement, если:

- direct claim blocked;
- есть competing interpretations;
- evidence отвечает на соседний, но не на текущий вопрос;
- сильный answer потребует unsupported causality;
- нет exact location/config/entrypoint proof, который обязателен для question type.

### 9.2 Когда не нужно запускать новый refinement

Не нужно инициировать refinement, если:

- direct answer уже возможен, но explanation limited;
- supporting facts weak, но direct location/yes-no уже подтверждены;
- impact/plan можно просто не показывать в main answer;
- проблема в presentation, а не в evidence.

Это важно: часть текущих слабых ответов лечится не новым research, а более умным answer composition.

---

## 10. Что НЕ меняется

### 10.1 Архитектурные границы

Не меняются:

- `Research`
- `Impact Analysis`
- `Context Builder`
- `Planner`
- общий pipeline orchestration
- внешний chat UX
- публичный shape `AnswerPackage`, `ValidationResult`, `ValidatedAnswerPacket`

### 10.2 Допустимые изменения

Разрешены только:

- внутренние answer-layer структуры;
- additive internal metadata;
- более сильные deterministic rules;
- более строгая claim validation;
- лучшее selective использование уже существующих artifacts.

---

## 11. Эволюционный план реализации

### Phase 1 — Internal Question Contract

Добавить внутренний `Question Contract Builder` в `packages/ai`.

Минимум:

- нормализованный `questionType`;
- `expectedAnswerShape`;
- `proofObligations`;
- `relevanceFilters`.

### Phase 2 — Claim Pipeline skeleton

Добавить внутри answer-layer claim-first skeleton поверх текущих validated artifacts.

Минимум:

- candidate claims;
- claim evidence links;
- validated claim set;
- rejected/unsafe claims;
- claim-level caveats.

### Phase 3 — Evidence Audit

Добавить answer-facing audit для quality classification claims.

Минимум:

- direct/supporting/noise split;
- missing obligations;
- competing interpretations;
- material unknowns.

### Phase 4 — Answer Brief V2

Перевести и deterministic fallback, и LLM prompt на новый internal brief.

Важно:

- brief должен строиться только из validated claim set;
- brief должен стать единственной входной формой для synthesis;
- сырые `Research/Impact/Context/Plan` не должны больше быть основным narrative substrate.

### Phase 5 — Claim-aware answer validation

Добавить answer-level verification:

- для deterministic answer;
- для LLM answer;
- для wording strength;
- для question alignment.

### Phase 6 — Prompt narrowing

Упростить LLM synthesis:

- не давать универсальный шестисекционный отчёт для всех вопросов;
- делать prompt answer-mode-specific;
- передавать только brief facts, caveats и where-to-look references.

---

## 12. Критерии успешности

Рефакторинг считается успешным, если:

1. `Answer Engine` перестаёт начинать ответ с `research.functionalSummary` или технического provenance sentence.
2. Configuration-вопросы перестают системно маппиться в flow-shaped answer.
3. Direct answer становится короче и точнее, а impact/plan перестают попадать в каждый ответ автоматически.
4. Partial evidence приводит к partial claim, а не к overstated conclusion.
5. Focused research запускается только when direct answer truly blocked.
6. LLM synthesis работает поверх claim-derived answer brief, а не поверх raw artifact dump.
7. Regression cases из `docs/state/test-scenarios.md` улучшаются без переписывания `Research`.

---

## 13. Известные ограничения

### 13.1 Этот слой не исправит ложный upstream факт

Если upstream evidence сам неверен, `Answer Intelligence V2` не гарантирует магического исправления.

### 13.2 Нужны additive internal structures

Без внутренних `Question Contract`, `Claim Pipeline`, `Evidence Audit`, `Validated Claim Set`, `Answer Brief V2` последний слой не сможет стать инженерным.

### 13.3 Придётся отказаться от части report-shaped удобства

Некоторые current multi-section ответы станут короче и менее “впечатляющими”, но инженерно честнее.

Это сознательная trade-off в пользу качества.

---

## 14. Итог

Следующий шаг развития answer pipeline — не новый большой модуль и не переписывание research.

Следующий шаг — сделать так, чтобы **последний слой сам понимал, какой ответ он имеет право утверждать**.

`Self-Validating Answer Pipeline` уже научил систему спрашивать:

- достаточно ли evidence вообще.

`Answer Intelligence V2` должен научить её спрашивать:

- **какой именно claim здесь доказан;**
- **какой claim нельзя делать;**
- **какие claims вообще не должны попадать в answer brief;**
- **что является answer-driving evidence, а что лишь соседним шумом;**
- **как ответить как инженер, а не как пересказчик артефактов.**
