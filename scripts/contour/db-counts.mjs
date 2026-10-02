#!/usr/bin/env node
/**
 * Количество записей по таблицам SurrealDB — для сверки после переноса базы.
 * Только чтение.
 *
 *   node scripts/contour/db-counts.mjs [--env <файл>] [--out <counts.json>] [--expect <counts.json>]
 *
 *   --env     откуда брать подключение (SURREALDB_* или SURREAL_*). Без него —
 *             из переменных окружения процесса (так удобно внутри контейнера web).
 *   --out     сохранить результат в JSON (манифест рядом с дампом).
 *   --expect  сравнить с манифестом; код выхода 1, если что-то не сошлось.
 *
 * Сверка через манифест, а не «облако против контура» напрямую: из закрытого
 * контура до облака может не быть сети. Манифест снимается при экспорте
 * (db-export.sh), а в контуре база сравнивается с ним:
 *   docker compose run --rm --no-deps -v "$PWD/scripts:/app/scripts:ro" \
 *     -v "$PWD/backups:/backups:ro" web node scripts/contour/db-counts.mjs --expect /backups/<дамп>.counts.json
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { Surreal } from 'surrealdb';

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

function parseEnvFile(path) {
  const out = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    out[m[1]] = m[2].replace(/^['"]|['"]\s*$/g, '');
  }
  return out;
}

const envFile = arg('--env');
const env = envFile ? parseEnvFile(envFile) : process.env;
const pick = (...keys) => keys.map((k) => env[k]?.trim()).find(Boolean);

const url = pick('SURREALDB_URL', 'SURREAL_URL');
const namespace = pick('SURREALDB_NAMESPACE', 'SURREAL_NAMESPACE');
const database = pick('SURREALDB_DATABASE', 'SURREAL_DATABASE');
const username = pick('SURREALDB_USER', 'SURREAL_USER');
const password = pick('SURREALDB_PASSWORD', 'SURREAL_PASSWORD', 'SURREAL_PASS');

if (!url || !namespace || !database || !username || !password) {
  console.error('✗ не хватает SURREALDB_URL/NAMESPACE/DATABASE/USER/PASSWORD (или SURREAL_*)');
  process.exit(2);
}

/** Ответ db.query у surrealdb 1.x: [rows] или [{ result: rows }]. */
function rows(res) {
  const first = Array.isArray(res) ? res[0] : undefined;
  if (Array.isArray(first)) return first;
  if (first && Array.isArray(first.result)) return first.result;
  return first && typeof first === 'object' ? [first] : [];
}

const db = new Surreal();
try {
  await db.connect(url);
  await db.use({ namespace, database });
  // Так же, как приложение (lib/getPromt.ts): вход без namespace = root-уровень.
  await db.signin({ username, password });

  const [info] = rows(await db.query('INFO FOR DB;'));
  const tables = Object.keys(info?.tables ?? {}).sort();
  const counts = {};
  for (const table of tables) {
    const [row] = rows(await db.query('SELECT count() AS n FROM type::table($t) GROUP ALL;', { t: table }));
    counts[table] = Number(row?.n ?? 0);
  }

  const host = (() => {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  })();
  const report = { host, namespace, database, takenAt: new Date().toISOString(), counts };

  for (const [t, n] of Object.entries(counts)) console.log(`${t.padEnd(28)} ${n}`);

  const out = arg('--out');
  if (out) {
    writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`✓ манифест: ${out}`);
  }

  const expectPath = arg('--expect');
  if (expectPath) {
    const expected = JSON.parse(readFileSync(expectPath, 'utf8')).counts ?? {};
    const problems = [];
    for (const [t, n] of Object.entries(expected)) {
      if (counts[t] !== n) problems.push(`${t}: ожидалось ${n}, в базе ${counts[t] ?? 'нет таблицы'}`);
    }
    if (problems.length) {
      console.error(`✗ не сошлось:\n  ${problems.join('\n  ')}`);
      process.exitCode = 1;
    } else {
      console.log(`✓ все ${Object.keys(expected).length} таблиц совпали с манифестом`);
    }
  }
} catch (e) {
  console.error('✗', e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  await db.close().catch(() => {});
}
