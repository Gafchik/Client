export interface ParseJsonResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  rawResponse: string;
}

/**
 * Пытается распарсить JSON из ответа LLM с несколькими стратегиями fallback.
 * Не выбрасывает исключений, возвращает структурированный результат.
 */
export function parseJsonSafely<T = unknown>(rawResponse: string): ParseJsonResult<T> {
  if (!rawResponse || typeof rawResponse !== 'string') {
    return {
      success: false,
      error: 'Empty or invalid response',
      rawResponse: String(rawResponse ?? ''),
    };
  }

  const trimmed = rawResponse.trim();
  if (!trimmed) {
    return {
      success: false,
      error: 'Empty response after trim',
      rawResponse,
    };
  }

  // Стратегия 1: прямой JSON.parse
  try {
    const parsed = JSON.parse(trimmed);
    return { success: true, data: parsed as T, rawResponse };
  } catch {
    // игнорируем, пробуем следующие стратегии
  }

  // Стратегия 2: извлечение из markdown-блока ```json ... ``` или ``` ... ```
  const markdownMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (markdownMatch?.[1]) {
    try {
      const parsed = JSON.parse(markdownMatch[1].trim());
      return { success: true, data: parsed as T, rawResponse };
    } catch {
      // игнорируем
    }
  }

  // Стратегия 3: поиск первого валидного JSON-объекта в тексте (баланс скобок)
  const extracted = extractFirstJsonObject(trimmed);
  if (extracted) {
    try {
      const parsed = JSON.parse(extracted);
      return { success: true, data: parsed as T, rawResponse };
    } catch {
      // игнорируем
    }
  }

  // Стратегия 4: попытка исправить частые ошибки (одинарные кавычки, trailing commas)
  const fixed = tryFixCommonJsonErrors(trimmed);
  if (fixed !== trimmed) {
    try {
      const parsed = JSON.parse(fixed);
      return { success: true, data: parsed as T, rawResponse };
    } catch {
      // игнорируем
    }
  }

  return {
    success: false,
    error: 'Failed to parse JSON after all fallback strategies',
    rawResponse,
  };
}

/**
 * Извлекает первый валидный JSON-объект из текста по балансу скобок.
 * Возвращает строку с JSON или null, если не найдено.
 */
function extractFirstJsonObject(text: string): string | null {
  let start = -1;
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (escape) {
      escape = false;
      continue;
    }

    if (ch === '\\') {
      escape = true;
      continue;
    }

    if (ch === '"' && !escape) {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start !== -1) {
          return text.slice(start, i + 1);
        }
      }
    }
  }

  return null;
}

/**
 * Пытается исправить частые ошибки в JSON от LLM.
 */
function tryFixCommonJsonErrors(text: string): string {
  let fixed = text;

  // Заменяем одинарные кавычки на двойные (только вне строк)
  // Простая эвристика: заменяем 'key': на "key":
  fixed = fixed.replace(/('\w+'\s*:)/g, (m) => m.replace(/'/g, '"'));

  // Удаляем trailing commas перед } или ]
  fixed = fixed.replace(/,(\s*[}\]])/g, '$1');

  // Удаляем комментарии // ... и /* ... */
  fixed = fixed.replace(/\/\/.*$/gm, '');
  fixed = fixed.replace(/\/\*[\s\S]*?\*\//g, '');

  return fixed;
}

/**
 * Устаревшая функция для обратной совместимости.
 * @deprecated Используйте parseJsonSafely
 */
export function parseJsonOrThrow<T = unknown>(rawResponse: string): T {
  const result = parseJsonSafely<T>(rawResponse);
  if (!result.success) {
    throw new Error(`${result.error}: ${result.rawResponse.slice(0, 200)}`);
  }
  return result.data as T;
}

/**
 * Алиас для обратной совместимости - возвращает распарсенный объект или дефолтное значение.
 * @deprecated Используйте parseJsonSafely
 */
export function safeJsonParse<T = unknown>(rawResponse: string, defaultValue: T): T {
  const result = parseJsonSafely<T>(rawResponse);
  return result.success && result.data !== undefined ? result.data : defaultValue;
}
