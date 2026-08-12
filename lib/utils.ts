/**
 * Мелкие утилиты, безопасные для клиентского бандла.
 *
 * ВАЖНО: сюда нельзя добавлять ничего тяжёлого. Модуль экспортирует `cn` —
 * самую популярную функцию проекта (её импортируют 30+ клиентских компонентов),
 * поэтому всё, что здесь лежит, попадает в ПЕРВУЮ загрузку страницы.
 *
 * Раньше в этом же файле статически импортировались `jszip`, `mammoth` и `xlsx`
 * ради `extractTextFromFileUIPart`. Функцию никто не вызывал (извлечение текста
 * живёт на сервере в `lib/attachment-extract.ts`, а в браузере —
 * в `lib/attachment-extract-client.ts`, который прямо оставляет PDF/XLSX/PPTX
 * серверу), но парсер таблиц весом ~387 КБ грузился каждым пользователем.
 * Мёртвый код удалён вместе с зависимостями — за парсингом идти в
 * `lib/attachment-extract.ts`.
 */
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Умеем ли мы вытащить текст из файла такого типа (без обращения к серверу). */
export function isTextExtractable(mimeType: string): boolean {
  return [
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.ms-powerpoint',
    'text/plain',
    'text/markdown',
    'text/csv',
  ].includes(mimeType);
}
