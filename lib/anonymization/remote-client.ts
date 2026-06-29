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

function postJson(
  urlStr: string,
  payload: unknown,
  token: string,
  timeoutMs: number,
): Promise<{ status: number; body: string }> {
  const url = new URL(urlStr);
  const isHttps = url.protocol === 'https:';
  const requestFn = isHttps ? https.request : http.request;
  const body = Buffer.from(JSON.stringify(payload), 'utf-8');

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Content-Length': String(body.length),
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  return new Promise((resolve, reject) => {
    const req = requestFn(
      {
        hostname: url.hostname,
        port: url.port ? Number(url.port) : isHttps ? 443 : 80,
        path: url.pathname + url.search,
        method: 'POST',
        headers,
        insecureHTTPParser: true,
        timeout: timeoutMs,
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
    req.write(body);
    req.end();
  });
}

/** Вызвать удалённый /anonymize. Бросает AnonymizerUnavailableError при сбое. */
export async function anonymizeRemote(
  text: string,
  stages?: AnonymizeStages,
): Promise<RemoteAnonymizeResult> {
  const base = anonymizerBaseUrl();
  const token = process.env.ANONYMIZER_TOKEN?.trim() ?? '';
  const timeoutMs = Number(process.env.ANONYMIZER_TIMEOUT_MS ?? 60000);

  if (!text || !text.trim()) {
    return { anonymized_text: text, mapping: {}, summary: {}, spans: [] };
  }

  let res: { status: number; body: string };
  try {
    res = await postJson(`${base}/anonymize`, { text, ...(stages ?? {}) }, token, timeoutMs);
  } catch (err) {
    throw new AnonymizerUnavailableError(
      `Анонимизатор недоступен: ${err instanceof Error ? err.message : String(err)}`,
    );
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
          headers: token ? { Authorization: `Bearer ${token}` } : {},
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
