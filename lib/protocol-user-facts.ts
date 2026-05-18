/**
 * Факты, которые пользователь явно ввёл в чат (приоритет над «не найдено в расшифровке»).
 */

export type UserSection1Facts = {
  protocolNumber: string | null;
  date: string | null;
  meetingTitle: string | null;
  rawUserText: string;
};

const PROTOCOL_NUM_RE =
  /(?:номер\s+)?протокол(?:а)?\s*(?:№|#|n\.?\s*)?\s*(\d+)|протокол\s+(\d+)\b/i;
const DATE_RE =
  /\b(\d{1,2}[./]\d{1,2}[./]\d{2,4}|\d{4}-\d{2}-\d{2})\b/;
const TITLE_RE =
  /название\s+встречи\s*[:\-—]?\s*([^,.;]+)/i;

/** Извлекает номер/дату/название из одной реплики пользователя. */
export function parseSection1FromUserText(text: string): UserSection1Facts {
  const raw = String(text ?? "").trim();
  const t = raw.toLowerCase();

  let protocolNumber: string | null = null;
  const pn = raw.match(PROTOCOL_NUM_RE);
  if (pn) {
    protocolNumber = (pn[1] || pn[2] || "").trim() || null;
  }

  let date: string | null = null;
  const dm = raw.match(DATE_RE);
  if (dm) date = dm[1];

  let meetingTitle: string | null = null;
  const tm = raw.match(TITLE_RE);
  if (tm) meetingTitle = tm[1].trim();

  // «номер протокола 1, дата 05.04.2026» без слова «протокол» перед цифрой
  if (!protocolNumber && /номер\s+протокол/i.test(t)) {
    const m = raw.match(/номер\s+протокол\w*\s*(\d+)/i);
    if (m) protocolNumber = m[1];
  }

  return { protocolNumber, date, meetingTitle, rawUserText: raw };
}

export function section1FactsLookComplete(facts: UserSection1Facts): boolean {
  return Boolean(facts.protocolNumber || facts.date);
}

/** Последняя реплика user в transcript (формат `user: ...`). */
export function lastUserLineFromTranscript(transcript: string): string {
  const lines = transcript.split("\n").filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^user:\s*/i.test(lines[i])) {
      return lines[i].replace(/^user:\s*/i, "").trim();
    }
  }
  return "";
}

export function userProvidedSection1InTranscript(transcript: string): UserSection1Facts | null {
  const lastUser = lastUserLineFromTranscript(transcript);
  if (!lastUser) return null;
  const facts = parseSection1FromUserText(lastUser);
  return section1FactsLookComplete(facts) ? facts : null;
}

export function buildUserProvidedSection1Appendix(
  facts: UserSection1Facts,
  options?: { ragToolEnabled?: boolean },
): string {
  const lines: string[] = [
    "",
    "## Данные раздела 1 от пользователя (обязательно принять)",
    "Пользователь **сам указал** в чате следующее. Считай раздел 1 **закрытым** для протокола:",
  ];
  if (facts.protocolNumber) {
    lines.push(`- Номер протокола: **${facts.protocolNumber}** (источник: сообщение пользователя)`);
  }
  if (facts.date) {
    lines.push(`- Дата встречи: **${facts.date}** (источник: сообщение пользователя)`);
  }
  if (facts.meetingTitle) {
    lines.push(`- Название встречи: **${facts.meetingTitle}**`);
  }
  lines.push(
    "",
    "**ЗАПРЕЩЕНО** для этих полей:",
    "- писать «в расшифровке не найдено» или просить подтвердить, что данные верны, если пользователь их уже назвал;",
    "- искать в RAG номер/дату раздела 1 — они уже заданы пользователем.",
    "",
    options?.ragToolEnabled
      ? "**Сразу** перейди к **разделу 2 (повестка)**: вызови retrieveFromIndexedDocuments с вопросом о темах/повестке встречи, предложи вариант повестки из excerpts и задай **один** уточняющий вопрос только по повестке."
      : "**Сразу** перейди к **разделу 2 (повестка)**: найди темы и цель встречи в блоке «ВЛОЖЕНИЯ ПОЛЬЗОВАТЕЛЯ» (полная расшифровка), предложи формулировку повестки и задай **один** уточняющий вопрос только по повестке.",
    "",
  );
  return lines.join("\n");
}
