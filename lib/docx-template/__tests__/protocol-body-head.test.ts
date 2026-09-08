import {
  buildAgendaXml,
  buildHeaderXml,
  buildMeetingDateXml,
  buildParticipantsXml,
} from "../protocol-body";
import {
  IND_AGENDA_LEFT,
  NUM_AGENDA,
  NUM_SECTION,
  SZ_TITLE,
  TBL_PARTICIPANTS,
} from "../style";
import { SAMPLE_PROTOCOL } from "./fixtures";

describe("buildHeaderXml", () => {
  it("ставит номер и дату по центру жирным одиннадцатым кеглем", () => {
    const xml = buildHeaderXml(SAMPLE_PROTOCOL);

    expect(xml).toContain("ПРОТОКОЛ №7 ОТ 12.01.2025");
    expect(xml).toContain('<w:jc w:val="center"/>');
    expect(xml).toContain(`<w:sz w:val="${SZ_TITLE}"/>`);
  });

  it("добавляет № к номеру, если модель его не поставила", () => {
    const xml = buildHeaderXml({ ...SAMPLE_PROTOCOL, protocolNumber: "7" });
    expect(xml).toContain("ПРОТОКОЛ №7 ОТ");
  });

  it("выводит договор и тему договора", () => {
    const xml = buildHeaderXml(SAMPLE_PROTOCOL);

    expect(xml).toContain("Договор №1122435346 от 30.12.2025 г.");
    expect(xml).toContain("Тема договора: ");
  });

  it("опускает тему договора, когда её нет", () => {
    const xml = buildHeaderXml({
      ...SAMPLE_PROTOCOL,
      contractSubject: undefined,
    });
    expect(xml).not.toContain("Тема договора");
  });
});

describe("buildMeetingDateXml", () => {
  it("нумерует раздел через numbering.xml и подчёркивает заголовок", () => {
    const xml = buildMeetingDateXml(SAMPLE_PROTOCOL);

    expect(xml).toContain(`<w:numId w:val="${NUM_SECTION}"/>`);
    expect(xml).toContain('<w:u w:val="single"/>');
    expect(xml).toContain("Дата собрания: ");
    expect(xml).toContain("12.01.2025");
  });

  it("не подставляет номер раздела текстом", () => {
    expect(buildMeetingDateXml(SAMPLE_PROTOCOL)).not.toContain("1.\t");
  });
});

describe("buildAgendaXml", () => {
  it("выносит пункты повестки в отдельный нумерованный список", () => {
    const xml = buildAgendaXml(SAMPLE_PROTOCOL);

    expect(xml).toContain(`<w:numId w:val="${NUM_AGENDA}"/>`);
    expect(xml).toContain(`w:left="${IND_AGENDA_LEFT}"`);
    expect(xml).toContain("Версия и дата обновления 1С:БГУ");
    expect(xml).toContain("Регламент доступа к тестовому контуру");
  });

  it("выбрасывает пустые пункты", () => {
    const xml = buildAgendaXml({
      ...SAMPLE_PROTOCOL,
      agenda: { items: ["Вопрос", "   ", ""] },
    });
    expect(
      xml.match(new RegExp(`<w:numId w:val="${NUM_AGENDA}"/>`, "g")),
    ).toHaveLength(1);
  });
});

describe("buildParticipantsXml", () => {
  it("строит две таблицы шаблонной ширины", () => {
    const xml = buildParticipantsXml(SAMPLE_PROTOCOL);
    const [wName, wPos] = TBL_PARTICIPANTS.grid;

    expect(xml.match(/<w:tbl>/g)).toHaveLength(2);
    expect(xml).toContain(
      `<w:gridCol w:w="${wName}"/><w:gridCol w:w="${wPos}"/>`,
    );
    expect(xml).toContain(
      `<w:tblW w:w="${TBL_PARTICIPANTS.width}" w:type="dxa"/>`,
    );
  });

  it("не заливает шапку серым — в шаблоне заливки нет", () => {
    expect(buildParticipantsXml(SAMPLE_PROTOCOL)).not.toContain("D9D9D9");
  });

  it("подписывает стороны и показывает организации", () => {
    const xml = buildParticipantsXml(SAMPLE_PROTOCOL);

    expect(xml).toContain("Заказчик — ООО «Ромашка»");
    expect(xml).toContain("Исполнитель — ООО «Форус»");
  });

  it("оставляет голую подпись стороны, когда организация — заглушка", () => {
    const xml = buildParticipantsXml({
      ...SAMPLE_PROTOCOL,
      participants: {
        ...SAMPLE_PROTOCOL.participants,
        customer: {
          ...SAMPLE_PROTOCOL.participants.customer,
          organizationName: "Заказчик",
        },
      },
    });
    expect(xml).toContain('<w:t xml:space="preserve">Заказчик</w:t>');
  });

  it("выбрасывает строки-заголовки, попавшие в участников от модели", () => {
    const xml = buildParticipantsXml({
      ...SAMPLE_PROTOCOL,
      participants: {
        ...SAMPLE_PROTOCOL.participants,
        customer: {
          organizationName: "ООО «Ромашка»",
          people: [
            { fullName: "ФИО", position: "Должность" },
            { fullName: "Иванов И.И.", position: "Главный бухгалтер" },
          ],
        },
      },
    });
    // Шапка таблицы одна, лишней строки «ФИО | Должность» в теле нет.
    expect(xml.match(/<w:t xml:space="preserve">ФИО<\/w:t>/g)).toHaveLength(2);
  });
});
