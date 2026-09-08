/** Единственное место, где шаблон читается с диска. */
import { readFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";

export const TEMPLATE_PATH = path.join(
  process.cwd(),
  "lib",
  "docx-template",
  "assets",
  "protocol-template.docx",
);

let cached: Buffer | null = null;

export async function loadTemplateBuffer(): Promise<Buffer> {
  if (cached) return cached;
  try {
    cached = await readFile(TEMPLATE_PATH);
  } catch (cause) {
    throw new Error(
      `Не найден шаблон протокола: ${TEMPLATE_PATH}. ` +
        "Соберите его командой npm run build:protocol-template, " +
        "а в Docker убедитесь, что каталог lib/docx-template/assets попадает в образ.",
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
