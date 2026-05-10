/**
 * Ручная проверка того, что реально лежит в SurrealDB по чатам.
 *
 * Запуск с хоста (порт 8000 проброшен):
 *   node scripts/inspect-conversations.mjs
 *   node scripts/inspect-conversations.mjs conversations:u06rkuelco0f39nwqqez
 *
 * Переменные из .env в корне (подставьте SURREALDB_URL для своего окружения).
 * В Docker web используется ws://surrealdb:8000/rpc — с машины замените на ws://127.0.0.1:8000/rpc
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Surreal from "surrealdb";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const envPath = path.join(root, ".env");

function loadDotEnv() {
  if (!fs.existsSync(envPath)) return;
  const raw = fs.readFileSync(envPath, "utf8");
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  }
}

function summarizeMessage(m, idx) {
  if (m == null) return { idx, error: "null" };
  const role = m.role ?? "?";
  const topText =
    typeof m.text === "string" ? m.text.slice(0, 120) : m.text != null ? String(m.text).slice(0, 120) : "";
  const parts = Array.isArray(m.parts) ? m.parts : [];
  const partSummary = parts.slice(0, 5).map((p, i) => {
    if (!p || typeof p !== "object") return `${i}:?`;
    const typ = p.type ?? "?";
    const tx = typeof p.text === "string" ? p.text.slice(0, 80) : "";
    return `${i}:${typ}${tx ? ` textLen=${tx.length}` : ""}`;
  });
  return { idx, role, topTextLen: topText.length, topTextPreview: topText, partsCount: parts.length, partSummary };
}

function summarizeRow(r) {
  const messages = Array.isArray(r.messages) ? r.messages : [];
  let rawLen = 0;
  let rawParsedLen = null;
  if (typeof r.messages_raw === "string" && r.messages_raw.length) {
    rawLen = r.messages_raw.length;
    try {
      const p = JSON.parse(r.messages_raw);
      rawParsedLen = Array.isArray(p) ? p.length : null;
    } catch {
      rawParsedLen = "parse_error";
    }
  }
  return {
    id: String(r.id ?? ""),
    title: r.title ?? null,
    messagesArrayLen: messages.length,
    messagesRawChars: rawLen,
    messagesRawParsedArrayLen: rawParsedLen,
    documentContentLen: typeof r.document_content === "string" ? r.document_content.length : 0,
    firstMessages: messages.slice(0, 4).map((m, i) => summarizeMessage(m, i)),
  };
}

async function main() {
  loadDotEnv();

  let url = process.env.SURREALDB_URL;
  const namespace = process.env.SURREALDB_NAMESPACE;
  const database = process.env.SURREALDB_DATABASE;
  const username = process.env.SURREALDB_USER;
  const password = process.env.SURREALDB_PASSWORD;

  if (url?.includes("surrealdb:") && !process.env.SURREALDB_URL_FORCE_DOCKER) {
    url = url.replace(/surrealdb/g, "127.0.0.1");
    console.warn("[inspect] Подмена host surrealdb → 127.0.0.1 (для запуска с хоста). Иначе: SURREALDB_URL=ws://127.0.0.1:8000/rpc");
  }

  if (!url || !namespace || !database || !username || !password) {
    console.error("Нужны SURREALDB_URL, SURREALDB_NAMESPACE, SURREALDB_DATABASE, SURREALDB_USER, SURREALDB_PASSWORD");
    process.exit(1);
  }

  const targetId = process.argv[2]?.trim();

  const db = new Surreal();
  await db.connect(url, { reconnect: true });
  await db.use({ namespace, database });
  await db.signin({ username: String(username), password: String(password) });

  let rows;
  if (targetId) {
    const m = targetId.match(/^([^:]+):(.+)$/);
    if (!m) {
      console.error("Ожидается id вида conversations:xxxx");
      process.exit(1);
    }
    const [, table, rid] = m;
    const q = await db.query(`SELECT * FROM type::thing($table, $rid);`, { table, rid });
    rows = (q?.[0] ?? []).filter(Boolean);
  } else {
    const q = await db.query(`SELECT * FROM conversations ORDER BY created DESC LIMIT 8;`);
    rows = q?.[0] ?? [];
  }

  console.log(JSON.stringify({ url, namespace, database, count: rows.length }, null, 2));

  for (const r of rows) {
    console.log("\n--- conversation ---\n", JSON.stringify(summarizeRow(r), null, 2));
    const messages = Array.isArray(r.messages) ? r.messages : [];
    if (messages.length === 0 && r.messages_raw) {
      console.log("[messages] array empty, messages_raw head:\n", String(r.messages_raw).slice(0, 600));
    }
  }

  await db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
