/**
 * Тонкий клиент удалённого анонимизатора (`anonymizer/server.py`).
 *
 * Вся детекция ПДн (NER, сборка плейсхолдеров, mapping) выполняется НА СЕРВЕРЕ.
 * Приложение только вызывает его и получает готовый результат:
 *
 *   POST {ANONYMIZER_URL}/anonymize        {text, ...stages} (синхронно)
 *     -> {anonymized_text, mapping, summary, spans, warnings, ...}
 *   POST {ANONYMIZER_URL}/jobs/anonymize   {text, ...stages}
 *     -> 202 {job_id};  затем GET {ANONYMIZER_URL}/jobs/<id> до status=done|error
 *
 * Раньше здесь жил параллельный TS-пайплайн прямого GLiNER (chunking/spans/
 * placeholders/canonicalize + сборка mapping на клиенте). Он убран: анонимизация
 * идёт только через python-сервер. Обратную подстановку (deanonymize.ts /
 * sse-deanonymize.ts) и хранение канонического mapping диалога делает
 * приложение — сервер stateless.
 *
 * Node http/https напрямую с insecureHTTPParser: JupyterHub/dev-tunnel-прокси
 * шлют Content-Security-Policy с переносами строк (нарушает RFC 7230) — undici
 * (нативный fetch) такое отвергает. Тело ответа читаем сами.
 */
import http from 'node:http';
import https from 'node:https';
import type { RemoteAnonymizeResult } from './types';

export class AnonymizerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnonymizerUnavailableError';
  }
}

export interface AnonymizeStages {
  regex?: boolean;
  corporate?: boolean;
  ner?: boolean;
  llm?: boolean;
}

function anonymizerBaseUrl(): string {
  const url = process.env.ANONYMIZER_URL?.trim();
  if (!url) {
    throw new AnonymizerUnavailableError('ANONYMIZER_URL не задан в окружении');
  }
  return url.replace(/\/+$/, '');
}

function request(
  method: 'GET' | 'POST',
  urlStr: string,
  payload: unknown,
  token: string,
  timeoutMs: number,
): Promise<{ status: number; body: string }> {
  const url = new URL(urlStr);
  const isHttps = url.protocol === 'https:';
  const requestFn = isHttps ? https.request : http.request;
  const body =
    payload === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(payload), 'utf-8');

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Content-Length': String(body.length),
    // Некоторые релеи (в т.ч. dev tunnel) отдают закешированный ответ на
    // повторный GET того же URL — для поллинга статуса это смертельно.
    'Cache-Control': 'no-cache',
    // Если анонимизатор проброшен через VS Code dev tunnel, туннель может
    // отдать HTML-заглушку с предупреждением вместо ответа сервиса. Заголовок
    // её отключает; на обычных адресах он просто игнорируется.
    'X-Tunnel-Skip-AntiPhishing-Page': 'true',
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  return new Promise((resolve, reject) => {
    const req = requestFn(
      {
        hostname: url.hostname,
        port: url.port ? Number(url.port) : isHttps ? 443 : 80,
        path: url.pathname + url.search,
        method,
        headers,
        insecureHTTPParser: true,
        // timeoutMs = 0 → без ограничения: анонимизатор работает минутами, и
        // рубить его на полпути хуже, чем дождаться. Когда пора прекращать,
        // решает платформа по maxDuration функции.
        ...(timeoutMs > 0 ? { timeout: timeoutMs } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(Buffer.from(c)));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf-8'),
          }),
        );
      },
    );
    req.on('timeout', () => {
      req.destroy(new Error(`таймаут ${timeoutMs} мс`));
    });
    req.on('error', reject);
    if (body.length) req.write(body);
    req.end();
  });
}

function postJson(
  urlStr: string,
  payload: unknown,
  token: string,
  timeoutMs: number,
): Promise<{ status: number; body: string }> {
  return request('POST', urlStr, payload, token, timeoutMs);
}

function parseRemoteResult(body: string): RemoteAnonymizeResult {
  let parsed: any;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new AnonymizerUnavailableError(`Анонимизатор вернул не-JSON: ${body.slice(0, 200)}`);
  }
  if (typeof parsed?.anonymized_text !== 'string' || typeof parsed?.mapping !== 'object') {
    throw new AnonymizerUnavailableError(
      `Анонимизатор вернул некорректную структуру: ${body.slice(0, 200)}`,
    );
  }
  return {
    anonymized_text: parsed.anonymized_text,
    mapping: parsed.mapping ?? {},
    summary: parsed.summary ?? {},
    spans: Array.isArray(parsed.spans) ? parsed.spans : [],
    ...(parsed.stages ? { stages: parsed.stages } : {}),
    ...(Array.isArray(parsed.warnings) && parsed.warnings.length ? { warnings: parsed.warnings } : {}),
  };
}

/**
 * Синхронная анонимизация через python-сервер: POST /anonymize.
 * Возвращает готовый результат (сервер сам делает NER + mapping).
 * Используется как fallback, если сервер не поддерживает /jobs (см. index.ts).
 * Бросает AnonymizerUnavailableError при сбое.
 */
export async function anonymizeRemote(
  text: string,
  stages?: AnonymizeStages,
): Promise<RemoteAnonymizeResult> {
  if (!text || !text.trim()) {
    return { anonymized_text: text, mapping: {}, summary: {}, spans: [] };
  }
  const base = anonymizerBaseUrl();
  const token = process.env.ANONYMIZER_TOKEN?.trim() ?? '';
  // По умолчанию без таймаута (0): анонимизатор работает минутами; предел задаёт
  // платформа по maxDuration. Переопределяется ANONYMIZER_TIMEOUT_MS.
  const timeoutMs = Number(process.env.ANONYMIZER_TIMEOUT_MS ?? 0);

  let res: { status: number; body: string };
  try {
    res = await postJson(`${base}/anonymize`, { text, ...(stages ?? {}) }, token, timeoutMs);
  } catch (err) {
    // Мгновенный обрыв (reset/refused) — транзиентная сеть, пробуем ещё раз.
    const message = String(err instanceof Error ? err.message : err);
    if (/таймаут|timeout/i.test(message)) {
      throw new AnonymizerUnavailableError(`Анонимизатор недоступен: ${message}`);
    }
    await new Promise((r) => setTimeout(r, 1000));
    res = await postJson(`${base}/anonymize`, { text, ...(stages ?? {}) }, token, timeoutMs);
  }

  if (res.status < 200 || res.status >= 300) {
    throw new AnonymizerUnavailableError(
      `Анонимизатор вернул HTTP ${res.status}: ${res.body.slice(0, 200)}`,
    );
  }
  return parseRemoteResult(res.body);
}

/**
 * Асинхронный режим: POST /jobs/anonymize -> 202 {job_id}, дальше опрос
 * GET /jobs/<id> до status=done|error.
 *
 * Зачем: на пути к анонимизатору стоят ДВА независимых потолка длительности
 * ОДНОГО запроса (релей ~100 c; Vercel maxDuration). Поэтому опрос вынесен в
 * браузер (см. app/api/anonymize/route.ts): submit и каждый poll — отдельные
 * короткие запросы, и ни один потолок не касается длительности самой работы.
 */
export type JobState =
  | { status: 'pending' | 'running' }
  | { status: 'done'; result: RemoteAnonymizeResult }
  | { status: 'error'; error: string };

/**
 * Поставить задачу. Возвращает job_id, либо null — если сервер старой версии и
 * не знает про /jobs (404); вызывающий откатывается на синхронный /anonymize.
 */
export async function submitAnonymizeJob(
  text: string,
  stages?: AnonymizeStages,
): Promise<string | null> {
  const base = anonymizerBaseUrl();
  const token = process.env.ANONYMIZER_TOKEN?.trim() ?? '';
  const submit = await request(
    'POST', `${base}/jobs/anonymize`, { text, ...(stages ?? {}) }, token, 30_000,
  );
  if (submit.status === 404) return null;
  if (submit.status !== 202) {
    throw new AnonymizerUnavailableError(
      `Анонимизатор вернул HTTP ${submit.status} на постановку задачи: ${submit.body.slice(0, 200)}`,
    );
  }
  let jobId: string;
  try {
    jobId = (JSON.parse(submit.body) as { job_id: string }).job_id;
  } catch {
    throw new AnonymizerUnavailableError(
      `Анонимизатор вернул не-JSON на постановку задачи: ${submit.body.slice(0, 200)}`,
    );
  }
  if (!jobId) throw new AnonymizerUnavailableError('Анонимизатор не вернул job_id');
  return jobId;
}

/**
 * Один опрос статуса. Сетевой сбой или мусор от релея НЕ считаются провалом
 * задачи (она считается на сервере независимо от того, доехал ли конкретный
 * GET) — возвращаем 'running', и браузер спросит снова.
 */
export async function fetchAnonymizeJob(jobId: string): Promise<JobState> {
  const base = anonymizerBaseUrl();
  const token = process.env.ANONYMIZER_TOKEN?.trim() ?? '';

  let poll: { status: number; body: string };
  try {
    poll = await request('GET', `${base}/jobs/${jobId}`, undefined, token, 30_000);
  } catch {
    return { status: 'running' };
  }

  if (poll.status === 404) {
    throw new AnonymizerUnavailableError(
      `Анонимизатор забыл задачу ${jobId} (перезапуск сервера или истёк TTL)`,
    );
  }
  if (poll.status < 200 || poll.status >= 300) return { status: 'running' };

  let state: { status: string; result: RemoteAnonymizeResult | null; error: string | null };
  try {
    state = JSON.parse(poll.body);
  } catch {
    return { status: 'running' }; // релей вклинился HTML-заглушкой
  }

  if (state.status === 'error') {
    throw new AnonymizerUnavailableError(`Анонимизатор упал: ${state.error ?? 'без сообщения'}`);
  }
  if (state.status === 'done') {
    if (!state.result) throw new AnonymizerUnavailableError('Задача завершена без результата');
    return { status: 'done', result: state.result };
  }
  return { status: 'running' };
}

/** Проверка доступности (GET /health). */
export async function anonymizerHealthy(): Promise<boolean> {
  try {
    const base = anonymizerBaseUrl();
    const token = process.env.ANONYMIZER_TOKEN?.trim() ?? '';
    const res = await request('GET', `${base}/health`, undefined, token, 8000);
    return res.status >= 200 && res.status < 300;
  } catch {
    return false;
  }
}
