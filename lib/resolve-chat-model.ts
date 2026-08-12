import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { createOpenAI } from '@ai-sdk/openai';
import { FIXED_CHAT_MODEL, normalizeCloudModel, parseAllowedOllamaModelsFromServerEnv } from '@/lib/chat-models';
import {
  applyOllamaOpenAiCompatOptions,
  ollamaHardCapOutputTokens,
  supportsOllamaExtensions,
} from '@/lib/ollama-limits';
import https from 'node:https';
import http from 'node:http';
import { Readable } from 'node:stream';

/**
 * Fetch wrapper using Node.js http/https module with insecureHTTPParser: true.
 * JupyterHub sends a Content-Security-Policy header with embedded newlines which
 * violates RFC 7230 — undici (native fetch) rejects it. The legacy http module
 * accepts it when insecureHTTPParser is set; we also sanitize header values so
 * the WHATWG Headers constructor doesn't throw.
 */
async function insecureFetch(
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

export type ChatProviderId = 'ollama' | 'openrouter';

export type ResolveChatModelOptions = {
  chatProvider?: ChatProviderId | string;
  chatModel?: string;
  useThinking?: boolean;
};

function createOpenRouterInstance() {
  return createOpenRouter({
    apiKey: process.env.OPENROUTER_API_KEY ?? '',
    baseURL: 'https://openrouter.ai/api/v1',
    compatibility: 'strict',
    headers: {
      'X-Title': 'AISDK',
    },
  });
}

function resolveOpenRouterSlug(requestedRaw: string): string {
  // normalizeCloudModel отсекает мёртвые слаги (напр. openrouter/owl-alpha из
  // устаревшего env или старого клиентского бандла) и пустые значения.
  const fallback = normalizeCloudModel(process.env.OPENROUTER_MODEL_DEFAULT);
  const requested = normalizeCloudModel(requestedRaw) === requestedRaw.trim()
    ? requestedRaw.trim()
    : ''; // мёртвый/пустой слаг → уходим на fallback
  const allowedCsv = process.env.ALLOWED_OPENROUTER_MODELS?.trim();
  if (!allowedCsv) {
    if (requested && /^[\w\-./:]+$/.test(requested) && requested.length <= 160) return requested;
    return fallback;
  }
  const allowed = allowedCsv.split(',').map((s) => s.trim()).filter(Boolean);
  if (allowed.includes(requested)) return requested;
  return allowed.includes(fallback) ? fallback : allowed[0]!;
}

/** Та же логика выбора модели, что и в /api/chat — Ollama или OpenRouter. */
export function resolveChatLanguageModel(options: ResolveChatModelOptions = {}) {
  const envDefault = (process.env.CHAT_PROVIDER_DEFAULT?.trim() || 'ollama') as ChatProviderId;
  const provider: ChatProviderId =
    options.chatProvider === 'openrouter' || options.chatProvider === 'ollama'
      ? (options.chatProvider as ChatProviderId)
      : envDefault;

  if (provider === 'ollama') {
    const allowed = parseAllowedOllamaModelsFromServerEnv(process.env.ALLOWED_OLLAMA_MODELS);
    const modelId = allowed.includes(FIXED_CHAT_MODEL)
      ? FIXED_CHAT_MODEL
      : allowed[0]!;
    const baseURL = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434/v1';
    const ollamaApiKey = process.env.OLLAMA_API_KEY || 'ollama';
    const openai = createOpenAI({
      baseURL,
      apiKey: ollamaApiKey,
      fetch: async (url, init) => {
        // Normalize headers to plain object and fix auth prefix:
        // JupyterHub requires "token <key>", not "Bearer <key>"
        const patchedHeaders: Record<string, string> = {};
        if (init?.headers) {
          const h = init.headers;
          if (h instanceof Headers) {
            h.forEach((v, k) => { patchedHeaders[k] = v; });
          } else if (Array.isArray(h)) {
            for (const [k, v] of h) patchedHeaders[k] = v;
          } else {
            Object.assign(patchedHeaders, h);
          }
        }
        // JupyterHub proxy accepts "Bearer <key>" and forwards to Ollama.
        // Ollama itself ignores the auth header when OLLAMA_API_KEY is not set.
        for (const key of Object.keys(patchedHeaders)) {
          if (key.toLowerCase() === 'authorization') delete patchedHeaders[key];
        }
        patchedHeaders['authorization'] = `Bearer ${ollamaApiKey}`;

        // Тело разбираем в УЗКОМ try: ошибка парсинга — это «нечего патчить,
        // отправляем как есть». Раньше в try было всё тело обработчика, включая
        // сам запрос к Ollama, и любой сетевой сбой уводил выполнение в
        // `catch { /* fallthrough */ }` → запрос уходил ВТОРОЙ раз с исходным
        // телом: без потолка max_tokens, без stream:false, без снятия
        // stream_options и без keep_alive. То есть при сбое поведение молча
        // менялось на противоположное тому, ради чего написан весь блок,
        // а модель генерировала дважды.
        let parsed: Record<string, unknown> | null = null;
        if (init?.body && typeof init.body === 'string') {
          try {
            parsed = JSON.parse(init.body) as Record<string, unknown>;
          } catch {
            parsed = null;
          }
        }

        if (parsed) {
          {
            const useThinking = Boolean(options.useThinking);
            applyOllamaOpenAiCompatOptions(parsed, useThinking, baseURL);
            // Жёсткий потолок (предохранитель), а не дефолт ответа: per-call
            // maxOutputTokens задаётся в chat/document агентах.
            const cap = ollamaHardCapOutputTokens();
            const requestedMax =
              typeof parsed.max_tokens === 'number' ? parsed.max_tokens : cap;
            parsed.max_tokens = Math.min(requestedMax, cap);
            // keep_alive: сколько держать модель в VRAM после запроса.
            // Раньше было жёстко -1 (вечно) — на общей карте это копило модели при
            // переключении/RAG до OOM. Теперь конечный дефолт «30m» и override через
            // OLLAMA_KEEP_ALIVE ('-1' — прежнее поведение, '300' — секунды, '10m' — строка).
            //
            // Поле вендорское: у сторонних OpenAI-совместимых шлюзов его нет, и
            // они отвечают на него 400, а не игнорируют. Управлением памятью
            // GPU там занимается сам провайдер, так что и смысла слать нет.
            if (supportsOllamaExtensions(baseURL)) {
              const kaEnv = process.env.OLLAMA_KEEP_ALIVE?.trim();
              parsed.keep_alive = kaEnv
                ? (/^-?\d+$/.test(kaEnv) ? Number(kaEnv) : kaEnv)
                : '30m';
            }

            // Стриминг. Через прокси JupyterHub SSE часто буферизуется/обрывается,
            // поэтому по умолчанию форсим non-stream и сами заворачиваем ответ в SSE
            // (минус: пользователь видит ответ только в конце). При работе через
            // vLLM/нормальный прокси выставьте LLM_FORCE_NONSTREAM=false — тогда
            // используется нативный стриминг и текст появляется по мере генерации.
            const forceNonStream =
              (process.env.LLM_FORCE_NONSTREAM ?? 'true') !== 'false';
            if (!forceNonStream) {
              return insecureFetch(url, {
                ...init,
                headers: patchedHeaders,
                body: JSON.stringify(parsed),
              });
            }

            parsed.stream = false;
            // stream_options валиден ТОЛЬКО при stream=true. AI SDK добавляет его
            // ({include_usage:true}) при стриминге; форсируя non-stream, обязаны его
            // убрать — иначе строгие шлюзы (oui/Open WebUI) отвечают 400
            // «Stream options can only be defined when stream=True».
            delete parsed.stream_options;

            if (process.env.OLLAMA_LOG_CHAT_REQUEST === '1') {
              const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : (url as Request).url;
              const authHdr = patchedHeaders['authorization'] ?? patchedHeaders['Authorization'] ?? '(none)';
              const authPreview = authHdr.slice(0, 12) + (authHdr.length > 12 ? '...' : '');
              console.log(
                `[ollama→] POST ${urlStr} auth="${authPreview}" model=${modelId} think=${String(parsed.think)} reasoning_effort=${String(parsed.reasoning_effort)} max_tokens=${parsed.max_tokens} msgs=${Array.isArray(parsed.messages) ? parsed.messages.length : '?'}`,
              );
            }

            const jsonResp = await insecureFetch(url, { ...init, headers: patchedHeaders, body: JSON.stringify(parsed) });
            const jsonText = await jsonResp.text();
            console.log(`[llm←] status=${jsonResp.status} body_preview=${jsonText.slice(0, 120)}`);

            // Convert non-streaming OpenAI completion to streaming delta format for AI SDK.
            // AI SDK expects SSE chunks with delta.content, not message.content.
            let sseBody: string;
            try {
              const completion = JSON.parse(jsonText) as Record<string, unknown>;

              // Лог usage + детектор молчаливой обрезки НАЧАЛА промпта сервером Ollama
              // (сервер за прокси реально держит num_ctx = OLLAMA_CONTEXT_LENGTH и при
              // переполнении режет начало контекста, включая системные инструкции).
              try {
                const usage = completion.usage as Record<string, unknown> | undefined;
                const promptTokens = Number(usage?.prompt_tokens);
                const completionTokens = Number(usage?.completion_tokens);
                if (Number.isFinite(promptTokens) || Number.isFinite(completionTokens)) {
                  console.log(`[llm←] usage: prompt=${promptTokens} completion=${completionTokens}`);
                }
                const ctxLimit = Number(process.env.OLLAMA_CONTEXT_LENGTH);
                if (Number.isFinite(ctxLimit) && Number.isFinite(promptTokens)) {
                  const maxTokens = typeof parsed.max_tokens === 'number' ? parsed.max_tokens : 0;
                  if (promptTokens >= ctxLimit - maxTokens - 256) {
                    console.warn(
                      `⚠️ [llm←] prompt_tokens=${promptTokens} упёрся в num_ctx=${ctxLimit} — сервер, вероятно, ОБРЕЗАЛ НАЧАЛО промпта (системные инструкции). Сократите документ/историю.`,
                    );
                  }
                }
              } catch {
                // Не ломаем основной поток из-за диагностики
              }

              const choices = completion.choices as any[] | undefined;
              const choice = choices?.[0] ?? {};
              const message = (choice.message ?? {}) as Record<string, unknown>;
              const finishReason = choice.finish_reason ?? 'stop';
              const base = { id: completion.id, object: 'chat.completion.chunk', created: completion.created, model: completion.model };

              // Build delta — must include tool_calls when present so AI SDK can execute tools.
              const delta: Record<string, unknown> = { role: message.role ?? 'assistant' };
              if (message.content != null) delta.content = String(message.content);
              const toolCalls = (message as any).tool_calls as any[] | undefined;
              // OpenAI streaming-формат требует index у каждого tool_call —
              // без него AI SDK может молча отбросить вызов инструмента.
              if (toolCalls?.length)
                delta.tool_calls = toolCalls.map((tc: any, i: number) => ({ index: i, ...tc }));

              const deltaChunk = { ...base, choices: [{ index: 0, delta, finish_reason: null }] };
              const finishChunk = { ...base, choices: [{ index: 0, delta: {}, finish_reason: finishReason }], usage: completion.usage };
              sseBody = `data: ${JSON.stringify(deltaChunk)}\n\ndata: ${JSON.stringify(finishChunk)}\n\ndata: [DONE]\n\n`;
            } catch {
              // Fallback: pass raw JSON as-is if parsing fails
              sseBody = `data: ${jsonText}\n\ndata: [DONE]\n\n`;
            }

            const encoder = new TextEncoder();
            const sseStream = new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(encoder.encode(sseBody));
                controller.close();
              },
            });
            return new Response(sseStream, {
              status: jsonResp.status,
              headers: { 'content-type': 'text/event-stream; charset=utf-8' },
            });
          }
        }

        // Тело не JSON (или его нет) — отправляем запрос как есть.
        // Сюда БОЛЬШЕ не попадают сбои сети: они пробрасываются наверх, где
        // AI SDK их и обработает, вместо тихой повторной генерации.
        return insecureFetch(url, { ...init, headers: patchedHeaders });
      },
    });
    return openai.chat(modelId);
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY is not set');
  }
  const slug = resolveOpenRouterSlug(typeof options.chatModel === 'string' ? options.chatModel : '');
  return createOpenRouterInstance().chat(slug);
}
