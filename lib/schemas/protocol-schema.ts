import { z } from 'zod';
import { isValidParticipantRow } from '@/lib/protocol-markdown-format';

// Участник (для таблиц)
export const ParticipantSchema = z.object({
  fullName: z.string().describe('ФИО'),
  position: z.string().describe('Должность'),
});

// Вопрос с ответом
export const QuestionAnswerSchema = z.object({
  question: z.string().describe('Текст вопроса'),
  answer: z.string().describe('Текст ответа'),
});

// Решение с ответственным
export const DecisionSchema = z.object({
  decision: z.string().describe('Текст решения'),
  responsible: z.string().describe('Ответственный (Исполнитель/Заказчик)'),
});

// Таблица особенностей миграции
export const MigrationFeatureSchema = z.object({
  tab: z.string().describe('Название вкладки'),
  features: z.string().describe('Описание особенностей'),
});

// Основная схема протокола обследования
export const ProtocolSchema = z.object({
  // 1. Номер и дата
  protocolNumber: z.string().describe('Номер протокола (например: №7)'),
  meetingDate: z.string().describe('Дата встречи в формате ДД.ММ.ГГГГ'),

  // 2. Повестка
  agenda: z.object({
    title: z.string().describe('Основная тема встречи'),
    items: z.array(z.string()).describe('Пункты повестки'),
  }),

  // 3. Участники
  participants: z.object({
    customer: z.object({
      organizationName: z.string().describe('Название организации заказчика'),
      people: z.array(ParticipantSchema),
    }),
    executor: z.object({
      organizationName: z.string().describe('Название организации исполнителя'),
      people: z.array(ParticipantSchema),
    }),
  }),

  // 4. Термины и определения
  termsAndDefinitions: z.array(
    z.object({
      term: z.string().describe('Термин'),
      definition: z.string().describe('Определение'),
    })
  ),

  // 5. Сокращения и обозначения
  abbreviations: z.array(
    z.object({
      abbreviation: z.string().describe('Сокращение'),
      fullForm: z.string().describe('Полная форма'),
    })
  ),

  // 6. Содержание встречи
  meetingContent: z.object({
    introduction: z.string().optional().describe('Вводная часть'),
    topics: z.array(
      z.object({
        title: z.string().describe('Название темы'),
        content: z.string().describe('Содержание обсуждения'),
        subtopics: z.array(
          z.object({
            title: z.string().optional(),
            content: z.string(),
          })
        ).optional(),
      })
    ),
    migrationFeatures: z.array(MigrationFeatureSchema).optional().describe('Особенности миграции (если применимо)'),
  }),

  // 7. Вопросы и ответы
  questionsAndAnswers: z.array(QuestionAnswerSchema),

  // 8. Решения
  decisions: z.array(DecisionSchema),

  // 9. Открытые вопросы
  openQuestions: z.array(z.string()),

  // 10. Согласовано
  approval: z.object({
    executorSignature: z.object({
      organization: z.string(),
      representative: z.string().describe('ФИО представителя'),
    }),
    customerSignature: z.object({
      organization: z.string(),
      representative: z.string().describe('ФИО представителя'),
    }),
  }),
});

export type Protocol = z.infer<typeof ProtocolSchema>;

const toStr = (value: unknown) => (value == null ? '' : String(value));
const toArr = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);

const isBlankStr = (v: unknown) => toStr(v).trim().length === 0;

/** Нет массива, length 0 или каждая строка «пустая» — типичный скелет от streamObject/schema. */
function isVacuousArray(arr: unknown, rowIsEmpty: (row: unknown) => boolean): boolean {
  if (!Array.isArray(arr) || arr.length === 0) return true;
  return arr.every(rowIsEmpty);
}

function termsRowEmpty(row: unknown): boolean {
  const r = row && typeof row === 'object' ? (row as Record<string, unknown>) : {};
  return isBlankStr(r.term ?? r.термин) && isBlankStr(r.definition ?? r.определение);
}

function abbrRowEmpty(row: unknown): boolean {
  const r = row && typeof row === 'object' ? (row as Record<string, unknown>) : {};
  return isBlankStr(r.abbreviation ?? r.сокращение) && isBlankStr(r.fullForm ?? r.full_form ?? r.расшифровка);
}

function qaRowEmpty(row: unknown): boolean {
  const r = row && typeof row === 'object' ? (row as Record<string, unknown>) : {};
  return isBlankStr(r.question ?? r.вопрос) && isBlankStr(r.answer ?? r.ответ);
}

function decisionRowEmpty(row: unknown): boolean {
  const r = row && typeof row === 'object' ? (row as Record<string, unknown>) : {};
  return isBlankStr(r.decision ?? r.решение) && isBlankStr(r.responsible ?? r.ответственный);
}

function meetingTopicsVacuous(mc: unknown): boolean {
  if (!mc || typeof mc !== 'object' || Array.isArray(mc)) return true;
  const topics = (mc as Record<string, unknown>).topics;
  if (!Array.isArray(topics) || topics.length === 0) return true;
  return topics.every((row) => {
    const r = row && typeof row === 'object' ? (row as Record<string, unknown>) : {};
    return isBlankStr(r.title ?? r.тема) && isBlankStr(r.content ?? r.суть);
  });
}

/** Убирает ```json … ``` вокруг ответа модели (Ollama часто так отдаёт structured output). */
export function stripMarkdownCodeFence(raw: string): string {
  let s = raw.trim();
  const fenced = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/im);
  if (fenced) return fenced[1].trim();
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  }
  return s;
}

/** JSON.parse с попыткой вырезать внешний мусор до первого `{` и после последнего `}`. */
export function parseLooseJsonObject(raw: string): unknown | null {
  const s = stripMarkdownCodeFence(raw);
  try {
    return JSON.parse(s);
  } catch {
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(s.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

/** Текст сырого ответа из цепочки AI_NoObjectGeneratedError / AI_JSONParseError. */
export function extractNoObjectGeneratedText(err: unknown): string | null {
  let cur: unknown = err;
  for (let i = 0; i < 10 && cur && typeof cur === 'object'; i++) {
    const t = (cur as Record<string, unknown>).text;
    if (typeof t === 'string' && t.trim().length > 0) return t;
    cur = (cur as Record<string, unknown>).cause;
  }
  return null;
}

/** Некоторые модели отдают протокол секциями `1_номер_и_дата` … `10_согласование` с русскими ключами. */
function applyRussianNumberedProtocolSections(p: Record<string, unknown>): void {
  const sec1 = p['1_номер_и_дата'];
  if (sec1 && typeof sec1 === 'object' && !Array.isArray(sec1)) {
    const n = sec1 as Record<string, unknown>;
    if (p.protocolNumber == null && p.number == null) p.protocolNumber = n.номер ?? n.number;
    if (p.meetingDate == null && p.date == null) p.meetingDate = n.дата ?? n.date;
  }

  const sec2 = p['2_повестка'];
  if (sec2 && typeof sec2 === 'object' && !Array.isArray(sec2) && p.agenda == null) {
    const ag = sec2 as Record<string, unknown>;
    p.agenda = {
      title: toStr(ag.тема ?? ag.theme),
      items: toArr<string>(ag.пункты ?? ag.items).map(toStr),
    };
  }

  const sec3 = p['3_участники'];
  if (sec3 && typeof sec3 === 'object' && !Array.isArray(sec3) && p.participants == null) {
    const u = sec3 as Record<string, unknown>;
    const cust = u.заказчик ?? u.customer;
    const exec = u.исполнитель ?? u.executor;
    if (cust && typeof cust === 'object' && exec && typeof exec === 'object') {
      const cu = cust as Record<string, unknown>;
      const eu = exec as Record<string, unknown>;
      const custPeople = toArr(cu.участники ?? cu.people);
      const execPeople = toArr(eu.участники ?? eu.people);
      const mapPerson = (row: unknown) => {
        const r = row && typeof row === 'object' ? (row as Record<string, unknown>) : {};
        return {
          name: toStr(r.фамилия_имя ?? r.name),
          role: toStr(r.должность ?? r.role ?? r.position),
        };
      };
      p.participants = {
        clientOrganization: toStr(cu.организация),
        executorOrganization: toStr(eu.организация),
        client: custPeople.map(mapPerson),
        executor: execPeople.map(mapPerson),
      };
    }
  }

  const sec4 = p['4_термины'];
  if (sec4 && typeof sec4 === 'object' && !Array.isArray(sec4) && p.terms == null && p.termsAndDefinitions == null) {
    const t = sec4 as Record<string, unknown>;
    const arr = t.термины ?? t.terms;
    if (Array.isArray(arr)) p.terms = arr;
  }

  const sec5 = p['5_сокращения'];
  if (sec5 && typeof sec5 === 'object' && !Array.isArray(sec5) && p.abbreviations == null) {
    const s5 = sec5 as Record<string, unknown>;
    const arr = s5.сокращения ?? s5.items;
    if (Array.isArray(arr)) {
      p.abbreviations = arr.map((item) => {
        const r = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
        return {
          abbreviation: toStr(r.сокращение ?? r.abbreviation),
          fullForm: toStr(r.расшифровка ?? r.full_form ?? r.fullForm),
        };
      });
    }
  }

  const mc = p.meetingContent as Record<string, unknown> | undefined;
  const topicsLen = mc && Array.isArray(mc.topics) ? (mc.topics as unknown[]).length : 0;
  const sec6 = p['6_содержание'];
  if (
    topicsLen === 0 &&
    sec6 &&
    typeof sec6 === 'object' &&
    !Array.isArray(sec6) &&
    p.content == null &&
    typeof p.content !== 'string'
  ) {
    const s6 = sec6 as Record<string, unknown>;
    const topicsRaw = s6.темы_обсуждения ?? s6.topics;
    if (Array.isArray(topicsRaw)) {
      p.content = topicsRaw.map((t) => {
        const row = t && typeof t === 'object' ? (t as Record<string, unknown>) : {};
        return { topic: toStr(row.тема ?? row.topic), details: toStr(row.суть ?? row.details) };
      });
    }
  }

  const sec7 = p['7_вопросы_и_ответы'];
  if (Array.isArray(sec7) && p.qa == null && p.questions_answers == null && p.questionsAndAnswers == null) {
    p.questions_answers = sec7.map((row) => {
      const r = row && typeof row === 'object' ? (row as Record<string, unknown>) : {};
      return { question: toStr(r.вопрос ?? r.question), answer: toStr(r.ответ ?? r.answer) };
    });
  }

  const sec8 = p['8_решения'];
  if (Array.isArray(sec8) && p.decisions == null) {
    p.decisions = sec8.map((row) => {
      const r = row && typeof row === 'object' ? (row as Record<string, unknown>) : {};
      return {
        decision: toStr(r.решение ?? r.decision),
        responsible: toStr(r.ответственный ?? r.responsible),
      };
    });
  }

  const sec9 = p['9_открытые_вопросы'];
  if (Array.isArray(sec9) && p.open_questions == null && p.openQuestions == null) {
    p.open_questions = sec9;
  }

  const sec10 = p['10_согласование'];
  if (sec10 && typeof sec10 === 'object' && !Array.isArray(sec10) && p.signatures == null && p.approval == null) {
    const s10 = sec10 as Record<string, unknown>;
    const execBlock = (s10.исполнитель ?? s10.executor) as Record<string, unknown> | undefined;
    const custBlock = (s10.заказчик ?? s10.client) as Record<string, unknown> | undefined;
    const execSigs = execBlock ? toArr(execBlock.подписи ?? execBlock.signatures) : [];
    const custSigs = custBlock ? toArr(custBlock.подписи ?? custBlock.signatures) : [];
    const mapSig = (row: unknown) => {
      const r = row && typeof row === 'object' ? (row as Record<string, unknown>) : {};
      return { name: toStr(r.фамилия_имя ?? r.name), role: toStr(r.должность ?? r.role) };
    };
    p.signatures = {
      executor: execSigs.map(mapSig),
      client: custSigs.map(mapSig),
    };
  }
}

/** Приводит типичные «креативные» формы JSON от LLM к полям, которые ждёт coerce. */
function preprocessLlmProtocolShape(input: unknown): Record<string, unknown> {
  let root: unknown = input;
  if (typeof root === 'string') {
    root = parseLooseJsonObject(root);
  }
  if (!root || typeof root !== 'object' || Array.isArray(root)) return {};
  let p = root as Record<string, unknown>;
  if (p.protocol && typeof p.protocol === 'object' && !Array.isArray(p.protocol)) {
    p = p.protocol as Record<string, unknown>;
  }

  applyRussianNumberedProtocolSections(p);

  const out: Record<string, unknown> = { ...p };

  if (out.protocolNumber === undefined && p.number !== undefined) out.protocolNumber = p.number;
  if (out.meetingDate === undefined && p.date !== undefined) out.meetingDate = p.date;

  if (typeof p.agenda === 'string') {
    out.agenda = { title: p.agenda, items: [] as string[] };
  }

  const po = p.participants as Record<string, unknown> | undefined;
  if (po && !po.customer && Array.isArray((po as Record<string, unknown>).client)) {
    const client = (po as Record<string, unknown>).client as unknown[];
    const executorRaw = (po as Record<string, unknown>).executor;
    const executor = Array.isArray(executorRaw) ? executorRaw : [];
    const custOrg =
      toStr((po as Record<string, unknown>).clientOrganization) ||
      toStr(
        client[0] && typeof client[0] === 'object'
          ? (client[0] as Record<string, unknown>).organization
          : '',
      ) ||
      'Заказчик';
    const execOrg =
      toStr((po as Record<string, unknown>).executorOrganization) ||
      toStr(
        executor[0] && typeof executor[0] === 'object'
          ? (executor[0] as Record<string, unknown>).organization
          : '',
      ) ||
      'Исполнитель';
    out.participants = {
      customer: { organizationName: custOrg, people: client },
      executor: { organizationName: execOrg, people: executor },
    };
  }

  if (isVacuousArray(out.termsAndDefinitions, termsRowEmpty) && Array.isArray(p.terms)) {
    out.termsAndDefinitions = p.terms;
  }

  if (Array.isArray(p.abbreviations) && p.abbreviations.length > 0) {
    out.abbreviations = (p.abbreviations as unknown[]).map((item) => {
      const r = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
      return {
        abbreviation: toStr(r.abbreviation ?? r.сокращение),
        fullForm: toStr(r.fullForm ?? r.full_form ?? r.расшифровка),
      };
    });
  }

  if (out.openQuestions === undefined) {
    if (typeof p.openQuestions === 'string') out.openQuestions = [p.openQuestions];
    else if (typeof p.open_questions === 'string') out.openQuestions = [p.open_questions];
    else if (Array.isArray(p.open_questions)) {
      out.openQuestions = (p.open_questions as unknown[]).map((x) =>
        typeof x === 'string'
          ? x
          : `${toStr((x as Record<string, unknown>)?.question ?? (x as Record<string, unknown>)?.вопрос)}${
              (x as Record<string, unknown>)?.status != null ||
              (x as Record<string, unknown>)?.статус != null
                ? ` — ${toStr((x as Record<string, unknown>).status ?? (x as Record<string, unknown>).статус)}`
                : ''
            }`.trim(),
      );
    }
  }

  const oq = out.openQuestions;
  if (Array.isArray(oq) && oq.length > 0 && typeof oq[0] === 'object' && oq[0] != null) {
    out.openQuestions = (oq as unknown[]).map((x) => {
      if (typeof x === 'string') return x;
      const o = x as Record<string, unknown>;
      const q = toStr(o.question ?? o.вопрос);
      const st = o.status ?? o.статус;
      return st != null && String(st).length ? `${q} — ${toStr(st)}` : q;
    });
  }

  const mc = out.meetingContent as Record<string, unknown> | undefined;
  const topicsEmpty = meetingTopicsVacuous(out.meetingContent);
  if (topicsEmpty && typeof p.content === 'string') {
    const prevIntro = mc && mc.introduction !== undefined ? toStr(mc.introduction).trim() : '';
    const body = String(p.content);
    out.meetingContent = {
      introduction: prevIntro ? `${prevIntro}\n\n${body}` : body,
      topics: [],
    };
  } else if (topicsEmpty && Array.isArray(p.content)) {
    const prevIntro = mc && mc.introduction !== undefined ? toStr(mc.introduction) : '';
    out.meetingContent = {
      introduction: prevIntro,
      topics: (p.content as unknown[]).map((t) => {
        const row = t && typeof t === 'object' ? (t as Record<string, unknown>) : {};
        return {
          title: toStr(row.topic ?? row.title),
          content: toStr(row.details ?? row.content),
        };
      }),
    };
  }

  if (isVacuousArray(out.questionsAndAnswers, qaRowEmpty)) {
    const qa = (p.qa ?? p.questions_answers) as unknown;
    if (Array.isArray(qa)) {
      out.questionsAndAnswers = (qa as unknown[]).map((row) => {
        const r = row && typeof row === 'object' ? (row as Record<string, unknown>) : {};
        return {
          question: toStr(r.question ?? r.вопрос),
          answer: toStr(r.answer ?? r.ответ),
        };
      });
    }
  }

  if (isVacuousArray(out.decisions, decisionRowEmpty)) {
    if (Array.isArray(p['8_решения'])) {
      out.decisions = (p['8_решения'] as unknown[]).map((row) => {
        const r = row && typeof row === 'object' ? (row as Record<string, unknown>) : {};
        return {
          decision: toStr(r.decision ?? r.решение),
          responsible: toStr(r.responsible ?? r.ответственный),
        };
      });
    } else if (Array.isArray(p.decisions)) {
      out.decisions = p.decisions as unknown[];
    }
  }

  if (!out.approval && p.signatures && typeof p.signatures === 'object') {
    const sig = p.signatures as Record<string, unknown>;
    const exec = Array.isArray(sig.executor) ? sig.executor : [];
    const cli = Array.isArray(sig.client) ? sig.client : [];
    const pickRep = (rows: unknown[]) => {
      for (const row of rows) {
        const r = row && typeof row === 'object' ? (row as Record<string, unknown>) : {};
        const name = toStr(r.name ?? r.fullName ?? r.фамилия_имя);
        if (name.trim()) return name;
      }
      const r0 = rows[0] && typeof rows[0] === 'object' ? (rows[0] as Record<string, unknown>) : undefined;
      return toStr(r0?.name ?? r0?.fullName ?? r0?.фамилия_имя ?? '');
    };
    out.approval = {
      executorSignature: {
        organization: 'Исполнитель',
        representative: pickRep(exec),
      },
      customerSignature: {
        organization: 'Заказчик',
        representative: pickRep(cli),
      },
    };
  }

  /** Пустые подписи в `approval` — подставить ФИО и организации из участников (после merge client→customer). */
  if (out.approval && typeof out.approval === 'object' && out.participants && typeof out.participants === 'object') {
    const appr = out.approval as Record<string, unknown>;
    const par = out.participants as Record<string, unknown>;
    const pickFirstNamed = (rows: unknown[]) => {
      for (const row of rows) {
        const r = row && typeof row === 'object' ? (row as Record<string, unknown>) : {};
        const name = toStr(r.fullName ?? r.name ?? r.фамилия_имя);
        if (name.trim()) return name;
      }
      return '';
    };
    const fillSide = (sigKey: string, grpKey: string, rawFallback: string) => {
      const sig = appr[sigKey] as Record<string, unknown> | undefined;
      if (!sig) return;
      const grp = par[grpKey] as Record<string, unknown> | undefined;
      let people: unknown[] = [];
      if (grp && typeof grp === 'object' && !Array.isArray(grp) && Array.isArray(grp.people)) {
        people = grp.people as unknown[];
      } else if (Array.isArray(par[rawFallback])) {
        people = par[rawFallback] as unknown[];
      }
      if (isBlankStr(sig.representative) && people.length) sig.representative = pickFirstNamed(people);
      if (isBlankStr(sig.organization)) {
        const orgFromGrp =
          grp && typeof grp === 'object' && !Array.isArray(grp) ? toStr(grp.organizationName) : '';
        sig.organization =
          orgFromGrp.trim() ||
          (sigKey === 'executorSignature' ? 'Исполнитель' : 'Заказчик');
      }
    };
    fillSide('executorSignature', 'executor', 'executor');
    fillSide('customerSignature', 'customer', 'client');
  }

  if (Array.isArray(out.termsAndDefinitions)) {
    out.termsAndDefinitions = (out.termsAndDefinitions as unknown[]).filter((row) => !termsRowEmpty(row));
  }
  if (Array.isArray(out.abbreviations)) {
    out.abbreviations = (out.abbreviations as unknown[]).filter((row) => !abbrRowEmpty(row));
  }
  if (Array.isArray(out.questionsAndAnswers)) {
    out.questionsAndAnswers = (out.questionsAndAnswers as unknown[]).filter((row) => !qaRowEmpty(row));
  }
  if (Array.isArray(out.decisions)) {
    out.decisions = (out.decisions as unknown[]).filter((row) => !decisionRowEmpty(row));
  }

  return out;
}

/** Приводит произвольный черновик (в т.ч. частичный от streamObject) к форме Protocol перед Zod-проверкой. */
export function coerceProtocolPartial(partial: unknown): Protocol {
  const pre = preprocessLlmProtocolShape(partial);
  const p = pre && typeof pre === 'object' && !Array.isArray(pre) ? pre : {};

  const toPeople = (value: unknown) =>
    toArr(value)
      .map((row: unknown) => {
        const r = row && typeof row === 'object' ? (row as Record<string, unknown>) : {};
        return {
          fullName: toStr(r.fullName ?? r.name ?? r.фамилия_имя),
          position: toStr(r.position ?? r.role),
        };
      })
      .filter((p) => isValidParticipantRow(p.fullName, p.position));

  const meetingContentRaw =
    p.meetingContent && typeof p.meetingContent === 'object' && !Array.isArray(p.meetingContent)
      ? (p.meetingContent as Record<string, unknown>)
      : {};

  return {
    protocolNumber: toStr(p.protocolNumber),
    meetingDate: toStr(p.meetingDate),
    agenda: {
      title: toStr((p.agenda as Record<string, unknown> | undefined)?.title),
      items: toArr<string>((p.agenda as Record<string, unknown> | undefined)?.items).map(toStr),
    },
    participants: {
      customer: {
        organizationName: toStr(
          ((p.participants as Record<string, unknown> | undefined)?.customer as Record<string, unknown> | undefined)
            ?.organizationName,
        ),
        people: toPeople(
          ((p.participants as Record<string, unknown> | undefined)?.customer as Record<string, unknown> | undefined)
            ?.people,
        ),
      },
      executor: {
        organizationName: toStr(
          ((p.participants as Record<string, unknown> | undefined)?.executor as Record<string, unknown> | undefined)
            ?.organizationName,
        ),
        people: toPeople(
          ((p.participants as Record<string, unknown> | undefined)?.executor as Record<string, unknown> | undefined)
            ?.people,
        ),
      },
    },
    termsAndDefinitions: toArr(p.termsAndDefinitions).map((item: unknown) => {
      const row = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
      return {
        term: toStr(row.term ?? row.термин),
        definition: toStr(row.definition ?? row.определение),
      };
    }),
    abbreviations: toArr(p.abbreviations).map((item: unknown) => {
      const row = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
      return {
        abbreviation: toStr(row.abbreviation ?? row.сокращение),
        fullForm: toStr(row.fullForm ?? row.full_form ?? row.расшифровка),
      };
    }),
    meetingContent: {
      introduction: meetingContentRaw.introduction !== undefined ? toStr(meetingContentRaw.introduction) : '',
      topics: toArr(meetingContentRaw.topics).map((topic: unknown) => {
        const t = topic && typeof topic === 'object' ? (topic as Record<string, unknown>) : {};
        return {
          title: toStr(t.title ?? t.тема),
          content: toStr(t.content ?? t.суть),
          subtopics: toArr(t.subtopics).map((sub: unknown) => {
            const s = sub && typeof sub === 'object' ? (sub as Record<string, unknown>) : {};
            return { title: s.title !== undefined ? toStr(s.title) : '', content: toStr(s.content) };
          }),
        };
      }),
      migrationFeatures: toArr(meetingContentRaw.migrationFeatures).map((feat: unknown) => {
        const f = feat && typeof feat === 'object' ? (feat as Record<string, unknown>) : {};
        return { tab: toStr(f.tab), features: toStr(f.features) };
      }),
    },
    questionsAndAnswers: toArr(p.questionsAndAnswers).map((qa: unknown) => {
      const row = qa && typeof qa === 'object' ? (qa as Record<string, unknown>) : {};
      return {
        question: toStr(row.question ?? row.вопрос),
        answer: toStr(row.answer ?? row.ответ),
      };
    }),
    decisions: toArr(p.decisions).map((decision: unknown) => {
      const row = decision && typeof decision === 'object' ? (decision as Record<string, unknown>) : {};
      return {
        decision: toStr(row.decision ?? row.решение),
        responsible: toStr(row.responsible ?? row.ответственный),
      };
    }),
    openQuestions: toArr<string>(p.openQuestions).map(toStr),
    approval: {
      executorSignature: {
        organization: toStr(
          (
            (p.approval as Record<string, unknown> | undefined)?.executorSignature as
              | Record<string, unknown>
              | undefined
          )?.organization,
        ),
        representative: toStr(
          (
            (p.approval as Record<string, unknown> | undefined)?.executorSignature as
              | Record<string, unknown>
              | undefined
          )?.representative,
        ),
      },
      customerSignature: {
        organization: toStr(
          (
            (p.approval as Record<string, unknown> | undefined)?.customerSignature as
              | Record<string, unknown>
              | undefined
          )?.organization,
        ),
        representative: toStr(
          (
            (p.approval as Record<string, unknown> | undefined)?.customerSignature as
              | Record<string, unknown>
              | undefined
          )?.representative,
        ),
      },
    },
  };
}

/**
 * Жёсткая проверка соответствия `ProtocolSchema` после получения итогового JSON от модели.
 * Частичный поток streamObject не гарантирует валидность — всегда вызывать на финальном объекте.
 */
export function parseProtocolStrict(input: unknown): Protocol {
  return ProtocolSchema.parse(coerceProtocolPartial(input));
}

/**
 * Тот же разбор без исключения — для логов и диагностики.
 */
export function safeParseProtocol(input: unknown) {
  return ProtocolSchema.safeParse(coerceProtocolPartial(input));
}

/**
 * Схема для валидации и анализа исходной расшифровки встречи
 */
export const TranscriptAnalysisSchema = z.object({
  hasContradictions: z.boolean().describe('Обнаружены ли противоречия'),
  contradictions: z.array(z.string()).describe('Список обнаруженных противоречий'),
  hasAmbiguities: z.boolean().describe('Есть ли недосказанности/неясности'),
  ambiguities: z.array(z.string()).describe('Список недосказанностей'),
  missingCriticalInfo: z.array(z.string()).describe('Список критически важной недостающей информации'),
  confidence: z.enum(['high', 'medium', 'low']).describe('Уровень уверенности в полноте данных'),
});

export type TranscriptAnalysis = z.infer<typeof TranscriptAnalysisSchema>;

// Схема инструкции по формированию протокола
export const ProtocolInstructionSchema = z.object({
  instruction: z.string().describe('Подробная инструкция по созданию протокола'),
  openQuestions: z.array(z.string()).describe('Список вопросов для уточнения'),
});

export type ProtocolInstruction = z.infer<typeof ProtocolInstructionSchema>;
