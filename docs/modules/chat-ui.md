# Chat UI

**Статус:** Product UX Specification  
**Автор:** Head of Product Design / Principal UI/UX Review  
**Дата:** 2026-07-10  
**Версия:** 1.0.0  

---

## 1. Назначение

Этот документ фиксирует целевой UX/UI для основного экрана Client.

Цель интерфейса:

- сократить время понимания легаси-проекта;
- сделать `Chat` главным и почти единственным рабочим пространством;
- спрятать сложность pipeline и внутренних артефактов за спокойным продуктовым интерфейсом;
- создать ощущение коммерческого инструмента уровня `ChatGPT Desktop`, `Cursor`, `Linear`, `Raycast`, `Arc`, а не внутренней инженерной консоли.

Документ не меняет backend, pipeline и архитектурные модули.
Он меняет только пользовательскую подачу.

---

## 2. Главный Сценарий

Основной сценарий продукта:

1. Пользователь открывает Client.
2. Выбирает проект.
3. При необходимости уточняет path, provider и model.
4. Пишет вопрос.
5. Читает ответ.
6. При желании открывает Inspector.
7. Закрывает продукт или задаёт следующий вопрос.

Все элементы главного экрана обязаны обслуживать именно этот сценарий.

Если элемент не помогает одному из этих действий, он:

- переносится в Inspector;
- скрывается за secondary interaction;
- или убирается с chat screen.

---

## 3. Layout Главного Окна

### 3.1 Верхняя Панель

Высота: `56 px`.

Содержимое:

- слева: `Client`
- справа: `Проекты`, `Провайдеры`

Назначение:

- закрепить идентичность продукта;
- дать редкий доступ к вторичным настройкам;
- не конкурировать с чатом.

### 3.2 Левая История

Ширина:

- `76 px` в compact-состоянии;
- `248 px` в expanded-состоянии.

Содержимое:

- `Новый чат`
- список последних вопросов
- снизу текущий проект

Назначение:

- возвращать пользователя к предыдущим вопросам;
- не превращаться в navigation-heavy IDE sidebar.

### 3.3 Центральная Колонка

Основная рабочая колонка:

- ширина `760–860 px`;
- по центру экрана;
- только одна главная ось внимания.

Внутри:

- compact environment strip
- empty state или transcript
- AI answer
- composer

### 3.4 Правая Зона

Постоянной правой панели нет.

Inspector открывается как `right drawer` поверх контента.

Назначение:

- сохранить глубину;
- не загромождать экран;
- не превращать интерфейс в operator console.

---

## 4. Chat Screen

### 4.1 Общая Иерархия

Порядок блоков сверху вниз:

1. Compact environment strip
2. Empty state или transcript
3. AI answer

### 4.2 Поведение во время thinking-run

Если проект находится в активном long-running thinking/research цикле, интерфейс должен вести себя как chat с AI-агентом, а не как форма со множеством параллельных действий.

Обязательные правила:

1. Основной composer показывает, что система думает, и не создаёт конкурирующий второй run поверх первого.
2. Быстрая смена проекта, path, provider и model должна быть заблокирована до завершения активного run.
3. Кратковременный timeout polling-запроса статуса не должен визуально интерпретироваться как "run упал", если нет подтверждённого failed-state от backend.
4. Пользователь должен видеть живой текущий stage и иметь возможность открыть подробности через Inspector, не теряя основной chat-first поверхности.

Такой режим особенно важен для больших репозиториев, где question-run может legitimately занимать заметное время даже при selective/baseline-driven execution.
4. Composer

Все системные статусы являются вторичными.

### 4.2 Environment Strip

Формат:

- ряд compact pills/dropdowns;
- высота элементов `36 px`;
- визуально тихий.

Элементы:

- `Project`
- `Path`
- `Provider`
- `Team` (реализовано 2026-07-15: заменил отдельный выбор модели — Team назначает модель сразу на три роли, Researcher/Critic/Observer, см. `docs/modules/provider-system.md` §10.6)
- справа status pill проекта

Пример:

`[ Magenda ] [ Backend ] [ Rout ] [ Проверенная тройка ] [ Карта актуальна ]`

Чего не должно быть:

- высоких form labels;
- толстых toolbars;
- нескольких строк controls;
- ощущения CRUD form.

### 4.3 Empty State

Содержимое:

- один сильный заголовок;
- одна короткая поясняющая строка;
- 3 suggested prompts.

Пример смысловой подачи:

- заголовок: `Понимание проекта за минуты, а не за часы`
- подзаголовок: `Client использует уже собранную карту проекта и помогает быстрее понять entrypoints, связи, риски и план изменений.`

### 4.4 Message Geometry

Параметры:

- расстояние между сообщениями: `18 px`
- padding AI answer container: `20 px`
- padding user bubble: `16–18 px`
- line-height body text: `1.6`

Пользователь:

- правый компактный bubble
- спокойный tinted background

AI:

- широкий calm container
- акцент на текст, а не на box chrome

### 4.5 Composer

Composer должен быть сильнейшим интерактивным элементом экрана.

Параметры:

- min-height: `64 px`
- max comfortable height before scroll: `160 px`
- radius: `20 px`
- fixed visual anchor near bottom

Содержимое:

- multiline input
- primary action `Получить ответ`
- тихая подпись состояния:
  - `Карта проекта актуальна`
  - `Идёт обновление`
  - `Есть локальные изменения`

Не должно быть:

- технического текста о baseline/overlay;
- перегруженного служебного статуса;
- нескольких конкурирующих CTA.

---

## 5. Answer UX

### 5.1 Что Видно Сразу

Сразу виден только:

- заголовок-суть ответа;
- основной человеческий текст;
- при необходимости короткий список;
- compact metrics row.

### 5.2 Compact Metrics Row

Сохраняется в чате как secondary block:

- `Ответ`
- `Impact`
- `Context`
- `Plan`

Например:

- `Ответ — 72% уверенность`
- `Impact — 71% уверенность`
- `Context — 365 токенов`
- `Plan — 8 шагов`

### 5.3 Сохраняемые Блоки

В чате остаются:

- `Ограничения`
- `План реализации`
- кнопки:
  - `Почему я так ответил`
  - `Открыть исследование`
  - `Посмотреть план`
  - `Execution preview`

### 5.4 Что Убирается Из Основного Ответа

Из chat bubble убирается:

- provenance narrative;
- baseline / overlay technical wording;
- raw evidence lists;
- confirmed/unconfirmed/manual-check blocks;
- diagnostics noise;
- любые внутренние lists, которые читаются как report dump.

---

## 6. Inspector

### 6.1 Формат

Inspector должен быть `right drawer`.

Параметры:

- ширина `480–560 px`
- overlay поверх интерфейса
- мягкий backdrop
- независимый scroll

### 6.2 Поведение

Обычный пользователь заходит редко.

Inspector открывается только по явным действиям:

- `Почему я так ответил`
- `Открыть исследование`
- `Посмотреть план`
- `Execution preview`

### 6.3 Вкладки

Оставить:

- Overview
- Research
- Impact
- Context
- Plan
- Execution
- Knowledge
- Git
- Diagnostics

Но по умолчанию это не главный UI, а deep layer.

---

## 7. Pipeline Progress

Pipeline нельзя показывать как CI.

Правильная подача:

- inline thinking block внутри AI message;
- human-readable labels;
- спокойный вертикальный список.

Показываем:

- текущую стадию
- 2–5 ближайших состояний

Не показываем на главном экране как primary grid:

- technical stage ids;
- полный внутренний оркестрационный шум.

---

## 8. Background Sync

На chat screen пользователь должен видеть только простые состояния:

- `Карта проекта актуальна`
- `Обновляю карту проекта`
- `Нужно обновить карту`
- `Есть локальные изменения`

Нельзя выводить наружу как first-class UI:

- exact-head
- baseline source
- reusable file count
- fingerprints
- technical repository phrasing

---

## 9. History

История должна выглядеть как lightweight chat history.

Каждый item:

- одна строка title
- одна строка meta

Meta:

- проект
- время
- status dot

Никаких длинных summaries.

---

## 10. Состояния

### Loading

- skeleton в зоне ответа
- selectors остаются читаемыми

### Streaming

- ответ появляется постепенно
- progress схлопывается по мере готовности

### Long Running

- мягкий copy shift после `8–10 sec`
- без alarming tone

### Partial

- маленькая amber note

### Stale

- quiet stale pill

### Syncing

- animated status pill

### Failed

- короткий человеческий error block
- `Повторить`
- `Открыть детали`

### Offline

- top subtle banner

---

## 11. Visual Language

### Typography

- большой заголовок продукта: `28–32 px`
- section titles: `20 px`
- body: `16 px`
- secondary/meta: `14 px`
- micro meta: `12 px`

### Spacing

Основной ритм:

- `8`
- `12`
- `16`
- `24`
- `32`

### Radius

- pills: `999 px`
- inputs: `20 px`
- cards: `24 px`
- drawer: `28–30 px`

### Color

Тон:

- тёплый светлый нейтрал
- графитовый текст
- мягкий синий accent
- мягкий amber caution
- мягкий green healthy state

### Shadows

- очень мягкие
- depth, а не heavy card chrome

### Density

- medium-compact
- рассчитано на `8 часов` ежедневной работы

---

## 12. Дизайн-Принципы

1. `Chat first`
2. `Ответ важнее статусов`
3. `Environment, а не form`
4. `Inspector по запросу`
5. `Одна колонка внимания`
6. `Меньше карточек`
7. `Меньше одинаковой важности`
8. `Тишина важнее демонстрации сложности`

---

## 13. Реализационный Фокус

Первый UX iteration должен сделать только следующее:

1. Перевести chat screen в layout `sidebar + center column + drawer`.
2. Сжать project/provider/model controls до compact environment strip.
3. Убрать системный шум из главного экрана.
4. Сохранить нужные secondary blocks ответа.
5. Сделать Inspector вторичным слоем.
6. Не менять backend, pipeline и архитектуру.
