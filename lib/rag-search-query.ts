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

export const RAG_PROTOCOL_SECTIONS_RU = `
Протокол встречи — 5 разделов + шапка:
Шапка: номер протокола, дата встречи, название протокола, договор и тема договора
1. Дата собрания
2. Повестка (нумерованный список вопросов)
3. Участники — заказчик и исполнитель (организации, ФИО, должности)
4. Содержание встречи — по каждому вопросу: кто слушал, что обсуждали, какие решения + Резюме
5. Согласовано (подписи сторон)
`.trim();

/** Готовые вопросы для поиска по разделу — используются как fallback. */
export const PROTOCOL_SECTION_RAG_QUESTIONS: Record<number, string> = {
  1: "какой номер протокола, дата и название встречи упоминались в разговоре?",
  2: "какие темы и вопросы планировали обсудить на встрече, о чём была повестка?",
  3: "кто участвовал во встрече, как их зовут, должности и организации заказчика и исполнителя?",
  4: "о чём говорили на встрече, кто что обсуждал, какие решения приняли и кто ответственный?",
  5: "кто должен подписать протокол со стороны заказчика и исполнителя?",
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

${RAG_PROTOCOL_SECTIONS_RU}

ШАГ 1: Прочитай диалог снизу вверх. Найди последний раздел (1–5), по которому
пользователь уже предоставил данные или написал подтверждение («да», «верно», «ок» и т.п.).

ШАГ 2: Следующий после него раздел — тот, который нужно заполнить сейчас.
Сформулируй вопрос для поиска данных по ЭТОМУ разделу в расшифровке.
Один раздел = один вопрос. Не мешай несколько разделов в одном запросе.
Для раздела 4 уточни конкретный вопрос повестки: кто слушал, что обсуждалось, какое принято решение и кто ответственный.

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