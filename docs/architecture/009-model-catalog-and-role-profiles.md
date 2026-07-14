# 009 — Model Catalog и Role Profiles

**Статус:** Proposed (Reference Catalog — операционный документ поверх целевой архитектуры)
**Автор:** Principal Architecture Specification
**Дата:** 2026-07-15
**Версия:** 1.2.0
**Зависимости:** [008-next-generation-architecture.md](./008-next-generation-architecture.md) (разделы 11, 13, 14, 15), [provider-system.md](/Users/evgenii/Desktop/client/docs/modules/provider-system.md)

---

## Оглавление

1. [Назначение и статус документа](#1-назначение-и-статус-документа)
2. [Модель множителя и cost-unit](#2-модель-множителя-и-cost-unit)
3. [Полный каталог доступных моделей](#3-полный-каталог-доступных-моделей)
4. [Классификация моделей по ценовым band](#4-классификация-моделей-по-ценовым-band)
5. [Роли, требующие LLM (напоминание из 008)](#5-роли-требующие-llm-напоминание-из-008)
6. [Принципы подбора модели на роль](#6-принципы-подбора-модели-на-роль)
7. [Профиль 1 — Economy](#7-профиль-1--economy)
8. [Профиль 2 — Balanced](#8-профиль-2--balanced)
9. [Профиль 3 — Premium](#9-профиль-3--premium)
10. [Сводная сравнительная таблица профилей](#10-сводная-сравнительная-таблица-профилей)
11. [Матрица адаптивной эскалации между профилями](#11-матрица-адаптивной-эскалации-между-профилями)
12. [Особые модели и предостережения](#12-особые-модели-и-предостережения)
13. [Что не входит в этот документ](#13-что-не-входит-в-этот-документ)

---

## 1. Назначение и статус документа

Этот документ фиксирует:

- полный каталог доступных LLM-моделей и их множителей стоимости (данные предоставлены как operational input, не архитектурное решение);
- три готовых **Role Profile** — Economy / Balanced / Premium — с конкретным назначением модели на каждую роль, определённую в `008-next-generation-architecture.md`, раздел 11.3.

Это **operational reference catalog**, а не архитектурная спецификация. Он обновляется гораздо чаще, чем `008-next-generation-architecture.md`: список моделей, множители и конкретные назначения на роли меняются при появлении новых моделей, пересмотре цен провайдером или по результатам shadow-бенчмаркинга (см. `008`, раздел 3, идея №4). Архитектурные принципы распределения (раздел 6 этого документа) должны оставаться стабильными дольше, чем конкретные имена моделей.

Документ не содержит кода и не предлагает реализацию — это справочник и три готовых конфигурации выбора моделей.

---

## 2. Модель множителя и cost-unit

Напоминание контракта из `008`, раздел 14.1:

```
cost_unit = raw_tokens × provider_multiplier
```

Множитель, указанный в каталоге ниже, — это и есть `provider_multiplier`. Все профили в этом документе сравниваются **только** в cost-unit, не в сырых токенах: модель с множителем `12.0x` в 24 раза дороже на одинаковый объём токенов, чем модель с множителем `0.5x`, — сравнение "число токенов" без учёта множителя архитектурно запрещено (`008`, принцип 13).

Для моделей с раздельными режимами (`Flex` / `Priority`) в каталоге указан базовый множитель; `Flex` — пониженный приоритет обработки за меньший множитель (кандидат для фонового L2-обогащения), `Priority` — повышенный множитель за гарантированную латентность (кандидат для интерактивных ролей при пиковой нагрузке).

### 2.1 Практический дневной бюджет для текущего проекта

Текущий операционный ввод:

- дневной лимит провайдера: **51M raw tokens/day**;
- целевой режим эксплуатации: использовать лимит почти полностью, то есть держать систему в диапазоне **до ~50M raw tokens/day** без вынужденного постоянного throttling.

Отсюда следует практический верхний предел на **средний допустимый множитель непрерывного профиля**:

```text
max_average_multiplier_for_near-full-continuous_mode = 51 / 50 = 1.02x
```

Практический вывод:

- если средний профильный множитель **около 1.0x или ниже**, такой профиль можно считать совместимым с почти непрерывной работой "на весь бюджет";
- всё, что заметно выше `1.0x`, уже не годится как постоянный дефолтный профиль под цель "гулять на все 50M";
- Advanced и Frontier band в таком режиме автоматически становятся **burst-only**, а не базовым рабочим слоем;
- даже часть Standard band теперь допустима только выборочно, по ролям и по доле трафика, а не как тотальный default.

---

## 3. Полный каталог доступных моделей

### 3.1 Anthropic

| Модель | ID | Множитель |
|---|---|---|
| Claude Fable 5 | `anthropic/claude-fable-5` | 24.0x |
| Claude Fable 5 Pxpipe | `anthropic/claude-fable-5-pxpipe` | 24.0x |
| Claude Haiku 4.5 | `anthropic/claude-haiku-4.5` | 1.3x |
| Claude Sonnet 5 | `anthropic/claude-sonnet-5` | 4.0x |
| Claude Sonnet 4.5 | `anthropic/claude-sonnet-4.5` | 6.0x |
| Claude Sonnet 4.6 | `anthropic/claude-sonnet-4.6` | 6.0x |
| Claude Opus 4.5 | `anthropic/claude-opus-4.5` | 12.0x |
| Claude Opus 4.6 | `anthropic/claude-opus-4.6` | 12.0x |
| Claude Opus 4.7 | `anthropic/claude-opus-4.7` | 12.0x |
| Claude Opus 4.8 | `anthropic/claude-opus-4.8` | 12.0x |

### 3.2 DeepSeek

| Модель | ID | Множитель |
|---|---|---|
| DeepSeek V3.2 | `deepseek/deepseek-v3.2` | 0.5x |
| DeepSeek V4 Flash | `deepseek/deepseek-v4-flash` | 0.5x |
| DeepSeek V4 Pro | `deepseek/deepseek-v4-pro` | 0.7x |
| DeepSeek Chat V3.1 | `deepseek/deepseek-chat-v3.1` | 0.8x |
| DeepSeek R1 0528 | `deepseek/deepseek-r1-0528` | 0.8x |
| DeepSeek V3.1 | `deepseek/deepseek-v3.1` | 0.8x |
| DeepSeek V3.1 Terminus | `deepseek/deepseek-v3.1-terminus` | 0.8x |

### 3.3 Google

| Модель | ID | Множитель |
|---|---|---|
| Gemini 3.1 Flash Lite | `google/gemini-3.1-flash-lite` | 0.5x (Flex 0.5x / Priority 1.8x) |
| Gemma 4 26b A4b It | `google/gemma-4-26b-a4b-it` | 0.7x |
| Gemma 4 31b It | `google/gemma-4-31b-it` | 0.7x |
| Gemini 3 Flash Preview | `google/gemini-3-flash-preview` | 1.5x (Flex 0.5x / Priority 1.8x) |
| Gemini 3.5 Flash | `google/gemini-3.5-flash` | 3.0x (Flex 0.5x / Priority 1.8x) |
| Gemini 2.5 Pro | `google/gemini-2.5-pro` | 4.0x (Flex 0.5x / Priority 1.8x) |
| Gemini 3.1 Pro Preview | `google/gemini-3.1-pro-preview` | 5.0x (Flex 0.5x / Priority 1.8x) |
| Gemini 3.1 Flash Lite Image *(мультимодальная)* | `google/gemini-3.1-flash-lite-image` | 8.8x |
| Gemini 3 Pro Image *(мультимодальная)* | `google/gemini-3-pro-image` | 25.0x |
| Gemini Omni Flash Preview *(мультимодальная)* | `google/gemini-omni-flash-preview` | 22.5x |
| Gemini 3.1 Flash Image Preview *(мультимодальная)* | `google/gemini-3.1-flash-image-preview` | 17.5x |

### 3.4 Meta

| Модель | ID | Множитель |
|---|---|---|
| Muse Spark 1.1 | `meta/muse-spark-1.1` | 1.5x |

### 3.5 MiniMax

| Модель | ID | Множитель |
|---|---|---|
| MiniMax M2.5 | `minimax/minimax-m2.5` | 1.0x |
| MiniMax M2.7 | `minimax/minimax-m2.7` | 1.0x |
| MiniMax M3 | `minimax/minimax-m3` | 1.0x |

### 3.6 Moonshot

| Модель | ID | Множитель |
|---|---|---|
| Kimi K2.5 | `moonshotai/kimi-k2.5` | 1.0x |
| Kimi K2.6 | `moonshotai/kimi-k2.6` | 1.5x |
| Kimi K2.7 Code | `moonshotai/kimi-k2.7-code` | 1.6x |
| Kimi K2.7 Code Highspeed | `moonshotai/kimi-k2.7-code-highspeed` | 3.3x |

### 3.7 NVIDIA

| Модель | ID | Множитель |
|---|---|---|
| Nemotron 3 Ultra | `nvidia/nemotron-3-ultra` | 0.0x *(подтверждено — постоянно бесплатная модель у провайдера, не промо-ставка; см. раздел 12)* |

### 3.8 OpenAI

| Модель | ID | Множитель |
|---|---|---|
| GPT-5.4 Nano | `openai/gpt-5.4-nano` | 0.5x |
| GPT-5.4 Mini | `openai/gpt-5.4-mini` | 0.8x |
| GPT-5 | `openai/gpt-5` | 1.8x |
| GPT-5 Chat | `openai/gpt-5-chat` | 1.8x |
| GPT-5.6 Luna | `openai/gpt-5.6-luna` | 1.5x |
| GPT-5.2 | `openai/gpt-5.2` | 2.0x |
| GPT-5.2 Chat | `openai/gpt-5.2-chat` | 2.0x |
| GPT-5.3 Chat | `openai/gpt-5.3-chat` | 2.0x |
| GPT-5.3 Codex | `openai/gpt-5.3-codex` | 2.0x |
| GPT-5.4 | `openai/gpt-5.4` | 2.0x |
| GPT-5.6 Terra | `openai/gpt-5.6-terra` | 2.8x |
| GPT-5.5 | `openai/gpt-5.5` | 5.5x |
| GPT-5.6 Sol | `openai/gpt-5.6-sol` | 5.5x |
| GPT Image 2 *(мультимодальная)* | `openai/gpt-image-2` | 27.5x (Flex 0.5x / Priority 1.8x) |
| GPT Image 1.5 *(мультимодальная)* | `openai/gpt-image-1.5` | 30.0x |

### 3.9 Perplexity *(встроенный web/document search)*

| Модель | ID | Множитель |
|---|---|---|
| Sonar | `perplexity/sonar` | 1.3x |
| Sonar Reasoning Pro | `perplexity/sonar-reasoning-pro` | 3.3x |
| Sonar Pro | `perplexity/sonar-pro` | 4.8x |

### 3.10 Qwen

| Модель | ID | Множитель |
|---|---|---|
| Qwen3.7 Plus | `qwen/qwen3.7-plus` | 1.0x |
| Qwen3.6 Plus | `qwen/qwen3.6-plus` | 1.5x |
| Qwen3.7 Max | `qwen/qwen3.7-max` | 1.8x |
| Qwen 3.6 Max | `qwen/qwen-3.6-max` | 2.0x |

### 3.11 Sakana AI

| Модель | ID | Множитель |
|---|---|---|
| Fugu Ultra | `sakana/fugu-ultra` | 15.0x |

### 3.12 Xiaomi

| Модель | ID | Множитель |
|---|---|---|
| Mimo V2.5 | `xiaomi/mimo-v2.5` | 0.5x |
| Mimo V2.5 Pro | `xiaomi/mimo-v2.5-pro` | 0.7x |
| Mimo V2 Pro | `xiaomi/mimo-v2-pro` | 1.8x |

### 3.13 Z-AI

| Модель | ID | Множитель |
|---|---|---|
| Glm 4.6 | `z-ai/glm-4.6` | 1.5x |
| Glm 4.7 | `z-ai/glm-4.7` | 1.5x |
| Glm 5 | `z-ai/glm-5` | 2.0x |
| Glm 5.1 | `z-ai/glm-5.1` | 2.0x |
| Glm 5.2 | `z-ai/glm-5.2` | 2.0x |
| Glm 5.2 Fast | `z-ai/glm-5.2-fast` | 2.5x |

### 3.14 xAI

| Модель | ID | Множитель |
|---|---|---|
| Grok 4.1 Fast | `x-ai/grok-4.1-fast` | 0.7x |
| Grok 4.20 | `x-ai/grok-4.20` | 1.5x |
| Grok 4.3 | `x-ai/grok-4.3` | 1.5x |
| Grok 4.5 | `x-ai/grok-4.5` | 2.5x |
| Grok Build 0.1 | `x-ai/grok-build-0.1` | 1.3x |

---

## 4. Классификация моделей по ценовым band

Для удобства построения профилей вводятся четыре band (границы — округлённые ориентиры, не жёсткие архитектурные константы):

| Band | Диапазон множителя | Назначение по умолчанию |
|---|---|---|
| **Micro** | 0.0x – 0.8x | Router fallback, батчевое L2-обогащение низкого приоритета, Clarifying Agent, интерпретация тестовых фейлов |
| **Standard** | 1.0x – 2.0x | Основной Answer Synthesizer, Evidence Validator, Reviewer, Semantic Enricher для приоритетных кластеров |
| **Advanced** | 2.5x – 6.0x | Planner, Developer Agent по умолчанию, эскалация Synthesizer/Validator при низком confidence |
| **Frontier** | ≥ 6.0x (текст) | Эскалация только для diagnostic/high-impact/change-task случаев, редкие вызовы Planner/Developer на сложных легаси-модулях |

Мультимодальные модели (image-генерация: Gemini *Image, GPT Image, вероятно Gemini Omni Flash Preview) в band не включены — они вне scope текущих текстовых ролей (`008`, раздел 21) и относятся к будущему `provider-system.md` разделу 24.1 (Multimodal Providers).

С точки зрения именно текущего бюджетного ограничения (`51M/day`) и цели работать почти на весь лимит (`~50M/day`):

- **continuous-safe** — только профили с усреднённым множителем около `1.0x` или ниже;
- **borderline** — `1.0x–1.3x`, допустимо только если дорогие роли включаются редко;
- **burst-only** — всё, что стабильно уводит средний профиль выше `1.3x`.

---

## 5. Роли, требующие LLM (напоминание из 008)

Из полной таблицы ролей `008`, раздел 11.3, назначения модели требуют только:

| Роль | Band по умолчанию | Кросс-вендорное требование |
|---|---|---|
| Intent/Question Router (fallback на неоднозначность) | Micro | нет |
| Semantic Enricher | Micro/Standard | нет (но желательна ротация вендора для drift-detection) |
| Evidence Validator/Critic | Standard/Advanced | **да** — вендор отличается от Answer Synthesizer |
| Answer Synthesizer | Standard, эскалация до Advanced/Frontier | нет |
| Clarifying Agent | Micro | нет |
| Planner | Advanced/Frontier | нет |
| Developer Agent | Advanced/Frontier | нет |
| Reviewer Agent | Standard/Advanced | **да** — вендор отличается от Developer Agent |
| Test-failure interpreter | Micro | нет |

Роли `Structural Analyst`, `Cost Governor` — не-LLM, моделей не требуют (напоминание из `008`).

### 5.1 Реализовано (2026-07-15): Team — конкретное воплощение части ролей выше

В отличие от остального документа (Proposed reference catalog, ролевая матрица без реального кода), три роли из таблицы выше теперь реально реализованы как явная, персистентная сущность **Team** (`apps/api/src/team-store.ts`, `packages/agentic-research`, `docs/modules/provider-system.md` §10.6):

- **Researcher** — по сути объединяет то, что здесь описано как Answer Synthesizer + значительную часть Research/Planner: ведёт agentic tool-loop исследование и пишет финальный ответ.
- **Critic** — прямая реализация Evidence Validator/Critic, кросс-вендорное требование (принцип 1 ниже) соблюдается по конструкции: дефолтная Team использует `google/gemini-3.1-flash-lite` как Critic при `openai/gpt-5.4-mini` как Researcher.
- **Observer** — новая роль, не описанная в таблице выше: медленный фоновый обход проекта для накопления персистентного графа бизнес-логики (`business_graph_entries`), намеренно не участвует в интерактивном пути. Ближе всего по духу к Semantic Enricher (`008`, §7 L2), но с более простой, директорийной единицей работы, а не graph-cluster.

Это не заменяет Router/Clarifying Agent/Planner/Developer Agent/Reviewer Agent из таблицы — они остаются нереализованными на момент записи.

---

## 6. Принципы подбора модели на роль

1. **Кросс-вендорность для верификационных пар обязательна.** Validator ≠ вендор Synthesizer; Reviewer ≠ вендор Developer. Это снижает коррелированные ошибки одного семейства моделей (`008`, принцип из раздела 11.3/15.5).
2. **Band, а не конкретная модель, — это архитектурное решение.** Конкретная модель внутри band может быть заменена при появлении новой версии без пересмотра профиля.
3. **Эскалация происходит по сигналу, не по умолчанию.** Advanced/Frontier band для Synthesizer/Validator активируется только при низком confidence входных фактов, обнаруженном противоречии между двумя дешёвыми оценками, или явном diagnostic/high-impact типе вопроса (`008`, раздел 11.4).
4. **Clarifying Agent и Router остаются в Micro band даже в Premium-профиле.** Короткий уточняющий вопрос не требует дорогой модели независимо от общего профиля — экономия здесь не снижает качество продукта.
5. **Developer Agent всегда работает на моделях, специализированных или проверенных на code-задачах**, где такая маркировка у вендора есть (`Codex`, `Code`, `Coder`-варианты), при прочих равных предпочтительнее generic chat-модели той же band.
6. **Поисковые модели (Perplexity Sonar-линейка)** рассматриваются отдельно — они не заменяют Answer Synthesizer, а являются кандидатом на будущую `search`-capability (внешняя документация/web) для L2/Focused Research, когда эта возможность будет подключена (см. `provider-system.md`, раздел 13).

---

## 7. Профиль 1 — Economy

**Назначение:** максимальная экономия cost-unit; используется по умолчанию для массовых, низкорисковых операций и на проектах/организациях с жёстким дневным лимитом. Там, где это не противоречит требованию кросс-вендорности (раздел 6, принцип 1), профиль использует **Nemotron 3 Ultra (0.0x, подтверждённо бесплатная модель)** как предпочтительный дефолт для высокообъёмных ролей — это не просто "дешёвая модель", а нулевая стоимость на самых частых вызовах в системе.

**Budget status для текущего лимита:** **continuous-safe** даже для near-full usage режима.

| Роль | Модель | ID | Множитель | Обоснование |
|---|---|---|---|---|
| Router (fallback) | Nemotron 3 Ultra | `nvidia/nemotron-3-ultra` | 0.0x | Самая частая роль в системе (каждый вопрос); бесплатная модель даёт максимальную экономию именно там, где объём вызовов наибольший |
| Semantic Enricher (фон, батч) | Nemotron 3 Ultra | `nvidia/nemotron-3-ultra` | 0.0x | Фоновое обогащение не интерактивно и идёт большими батчами — нулевая цена снимает основной объём cost-unit нагрузки этой роли |
| Clarifying Agent | Nemotron 3 Ultra | `nvidia/nemotron-3-ultra` | 0.0x | Короткие уточняющие вопросы не требуют платной модели вообще |
| Answer Synthesizer (default) | DeepSeek Chat V3.1 | `deepseek/deepseek-chat-v3.1` | 0.8x | Разговорный формат ответа при сохранении низкой стоимости; остаётся платной моделью для основного пользовательского ответа до отдельного shadow-бенчмаркинга Nemotron на этой роли |
| Evidence Validator/Critic | Gemini 3.1 Flash Lite | `google/gemini-3.1-flash-lite` | 0.5x | Другой вендор, чем Synthesizer (Google vs DeepSeek), минимальная цена; кросс-вендорное требование не позволяет здесь просто взять Nemotron, если Synthesizer тоже перейдёт на него в будущем |
| Planner | Qwen3.7 Plus | `qwen/qwen3.7-plus` | 1.0x | Самый дешёвый платный вариант с приемлемым reasoning для простых структурных планов |
| Developer Agent | Kimi K2.7 Code | `moonshotai/kimi-k2.7-code` | 1.6x | Единственная в Micro/нижнем Standard band модель с явной code-специализацией |
| Reviewer Agent | MiniMax M3 | `minimax/minimax-m3` | 1.0x | Другой вендор, чем Developer (MiniMax vs Moonshot) |
| Test-failure interpreter | Nemotron 3 Ultra | `nvidia/nemotron-3-ultra` | 0.0x | Интерпретация структурированного вывода тестов/линтера — рутинная, высокообъёмная задача, не требующая платной модели |

**Профильное предупреждение:** Planner и Developer Agent в Economy-профиле работают в band Micro/нижний Standard — рекомендуется только для низко-рискованных, хорошо изолированных задач. Для diagnostic/high-impact/change-задач Economy-профиль не рекомендуется как единственный (см. раздел 11 — матрица эскалации). Отдельное предупреждение: нулевая цена Nemotron 3 Ultra не означает автоматически приемлемое качество для каждой роли — назначения выше (Router/Enricher/Clarifying/Test-interpreter) выбраны как задачи с низкой ценой ошибки и высокой терпимостью к более слабой модели; распространение Nemotron на Answer Synthesizer/Planner/Developer требует отдельного shadow-бенчмаркинга, а не автоматического переноса по аналогии.

---

## 8. Профиль 2 — Balanced

**Назначение:** продовый профиль по умолчанию для большинства пользовательских сценариев — баланс качества ответа и cost-unit.

**Budget status для текущего лимита:** **burst-only как тотальный дефолт**. Его можно использовать только как частичную эскалацию поверх Economy-like базы, но не как постоянный профиль при цели выйти почти на `50M raw/day`.

| Роль | Модель | ID | Множитель | Обоснование |
|---|---|---|---|---|
| Router (fallback) | Claude Haiku 4.5 | `anthropic/claude-haiku-4.5` | 1.3x | Быстрая, надёжная классификация при сохранении низкой цены |
| Semantic Enricher (приоритетные кластеры) | Gemini 3.5 Flash | `google/gemini-3.5-flash` | 3.0x | Достаточная глубина для domain-выводов, приемлемая цена для батч-режима с приоритетом |
| Clarifying Agent | Claude Haiku 4.5 | `anthropic/claude-haiku-4.5` | 1.3x | Тот же принцип, что и в Economy — не эскалируется без необходимости |
| Answer Synthesizer (default) | Claude Sonnet 5 | `anthropic/claude-sonnet-5` | 4.0x | Сильный баланс качества объяснения и цены среди Advanced band |
| Evidence Validator/Critic | GPT-5.2 | `openai/gpt-5.2` | 2.0x | Другой вендор (OpenAI vs Anthropic), сопоставимый уровень reasoning дешевле Synthesizer |
| Planner | GPT-5.4 | `openai/gpt-5.4` | 2.0x | Устойчивое structured-output планирование по разумной цене |
| Developer Agent | GPT-5.3 Codex | `openai/gpt-5.3-codex` | 2.0x | Явная code-специализация (Codex-линейка) в Advanced band |
| Reviewer Agent | Grok 4.3 | `x-ai/grok-4.3` | 1.5x | Другой вендор, чем Developer (xAI vs OpenAI), независимая проверка |
| Test-failure interpreter | Claude Haiku 4.5 | `anthropic/claude-haiku-4.5` | 1.3x | Достаточно для интерпретации фейлов, не требует Sonnet-уровня |

**Профильное примечание:** этот профиль рекомендуется как **дефолтный** для инсталляции — обеспечивает кросс-вендорность на обеих критичных парах (Validator/Synthesizer и Reviewer/Developer) при умеренном общем множителе.

---

## 9. Профиль 3 — Premium

**Назначение:** максимальное качество для diagnostic-вопросов с низким confidence, high-impact change-задач и сложных legacy-модулей. Используется по эскалации, не как профиль по умолчанию (см. `008`, принцип адаптивной эскалации, раздел 11.4).

**Budget status для текущего лимита:** **strict burst-only**. Непригоден как постоянный слой при стратегии "использовать почти весь суточный лимит".

| Роль | Модель | ID | Множитель | Обоснование |
|---|---|---|---|---|
| Router (fallback) | Claude Haiku 4.5 | `anthropic/claude-haiku-4.5` | 1.3x | **Намеренно не эскалируется** — классификация intent не выигрывает от Frontier band |
| Semantic Enricher (критичные кластеры) | Claude Sonnet 5 | `anthropic/claude-sonnet-5` | 4.0x | Более глубокий domain-вывод для кластеров с высокой centrality |
| Clarifying Agent | Claude Haiku 4.5 | `anthropic/claude-haiku-4.5` | 1.3x | **Намеренно не эскалируется** — короткий уточняющий вопрос остаётся дешёвым даже в Premium |
| Answer Synthesizer (эскалированный diagnostic/high-impact) | Claude Opus 4.5 | `anthropic/claude-opus-4.5` | 12.0x | Максимальная глубина рассуждения для конкурирующих гипотез в diagnostic-ответах |
| Evidence Validator/Critic | GPT-5.5 | `openai/gpt-5.5` | 5.5x | Другой вендор, чем Synthesizer (OpenAI vs Anthropic), сопоставимый Frontier-уровень |
| Planner | Claude Opus 4.5 | `anthropic/claude-opus-4.5` | 12.0x | Максимальное качество декомпозиции для сложных/рискованных change-задач |
| Developer Agent | GPT-5.6 Sol | `openai/gpt-5.6-sol` | 5.5x | Сильная code-генерация в Frontier band без выхода на самый дорогой tier (Opus) без необходимости |
| Reviewer Agent | Gemini 3.1 Pro Preview | `google/gemini-3.1-pro-preview` | 5.0x | Третий независимый вендор (Google), максимальная независимость проверки от Developer (OpenAI) и от Planner (Anthropic) |
| Test-failure interpreter | Claude Sonnet 5 | `anthropic/claude-sonnet-5` | 4.0x | Более глубокая интерпретация сложных многофайловых тестовых фейлов |

**Профильное примечание:** Premium-профиль реализует принцип "эскалация точечная, а не тотальная" (`008`, раздел 11.4) — Router и Clarifying Agent остаются в Micro band даже здесь. Developer Agent намеренно не назначен на Claude Opus по умолчанию — эскалация до Opus для Developer Agent должна происходить как отдельный, ещё более узкий уровень эскалации внутри Premium-профиля, только для наиболее сложных/рискованных шагов плана (см. раздел 11).

---

## 10. Сводная сравнительная таблица профилей

| Роль | Economy | Balanced | Premium |
|---|---|---|---|
| Router (fallback) | Nemotron 3 Ultra (0.0x) | Claude Haiku 4.5 (1.3x) | Claude Haiku 4.5 (1.3x) |
| Semantic Enricher | Nemotron 3 Ultra (0.0x) | Gemini 3.5 Flash (3.0x) | Claude Sonnet 5 (4.0x) |
| Clarifying Agent | Nemotron 3 Ultra (0.0x) | Claude Haiku 4.5 (1.3x) | Claude Haiku 4.5 (1.3x) |
| Answer Synthesizer | DeepSeek Chat V3.1 (0.8x) | Claude Sonnet 5 (4.0x) | Claude Opus 4.5 (12.0x) |
| Evidence Validator/Critic | Gemini 3.1 Flash Lite (0.5x) | GPT-5.2 (2.0x) | GPT-5.5 (5.5x) |
| Planner | Qwen3.7 Plus (1.0x) | GPT-5.4 (2.0x) | Claude Opus 4.5 (12.0x) |
| Developer Agent | Kimi K2.7 Code (1.6x) | GPT-5.3 Codex (2.0x) | GPT-5.6 Sol (5.5x) |
| Reviewer Agent | MiniMax M3 (1.0x) | Grok 4.3 (1.5x) | Gemini 3.1 Pro Preview (5.0x) |
| Test-failure interpreter | Nemotron 3 Ultra (0.0x) | Claude Haiku 4.5 (1.3x) | Claude Sonnet 5 (4.0x) |
| **Средний множитель по профилю** | **≈ 0.36x** | **≈ 2.2x** | **≈ 6.3x** |
| **Отношение к Economy** | 1× (базис) | ≈ 6× дороже | ≈ 17.5× дороже |
| **Совместимость с near-full 50M/day** | Да | Нет как дефолт | Нет |

Средний множитель — простое арифметическое среднее по девяти ролям, приведено только для сравнения порядка величины между профилями, не для расчёта фактического бюджета (реальный расход зависит от фактического распределения вызовов по ролям, которое сильно неравномерно — см. `008`, раздел 14.3).

---

## 11. Матрица адаптивной эскалации между профилями

Профили не являются взаимоисключающими глобальными режимами инсталляции — это **три готовых набора**, между которыми Cost Governor/L6 Orchestrator переключается **по роли и по сигналу**, а не переключает всю систему целиком (`008`, раздел 11.4, принцип адаптивной эскалации).

| Сигнал | Действие |
|---|---|
| Вопрос классифицирован как existence/location с высоким confidence фактов из Memory | Answer Synthesizer — Economy band, LLM может не понадобиться вовсе (прямой ответ из L3) |
| Confidence фактов средний, вопрос flow/configuration | Answer Synthesizer/Validator — Balanced |
| Вопрос diagnostic с конкурирующими гипотезами, или confidence ниже порога | Answer Synthesizer/Validator — эскалация до Premium |
| Расхождение между двумя независимыми Balanced-оценками (Validator vs Synthesizer) | Автоматическая эскалация конкретно этого вызова до Premium, остальной pipeline остаётся Balanced |
| Change-задача с широким blast radius (Impact Report указывает много affected files/high risk) | Planner и Developer Agent — Premium, Router/Clarifying остаются Micro band независимо от эскалации |
| Явный дневной/проектный лимит cost-unit приближается к 80–90% | Принудительное понижение всех ролей на один профиль вниз (Premium→Balanced→Economy), кроме уже начатых Frontier-вызовов текущего run |
| Дневной лимит достигнут (100%) | Hard stop согласно `008`, раздел 14.2 — новые LLM-вызовы не принимаются независимо от профиля |

---

## 12. Особые модели и предостережения

- **Nemotron 3 Ultra (0.0x)** — подтверждено: это постоянно бесплатная модель у провайдера (не промо-ставка и не временная акция). Это меняет её роль в архитектуре: она становится **предпочтительным дефолтом** для высокообъёмных и невысокорисковых ролей в Economy-профиле (Router, фоновый Semantic Enricher, Clarifying Agent, Test-failure interpreter — см. раздел 7), а не просто "ещё одной дешёвой опцией". Для ролей с более высокими ставками (Planner, Developer Agent, Answer Synthesizer в diagnostic-сценариях) она остаётся кандидатом, но требует shadow-бенчмаркинга (`008`, раздел 3, идея №4) перед назначением, так как нулевая цена не гарантирует качество, сопоставимое с платными моделями того же класса.
- **Claude Fable 5 / Claude Fable 5 Pxpipe (24.0x)** — заведомо не совместимы с near-full непрерывным режимом; допустимы только как ручная, редчайшая эскалация на штучных high-stakes задачах.
- **Grok Build 0.1 (1.3x)** — после уточнения множителя становится валидным кандидатом на отдельные low-mid roles, но уже не continuous-safe как массовый дефолт при цели держаться около `50M/day`.
- **Мультимодальные/image-модели** (`Gemini 3 Pro Image`, `Gemini 3.1 Flash Image Preview`, `Gemini 3.1 Flash Lite Image`, `Gemini Omni Flash Preview`, `GPT Image 1.5`, `GPT Image 2`) — не назначаются ни на одну текущую роль; зарезервированы для будущей multimodal-capability (`008`, раздел 21; `provider-system.md`, раздел 24.1).
- **Sakana Fugu Ultra (15.0x)** — самый дорогой текстовый вариант в каталоге; не включён ни в один профиль по умолчанию; кандидат для точечной, штучной эскалации отдельных Frontier-вызовов Planner/Developer на самых сложных задачах — решение о включении требует отдельной оценки качества, не принимается этим документом автоматически.
- **Perplexity Sonar-линейка** — не назначена ни на одну роль, так как текущая архитектура (`008`) не подключает `search`-capability к пользовательскому pipeline; зафиксирована в каталоге как кандидат для будущего расширения L2/Focused Research.
- **DeepSeek R1 0528** — reasoning-ориентированная модель по цене Micro band (0.8x); не включена в профили по умолчанию, но является кандидатом на замену Planner в Economy-профиле при последующей калибровке, если shadow-бенчмаркинг покажет преимущество над Qwen3.7 Plus.
- **`response_format: json_object` через `rout.my`** — эмпирически подтверждено (2026-07-14, живой прогон `packages/ai`): `nvidia/nemotron-3-ultra`, `deepseek/deepseek-v4-pro`, `openai/gpt-5.4-mini` отвечают `400 Bad Request` на строгий JSON-режим через этот роутер; только `google/gemini-3.1-flash-lite` принимает его без проблем. Все JSON-структурированные вызовы к провайдеру (`packages/ai`) поэтому просят JSON текстом в промпте и парсят терпимо (regex-извлечение `{...}` из ответа), а не полагаются на `response_format`. При добавлении новых JSON-структурированных ролей на эти модели через `rout.my` — тот же паттерн, не строгий JSON-режим.
- **DeepSeek V4 Pro для интерактивных/чатовых ролей** — эмпирически подтверждено непригодным (2026-07-14): латентность полного pipeline-прохода (не изолированного LLM-вызова) на вопрос в диалоге — 45-78 секунд на отдельные LLM-вызовы (`validateEvidence`) через `rout.my`, при сопоставимом с другими моделями качестве рассуждений. Для ролей вроде Router/Query Interpreter/Retrieval Judge/Answer Synthesizer (частые, интерактивные вызовы) предпочтительны `nvidia/nemotron-3-ultra` или `google/gemini-3.1-flash-lite` — оба дают латентность 1.5-3с на вызов при равном качестве суждений (подтверждено сравнением на одинаковых evidence-пакетах: обе модели корректно определяют domain-collision и отклоняют сфабрикованные cross-domain связи). DeepSeek V4 Pro остаётся кандидатом для неинтерактивных/фоновых ролей, где качество важнее задержки.

## 12.1 Практическое решение для текущего бюджета

Если реальная цель — не "бережно уложиться", а **работать почти на весь дневной лимит в 51M raw tokens/day**, то базовая стратегия профиля должна быть жёстче предыдущих допущений:

- дефолтный runtime не может быть Balanced или Premium;
- постоянный chat/runtime слой должен строиться вокруг моделей **0.0x–0.8x**, изредка до `1.0x`;
- Answer Synthesizer по умолчанию желательно держать в диапазоне **0.5x–0.8x**;
- Validator/Critic тоже должен жить в диапазоне **0.5x–0.8x** и эскалироваться только при явном сигнале;
- Planner/Developer/Reviewer выше `1.0x` допустимы только в change-flow или в редкой точечной эскалации, но не в обычном research-chat;
- любые модели `>= 1.3x` должны рассматриваться как ограниченный premium-capability слой, а не как часть базового конвейера ответов.

---

## 13. Что не входит в этот документ

- окончательные, не подлежащие пересмотру назначения моделей — этот каталог обновляется по мере появления новых версий моделей и результатов shadow-бенчмаркинга;
- фактическая реализация Cost Governor/Provider Registry — это `008`, разделы 13, 20 (Slice 8);
- расчёт реального дневного расхода в токенах — зависит от фактического профиля использования конкретной инсталляции и не может быть предсказан этим документом;
- решение о том, какой провайдер (прямой API вендора или единый шлюз) используется для доступа к каждой модели — operational/infra-решение вне scope архитектурной спецификации.
