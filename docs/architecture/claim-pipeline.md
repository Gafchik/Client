# Claim Pipeline

**Статус:** Proposed  
**Автор:** Principal Engineering Specification  
**Дата:** 2026-07-10  
**Версия:** 1.0.0  
**Зависимости:** [self-validating-answer-pipeline.md](/Users/evgenii/Desktop/client/docs/architecture/self-validating-answer-pipeline.md), [answer-intelligence-v2.md](/Users/evgenii/Desktop/client/docs/architecture/answer-intelligence-v2.md), [answer-engine.md](/Users/evgenii/Desktop/client/docs/modules/answer-engine.md), [research.md](/Users/evgenii/Desktop/client/docs/modules/research.md), [impact-analysis.md](/Users/evgenii/Desktop/client/docs/modules/impact-analysis.md), [context-builder.md](/Users/evgenii/Desktop/client/docs/modules/context-builder.md), [planner.md](/Users/evgenii/Desktop/client/docs/modules/planner.md)

---

## 1. Назначение

Этот документ предлагает ввести внутри последнего слоя answer pipeline промежуточную фундаментальную единицу: **Claim Pipeline**.

Цель:

- перестать строить answer напрямую из `Research` или даже напрямую из `Answer Brief`;
- сначала выделить отдельные утверждения (`Claims`);
- провалидировать каждое утверждение отдельно;
- пропускать в финальный ответ только те claims, которые действительно подтверждены;
- подготовить архитектуру к будущему multi-model debate на уровне утверждений, а не целого ответа.

Главный тезис документа:

**Claim Pipeline должен быть более фундаментальным внутренним слоем, чем Answer Brief.**

`Answer Brief` тогда становится:

- не первичной reasoning-сущностью;
- а presentation-oriented представлением поверх уже отобранных и проверенных claims.

---

## 2. Почему одного Answer Brief недостаточно

`Answer Brief` уже является шагом вперёд по сравнению с прямым `Research -> Answer`.

Но у него остаётся ограничение:

- brief всё ещё агрегирует картину на уровне ответа;
- он не делает отдельные утверждения first-class citizens;
- он плохо подходит для claim-level validation;
- он плохо подходит для future debate, dissent и cross-model verification.

На практике это означает:

- direct answer и supporting explanation ещё могут смешиваться;
- частично подтверждённый механизм может попасть в общий answer block как будто он уже доказан;
- validator может сказать “answer in general allowed”, но не ответить, какие конкретно предложения в нём допустимы.

Именно поэтому нужен слой ниже `Answer Brief`, но выше raw artifacts.

---

## 3. Основная идея Claim Pipeline

Новый внутренний принцип:

`Artifacts -> Candidate Claims -> Claim Validation -> Validated Claim Set -> Answer Brief -> Final Answer`

Это означает:

1. система получает `Research`, `Impact`, `Context`, `Plan`, `Validation`;
2. извлекает из них отдельные candidate claims;
3. связывает каждый claim с evidence;
4. проверяет claim по отдельности;
5. строит answer только из validated claim set.

---

## 4. Claim Pipeline и Answer Brief: что фундаментальнее

### 4.1 Почему Claim Pipeline фундаментальнее

Claim Pipeline ближе к инженерной истине, чем `Answer Brief`, потому что:

- claim можно проверить отдельно;
- claim можно подтвердить или отклонить отдельно;
- claim можно спорить между моделями отдельно;
- claim можно переиспользовать в разных answer modes;
- claim можно трассировать к конкретному evidence;
- claim можно хранить как auditable unit reasoning.

`Answer Brief` таких свойств в полной мере не имеет, потому что это уже:

- partially composed representation;
- answer-oriented aggregation;
- слой ближе к UX, чем к reasoning atomics.

### 4.2 Правильная иерархия

Рекомендуемая иерархия:

1. `Question Contract`
2. `Claim Pipeline`
3. `Answer Brief`
4. `Final Answer`

То есть:

- `Question Contract` определяет, какие типы claims вообще нужны;
- `Claim Pipeline` извлекает и валидирует их;
- `Answer Brief` упаковывает validated claims в answer-facing структуру;
- `Final Answer` превращает brief в человеческий текст.

### 4.3 Что это меняет концептуально

После этого:

- `Answer Brief` перестаёт быть местом, где рождается инженерная истина;
- `Answer Brief` становится местом, где validated truth готовится к выдаче пользователю.

---

## 5. Какие проблемы решает Claim Pipeline

### 5.1 Разделяет факты на самостоятельные единицы

Сейчас ответ часто строится из общего summary.  
Claim Pipeline заставляет систему работать через утверждения вроде:

- `Локаль читается из header X-Locale.`
- `При отсутствии header используется default locale.`
- `Locale устанавливается внутри LocaleMiddleware.`
- `Middleware подключён в bootstrap/app.php.`

Каждое из них можно проверить отдельно.

### 5.2 Устраняет overclaim-by-aggregation

Если один из claims не подтверждён, он:

- не должен автоматически попадать в final answer;
- может быть downgraded до caveat;
- может уйти в `unconfirmed` или `manual checks`.

### 5.3 Позволяет различать типы поддержки

Не все claims одинаковы.

Claim Pipeline позволяет явно различать:

- direct claim;
- supporting claim;
- inferred claim;
- rejected claim;
- competing claim.

### 5.4 Делает answer validation намного сильнее

Вместо вопроса:

- “в целом можно ли ответить?”

система получает вопросы:

- “какие claims подтверждены?”
- “какие claims подтверждены только косвенно?”
- “какие claims конфликтуют?”
- “какие claims нельзя включать в answer?”

### 5.5 Готовит базу для future debate

Multi-model debate на whole-answer уровне слишком грубый.

Гораздо полезнее, когда модели спорят на уровне:

- `Claim A подтверждён / не подтверждён`
- `Claim B требует caveat`
- `Claim C противоречит current evidence`

Это делает debate:

- дешевле;
- точнее;
- auditable;
- composable.

---

## 6. Как Claim Pipeline встраивается без смены общей архитектуры

Новый слой не меняет глобальную архитектуру.

Остаётся:

`Question -> Research -> Impact -> Context -> Evidence Validation -> Focused Research -> Answer Preparation -> Answer Engine`

Добавляется внутренняя детализация в зоне `Answer Preparation / Answer Engine`.

Целевая внутренняя схема:

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
Focused Research Loop
    ->
Question Contract
    ->
Claim Extraction
    ->
Claim Validation
    ->
Validated Claim Set
    ->
Answer Brief
    ->
Answer Engine
    ->
Final Answer
```

Ключевой принцип:

Claim Pipeline не становится новым top-level module.

Он является:

- internal reasoning layer;
- additive orchestration extension;
- частью последней мили answer quality path.

---

## 7. Где должен жить Claim Pipeline

Предпочтительное место:

- внутри answer-quality orchestration;
- рядом с `Answer Engine`;
- поверх уже существующего validation loop;
- без собственного ownership над `Research`, `Impact`, `Context`, `Plan`.

То есть Claim Pipeline должен жить:

- не как отдельный platform-wide domain owner;
- а как internal subsystem `Answer Preparation`.

Причины:

- он не владеет кодовой истиной;
- он не владеет graph;
- он не владеет knowledge;
- он не требует отдельной общей архитектуры хранения для MVP;
- он обслуживает только ответ и будущую claim-level validation ecosystem.

---

## 8. Новые сущности

Ниже перечислены рекомендуемые сущности Claim Pipeline.

### 8.1 Claim

`Claim` — атомарное инженерное утверждение, которое может быть отдельно:

- сформулировано;
- проверено;
- подтверждено;
- отклонено;
- оспорено;
- включено или не включено в ответ.

Минимальные поля:

- `claimId`
- `runId`
- `questionId` or `requestId`
- `claimType`
- `statement`
- `normalizedStatement`
- `scope`
- `intentRole`
- `supportLevel`
- `status`
- `confidence`
- `caveats[]`
- `evidenceRefs[]`
- `derivedFrom[]`

### 8.2 ClaimType

Рекомендуемые типы:

- `direct-answer`
- `mechanism`
- `location`
- `causality`
- `configuration`
- `impact`
- `risk`
- `plan-step`
- `limitation`
- `manual-check`

### 8.3 ClaimIntentRole

Роль claim относительно вопроса:

- `answer-driving`
- `supporting`
- `contextual`
- `competing`
- `rejected`

### 8.4 ClaimEvidence

`ClaimEvidence` — явная связь claim с evidence.

Минимальные поля:

- `claimEvidenceId`
- `claimId`
- `evidenceSourceType`
- `evidenceLabel`
- `filePath?`
- `reason`
- `origin`
- `supportKind`
- `weight`

### 8.5 ClaimSupportKind

Рекомендуемые значения:

- `direct`
- `supporting`
- `indirect`
- `negative`
- `conflicting`

### 8.6 ClaimStatus

Отдельный статус claim, а не всего ответа.

Рекомендуемые статусы:

- `candidate`
- `supported`
- `partially-supported`
- `unsupported`
- `conflicted`
- `deferred`
- `rejected`

### 8.7 ClaimValidator

`ClaimValidator` — внутренний слой, который валидирует отдельный claim.

Он должен отвечать:

- достаточно ли evidence именно для этого claim;
- есть ли conflict;
- claim direct или only inferred;
- можно ли включать claim в final answer;
- нужен ли caveat;
- нужен ли additional refinement.

### 8.8 ClaimValidationResult

Минимальные поля:

- `claimId`
- `status`
- `supportLevel`
- `confidence`
- `blockingGaps[]`
- `conflicts[]`
- `requiredCaveats[]`
- `refinementHints[]`
- `rationale`

### 8.9 ClaimSet

`ClaimSet` — набор claims, построенный под конкретный вопрос.

Он должен содержать:

- `answerDrivingClaims[]`
- `supportingClaims[]`
- `rejectedClaims[]`
- `competingClaims[]`
- `manualCheckClaims[]`

### 8.10 ValidatedClaimSet

Это уже gate-approved набор.

Из него строится `Answer Brief`.

Минимальные свойства:

- содержит только claims, разрешённые к downstream usage;
- отделяет supported claims от partial claims;
- хранит unresolved competition и required caveats;
- пригоден для deterministic answer и LLM answer одинаково.

---

## 9. Как формируются Claims

### 9.1 Источники claim extraction

Claims могут извлекаться из:

- `Research findings`
- `Research functional summary`
- `Research evidence`
- `Impact summary`
- `Impact risks`
- `Context highlights`
- `Plan steps`
- `Validation gaps / rationale / caveats`

Но Claim Pipeline не должен blindly mirror upstream text.

Он должен:

- нормализовать утверждения;
- разрезать summary на отдельные propositions;
- отбрасывать decorative narrative;
- отделять fact от interpretation.

### 9.2 Пример decomposition

Вместо одного summary:

- `Локаль выбирается через middleware, зависит от X-Locale и при отсутствии header берётся default locale.`

получаются claims:

1. `Локаль выбирается через LocaleMiddleware.`
2. `LocaleMiddleware читает входящий header X-Locale.`
3. `При отсутствии или невалидности header используется default locale.`
4. `Default locale берётся из fallback chain проекта.`
5. `Middleware подключён в bootstrap/app.php.`

Дальше каждый claim проверяется отдельно.

---

## 10. Claim Validation Model

### 10.1 Что валидируется

ClaimValidator должен проверять для каждого claim:

- есть ли direct evidence;
- есть ли supporting evidence;
- есть ли conflicting evidence;
- относится ли evidence именно к scope вопроса;
- не является ли claim overstated interpretation;
- не требует ли claim явного caveat.

### 10.2 Support levels

Рекомендуемые уровни:

- `strong`
- `moderate`
- `weak`
- `none`

### 10.3 Claim confidence

Confidence должен быть claim-level, а не answer-level.

Он строится из:

- strength of evidence;
- diversity of evidence origins;
- freshness;
- absence/presence of conflicts;
- directness относительно question contract.

### 10.4 Claim-level caveats

Важно, что caveat может относиться не ко всему answer, а только к одному claim.

Например:

- claim о location supported strongly;
- claim о causality supported only partially;
- значит location можно утверждать прямо, а causality только с caveat.

### 10.5 Claim-level stop rule

Если answer-driving claim не supported, а supporting claims supported, система не должна silently upgrade supporting picture into direct answer.

В этом случае:

- либо запускается refinement;
- либо direct answer маркируется как insufficient;
- либо answer становится partial.

---

## 11. Связь Claim Pipeline с Self-Validating Answer Pipeline

### 11.1 Current validator remains

Существующий validator не выбрасывается.

Он по-прежнему решает:

- готов ли pipeline в целом;
- нужен ли focused research;
- насколько evidence в целом sufficient.

### 11.2 New claim layer comes after global readiness

После global readiness gate:

- включается claim extraction;
- затем claim validation;
- затем answer assembly.

Иначе говоря:

`global evidence readiness` и `claim readiness` — разные уровни.

### 11.3 Why both layers are needed

Без global validator:

- answer-layer пришлось бы самому решать, нужен ли ещё research.

Без claim validator:

- answer-layer не знает, какие именно утверждения реально допустимы.

Оба слоя нужны, но для разных задач.

---

## 12. Claim Pipeline и Answer Brief

### 12.1 Новый порядок

Должно быть так:

`Validated Claim Set -> Answer Brief`

А не так:

`Artifacts -> Answer Brief -> attempt to validate answer`

### 12.2 Что должен содержать Answer Brief после Claim Pipeline

`Answer Brief` становится projection-слоем и должен содержать:

- `directAnswerClaim`
- `supportingClaims`
- `claimsWithCaveats`
- `rejectedClaims`
- `whereToLookClaims`
- `impactClaims`
- `planClaims`
- `materialUnknownClaims`
- `manualCheckClaims`

То есть Answer Brief уже не изобретает содержание, а only organizes approved claims.

### 12.3 Benefits

Это даёт:

- более чистый prompt для LLM;
- более надёжный deterministic fallback;
- меньший риск summary-driven hallucination;
- лучшую explainability.

---

## 13. Подготовка к future multi-model debate

### 13.1 Почему debate на уровне whole answer слабый

Если спорят два ответа целиком, трудно понять:

- где именно disagreement;
- какой кусок ответа слабый;
- какой кусок уже подтверждён.

Это дорого, шумно и плохо трассируется.

### 13.2 Why claim-level debate is better

Если спор идёт по отдельным claims, то разные модели могут:

- поддержать claim;
- отклонить claim;
- понизить support level;
- предложить caveat;
- указать, что нужен ещё один refinement step.

### 13.3 Debate roles

Будущие роли моделей:

- `Claim Extractor Model`
- `Claim Validator Model`
- `Claim Challenger Model`
- `Claim Arbiter Model`
- `Final Answer Model`

При этом не обязательно использовать все сразу.

### 13.4 Debate example

Например, для claim:

- `RollbackDraft запрещён после rollback_to_generated из-за guard-флага was_been_rollback_to_generated.`

одна модель может сказать:

- `supported`

другая:

- `partially-supported, because controller guard found but full historical derivation of flag not fully closed`

арбитр:

- `include claim with caveat`

Это намного полезнее, чем debate на уровне целого paragraph.

### 13.5 Operational benefit

Claim-level debate:

- дешевле по токенам;
- легче кэшируется;
- легче дебажится;
- лучше подходит для partial reuse между похожими вопросами.

---

## 14. Эволюционный план внедрения

### Phase 1 — Internal Claim Model

Добавить internal claim structures без изменения публичного API.

Минимум:

- `Claim`
- `ClaimEvidence`
- `ClaimValidationResult`
- `ValidatedClaimSet`

### Phase 2 — Claim Extraction from current artifacts

Извлекать claims из already existing:

- `Research`
- `Impact`
- `Plan`
- `Validation`

Без смены upstream modules.

### Phase 3 — Claim Validation

Добавить claim-level validator:

- heuristic first;
- затем optional model-assisted.

### Phase 4 — Answer Brief from ValidatedClaimSet

Перевести `Answer Brief` на projection из claims.

### Phase 5 — Claim-aware final synthesis

LLM и deterministic fallback получают уже только:

- validated claims;
- caveats;
- rejected claims;
- manual checks.

### Phase 6 — Debate-ready claim interfaces

Добавить internal extensibility для:

- multiple validator opinions;
- challenger/arbiter roles;
- claim-level dissent.

---

## 15. Что не меняется

Не меняются:

- общая архитектура pipeline;
- ownership `Research`, `Impact`, `Context`, `Planner`;
- внешний `AnswerPackage` как пользовательский артефакт;
- UX chat-first;
- обязательность global validation layer.

Claim Pipeline — additive refinement, а не disruptive rewrite.

---

## 16. Ограничения

### 16.1 Не исправляет плохой upstream discovery

Если нужная зона проекта не найдена вообще, Claim Pipeline не создаст truth из nothing.

### 16.2 Добавляет внутреннюю сложность

Слой claim reasoning делает answer path сложнее.

Это оправдано только потому, что:

- complexity остаётся внутренней;
- внешний UX не усложняется;
- benefit напрямую бьёт по качеству ответа.

### 16.3 Не стоит превращать claims в новый public API слишком рано

На этом этапе claims должны оставаться internal architectural unit.

Публичный контракт можно обсуждать позже, когда:

- структура стабилизируется;
- появятся debate workflows;
- будет ясно, какие поля реально полезны outside the subsystem.

---

## 17. Итог

Идея Claim Pipeline действительно усиливает архитектуру.

Рекомендуемый вывод:

- **да, Claim Pipeline стоит вводить;**
- **да, он должен быть более фундаментальным internal reasoning layer, чем Answer Brief;**
- **да, он встраивается в текущий Self-Validating Answer Pipeline без изменения общей архитектуры;**
- **да, он лучше готовит систему к future multi-model debate, чем brief-first подход.**

Правильная эволюционная модель выглядит так:

`Validated artifacts -> Claims -> Validated Claim Set -> Answer Brief -> Final Answer`

Именно это переводит платформу из режима:

- `мы красиво пересказали исследование`

в режим:

- `мы отдельно доказали, какие утверждения имеем право включить в ответ`.

