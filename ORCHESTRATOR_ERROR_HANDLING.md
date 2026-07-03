# Обработка ошибок оркестратора: "Developer did not return any file changes"

## Проблема

Когда разработчик (Developer агент) не возвращает никаких изменений файлов для задачи, которая требует конкретных изменений кода, система выдавала ошибку:

```
Developer did not return any file changes for a code task.
```

Проблема заключалась в том, что **оркестратор не мог показать пользователю контекст этой ошибки** - все собранные данные (анализ, токен-использование, причины блокировки) теряются.

## Решение

### 1. Сохранение частичного отчета перед ошибкой (runs.service.ts)

Когда разработчик не возвращает операции изменения файлов для задачи, требующей конкретных изменений:

```typescript
// Генерируем partial report со всеми собранными данными
const partialReport = {
  runId: run.id,
  projectPath: run.projectPath,
  task: run.task,
  approvals: { testerStatus: "blocked" },
  orchestrator: orchestrator.artifact,
  analyst: analyst.artifact,
  developer: developer.artifact,
  tester: null,
  orchestratorResponse: {
    message: "Developer did not return any file changes for a code task.",
    error: "blocked_no_file_changes",
    summary: developer.artifact?.summary,
    details: developer.artifact?.notes || [],
  },
  applyResult: { applied: [], skipped: [] },
  usageSummary, // ✅ Включаем информацию об использовании токенов
  projectMemoryUsed: [...],
  generatedAt: new Date().toISOString(),
};

// Сохраняем отчет в файл, чтобы он был доступен пользователю
await this.writeArtifact(runRoot, "final-report.json", partialReport);

// Отправляем сообщение в чат с полной информацией об ошибке
await this.chatsService.addMessage(chat.id, "assistant", 
  `Ошибка запуска: Developer did not return any file changes for a code task.\n\n${developer.artifact?.summary}\n\n${developer.artifact?.notes.join("\n")}`,
  {
    type: "run-error",
    runId: run.id,
    usageSummary, // ✅ Информация об использовании токенов доступна
  }
);
```

### 2. Новый эндпоинт для подробного резюме (runs.controller.ts)

Добавлен эндпоинт `GET /runs/:id/summary`, который показывает пользователю всю ключевую информацию:

```typescript
@Get("runs/:id/summary")
async getRunSummary(@Param("id") id: string) {
  // Возвращает структурированную информацию:
  return {
    task: "исходная задача",
    status: "failed|done|running",
    error: "причина ошибки если есть",
    
    orchestrator: {
      goal: "цель оркестратора",
      message: "сообщение пользователю",
      teamSummary: ["что делала команда"],
      risks: ["возможные риски"],
      nextSteps: ["следующие действия"],
    },
    
    teamWork: {
      analyst: {
        executed: true,
        summary: "анализ аналитика",
        findings: ["выводы"],
      },
      developer: {
        executed: true,
        summary: "результат разработчика",
        operationsCount: 5,
        notes: ["примечания разработчика"],
      },
      tester: {
        executed: false,
        status: "not_requested",
      },
    },
    
    tokenUsage: {
      totalActualTokens: 38119,
      totalWeightedTokens: 43223,
      byAgent: {
        orchestrator: {
          model: "openai/gpt-5.4-mini",
          multiplier: 0.8,
          calls: 2,
          actualTokens: 7894,
          weightedTokens: 6316,
        },
        analyst: {
          model: "deepseek/deepseek-v4-pro",
          multiplier: 0.7,
          calls: 1,
          actualTokens: 10723,
          weightedTokens: 7507,
        },
        // ... другие агенты
      },
    },
    
    fileChanges: {
      applied: 8,
      skipped: 0,
      details: {
        applied: [
          {
            path: "apps/api/src/persistence/task.entity.ts",
            action: "update",
            reason: "...",
          },
        ],
        skipped: [],
      },
    },
  };
}
```

## Преимущества

✅ **Полная видимость**: Пользователь видит все, что произошло в процессе выполнения  
✅ **Анализ токен-использования**: Понимает, сколько и где потратили ресурсы  
✅ **Контекст ошибки**: Знает, почему разработчик не вернул изменения  
✅ **Информация от аналитика**: Видит анализ и рекомендации  
✅ **История попыток**: Может увидеть все попытки и их результаты  

## Примеры использования

### Когда разработчик заблокирован (нет данных):
```bash
curl http://localhost:3000/runs/run-1783063063891/summary

# Ответ включит:
# - Сообщение блокировки от разработчика
# - Анализ аналитика (если был)
# - Информацию об использованных токенах
# - Указание на то, какие данные нужны для продолжения
```

### Когда разработчик вернул изменения:
```bash
curl http://localhost:3000/runs/run-1783062011983/summary

# Ответ включит:
# - Список всех применённых изменений (8 файлов)
# - Детальное использование токенов по агентам
# - Результаты тестирования (если были)
# - Финальное сообщение от оркестратора
```

## Как это решает проблему пользователя

Пользователь спрашивал: "почему аркестартор не может мне показать эти записи? он же должен мочь все"

Теперь оркестратор **действительно может** показать всё:
1. Сохраняет полный контекст выполнения даже при ошибке
2. Выставляет эндпоинт `/runs/:id/summary` для доступа к полной информации
3. Включает детальное использование токенов по каждому агенту
4. Предоставляет информацию о всех попытках и причинах блокировок

## Интеграция с фронтенд-приложением

Фронтенд может теперь использовать этот эндпоинт для отображения:
- Прогресс-бара с информацией об используемых токенах
- Детальный лог работы команды
- Информацию об ошибках с контекстом
- Список применённых изменений
