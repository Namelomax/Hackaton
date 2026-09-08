import https from 'node:https';
import http from 'node:http';
import { Readable } from 'node:stream';

/**
 * Fetch wrapper using Node.js http/https module with insecureHTTPParser: true.
 * JupyterHub sends a Content-Security-Policy header with embedded newlines which
 * violates RFC 7230 — undici (native fetch) rejects it. The legacy http module
 * accepts it when insecureHTTPParser is set; we also sanitize header values so
 * the WHATWG Headers constructor doesn't throw.
 *
 * Вынесено из resolve-chat-model.ts в отдельный модуль, чтобы им же мог
 * пользоваться lib/gateway-model.ts (GET {OLLAMA_BASE_URL}/models ходит через
 * тот же проблемный прокси) — без копирования тела функции.
 */
export async function insecureFetch(
  urlInput: string | URL | globalThis.Request,
  init?: RequestInit,
): Promise<Response> {
  const urlStr =
    typeof urlInput === 'string'
      ? urlInput
      : urlInput instanceof URL
        ? urlInput.href
        : urlInput.url;
  const url = new URL(urlStr);
  const isHttps = url.protocol === 'https:';
  const nodeRequest = isHttps ? https.request : http.request;

  const headers: Record<string, string> = {};
  const initHeaders =
    init?.headers ?? (urlInput instanceof Request ? urlInput.headers : undefined);
  if (initHeaders instanceof Headers) {
    initHeaders.forEach((v, k) => {
      headers[k] = v;
    });
  } else if (Array.isArray(initHeaders)) {
    for (const [k, v] of initHeaders) headers[k] = v;
  } else if (initHeaders && typeof initHeaders === 'object') {
    Object.assign(headers, initHeaders);
  }

  const bodyData =
    init?.body !== undefined
      ? init.body
      : urlInput instanceof Request
        ? await urlInput.text()
        : undefined;

  // Отмена. node:http ничего не знает про AbortSignal, поэтому абортить
  // соединение нужно вручную. Без этого закрытая вкладка или кнопка «стоп» не
  // останавливали генерацию: AI SDK отписывался, а запрос к Ollama продолжал
  // жить до maxDuration = 300, занимая VRAM на общей карте.
  const signal = init?.signal ?? (urlInput instanceof Request ? urlInput.signal : undefined);

  /**
   * Общий потолок на запрос. По умолчанию ВЫКЛЮЧЕН.
   *
   * Тут были грабли: сначала стояло `req.setTimeout(600_000, …)`. Это НЕ общий
   * таймаут запроса, а таймаут ПРОСТОЯ сокета, и на живом стенде он срубал
   * генерацию через ~15 секунд с сообщением про 600000 мс. Теперь считаем сами
   * обычным таймером от момента отправки — он не может сработать раньше срока —
   * и включаем только явной установкой LLM_REQUEST_TIMEOUT_MS, чтобы дефолт не
   * ломал длинные генерации на медленной GPU.
   */
  const timeoutRaw = Number(process.env.LLM_REQUEST_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : 0;

  return new Promise((resolve, reject) => {
    let requestTimer: NodeJS.Timeout | undefined;
    const clearRequestTimer = () => {
      if (requestTimer) {
        clearTimeout(requestTimer);
        requestTimer = undefined;
      }
    };

    const req = nodeRequest(
      {
        hostname: url.hostname,
        port: url.port ? Number(url.port) : isHttps ? 443 : 80,
        path: url.pathname + url.search,
        method: init?.method ?? (urlInput instanceof Request ? urlInput.method : 'GET'),
        headers,
        insecureHTTPParser: true,
      },
      (res) => {
        clearRequestTimer();
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(res.headers)) {
          if (!value) continue;
          const vals = Array.isArray(value) ? value : [value];
          for (const v of vals) {
            try {
              responseHeaders.append(key, v.replace(/[\r\n]+/g, ' ').trim());
            } catch {
              // skip headers that still fail validation
            }
          }
        }

        const status = res.statusCode ?? 200;
        const contentType = res.headers['content-type'] ?? '';
        console.log(`[llm←] status=${status} content-type=${contentType}`);
        resolve(
          new Response(Readable.toWeb(res) as ReadableStream<Uint8Array>, {
            status,
            headers: responseHeaders,
          }),
        );
      },
    );

    req.on('error', (err) => {
      clearRequestTimer();
      reject(err);
    });
    req.on('close', clearRequestTimer);

    if (timeoutMs > 0) {
      requestTimer = setTimeout(() => {
        req.destroy(new Error(`LLM request timeout after ${timeoutMs}ms`));
      }, timeoutMs);
    }

    if (signal) {
      if (signal.aborted) {
        clearRequestTimer();
        req.destroy(new Error('aborted'));
        reject(new DOMException('The operation was aborted.', 'AbortError'));
        return;
      }
      const onAbort = () => {
        clearRequestTimer();
        req.destroy(new Error('aborted'));
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      req.on('close', () => signal.removeEventListener('abort', onAbort));
    }

    if (bodyData != null) {
      if (typeof bodyData === 'string') req.write(bodyData);
      else if (bodyData instanceof Uint8Array || Buffer.isBuffer(bodyData)) req.write(bodyData);
      else {
        // ReadableStream/FormData/URLSearchParams раньше молча уходили пустыми:
        // сервер получал запрос без тела и отвечал невнятной ошибкой. Падаем явно.
        clearRequestTimer();
        req.destroy();
        reject(new Error(`insecureFetch: неподдерживаемый тип тела запроса (${typeof bodyData})`));
        return;
      }
    }
    req.end();
  });
}
