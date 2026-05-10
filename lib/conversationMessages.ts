/**
 * Surreal иногда сохраняет в поле `messages` массив пустых объектов,
 * при этом `messages_raw` содержит корректный JSON — см. scripts/inspect-conversations.mjs.
 */

function textFromContentField(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const chunks: string[] = [];
  for (const item of content) {
    if (typeof item === "string") {
      chunks.push(item);
      continue;
    }
    if (item && typeof item === "object") {
      const t = (item as { text?: unknown }).text;
      if (typeof t === "string") chunks.push(t);
    }
  }
  return chunks.join("");
}

export function parseMessagesRawField(messages_raw: unknown): any[] | null {
  if (typeof messages_raw !== "string" || !messages_raw.trim()) return null;
  try {
    const parsed = JSON.parse(messages_raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Сообщение «битое» для поля messages: нет ни роли, ни текста в ожидаемых местах. */
export function messageLooksCorrupt(m: unknown): boolean {
  if (m == null || typeof m !== "object") return true;
  const o = m as Record<string, unknown>;
  const role = o.role;
  const hasRole = role === "user" || role === "assistant" || role === "system";
  const topText = typeof o.text === "string" ? o.text.trim() : "";
  const strContent = typeof o.content === "string" ? o.content.trim() : "";
  const parts = Array.isArray(o.parts) ? o.parts : [];
  const hasPartText = parts.some(
    (p) =>
      p &&
      typeof p === "object" &&
      String((p as Record<string, unknown>).type) === "text" &&
      typeof (p as Record<string, unknown>).text === "string" &&
      String((p as Record<string, unknown>).text).trim() !== "",
  );
  const arrText = Array.isArray(o.content) ? textFromContentField(o.content).trim() : "";
  const hasPayload = Boolean(topText || strContent || hasPartText || arrText);
  return !hasRole && !hasPayload;
}

export function messagesArrayLooksCorrupt(messages: unknown): boolean {
  if (!Array.isArray(messages) || messages.length === 0) return true;
  return messages.every(messageLooksCorrupt);
}

/** Предпочитает `messages_raw`, если массив `messages` пустой или полностью «пустые» объекты из Surreal. */
export function resolveMessagesFromRecord(messages: unknown, messages_raw: unknown): any[] {
  const arr = Array.isArray(messages) ? messages : [];
  const fromRaw = parseMessagesRawField(messages_raw) ?? [];
  if (fromRaw.length > 0 && messagesArrayLooksCorrupt(arr)) return fromRaw;
  if (arr.length > 0) return arr;
  return fromRaw;
}
