/** Справочник форматов для памятки гостя (без проверок при загрузке). */
export const SUPPORTED_UPLOAD_FORMATS = [
  { ext: 'PDF', note: 'текст извлекается на сервере' },
  { ext: 'DOCX, DOC', note: 'Word' },
  { ext: 'TXT, MD, RTF', note: 'текст' },
  { ext: 'XLSX, XLS, CSV', note: 'таблицы' },
  { ext: 'PPTX, PPT', note: 'презентации' },
] as const;
