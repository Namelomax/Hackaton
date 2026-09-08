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
export const TBL_APPROVAL = {
  grid: [1830, 3000, 2025, 2235],
  width: 9090,
  indent: 284,
} as const;
