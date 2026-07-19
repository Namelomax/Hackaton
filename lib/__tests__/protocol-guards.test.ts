import { enforceDateProvenance, fillContractFromDialogue } from '@/lib/protocol-guards';
import { extractUserAnswerTexts, extractLatestUserCorrections } from '@/lib/protocol-chat-extract';
import { normalizeCyrillicHomoglyphs } from '@/lib/prompts/glossary';
import type { Protocol } from '@/lib/schemas/protocol-schema';

/** Минимальный валидный Protocol (собран вручную по protocol-schema.ts). */
function makeProtocol(overrides: Partial<Protocol> = {}): Protocol {
  return {
    protocolNumber: '№1',
    meetingDate: '10.01.2026',
    protocolTitle: 'Тестовый протокол',
    agenda: { items: ['Пункт 1'] },
    participants: {
      customer: { organizationName: 'Заказчик', people: [] },
      executor: { organizationName: 'Исполнитель', people: [] },
    },
    meetingContent: { topics: [], summary: [] },
    approval: {
      customer: { organization: 'Заказчик', signatories: [] },
      executor: { organization: 'Исполнитель', signatories: [] },
    },
    ...overrides,
  };
}

/** Хелпер: минимальное uiMessage от пользователя с текстом в parts (формат AI SDK). */
function userMessage(text: string) {
  return { role: 'user', parts: [{ type: 'text', text }] };
}

describe('enforceDateProvenance', () => {
  it('сохраняет дату, названную в источнике словесно (в другом падеже/формате)', () => {
    const p = makeProtocol({
      meetingContent: {
        topics: [
          {
            title: 'Переход на ЭДО',
            listened: '',
            discussed: '',
            decided: 'Осуществить переход до 01.03.2026',
          },
        ],
        summary: [],
      },
    });
    const result = enforceDateProvenance(p, 'переход с 01 марта 2026 года');
    expect(result.protocol.meetingContent.topics[0].decided).toBe('Осуществить переход до 01.03.2026');
    expect(result.unresolved).toHaveLength(0);
  });

  it('заменяет непровязанную дату с предлогом на грамматически корректную фразу', () => {
    const p = makeProtocol({
      meetingContent: {
        topics: [{ title: 'Тема', listened: '', discussed: '', decided: 'выполнить до 05.05.2027' }],
        summary: [],
      },
    });
    const result = enforceDateProvenance(p, 'текст без каких-либо дат');
    const decided = result.protocol.meetingContent.topics[0].decided;
    expect(decided).not.toContain('до подлежит');
    expect(decided).toContain('в срок, подлежащий уточнению');
    expect(result.unresolved.length).toBeGreaterThan(0);
  });

  it('сохраняет формат «Срок: подлежит уточнению» для явного поля «Срок:»', () => {
    const p = makeProtocol({
      meetingContent: {
        topics: [],
        summary: [{ question: 'Вопрос', decision: 'Срок: 05.05.2027' }],
      },
    });
    const result = enforceDateProvenance(p, 'текст без каких-либо дат');
    expect(result.protocol.meetingContent.summary[0].decision).toBe('Срок: подлежит уточнению');
  });
});

describe('fillContractFromDialogue', () => {
  it('заполняет номер/дату/тему договора из явного текста', () => {
    const p = makeProtocol();
    const result = fillContractFromDialogue(p, 'Договор № 12 от 01.02.2026, тема: аудит процессов');
    expect(result.contractNumber).toBe('№12');
    expect(result.contractDate).toBe('01.02.2026');
    expect(result.contractSubject).toBe('аудит процессов');
  });

  it('текущее поведение: функция не различает источник текста — фильтрация теперь на стороне вызывающего кода', () => {
    // Раньше document-agent передавал сюда весь conversationContext (включая расшифровку),
    // из-за чего случайные упоминания «договор №…» в расшифровке попадали в шапку.
    // Сама fillContractFromDialogue по-прежнему просто разбирает переданный текст —
    // теперь вызывающий код (document-agent.ts) передаёт только extractUserAnswerTexts(...),
    // а не весь conversationContext (см. тест extractUserAnswerTexts ниже).
    const p = makeProtocol();
    const result = fillContractFromDialogue(p, 'трудовой договор № 47-ТД от 12.01.2026');
    expect(result.contractNumber).toBe('№47');
    expect(result.contractDate).toBe('12.01.2026');
  });
});

describe('extractUserAnswerTexts', () => {
  it('исключает сообщения длиннее лимита (похожие на вставленную расшифровку)', () => {
    const longText = 'А'.repeat(2001);
    const shortText = 'Договор номер 5, дата 01012026, тема — консультация';
    const uiMessages = [userMessage(longText), userMessage(shortText)];
    const result = extractUserAnswerTexts(uiMessages);
    expect(result).not.toContain(longText);
    expect(result).toContain(shortText);
  });

  it('включает короткие ответы пользователя (от 3 символов)', () => {
    const uiMessages = [userMessage('ок'), userMessage('да, верно')];
    const result = extractUserAnswerTexts(uiMessages);
    expect(result).not.toContain('ок'); // короче 3 символов
    expect(result).toContain('да, верно');
  });
});

describe('extractLatestUserCorrections', () => {
  it('обрезает длинное сообщение без признаков расшифровки, добавляя маркер, а не выбрасывает его', () => {
    const longText = 'Пожалуйста, исправьте формулировку решения по первому пункту. ' + 'X'.repeat(3000);
    const uiMessages = [userMessage(longText)];
    const result = extractLatestUserCorrections(uiMessages);
    expect(result).toHaveLength(1);
    expect(result[0].length).toBeLessThan(longText.length);
    expect(result[0]).toContain('правка обрезана до 2000 символов');
  });

  it('пропускает длинное сообщение, похожее на вставленную расшифровку (≥3 реплик)', () => {
    const lines = Array.from(
      { length: 5 },
      (_, i) => `[00:0${i}:15] — Реплика номер ${i}: ${'текст '.repeat(120)}`,
    ).join('\n');
    expect(lines.length).toBeGreaterThan(2000);
    const uiMessages = [userMessage(lines)];
    const result = extractLatestUserCorrections(uiMessages);
    expect(result).toHaveLength(0);
  });
});

describe('normalizeCyrillicHomoglyphs', () => {
  it('заменяет латинскую букву-гомоглиф внутри преимущественно кириллического слова', () => {
    expect(normalizeCyrillicHomoglyphs('ЭДO')).toBe('ЭДО');
  });

  it('не трогает слово целиком на латинице', () => {
    expect(normalizeCyrillicHomoglyphs('Ozon')).toBe('Ozon');
  });

  it('не трогает латинскую аббревиатуру рядом с кириллическим словом', () => {
    expect(normalizeCyrillicHomoglyphs('система MVP')).toBe('система MVP');
  });
});
