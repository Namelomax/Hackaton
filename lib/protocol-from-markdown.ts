import type { MeetingQuestion, Protocol, ResumeRow } from '@/lib/schemas/protocol-schema';
import { cleanProtocolText, stripProtocolTimecodes } from '@/lib/protocol-markdown-format';
import { finalizeProtocol } from '@/lib/protocol-sanitize';
import { coerceProtocolPartial } from '@/lib/schemas/protocol-schema';

/** Убирает плейсхолдер пустой панели, если он попал в сохранённый текст. */
export function stripDocumentPanelPlaceholder(text: string): string {
  return String(text ?? '')
    .replace(/^Здесь будет ваш протокол\.?\s*/i, '')
    .trim();
}

function linesOf(raw: string): string[] {
  return stripDocumentPanelPlaceholder(raw).replace(/\r\n?/g, '\n').split('\n');
}

function parseTabRow(line: string): string[] {
  if (!line.includes('\t')) return [];
  return line.split('\t').map((c) => cleanProtocolText(c));
}

function isGfmSeparator(line: string): boolean {
  const t = line.trim();
  return /^\|?\s*:?-{2,}/.test(t);
}

/** Собирает Protocol из markdown/tab-текста панели (источник истины для DOCX). */
export function parseProtocolFromMarkdown(raw: string): Protocol | null {
  const lines = linesOf(raw);
  if (!lines.some((l) => /^ПРОТОКОЛ\s*№/i.test(l.trim()))) return null;

  const draft: Partial<Protocol> = {
    agendaItems: [],
    meetingQuestions: [],
    resume: [],
    participants: {
      customer: { organizationName: 'Заказчик', people: [] },
      executor: { organizationName: 'Исполнитель', people: [] },
    },
    approval: {
      customer: { organizationName: 'Заказчик', signatories: [] },
      executor: { organizationName: 'Исполнитель', signatories: [] },
    },
  };

  let section = 0;
  let participantSide: 'customer' | 'executor' | null = null;
  let inResume = false;
  let resumeHeaderSeen = false;
  let currentQuestion: MeetingQuestion | null = null;

  const flushQuestion = () => {
    if (!currentQuestion) return;
    if (currentQuestion.question || currentQuestion.listened || currentQuestion.discussed || currentQuestion.decided) {
      draft.meetingQuestions!.push(currentQuestion);
    }
    currentQuestion = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = stripProtocolTimecodes(line.trim());
    if (!trimmed) continue;

    const sectionM = trimmed.match(/^(\d+)\.\t(.+)$/i) || trimmed.match(/^(\d+)\.\s+(.+)$/i);
    if (sectionM) {
      const num = parseInt(sectionM[1], 10);
      if (num >= 1 && num <= 5) {
        flushQuestion();
        section = num;
        inResume = false;
        participantSide = null;
        if (section === 1) {
          const dateM = trimmed.match(/дата собрания:\s*(\d{1,2}\.\d{1,2}\.\d{4})/i);
          if (dateM) draft.assemblyDate = dateM[1];
        }
        if (section === 2 && /повестка/i.test(sectionM[2])) continue;
        if (section === 3 && /участник/i.test(sectionM[2])) continue;
        if (section === 4 && /содержание/i.test(sectionM[2])) continue;
        if (section === 5 && /согласован/i.test(sectionM[2])) continue;
      }
      continue;
    }

    if (i < 8 && /^ПРОТОКОЛ\s*№/i.test(trimmed)) {
      const numM = trimmed.match(/ПРОТОКОЛ\s*№\s*(\d+)/i);
      const dateM = trimmed.match(/ОТ\s+(\d{1,2}\.\d{1,2}\.\d{4})/i);
      if (numM) draft.protocolNumber = numM[1];
      if (dateM) draft.protocolDate = dateM[1];
      continue;
    }

    if (!draft.protocolTitle && i > 0 && i < 6 && !/^\d+\./.test(trimmed) && !/^ПРОТОКОЛ/i.test(trimmed)) {
      if (/^договор/i.test(trimmed)) {
        const cM = trimmed.match(/№\s*(\S+)\s+от\s+(.+)/i) || trimmed.match(/№\s*(\S+)/i);
        if (cM) {
          draft.contractNumber = cM[1];
          if (cM[2]) draft.contractDate = cleanProtocolText(cM[2]);
        }
        continue;
      }
      if (/^тема договора:/i.test(trimmed)) {
        draft.contractTopic = cleanProtocolText(trimmed.replace(/^тема договора:\s*/i, ''));
        continue;
      }
      if (!draft.protocolTitle) {
        draft.protocolTitle = cleanProtocolText(trimmed);
        continue;
      }
    }

    if (/^резюме:/i.test(trimmed)) {
      flushQuestion();
      section = 4;
      inResume = true;
      resumeHeaderSeen = false;
      continue;
    }

    if (section === 2 || (section === 0 && /повестка/i.test(trimmed))) {
      const agendaM = trimmed.match(/^(\d+)\)\s*(.+)$/);
      if (agendaM?.[2]) draft.agendaItems!.push(cleanProtocolText(agendaM[2]));
      continue;
    }

    if (section === 3) {
      if (/^заказчик$/i.test(trimmed)) {
        participantSide = 'customer';
        continue;
      }
      if (/^исполнитель$/i.test(trimmed)) {
        participantSide = 'executor';
        continue;
      }
      const orgM = trimmed.match(/^заказчик\s*:\s*(.+)$/i);
      if (orgM?.[1]) {
        draft.participants!.customer.organizationName = cleanProtocolText(orgM[1]);
        continue;
      }
      const orgE = trimmed.match(/^исполнитель\s*:\s*(.+)$/i);
      if (orgE?.[1]) {
        draft.participants!.executor.organizationName = cleanProtocolText(orgE[1]);
        continue;
      }
      if (/^фио\tдолжность$/i.test(trimmed) || /^фио\s*\|/i.test(trimmed)) continue;

      const tab = parseTabRow(trimmed);
      if (tab.length >= 2 && participantSide) {
        draft.participants![participantSide].people.push({
          fullName: tab[0],
          position: tab[1],
        });
        continue;
      }

      const gfm = trimmed.match(/^\|\s*([^|]+)\|\s*([^|]+)\|/);
      if (gfm && participantSide && !isGfmSeparator(trimmed)) {
        draft.participants![participantSide].people.push({
          fullName: cleanProtocolText(gfm[1]),
          position: cleanProtocolText(gfm[2]),
        });
      }
      continue;
    }

    if (inResume || (section === 4 && resumeHeaderSeen)) {
      if (/обсуждаемые вопросы/i.test(trimmed) && /принятые решения/i.test(trimmed)) {
        resumeHeaderSeen = true;
        inResume = true;
        continue;
      }
      if (isGfmSeparator(trimmed)) continue;

      const tab = parseTabRow(trimmed);
      if (tab.length >= 2) {
        draft.resume!.push({
          discussedQuestion: tab[0],
          decision: tab[1],
          deadline: tab[2] && tab[2] !== '—' ? tab[2] : undefined,
          responsible: tab[3] && tab[3] !== '—' ? tab[3] : undefined,
        });
        continue;
      }

      const gfm = trimmed.match(/^\|\s*([^|]+)\|\s*([^|]+)\|\s*([^|]*)\|\s*([^|]*)\|/);
      if (gfm && !isGfmSeparator(trimmed) && !/обсуждаемые/i.test(gfm[1])) {
        draft.resume!.push({
          discussedQuestion: cleanProtocolText(gfm[1]),
          decision: cleanProtocolText(gfm[2]),
          deadline: cleanProtocolText(gfm[3]) || undefined,
          responsible: cleanProtocolText(gfm[4]) || undefined,
        });
      }
      continue;
    }

    if (section === 4) {
      const itemM = trimmed.match(/^(\d+)\)\s*(.*)$/);
      if (itemM && !/^слушали:/i.test(itemM[2])) {
        flushQuestion();
        currentQuestion = {
          question: cleanProtocolText(itemM[2]),
          listened: '',
          discussed: '',
          decided: '',
        };
        continue;
      }

      if (!currentQuestion) {
        currentQuestion = { question: '', listened: '', discussed: '', decided: '' };
      }

      const listenedM = trimmed.match(/^слушали:\s*(.*)$/i);
      if (listenedM) {
        currentQuestion.listened = cleanProtocolText(listenedM[1]);
        continue;
      }
      const discussedM = trimmed.match(/^обсудили:\s*(.*)$/i);
      if (discussedM) {
        currentQuestion.discussed = cleanProtocolText(discussedM[1]);
        continue;
      }
      if (/^решили:/i.test(trimmed)) {
        const rest = trimmed.replace(/^решили:\s*/i, '');
        currentQuestion.decided = rest ? cleanProtocolText(rest) : '';
        continue;
      }
      if (currentQuestion.decided && !/^резюме/i.test(trimmed)) {
        currentQuestion.decided += `\n${cleanProtocolText(trimmed)}`;
      }
      continue;
    }

    if (section === 5) {
      if (/^заказчик\s*:?\s*$/i.test(trimmed)) continue;
      if (/^исполнитель\s*:?\s*$/i.test(trimmed)) continue;
      const custOrg = trimmed.match(/^заказчик\s*:\s*(.+)$/i);
      if (custOrg?.[1]) {
        draft.approval!.customer.organizationName = cleanProtocolText(custOrg[1]);
        continue;
      }
      const execOrg = trimmed.match(/^исполнитель\s*:\s*(.+)$/i);
      if (execOrg?.[1]) {
        draft.approval!.executor.organizationName = cleanProtocolText(execOrg[1]);
        continue;
      }
      const tab = parseTabRow(trimmed);
      if (tab.length >= 2) {
        const left = tab[0].replace(/_+/g, '').trim();
        const right = tab[1].replace(/_+/g, '').trim();
        if (left) draft.approval!.customer.signatories.push(left);
        if (right) draft.approval!.executor.signatories.push(right);
      }
    }
  }

  flushQuestion();

  if (!draft.protocolNumber && !draft.protocolDate) return null;

  return finalizeProtocol(coerceProtocolPartial(draft));
}
