# Provider System — Унифицированный Слой Абстракции Внешних AI-Сервисов

**Статус:** Спецификация
**Автор:** Principal Architecture Specification
**Дата:** 2026-07-08
**Версия:** 1.0.0
**Зависимости:** [000-overview.md](../architecture/000-overview.md), [001-domain-model.md](../architecture/001-domain-model.md), [002-storage.md](../architecture/002-storage.md), [003-event-system.md](../architecture/003-event-system.md), [004-dependency-map.md](../architecture/004-dependency-map.md), [005-contract-gaps.md](../architecture/005-contract-gaps.md)

---

## Оглавление

1. [Назначение](#1-назначение)
2. [Ответственность](#2-ответственность)
3. [Входные данные](#3-входные-данные)
4. [Выходные данные](#4-выходные-данные)
5. [Архитектура модуля](#5-архитектура-модуля)
6. [Provider Model](#6-provider-model)
7. [Capability Types](#7-capability-types)
8. [Provider Registration and Discovery](#8-provider-registration-and-discovery)
9. [Routing Model](#9-routing-model)
10. [Consumer Integration](#10-consumer-integration)
11. [LLM Provider Handling](#11-llm-provider-handling)
12. [Embedding and Vector Capabilities](#12-embedding-and-vector-capabilities)
13. [Search Providers](#13-search-providers)
14. [Configuration and Policy](#14-configuration-and-policy)
15. [Cost and Budget Control](#15-cost-and-budget-control)
16. [Reliability and Fallback](#16-reliability-and-fallback)
17. [Normalization Layer](#17-normalization-layer)
18. [Observability](#18-observability)
19. [Events](#19-events)
20. [Security](#20-security)
21. [Performance](#21-performance)
22. [Failure Handling](#22-failure-handling)
23. [Ограничения](#23-ограничения)
24. [Будущее развитие](#24-будущее-развитие)
25. [Заключение](#25-заключение)

---

## 1. Назначение

### 1.1 Что такое Provider System

Provider System — это **слой абстракции над внешними AI-сервисами и моделями**. Это единственная точка входа для всех downstream-модулей платформы Client, которым требуется взаимодействие с LLM-моделями, embedding-сервисами, векторными хранилищами, поисковыми системами и будущими capability-провайдерами.

Provider System не принимает инженерных решений. Он не определяет, какую задачу решать, какой контекст собирать или какое знание извлекать. Его единственная роль — предоставить **унифицированный, наблюдаемый, безопасный и заменяемый доступ** к внешним capability providers.

Это инфраструктурный, а не прикладной модуль — на том же архитектурном уровне, что и Event Bus, Storage Layer и Workspace.

### 1.2 Почему он существует

Без Provider System каждый модуль (Research, Knowledge, Context Builder, Execution) был бы вынужден самостоятельно интегрироваться с каждым LLM-вендором, реализовывать retry/rate limiting/fallback, управлять секретами, отслеживать usage и стоимость. Это привело бы к vendor lock-in, дублированию кода, неконтролируемым расходам, уязвимостям безопасности и непрозрачности.

### 1.3 Ключевые задачи

| Задача | Описание |
|--------|----------|
| **Унификация доступа** | Единый интерфейс для LLM, Embedding и Search |
| **Заменяемость провайдеров** | Смена провайдера без изменений в модулях-потребителях |
| **Управление стоимостью** | Централизованный бюджет, учёт токенов, лимиты на проект/задачу/Run |
| **Безопасность** | Изоляция секретов, data minimization |
| **Надёжность** | Retry, exponential backoff, circuit breaker, fallback chains |
| **Наблюдаемость** | Единая точка метрик: latency, usage, cost per consumer |
| **Нормализация** | Приведение vendor-specific форматов к единой модели |

### 1.4 Отличие от других модулей

- **Research** — прикладной модуль формирования исследовательских вопросов. Provider System даёт ему доступ к LLM/Search.
- **Knowledge** — прикладной модуль хранения инженерных знаний. Provider System даёт ему доступ к Embedding.
- **Execution** — прикладной модуль выполнения плана. Provider System обслуживает LLM-запросы Developer/Reviewer Agents.

---

## 2. Ответственность

### 2.1 Что входит

| # | Ответственность |
|---|-----------------|
| 1 | Provider Registry — реестр провайдеров, моделей и capabilities |
| 2 | Capability-based Routing — выбор провайдера под запрос |
| 3 | Policy Enforcement — allowlist/denylist, compliance |
| 4 | Request/Response Normalization — приведение к единой модели |
| 5 | Secret Management Bridge — безопасная работа с ключами |
| 6 | Budget Management — учёт и контроль расхода токенов/бюджета |
| 7 | Rate Limit Management — соблюдение лимитов |
| 8 | Retry, Backoff, Circuit Breaker — автоматическая обработка отказов |
| 9 | Fallback Management — цепочки резервных провайдеров |
| 10 | Cost Estimation & Accounting — предварительная и фактическая стоимость |
| 11 | Observability — метрики, трассировка, аудит |
| 12 | Provider Health Monitoring — непрерывный мониторинг |
| 13 | Event Publishing — канонические события AI-категории |
| 14 | Vendor Quirks Isolation — инкапсуляция особенностей API |
| 15 | Embedding Model Versioning — версионирование, reindex |
| 16 | Multimodal Extensibility — готовность к новым capability classes |

### 2.2 Что НЕ входит

| НЕ-ответственность | Где это должно быть |
|---------------------|---------------------|
| Принятие инженерных решений | Planner, Developer Agent |
| Формулировка исследовательских вопросов | Research Engine |
| Сборка контекста для LLM | Context Builder |
| Извлечение знаний из ответов | Knowledge |
| Хранение знаний или артефактов | Knowledge, Artifact Storage |
| Индексация кода | Indexer |
| Управление графом | Graph |
| Управление Workspace | Workspace |
| Knowledge retrieval semantics | Knowledge |
| Введение собственных lifecycle событий | Запрещено `005-contract-gaps.md`, Section 6.1 |

---

## 3. Входные данные

### 3.1 Provider Configuration
Тип, endpoint, модели, credential reference (не ключ), default-параметры, rate limits, cost/latency/reliability profiles, capabilities.

### 3.2 Project Policies
Allowlist/denylist провайдеров и моделей, бюджеты на проект/задачу/Run, privacy требования, compliance restrictions, latency constraints.

### 3.3 Task Constraints
Максимум LLM-вызовов, бюджет задачи, режим (deterministic/creative), требуемый context window, предпочитаемые/запрещённые модели.

### 3.4 Consumer Requests
- **LLM Request:** messages, system prompt, temperature, max_tokens, structured output schema, streaming flag, tool definitions.
- **Embedding Request:** text(s), model hint, batch size.
- **Search Request:** query, search type, max results, freshness, domain constraints.

### 3.5 Дополнительные входы
Security Policies (TLS, юрисдикции), Budget Limits (глобальный, per-project, per-task, per-run), Rate Limits (provider-specific, глобальные, per-project), Model Requirements (context window, structured output, function calling), Routing Hints (cost/quality/latency приоритет), Failover Policies (fallback chains, circuit breaker thresholds).

---

## 4. Выходные данные

### 4.1 ModelResponse
`response_id`, `provider_id`, `model_id`, `content`, `structured_output`, `tool_calls`, `finish_reason`, `usage` (prompt/completion/total tokens), `latency_ms`, `cost`, `created_at`.

### 4.2 EmbeddingResponse
`embedding_id`, `provider_id`, `model_id`, `model_version`, `vector` (float[]), `dimensions`, `text_hash`, `created_at`, `cost`.

### 4.3 SearchResults
`search_id`, `provider_id`, `results[]` (title, url, snippet, full_text, relevance_score 0-1, source_type, published_at, freshness_score, trust_score), `total_results`, `latency_ms`, `cost`.

### 4.4 Provider Diagnostics
`provider_id`, `availability_state`, `latency_p50/p95/p99`, `error_rate_5m/1h/24h`, `rate_limit_remaining`, `circuit_breaker_open`, `health_score`.

### 4.5 Usage/Cost Metrics
Per provider/model/project/task/run/consumer: total_requests, total_tokens, total_cost, avg_latency. Budget consumed %, projected monthly cost, savings from fallback.

### 4.6 Rate Limit & Fallback Signals
Оставшиеся запросы/токены, window reset, utilization %. Original vs actual provider_id, fallback_reason, fallback_chain_position.

---

## 5. Архитектура модуля

### 5.1 Компоненты

```
Provider System Module
│
├── Provider Coordinator — центральный оркестратор запросов
│
├── Registry — реестр провайдеров, моделей, capabilities
│   ├── Provider Descriptor Store
│   ├── Model Descriptor Store
│   └── Capability Registry
│
├── Capability Router — выбор провайдера
│   ├── Rule Engine
│   ├── Context Evaluator
│   └── Candidate Ranker
│
├── Policy Engine — политики доступа
│   ├── Access Policy Evaluator
│   ├── Budget Policy Evaluator
│   └── Compliance Evaluator
│
├── Budget Manager — бюджеты и стоимость
│   ├── Budget Tracker
│   ├── Cost Estimator
│   └── Alert Manager
│
├── Rate Limit Manager — ограничения частоты
│   ├── Rate Limit Tracker
│   └── Throttle Controller
│
├── Retry Manager — повторные попытки
│   ├── Backoff Calculator (exponential + jitter)
│   └── Retry Policy Store
│
├── Circuit Breaker — защита от каскадных отказов
│   ├── Health Tracker (скользящее окно ошибок)
│   └── State Manager (Closed→Open→Half-Open→Closed)
│
├── Fallback Manager — цепочки резервных провайдеров
│   ├── Fallback Chain Resolver
│   └── Degraded Mode Manager
│
├── Observability Manager — метрики, трейсинг, аудит
│   ├── Metrics Collector
│   ├── Trace Publisher
│   └── Audit Logger
│
├── Secret Manager Bridge — безопасная работа с ключами
│   ├── Credential Resolver
│   └── Rotation Manager
│
├── Response Normalizer — нормализация ответов
│   ├── LLM Response Normalizer
│   ├── Embedding Response Normalizer
│   └── Search Response Normalizer
│
└── Provider Health Manager — мониторинг здоровья
    ├── Active Health Checker (синтетические запросы)
    └── Passive Health Collector (анализ реальных запросов)
```

### 5.2 Поток обработки запроса

```
Consumer Request → Provider Coordinator
  → Policy Engine (allowlist/denylist)
  → Budget Manager (budget check)
  → Capability Router (выбор провайдера по capability/policy/health/rate/cost)
    → Registry поиск
    → Policy фильтр
    → Health фильтр
    → Rate Limit фильтр
    → Candidate Ranker
  → Secret Manager Bridge (получение API key)
  → Retry Manager (первая попытка)
    ├── Успех → Response Normalizer → Consumer
    ├── Transient Error → Retry (exponential backoff + jitter)
    │   ├── Успех → Consumer
    │   └── Исчерпаны → Fallback Manager
    ├── Rate Limited → Fallback Manager → AIProviderFallbackActivated / AIRateLimited
    ├── Provider Unavailable → Circuit Breaker (increment error count) → Fallback
    └── Malformed Response → Retry / Fallback
  → Observability Manager (метрики на каждом шаге)
```

---

## 6. Provider Model

### 6.1 Provider
Внешний сервис, предоставляющий AI-возможности. Атрибуты: `provider_id`, `provider_name`, `provider_type` (LLM/Embedding/Search/Vector/Multimodal/Custom), `api_base_url`, `auth_type`, `credential_reference`, `status` (active/disabled/deprecated/removed).

### 6.2 Provider Type
`LLM` — OpenAI, Anthropic, Google AI, Mistral, локальные. `Embedding` — OpenAI Embeddings, Cohere, локальные. `Search` — Google/Bing/внутренний. `Vector` — Pinecone, Weaviate, Qdrant, pgvector. `Multimodal`, `Tool`, `Custom` — будущие.

### 6.3 Capability
Конкретная функция: `chat`, `structured_output`, `function_calling`, `streaming`, `long_context`, `embedding`, `semantic_search`, `search`, `rerank`.

### 6.4 Model Descriptor
`model_id`, `provider_id`, `external_model_id`, `model_family`, `capabilities[]`, `context_window`, `max_output_tokens`, `input/output_modalities`, `status`, `deprecated_at`, `replaced_by_model_id`.

### 6.5 Embedding Descriptor
`embedding_model_id`, `provider_id`, `external_model_id`, `dimensions`, `max_input_tokens`, `supports_batch`, `batch_size_limit`, `model_version` (критично для reindex), `status`.

### 6.6 Search Descriptor
`search_provider_id`, `provider_id`, `search_type`, `supports_freshness_filter`, `supports_domain_filter`, `max_results_per_request`, `relevance_score_scale`.

### 6.7 Профили
**Cost Profile:** input/output cost per 1K tokens, cost per embedding/search, валюта, период действия.
**Latency Profile:** median/p95/p99 latency, time-to-first-token, tokens per second.
**Reliability Profile:** historical uptime %, error_rate_24h, avg recovery time, SLA.

### 6.8 Availability State
`provider_id`, `state` (available/degraded/unavailable), `degraded_reason`, `checked_at`, `consecutive_failures`, `circuit_breaker_open`.

### 6.9 Routing Policy & Fallback Chain
**Routing Policy:** scope, priority_criteria (cost/latency/quality/privacy), preferred/forbidden providers, constraints.
**Fallback Chain:** primary provider, ordered fallback array, max depth, timeouts.

---

## 7. Capability Types

| Capability | Назначение | Потребители |
|------------|------------|-------------|
| `chat` | Текстовое completion | Research, Execution/Agents |
| `structured_output` | Генерация JSON по схеме | Planner, Knowledge, Research |
| `function_calling` | Вызов внешних инструментов | Developer/Reviewer Agents |
| `streaming` | Потоковая генерация (лучший UX) | Execution/Agents |
| `long_context` | Поддержка >32K токенов | Context-heavy задачи |
| `embedding` | Векторные представления текста | Knowledge, Indexer |
| `semantic_search` | Поиск по векторной близости | Knowledge, Context Builder |
| `search` | Внешний поиск (web/docs/academic) | Research |
| `rerank` | Переранжирование результатов | Knowledge, Context Builder |
| `multimodal_input` | Обработка изображений/аудио (будущее) | — |
| `code_execution` | Sandbox-исполнение кода (будущее) | — |

---

## 8. Provider Registration and Discovery

### 8.1 Регистрация
Административная операция: создание Provider → Model Descriptors → Capability Registry → Cost/Latency/Reliability Profiles → Secret Manager проверка → Health Check → Active.

### 8.2 Discovery
Capability Router выполняет: Capability Match → Status Filter (исключить disabled/deprecated) → Policy Filter (allowlist/denylist) → Health Filter (исключить unavailable/open circuit) → Rate Limit Filter → Budget Filter → Candidate Ranking.

### 8.3 Совместимость
Провайдер должен удовлетворять: capability match, context window ≥ требуемый, output format match, modality match, latency ≤ constraint, cost ≤ constraint, policy match, privacy match. Несовместимость по любому критерию = исключение.

---

## 9. Routing Model

### 9.1 Фундаментальное правило
**Routing — выбор способа исполнения внешнего запроса, не инженерное решение о задаче.** Capability Router не знает контекст задачи, архитектурные решения, назначение запроса.

### 9.2 Типы маршрутизации

**Capability-based:** поиск всех провайдеров с требуемой capability.
**Policy-based:** фильтрация по allowlist/denylist проекта.
**Cost-aware:** Cost Estimator → исключение превышающих бюджет → ранжирование по стоимости.
**Latency-aware:** Latency Profile → исключение p95 > constraint → ранжирование по latency.
**Quality-aware:** Quality Tier (model family, бенчмарки) → исключение ниже constraint → ранжирование.
**Privacy-aware:** исключение провайдеров без DPA, с запрещённой юрисдикцией, с data training.
**Project-specific:** предпочтения проекта переопределяют глобальные, но не security constraints.
**Fallback:** активация цепочки при недоступности, публикация `AIProviderFallbackActivated`.

### 9.3 Multi-criteria Decision
Взвешенное ранжирование: score = Σ(weight_i × score_i). Веса по умолчанию: Cost 0.4, Quality 0.35, Latency 0.25. Переопределяются routing hints.

---

## 10. Consumer Integration

### 10.1 Общая модель
Consumer → формулирует запрос (LLM/Embedding/Search) → Provider Coordinator → routing/policy/budget → выполнение → нормализация → Consumer. Consumer не знает: какой провайдер, API-ключи, retry/fallback факт, rate limits.

### 10.2 Research Engine
**Capabilities:** `chat`, `structured_output`, `search`.
**Ограничения:** не выбирает провайдера, не управляет бюджетом, не хранит ключи. Лимит LLM-вызовов на Research.
**Ответы:** `ModelResponse`, `SearchResults`.

### 10.3 Knowledge
**Capabilities:** `embedding`, `search` (через Research).
**Ограничения:** не знает embedding-модель, не управляет версионированием. Получает `model_version` с embedding. При смене модели Provider System координирует reindex.
**Ответы:** `EmbeddingResponse`.

### 10.4 Context Builder
**Напрямую НЕ обращается** за LLM. Может запрашивать `rerank` для приоритезации контекста. Не вызывает LLM самостоятельно, не интерпретирует ответы.

### 10.5 Execution Engine / Agents
**Capabilities:** `chat`, `structured_output`, `function_calling`, `streaming`, `long_context`.
**Ограничения:** Agent не знает провайдера/ключи, не реализует retry, соблюдает бюджет Run. Обрабатывает `AIRateLimited`/`AIRequestFailed`.
**Ответы:** `ModelResponse`, streaming `StreamChunk`.

---

## 11. LLM Provider Handling

### 11.1 Выбор модели
Capability Router выбирает по `model_requirements`. Если указанная модель недоступна — совместимая замена или fallback.

### 11.2 Нормализация входа
System prompt проверка на запрещённый контент, role mapping под API провайдера, tool definitions → provider-specific формат, output schema → provider-specific, context truncation при превышении window.

### 11.3 Structured Output
Schema → правильный формат провайдера, strict mode где поддерживается, валидация ответа на schema, retry/fallback при несоответствии.

### 11.4 Deterministic vs Creative
Deterministic (temperature ≈ 0) для точности/воспроизводимости. Creative (temperature > 0) для вариативности.

### 11.5 Безопасность
Content filtering, system prompt integrity, prompt injection detection, output sanitization.

### 11.6 Token Accounting
Pre-request estimation (tokenizer) + post-request actual (usage из ответа). Учёт per consumer/project/task/run. Cost calculation по Cost Profile.

### 11.7 Long Context
Проверка размера → обрезка старых сообщений/суммаризация/отказ. Consumer уведомлён при модификации.

### 11.8 Vendor Quirks
Все различия (system prompt формат, tool calling, finish_reason, streaming, errors) инкапсулированы в адаптерах Response Normalizer. Consumer всегда получает единый ModelResponse.

---

## 12. Embedding and Vector Capabilities

### 12.1 Получение embeddings
Consumer → Provider System → Router → API провайдера → нормализация → `EmbeddingResponse`.

### 12.2 Версионирование
Смена embedding-модели меняет векторное пространство. `model_version` обязателен. Semantic search только в рамках одной версии.

### 12.3 Reindex
При смене модели Provider System координирует: новая модель → `EmbeddingModelVersionCreated` → Knowledge запускает reindex → старая модель deprecated после завершения. Во время reindex search использует старую модель.

### 12.4 Embedding Drift
Если провайдер обновляет модель без версии, Provider System детектирует drift через эталонные тексты.

---

## 13. Search Providers

### 13.1 Типы поиска
**Documentation:** официальная документация, высокий trust_score, привязка к версии.
**Web search** — capability `search`, более низкий trust_score, фильтрация источников.

### 13.2 Project-safe Policies
Domain allowlist/denylist, content type filter (исключение форумов/spam), license awareness, copyright caution (snippets, не полный текст защищённых материалов).

### 13.3 Нормализация
Разные провайдеры (Google, Bing, внутренний) → единая структура: title, url, snippet, full_text, relevance_score (нормализованный 0-1), source_type, trust_score, freshness_score. Дедупликация результатов.

### 13.4 Freshness и Trust
**Freshness:** дата публикации, соответствие версии документации проекту.
**Trust:** официальная документация > технические блоги > форумы. Авторитетность домена, атрибуция, отсутствие маркеров спама.

---

## 14. Configuration and Policy

### 14.1 Provider Configuration
Хранится в Configuration Store (не в Provider System). Параметры: provider_id, тип, URL, auth_type, credential_reference, default_model, timeout, max_retries.

### 14.2 Secret References
`credential_reference` — ссылка на Secret Manager (`secret://providers/openai/api-key`). Ключ в памяти только на время запроса. Никогда не передаётся consumer'ам, не попадает в логи.

### 14.3 Allow/Deny Policies
Provider Allowlist/Denylist, Model Allowlist/Denylist. Приоритет: Denylist > Allowlist.

### 14.4 Per-project и Per-capability
Проектные политики переопределяют глобальные (но не security). Per-capability: для `chat` — одни модели, для `embedding` — другие.

### 14.5 Budget Ceilings
`global_monthly_budget`, `project_monthly_budget`, `project_total_budget`, `task_max_budget`, `run_max_budget`. Soft limit (80-90%: warning), hard limit (100%: отказ).

### 14.6 Compliance
Data residency (юрисдикция), data retention (не хранить у провайдера), model training opt-out, audit trail, data minimization.

---

## 15. Cost and Budget Control

### 15.1 Token Budgets
Бюджет в токенах или деньгах. Автоматическая конвертация через Cost Profile.

### 15.2 Pre-request Estimation
LLM: input tokens (tokenizer) × input_cost + estimated output × output_cost. Embedding: кол-во текстов × cost_per. Search: фиксированная cost_per_request. Отказ при превышении бюджета.

### 15.3 Post-request Accounting
Фактические tokens × cost. Атрибуция к provider/model/consumer/project/task/run/timestamp.

### 15.4 Budget Alerts
80% — warning, 90% — уведомление администратору, 95% — critical, 100% — hard stop или soft degradation.

### 15.5 Hard Stop vs Soft Degradation
**Hard Stop:** все запросы отклонены, требуется ручное увеличение бюджета.
**Soft Degradation:** Router выбирает только дешёвые модели, качество снижено, работа продолжается. Выбирается per-project.

### 15.6 Per-task и Per-run Budget
Предотвращение runaway-задач. При превышении: задача приостановлена → запрос подтверждения пользователя. Run-бюджет — самый гранулярный уровень.

---

## 16. Reliability and Fallback

### 16.1 Retries
Retryable: network errors, timeout, 429, 5xx. Non-retryable: 400, 401, 403, 404. Max retries: 3 (конфигурируется). Idempotency: streaming — retry с начала.

### 16.2 Exponential Backoff
Начальная задержка: 1s, множитель: 2×, максимум: 60s. Jitter: ±25%. Total retry window: 120s.

### 16.3 Circuit Breaker
Состояния: Closed → Open (error rate > порог) → Half-Open (тестовые запросы) → Closed (восстановление). Параметры: error_threshold, open_duration, half_open_max_requests.

### 16.4 Fallback Chain
Пример: Claude Sonnet → GPT-4o → Claude Haiku → GPT-4o-mini → ошибка. Каждый шаг — совместимая замена. Макс. глубина: 3. Событие: `AIProviderFallbackActivated`.

### 16.5 Degraded Mode
Пониженное качество/скорость при частичной недоступности. Критические capabilities сохранены. Consumer уведомлён. Автовозврат при восстановлении.

### 16.6 Rate Limit Handling
429 → Retry-After (если есть) или exponential backoff. Rate Limit Manager обновляет счётчик. Персистентный → fallback. Событие: `AIRateLimited`.

---

## 17. Normalization Layer

### 17.1 Зачем нужна
Без нормализации: vendor lock-in, дублирование, невозможность бесшовного переключения. С нормализацией: consumer'ы работают с единой моделью, провайдеры заменяемы.

### 17.2 Единая форма
| Поле | OpenAI | Anthropic | Google AI | → Normalized |
|------|--------|-----------|-----------|--------------|
| content | choices[0].message.content | content[0].text | candidates[0].content.parts[0].text | content |
| prompt_tokens | usage.prompt_tokens | usage.input_tokens | usageMetadata.promptTokenCount | usage.prompt_tokens |
| finish_reason | "stop" | "end_turn" | "STOP" | "stop" |

### 17.3 Адаптеры
Request Adapter (нормализованный → provider-specific), Response Adapter (provider-specific → нормализованный), Error Adapter, Stream Adapter. Адаптеры — единственное место с vendor-specific знанием.

### 17.4 Inconsistent Outputs
Structured output не соответствует схеме → retry с подсказкой → fallback. Embedding с неправильной размерностью → retry/fallback. Truncated response → уведомление consumer.

---

## 18. Observability

### 18.1 Tracing
`trace_id` сквозной, `span_id` на каждый шаг (routing, normalization, provider call, retry), `parent_span_id` для дерева вызовов. End-to-end tracing.

### 18.2 Latency
End-to-end, provider latency, overhead (routing/normalization/policy), time-to-first-token (streaming). Per provider/model/capability/project/consumer.

### 18.3 Token Usage
Total, prompt vs completion, per request/project/task/run/consumer. Per-model стоимость.

### 18.4 Error Rates
Per provider/model, per error type (rate_limit, timeout, server_error, auth_error, malformed), fallback activation rate, circuit breaker open events.

### 18.5 Provider Health
health_score (0-1), availability %, latency p50/p95/p99, success rate.

### 18.6 Cost Tracking
Real-time: текущий расход за период. Per provider/project/task/run/consumer. Projected monthly. Savings from fallback.

### 18.7 Audit Trail
Все запросы: timestamp, trace_id, consumer, project, task, run, provider, model, capability, request summary (с маскированием PII), response summary, usage, cost, errors. Retention: 90 дней онлайн, 1 год архив. Immutable.

### 18.8 Per-consumer
Research: LLM-вызовов/исследование, стоимость/исследование, поисковых запросов.
Knowledge: embedding-запросов, стоимость векторизации, частота reindex.
Execution: LLM-вызовов/Run, стоимость/Run, success/error ratio.

---

## 19. Events

### 19.1 Канонические события (утверждены в `003-event-system.md`)

| Событие | Издатель | Подписчики | Когда | Payload |
|---------|----------|------------|------|---------|
| **AIRequestSent** | Agent / Provider System | Conversation (сохраняет запрос), Audit Logger | При отправке запроса провайдеру | trace_id, consumer_id, provider_id, model_id, project/task/run_id, request_summary, expected_tokens |
| **AIResponseReceived** | Agent / Provider System | Conversation (сохраняет ответ), Execution (продолжает), Audit Logger | При получении ответа | trace_id, provider/model_id, actual_tokens, cost, latency_ms, finish_reason |
| **AIRequestFailed** | Agent / Provider System | Execution (retry/fallback), Provider System (обновляет статус провайдера) | При ошибке вызова | trace_id, provider/model_id, error_type, error_message, retry_count |
| **AIRateLimited** | Agent / Provider System | Provider System (Rate Limiter), Execution (backoff) | При превышении лимита | trace_id, provider/model_id, rate_limit_reset_at, retry_after_seconds |
| **AIProviderFallbackActivated** | Provider System | Frontend (уведомление), Execution (продолжает с fallback) | При активации fallback | trace_id, original_provider_id, fallback_provider_id, fallback_reason, chain_position |

### 19.2 Дополнительные внутренние события
`ProviderHealthChanged`, `ProviderBudgetExceeded`, `EmbeddingModelVersionCreated` — не канонические согласно `005-contract-gaps.md`. Требуют включения в `003-event-system.md` при реализации.

### 19.3 Правила интеграции (из `005-contract-gaps.md`, Section 6.1)
- Provider System **не должен** вводить собственные lifecycle события без проверки совместимости с `003-event-system.md`.
- Provider System **не должен** подменять event orchestration.
- При конфликте event semantics приоритет у `003-event-system.md`.

---

## 20. Security

### 20.1 Secret Handling
Ключи никогда: в коде, конфигурации, логах, у consumer'ов. Хранение: Secret Manager (Vault/AWS Secrets Manager). В памяти только на время запроса. Маскирование в логах. Поддержка ротации.

### 20.2 API Key Isolation
Каждый провайдер — отдельный ключ. Доступ к ключам — только Provider System. Project-specific ключи опционально.

### 20.3 Outbound Request Policies
TLS 1.3+ обязателен. mTLS где поддерживается. Certificate pinning опционально. Timeout enforcement. Request size limit.

### 20.4 Data Minimization
Только необходимые данные. Без внутренних идентификаторов (project_id, user_id). Без PII (маскирование). Без секретов (проверка паттернов).

### 20.5 Prompt/Data Leakage Prevention
System prompt без конфиденциальной информации. Project code — только если политика разрешает. Knowledge — без конфиденциальных данных.

### 20.6 Project Confidentiality Boundaries
Данные проекта A никогда в контексте проекта B. Budget tracking изолирован. Логи аудита сегментированы.

### 20.7 Provider Trust Tiers
| Tier | Описание | Ограничения | Примеры |
|------|----------|-------------|---------|
| Tier 1: Trusted Enterprise | On-premise/private cloud, DPA, аудит | Минимальные | Self-hosted Llama, Azure OpenAI с DPA |
| Tier 2: Verified Provider | DPA подписан, compliance подтверждён | Стандартные проверки | OpenAI/Anthropic API с DPA |
| Tier 3: Standard Provider | Без DPA, стандартные Terms | Data minimization, no PII | Бесплатные API, прокси |
| Tier 4: Untrusted | Без гарантий | Максимальные ограничения | Публичные экспериментальные модели |

---

## 21. Performance

### 21.1 Connection Pooling
Переиспользование HTTP-соединений. Keep-alive. Connection pool per provider.

### 21.2 Request Batching
Embedding: batch-запросы для снижения количества вызовов. LLM: batching не применим.

### 21.3 Caching
Deterministic-запросы (temperature=0) с одинаковыми параметрами могут кэшироваться (TTL-зависимый, конфигурируемый). Embedding-кэш по text_hash. Policy evaluation results (TTL: минуты).

### 21.4 Concurrency
Ограничение одновременных запросов per provider (rate limit). Приоритезация: интерактивные задачи > фоновые.

### 21.5 Streaming
Поддержка streaming для LLM-запросов. Потоковая передача consumer'у без буферизации полного ответа. Нормализация stream chunks на лету.

### 21.6 Latency Budget
Каждый шаг обработки имеет latency budget: routing < 50ms, policy check < 20ms, normalization < 30ms. Превышение → degraded mode.

---

## 22. Failure Handling

### 22.1 Категории ошибок

| Категория | Retryable | Стратегия |
|-----------|-----------|-----------|
| Transient (timeout, network, 5xx) | Да | Exponential backoff + jitter |
| Rate Limit (429) | Да | Retry-After + fallback |
| Auth (401, 403) | Нет | Alert администратору, disable provider |
| Bad Request (400) | Нет | Ошибка consumer'у |
| Model Not Found (404) | Нет | Fallback на совместимую |
| Malformed Response | Условно | Retry 1 раз, затем fallback |
| Provider Unavailable | Да (через fallback) | Circuit breaker + fallback |

### 22.2 Graceful Degradation
При недоступности Tier 1 → Tier 2 → Tier 3. При недоступности всех → ошибка consumer'у с объяснением.

### 22.3 Восстановление
Circuit breaker: Closed → Open → Half-Open (тестовые запросы) → Closed. Fallback: мониторинг primary провайдера, возврат при health_score ≥ threshold в течение N минут.

### 22.4 Изоляция отказов
Отказ одного провайдера не влияет на другие. Отказ одного проекта (превышение бюджета) не влияет на другие проекты.

---

## 23. Ограничения

### 23.1 Когда Provider System обязан отказать
- Все провайдеры для требуемой capability недоступны.
- Бюджет проекта/задачи исчерпан (hard stop активен).
- Запрос нарушает security policy (запрещённый провайдер, юрисдикция).
- Невозможно нормализовать ответ (persistent malformed responses).

### 23.2 Что Provider System не может гарантировать
- Идентичность ответов разных провайдеров (разные модели = разные ответы).
- Доступность внешних сервисов (вне зоны контроля).
- Консистентность embedding между версиями моделей (требуется reindex).

### 23.3 Принцип Fail-Safe
При неразрешимой ошибке Provider System должен: вернуть структурированную ошибку consumer'у, залогировать incident, опубликовать соответствующее каноническое событие, НЕ пытаться бесконечно retry, НЕ подменять ответ "заглушкой".

---

## 24. Будущее развитие

### 24.1 Multimodal Providers
Image input (скриншоты кода, диаграммы архитектуры, UI mockups) → модели с vision capabilities. Audio input (голосовые инструкции). Image generation (генерация диаграмм, UI previews).

### 24.2 Локальные модели
Self-hosted модели через Ollama/vLLM/LocalAI как Tier 1 провайдеры. Inference on-premise. Полный контроль над данными.

### 24.3 Fine-tuned Models
Fine-tuning моделей на проектных данных. Provider System управляет версиями fine-tuned моделей, lifecycle, A/B тестированием.

### 24.4 Provider Marketplace
Стандартизированный интерфейс для регистрации кастомных провайдеров. Сообщество может создавать и публиковать провайдеры.

### 24.5 Federation и Routing Intelligence
Федерация между инстансами Client. ML-based routing: выбор провайдера на основе предсказания качества ответа для конкретного типа запроса. Auto-tuning routing weights.

### 24.6 Cost Optimization
Spot-инстансы для self-hosted моделей. Динамический выбор провайдера по real-time pricing. Автоматическое ужесточение budget policy при аномалиях.

---

## 25. Заключение

Provider System — это инфраструктурный фундамент, обеспечивающий vendor-independence, безопасность, надёжность и наблюдаемость всех внешних AI-взаимодействий платформы Client.

**Ключевые архитектурные гарантии:**
- Consumer-модули никогда не зависят от конкретного провайдера или модели.
- Смена/добавление провайдера не требует изменений в прикладном коде.
- Все секреты изолированы и недоступны consumer-модулям.
- Бюджеты и rate limits централизованно контролируются и не могут быть нарушены.
- Полная наблюдаемость: каждый запрос трассирован, учтён и проаудирован.
- При отказе провайдера система автоматически переключается на fallback без участия consumer.

**Архитектурные принципы:**
- Routing — выбор способа исполнения запроса, не инженерное решение.
- Нормализация — vendor-specific особенности инкапсулированы в адаптерах.
- Capability-based — потребители запрашивают capabilities, а не конкретных провайдеров.
- Fail-safe — система отказывает явно, не подменяет ответы и не скрывает ошибки.
- Событийная модель — все значимые события публикуются согласно `003-event-system.md`.