import { fixProtocolSectionHeadingsInMarkdown } from '@/lib/protocol-markdown-format';

/** Превращает tab-текст протокола в markdown для предпросмотра (таблицы GFM, жирные метки). */
export function protocolContentToPreviewMarkdown(raw: string): string {
  if (!raw?.trim()) return '';
  if (!/^ПРОТОКОЛ\s*№/im.test(raw.trim())) {
    return fixProtocolSectionHeadingsInMarkdown(raw);
  }

  const lines = raw.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;

  const flushParticipantTable = (rows: string[][]) => {
    if (rows.length === 0) return;
    out.push('');
    out.push('| ФИО | Должность |');
    out.push('| --- | --- |');
    for (const [a, b] of rows) {
      out.push(`| ${a} | ${b} |`);
    }
    out.push('');
  };

  const flushResumeTable = (rows: string[][]) => {
    if (rows.length === 0) return;
    out.push('');
    out.push('| Обсуждаемые вопросы | Принятые решения | Срок | Ответственный |');
    out.push('| --- | --- | --- | --- |');
    for (const cells of rows) {
      out.push(`| ${cells.map((c) => c.replace(/\|/g, '\\|')).join(' | ')} |`);
    }
    out.push('');
  };

  const flushSignatureTable = (rows: string[][]) => {
    if (rows.length === 0) return;
    out.push('');
    out.push('| Заказчик | Исполнитель |');
    out.push('| --- | --- |');
    for (const [a, b] of rows) {
      out.push(`| ${a || '________________'} | ${b || '________________'} |`);
    }
    out.push('');
  };

  let participantRows: string[][] = [];
  let resumeRows: string[][] = [];
  let signatureRows: string[][] = [];
  let mode: 'none' | 'participants' | 'resume' | 'signatures' = 'none';

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (mode === 'participants' && trimmed.includes('\t') && !/^фио\t/i.test(trimmed)) {
      const cells = trimmed.split('\t').map((c) => c.trim());
      if (cells[0] && !/^заказчик$|^исполнитель$/i.test(cells[0])) {
        participantRows.push([cells[0] ?? '', cells[1] ?? '']);
      }
      i++;
      continue;
    }

    if (mode === 'resume' && trimmed.includes('\t') && !/обсуждаемые вопросы/i.test(trimmed)) {
      const cells = trimmed.split('\t').map((c) => c.trim());
      if (cells[0]) {
        const decision = cells[1] ?? '';
        const deadlineM = decision.match(/Срок:\s*([^.\n]+)/i);
        const respM = decision.match(/Ответственный:\s*([^\n]+)/i);
        let decisionOnly = decision
          .replace(/Срок:\s*[^.\n]+/gi, '')
          .replace(/Ответственный:\s*[^\n]+/gi, '')
          .trim();
        resumeRows.push([
          cells[0],
          decisionOnly || decision,
          cells[2]?.trim() || (deadlineM?.[1] ?? '').trim(),
          cells[3]?.trim() || (respM?.[1] ?? '').trim(),
        ]);
      }
      i++;
      continue;
    }

    if (mode === 'signatures' && trimmed.includes('\t')) {
      const cells = trimmed.split('\t').map((c) => c.trim());
      if (!/со стороны|заказчик:|исполнитель:/i.test(trimmed)) {
        signatureRows.push([cells[0] ?? '', cells[1] ?? '']);
      }
      i++;
      continue;
    }

    if (mode !== 'none') {
      if (mode === 'participants') flushParticipantTable(participantRows);
      if (mode === 'resume') flushResumeTable(resumeRows);
      if (mode === 'signatures') flushSignatureTable(signatureRows);
      participantRows = [];
      resumeRows = [];
      signatureRows = [];
      mode = 'none';
    }

    if (!trimmed) {
      out.push('');
      i++;
      continue;
    }

    if (/^фио\tдолжность$/i.test(trimmed)) {
      mode = 'participants';
      i++;
      continue;
    }

    if (/^обсуждаемые вопросы\tпринятые решения/i.test(trimmed)) {
      mode = 'resume';
      i++;
      continue;
    }

    if (/^со стороны заказчика\tсо стороны исполнителя/i.test(trimmed)) {
      mode = 'signatures';
      i++;
      continue;
    }

    if (/^(заказчик|исполнитель)$/i.test(trimmed) && !trimmed.includes('\t')) {
      out.push(`**${trimmed}**`);
      i++;
      continue;
    }

    const sectionM = trimmed.match(/^(\d+)\.\t(.+)$/);
    if (sectionM) {
      out.push(`**${sectionM[1]}. ${sectionM[2]}**`);
      i++;
      continue;
    }

    const labelM = trimmed.match(/^(Слушали|Обсудили|Решили):\s*(.*)$/i);
    if (labelM) {
      const rest = labelM[2]?.trim();
      out.push(rest ? `**${labelM[1]}:** ${rest}` : `**${labelM[1]}:**`);
      i++;
      continue;
    }

    const agendaM = trimmed.match(/^(\d+)\)\t(.+)$/);
    if (agendaM) {
      out.push(`${agendaM[1]}) ${agendaM[2]}`);
      i++;
      continue;
    }

    if (/^резюме:$/i.test(trimmed)) {
      out.push('**Резюме:**');
      i++;
      continue;
    }

    if (/^ПРОТОКОЛ\s*№/i.test(trimmed)) {
      out.push(`**${trimmed}**`);
      i++;
      continue;
    }

    out.push(trimmed);
    i++;
  }

  if (mode === 'participants') flushParticipantTable(participantRows);
  if (mode === 'resume') flushResumeTable(resumeRows);
  if (mode === 'signatures') flushSignatureTable(signatureRows);

  return out.join('\n');
}
