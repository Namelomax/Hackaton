/**
 * Сквозной тест генерации протокола против ЖИВОЙ модели (gemma4:31b и т.п.).
 * Запуск из корня репозитория (нужны переменные окружения из .env / .env.local):
 *
 *   npx esbuild scripts/test-protocol-e2e.ts --bundle --platform=node --format=esm \
 *       --tsconfig=tsconfig.json --outfile=/tmp/e2e.mjs && node /tmp/e2e.mjs
 *
 * Проверяет ключевые фиксы: расшифровка доходит до агента документа (раздел 2/4 не
 * пустые), детерминированная чистка жаргона, валидность по Zod-схеме.
 */
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { SGR_DOCUMENT_AGENT_PROMPT } from '@/lib/prompts/sgr-prompts';
import { PROTOCOL_REGULATION } from '@/lib/prompts/regulation';
import { parseProtocolStrict, coerceProtocolPartial, parseLooseJsonObject } from '@/lib/schemas/protocol-schema';
import { mergeProtocolWithChatDraft } from '@/lib/protocol-chat-extract';
import { applyGlossaryToProtocol } from '@/lib/prompts/glossary';

function loadEnv(file: string) {
  try {
    const t = fs.readFileSync(file, 'utf8');
    for (const line of t.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {}
}
['.env.local', '.env'].forEach((f) => loadEnv(path.join(process.cwd(), f)));

const BASE = process.env.OLLAMA_BASE_URL;
const KEY = process.env.OLLAMA_API_KEY || 'ollama';
const MODEL = (process.env.ALLOWED_OLLAMA_MODELS || 'gemma4:31b').split(',')[0].trim();
if (!BASE) { console.error('OLLAMA_BASE_URL не задан'); process.exit(2); }

function post(url: string, body: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const data = JSON.stringify(body);
    const req = lib.request(
      { hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search, method: 'POST', insecureHTTPParser: true,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}`, 'content-length': Buffer.byteLength(data) } },
      (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode || 0, body: b })); },
    );
    req.on('error', reject); req.write(data); req.end();
  });
}

const transcript = `[РАСШИФРОВКА ВСТРЕЧИ — первоисточник фактов для разделов 2 и 4]
Спикер 1:
00:00:05 — Иван Иванов, директор Заказчика ООО «Ромашка». Обсуждаем два вопроса: требования к функционалу и сроки.
Спикер 2:
00:01:10 — Пётр Петров, аналитик Исполнителя. Модуль отчётности доделывается, тайм-коды нужны в интерфейсе.
00:02:30 — Заказчик: нужно согласовать сроки, прислать ТЗ.
00:03:00 — Исполнитель: ТЗ скинем завтра.
(Сергей Сидоров, тестировщик Исполнителя, присутствовал, но не выступал.)`;

const conversationContext =
  `user: ${transcript}\n` +
  `assistant: Повестка: 1) Согласование требований; 2) Согласование сроков. Уточните № и тему договора.\n` +
  `user: Договор №7 от 01.06.2026, тема — разработка системы отчётности. Дата встречи 05.06.2026.`;

const prompt = SGR_DOCUMENT_AGENT_PROMPT
  .replace('{{REGULATION}}', PROTOCOL_REGULATION)
  .replace('{{CONVERSATION_CONTEXT}}', conversationContext)
  .replace('{{EXISTING_DOCUMENT_CONTEXT}}', '')
  .replace('{{AGREED_CHAT_CONTEXT}}', '(нет отдельного блока)');

(async () => {
  console.log(`Модель: ${MODEL}\nЭндпоинт: ${BASE}\n`);
  const t0 = Date.now();
  const r = await post(`${BASE}/chat/completions`, { model: MODEL, messages: [{ role: 'user', content: prompt }], temperature: 0.1, max_tokens: 8192, stream: false, think: false, reasoning_effort: 'none' });
  if (r.status !== 200) { console.error('HTTP', r.status, r.body.slice(0, 600)); process.exit(2); }
  const content = (JSON.parse(r.body).choices?.[0]?.message?.content) ?? '';
  console.log(`Ответ за ${((Date.now() - t0) / 1000).toFixed(1)}s, ${content.length} симв.`);
  const raw = parseLooseJsonObject(content);
  if (!raw) { console.error('FAIL: не распарсился JSON. Ответ:\n', content.slice(0, 800)); process.exit(1); }
  let proto;
  try { proto = parseProtocolStrict(raw); }
  catch (e) { console.error('FAIL: Zod-схема:', String(e).slice(0, 300), '\ncoerced:', JSON.stringify(coerceProtocolPartial(raw)).slice(0, 800)); process.exit(1); }
  proto = mergeProtocolWithChatDraft(proto, {});
  proto = applyGlossaryToProtocol(proto);

  let ok = 0, fail = 0; const chk = (n: string, c: boolean) => { c ? ok++ : fail++; console.log(c ? 'PASS' : 'FAIL', n); };
  const all = JSON.stringify(proto).toLowerCase();
  chk('повестка не пустая (фикс #1+#2)', proto.agenda.items.length > 0);
  chk('содержание не пустое (фикс #1)', proto.meetingContent.topics.some((t) => t.discussed.trim().length > 0));
  chk('срок+ответственный в решениях', proto.meetingContent.topics.some((t) => /срок/i.test(t.decided)) || proto.meetingContent.summary.some((r) => /срок/i.test(r.decision)));
  chk('жаргон вычищен (нет «доделывается»/«тайм-код»)', !/доделывается|тайм-код/.test(all));
  chk('нет англоязычных заглушек', !/n\/a|not provided|tbd/i.test(all));
  console.log('\n--- ИТОГОВЫЙ ПРОТОКОЛ (JSON) ---');
  console.log(JSON.stringify(proto, null, 2));
  console.log(`\n${ok} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
