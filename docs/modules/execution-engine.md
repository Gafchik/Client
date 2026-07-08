# Execution Engine

**Статус:** Спецификация модуля
**Версия:** 1.0.0
**Зависимости:** Event System, Planner, Context Builder, Graph, Knowledge, Workspace, Provider System

---

## 1. Назначение Execution Engine

Execution Engine — это модуль, который исполняет `Execution Plan`, созданный Planner.

Execution Engine является конечным исполнителем в цепочке обработки задач. Он получает утверждённый план, содержащий последовательность шагов, зависимости, исполнителей и validation gates, после чего выполняет его шаг за шагом.

Execution Engine **не принимает архитектурных решений**.

Execution Engine **не изменяет план самостоятельно**.

Execution Engine отвечает исключительно за **безопасное, детерминированное и наблюдаемое выполнение** плана.

Если в процессе выполнения возникает ситуация, требующая архитектурного выбора, Execution Engine останавливается и запрашивает вмешательство Planner или человека — но никогда не принимает решение сам.

Execution Engine — это **execution runtime**, а не reasoning engine.

---

## 2. Ответственность

Execution Engine отвечает за:

- получение `Execution Plan` и его валидацию перед стартом;
- оркестрацию выполнения шагов в правильном порядке (последовательном и параллельном);
- вызов инструментов (Tool Invocation) в рамках каждого шага;
- вызов AI Tasks там, где требуется LLM-обработка;
- синхронизацию состояния выполнения в реальном времени;
- публикацию событий о ходе выполнения;
- сбор и агрегацию результатов каждого шага;
- формирование `Execution Report` как выходного артефакта;
- обнаружение сбоев и выполнение стратегии retry;
- выполнение rollback, если шаг или цепочка шагов завершилась неудачей;
- управление чекпоинтами (checkpoints);
- валидацию результата каждого шага перед переходом к следующему;
- приостановку выполнения в точках human approval;
- восстановление выполнения после сбоев и перезапусков;
- соблюдение safety bounds, определённых планом.

Execution Engine **не отвечает** за:

- формирование плана — это зона ответственности Planner;
- исследование кодовой базы — это зона Research Engine;
- сбор и актуализацию контекста — это зона Context Builder;
- архитектурный анализ и принятие решений;
- оптимизацию плана — это зона Planner;
- изменение scope задачи — это зона Planner и Research.

---

## 3. Входные данные

Execution Engine принимает на вход:

### 3.1 Execution Plan

Исполнимый план, созданный Planner и утверждённый (если требуется human approval). План содержит:

- `planId` — уникальный идентификатор плана;
- `planVersion` — версия плана;
- `taskId` — идентификатор родительской задачи;
- `steps[]` — упорядоченный список шагов с зависимостями;
- `stepDependencies` — граф зависимостей между шагами;
- `parallelGroups` — группы шагов, допускающие параллельное выполнение;
- `rollbackPlan` — план отката для каждого шага и групп шагов;
- `approvalPoints` — точки, где требуется human approval;
- `validationRules` — правила валидации для каждого шага;
- `agentAssignments` — назначение агентов на шаги;
- `toolBindings` — привязка инструментов к шагам;
- `retryPolicies` — политики повторных попыток;
- `timeouts` — таймауты для шагов и групп;
- `safetyBounds` — границы безопасности.

### 3.2 Execution Context

Контекст выполнения, включающий:

- workspace snapshot — состояние рабочей области до начала выполнения;
- knowledge snapshot — срез знаний на момент планирования;
- graph snapshot — срез графа зависимостей на момент планирования;
- artifacts from Research — артефакты исследования.

### 3.3 Runtime Configuration

- provider configurations — конфигурации LLM-провайдеров;
- tool registrations — зарегистрированные инструменты;
- agent definitions — определения доступных агентов;
- workspace access — доступ к workspace;
- event bus configuration — конфигурация шины событий;
- logging configuration — конфигурация логирования.

---

## 4. Выходные данные

Execution Engine формирует:

### 4.1 Execution Report

Финальный отчёт о выполнении, содержащий:

- `executionId` — уникальный идентификатор выполнения;
- `planId` — идентификатор выполненного плана;
- `status` — итоговый статус (`completed`, `partially_completed`, `failed`, `aborted`);
- `steps[]` — результаты выполнения каждого шага;
- `executionTrace` — полная трасса выполнения;
- `toolCalls[]` — все выполненные tool calls с результатами;
- `aiTaskResults[]` — результаты AI-задач;
- `events[]` — все опубликованные события;
- `errors[]` — ошибки и информация о сбоях;
- `rollbacks[]` — выполненные откаты;
- `approvals[]` — пройденные точки human approval;
- `artifacts[]` — созданные артефакты;
- `metrics` — метрики выполнения (длительность, токены, retries и т.д.);
- `checkpoints[]` — контрольные точки.

### 4.2 Workspace Changes

Фактические изменения в workspace:

- созданные/изменённые/удалённые файлы;
- выполненные миграции;
- обновлённые конфигурации.

### 4.3 Knowledge Update Artifacts

Артефакты для обновления Knowledge:

- новые сущности;
- изменённые связи;
- обновлённые метаданные;
- новые паттерны.

### 4.4 Event Stream

Поток событий для downstream-потребителей:

- прогресс выполнения;
- ошибки;
- предупреждения;
- метрики;
- результаты шагов.

---

## 5. Архитектура Execution Engine

Execution Engine построен как pipeline-архитектура с чётко разделёнными стадиями.

### 5.1 Компоненты

```
Execution Engine
├── Plan Validator
├── Step Executor
│   ├── Tool Invoker
│   ├── AI Task Runner
│   └── Validation Engine
├── Parallel Scheduler
├── State Manager
├── Retry Manager
├── Rollback Manager
├── Checkpoint Manager
├── Event Publisher
├── Logging Pipeline
├── Metrics Collector
├── Approval Gate
├── Failure Recovery
└── Report Builder
```

### 5.2 Принципы архитектуры

- **Pipeline Transparency:** каждая стадия видима и наблюдаема;
- **Immutable Plan:** план не модифицируется без явной команды Planner на replanning;
- **Isolated Steps:** каждый шаг исполняется в изолированном контексте;
- **Stateful Execution:** состояние выполнения сохраняется и восстанавливается;
- **Event-Driven Observability:** каждое значимое действие порождает событие;
- **Graceful Degradation:** сбой одного шага не разрушает всё выполнение, если это позволяет план;
- **Deterministic Playback:** любое выполнение может быть воспроизведено по трассе.

---

## 6. Execution Pipeline

Execution Pipeline — это главный процессорный конвейер Engine.

### 6.1 Стадии Pipeline

```
[Pre-flight] → [Validation] → [Execution Loop] → [Post-execution] → [Report]
```

#### 6.1.1 Pre-flight

На этой стадии Engine:

1. принимает `Execution Plan`;
2. проверяет целостность плана (все ссылки разрешимы, нет циклических зависимостей);
3. загружает `Execution Context`;
4. сверяет workspace state с ожидаемым snapshot;
5. инициализирует State Manager;
6. создаёт `executionId` и регистрирует начало выполнения;
7. создаёт чекпоинт `start`;
8. публикует событие `EXECUTION_STARTED`.

Pre-flight не выполняет шагов. Это исключительно подготовительная стадия.

При любом несоответствии на pre-flight выполнение абортируется до начала исполнения шагов.

#### 6.1.2 Validation

Перед началом исполнения Engine валидирует:

- каждый шаг имеет назначенного исполнителя;
- каждый шаг имеет определённый rollback plan;
- каждый шаг имеет validation rules;
- инструменты, необходимые для шагов, доступны;
- AI-провайдеры доступны, если требуются AI Tasks;
- approval points корректно размечены;
- зависимости не содержат циклов;
- safety bounds не нарушены.

Результат валидации фиксируется. При нарушении выполнение останавливается.

#### 6.1.3 Execution Loop

Основной цикл выполнения:

1. выбрать следующий шаг (или группу шагов) для выполнения;
2. проверить, что все зависимости шага удовлетворены;
3. проверить, не требует ли шаг human approval;
4. создать execution context для шага;
5. выполнить шаг через Step Executor;
6. валидировать результат шага;
7. опубликовать событие о завершении шага;
8. создать чекпоинт;
9. перейти к следующему шагу.

Цикл продолжается, пока:
- все шаги выполнены успешно;
- или обнаружена невосстановимая ошибка;
- или достигнута точка прерывания (approval, failure, abort).

#### 6.1.4 Post-execution

После завершения цикла:

1. собрать все результаты;
2. агрегировать метрики;
3. сформировать `Execution Report`;
4. опубликовать событие `EXECUTION_COMPLETED` (или `EXECUTION_FAILED`, `EXECUTION_ABORTED`);
5. освободить ресурсы;
6. зафиксировать финальное состояние.

#### 6.1.5 Report Generation

Финальный этап: формирование структурированного `Execution Report`, который передаётся downstream-потребителям.

### 6.2 Pipeline States

Pipeline может находиться в следующих состояниях:

- `INIT` — инициализация;
- `PREFLIGHT` — pre-flight проверка;
- `VALIDATING` — валидация плана;
- `RUNNING` — выполнение шагов;
- `WAITING_APPROVAL` — ожидание human approval;
- `ROLLING_BACK` — выполнение отката;
- `RECOVERING` — восстановление после сбоя;
- `COMPLETED` — успешное завершение;
- `FAILED` — завершение с ошибкой;
- `ABORTED` — принудительная остановка.

---

## 7. Step Executor

Step Executor — это ядро Execution Engine, отвечающее за выполнение одного шага.

### 7.1 Жизненный цикл выполнения шага

Жизненный цикл шага детально определён и включает следующие фазы:

#### Фаза 1: Pre-execution

1. **Context Preparation**
   - собрать контекст, необходимый для шага;
   - загрузить результаты предыдущих шагов, от которых зависит данный шаг;
   - подготовить workspace для шага.

2. **Tool Resolution**
   - проверить доступность всех инструментов, указанных в шаге;
   - проверить совместимость версий инструментов;
   - подготовить tool schemas.

3. **Agent Assignment**
   - назначить конкретного агента на шаг;
   - проверить, что агент доступен и имеет необходимые права;
   - инициализировать agent session.

4. **Safety Check**
   - проверить, что шаг не выходит за пределы safety bounds;
   - проверить, что шаг не нарушает ограничения workspace;
   - валидировать входные параметры шага.

5. **Checkpoint Before**
   - создать чекпоинт перед выполнением шага;
   - сохранить состояние workspace до изменений;
   - записать `EXECUTION_STEP_STARTED`.

#### Фаза 2: Execution

6. **Step Dispatch**
   - определить тип шага: Tool Invocation, AI Task или Compound Step;
   - направить шаг соответствующему исполнителю.

7. **Execution**
   - выполнить шаг согласно его типу;
   - захватить все промежуточные результаты;
   - мониторить выполнение в реальном времени.

8. **Completion**
   - получить результат выполнения;
   - зафиксировать фактические параметры выполнения;
   - записать время выполнения, токены и другие метрики.

#### Фаза 3: Post-execution

9. **Validation**
   - провалидировать результат шага согласно validation rules;
   - проверить, что результат соответствует ожидаемому формату;
   - проверить побочные эффекты.

10. **Result Collection**
    - агрегировать все артефакты шага;
    - сохранить логи выполнения;
    - зафиксировать метрики.

11. **Event Publishing**
    - опубликовать `EXECUTION_STEP_COMPLETED` (или `EXECUTION_STEP_FAILED`);
    - включить в событие результат, метрики и артефакты.

12. **Checkpoint After**
    - создать чекпоинт после выполнения шага;
    - сохранить состояние workspace после изменений.

#### Фаза 4: Error Handling (при сбое)

13. **Failure Classification**
    - классифицировать сбой: transient, permanent, validation, safety;
    - определить, является ли сбой recoverable.

14. **Retry Evaluation**
    - проверить политику retry для шага;
    - если retry допустим — перейти к фазе retry;
    - если retry недопустим — перейти к rollback.

15. **Rollback (при необходимости)**
    - выполнить rollback согласно rollback plan шага;
    - восстановить workspace до состояния checkpoint before;
    - опубликовать `EXECUTION_STEP_ROLLED_BACK`.

16. **Failure Notification**
    - опубликовать `EXECUTION_STEP_FAILED` с деталями сбоя;
    - уведомить Planner, если требуется replanning;
    - приостановить pipeline, если сбой blocking.

### 7.2 Типы шагов

#### 7.2.1 Tool Invocation Step

Шаг, исполняющий конкретный инструмент.

- Не использует AI.
- Детерминирован.
- Имеет чётко определённые входные и выходные параметры.
- Валидируется по схеме.

#### 7.2.2 AI Task Step

Шаг, требующий LLM-обработки.

- Отправляет prompt с контекстом провайдеру.
- Получает ответ.
- Валидирует ответ согласно validation rules.
- Фиксирует токены и latency.

#### 7.2.3 Compound Step

Шаг, состоящий из последовательности подшагов.

- Может включать как Tool Invocation, так и AI Tasks.
- Имеет собственный mini-pipeline выполнения.
- Поддерживает partial rollback внутри себя.
- Атомарен с точки зрения parent pipeline.

### 7.3 Execution Context шага

Каждый шаг получает изолированный execution context:

- `stepId` — идентификатор шага;
- `parentExecutionId` — идентификатор родительского выполнения;
- `planStep` — определение шага из плана;
- `input` — входные данные;
- `workspacePath` — путь к workspace;
- `previousResults` — результаты зависимых шагов;
- `allowedTools` — разрешённые инструменты;
- `timeout` — таймаут выполнения;
- `retryPolicy` — политика retry;
- `rollbackPlan` — план отката;
- `validationRules` — правила валидации;
- `safetyBounds` — границы безопасности.

---

## 8. Tool Invocation

Tool Invocation — это механизм вызова инструментов внутри шагов.

### 8.1 Архитектура Tool Invocation

```
Tool Invoker
├── Tool Registry
├── Tool Resolver
├── Parameter Validator
├── Sandbox Executor
├── Result Collector
└── Timeout Watcher
```

### 8.2 Tool Registry

Tool Registry хранит все доступные инструменты с их:

- именем;
- версией;
- схемой входных параметров;
- схемой выходных данных;
- safety classification (safe, moderate, dangerous, critical);
- timeouts (default и maximum);
- resource constraints;
- rollback capability (supported, partially supported, not supported).

### 8.3 Процесс вызова инструмента

1. **Tool Lookup**: найти инструмент в Tool Registry по имени.
2. **Version Check**: проверить совместимость версии.
3. **Parameter Validation**: провалидировать входные параметры по JSON Schema.
4. **Safety Classification Check**: проверить, что инструмент разрешён для данного шага и safety bounds.
5. **Sandbox Preparation**: подготовить изолированное окружение для выполнения.
6. **Execution**: выполнить инструмент в sandbox.
7. **Timeout Monitoring**: отслеживать таймаут выполнения.
8. **Result Capture**: захватить stdout, stderr, exit code, артефакты.
9. **Result Validation**: провалидировать результат по ожидаемой схеме.
10. **Side Effect Detection**: обнаружить и зафиксировать побочные эффекты.
11. **Result Packaging**: упаковать результат в стандартизированный формат.

### 8.4 Safety Classification инструментов

- **Safe:** инструменты только для чтения (чтение файлов, поиск, grep, ls, cat, git log, git status).
- **Moderate:** инструменты, создающие/изменяющие файлы без side effects (write_to_file, mkdir, touch).
- **Dangerous:** инструменты, изменяющие состояние (git commit, npm install, docker build, database migrations).
- **Critical:** инструменты с необратимыми последствиями (git push, npm publish, db:drop, rm -rf, docker push).

Каждый уровень требует соответствующего уровня валидации, approval и sandbox isolation.

### 8.5 Sandbox Execution

Все tool calls выполняются в изолированном окружении:

- ограниченный доступ к файловой системе (только workspace);
- ограниченный доступ к сети (только разрешённые endpoints);
- ограниченные системные ресурсы (CPU, память, диск);
- ограниченное время выполнения (timeout);
- запрет на выполнение произвольного кода без явного разрешения;
- перехват и логирование всех системных вызовов.

### 8.6 Результат Tool Invocation

Результат вызова инструмента включает:

- `toolName` — имя инструмента;
- `toolVersion` — версия;
- `input` — входные параметры;
- `output` — выходные данные;
- `exitCode` — код завершения;
- `duration` — длительность выполнения;
- `stdout` — стандартный вывод;
- `stderr` — стандартный вывод ошибок;
- `artifacts[]` — созданные артефакты;
- `sideEffects[]` — обнаруженные побочные эффекты;
- `status` — `success`, `failure`, `timeout`;
- `errorDetails` — детали ошибки (если есть).

---

## 9. Agent Coordination

Agent Coordination отвечает за управление AI-агентами, которые исполняют AI Tasks.

### 9.1 Модель агента

Агент — это исполняемая сущность, представляющая конкретную роль:

- `Developer Agent` — агент, пишущий код;
- `Reviewer Agent` — агент, выполняющий review;
- `Analyzer Agent` — агент, анализирующий код;
- `Fixer Agent` — агент, исправляющий ошибки;
- `Refactor Agent` — агент, выполняющий рефакторинг.

Каждый агент имеет:

- `role` — роль агента;
- `capabilities[]` — список способностей;
- `allowedTools[]` — разрешённые инструменты;
- `boundedContext` — ограниченный контекст (что агент "видит");
- `temperature` — температурный параметр LLM;
- `maxTokens` — максимальное количество токенов;
- `systemPrompt` — системный промпт агента.

### 9.2 Agent Lifecycle

1. **Agent Reservation**: зарезервировать агента для шага.
2. **Context Injection**: передать агенту контекст шага.
3. **Prompt Assembly**: собрать полный промпт, включая:
   - system prompt роли;
   - контекст шага;
   - входные данные;
   - ограничения;
   - ожидаемый формат ответа.
4. **LLM Call**: отправить промпт LLM-провайдеру.
5. **Response Capture**: получить и разобрать ответ.
6. **Validation**: провалидировать ответ агента.
7. **Agent Release**: освободить агента.

### 9.3 Agent Constraints

Агенты работают с жёсткими ограничениями:

- не могут вызывать произвольные инструменты — только те, что разрешены ролью и шагом;
- не могут видеть контекст вне boundedContext;
- не могут принимать архитектурные решения;
- не могут модифицировать план;
- не могут влиять на назначение других агентов;
- обязаны выдавать результат в ожидаемом формате.

### 9.4 AI Task Execution

AI Task — это шаг, выполняемый агентом через LLM.

Процесс выполнения AI Task:

1. **Task Reception**: получить AI Task из Step Executor.
2. **Agent Match**: подобрать подходящего агента.
3. **Prompt Construction**:
   - system prompt: роль, ограничения, правила;
   - task description: что нужно сделать;
   - context: входные данные, состояние workspace, предыдущие результаты;
   - constraints: safety bounds, expected format, forbidden actions;
   - examples: примеры ожидаемого поведения (если применимы).
4. **Provider Call**:
   - выбрать LLM-провайдера согласно конфигурации;
   - отправить запрос;
   - получить ответ.
5. **Response Processing**:
   - распарсить ответ;
   - извлечь структурированные данные;
   - проверить формат.
6. **Action Extraction**:
   - извлечь предлагаемые действия (tool calls, code changes, analysis results);
   - проверить, что действия не выходят за пределы разрешённого.
7. **Validation**:
   - провалидировать ответ согласно validation rules;
   - проверить, что агент не предложил архитектурных изменений;
   - проверить safety constraints.
8. **Result Packaging**:
   - упаковать результат в стандартизированный формат;
   - включить токены, latency, model info.
9. **Completion**: вернуть результат Step Executor.

---

## 10. Parallel Execution

Execution Engine поддерживает параллельное выполнение независимых шагов.

### 10.1 Parallel Groups

Planner определяет группы шагов, которые могут выполняться параллельно:

- шаги в одной группе не имеют зависимостей друг от друга;
- шаги оперируют разными частями workspace;
- шаги не создают конфликтующих изменений.

Parallel Group характеризуется:

- `groupId` — идентификатор группы;
- `steps[]` — шаги группы;
- `maxConcurrency` — максимальная степень параллелизма;
- `strategy` — стратегия (`all` или `any`).

### 10.2 Стратегии параллельного выполнения

#### All Strategy

- все шаги в группе должны завершиться успешно;
- если любой шаг падает — группа падает;
- rollback для группы включает rollback всех шагов группы.

#### Any Strategy

- группа завершается, как только любой шаг успешен;
- остальные шаги отменяются;
- используется для конкурентных альтернативных подходов.

### 10.3 Parallel Scheduler

Parallel Scheduler отвечает за:

1. **Dependency Resolution**: проверка, что все зависимости группы удовлетворены.
2. **Resource Allocation**: выделение ресурсов под параллельные шаги (workspace isolation, agent instances).
3. **Concurrency Control**: ограничение параллелизма согласно maxConcurrency.
4. **Result Synchronization**: сбор результатов всех параллельных шагов.
5. **Conflict Detection**: обнаружение конфликтов между параллельными шагами.
6. **Group Completion**: определение момента завершения группы согласно стратегии.

### 10.4 Workspace Isolation при параллельном выполнении

Для параллельных шагов Workspace обеспечивает изоляцию:

- каждый параллельный шаг работает в своей workspace sandbox;
- изменения изолированы до завершения группы;
- после завершения группы изменения merge'ятся в основной workspace;
- конфликты при merge разрешаются согласно конфликтной стратегии;
- при конфликте, требующем разрешения, параллельная группа приостанавливается.

---

## 11. Sequential Execution

Последовательное выполнение — это базовый режим для шагов с зависимостями.

### 11.1 Порядок выполнения

Шаги выполняются последовательно, если:

- шаг B зависит от результата шага A (explicit dependency);
- шаги оперируют одной и той же областью workspace;
- порядок важен для корректности (architectural ordering);
- Planner явно указал sequential execution.

### 11.2 Механизм

1. Выполнить шаг полностью (все фазы жизненного цикла).
2. Дождаться успешной валидации результата.
3. Передать результат как вход для следующего шага.
4. Выполнить следующий шаг.

Зависимость выражается через:

```
Step B {
  dependsOn: [Step A],
  input: {
    ...stepInput,
    previousResult: $StepA.output
  }
}
```

### 11.3 Гарантии последовательного выполнения

- шаг не начнётся, пока предыдущий не завершён;
- результат предыдущего шага доступен в контексте следующего;
- сбой на любом шаге останавливает цепочку;
- rollback может быть частичным (только сбойный шаг) или цепочечным (все зависимые шаги).

---

## 12. State Machine выполнения

Execution Engine реализован как конечный автомат (State Machine).

### 12.1 Состояния

```
                    ┌─────────────┐
                    │    INIT     │
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │  PREFLIGHT  │
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
         ┌──────────│ VALIDATING  │──────────┐
         │ error     └──────┬──────┘          │
         │                  │ success         │ error
   ┌─────▼─────┐    ┌──────▼──────┐    ┌──────▼──────┐
   │  ABORTED  │    │   RUNNING   │    │   FAILED    │
   └───────────┘    └──────┬──────┘    └─────────────┘
                           │
          ┌────────────────┼────────────────┐
          │                │                │
   ┌──────▼──────┐  ┌──────▼──────┐  ┌──────▼──────┐
   │  WAITING    │  │  ROLLING    │  │ RECOVERING  │
   │  APPROVAL   │  │   BACK      │  │             │
   └──────┬──────┘  └──────┬──────┘  └──────┬──────┘
          │                │                │
          └────────────────┼────────────────┘
                           │
                    ┌──────▼──────┐
                    │  COMPLETED  │
                    └─────────────┘
```

### 12.2 Переходы

| Из | В | Условие |
|---|---|---|
| INIT | PREFLIGHT | Execution начато |
| PREFLIGHT | VALIDATING | Pre-flight checks пройдены |
| PREFLIGHT | ABORTED | Pre-flight checks failed |
| VALIDATING | RUNNING | Plan валиден |
| VALIDATING | FAILED | Plan невалиден |
| VALIDATING | ABORTED | Abort requested |
| RUNNING | WAITING_APPROVAL | Достигнута точка approval |
| WAITING_APPROVAL | RUNNING | Approval получен |
| WAITING_APPROVAL | ABORTED | Approval отклонён |
| RUNNING | ROLLING_BACK | Step failure, rollback triggered |
| ROLLING_BACK | RUNNING | Rollback завершён, продолжение |
| ROLLING_BACK | FAILED | Rollback неудачен |
| RUNNING | RECOVERING | Infrastructure failure |
| RECOVERING | RUNNING | Recovery успешен |
| RECOVERING | FAILED | Recovery неудачен |
| RUNNING | COMPLETED | Все шаги выполнены |
| RUNNING | ABORTED | Abort requested |

### 12.3 Инварианты

- Состояние сохраняется между перезапусками.
- Переходы атомарны.
- Состояние публикуется как событие при каждом переходе.
- Из ABORTED, FAILED, COMPLETED нет переходов (терминальные состояния).

---

## 13. Retry Strategy

Execution Engine поддерживает настраиваемую стратегию повторных попыток.

### 13.1 Уровни Retry

#### Step-level Retry

- применяется к отдельному шагу;
- настраивается в плане для каждого шага;
- лимитирован по количеству попыток.

#### Group-level Retry

- применяется к параллельной или последовательной группе;
- если группа упала, можно повторить всю группу;
- используется, когда групповой результат атомарен.

#### Pipeline-level Retry

- применяется ко всему выполнению;
- только для infrastructure failures;
- требует сохранения всех чекпоинтов.

### 13.2 Retry Policy

Каждый шаг имеет политику retry:

```
RetryPolicy {
  maxAttempts: number;
  backoffStrategy: "fixed" | "exponential" | "linear";
  initialDelay: duration;
  maxDelay: duration;
  retryableErrors: ["transient", "timeout", "resource_unavailable"];
  nonRetryableErrors: ["validation_failure", "safety_violation", "permanent"];
  retryOnTimeout: boolean;
  retryOnPartialResult: boolean;
}
```

### 13.3 Процесс Retry

1. **Failure Detection**: шаг завершился с ошибкой.
2. **Error Classification**: определить класс ошибки.
3. **Retryability Check**: проверить, является ли ошибка retryable.
4. **Retry Count Check**: проверить, не превышен ли maxAttempts.
5. **Backoff Wait**: ожидание согласно backoff strategy.
6. **Context Reset**: сбросить контекст до состояния checkpoint before.
7. **Re-execute**: выполнить шаг заново.
8. **Result Comparison**: сравнить результат с предыдущей попыткой.
9. **Success/Failure**: зафиксировать итоговый результат.

### 13.4 Когда Retry недопустим

Retry не выполняется, если:

- ошибка классифицирована как `permanent`;
- нарушены safety bounds;
- ошибка является `validation_failure` (результат невалиден, но не из-за transient issue);
- шаг имеет необратимые побочные эффекты, которые нельзя безопасно повторить;
- превышено максимальное количество попыток;
- план явно запрещает retry для данного шага.

---

## 14. Rollback Strategy

Rollback — это механизм возврата состояния после сбоя.

### 14.1 Принципы Rollback

- Rollback не является "отменой" — это явно спланированная процедура возврата.
- Rollback plan создаётся Planner и является частью Execution Plan.
- Execution Engine не придумывает rollback на ходу.
- Rollback может быть частичным или полным.
- Rollback сам может упасть — для этого есть contingency.

### 14.2 Типы Rollback

#### Step Rollback

- откат одного шага;
- восстановление workspace до checkpoint before;
- отмена побочных эффектов шага.

#### Chain Rollback

- откат цепочки зависимых шагов;
- в обратном порядке (последний выполненный шаг откатывается первым);
- восстановление workspace до checkpoint before первого шага цепочки.

#### Group Rollback

- откат параллельной группы;
- откат всех шагов группы, которые успели выполниться;
- разрешение конфликтов между параллельными изменениями.

#### Full Rollback

- откат всего выполнения;
- восстановление workspace до checkpoint start;
- отмена всех изменений.

### 14.3 Rollback Plan

Каждый шаг имеет rollback plan:

```
RollbackPlan {
  type: "revert" | "restore_checkpoint" | "custom";
  revertSteps: [
    { tool: "git", command: "checkout", target: "affected_files" },
    { tool: "file_system", command: "restore", target: "checkpoint_snapshot" }
  ];
  validationAfterRollback: ValidationRule[];
  timeout: duration;
  onRollbackFailure: "abort" | "manual_intervention" | "continue_with_warning";
}
```

### 14.4 Процесс Rollback

1. **Rollback Trigger**: шаг или группа завершилась неудачей.
2. **Scope Determination**: определить scope rollback (step, chain, group, full).
3. **Checkpoint Verification**: проверить наличие и целостность необходимых чекпоинтов.
4. **Rollback Execution**: выполнить revert steps в обратном порядке.
5. **State Verification**: проверить, что состояние соответствует checkpoint.
6. **Validation After Rollback**: провалидировать восстановленное состояние.
7. **Completion**: зафиксировать результат rollback.

### 14.5 Rollback Failure

Если rollback завершился неудачей:

1. Публикуется событие `ROLLBACK_FAILED`.
2. Выполнение приостанавливается.
3. Требуется human intervention.
4. Все последующие шаги блокируются до разрешения ситуации.

---

## 15. Checkpoints

Checkpoints — это сохранённые снимки состояния выполнения.

### 15.1 Назначение Checkpoints

- точка восстановления при сбое;
- точка отсчёта для rollback;
- основа для воспроизводимости выполнения;
- аудит и traceability.

### 15.2 Типы Checkpoints

#### Start Checkpoint

- создаётся на стадии pre-flight;
- фиксирует состояние workspace до начала выполнения.

#### Pre-step Checkpoint

- создаётся перед выполнением каждого шага;
- фиксирует состояние до изменений шага.

#### Post-step Checkpoint

- создаётся после успешного выполнения и валидации шага;
- фиксирует состояние после изменений шага.

#### Approval Checkpoint

- создаётся перед точкой human approval;
- фиксирует состояние перед приостановкой.

#### Failure Checkpoint

- создаётся при сбое;
- фиксирует состояние на момент сбоя для анализа.

### 15.3 Содержимое Checkpoint

```
Checkpoint {
  checkpointId: string;
  executionId: string;
  type: "start" | "pre_step" | "post_step" | "approval" | "failure";
  stepId: string | null;
  timestamp: datetime;
  workspaceSnapshot: {
    fileHashes: Map<path, hash>;
    gitCommit: string;
    configSnapshot: object;
  };
  executionState: {
    completedSteps: string[];
    currentStep: string | null;
    pipelineState: PipelineState;
    retryCounters: Map<stepId, number>;
  };
  metadata: object;
}
```

### 15.4 Управление Checkpoints

- Checkpoints хранятся в persistent storage.
- Старые checkpoints могут удаляться после успешного завершения (согласно retention policy).
- Checkpoints для failed executions сохраняются для анализа.
- Checkpoints versioned (не перезаписываются).

---

## 16. Validation после каждого шага

Validation — это обязательная стадия post-execution каждого шага.

### 16.1 Цели Validation

- удостовериться, что результат шага соответствует ожиданиям;
- обнаружить побочные эффекты;
- предотвратить распространение некорректных изменений;
- убедиться, что safety bounds не нарушены.

### 16.2 Типы Validation

#### Output Validation

- проверка формата и структуры результата;
- проверка наличия обязательных полей;
- проверка типов данных.

#### Semantic Validation

- проверка, что результат имеет смысл в контексте задачи;
- проверка, что AI-ответ не содержит галлюцинаций;
- проверка, что изменения не противоречат архитектуре.

#### Safety Validation

- проверка, что safety bounds не нарушены;
- проверка, что критические файлы не задеты без разрешения;
- проверка, что инструменты не использованы опасным образом.

#### Side Effect Validation

- проверка, что побочные эффекты ожидаемы и разрешены;
- обнаружение неожиданных побочных эффектов;
- проверка, что изменения ограничены разрешённой областью.

#### Integrity Validation

- проверка целостности workspace после изменений;
- проверка, что файлы не повреждены;
- проверка, что зависимости не сломаны.

### 16.3 Validation Rules

Правила валидации определяются Planner в Execution Plan:

```
ValidationRules {
  outputSchema: JSONSchema;
  requiredFields: string[];
  forbiddenPatterns: string[];
  maxFileChanges: number;
  allowedChangeScope: string[];
  criticalFilesUntouchable: string[];
  safetyChecks: SafetyCheck[];
}
```

### 16.4 Результат Validation

Validation возвращает один из трёх результатов:

- **PASS**: шаг успешно провалидирован, можно продолжать.
- **WARN**: шаг содержит предупреждения, но не блокирует pipeline. Требуется acknowledgement.
- **FAIL**: шаг не прошёл валидацию. Pipeline останавливается. Требуется retry, rollback или human intervention.

---

## 17. Event Publishing

Execution Engine публикует события на каждой значимой стадии выполнения.

### 17.1 Принципы

- События публикуются через шину событий (Event Bus).
- Каждое событие имеет тип, timestamp, executionId, и payload.
- События являются неизменяемыми после публикации.
- События упорядочены и idempotent.
- Все события сохраняются как часть Execution Report.

### 17.2 Каталог событий Execution Engine

| Событие | Уровень | Момент публикации |
|---|---|---|
| `EXECUTION_STARTED` | Pipeline | Начало выполнения |
| `EXECUTION_PREFLIGHT_PASSED` | Pipeline | Pre-flight checks пройдены |
| `EXECUTION_PREFLIGHT_FAILED` | Pipeline | Pre-flight checks failed |
| `EXECUTION_VALIDATION_PASSED` | Pipeline | Plan validation пройдена |
| `EXECUTION_VALIDATION_FAILED` | Pipeline | Plan validation failed |
| `EXECUTION_PIPELINE_STATE_CHANGED` | Pipeline | Изменение состояния pipeline |
| `EXECUTION_STEP_STARTED` | Step | Начало выполнения шага |
| `EXECUTION_STEP_PROGRESS` | Step | Прогресс внутри шага |
| `EXECUTION_STEP_COMPLETED` | Step | Успешное завершение шага |
| `EXECUTION_STEP_FAILED` | Step | Сбой шага |
| `EXECUTION_STEP_RETRYING` | Step | Повторная попытка шага |
| `EXECUTION_STEP_ROLLED_BACK` | Step | Откат шага |
| `EXECUTION_STEP_VALIDATION_PASSED` | Step | Validation шага пройдена |
| `EXECUTION_STEP_VALIDATION_FAILED` | Step | Validation шага failed |
| `EXECUTION_TOOL_CALL_STARTED` | Tool | Начало tool invocation |
| `EXECUTION_TOOL_CALL_COMPLETED` | Tool | Tool call завершён |
| `EXECUTION_TOOL_CALL_FAILED` | Tool | Tool call failed |
| `EXECUTION_AI_TASK_STARTED` | AI | Начало AI Task |
| `EXECUTION_AI_TASK_COMPLETED` | AI | AI Task завершён |
| `EXECUTION_AI_TASK_FAILED` | AI | AI Task failed |
| `EXECUTION_APPROVAL_REQUIRED` | Approval | Требуется human approval |
| `EXECUTION_APPROVAL_GRANTED` | Approval | Human approval получен |
| `EXECUTION_APPROVAL_REJECTED` | Approval | Human approval отклонён |
| `EXECUTION_ROLLBACK_STARTED` | Rollback | Начало rollback |
| `EXECUTION_ROLLBACK_COMPLETED` | Rollback | Rollback завершён |
| `EXECUTION_ROLLBACK_FAILED` | Rollback | Rollback failed |
| `EXECUTION_CHECKPOINT_CREATED` | System | Чекпоинт создан |
| `EXECUTION_RECOVERY_STARTED` | System | Начало recovery |
| `EXECUTION_RECOVERY_COMPLETED` | System | Recovery завершён |
| `EXECUTION_RECOVERY_FAILED` | System | Recovery failed |
| `EXECUTION_WARNING` | System | Предупреждение |
| `EXECUTION_ERROR` | System | Ошибка |
| `EXECUTION_COMPLETED` | Pipeline | Выполнение успешно завершено |
| `EXECUTION_FAILED` | Pipeline | Выполнение завершено с ошибкой |
| `EXECUTION_ABORTED` | Pipeline | Выполнение прервано |
| `EXECUTION_REPORT_GENERATED` | Pipeline | Execution Report сформирован |

### 17.3 Структура события

```
ExecutionEvent {
  eventId: string;
  eventType: ExecutionEventType;
  executionId: string;
  planId: string;
  taskId: string;
  stepId: string | null;
  timestamp: datetime;
  sequence: number;
  payload: object;
  metadata: {
    source: "execution_engine";
    version: string;
    correlationId: string;
  };
}
```

---

## 18. Logging

Execution Engine ведёт детальное логирование всех операций.

### 18.1 Уровни логирования

- **TRACE**: пошаговые детали выполнения внутри шага (tool calls, AI prompts, промежуточные результаты);
- **DEBUG**: технические детали для отладки (state transitions, параметры);
- **INFO**: основные вехи выполнения (step started/completed, pipeline state changes);
- **WARN**: предупреждения (retry, деградация, неожиданные, но не критические ситуации);
- **ERROR**: ошибки (step failure, validation failure, tool failure, rollback failure);
- **FATAL**: критические сбои (pipeline crash, unrecoverable state).

### 18.2 Структура лог-записи

```
ExecutionLogEntry {
  logId: string;
  executionId: string;
  stepId: string | null;
  toolCallId: string | null;
  aiTaskId: string | null;
  level: LogLevel;
  message: string;
  timestamp: datetime;
  context: {
    pipelineState: PipelineState;
    stepState: StepState | null;
    agentId: string | null;
  };
  data: object | null;
  error: {
    message: string;
    stack: string;
    classification: ErrorClass;
  } | null;
}
```

### 18.3 Принципы логирования

- каждый лог имеет correlationId для связывания событий в цепочку;
- логирование не влияет на производительность выполнения (асинхронное);
- логи хранятся в структурированном формате (JSON);
- логи содержат достаточно информации для полного воспроизведения выполнения;
- логи не содержат секретов и чувствительных данных.

---

## 19. Observability

Execution Engine обеспечивает полную наблюдаемость выполнения.

### 19.1 Метрики

Execution Engine собирает следующие метрики:

#### Pipeline-метрики

- `execution_duration_total` — общая длительность выполнения;
- `execution_state_duration{state}` — длительность в каждом состоянии;
- `steps_total{status}` — количество шагов по статусам;
- `steps_duration_avg` — средняя длительность шага;
- `retries_total` — общее количество retry;
- `rollbacks_total` — общее количество rollback;
- `failures_total{class}` — количество сбоев по классам.

#### Step-метрики

- `step_duration` — длительность шага;
- `step_retry_count` — количество retry для шага;
- `step_tool_calls_count` — количество tool calls внутри шага;
- `step_ai_tasks_count` — количество AI Tasks внутри шага;
- `step_validation_duration` — длительность валидации.

#### Tool-метрики

- `tool_call_duration{tool}` — длительность вызова инструмента;
- `tool_call_count{tool}` — количество вызовов по инструментам;
- `tool_call_errors{tool}` — количество ошибок по инструментам.

#### AI-метрики

- `ai_task_duration{provider,model}` — длительность AI Task;
- `ai_task_tokens{prompt,completion}` — использование токенов;
- `ai_task_cost{provider,model}` — стоимость вызова;
- `ai_task_latency{provider,model}` — latency вызова.

### 19.2 Трассировка

- каждый execution имеет traceId;
- каждый шаг имеет spanId;
- каждый tool call и AI Task имеют spanId внутри родительского step span;
- трассы экспортируются в OpenTelemetry-совместимый формат;
- полная трасса выполнения доступна в Execution Report.

### 19.3 Health Checks

Execution Engine предоставляет:

- pipeline health: текущее состояние, прогресс, ETA;
- step health: состояние текущего шага, длительность, retry count;
- agent health: доступность агентов, нагрузка;
- tool health: доступность инструментов, error rate;
- provider health: доступность LLM-провайдеров, latency, error rate.

---

## 20. Failure Recovery

Failure Recovery — это механизм восстановления после сбоев.

### 20.1 Классы сбоев

#### Transient Failure

- временная недоступность ресурса;
- сетевая ошибка;
- timeout.

Стратегия: retry с backoff.

#### Permanent Failure

- валидационная ошибка;
- нарушение safety bounds;
- инструмент вернул ожидаемую ошибку.

Стратегия: rollback, затем либо abort, либо replanning.

#### Infrastructure Failure

- отказ базы данных;
- отказ файловой системы;
- отказ внешнего сервиса.

Стратегия: сохранение состояния, graceful shutdown, recovery при перезапуске.

#### State Corruption

- повреждение execution state;
- потеря checkpoint;
- неконсистентное состояние workspace.

Стратегия: остановка, human intervention.

### 20.2 Recovery Process

1. **Failure Detection**: обнаружение сбоя.
2. **State Preservation**: сохранение текущего состояния (failure checkpoint).
3. **Classification**: классификация сбоя.
4. **Isolation**: изоляция сбойного компонента.
5. **Recovery Strategy Selection**: выбор стратегии на основе класса сбоя.
6. **Recovery Execution**:
   - для transient: retry после backoff;
   - для permanent: rollback и уведомление Planner;
   - для infrastructure: ожидание восстановления сервиса, переподключение;
   - для state corruption: human intervention.
7. **State Restoration**: восстановление состояния из checkpoint.
8. **Resume**: продолжение выполнения с прерванного места.

### 20.3 Recovery Constraints

- Recovery не должен приводить к дублированию уже выполненных шагов (идемпотентность).
- Recovery не должен терять результаты успешно выполненных шагов.
- Recovery должен сохранять полную traceability.
- Recovery должен публиковать события о процессе восстановления.

---

## 21. Human Approval Points

Execution Engine обрабатывает точки human approval, определённые в плане.

### 21.1 Обнаружение Approval Point

При переходе к шагу, помеченному как `requiresApproval`, Execution Engine:

1. приостанавливает pipeline (состояние `WAITING_APPROVAL`);
2. создаёт approval checkpoint;
3. публикует событие `EXECUTION_APPROVAL_REQUIRED`;
4. ожидает внешнего сигнала.

### 21.2 Approval Request

Событие `EXECUTION_APPROVAL_REQUIRED` содержит:

```
ApprovalRequest {
  executionId: string;
  stepId: string;
  reason: string;
  blockingScope: string[];
  options: [
    { action: "approve", consequences: "..." },
    { action: "reject", consequences: "..." },
    { action: "skip", consequences: "..." }
  ];
  context: {
    whatWillBeDone: string;
    whatIsAtRisk: string;
    whyApprovalRequired: string;
  };
  expiresAt: datetime | null;
}
```

### 21.3 Реакция на Approval Outcome

- **Approved**: pipeline продолжается, шаг выполняется.
- **Rejected**: шаг пропускается или pipeline абортируется (согласно плану).
- **Modified**: шаг выполняется с изменёнными параметрами.
- **Expired**: если approval имеет срок и он истёк — считается rejected.

### 21.4 Гарантии

- Ни один шаг, требующий approval, не будет выполнен без явного положительного ответа.
- Approval outcome фиксируется в Execution Report.
- Approval checkpoint позволяет восстановить состояние до approval, если потребуется.

---

## 22. Безопасность выполнения

Execution Engine обеспечивает безопасность на всех уровнях.

### 22.1 Safety Bounds

Каждый план определяет safety bounds:

- `allowedTools` — разрешённые инструменты;
- `allowedWorkspacePaths` — разрешённые пути в workspace;
- `forbiddenPatterns` — запрещённые паттерны (например, не трогать `*.config.ts`);
- `maxChangesPerStep` — максимальное количество изменений за шаг;
- `maxFileSize` — максимальный размер файла для изменений;
- `forbiddenOperations` — запрещённые операции (rm, force push, etc.).

Execution Engine проверяет каждый шаг и каждый tool call на соответствие safety bounds.

### 22.2 Sandbox Isolation

- Tool calls выполняются в sandbox с ограниченными правами.
- AI Tasks не имеют прямого доступа к файловой системе — только через разрешённые инструменты.
- Каждый шаг имеет ограниченный scope workspace.

### 22.3 Prompt Injection Protection

- AI-промпты строятся из trusted templates.
- Пользовательский контент санитизируется перед включением в промпты.
- Агенты не имеют доступа к системным промптам других агентов.

### 22.4 Output Sanitization

- Результаты AI Tasks проверяются на наличие вредоносного кода.
- Выходные данные валидируются перед записью в workspace.
- Логи фильтруются от чувствительной информации.

### 22.5 Access Control

- Execution Engine работает от имени ограниченного системного пользователя.
- Доступ к внешним ресурсам контролируется (сетевые политики, firewall).
- Критические операции требуют подтверждения на уровне инструмента.

---

## 23. Ограничения

### 23.1 Execution Engine не должен

- модифицировать Execution Plan;
- принимать архитектурные решения;
- игнорировать validation failures;
- пропускать approval points;
- выполнять шаги без rollback plan;
- обходить safety bounds;
- самостоятельно выбирать инструменты вне плана;
- изменять scope задачи;
- выполнять исследование кодовой базы;
- формировать новые промпты, не определённые планом;
- назначать агентов, не назначенных планом.

### 23.2 Когда Execution Engine обязан остановиться

Execution Engine должен остановиться, если:

- обнаружено нарушение safety bounds;
- validation failed и retry исчерпаны;
- rollback failed;
- approval rejected;
- обнаружена циклическая зависимость;
- состояние workspace не соответствует ожидаемому snapshot;
- обнаружена попытка выполнения неавторизованной операции;
- ресурсы исчерпаны (диск, память);
- потеряна связь с критическим сервисом.

В этих случаях Execution Engine переходит в состояние `FAILED` или `ABORTED` и уведомляет Planner и человека.

### 23.3 Почему ограничения критичны

Execution Engine — это последняя линия перед реальными изменениями в проекте. Если Engine выйдет за свои границы:

- изменения станут неконтролируемыми;
- архитектурные решения будут приняты без человеческого участия;
- traceability будет потеряна;
- безопасность будет нарушена;
- доверие к системе будет подорвано.

---

## 24. Будущее развитие

Execution Engine должен эволюционировать, сохраняя свои базовые принципы.

### 24.1 Что должно легко добавляться

- новые стратегии параллельного выполнения;
- более сложные политики retry (circuit breaker, adaptive backoff);
- richer validation rules engine;
- улучшенная conflict resolution для параллельных шагов;
- streaming execution (live progress для каждого tool call);
- расширенная observability (распределённая трассировка между модулями);
- support для распределённого выполнения (multiple workers);
- plugin system для пользовательских tool executors;
- richer approval workflows;
- execution replay для отладки и аудита;
- predictive failure detection (раннее предупреждение о потенциальных сбоях).

### 24.2 Что не должно меняться

- Execution Engine не принимает архитектурных решений;
- Execution Engine не модифицирует план;
- каждый шаг имеет rollback plan;
- validation обязателен после каждого шага;
- safety bounds обязательны;
- все действия traceable и воспроизводимы;
- план остаётся единственным источником истины для выполнения.

### 24.3 Стратегический результат

Зрелый Execution Engine — это исполняющая среда, которая:

- гарантирует, что утверждённый план будет выполнен безопасно и предсказуемо;
- обеспечивает полную наблюдаемость и воспроизводимость;
- обрабатывает сбои и восстанавливает выполнение без потери данных;
- защищает проект от неконтролируемых изменений;
- служит надёжным фундаментом для всей системы исполнения задач.

Execution Engine — это не место для принятия решений. Это место, где решения превращаются в реальность безопасно, наблюдаемо и контролируемо.