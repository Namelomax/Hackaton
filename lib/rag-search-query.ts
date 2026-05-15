const HIDDEN_BLOCK_RE = /<AI-HIDDEN>[\s\S]*?<\/AI-HIDDEN>/gi;

export const RAG_QUERY_MAX_CHARS = 220;

export function stripTextForRagQuery(input: string): string {
  let s = String(input ?? "");
  s = s.replace(HIDDEN_BLOCK_RE, " ");
  s = s.replace(/\[RAG\][^\n]*/gi, " ");
  s = s.replace(/\[Вложение «[^»]+»[^\]]*\]/g, " ");
  s = s.replace(/\[Файл «[^»]+»[^\]]*\]/g, " ");
  s = s.replace(/полный текст в промпт[^\n.]*/gi, " ");
  s = s.replace(/только имя[^\n.;]*/gi, " ");
  s = s.replace(/включён контекст из RAG[^\n.]*/gi, " ");
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

export const RAG_PROTOCOL_TEN_SECTIONS_RU = `
Протокол обследования — 10 разделов:
1. Номер протокола и дата встречи
2. Повестка встречи (тема, пункты)
3. Участники — заказчик и исполнитель (организации, ФИО, должности)
4. Термины и определения
5. Сокращения и обозначения
6. Содержание встречи (ход обсуждения)
7. Вопросы и ответы
8. Решения (с указанием ответственных)
9. Открытые вопросы
10. Утверждение (подписи сторон)
`.trim();

/** Готовые вопросы для поиска по разделу — используются как fallback. */
export const PROTOCOL_SECTION_RAG_QUESTIONS: Record<number, string> = {
  1: "какой номер протокола, дата и название встречи упоминались в разговоре?",
  2: "какие темы и вопросы планировали обсудить на встрече, о чём была повестка?",
  3: "кто участвовал во встрече, как их зовут, должности и организации заказчика и исполнителя?",
  4: "какие термины и определения участники использовали в разговоре?",
  5: "какие сокращения и обозначения упоминались на встрече?",
  6: "о чём говорили на встрече, какой был ход обсуждения?",
  7: "какие вопросы задавали и какие ответы давали участники?",
  8: "какие решения приняли, кто ответственный и какие сроки назвали?",
  9: "какие вопросы остались открытыми, что не успели решить?",
  10: "кто должен подписать и утвердить протокол?",
};

/** Плохой запрос — набор слов без вопросительной интонации. */
export function looksLikeKeywordSoupQuery(query: string): boolean {
  const q = stripTextForRagQuery(query);
  if (!q) return true;
  if (q.includes("?")) return false;
  const words = q.split(/\s+/).filter(Boolean);
  if (words.length >= 10) return true;
  const commaHeavy = (q.match(/,/g) ?? []).length >= 3;
  const sectionKeywords =
    (q.match(/протокол|повестк|участник|решени|ответственн|пункты|темы/gi) ?? []).length >= 4;
  return commaHeavy && sectionKeywords;
}

export function hydratedChatTranscriptForRag(
  messages: unknown[],
  maxChars: number
): string {
  const tail = Array.isArray(messages) ? messages.slice(-24) : [];
  const lines: string[] = [];
  for (const m of tail) {
    const rec = m as { role?: string; content?: string };
    const role =
      rec.role === "assistant" ? "assistant" : rec.role === "user" ? "user" : null;
    if (!role) continue;
    const raw = typeof rec.content === "string" ? rec.content : "";
    const t = stripTextForRagQuery(raw.replace(/\s+/g, " ").trim());
    if (!t) continue;
    lines.push(`${role}: ${t}`);
  }
  const joined = lines.join("\n");
  if (joined.length <= maxChars) return joined;
  return joined.slice(joined.length - maxChars);
}

/**
 * Промпт для генерации RAG-запроса.
 * Никакого хардкода номеров разделов — LLM определяет сам по диалогу.
 */
export function buildRagHybridQueryPrompt(
  transcript: string,
  purposeFocus: string
): string {
  return `Сформулируй ОДИН вопрос для поиска фактов в расшифровке встречи.

ФОРМАТ — естественный вопрос на русском, как спрашивают в разговоре:
  ✓ "кто участвовал в встрече и из каких они организаций?"
  ✓ "какие темы планировали обсудить на встрече?"
  ✗ "участники фио организации должности протокол" (набор слов — плохо)

${RAG_PROTOCOL_TEN_SECTIONS_RU}

ШАГ 1: Прочитай диалог снизу вверх. Найди последний раздел (1–10), по которому
пользователь уже предоставил данные или написал подтверждение («да», «верно», «ок» и т.п.).

ШАГ 2: Следующий после него раздел — тот, который нужно заполнить сейчас.
Сформулируй вопрос для поиска данных по ЭТОМУ разделу в расшифровке.
Один раздел = один вопрос. Не мешай несколько разделов в одном запросе.

Диалог:
"""
${stripTextForRagQuery(transcript)}
"""

Фокус (что нужно найти): ${purposeFocus}

Выведи ТОЛЬКО текст вопроса одной строкой, без кавычек и пояснений. До ${RAG_QUERY_MAX_CHARS} символов.`;
}

/**
 * Fallback: если LLM вернул keyword soup или пустоту,
 * берём вопрос для раздела 2 (первый после номера/даты).
 * Не пытаемся угадать раздел по regex — просто безопасный дефолт.
 */
export function fallbackRagQuestion(): string {
  return PROTOCOL_SECTION_RAG_QUESTIONS[2];
}