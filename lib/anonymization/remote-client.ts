/**
 * Тонкий клиент удалённого анонимизатора (`anonymizer/server.py`).
 *
 * POST {ANONYMIZER_URL}/anonymize  {text, regex?, corporate?, ner?, llm?}
 *   -> {anonymized_text, mapping, summary, spans, stages}
 *
 * Используем node http/https напрямую с insecureHTTPParser: JupyterHub-прокси
 * шлёт Content-Security-Policy с переносами строк (нарушает RFC 7230) — undici
 * (нативный fetch) такое отвергает. Тело ответа читаем сами, заголовки игнорируем.
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

/**
 * Асинхронный режим: POST /jobs/anonymize -> 202 {job_id}, дальше поллинг
 * GET /jobs/<id> до status=done|error.
 *
 * Зачем: между нами и анонимизатором стоит релей (VS Code dev tunnel), у
 * которого фиксированный таймаут на ОДИН запрос (~100 с, не настраивается —
 * мы ловили от него HTTP 504 на 101-103-й секунде). Полный пайплайн на боевой
 * расшифровке идёт дольше. Поллинг делает каждый HTTP-запрос коротким, и
 * лимит релея перестаёт что-либо значить: сколько бы ни считал пайплайн, ни
 * одно соединение не живёт дольше пары секунд.
 *
 * Возвращает null, если сервер не знает про /jobs (старая версия анонимизатора
 * ответит 404) — вызывающий код тогда откатывается на синхронный /anonymize.
 */
async function anonymizeViaJob(
  base: string,
  payload: unknown,
  token: string,
): Promise<RemoteAnonymizeResult | null> {
  const submit = await request('POST', `${base}/jobs/anonymize`, payload, token, 30_000);
  if (submit.status === 404) return null; // сервер без job-API
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

  // Потолок ожидания. Держим ниже maxDuration роута (300 с), чтобы вернуть
  // осмысленную ошибку самим, а не быть убитыми платформой на полуслове.
  const deadline = Date.now() + Number(process.env.ANONYMIZER_JOB_MAX_MS ?? 270_000);
  // Первые опросы частые (короткие тексты успевают за секунды), дальше реже,
  // чтобы не молотить релей сотнями запросов на трёхминутной задаче.
  let delayMs = 1000;
  let transientFailures = 0;

  for (;;) {
    await new Promise((r) => setTimeout(r, delayMs));
    delayMs = Math.min(delayMs * 1.4, 5000);

    if (Date.now() > deadline) {
      throw new AnonymizerUnavailableError(
        `Анонимизация не завершилась за ${Math.round(
          Number(process.env.ANONYMIZER_JOB_MAX_MS ?? 270_000) / 1000,
        )} с (задача ${jobId} всё ещё выполняется)`,
      );
    }

    let poll: { status: number; body: string };
    try {
      poll = await request('GET', `${base}/jobs/${jobId}`, undefined, token, 30_000);
    } catch {
      // Единичный обрыв опроса — не повод хоронить задачу: она считается на
      // сервере независимо от того, доехал ли до нас конкретный GET.
      if (++transientFailures > 5) {
        throw new AnonymizerUnavailableError('Анонимизатор перестал отвечать на опрос статуса');
      }
      continue;
    }
    transientFailures = 0;

    if (poll.status === 404) {
      throw new AnonymizerUnavailableError(`Анонимизатор забыл задачу ${jobId}`);
    }
    if (poll.status < 200 || poll.status >= 300) continue; // 5xx релея — пробуем ещё

    let state: { status: string; result: RemoteAnonymizeResult | null; error: string | null };
    try {
      state = JSON.parse(poll.body);
    } catch {
      continue; // релей вклинился HTML-заглушкой — следующий опрос
    }

    if (state.status === 'error') {
      throw new AnonymizerUnavailableError(`Анонимизатор упал: ${state.error ?? 'без сообщения'}`);
    }
    if (state.status === 'done') {
      if (!state.result) throw new AnonymizerUnavailableError('Задача завершена без результата');
      return state.result;
    }
  }
}

/** Вызвать удалённый /anonymize. Бросает AnonymizerUnavailableError при сбое. */
export async function anonymizeRemote(
  text: string,
  stages?: AnonymizeStages,
): Promise<RemoteAnonymizeResult> {
  const base = anonymizerBaseUrl();
  const token = process.env.ANONYMIZER_TOKEN?.trim() ?? '';
  // По умолчанию БЕЗ таймаута (0). Прежние 60 с обрывали живой анонимизатор:
  // на боевой расшифровке он честно работает две минуты. Ограничение можно
  // вернуть через ANONYMIZER_TIMEOUT_MS.
  const timeoutMs = Number(process.env.ANONYMIZER_TIMEOUT_MS ?? 0);

  if (!text || !text.trim()) {
    return { anonymized_text: text, mapping: {}, summary: {}, spans: [] };
  }

  const payload = { text, ...(stages ?? {}) };

  // Сначала пробуем асинхронный режим: он не упирается в таймаут релея.
  // ANONYMIZER_SYNC=1 форсирует старый синхронный путь (отладка вживую).
  if (process.env.ANONYMIZER_SYNC !== '1') {
    try {
      const viaJob = await anonymizeViaJob(base, payload, token);
      if (viaJob) return viaJob;
      // null = сервер старой версии, без /jobs — проваливаемся в синхронный путь.
    } catch (err) {
      if (err instanceof AnonymizerUnavailableError) throw err;
      throw new AnonymizerUnavailableError(
        `Анонимизатор недоступен: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  let res: { status: number; body: string };
  try {
    res = await postJson(`${base}/anonymize`, { text, ...(stages ?? {}) }, token, timeoutMs);
  } catch (err) {
    // Мгновенный обрыв (connection reset / refused) — не «анонимизатор упал»,
    // а транзиентная сеть: пробуем ещё раз, прежде чем отключать анонимизацию.
    // Настоящий таймаут (запрос шёл долго) не ретраим — время уже потрачено.
    const elapsedGuess = String(err instanceof Error ? err.message : err);
    const isTimeout = /таймаут|timeout/i.test(elapsedGuess);
    if (!isTimeout) {
      try {
        await new Promise((r) => setTimeout(r, 1000));
        res = await postJson(`${base}/anonymize`, payload, token, timeoutMs);
      } catch (retryErr) {
        throw new AnonymizerUnavailableError(
          `Анонимизатор недоступен: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`,
        );
      }
    } else {
      throw new AnonymizerUnavailableError(
        `Анонимизатор недоступен: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (res.status < 200 || res.status >= 300) {
    throw new AnonymizerUnavailableError(
      `Анонимизатор вернул HTTP ${res.status}: ${res.body.slice(0, 200)}`,
    );
  }

  let parsed: RemoteAnonymizeResult;
  try {
    parsed = JSON.parse(res.body) as RemoteAnonymizeResult;
  } catch {
    throw new AnonymizerUnavailableError(
      `Анонимизатор вернул не-JSON: ${res.body.slice(0, 200)}`,
    );
  }
  if (typeof parsed.anonymized_text !== 'string' || typeof parsed.mapping !== 'object') {
    throw new AnonymizerUnavailableError('Анонимизатор вернул некорректную структуру');
  }
  return parsed;
}

/** Проверка доступности (GET /health). */
export async function anonymizerHealthy(): Promise<boolean> {
  try {
    const base = anonymizerBaseUrl();
    const token = process.env.ANONYMIZER_TOKEN?.trim() ?? '';
    const url = new URL(`${base}/health`);
    const isHttps = url.protocol === 'https:';
    const requestFn = isHttps ? https.request : http.request;
    return await new Promise<boolean>((resolve) => {
      const req = requestFn(
        {
          hostname: url.hostname,
          port: url.port ? Number(url.port) : isHttps ? 443 : 80,
          path: url.pathname,
          method: 'GET',
          headers: {
            'X-Tunnel-Skip-AntiPhishing-Page': 'true',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          insecureHTTPParser: true,
          timeout: 8000,
        },
        (res) => {
          res.resume();
          resolve((res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300);
        },
      );
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
      req.on('error', () => resolve(false));
      req.end();
    });
  } catch {
    return false;
  }
}
