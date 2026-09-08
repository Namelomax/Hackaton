/**
 * Рендерит .docx постранично в PNG через LibreOffice — чтобы глазами сверить
 * результат с эталонным шаблоном заказчика.
 *
 * Запуск: node scripts/render-docx-preview.mjs <файл.docx> [каталог]
 * Путь к LibreOffice можно задать переменной SOFFICE_PATH.
 */
import { execFile } from "node:child_process";
import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

const SOFFICE =
  process.env.SOFFICE_PATH ??
  "C:\\Program Files\\LibreOffice\\program\\soffice.exe";

const source = process.argv[2];
const outDir = process.argv[3] ?? "tmp/docx-preview";

if (!source) {
  console.error(
    "Использование: node scripts/render-docx-preview.mjs <файл.docx> [каталог]",
  );
  process.exit(1);
}

await mkdir(outDir, { recursive: true });

const png =
  'png:draw_png_Export:{"PixelWidth":{"type":"long","value":1240},' +
  '"PixelHeight":{"type":"long","value":1754}}';

await run(SOFFICE, [
  "--headless",
  "--convert-to",
  "pdf",
  "--outdir",
  outDir,
  source,
]);

const pdf = path.join(
  outDir,
  `${path.basename(source, path.extname(source))}.pdf`,
);
await run(SOFFICE, [
  "--headless",
  "--convert-to",
  png,
  "--outdir",
  outDir,
  pdf,
]);

console.log(`Готово. Картинки в ${outDir}:`);
for (const name of (await readdir(outDir)).filter((n) => n.endsWith(".png"))) {
  console.log(`  ${path.join(outDir, name)}`);
}
console.log(
  "\nLibreOffice конвертирует в PNG только первую страницу." +
    "\nЧтобы посмотреть остальные, откройте PDF: " +
    pdf,
);
