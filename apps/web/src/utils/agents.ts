import type { ChatMessage } from "../types";

// ---- Метаданные агентов для отрисовки аватаров/имен --------------------------
export const AGENT_DISPLAY: Record<string, { name: string; letter: string; cls: string; placeholder: string }> = {
  orchestrator: { name: "Alex (Оркестратор)", letter: "A", cls: "orchestrator", placeholder: "Анализирую задачу и планирую работу команды…" },
  pm: { name: "Mira (PM)", letter: "M", cls: "pm", placeholder: "Изучаю код и составляю техническое задание…" },
  developer: { name: "Kai (Разработчик)", letter: "K", cls: "developer", placeholder: "Пишу код и применяю изменения…" },
  tester: { name: "Nova (Тестировщик)", letter: "N", cls: "tester", placeholder: "Проверяю изменения…" },
};

export function agentDisplay(role: string) {
  return AGENT_DISPLAY[role] || AGENT_DISPLAY.orchestrator;
}

export function avatarColor(role: string): string {
  const colors: Record<string, string> = {
    orchestrator: "#6366f1",
    pm: "#6366f1",
    researcher: "#10b981",
    developer: "#f59e0b",
    coder: "#f59e0b",
    tester: "#ef4444",
    system: "#6b7280",
    user: "#3b82f6",
  };
  return colors[role] || colors.system;
}

export function agentInitial(item: any): string {
  const name = item.name || item.label || "?";
  return name.charAt(0).toUpperCase();
}

// ---- Извлечение человекочитаемого текста из частичного JSON-стрима -----------
// Агенты отвечают JSON-скелетом ({"message":"...","shouldExecute":...}) или
// маркерами (SUMMARY:...). Показывать сырой скелет в чате — некрасиво. Эти
// функции на лету вытягивают читаемое поле из ЧАСТИЧНОГО стрима и прячут
// JSON-обёртку, чтобы в чате был обычный текст «думаю… делаю…».
export function decodeJsonString(s: string): string {
  return s.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

// Вытягивает строковое поле из частичного JSON (строка может быть ещё не закрыта).
export function extractJsonField(raw: string, field: string): string | null {
  const re = new RegExp(`"${field}"\\s*:\\s*"`);
  const m = re.exec(raw);
  if (!m) return null;
  let i = m.index + m[0].length;
  let out = "";
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === "\\" && i + 1 < raw.length) {
      out += ch + raw[i + 1];
      i += 2;
      continue;
    }
    if (ch === '"') break; // закрывающая кавычка строки
    out += ch;
    i++;
  }
  return out ? decodeJsonString(out) : null;
}

// Извлекает читаемый текст из сырого стрима агента по его роли.
export function extractReadableText(role: string, raw: string): string {
  if (!raw) return "";
  if (role === "developer") {
    const m = raw.match(/^[ \t]*SUMMARY:[ \t]*(.+?)$/m);
    return m ? m[1].trim() : "";
  }
  if (role === "orchestrator") {
    return extractJsonField(raw, "message") || "";
  }
  if (role === "pm") {
    return extractJsonField(raw, "description") || extractJsonField(raw, "feature") || "";
  }
  if (role === "tester") {
    const pm = raw.match(/"passed"\s*:\s*(true|false)/);
    if (pm) return pm[1] === "true" ? "Проверяю изменения — явных ошибок пока не вижу." : "Нашёл замечания, формирую отчёт…";
    return "";
  }
  return "";
}

// ---- Актёр события (имя/роль/лейбл) ------------------------------------------
export interface ActorInfo {
  agentName: string;
  label: string;
  role: string;
  detail: string;
  attempt?: number;
}

export function eventActor(payload: unknown): ActorInfo {
  if (!payload || typeof payload !== "object") {
    return { agentName: "Команда", label: "Система", role: "system", detail: "" };
  }
  const meta = payload as { agentName?: string; label?: string; role?: string; detail?: string; attempt?: number };
  return {
    agentName: meta.agentName || "Команда",
    label: meta.label || "Система",
    role: meta.role || "system",
    detail: meta.detail || "",
    attempt: meta.attempt,
  };
}

// Читаемая сводка одного события run для строки активности.
export function formatActivityEntry(entry: { at: string; event: string; payload?: unknown }): string {
  const actor = eventActor(entry.payload);
  switch (entry.event) {
    case "agent:activity":
      return `${actor.agentName} (${actor.label}): ${actor.detail}`;
    case "agent:retry":
      return `${actor.agentName} (${actor.label}): ответ не распарсился, автоповтор ${actor.attempt || "?"}/3`;
    case "agent:retry-success":
      return `${actor.agentName} (${actor.label}): прислал валидный JSON, выполнение продолжено`;
    case "agent:note":
      return `${actor.agentName} (${actor.label}): ${actor.detail}`;
    case "agent:done":
      return `${actor.agentName} (${actor.label}): завершил этап`;
    case "agent:skipped":
      return `${actor.agentName} (${actor.label}): сейчас не задействован`;
    case "developer:empty-operations":
      return `${actor.agentName} (${actor.label}): не вернул правок, получает повторную задачу`;
    case "run:blocked":
      return `${actor.agentName} (${actor.label}): прогон остановлен, нет реальных правок`;
    case "file:processing": {
      const p = entry.payload as { path?: string; action?: string };
      return `Разработчик: ${p?.action === "create" ? "создаёт" : "обновляет"} файл ${p?.path || "-"}`;
    }
    case "file:applied": {
      const p = entry.payload as { path?: string; action?: string };
      return `Разработчик: ${p?.action === "create" ? "создал" : "обновил"} файл ${p?.path || "-"}`;
    }
    case "file:skipped": {
      const p = entry.payload as { path?: string; reason?: string };
      return `Разработчик: пропустил файл ${p?.path || "-"} (${p?.reason || "без причины"})`;
    }
    case "files:applied":
      return "Разработчик применил изменения к файлам";
    case "test:started": {
      const p = entry.payload as { command?: string };
      return `Тестировщик: запускает "${p?.command || ""}"`;
    }
    case "test:finished": {
      const p = entry.payload as { command?: string; success?: boolean; code?: number };
      return `Тестировщик: ${p?.success ? "успешно завершил" : "завершил с ошибкой"} "${p?.command || ""}" (code ${p.code ?? "-"})`;
    }
    case "tests:done":
      return "Тестировщик завершил проверку";
    case "tests:skipped":
      return "Проверка тестировщиком была пропущена";
    default:
      return `Событие: ${entry.event}`;
  }
}

// Имя автора сообщения для заголовка пузыря.
export function messageName(item: any): string {
  if (item.type === "user") return "Вы";
  if (item.type === "assistant" || item.type === "run-summary")
    return `${item.name || "Alex"} (${item.label || "Оркестратор"})`;
  if (item.type === "agent-status") return `${item.name || "Agent"} (${item.label || item.agentRole})`;
  if (item.type === "system") return "Система";
  if (item.type === "token-summary") return "Токены";
  return "Неизвестно";
}

// Последняя activity-фраза для роли (например «Начинаю реализацию по ТЗ»),
// чтобы живой пузырь агента показывал, чем он занят прямо сейчас.
export function latestActivityForRole(
  events: Array<{ at: string; event: string; payload?: unknown }>,
  role: string,
): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.event !== "agent:activity") continue;
    const p = e.payload as any;
    if (p?.role === role) return p?.detail || "";
  }
  return "";
}
