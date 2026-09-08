# Вывод DOCX-протокола по корпоративному шаблону — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Протокол в DOCX должен выходить точно по корпоративному шаблону заказчика — шрифт Verdana, поля страницы, колонтитулы с логотипом «Форус», нумерация разделов и оформление таблиц.

**Architecture:** Шаблон лежит в репозитории как бинарный `.docx`. При генерации он распаковывается через JSZip, подменяется только `word/document.xml`, остальные части (стили, колонтитулы, нумерация, тема, логотип) переносятся байт-в-байт. Сервер становится единственным сборщиком DOCX; клиентский `@mohtasham/md-to-docx` удаляется, а под ручные правки пишется детерминированный `markdownToProtocol`.

**Tech Stack:** TypeScript, Next.js 15 App Router, JSZip 3.10 (уже в зависимостях), Jest + ts-jest, Biome. Новых npm-пакетов не требуется.

**Спека:** [docs/superpowers/specs/2026-09-06-docx-corporate-template-design.md](../specs/2026-09-06-docx-corporate-template-design.md)

## Global Constraints

- Никаких новых npm-зависимостей. JSZip 3.10.1 уже в `dependencies`.
- Все размеры в OOXML — twip (1/1440 дюйма); размеры шрифта — полуочки (`sz=20` → 10pt).
- Все константы оформления живут только в `lib/docx-template/style.ts`. Магические числа в других файлах модуля запрещены.
- Порядок дочерних элементов внутри `<w:pPr>`, `<w:tblPr>`, `<w:tcPr>` задан схемой OOXML. При нарушении Word молча теряет свойства. Соблюдать: `pPr` → `numPr`, `spacing`, `ind`, `jc`, `rPr`; `tblPr` → `tblW`, `tblInd`, `tblBorders`, `tblLayout`, `tblLook`; `tcPr` → `tcW`, `gridSpan`, `tcBorders`.
- Тесты кладём в `__tests__` рядом с кодом (`lib/docx-template/__tests__/…`) — так устроен весь проект.
- Тесты, которые читают файлы или собирают zip, начинаются с докблока `/** @jest-environment node */` — глобальный `testEnvironment` в `jest.config.js` это `jsdom`.
- Комментарии и сообщения об ошибках — на русском, как во всём проекте.
- Каждая задача заканчивается коммитом. Сообщения коммитов — на русском, в стиле репозитория (`feat:`, `fix:`, `refactor:`, `test:`).

---

### Task 1: Ресурс шаблона без внедрённых шрифтов

Шаблон заказчика весит 2.37 МБ из-за семи внедрённых `.odttf`. Verdana и Arial есть на любой Windows-машине, поэтому шрифты вырезаются один раз при подготовке ресурса, а не в рантайме. Проверено: после вырезания файл 25.7 КБ и рендерится идентично оригиналу.

**Files:**
- Create: `scripts/build-protocol-template.mjs`
- Create: `lib/docx-template/assets/protocol-template.docx` (генерируется скриптом)
- Modify: `package.json` (раздел `scripts`)
- Modify: `Dockerfile`
- Test: `lib/docx-template/__tests__/template-asset.test.ts`

**Interfaces:**
- Consumes: ничего.
- Produces: файл `lib/docx-template/assets/protocol-template.docx` — валидный OOXML-пакет без `word/fonts/`, с сохранёнными `word/header1.xml`, `word/footer1.xml`, `word/media/image1.png`, `word/styles.xml`, `word/numbering.xml`.

- [ ] **Step 1: Написать скрипт подготовки ресурса**

Создать `scripts/build-protocol-template.mjs`:

```js
/**
 * Готовит бинарный ресурс шаблона протокола из исходника заказчика.
 *
 * Вырезает внедрённые шрифты: в оригинале их семь штук на 4.3 МБ, из-за чего
 * каждый сгенерированный протокол весил бы 2.4 МБ. Verdana и Arial есть на любой
 * Windows-машине, так что вид документа не меняется.
 *
 * Запуск: npm run build:protocol-template
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';

const SRC = process.argv[2] ?? 'Шаблон протокола чистый.docx';
const DST = process.argv[3] ?? 'lib/docx-template/assets/protocol-template.docx';

const zip = await JSZip.loadAsync(await readFile(SRC));

// Сами файлы шрифтов и связи на них.
for (const name of Object.keys(zip.files)) {
  if (name.startsWith('word/fonts/') || name === 'word/_rels/fontTable.xml.rels') {
    zip.remove(name);
  }
}

const patch = async (name, fn) => {
  const entry = zip.file(name);
  if (!entry) return;
  zip.file(name, fn(await entry.async('string')));
};

// Объявление типа .odttf, флаг внедрения и ссылки на шрифты в таблице шрифтов.
await patch('[Content_Types].xml', (s) => s.replace(/<Default[^>]*Extension="odttf"[^>]*\/>/g, ''));
await patch('word/settings.xml', (s) => s.replace(/<w:embedTrueTypeFonts\s*\/>/g, ''));
await patch('word/fontTable.xml', (s) =>
  s.replace(/<w:embed(?:Regular|Bold|Italic|BoldItalic)\b[^>]*\/>/g, ''),
);

await mkdir(path.dirname(DST), { recursive: true });
await writeFile(DST, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));

console.log(`Шаблон готов: ${DST}`);
```

- [ ] **Step 2: Прописать команду в package.json**

В раздел `scripts` добавить строку:

```json
"build:protocol-template": "node scripts/build-protocol-template.mjs"
```

- [ ] **Step 3: Сгенерировать ресурс**

Run: `npm run build:protocol-template`
Expected: `Шаблон готов: lib/docx-template/assets/protocol-template.docx`, файл ~25–27 КБ.

- [ ] **Step 4: Написать тест целостности ресурса**

Создать `lib/docx-template/__tests__/template-asset.test.ts`:

```ts
/** @jest-environment node */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';

const ASSET = path.join(process.cwd(), 'lib/docx-template/assets/protocol-template.docx');

describe('ресурс шаблона протокола', () => {
  it('содержит части, отвечающие за фирменное оформление', async () => {
    const zip = await JSZip.loadAsync(await readFile(ASSET));
    const names = Object.keys(zip.files);

    expect(names).toEqual(expect.arrayContaining([
      'word/document.xml',
      'word/styles.xml',
      'word/numbering.xml',
      'word/header1.xml',
      'word/footer1.xml',
      'word/media/image1.png',
      'word/theme/theme1.xml',
    ]));
  });

  it('не тащит внедрённые шрифты', async () => {
    const zip = await JSZip.loadAsync(await readFile(ASSET));
    const names = Object.keys(zip.files);

    expect(names.filter((n) => n.startsWith('word/fonts/'))).toEqual([]);
    expect(names).not.toContain('word/_rels/fontTable.xml.rels');

    const settings = await zip.file('word/settings.xml')!.async('string');
    expect(settings).not.toContain('embedTrueTypeFonts');
  });

  it('весит меньше 100 КБ', async () => {
    const buffer = await readFile(ASSET);
    expect(buffer.length).toBeLessThan(100 * 1024);
  });

  it('сохраняет ссылки на колонтитулы и поля страницы', async () => {
    const zip = await JSZip.loadAsync(await readFile(ASSET));
    const doc = await zip.file('word/document.xml')!.async('string');

    expect(doc).toContain('<w:headerReference');
    expect(doc).toContain('<w:footerReference');
    expect(doc).toContain('w:top="1424"');
    expect(doc).toContain('w:left="993"');
  });
});
```

- [ ] **Step 5: Прогнать тест**

Run: `npx jest lib/docx-template/__tests__/template-asset.test.ts`
Expected: PASS, 4 теста.

- [ ] **Step 6: Починить доставку ресурса в Docker**

`Dockerfile` в runner-стадии копирует только `public`, `.next`, `node_modules` и `package.json`, поэтому файл под `lib/` в контейнер не попадёт и генерация упадёт в проде.

В `Dockerfile`, в стадии `runner`, после строки `COPY --from=builder /app/package.json ./package.json` добавить:

```dockerfile
COPY --from=builder /app/lib/docx-template/assets ./lib/docx-template/assets
```

- [ ] **Step 7: Коммит**

```bash
git add scripts/build-protocol-template.mjs lib/docx-template/assets/protocol-template.docx lib/docx-template/__tests__/template-asset.test.ts package.json Dockerfile
git commit -m "feat: ресурс корпоративного шаблона протокола без внедрённых шрифтов"
```

---

### Task 2: Примитивы OOXML и константы оформления

**Files:**
- Create: `lib/docx-template/style.ts`
- Create: `lib/docx-template/ooxml.ts`
- Test: `lib/docx-template/__tests__/ooxml.test.ts`

**Interfaces:**
- Consumes: ничего.
- Produces:
  - `style.ts`: `SZ_BODY: 20`, `SZ_TITLE: 22`, `LINE_115: 276`, `SPACING_AFTER_BLOCK: 160`, `NUM_SECTION: 1`, `NUM_TOPIC: 2`, `NUM_AGENDA: 4`, `IND_SECTION_LEFT: 284`, `IND_SECTION_HANGING: 284`, `IND_AGENDA_LEFT: 644`, `IND_AGENDA_HANGING: 360`, `IND_TOPIC_LEFT: 720`, `IND_TOPIC_HANGING: 360`, `IND_APPROVAL_NAME_LEFT: 66`, `IND_APPROVAL_NAME_RIGHT: 317`, `TBL_PARTICIPANTS`, `TBL_SUMMARY`, `TBL_APPROVAL`.
  - `ooxml.ts`: `esc(text: string): string`; `run(text: string, options?: RunOptions): string`; `paragraph(runsXml: string, options?: ParagraphOptions): string`; `cell(paragraphsXml: string, options: CellOptions): string`; `row(cellsXml: string): string`; `table(rowsXml: string, options: TableOptions): string`; типы `RunOptions`, `ParagraphOptions`, `CellOptions`, `CellBorders`, `TableOptions`.

- [ ] **Step 1: Написать константы оформления**

Создать `lib/docx-template/style.ts`:

```ts
/**
 * Константы оформления протокола, снятые с «Шаблон протокола чистый.docx».
 * Единственное место, где меняется вид документа.
 *
 * Размеры — twip (1/1440 дюйма). Размеры шрифта — полуочки: sz=20 это 10pt.
 */

/** Основной текст протокола — 10pt. */
export const SZ_BODY = 20;
/** «ПРОТОКОЛ № … ОТ …» и название — 11pt, размер по умолчанию из docDefaults. */
export const SZ_TITLE = 22;

/** Межстрочный интервал 1.15. */
export const LINE_115 = 276;
/** Отбивка под блоками шапки документа. */
export const SPACING_AFTER_BLOCK = 160;

/** Нумерация разделов протокола: «1.», «2.» … */
export const NUM_SECTION = 1;
/** Нумерация вопросов внутри раздела «Содержание встречи»: «1)», «2)» … */
export const NUM_TOPIC = 2;
/** Нумерация пунктов повестки: «1)», «2)» … */
export const NUM_AGENDA = 4;

export const IND_SECTION_LEFT = 284;
export const IND_SECTION_HANGING = 284;
export const IND_AGENDA_LEFT = 644;
export const IND_AGENDA_HANGING = 360;
export const IND_TOPIC_LEFT = 720;
export const IND_TOPIC_HANGING = 360;

/** Отступы ФИО подписантов в таблице «Согласовано» — слева и справа они разные. */
export const IND_APPROVAL_NAME_LEFT = 66;
export const IND_APPROVAL_NAME_RIGHT = 317;

export const TBL_PARTICIPANTS = { grid: [4672, 5388], width: 10060 } as const;
export const TBL_SUMMARY = { grid: [3810, 6255], width: 10065 } as const;
export const TBL_APPROVAL = { grid: [1830, 3000, 2025, 2235], width: 9090, indent: 284 } as const;
```

- [ ] **Step 2: Написать падающий тест примитивов**

Создать `lib/docx-template/__tests__/ooxml.test.ts`:

```ts
import { cell, esc, paragraph, row, run, table } from '../ooxml';
import { LINE_115, NUM_SECTION, SZ_BODY } from '../style';

describe('esc', () => {
  it('экранирует спецсимволы XML', () => {
    expect(esc('ООО «А&Б» <тест>')).toBe('ООО «А&amp;Б» &lt;тест&gt;');
  });

  it('вырезает управляющие символы, ломающие Word', () => {
    expect(esc('до\u0007после')).toBe('допосле');
  });
});

describe('run', () => {
  it('по умолчанию задаёт размер основного текста', () => {
    expect(run('Текст')).toBe(
      `<w:r><w:rPr><w:sz w:val="${SZ_BODY}"/><w:szCs w:val="${SZ_BODY}"/></w:rPr>` +
      `<w:t xml:space="preserve">Текст</w:t></w:r>`,
    );
  });

  it('переносы строк превращает в <w:br/>', () => {
    expect(run('раз\nдва')).toContain('</w:t><w:br/><w:t xml:space="preserve">два</w:t>');
  });

  it('складывает жирный, курсив и подчёркивание в правильном порядке', () => {
    expect(run('X', { bold: true, italic: true, underline: true })).toContain(
      '<w:b/><w:i/><w:u w:val="single"/>',
    );
  });
});

describe('paragraph', () => {
  it('без свойств не выводит пустой pPr', () => {
    expect(paragraph('')).toBe('<w:p></w:p>');
  });

  it('соблюдает порядок numPr → spacing → ind → jc', () => {
    const xml = paragraph('', {
      align: 'center',
      indentLeft: 284,
      indentHanging: 284,
      spacingLine: LINE_115,
      numId: NUM_SECTION,
    });

    expect(xml).toBe(
      '<w:p><w:pPr>' +
      `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${NUM_SECTION}"/></w:numPr>` +
      `<w:spacing w:line="${LINE_115}" w:lineRule="auto"/>` +
      '<w:ind w:left="284" w:hanging="284"/>' +
      '<w:jc w:val="center"/>' +
      '</w:pPr></w:p>',
    );
  });
});

describe('table', () => {
  it('строит tblPr в порядке tblW → tblInd → tblBorders → tblLayout → tblLook', () => {
    const xml = table(row(cell(paragraph(''), { width: 100 })), {
      grid: [100],
      width: 100,
      borders: 'single',
    });

    expect(xml.indexOf('<w:tblW')).toBeLessThan(xml.indexOf('<w:tblInd'));
    expect(xml.indexOf('<w:tblInd')).toBeLessThan(xml.indexOf('<w:tblBorders'));
    expect(xml.indexOf('<w:tblBorders')).toBeLessThan(xml.indexOf('<w:tblLayout'));
    expect(xml).toContain('<w:gridCol w:w="100"/>');
  });
});

describe('cell', () => {
  it('borders="none" гасит все четыре границы', () => {
    expect(cell(paragraph(''), { width: 100, borders: 'none' })).toContain(
      '<w:tcBorders><w:top w:val="nil"/><w:left w:val="nil"/><w:bottom w:val="nil"/><w:right w:val="nil"/></w:tcBorders>',
    );
  });

  it('borders="bottom" оставляет нижнюю границу — это линия подписи', () => {
    const xml = cell(paragraph(''), { width: 100, borders: 'bottom' });

    expect(xml).toContain('<w:tcBorders><w:top w:val="nil"/><w:left w:val="nil"/><w:right w:val="nil"/></w:tcBorders>');
    expect(xml).not.toContain('<w:bottom w:val="nil"/>');
  });

  it('пустая ячейка всё равно содержит абзац — иначе Word не открывает файл', () => {
    expect(cell('', { width: 100 })).toContain('<w:p></w:p>');
  });

  it('gridSpan идёт после tcW', () => {
    const xml = cell(paragraph(''), { width: 200, gridSpan: 2 });
    expect(xml.indexOf('<w:tcW')).toBeLessThan(xml.indexOf('<w:gridSpan'));
  });
});
```

- [ ] **Step 3: Прогнать тест и убедиться, что он падает**

Run: `npx jest lib/docx-template/__tests__/ooxml.test.ts`
Expected: FAIL — `Cannot find module '../ooxml'`.

- [ ] **Step 4: Написать примитивы**

Создать `lib/docx-template/ooxml.ts`:

```ts
/**
 * Примитивы сборки WordprocessingML. Ничего не знают про структуру протокола.
 *
 * Порядок дочерних элементов внутри pPr / tblPr / tcPr задан схемой OOXML.
 * Word не ругается на нарушение — он молча игнорирует свойства, оказавшиеся
 * не на своём месте, поэтому порядок здесь жёстко зашит.
 */
import { SZ_BODY } from './style';

/** Символы, недопустимые в XML 1.0. Word на них молча отказывается открывать файл. */
const INVALID_XML_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

export function esc(text: string): string {
  return String(text ?? '')
    .replace(INVALID_XML_CHARS, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface RunOptions {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  /** Полуочки. По умолчанию SZ_BODY. null — не задавать, наследовать из стилей. */
  size?: number | null;
  font?: string;
}

/** Один <w:r>. Переносы строк внутри текста становятся <w:br/>. */
export function run(text: string, options: RunOptions = {}): string {
  const { bold, italic, underline, size = SZ_BODY, font } = options;

  const rPr: string[] = [];
  if (font) {
    const f = esc(font);
    rPr.push(`<w:rFonts w:ascii="${f}" w:eastAsia="${f}" w:hAnsi="${f}" w:cs="${f}"/>`);
  }
  if (bold) rPr.push('<w:b/>');
  if (italic) rPr.push('<w:i/>');
  if (underline) rPr.push('<w:u w:val="single"/>');
  if (size != null) rPr.push(`<w:sz w:val="${size}"/><w:szCs w:val="${size}"/>`);
  const rPrXml = rPr.length ? `<w:rPr>${rPr.join('')}</w:rPr>` : '';

  const body = String(text ?? '')
    .split(/\r\n|\r|\n/)
    .map((line) => `<w:t xml:space="preserve">${esc(line)}</w:t>`)
    .join('<w:br/>');

  return `<w:r>${rPrXml}${body}</w:r>`;
}

export interface ParagraphOptions {
  align?: 'left' | 'center' | 'right' | 'both';
  indentLeft?: number;
  indentHanging?: number;
  indentFirstLine?: number;
  spacingAfter?: number;
  spacingLine?: number;
  numId?: number;
}

/** Один <w:p>. */
export function paragraph(runsXml: string, options: ParagraphOptions = {}): string {
  const pPr: string[] = [];

  if (options.numId != null) {
    pPr.push(`<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${options.numId}"/></w:numPr>`);
  }

  const spacing: string[] = [];
  if (options.spacingAfter != null) spacing.push(`w:after="${options.spacingAfter}"`);
  if (options.spacingLine != null) spacing.push(`w:line="${options.spacingLine}" w:lineRule="auto"`);
  if (spacing.length) pPr.push(`<w:spacing ${spacing.join(' ')}/>`);

  const ind: string[] = [];
  if (options.indentLeft != null) ind.push(`w:left="${options.indentLeft}"`);
  if (options.indentHanging != null) ind.push(`w:hanging="${options.indentHanging}"`);
  if (options.indentFirstLine != null) ind.push(`w:firstLine="${options.indentFirstLine}"`);
  if (ind.length) pPr.push(`<w:ind ${ind.join(' ')}/>`);

  if (options.align) pPr.push(`<w:jc w:val="${options.align}"/>`);

  const pPrXml = pPr.length ? `<w:pPr>${pPr.join('')}</w:pPr>` : '';
  return `<w:p>${pPrXml}${runsXml}</w:p>`;
}

/**
 * Как ячейка обходится с границами таблицы.
 * - `inherit` — как объявлено в tblBorders.
 * - `none` — рамки нет.
 * - `bottom` — гасим всё, кроме низа; низ наследуется из tblBorders и даёт линию подписи.
 */
export type CellBorders = 'inherit' | 'none' | 'bottom';

export interface CellOptions {
  width: number;
  gridSpan?: number;
  borders?: CellBorders;
}

export function cell(paragraphsXml: string, options: CellOptions): string {
  const tcPr: string[] = [`<w:tcW w:w="${options.width}" w:type="dxa"/>`];

  if (options.gridSpan != null && options.gridSpan > 1) {
    tcPr.push(`<w:gridSpan w:val="${options.gridSpan}"/>`);
  }

  if (options.borders === 'none') {
    tcPr.push(
      '<w:tcBorders><w:top w:val="nil"/><w:left w:val="nil"/><w:bottom w:val="nil"/><w:right w:val="nil"/></w:tcBorders>',
    );
  } else if (options.borders === 'bottom') {
    tcPr.push('<w:tcBorders><w:top w:val="nil"/><w:left w:val="nil"/><w:right w:val="nil"/></w:tcBorders>');
  }

  // Ячейка без единого блочного элемента делает файл невалидным.
  const content = paragraphsXml || paragraph('');
  return `<w:tc><w:tcPr>${tcPr.join('')}</w:tcPr>${content}</w:tc>`;
}

export function row(cellsXml: string): string {
  return `<w:tr>${cellsXml}</w:tr>`;
}

export interface TableOptions {
  grid: readonly number[];
  width: number;
  indent?: number;
  borders: 'single' | 'none';
}

export function table(rowsXml: string, options: TableOptions): string {
  const border = (tag: string) =>
    options.borders === 'single'
      ? `<w:${tag} w:val="single" w:sz="4" w:space="0" w:color="000000"/>`
      : `<w:${tag} w:val="nil"/>`;

  const borders = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(border).join('');

  const tblPr =
    '<w:tblPr>' +
    `<w:tblW w:w="${options.width}" w:type="dxa"/>` +
    `<w:tblInd w:w="${options.indent ?? 0}" w:type="dxa"/>` +
    `<w:tblBorders>${borders}</w:tblBorders>` +
    '<w:tblLayout w:type="fixed"/>' +
    '<w:tblLook w:val="0600" w:firstRow="0" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="1" w:noVBand="1"/>' +
    '</w:tblPr>';

  const grid = `<w:tblGrid>${options.grid.map((w) => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>`;

  return `<w:tbl>${tblPr}${grid}${rowsXml}</w:tbl>`;
}
```

- [ ] **Step 5: Прогнать тест**

Run: `npx jest lib/docx-template/__tests__/ooxml.test.ts`
Expected: PASS, 11 тестов.

- [ ] **Step 6: Коммит**

```bash
git add lib/docx-template/style.ts lib/docx-template/ooxml.ts lib/docx-template/__tests__/ooxml.test.ts
git commit -m "feat: примитивы OOXML и константы оформления протокола"
```

---

### Task 3: Общие форматтеры и разделы 1–3

Три вспомогательные функции сейчас продублированы в `lib/docx-generator.ts` и `app/api/chat/agents/document-agent.ts`. Переносим их в `lib/protocol-markdown-format.ts`, где уже живут все остальные форматтеры протокола, и переиспользуем.

**Files:**
- Modify: `lib/protocol-markdown-format.ts` (добавить экспорты)
- Modify: `lib/docx-generator.ts:47-49,74-82` (убрать дубликаты, импортировать)
- Modify: `app/api/chat/agents/document-agent.ts:1092-1099` (убрать дубликат, импортировать)
- Create: `lib/docx-template/protocol-body.ts`
- Create: `lib/docx-template/__tests__/fixtures.ts`
- Test: `lib/docx-template/__tests__/protocol-body-head.test.ts`

**Interfaces:**
- Consumes: `esc`, `run`, `paragraph`, `cell`, `row`, `table` из `lib/docx-template/ooxml`; константы из `lib/docx-template/style`; `cleanProtocolText`, `formatContractBlock`, `isValidParticipantRow`, `parseInlineMarkdownBold` из `lib/protocol-markdown-format`.
- Produces:
  - `lib/protocol-markdown-format.ts`: `isValidOrgDisplayName(name: string): boolean`, `formatApprovalOrgLine(org: string): string`, `formatMultilineField(text: string): string`.
  - `lib/docx-template/protocol-body.ts`: `buildHeaderXml(protocol: Protocol): string`, `buildMeetingDateXml(protocol: Protocol): string`, `buildAgendaXml(protocol: Protocol): string`, `buildParticipantsXml(protocol: Protocol): string`; внутренние `spacer()`, `sectionHeading(title, valueXml?)`, `inlineRuns(text, options?)`, `participantsTable(people)`.
  - `lib/docx-template/__tests__/fixtures.ts`: `SAMPLE_PROTOCOL: Protocol`.

- [ ] **Step 1: Перенести общие форматтеры в protocol-markdown-format.ts**

В конец `lib/protocol-markdown-format.ts` добавить:

```ts
/** Проверяет, что название организации — реальное имя, а не заглушка или мусор из LLM. */
export function isValidOrgDisplayName(name: string): boolean {
  const s = name.trim();
  if (!s) return false;
  if (/^[-–—\s.]+$/.test(s)) return false;
  if (/^(заказчик|исполнитель)$/i.test(s)) return false;
  if (s.length > 100) return false;
  return true;
}

/** Строка организации в разделе «Согласовано»: «ООО «Ромашка»:». */
export function formatApprovalOrgLine(org: string): string {
  const t = org.trim();
  if (!t || /^(заказчик|исполнитель)$/i.test(t)) return 'не указано в расшифровке';
  if (/^ООО\s/i.test(t)) return `${t}:`;
  const inner = t.replace(/^ООО\s*[«"'„](.+?)[»"'"]$/, '$1').trim();
  if (inner !== t) return `ООО «${inner}»:`;
  return `${t}:`;
}

/** Многострочное поле → markdown-список. Однострочное возвращается как есть. */
export function formatMultilineField(text: string): string {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length <= 1) return text;
  return lines.map((l) => `- ${l}`).join('\n');
}
```

- [ ] **Step 2: Убрать дубликаты в двух файлах**

В `lib/docx-generator.ts` удалить локальные `normalizeDocxOrgName`, `isValidOrgDisplayName`, `formatApprovalOrgLine` и добавить `isValidOrgDisplayName`, `formatApprovalOrgLine` в существующий импорт из `./protocol-markdown-format`. Заменить вызовы `formatApprovalOrgLine` на импортированную версию.

В `app/api/chat/agents/document-agent.ts` удалить локальные `isValidOrgDisplayName` и `formatMultilineField`, добавить их в существующий импорт из `@/lib/protocol-markdown-format`. Локальную `formatApprOrg` внутри `protocolToMarkdown` заменить на импортированную `formatApprovalOrgLine`.

- [ ] **Step 3: Проверить, что ничего не сломалось**

Run: `npx tsc --noEmit && npm test`
Expected: компиляция без ошибок, все существующие тесты проходят.

- [ ] **Step 4: Написать фикстуру**

Создать `lib/docx-template/__tests__/fixtures.ts`:

```ts
import type { Protocol } from '@/lib/schemas/protocol-schema';

/**
 * Эталонный протокол для тестов сборки.
 *
 * Поля намеренно «чистые»: cleanProtocolText не должна их менять, иначе круговой
 * тест markdown → Protocol → markdown будет падать не по делу.
 */
export const SAMPLE_PROTOCOL: Protocol = {
  protocolNumber: '№7',
  meetingDate: '12.01.2025',
  protocolTitle: 'Обновление 1С:БГУ',
  contractNumber: '1122435346',
  contractDate: '30.12.2025',
  contractSubject: 'Сопровождение ГИС «Единая централизованная система»',
  agenda: {
    items: ['Версия и дата обновления 1С:БГУ', 'Регламент доступа к тестовому контуру'],
  },
  participants: {
    customer: {
      organizationName: 'ООО «Ромашка»',
      people: [{ fullName: 'Иванов И.И.', position: 'Главный бухгалтер' }],
    },
    executor: {
      organizationName: 'ООО «Форус»',
      people: [
        { fullName: 'Петров П.П.', position: 'Руководитель проекта' },
        { fullName: 'Сидоров С.С.', position: 'Аналитик' },
      ],
    },
  },
  meetingContent: {
    topics: [
      {
        title: 'Принятие решения о версии обновления',
        listened: 'Иванов И.И., Петров П.П.',
        discussed: 'Рассмотрели релиз 2.0.102.79 и окно обновления после 20:00.',
        decided: 'Обновить 1С:БГУ на релиз 2.0.102.79\nСрок: 09.04.2025\nОтветственные: Петров П.П.',
      },
      {
        title: 'Доступ к тестовому контуру',
        listened: 'Сидоров С.С.',
        discussed: 'Обсудили порядок выдачи учётных записей.',
        decided: 'Выдать доступ трём сотрудникам заказчика',
      },
    ],
    summary: [
      {
        question: 'Версия и дата обновления 1С:БГУ',
        decision: 'Обновление на релиз 2.0.102.79\nСрок: 09.04.2025\nОтветственные: Петров П.П.',
      },
    ],
  },
  approval: {
    customer: { organization: 'ООО «Ромашка»', signatories: ['Иванов И.И.'] },
    executor: { organization: 'ООО «Форус»', signatories: ['Петров П.П.', 'Сидоров С.С.'] },
  },
};
```

- [ ] **Step 5: Написать падающий тест разделов 1–3**

Создать `lib/docx-template/__tests__/protocol-body-head.test.ts`:

```ts
import {
  buildAgendaXml,
  buildHeaderXml,
  buildMeetingDateXml,
  buildParticipantsXml,
} from '../protocol-body';
import { IND_AGENDA_LEFT, NUM_AGENDA, NUM_SECTION, SZ_TITLE, TBL_PARTICIPANTS } from '../style';
import { SAMPLE_PROTOCOL } from './fixtures';

describe('buildHeaderXml', () => {
  it('ставит номер и дату по центру жирным одиннадцатым кеглем', () => {
    const xml = buildHeaderXml(SAMPLE_PROTOCOL);

    expect(xml).toContain('ПРОТОКОЛ №7 ОТ 12.01.2025');
    expect(xml).toContain('<w:jc w:val="center"/>');
    expect(xml).toContain(`<w:sz w:val="${SZ_TITLE}"/>`);
  });

  it('добавляет № к номеру, если модель его не поставила', () => {
    const xml = buildHeaderXml({ ...SAMPLE_PROTOCOL, protocolNumber: '7' });
    expect(xml).toContain('ПРОТОКОЛ №7 ОТ');
  });

  it('выводит договор и тему договора', () => {
    const xml = buildHeaderXml(SAMPLE_PROTOCOL);

    expect(xml).toContain('Договор №1122435346 от 30.12.2025 г.');
    expect(xml).toContain('Тема договора: ');
  });

  it('опускает тему договора, когда её нет', () => {
    const xml = buildHeaderXml({ ...SAMPLE_PROTOCOL, contractSubject: undefined });
    expect(xml).not.toContain('Тема договора');
  });
});

describe('buildMeetingDateXml', () => {
  it('нумерует раздел через numbering.xml и подчёркивает заголовок', () => {
    const xml = buildMeetingDateXml(SAMPLE_PROTOCOL);

    expect(xml).toContain(`<w:numId w:val="${NUM_SECTION}"/>`);
    expect(xml).toContain('<w:u w:val="single"/>');
    expect(xml).toContain('Дата собрания: ');
    expect(xml).toContain('12.01.2025');
  });

  it('не подставляет номер раздела текстом', () => {
    expect(buildMeetingDateXml(SAMPLE_PROTOCOL)).not.toContain('1.\t');
  });
});

describe('buildAgendaXml', () => {
  it('выносит пункты повестки в отдельный нумерованный список', () => {
    const xml = buildAgendaXml(SAMPLE_PROTOCOL);

    expect(xml).toContain(`<w:numId w:val="${NUM_AGENDA}"/>`);
    expect(xml).toContain(`w:left="${IND_AGENDA_LEFT}"`);
    expect(xml).toContain('Версия и дата обновления 1С:БГУ');
    expect(xml).toContain('Регламент доступа к тестовому контуру');
  });

  it('выбрасывает пустые пункты', () => {
    const xml = buildAgendaXml({
      ...SAMPLE_PROTOCOL,
      agenda: { items: ['Вопрос', '   ', ''] },
    });
    expect(xml.match(new RegExp(`<w:numId w:val="${NUM_AGENDA}"/>`, 'g'))).toHaveLength(1);
  });
});

describe('buildParticipantsXml', () => {
  it('строит две таблицы шаблонной ширины', () => {
    const xml = buildParticipantsXml(SAMPLE_PROTOCOL);
    const [wName, wPos] = TBL_PARTICIPANTS.grid;

    expect(xml.match(/<w:tbl>/g)).toHaveLength(2);
    expect(xml).toContain(`<w:gridCol w:w="${wName}"/><w:gridCol w:w="${wPos}"/>`);
    expect(xml).toContain(`<w:tblW w:w="${TBL_PARTICIPANTS.width}" w:type="dxa"/>`);
  });

  it('не заливает шапку серым — в шаблоне заливки нет', () => {
    expect(buildParticipantsXml(SAMPLE_PROTOCOL)).not.toContain('D9D9D9');
  });

  it('подписывает стороны и показывает организации', () => {
    const xml = buildParticipantsXml(SAMPLE_PROTOCOL);

    expect(xml).toContain('Заказчик — ООО «Ромашка»');
    expect(xml).toContain('Исполнитель — ООО «Форус»');
  });

  it('оставляет голую подпись стороны, когда организация — заглушка', () => {
    const xml = buildParticipantsXml({
      ...SAMPLE_PROTOCOL,
      participants: {
        ...SAMPLE_PROTOCOL.participants,
        customer: { ...SAMPLE_PROTOCOL.participants.customer, organizationName: 'Заказчик' },
      },
    });
    expect(xml).toContain('<w:t xml:space="preserve">Заказчик</w:t>');
  });

  it('выбрасывает строки-заголовки, попавшие в участников от модели', () => {
    const xml = buildParticipantsXml({
      ...SAMPLE_PROTOCOL,
      participants: {
        ...SAMPLE_PROTOCOL.participants,
        customer: {
          organizationName: 'ООО «Ромашка»',
          people: [
            { fullName: 'ФИО', position: 'Должность' },
            { fullName: 'Иванов И.И.', position: 'Главный бухгалтер' },
          ],
        },
      },
    });
    // Шапка таблицы одна, лишней строки «ФИО | Должность» в теле нет.
    expect(xml.match(/<w:t xml:space="preserve">ФИО<\/w:t>/g)).toHaveLength(2);
  });
});
```

- [ ] **Step 6: Прогнать тест и убедиться, что он падает**

Run: `npx jest lib/docx-template/__tests__/protocol-body-head.test.ts`
Expected: FAIL — `Cannot find module '../protocol-body'`.

- [ ] **Step 7: Написать разделы 1–3**

Создать `lib/docx-template/protocol-body.ts`:

```ts
/**
 * Protocol → OOXML. Единственное место, где структура протокола превращается
 * в разметку Word. Про zip, файловую систему и HTTP тут не знают.
 */
import {
  cleanProtocolText,
  formatContractBlock,
  isValidOrgDisplayName,
  isValidParticipantRow,
  parseInlineMarkdownBold,
} from '@/lib/protocol-markdown-format';
import type { Protocol } from '@/lib/schemas/protocol-schema';
import { cell, paragraph, row, run, table } from './ooxml';
import {
  IND_AGENDA_HANGING,
  IND_AGENDA_LEFT,
  IND_SECTION_HANGING,
  IND_SECTION_LEFT,
  LINE_115,
  NUM_AGENDA,
  NUM_SECTION,
  SPACING_AFTER_BLOCK,
  SZ_TITLE,
  TBL_PARTICIPANTS,
} from './style';

/** Пустой абзац-разделитель. После таблицы обязателен: иначе Word склеит соседние таблицы. */
function spacer(): string {
  return paragraph('', { spacingLine: LINE_115 });
}

/** Заголовок нумерованного раздела: подчёркнутый текст, номер — из numbering.xml. */
function sectionHeading(title: string, valueXml = ''): string {
  return paragraph(run(title, { underline: true }) + valueXml, {
    numId: NUM_SECTION,
    indentLeft: IND_SECTION_LEFT,
    indentHanging: IND_SECTION_HANGING,
    spacingLine: LINE_115,
  });
}

/** Инлайновый **жирный** из полей протокола → набор <w:r>. */
function inlineRuns(text: string, options: { bold?: boolean; italic?: boolean } = {}): string {
  const segments = parseInlineMarkdownBold(cleanProtocolText(text)).filter((s) => s.text.length > 0);
  if (segments.length === 0) return run('', options);
  return segments
    .map((s) => run(s.text, { bold: s.bold || options.bold, italic: options.italic }))
    .join('');
}

export function buildHeaderXml(protocol: Protocol): string {
  const raw = String(protocol.protocolNumber ?? '').trim();
  const number = raw.startsWith('№') ? raw : `№${raw}`;

  const parts: string[] = [
    paragraph(
      run(`ПРОТОКОЛ ${number} ОТ ${protocol.meetingDate}`, { bold: true, size: SZ_TITLE }),
      { align: 'center', indentFirstLine: 0, spacingAfter: SPACING_AFTER_BLOCK },
    ),
  ];

  const title = cleanProtocolText(protocol.protocolTitle);
  if (title) {
    parts.push(
      paragraph(run(title, { bold: true, size: SZ_TITLE }), {
        align: 'center',
        indentFirstLine: 0,
        spacingAfter: SPACING_AFTER_BLOCK,
      }),
    );
  }

  parts.push(
    paragraph(run(formatContractBlock(protocol)), {
      indentFirstLine: 0,
      spacingAfter: SPACING_AFTER_BLOCK,
    }),
  );

  const subject = cleanProtocolText(protocol.contractSubject ?? '');
  if (subject) {
    parts.push(
      paragraph(run('Тема договора: ') + inlineRuns(subject), {
        indentFirstLine: 0,
        spacingAfter: SPACING_AFTER_BLOCK,
      }),
    );
  }

  return parts.join('');
}

export function buildMeetingDateXml(protocol: Protocol): string {
  return sectionHeading('Дата собрания: ', run(protocol.meetingDate));
}

export function buildAgendaXml(protocol: Protocol): string {
  const items = protocol.agenda.items
    .map((item) => cleanProtocolText(item))
    .filter(Boolean)
    .map((item) =>
      paragraph(run(item), {
        numId: NUM_AGENDA,
        indentLeft: IND_AGENDA_LEFT,
        indentHanging: IND_AGENDA_HANGING,
        spacingLine: LINE_115,
      }),
    )
    .join('');

  return sectionHeading('Повестка:') + items;
}

function participantsTable(people: Array<{ fullName: string; position: string }>): string {
  const [wName, wPos] = TBL_PARTICIPANTS.grid;
  const centered = { align: 'center', indentFirstLine: 0, spacingLine: LINE_115 } as const;
  const plain = { indentFirstLine: 0, spacingLine: LINE_115 } as const;

  const header = row(
    cell(paragraph(run('ФИО'), centered), { width: wName }) +
      cell(paragraph(run('Должность'), centered), { width: wPos }),
  );

  const body = people
    .filter((p) => isValidParticipantRow(p.fullName, p.position))
    .map((p) =>
      row(
        cell(paragraph(inlineRuns(p.fullName), plain), { width: wName }) +
          cell(paragraph(inlineRuns(p.position), plain), { width: wPos }),
      ),
    )
    .join('');

  return table(header + body, {
    grid: TBL_PARTICIPANTS.grid,
    width: TBL_PARTICIPANTS.width,
    borders: 'single',
  });
}

export function buildParticipantsXml(protocol: Protocol): string {
  /** «Заказчик» плюс название организации, если оно осмысленное. */
  const sideLabel = (label: string, org: string) => {
    const name = org?.trim() ?? '';
    const text = isValidOrgDisplayName(name) ? `${label} — ${name}` : label;
    return paragraph(run(text), { align: 'center', indentFirstLine: 0, spacingLine: LINE_115 });
  };

  const { customer, executor } = protocol.participants;

  return (
    sectionHeading('Участники:') +
    sideLabel('Заказчик', customer.organizationName) +
    participantsTable(customer.people) +
    spacer() +
    sideLabel('Исполнитель', executor.organizationName) +
    participantsTable(executor.people) +
    spacer()
  );
}
```

- [ ] **Step 8: Прогнать тест**

Run: `npx jest lib/docx-template/__tests__/protocol-body-head.test.ts`
Expected: PASS, 13 тестов.

- [ ] **Step 9: Коммит**

```bash
git add lib/protocol-markdown-format.ts lib/docx-generator.ts app/api/chat/agents/document-agent.ts lib/docx-template/protocol-body.ts lib/docx-template/__tests__/fixtures.ts lib/docx-template/__tests__/protocol-body-head.test.ts
git commit -m "feat: сборка шапки и разделов 1-3 протокола в OOXML"
```

---

### Task 4: Разделы 4–5 и сборка тела целиком

**Files:**
- Modify: `lib/docx-template/protocol-body.ts` (дописать)
- Test: `lib/docx-template/__tests__/protocol-body-content.test.ts`

**Interfaces:**
- Consumes: всё из Task 3 плюс `resolveApprovalForDocument`, `splitDecisionSegments`, `formatApprovalOrgLine` из `lib/protocol-markdown-format`; `TBL_SUMMARY`, `TBL_APPROVAL`, `NUM_TOPIC`, `IND_TOPIC_LEFT`, `IND_TOPIC_HANGING`, `IND_APPROVAL_NAME_LEFT`, `IND_APPROVAL_NAME_RIGHT` из `./style`.
- Produces: `buildMeetingContentXml(protocol: Protocol): string`, `buildSummaryXml(protocol: Protocol): string`, `buildApprovalXml(protocol: Protocol): string`, `buildProtocolBodyXml(protocol: Protocol): string`.

- [ ] **Step 1: Написать падающий тест**

Создать `lib/docx-template/__tests__/protocol-body-content.test.ts`:

```ts
import {
  buildApprovalXml,
  buildMeetingContentXml,
  buildProtocolBodyXml,
  buildSummaryXml,
} from '../protocol-body';
import { NUM_TOPIC, TBL_APPROVAL, TBL_SUMMARY } from '../style';
import { SAMPLE_PROTOCOL } from './fixtures';

describe('buildMeetingContentXml', () => {
  it('нумерует вопросы отдельным списком', () => {
    const xml = buildMeetingContentXml(SAMPLE_PROTOCOL);

    expect(xml.match(new RegExp(`<w:numId w:val="${NUM_TOPIC}"/>`, 'g'))).toHaveLength(2);
    expect(xml).toContain('Принятие решения о версии обновления');
    expect(xml).toContain('Доступ к тестовому контуру');
  });

  it('делает метки Слушали/Обсудили/Решили жирными', () => {
    const xml = buildMeetingContentXml(SAMPLE_PROTOCOL);

    for (const label of ['Слушали:', 'Обсудили:', 'Решили:']) {
      expect(xml).toContain(`<w:b/><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr><w:t xml:space="preserve">${label}`);
    }
  });

  it('многострочное решение разбивает на абзацы с маркерами', () => {
    const xml = buildMeetingContentXml(SAMPLE_PROTOCOL);

    expect(xml).toContain('Срок: 09.04.2025');
    expect(xml).toContain('Ответственные: Петров П.П.');
    expect(xml).toContain('<w:t xml:space="preserve">• </w:t>');
  });

  it('пропускает пустые блоки', () => {
    const xml = buildMeetingContentXml({
      ...SAMPLE_PROTOCOL,
      meetingContent: {
        summary: [],
        topics: [{ title: 'Вопрос', listened: '', discussed: '', decided: '' }],
      },
    });

    expect(xml).not.toContain('Слушали');
    expect(xml).not.toContain('Обсудили');
  });
});

describe('buildSummaryXml', () => {
  it('строит таблицу шаблонной ширины и подчёркивает заголовок', () => {
    const xml = buildSummaryXml(SAMPLE_PROTOCOL);

    expect(xml).toContain(`<w:tblW w:w="${TBL_SUMMARY.width}" w:type="dxa"/>`);
    expect(xml).toContain('<w:u w:val="single"/>');
    expect(xml).toContain('Резюме:');
    expect(xml).toContain('Обсуждаемые вопросы');
    expect(xml).toContain('Принятые решения');
  });

  it('не нумерует Резюме — в шаблоне это не раздел', () => {
    expect(buildSummaryXml(SAMPLE_PROTOCOL)).not.toContain('<w:numPr>');
  });

  it('метки Срок и Ответственные — отдельными жирными абзацами', () => {
    const xml = buildSummaryXml(SAMPLE_PROTOCOL);

    expect(xml).toContain('<w:t xml:space="preserve">Срок:</w:t>');
    expect(xml).toContain('<w:t xml:space="preserve">Ответственные:</w:t>');
  });

  it('на пустом резюме не выводит ничего', () => {
    const xml = buildSummaryXml({
      ...SAMPLE_PROTOCOL,
      meetingContent: { ...SAMPLE_PROTOCOL.meetingContent, summary: [] },
    });
    expect(xml).toBe('');
  });
});

describe('buildApprovalXml', () => {
  it('строит таблицу из четырёх колонок с отступом', () => {
    const xml = buildApprovalXml(SAMPLE_PROTOCOL);

    expect(xml).toContain(
      TBL_APPROVAL.grid.map((w) => `<w:gridCol w:w="${w}"/>`).join(''),
    );
    expect(xml).toContain(`<w:tblInd w:w="${TBL_APPROVAL.indent}" w:type="dxa"/>`);
  });

  it('шапку разносит на две ячейки по две колонки', () => {
    const xml = buildApprovalXml(SAMPLE_PROTOCOL);

    expect(xml).toContain('Со стороны Заказчика');
    expect(xml).toContain('Со стороны Исполнителя');
    expect(xml.match(/<w:gridSpan w:val="2"\/>/g)).toHaveLength(2);
  });

  it('даёт по строке на подписанта — их столько, сколько у самой длинной стороны', () => {
    const xml = buildApprovalXml(SAMPLE_PROTOCOL);

    expect(xml).toContain('Иванов И.И.');
    expect(xml).toContain('Петров П.П.');
    expect(xml).toContain('Сидоров С.С.');
    // Шапка + две строки подписантов.
    expect(xml.match(/<w:tr>/g)).toHaveLength(3);
  });

  it('линия подписи — нижняя граница ячейки, а не подчёркнутый текст', () => {
    const xml = buildApprovalXml(SAMPLE_PROTOCOL);

    expect(xml).toContain(
      '<w:tcBorders><w:top w:val="nil"/><w:left w:val="nil"/><w:right w:val="nil"/></w:tcBorders>',
    );
    expect(xml).not.toContain('/______________');
  });

  it('не рисует лишнюю линию там, где у стороны подписанта нет', () => {
    const xml = buildApprovalXml(SAMPLE_PROTOCOL);
    const rows = xml.split('<w:tr>').slice(1);
    const lastRow = rows[rows.length - 1];

    // Во второй строке подписант есть только у исполнителя: одна линия, а не две.
    const lines = lastRow.match(
      /<w:tcBorders><w:top w:val="nil"\/><w:left w:val="nil"\/><w:right w:val="nil"\/><\/w:tcBorders>/g,
    );
    expect(lines).toHaveLength(1);
  });

  it('оформляет название организации так же, как markdown-версия протокола', () => {
    const xml = buildApprovalXml({
      ...SAMPLE_PROTOCOL,
      approval: {
        customer: { organization: 'Ромашка', signatories: ['Иванов И.И.'] },
        executor: { organization: 'ООО «Форус»', signatories: ['Петров П.П.'] },
      },
    });

    // formatApprovalOrgLine добавляет двоеточие и не дописывает ООО к голому имени.
    expect(xml).toContain('Ромашка:');
    expect(xml).toContain('ООО «Форус»:');
  });

  it('пишет заглушку, когда организация не распознана', () => {
    const xml = buildApprovalXml({
      ...SAMPLE_PROTOCOL,
      participants: {
        customer: { organizationName: '', people: [] },
        executor: { organizationName: '', people: [] },
      },
      approval: {
        customer: { organization: '', signatories: [] },
        executor: { organization: '', signatories: [] },
      },
    });

    expect(xml).toContain('не указано в расшифровке');
  });
});

describe('снимок вёрстки', () => {
  it('document.xml тела протокола не меняется незаметно', () => {
    expect(buildProtocolBodyXml(SAMPLE_PROTOCOL)).toMatchSnapshot();
  });
});

describe('buildProtocolBodyXml', () => {
  it('собирает все разделы по порядку', () => {
    const xml = buildProtocolBodyXml(SAMPLE_PROTOCOL);
    const order = [
      'ПРОТОКОЛ №7',
      'Дата собрания:',
      'Повестка:',
      'Участники:',
      'Содержание встречи:',
      'Резюме:',
      'Согласовано:',
    ];

    let previous = -1;
    for (const marker of order) {
      const at = xml.indexOf(marker);
      expect(at).toBeGreaterThan(previous);
      previous = at;
    }
  });

  it('заканчивается абзацем — иначе Word ломается на таблице перед sectPr', () => {
    expect(buildProtocolBodyXml(SAMPLE_PROTOCOL).endsWith('<w:p></w:p>')).toBe(true);
  });

  it('не оставляет незакрытых тегов', () => {
    const xml = buildProtocolBodyXml(SAMPLE_PROTOCOL);

    expect(xml.match(/<w:tbl>/g)?.length).toBe(xml.match(/<\/w:tbl>/g)?.length);
    expect(xml.match(/<w:tc>/g)?.length).toBe(xml.match(/<\/w:tc>/g)?.length);
    expect(xml.match(/<w:p>/g)?.length).toBe(xml.match(/<\/w:p>/g)?.length);
  });
});
```

- [ ] **Step 2: Прогнать тест и убедиться, что он падает**

Run: `npx jest lib/docx-template/__tests__/protocol-body-content.test.ts`
Expected: FAIL — `buildMeetingContentXml is not a function`.

- [ ] **Step 3: Дописать разделы 4–5**

В `lib/docx-template/protocol-body.ts` расширить импорты:

```ts
import {
  cleanProtocolText,
  formatApprovalOrgLine,
  formatContractBlock,
  isValidOrgDisplayName,
  isValidParticipantRow,
  parseInlineMarkdownBold,
  resolveApprovalForDocument,
  splitDecisionSegments,
} from '@/lib/protocol-markdown-format';
```

```ts
import {
  IND_AGENDA_HANGING,
  IND_AGENDA_LEFT,
  IND_APPROVAL_NAME_LEFT,
  IND_APPROVAL_NAME_RIGHT,
  IND_SECTION_HANGING,
  IND_SECTION_LEFT,
  IND_TOPIC_HANGING,
  IND_TOPIC_LEFT,
  LINE_115,
  NUM_AGENDA,
  NUM_SECTION,
  NUM_TOPIC,
  SPACING_AFTER_BLOCK,
  SZ_TITLE,
  TBL_APPROVAL,
  TBL_PARTICIPANTS,
  TBL_SUMMARY,
} from './style';
```

И дописать в конец файла:

```ts
/** «Слушали:» / «Обсудили:» / «Решили:». Многострочное значение — по абзацу на строку. */
function labeledBlock(label: string, value: string): string {
  const text = cleanProtocolText(value);
  if (!text) return '';

  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);

  if (lines.length <= 1) {
    return paragraph(run(`${label} `, { bold: true }) + inlineRuns(text), {
      indentFirstLine: 0,
      spacingLine: LINE_115,
    });
  }

  return (
    paragraph(run(label, { bold: true }), { indentFirstLine: 0, spacingLine: LINE_115 }) +
    lines
      .map((line) =>
        paragraph(run('• ') + inlineRuns(line), {
          indentFirstLine: 0,
          indentLeft: IND_TOPIC_LEFT,
          spacingLine: LINE_115,
        }),
      )
      .join('')
  );
}

export function buildMeetingContentXml(protocol: Protocol): string {
  const topics = protocol.meetingContent.topics
    .map((topic) =>
      [
        paragraph(inlineRuns(topic.title, { bold: true }), {
          numId: NUM_TOPIC,
          indentLeft: IND_TOPIC_LEFT,
          indentHanging: IND_TOPIC_HANGING,
          spacingLine: LINE_115,
        }),
        labeledBlock('Слушали:', topic.listened),
        labeledBlock('Обсудили:', topic.discussed),
        labeledBlock('Решили:', topic.decided),
        spacer(),
      ].join(''),
    )
    .join('');

  return sectionHeading('Содержание встречи:') + topics;
}

/** Ячейка решения: основной текст, затем «Срок:» и «Ответственные:» отдельными абзацами. */
function decisionParagraphs(raw: string): string {
  const segments = splitDecisionSegments(raw);
  if (segments.length === 0) return paragraph('', { indentFirstLine: 0 });

  return segments
    .map((segment) => {
      const m = segment.match(/^(Срок\s*:|Ответственн\w*\s*:)\s*([\s\S]*)/i);
      if (m) {
        const rest = m[2].trim();
        return paragraph(run(m[1].trim(), { bold: true }) + (rest ? run(` ${rest}`) : ''), {
          indentFirstLine: 0,
        });
      }
      return paragraph(inlineRuns(segment), { indentFirstLine: 0 });
    })
    .join('');
}

export function buildSummaryXml(protocol: Protocol): string {
  const rows = protocol.meetingContent.summary;
  if (rows.length === 0) return '';

  const [wQuestion, wDecision] = TBL_SUMMARY.grid;
  const centered = { align: 'center', indentFirstLine: 0 } as const;

  const header = row(
    cell(paragraph(run('Обсуждаемые вопросы'), centered), { width: wQuestion }) +
      cell(paragraph(run('Принятые решения'), centered), { width: wDecision }),
  );

  const body = rows
    .map((r) =>
      row(
        cell(paragraph(inlineRuns(r.question), { indentFirstLine: 0 }), { width: wQuestion }) +
          cell(decisionParagraphs(r.decision), { width: wDecision }),
      ),
    )
    .join('');

  return (
    paragraph(run('Резюме:', { underline: true }), { indentFirstLine: 0, spacingLine: LINE_115 }) +
    table(header + body, {
      grid: TBL_SUMMARY.grid,
      width: TBL_SUMMARY.width,
      borders: 'single',
    }) +
    spacer()
  );
}

export function buildApprovalXml(protocol: Protocol): string {
  const sides = resolveApprovalForDocument(protocol);
  const [wNameLeft, wSignLeft, wNameRight, wSignRight] = TBL_APPROVAL.grid;

  const headSide = (width: number, title: string, organization: string) =>
    cell(
      paragraph(run(title, { bold: true }), { align: 'center' }) +
        paragraph(run(formatApprovalOrgLine(organization)), { align: 'center' }),
      { width, gridSpan: 2, borders: 'none' },
    );

  const header = row(
    headSide(wNameLeft + wSignLeft, 'Со стороны Заказчика', sides.customer.organization) +
      headSide(wNameRight + wSignRight, 'Со стороны Исполнителя', sides.executor.organization),
  );

  const customerSignatories = sides.customer.signatories;
  const executorSignatories = sides.executor.signatories;
  const rowCount = Math.max(customerSignatories.length, executorSignatories.length, 1);

  const body: string[] = [];
  for (let i = 0; i < rowCount; i++) {
    const customer = customerSignatories[i]?.trim() ?? '';
    const executor = executorSignatories[i]?.trim() ?? '';

    // Сторона без подписантов всё равно получает одну линию для подписи от руки.
    const customerHasLine = i < Math.max(customerSignatories.length, 1);
    const executorHasLine = i < Math.max(executorSignatories.length, 1);

    body.push(
      row(
        cell(paragraph(run(customer), { indentLeft: IND_APPROVAL_NAME_LEFT, indentFirstLine: 0 }), {
          width: wNameLeft,
          borders: 'none',
        }) +
          cell(paragraph(''), {
            width: wSignLeft,
            borders: customerHasLine ? 'bottom' : 'none',
          }) +
          cell(
            paragraph(run(executor), { indentLeft: IND_APPROVAL_NAME_RIGHT, indentFirstLine: 0 }),
            { width: wNameRight, borders: 'none' },
          ) +
          cell(paragraph(''), {
            width: wSignRight,
            borders: executorHasLine ? 'bottom' : 'none',
          }),
      ),
    );
  }

  return (
    sectionHeading('Согласовано:') +
    table(header + body.join(''), {
      grid: TBL_APPROVAL.grid,
      width: TBL_APPROVAL.width,
      indent: TBL_APPROVAL.indent,
      borders: 'single',
    })
  );
}

export function buildProtocolBodyXml(protocol: Protocol): string {
  return (
    buildHeaderXml(protocol) +
    buildMeetingDateXml(protocol) +
    buildAgendaXml(protocol) +
    buildParticipantsXml(protocol) +
    buildMeetingContentXml(protocol) +
    buildSummaryXml(protocol) +
    buildApprovalXml(protocol) +
    // Абзац после последней таблицы: без него Word считает файл повреждённым.
    paragraph('')
  );
}
```

- [ ] **Step 4: Прогнать тесты**

Run: `npx jest lib/docx-template/`
Expected: PASS, все тесты модуля.

- [ ] **Step 5: Коммит**

```bash
git add lib/docx-template/protocol-body.ts lib/docx-template/__tests__/protocol-body-content.test.ts
git commit -m "feat: сборка разделов 4-5 и тела протокола целиком"
```

---

### Task 5: Загрузка шаблона и сборка пакета

**Files:**
- Create: `lib/docx-template/template.ts`
- Create: `lib/docx-template/render.ts`
- Test: `lib/docx-template/__tests__/render.test.ts`

**Interfaces:**
- Consumes: `buildProtocolBodyXml` из `./protocol-body`.
- Produces:
  - `template.ts`: `loadTemplateBuffer(): Promise<Buffer>`, `loadTemplateZip(): Promise<JSZip>`, `TEMPLATE_PATH: string`.
  - `render.ts`: `assembleDocumentXml(templateXml: string, bodyXml: string): string`, `renderProtocolDocx(protocol: Protocol): Promise<Buffer>`.

- [ ] **Step 1: Написать загрузку шаблона**

Создать `lib/docx-template/template.ts`:

```ts
/** Единственное место, где шаблон читается с диска. */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';

export const TEMPLATE_PATH = path.join(
  process.cwd(),
  'lib',
  'docx-template',
  'assets',
  'protocol-template.docx',
);

let cached: Buffer | null = null;

export async function loadTemplateBuffer(): Promise<Buffer> {
  if (cached) return cached;
  try {
    cached = await readFile(TEMPLATE_PATH);
  } catch (cause) {
    throw new Error(
      `Не найден шаблон протокола: ${TEMPLATE_PATH}. ` +
        'Соберите его командой npm run build:protocol-template, ' +
        'а в Docker убедитесь, что каталог lib/docx-template/assets попадает в образ.',
      { cause },
    );
  }
  return cached;
}

/**
 * Свежий JSZip на каждый вызов: один экземпляр нельзя переиспользовать между
 * параллельными генерациями — они затрут друг другу document.xml.
 */
export async function loadTemplateZip(): Promise<JSZip> {
  return JSZip.loadAsync(await loadTemplateBuffer());
}
```

- [ ] **Step 2: Написать падающий тест сборки**

Создать `lib/docx-template/__tests__/render.test.ts`:

```ts
/** @jest-environment node */
import { readFile } from 'node:fs/promises';
import JSZip from 'jszip';
import { assembleDocumentXml, renderProtocolDocx } from '../render';
import { TEMPLATE_PATH } from '../template';
import { SAMPLE_PROTOCOL } from './fixtures';

describe('assembleDocumentXml', () => {
  const templateXml =
    '<?xml version="1.0"?><w:document xmlns:w="urn:w" mc:Ignorable="w14"><w:body>' +
    '<w:p>старое</w:p>' +
    '<w:sectPr><w:pgSz w:w="11906"/></w:sectPr>' +
    '</w:body></w:document>';

  it('переносит корневой элемент и sectPr из шаблона', () => {
    const xml = assembleDocumentXml(templateXml, '<w:p>новое</w:p>');

    expect(xml).toContain('<w:document xmlns:w="urn:w" mc:Ignorable="w14">');
    expect(xml).toContain('<w:sectPr><w:pgSz w:w="11906"/></w:sectPr>');
    expect(xml).toContain('<w:p>новое</w:p>');
    expect(xml).not.toContain('старое');
  });

  it('ставит sectPr последним элементом body', () => {
    const xml = assembleDocumentXml(templateXml, '<w:p>новое</w:p>');
    expect(xml.endsWith('</w:sectPr></w:body></w:document>')).toBe(true);
  });

  it('падает понятной ошибкой на шаблоне без sectPr', () => {
    expect(() =>
      assembleDocumentXml('<w:document><w:body></w:body></w:document>', ''),
    ).toThrow(/sectPr/);
  });
});

describe('renderProtocolDocx', () => {
  it('отдаёт валидный zip', async () => {
    const buffer = await renderProtocolDocx(SAMPLE_PROTOCOL);
    const zip = await JSZip.loadAsync(buffer);

    expect(Object.keys(zip.files)).toContain('word/document.xml');
  });

  it('переносит оформление из шаблона байт-в-байт', async () => {
    const source = await JSZip.loadAsync(await readFile(TEMPLATE_PATH));
    const result = await JSZip.loadAsync(await renderProtocolDocx(SAMPLE_PROTOCOL));

    const parts = [
      'word/styles.xml',
      'word/numbering.xml',
      'word/header1.xml',
      'word/footer1.xml',
      'word/media/image1.png',
      'word/theme/theme1.xml',
    ];

    for (const part of parts) {
      const before = await source.file(part)!.async('nodebuffer');
      const after = await result.file(part)!.async('nodebuffer');
      expect(after.equals(before)).toBe(true);
    }
  });

  it('кладёт данные протокола в document.xml', async () => {
    const zip = await JSZip.loadAsync(await renderProtocolDocx(SAMPLE_PROTOCOL));
    const doc = await zip.file('word/document.xml')!.async('string');

    expect(doc).toContain('ПРОТОКОЛ №7 ОТ 12.01.2025');
    expect(doc).toContain('Иванов И.И.');
    expect(doc).toContain('<w:headerReference');
    expect(doc).toContain('w:top="1424"');
  });

  it('не тащит шрифты в результат', async () => {
    const zip = await JSZip.loadAsync(await renderProtocolDocx(SAMPLE_PROTOCOL));
    expect(Object.keys(zip.files).filter((n) => n.startsWith('word/fonts/'))).toEqual([]);
  });

  it('две параллельные сборки не мешают друг другу', async () => {
    const other = { ...SAMPLE_PROTOCOL, protocolNumber: '№99' };
    const [first, second] = await Promise.all([
      renderProtocolDocx(SAMPLE_PROTOCOL),
      renderProtocolDocx(other),
    ]);

    const read = async (b: Buffer) =>
      (await JSZip.loadAsync(b)).file('word/document.xml')!.async('string');

    expect(await read(first)).toContain('ПРОТОКОЛ №7');
    expect(await read(second)).toContain('ПРОТОКОЛ №99');
  });
});
```

- [ ] **Step 3: Прогнать тест и убедиться, что он падает**

Run: `npx jest lib/docx-template/__tests__/render.test.ts`
Expected: FAIL — `Cannot find module '../render'`.

- [ ] **Step 4: Написать сборку пакета**

Создать `lib/docx-template/render.ts`:

```ts
/**
 * Сборка .docx: берём шаблон, подменяем word/document.xml, остальное не трогаем.
 * Про структуру протокола тут не знают — за неё отвечает protocol-body.ts.
 */
import type { Protocol } from '@/lib/schemas/protocol-schema';
import { buildProtocolBodyXml } from './protocol-body';
import { loadTemplateZip } from './template';

const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';
const ROOT_OPEN_RX = /<w:document\b[^>]*>/;
const SECT_PR_RX = /<w:sectPr\b[\s\S]*?<\/w:sectPr>/;

/**
 * Корневой элемент со всеми объявлениями namespace и sectPr (поля страницы,
 * ссылки на колонтитулы) берутся из шаблона, а не хардкодятся: при замене
 * шаблона на новую версию они подхватятся сами.
 */
export function assembleDocumentXml(templateXml: string, bodyXml: string): string {
  const rootOpen = templateXml.match(ROOT_OPEN_RX);
  if (!rootOpen) {
    throw new Error('Шаблон протокола повреждён: в word/document.xml нет <w:document>');
  }

  const sectPr = templateXml.match(SECT_PR_RX);
  if (!sectPr) {
    throw new Error('Шаблон протокола повреждён: в word/document.xml нет <w:sectPr>');
  }

  return `${XML_DECLARATION}${rootOpen[0]}<w:body>${bodyXml}${sectPr[0]}</w:body></w:document>`;
}

export async function renderProtocolDocx(protocol: Protocol): Promise<Buffer> {
  const zip = await loadTemplateZip();

  const templateEntry = zip.file('word/document.xml');
  if (!templateEntry) {
    throw new Error('Шаблон протокола повреждён: нет word/document.xml');
  }

  const documentXml = assembleDocumentXml(
    await templateEntry.async('string'),
    buildProtocolBodyXml(protocol),
  );

  zip.file('word/document.xml', documentXml);

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
```

- [ ] **Step 5: Прогнать тесты**

Run: `npx jest lib/docx-template/`
Expected: PASS, все тесты модуля.

- [ ] **Step 6: Коммит**

```bash
git add lib/docx-template/template.ts lib/docx-template/render.ts lib/docx-template/__tests__/render.test.ts
git commit -m "feat: сборка .docx протокола на основе корпоративного шаблона"
```

---

### Task 6: Переключение генератора на шаблон

**Files:**
- Modify: `lib/docx-generator.ts` (заменить содержимое целиком)
- Test: `lib/__tests__/docx-generator.test.ts`

**Interfaces:**
- Consumes: `renderProtocolDocx` из `lib/docx-template/render`.
- Produces: `generateProtocolDocx(protocol: Protocol): Promise<Buffer>` — сигнатура прежняя, вызывающий код в `document-agent.ts` не меняется.

- [ ] **Step 1: Написать падающий тест**

Создать `lib/__tests__/docx-generator.test.ts`:

```ts
/** @jest-environment node */
import JSZip from 'jszip';
import { SAMPLE_PROTOCOL } from '@/lib/docx-template/__tests__/fixtures';
import { generateProtocolDocx } from '../docx-generator';

describe('generateProtocolDocx', () => {
  it('собирает документ по корпоративному шаблону', async () => {
    const zip = await JSZip.loadAsync(await generateProtocolDocx(SAMPLE_PROTOCOL));

    // Колонтитулы с логотипом и реквизитами появились только после перехода на шаблон.
    expect(Object.keys(zip.files)).toEqual(
      expect.arrayContaining(['word/header1.xml', 'word/footer1.xml', 'word/media/image1.png']),
    );
  });

  it('больше не заливает шапки таблиц серым', async () => {
    const zip = await JSZip.loadAsync(await generateProtocolDocx(SAMPLE_PROTOCOL));
    const doc = await zip.file('word/document.xml')!.async('string');

    expect(doc).not.toContain('D9D9D9');
  });
});
```

- [ ] **Step 2: Прогнать тест и убедиться, что он падает**

Run: `npx jest lib/__tests__/docx-generator.test.ts`
Expected: FAIL — в пакете нет `word/header1.xml`, есть `D9D9D9`.

- [ ] **Step 3: Заменить содержимое docx-generator.ts**

Полностью заменить `lib/docx-generator.ts` на:

```ts
import { renderProtocolDocx } from './docx-template/render';
import type { Protocol } from './schemas/protocol-schema';

/**
 * Собирает протокол в .docx по корпоративному шаблону заказчика.
 *
 * Вся вёрстка живёт в lib/docx-template: оформление берётся из самого шаблона,
 * здесь остаётся только точка входа с исторической сигнатурой.
 */
export async function generateProtocolDocx(protocol: Protocol): Promise<Buffer> {
  return renderProtocolDocx(protocol);
}
```

- [ ] **Step 4: Прогнать тесты и сборку**

Run: `npx jest && npx tsc --noEmit`
Expected: все тесты PASS, компиляция без ошибок.

Если `tsc` ругается на неиспользуемые импорты `docx` — библиотека `docx` больше не нужна ни одному файлу. Проверить: `grep -rn "from 'docx'" app lib components --include=*.ts --include=*.tsx`. Если совпадений нет, удалить `docx` из `dependencies` в `package.json` и выполнить `npm install`.

- [ ] **Step 5: Коммит**

```bash
git add lib/docx-generator.ts lib/__tests__/docx-generator.test.ts package.json package-lock.json
git commit -m "feat: генерация протокола идёт через корпоративный шаблон"
```

---

### Task 7: Обратный разбор markdown в Protocol

**Files:**
- Modify: `app/api/chat/agents/document-agent.ts:1108-1215` (перенести `protocolToMarkdown`)
- Modify: `lib/protocol-markdown-format.ts` (принять `protocolToMarkdown`)
- Create: `lib/protocol-markdown-parse.ts`
- Test: `lib/__tests__/protocol-markdown-parse.test.ts`

**Interfaces:**
- Consumes: `protocolToMarkdown` из `lib/protocol-markdown-format`; `coerceProtocolPartial` из `lib/schemas/protocol-schema`; `buildProtocolBodyXml` из `lib/docx-template/protocol-body` (в тестах).
- Produces: `markdownToProtocol(markdown: string): Protocol` из `lib/protocol-markdown-parse`; `protocolToMarkdown(protocol: Protocol): string` из `lib/protocol-markdown-format`.

- [ ] **Step 1: Перенести protocolToMarkdown к остальным форматтерам**

Вырезать функцию `protocolToMarkdown` из `app/api/chat/agents/document-agent.ts` (строки 1108–1215) и вставить в конец `lib/protocol-markdown-format.ts`, добавив `export`. Внутри неё заменить локальный вызов `formatApprOrg` на `formatApprovalOrgLine` (перенесена в Task 3) и удалить объявление `formatApprOrg`.

В `document-agent.ts` добавить `protocolToMarkdown` в существующий импорт из `@/lib/protocol-markdown-format`.

Функция чистая — это перенос без изменения поведения. `markUnresolvedInMarkdown` остаётся в `document-agent.ts`.

- [ ] **Step 2: Проверить, что перенос ничего не сломал**

Run: `npx tsc --noEmit && npm test && npm run build`
Expected: компиляция и сборка без ошибок, все тесты проходят.

- [ ] **Step 3: Написать падающий тест разбора**

Создать `lib/__tests__/protocol-markdown-parse.test.ts`:

```ts
import { buildProtocolBodyXml } from '@/lib/docx-template/protocol-body';
import { SAMPLE_PROTOCOL } from '@/lib/docx-template/__tests__/fixtures';
import { protocolToMarkdown } from '../protocol-markdown-format';
import { markdownToProtocol } from '../protocol-markdown-parse';

/** Повторяет разметку маркеров из document-agent.markUnresolvedInMarkdown. */
function markUnresolved(md: string): string {
  return md
    .replace(/не указано в расшифровке/gi, '⚠️ не указано в расшифровке — требует уточнения')
    .replace(/⚠️\s*⚠️/g, '⚠️');
}

describe('markdownToProtocol', () => {
  it('вытаскивает шапку протокола', () => {
    const parsed = markdownToProtocol(protocolToMarkdown(SAMPLE_PROTOCOL));

    expect(parsed.protocolNumber).toBe('№7');
    expect(parsed.meetingDate).toBe('12.01.2025');
    expect(parsed.protocolTitle).toBe('Обновление 1С:БГУ');
    expect(parsed.contractNumber).toBe('1122435346');
    expect(parsed.contractDate).toBe('30.12.2025');
    expect(parsed.contractSubject).toContain('Сопровождение ГИС');
  });

  it('разбирает повестку без хвостовых точек с запятой', () => {
    const parsed = markdownToProtocol(protocolToMarkdown(SAMPLE_PROTOCOL));

    expect(parsed.agenda.items).toEqual([
      'Версия и дата обновления 1С:БГУ',
      'Регламент доступа к тестовому контуру',
    ]);
  });

  it('разбирает участников обеих сторон вместе с организациями', () => {
    const parsed = markdownToProtocol(protocolToMarkdown(SAMPLE_PROTOCOL));

    expect(parsed.participants.customer.organizationName).toBe('ООО «Ромашка»');
    expect(parsed.participants.executor.people).toHaveLength(2);
    expect(parsed.participants.executor.people[0]).toEqual({
      fullName: 'Петров П.П.',
      position: 'Руководитель проекта',
    });
  });

  it('разбирает вопросы вместе со Слушали/Обсудили/Решили', () => {
    const parsed = markdownToProtocol(protocolToMarkdown(SAMPLE_PROTOCOL));

    expect(parsed.meetingContent.topics).toHaveLength(2);
    expect(parsed.meetingContent.topics[0].listened).toBe('Иванов И.И., Петров П.П.');
    expect(parsed.meetingContent.topics[0].decided).toContain('Срок: 09.04.2025');
  });

  it('разбирает таблицу резюме, снимая <br> и жирный', () => {
    const parsed = markdownToProtocol(protocolToMarkdown(SAMPLE_PROTOCOL));

    expect(parsed.meetingContent.summary).toHaveLength(1);
    expect(parsed.meetingContent.summary[0].question).toBe('Версия и дата обновления 1С:БГУ');
    expect(parsed.meetingContent.summary[0].decision).toContain('Срок: 09.04.2025');
    expect(parsed.meetingContent.summary[0].decision).not.toContain('<br>');
    expect(parsed.meetingContent.summary[0].decision).not.toContain('**');
  });

  it('разбирает подписантов, снимая линии для подписи', () => {
    const parsed = markdownToProtocol(protocolToMarkdown(SAMPLE_PROTOCOL));

    expect(parsed.approval.customer.signatories).toEqual(['Иванов И.И.']);
    expect(parsed.approval.executor.signatories).toEqual(['Петров П.П.', 'Сидоров С.С.']);
    expect(parsed.approval.customer.organization).toBe('ООО «Ромашка»');
  });

  it('не тащит в документ маркеры «требует уточнения»', () => {
    const parsed = markdownToProtocol(markUnresolved(protocolToMarkdown({
      ...SAMPLE_PROTOCOL,
      approval: {
        customer: { organization: '', signatories: [] },
        executor: { organization: '', signatories: [] },
      },
      participants: {
        customer: { organizationName: '', people: [] },
        executor: { organizationName: '', people: [] },
      },
    })));

    const serialized = JSON.stringify(parsed);
    expect(serialized).not.toContain('⚠️');
    expect(serialized).not.toContain('требует уточнения');
  });

  it('не падает на пустом вводе', () => {
    const parsed = markdownToProtocol('');

    expect(parsed.agenda.items).toEqual([]);
    expect(parsed.meetingContent.topics).toEqual([]);
  });
});

describe('круговой разбор', () => {
  const cases: Array<[string, typeof SAMPLE_PROTOCOL]> = [
    ['полный протокол', SAMPLE_PROTOCOL],
    [
      'без резюме',
      {
        ...SAMPLE_PROTOCOL,
        meetingContent: { ...SAMPLE_PROTOCOL.meetingContent, summary: [] },
      },
    ],
    [
      'без подписантов',
      {
        ...SAMPLE_PROTOCOL,
        approval: {
          customer: { organization: 'ООО «Ромашка»', signatories: [] },
          executor: { organization: 'ООО «Форус»', signatories: [] },
        },
      },
    ],
    [
      'разное число подписантов у сторон',
      {
        ...SAMPLE_PROTOCOL,
        approval: {
          customer: { organization: 'ООО «Ромашка»', signatories: ['Иванов И.И.'] },
          executor: {
            organization: 'ООО «Форус»',
            signatories: ['Петров П.П.', 'Сидоров С.С.', 'Кузнецов К.К.'],
          },
        },
      },
    ],
  ];

  it.each(cases)('%s: markdown → Protocol → та же вёрстка', (_name, protocol) => {
    const roundTripped = markdownToProtocol(protocolToMarkdown(protocol));

    expect(buildProtocolBodyXml(roundTripped)).toBe(buildProtocolBodyXml(protocol));
  });
});
```

- [ ] **Step 4: Прогнать тест и убедиться, что он падает**

Run: `npx jest lib/__tests__/protocol-markdown-parse.test.ts`
Expected: FAIL — `Cannot find module '../protocol-markdown-parse'`.

- [ ] **Step 5: Написать парсер**

Создать `lib/protocol-markdown-parse.ts`:

```ts
/**
 * Обратный разбор markdown-протокола в Protocol.
 *
 * Нужен ровно для одного сценария: пользователь отредактировал текст в правой
 * панели руками, и DOCX надо пересобрать из правленого текста. Формат входа
 * фиксирован — его порождает protocolToMarkdown. Детерминированно, без LLM.
 */
import { isMarkdownTableSeparatorRow, isValidParticipantRow } from './protocol-markdown-format';
import { coerceProtocolPartial, type Protocol } from './schemas/protocol-schema';

const SECTION_RX = /^##\s*(\d{1,2})\.\s*(.+?)\s*$/;

interface Section {
  title: string;
  body: string[];
}

/** Снимает пометки, которые markUnresolvedInMarkdown добавляет только для показа в панели. */
function stripUnresolvedMarkers(text: string): string {
  return String(text ?? '')
    .replace(/\s*—\s*(?:⚠️\s*)?требует уточнения/gi, '')
    .replace(/⚠️\s*/g, '');
}

function splitSections(lines: string[]): { preamble: string[]; sections: Section[] } {
  const preamble: string[] = [];
  const sections: Section[] = [];
  let current: Section | null = null;

  for (const line of lines) {
    const m = line.match(SECTION_RX);
    if (m) {
      current = { title: m[2], body: [] };
      sections.push(current);
      continue;
    }
    if (current) current.body.push(line);
    else preamble.push(line);
  }

  return { preamble, sections };
}

function findSection(sections: Section[], rx: RegExp): Section | undefined {
  return sections.find((s) => rx.test(s.title));
}

/** Читает подряд идущие строки markdown-таблицы, пропуская строку-разделитель. */
function parseTableRows(lines: string[], start: number): { rows: string[][]; next: number } {
  const rows: string[][] = [];
  let i = start;

  while (i < lines.length && lines[i].trim().startsWith('|')) {
    const cells = lines[i]
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((c) => c.trim());
    if (!isMarkdownTableSeparatorRow(cells)) rows.push(cells);
    i++;
  }

  return { rows, next: i };
}

function firstTableIndex(lines: string[]): number {
  return lines.findIndex((l) => l.trim().startsWith('|'));
}

function parseContract(text: string): { contractNumber?: string; contractDate?: string } {
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => /^Договор\b/i.test(l));

  if (!line || /не\s+указан/i.test(line)) return {};

  const number = line.match(/№\s*(\S+)/);
  const date = line.match(/\bот\s+(.+?)(?:\s*г\.)?$/i);

  return {
    contractNumber: number ? number[1].trim() : undefined,
    contractDate: date ? date[1].trim() : undefined,
  };
}

function parsePreamble(preamble: string[]) {
  const text = preamble.join('\n');

  const head = text.match(/ПРОТОКОЛ\s*(\S+)\s*ОТ\s*([^\n]*)/i);
  const protocolNumber = head ? head[1].trim() : '';
  const meetingDate = head ? head[2].trim() : '';

  const titleLine = preamble.find((l) => /^\*\*.+\*\*$/.test(l.trim()));
  const protocolTitle = titleLine ? titleLine.trim().replace(/^\*\*|\*\*$/g, '').trim() : '';

  const subjectLine = preamble
    .map((l) => l.trim())
    .find((l) => /^Тема договора:/i.test(l));
  const contractSubject = subjectLine
    ? subjectLine.replace(/^Тема договора:\s*/i, '').trim()
    : undefined;

  return { protocolNumber, meetingDate, protocolTitle, contractSubject, ...parseContract(text) };
}

function parseAgenda(body: string[]): string[] {
  return body
    .map((l) => l.trim())
    .filter((l) => /^\d+[).]\s+/.test(l))
    // Точку с запятой в конце ставит форматтер, в исходных данных её нет.
    .map((l) => l.replace(/^\d+[).]\s+/, '').replace(/;$/, '').trim())
    .filter(Boolean);
}

function emptySide() {
  return { organizationName: '', people: [] as Array<{ fullName: string; position: string }> };
}

function parseParticipants(body: string[]) {
  const sides = { customer: emptySide(), executor: emptySide() };
  let side: 'customer' | 'executor' | null = null;

  for (let i = 0; i < body.length; i++) {
    const line = body[i].trim();

    const head = line.match(/^\*\*(Заказчик|Исполнитель)(?:\s*[—–-]\s*(.+?))?\*\*$/);
    if (head) {
      side = head[1] === 'Заказчик' ? 'customer' : 'executor';
      sides[side].organizationName = (head[2] ?? '').trim();
      continue;
    }

    if (side && line.startsWith('|')) {
      const { rows, next } = parseTableRows(body, i);
      sides[side].people = rows
        .map((cells) => ({ fullName: cells[0] ?? '', position: cells[1] ?? '' }))
        .filter((p) => isValidParticipantRow(p.fullName, p.position));
      i = next - 1;
      side = null;
    }
  }

  return sides;
}

/** Ячейка резюме: <br> и жирный — это разметка форматтера, в поле их быть не должно. */
function summaryCellToPlain(cellText: string): string {
  return cellText
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/\*\*/g, '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .join('\n');
}

function parseContent(body: string[]) {
  const topics: Protocol['meetingContent']['topics'] = [];
  const summary: Protocol['meetingContent']['summary'] = [];

  let topic: Protocol['meetingContent']['topics'][number] | null = null;
  let label: 'listened' | 'discussed' | 'decided' | null = null;

  for (let i = 0; i < body.length; i++) {
    const trimmed = body[i].trim();

    const topicHead = trimmed.match(/^\*\*\s*\d+\)\s*(.+?)\s*\*\*$/);
    if (topicHead) {
      topic = { title: topicHead[1], listened: '', discussed: '', decided: '' };
      topics.push(topic);
      label = null;
      continue;
    }

    if (/^\*\*Резюме:\*\*$/i.test(trimmed)) {
      const from = firstTableIndex(body.slice(i + 1));
      if (from >= 0) {
        const { rows, next } = parseTableRows(body, i + 1 + from);
        for (const cells of rows) {
          const question = (cells[0] ?? '').replace(/\*\*/g, '').trim();
          if (/^обсуждаемые вопросы$/i.test(question)) continue;
          const decision = summaryCellToPlain(cells[1] ?? '');
          if (question || decision) summary.push({ question, decision });
        }
        i = next - 1;
      }
      topic = null;
      label = null;
      continue;
    }

    const labelled = trimmed.match(/^\*\*(Слушали|Обсудили|Решили):\*\*\s*(.*)$/i);
    if (labelled && topic) {
      const key = labelled[1].toLowerCase();
      label = key === 'слушали' ? 'listened' : key === 'обсудили' ? 'discussed' : 'decided';
      topic[label] = labelled[2].trim();
      continue;
    }

    if (topic && label && trimmed) {
      const value = trimmed.replace(/^[-*]\s+/, '');
      topic[label] = topic[label] ? `${topic[label]}\n${value}` : value;
    }
  }

  return { topics, summary };
}

function parseApproval(body: string[]) {
  const start = firstTableIndex(body);
  if (start < 0) return null;

  const { rows } = parseTableRows(body, start);
  const data = rows.filter((cells) => !/^\*\*Со стороны/i.test(cells[0] ?? ''));
  if (data.length === 0) return null;

  const [orgRow, ...signatureRows] = data;

  const org = (s: string) => s.replace(/\*\*/g, '').replace(/:\s*$/, '').trim();
  const signatory = (s: string) => s.replace(/\s*\/_+\s*$/, '').replace(/^_+$/, '').trim();

  return {
    customer: {
      organization: org(orgRow[0] ?? ''),
      signatories: signatureRows.map((r) => signatory(r[0] ?? '')).filter(Boolean),
    },
    executor: {
      organization: org(orgRow[1] ?? ''),
      signatories: signatureRows.map((r) => signatory(r[1] ?? '')).filter(Boolean),
    },
  };
}

export function markdownToProtocol(markdown: string): Protocol {
  const lines = stripUnresolvedMarkers(markdown).replace(/\r\n?/g, '\n').split('\n');
  const { preamble, sections } = splitSections(lines);

  const head = parsePreamble(preamble);
  const agendaSection = findSection(sections, /^Повестка/i);
  const participantsSection = findSection(sections, /^Участники/i);
  const contentSection = findSection(sections, /^Содержание встречи/i);
  const approvalSection = findSection(sections, /^Согласовано/i);
  const dateSection = findSection(sections, /^Дата собрания/i);

  // Раздел «Дата собрания» авторитетнее шапки: пользователь правит именно его.
  const sectionDate = dateSection?.title.replace(/^Дата собрания:\s*/i, '').trim();

  const participants = participantsSection
    ? parseParticipants(participantsSection.body)
    : { customer: emptySide(), executor: emptySide() };

  const content = contentSection
    ? parseContent(contentSection.body)
    : { topics: [], summary: [] };

  const approval = approvalSection ? parseApproval(approvalSection.body) : null;

  return coerceProtocolPartial({
    protocolNumber: head.protocolNumber,
    meetingDate: sectionDate || head.meetingDate,
    protocolTitle: head.protocolTitle,
    contractNumber: head.contractNumber,
    contractDate: head.contractDate,
    contractSubject: head.contractSubject,
    agenda: { items: agendaSection ? parseAgenda(agendaSection.body) : [] },
    participants,
    meetingContent: content,
    approval: approval ?? {
      customer: { organization: '', signatories: [] },
      executor: { organization: '', signatories: [] },
    },
  });
}
```

- [ ] **Step 6: Прогнать тесты**

Run: `npx jest lib/__tests__/protocol-markdown-parse.test.ts`
Expected: PASS, 12 тестов.

Если круговой тест падает на конкретном поле, чинить парсер, а не подгонять фикстуру: несовпадение означает, что правленый пользователем текст потеряет данные.

- [ ] **Step 7: Коммит**

```bash
git add lib/protocol-markdown-format.ts lib/protocol-markdown-parse.ts app/api/chat/agents/document-agent.ts lib/__tests__/protocol-markdown-parse.test.ts
git commit -m "feat: обратный разбор markdown-протокола в Protocol"
```

---

### Task 8: Единый серверный путь скачивания

**Files:**
- Modify: `app/api/download-docx/route.ts` (целиком)
- Modify: `components/document/DocumentPanel.tsx:167,200-215,320-376,415-470,478-495`
- Modify: `lib/document/types.ts:1-6`
- Modify: `package.json` (убрать `@mohtasham/md-to-docx`)
- Test: `app/api/download-docx/__tests__/route.test.ts`

**Interfaces:**
- Consumes: `markdownToProtocol` из `lib/protocol-markdown-parse`; `generateProtocolDocx` из `lib/docx-generator`.
- Produces: `POST /api/download-docx` принимает либо `{ content: string; filename: string }` (base64 готового файла), либо `{ markdown: string; filename: string }`; отвечает бинарным `.docx`.

- [ ] **Step 1: Написать падающий тест роута**

Создать `app/api/download-docx/__tests__/route.test.ts`:

```ts
/** @jest-environment node */
import JSZip from 'jszip';
import { SAMPLE_PROTOCOL } from '@/lib/docx-template/__tests__/fixtures';
import { protocolToMarkdown } from '@/lib/protocol-markdown-format';
import { POST } from '../route';

function request(body: unknown): Request {
  return new Request('http://localhost/api/download-docx', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/download-docx', () => {
  it('собирает документ из правленого markdown по шаблону', async () => {
    const response = await POST(request({
      markdown: protocolToMarkdown(SAMPLE_PROTOCOL),
      filename: 'Протокол.docx',
    }) as never);

    expect(response.status).toBe(200);

    const zip = await JSZip.loadAsync(Buffer.from(await response.arrayBuffer()));
    expect(Object.keys(zip.files)).toContain('word/header1.xml');

    const doc = await zip.file('word/document.xml')!.async('string');
    expect(doc).toContain('ПРОТОКОЛ №7');
  });

  it('отдаёт как есть уже собранный base64', async () => {
    const response = await POST(request({
      content: Buffer.from('готовый файл').toString('base64'),
      filename: 'Протокол.docx',
    }) as never);

    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe('готовый файл');
  });

  it('отвергает запрос без содержимого', async () => {
    const response = await POST(request({ filename: 'Протокол.docx' }) as never);
    expect(response.status).toBe(400);
  });
});
```

- [ ] **Step 2: Прогнать тест и убедиться, что он падает**

Run: `npx jest app/api/download-docx`
Expected: FAIL — на markdown-запросе роут отвечает 400.

- [ ] **Step 3: Расширить роут**

Полностью заменить `app/api/download-docx/route.ts` на:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { generateProtocolDocx } from '@/lib/docx-generator';
import { markdownToProtocol } from '@/lib/protocol-markdown-parse';

/**
 * Отдаёт .docx протокола.
 *
 * Обычный путь: клиент присылает base64 файла, который сервер уже собрал по
 * шаблону во время генерации, — просто отдаём его.
 *
 * После ручной правки в панели готового файла нет: клиент присылает markdown,
 * и мы пересобираем документ из него, снова по шаблону. Сборка на клиенте
 * убрана намеренно — иначе правленый протокол выходил бы с другим оформлением.
 */
export async function POST(request: NextRequest) {
  try {
    const { content, markdown, filename } = await request.json();

    if (!filename || (!content && !markdown)) {
      return NextResponse.json({ error: 'Missing content or filename' }, { status: 400 });
    }

    const buffer = content
      ? Buffer.from(content, 'base64')
      : await generateProtocolDocx(markdownToProtocol(markdown));

    return new NextResponse(buffer, {
      headers: {
        'Content-Type':
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(filename)}"`,
        'Content-Length': buffer.length.toString(),
      },
    });
  } catch (error) {
    console.error('Error generating docx:', error);
    return NextResponse.json({ error: 'Failed to generate document' }, { status: 500 });
  }
}
```

- [ ] **Step 4: Прогнать тест роута**

Run: `npx jest app/api/download-docx`
Expected: PASS, 3 теста.

- [ ] **Step 5: Убрать сборку docx с клиента**

В `components/document/DocumentPanel.tsx`:

1. Удалить функцию `buildDocxData` целиком (около строки 455) и функцию `arrayBufferToBase64` (около строки 443), если она больше нигде не используется.

2. В эффекте около строки 203 убрать ветку автогенерации — оставить только присвоение пришедших данных:

```tsx
      if (document.docxData) {
        setDocxData(document.docxData);
      }
```

3. В `saveEdit` (около строки 478) заменить пересборку на сброс содержимого с сохранением имени файла:

```tsx
  const saveEdit = async () => {
    const updated: DocumentState = {
      ...localDoc,
      title: draftTitle,
      content: draftContent,
    };
    setLocalDoc(updated);
    setEditing(false);

    // Файл пересоберёт сервер по корпоративному шаблону — на клиенте его больше
    // не собираем, иначе правленый протокол выходил бы с другим оформлением.
    const next = { filename: docxData?.filename ?? sanitizeFilename(updated.title, 'document') + '.docx' };
    setDocxData(next);
    onEdit?.({ ...updated, docxData: next });
  };
```

4. В `handleDownloadDocx` (около строки 415) отправлять markdown, когда готового файла нет:

```tsx
  const handleDownloadDocx = async () => {
    if (!hasProtocol || !docxData) return;

    try {
      void persistProtocolExample();
      const response = await fetch('/api/download-docx', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          docxData.content
            ? { content: docxData.content, filename: docxData.filename }
            : { markdown: localDoc.content, filename: docxData.filename },
        ),
      });

      if (!response.ok) throw new Error('Failed to download docx');

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = window.document.createElement('a');
      link.href = url;
      link.download = docxData.filename;
      window.document.body.appendChild(link);
      link.click();
      window.document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Error downloading docx:', error);
    }
  };
```

5. В `handleDownloadBundle` (около строки 324) заменить блок сборки через `md-to-docx` на запрос к серверу:

```tsx
      const JSZip = (await import('jszip')).default;
      const zip = new JSZip();

      const docFilename = docxData?.filename ?? sanitizeFilename(displayTitle, 'document') + '.docx';
      const response = await fetch('/api/download-docx', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          docxData?.content
            ? { content: docxData.content, filename: docFilename }
            : { markdown: viewContent, filename: docFilename },
        ),
      });
      if (!response.ok) throw new Error('Failed to build docx');
      zip.file(docFilename, await response.arrayBuffer());
```

6. Обновить тип `docxData`: поле `content` становится необязательным.

В `lib/document/types.ts`:

```ts
export type DocumentState = {
  title: string;
  content: string;
  isStreaming: boolean;
  /** content отсутствует, когда протокол правили руками: файл пересоберёт сервер. */
  docxData?: { content?: string; filename: string };
};
```

В `components/document/DocumentPanel.tsx:167`:

```tsx
  const [docxData, setDocxData] = useState<{ content?: string; filename: string } | null>(null);
```

- [ ] **Step 6: Убрать зависимость**

Run: `grep -rn "md-to-docx" app lib components --include=*.ts --include=*.tsx`
Expected: пусто.

Затем:

```bash
npm uninstall @mohtasham/md-to-docx
```

- [ ] **Step 7: Проверить сборку и тесты**

Run: `npx tsc --noEmit && npm test && npm run build`
Expected: всё зелёное.

Затем линтер — только по файлам этой ветки, а не по всему репозиторию:

Run: `npx biome check lib/docx-template lib/protocol-markdown-parse.ts lib/docx-generator.ts app/api/download-docx components/document/DocumentPanel.tsx lib/document/types.ts`
Expected: `Found 0 errors`.

Репозиторный `npm run lint` НЕ является критерием: на базовом коммите ветки (`5d43ba0`) biome уже даёт 310 ошибок и 467 предупреждений по всему проекту. Приводить чужой код в порядок в объём этой работы не входит — важно лишь не добавить своих.

- [ ] **Step 8: Коммит**

```bash
git add app/api/download-docx/route.ts app/api/download-docx/__tests__/route.test.ts components/document/DocumentPanel.tsx lib/document/types.ts package.json package-lock.json
git commit -m "feat: единый серверный путь сборки DOCX, клиентский md-to-docx удалён"
```

---

### Task 9: Визуальная сверка с эталоном

Автотесты проверяют структуру XML, но не то, как документ выглядит. Этот шаг рендерит результат и эталон в PNG и сравнивает их глазами. LibreOffice в среде разработки уже стоит.

**Files:**
- Create: `scripts/render-docx-preview.mjs`
- Modify: `lib/docx-template/__tests__/render.test.ts` (дописать тест-писатель образца)
- Modify: `package.json` (раздел `scripts`)
- Modify: `.gitignore`

**Interfaces:**
- Consumes: `SAMPLE_PROTOCOL`, `generateProtocolDocx`.
- Produces: PNG-страницы в `tmp/docx-preview/`.

- [ ] **Step 1: Написать скрипт рендера**

Создать `scripts/render-docx-preview.mjs`:

```js
/**
 * Рендерит .docx постранично в PNG через LibreOffice — чтобы глазами сверить
 * результат с эталонным шаблоном заказчика.
 *
 * Запуск: node scripts/render-docx-preview.mjs <файл.docx> [каталог]
 * Путь к LibreOffice можно задать переменной SOFFICE_PATH.
 */
import { execFile } from 'node:child_process';
import { mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

const SOFFICE =
  process.env.SOFFICE_PATH ?? 'C:\\Program Files\\LibreOffice\\program\\soffice.exe';

const source = process.argv[2];
const outDir = process.argv[3] ?? 'tmp/docx-preview';

if (!source) {
  console.error('Использование: node scripts/render-docx-preview.mjs <файл.docx> [каталог]');
  process.exit(1);
}

await mkdir(outDir, { recursive: true });

const png =
  'png:draw_png_Export:{"PixelWidth":{"type":"long","value":1240},' +
  '"PixelHeight":{"type":"long","value":1754}}';

await run(SOFFICE, ['--headless', '--convert-to', 'pdf', '--outdir', outDir, source]);

const pdf = path.join(outDir, `${path.basename(source, path.extname(source))}.pdf`);
await run(SOFFICE, ['--headless', '--convert-to', png, '--outdir', outDir, pdf]);

console.log(`Готово. Картинки в ${outDir}:`);
for (const name of (await readdir(outDir)).filter((n) => n.endsWith('.png'))) {
  console.log(`  ${path.join(outDir, name)}`);
}
console.log(
  '\nLibreOffice конвертирует в PNG только первую страницу.' +
    '\nЧтобы посмотреть остальные, откройте PDF: ' + pdf,
);
```

- [ ] **Step 2: Научиться складывать образец на диск**

В проекте нет ни `ts-node`, ни `tsx` (проверено: `ls node_modules/.bin | grep -E "ts-node|tsx"` пусто), поэтому импортировать `.ts` из `.mjs`-скрипта не выйдет. Образец пишет сам Jest — он и так умеет собирать TypeScript.

В конец `lib/docx-template/__tests__/render.test.ts`, внутрь `describe('renderProtocolDocx', …)`, добавить:

```ts
  it('кладёт на диск открываемый образец для визуальной сверки', async () => {
    const { mkdir, readFile, writeFile } = await import('node:fs/promises');
    await mkdir('tmp/docx-preview', { recursive: true });

    const target = 'tmp/docx-preview/sample.docx';
    await writeFile(target, await renderProtocolDocx(SAMPLE_PROTOCOL));

    // Файл кладём безусловно: tmp/ в .gitignore, зато образец для сверки
    // всегда свежий. Проверяем, что на диск лёг именно открываемый пакет.
    const written = await readFile(target);
    expect(written.length).toBeGreaterThan(10_000);

    const zip = await JSZip.loadAsync(written);
    const doc = await zip.file('word/document.xml')!.async('string');
    expect(doc).toContain('ПРОТОКОЛ №7');
  });
```

- [ ] **Step 3: Прописать команду и игнор**

В `package.json`, раздел `scripts`:

```json
"preview:protocol": "jest lib/docx-template/__tests__/render.test.ts && node scripts/render-docx-preview.mjs tmp/docx-preview/sample.docx"
```

В `.gitignore` добавить строку:

```
tmp/
```

В `.gitignore` добавить строку:

```
tmp/
```

- [ ] **Step 4: Отрендерить эталон заказчика**

Run: `node scripts/render-docx-preview.mjs "Шаблон протокола с комм.docx" tmp/docx-reference`
Expected: `tmp/docx-reference/Шаблон протокола с комм.png` — первая страница эталона с логотипом «Форус» справа сверху, нижним колонтитулом «СтК 2.40.08.02-01 … Версия 3.0» и линией над ним.

- [ ] **Step 5: Отрендерить результат**

Run: `npm run preview:protocol`
Expected: `tmp/docx-preview/sample.png`.

- [ ] **Step 6: Сверить попунктно**

Открыть обе картинки и проверить построчно:

- логотип «Форус» справа в верхнем колонтитуле, того же размера;
- нижний колонтитул: горизонтальная линия, слева «СтК 2.40.08.02-01», справа «Версия 3.0»;
- шрифт основного текста — Verdana, а не Calibri;
- «ПРОТОКОЛ № … ОТ …» по центру жирным;
- разделы пронумерованы 1–5, заголовки подчёркнуты и не жирные;
- «Резюме:» подчёркнуто и без номера;
- таблицы участников и резюме — с рамками, шапка без серой заливки;
- «Согласовано» — без рамок, ФИО слева, линия подписи справа от каждого ФИО;
- поля страницы: узкое правое поле, широкое верхнее (место под логотип).

Любое расхождение — правка в `lib/docx-template/style.ts` или `protocol-body.ts`, затем повтор шагов 5–6.

- [ ] **Step 7: Финальная проверка**

Run: `npm test && npm run build`
Expected: всё зелёное.

Run: `npx biome check lib/docx-template lib/protocol-markdown-parse.ts lib/docx-generator.ts app/api/download-docx components/document/DocumentPanel.tsx lib/document/types.ts scripts/build-protocol-template.mjs scripts/render-docx-preview.mjs`
Expected: `Found 0 errors` — по файлам этой ветки. Репозиторные ошибки biome в чужом коде (310 штук на базовом коммите) не трогаем.

- [ ] **Step 8: Коммит**

```bash
git add scripts/render-docx-preview.mjs lib/docx-template/__tests__/render.test.ts package.json .gitignore
git commit -m "chore: скрипты визуальной сверки DOCX с эталонным шаблоном"
```

---

## Замечания для исполнителя

**Что менять нельзя.** `word/styles.xml`, `word/numbering.xml`, `word/header1.xml`, `word/footer1.xml`, `word/theme/theme1.xml`, `word/media/image1.png` из шаблона переносятся байт-в-байт. Если хочется поправить оформление — это делается в `lib/docx-template/style.ts` либо заменой самого шаблона, но не редактированием этих частей в коде.

**Два расхождения между шаблонами.** В «чистом» шаблоне «Дата собрания» не входит в нумерованный список, в «с комм.» — входит и получает номер 1. Взят вариант «с комм.»: нумерация 1–5, «Резюме» без номера. Это совпадает с тем, что уже делает `protocolToMarkdown`.

**Название организации у сторон.** В шаблоне над таблицами участников стоит просто «Заказчик» / «Исполнитель». Реализация оставляет текущее поведение проекта и дописывает название организации, если оно осмысленное: «Заказчик — ООО «Ромашка»». Убирать его — значит терять информацию, которая сейчас в документе есть. Формат абзаца при этом шаблонный.

**Латентная проблема рядом.** `lib/prompts/glossary.ts` читает `data/glossary.json` через `process.cwd()`, а Dockerfile каталог `data/` в образ не копирует. Задача 1 чинит это только для шаблона протокола. В объём этого плана `data/` не входит.
