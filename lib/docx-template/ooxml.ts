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
