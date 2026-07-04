// ---- Форматирование времени и текста сообщений ------------------------------

export function formatTime(iso?: string): string {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

// Превращает сырой текст в безопасный HTML с <br> вместо переносов и оборачивает
// системные/статусные сообщения в соответствующие спаны для стилей.
export function formatMessageContent(item: any): string {
  if (!item.content) return "";
  let content = String(item.content);
  content = content.replace(/\\n/g, "\n");
  const escaped = content
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, "<br>");
  if (item.type === "agent-status") return `<span class="agent-status-text">${escaped}</span>`;
  if (item.type === "system") return `<span class="system-text">${escaped}</span>`;
  if (item.type === "run-summary") return `<div class="run-summary-text">${escaped}</div>`;
  return escaped;
}
