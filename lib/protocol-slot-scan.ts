/**
 * Детерминированный «слот-скан» расшифровки: до первого ответа пользователю
 * вычисляем, что в расшифровке есть и чего не хватает. Результат подмешивается в
 * системный промпт, чтобы слабая модель НЕ пропускала обязательные вопросы
 * (договор, сроки, ФИО) и не выдумывала недостающее.
 *
 * Только надёжные сигналы (regex/эвристики). Семантику (повестка, кто что сказал)
 * по-прежнему извлекает модель — здесь лишь якорь для блока «Не хватает».
 */
export interface SlotScan {
  transcriptChars: number;
  hasTimecodes: boolean;
  hasConcreteDate: boolean;
  hasContractMention: boolean;
  speakerLabelCount: number;
  relativeDateExpressions: string[];
  gaps: string[];
}

const RELATIVE_DATE_TERMS = [
  'послезавтра', 'сегодня', 'вчера', 'завтра',
  'на следующей неделе', 'на прошлой неделе', 'на этой неделе',
  'до конца недели', 'до конца месяца', 'в конце месяца', 'в начале месяца',
  'в ближайшее время', 'в течение недели', 'в течение месяца',
  'в понедельник', 'во вторник', 'в среду', 'в четверг', 'в пятницу',
];

export function analyzeTranscriptSlots(transcript: string): SlotScan {
  const t = String(transcript || '');
  const hasTimecodes = /\b\d{1,2}:\d{2}:\d{2}\b/.test(t);
  const hasConcreteDate = /\b\d{1,2}\.\d{1,2}\.\d{4}\b/.test(t);
  const hasContractMention = /договор/i.test(t);
  const speakers = new Set(
    (t.match(/Спикер\s*\d+/gi) || []).map((s) => s.toLowerCase().replace(/\s+/g, ' ')),
  );
  const speakerLabelCount = speakers.size;
  const lower = t.toLowerCase();
  const relativeDateExpressions = RELATIVE_DATE_TERMS.filter((term) => lower.includes(term));

  const gaps: string[] = [];
  if (!hasContractMention)
    gaps.push('Договор не упомянут в расшифровке — обязательно уточнить № договора, дату и тему.');
  if (!hasConcreteDate)
    gaps.push('В расшифровке нет ни одной конкретной даты (ДД.ММ.ГГГГ) — дату встречи и сроки решений уточнить у пользователя, НЕ выдумывать.');
  if (relativeDateExpressions.length)
    gaps.push(`Относительные даты в расшифровке (${relativeDateExpressions.join(', ')}) — перевести в конкретные ДД.ММ.ГГГГ или уточнить.`);
  if (speakerLabelCount > 0)
    gaps.push(`Участники помечены как «Спикер N» (${speakerLabelCount} шт.) — сопоставить с ФИО из текста реплик и уточнить неполные.`);

  return {
    transcriptChars: t.length,
    hasTimecodes,
    hasConcreteDate,
    hasContractMention,
    speakerLabelCount,
    relativeDateExpressions,
    gaps,
  };
}

/** Блок для системного промпта чат-агента. Пустая расшифровка → пустая строка. */
export function formatSlotScanForPrompt(scan: SlotScan): string {
  if (!scan || scan.transcriptChars === 0) return '';
  const lines = [
    '',
    '[АВТО-СКАН РАСШИФРОВКИ — учти при формировании блока «Не хватает» в первом сообщении]',
    `Объём: ${scan.transcriptChars} симв.; тайм-коды: ${scan.hasTimecodes ? 'есть' : 'нет'}; конкретные даты: ${scan.hasConcreteDate ? 'есть' : 'НЕТ'}; договор упомянут: ${scan.hasContractMention ? 'да' : 'НЕТ'}.`,
  ];
  if (scan.gaps.length) {
    lines.push('Выявленные пробелы (обязательно отрази в «Не хватает» и задай вопросы):');
    scan.gaps.forEach((g, i) => lines.push(`${i + 1}. ${g}`));
  } else {
    lines.push('Явных пробелов не выявлено — всё равно подтверди участников и договор.');
  }
  return lines.join('\n');
}
