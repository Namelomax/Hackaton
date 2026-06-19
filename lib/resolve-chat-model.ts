import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { createOpenAI } from '@ai-sdk/openai';
import { FIXED_CHAT_MODEL, parseAllowedOllamaModelsFromServerEnv } from '@/lib/chat-models';
import { applyOllamaOpenAiCompatOptions, ollamaChatMaxOutputTokens } from '@/lib/ollama-limits';
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

  return new Promise((resolve, reject) => {
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

    req.on('error', reject);

    if (bodyData != null) {
      if (typeof bodyData === 'string') req.write(bodyData);
      else if (bodyData instanceof Uint8Array || Buffer.isBuffer(bodyData))
        req.write(bodyData);
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
  const fallback = process.env.OPENROUTER_MODEL_DEFAULT || 'nvidia/nemotron-3-super-120b-a12b:free';
  const requested = requestedRaw.trim();
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
  const provider: ChatProviderId = options.chatProvider === 'openrouter' ? 'openrouter' : 'ollama';

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
        // Ollama validates OLLAMA_API_KEY against "Bearer" prefix
        for (const key of Object.keys(patchedHeaders)) {
          if (key.toLowerCase() === 'authorization') delete patchedHeaders[key];
        }
        patchedHeaders['authorization'] = `Bearer ${ollamaApiKey}`;

        if (init?.body && typeof init.body === 'string') {
          try {
            const parsed = JSON.parse(init.body) as Record<string, unknown>;
            const useThinking = Boolean(options.useThinking);
            applyOllamaOpenAiCompatOptions(parsed, useThinking);
            const cap = ollamaChatMaxOutputTokens();
            const requestedMax =
              typeof parsed.max_tokens === 'number' ? parsed.max_tokens : cap;
            parsed.max_tokens = Math.min(requestedMax, cap);
            // Keep model loaded in GPU memory indefinitely (default Ollama keep_alive is 5 min)
            parsed.keep_alive = -1;

            // Force non-streaming: JupyterHub proxy reliably handles plain HTTP responses,
            // SSE streams often get buffered or timed out. We wrap the JSON response in
            // SSE format ourselves so the AI SDK receives what it expects.
            parsed.stream = false;

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
              const choices = completion.choices as any[] | undefined;
              const choice = choices?.[0] ?? {};
              const message = (choice.message ?? {}) as Record<string, unknown>;
              const content = String(message.content ?? '');
              const finishReason = choice.finish_reason ?? 'stop';
              const base = { id: completion.id, object: 'chat.completion.chunk', created: completion.created, model: completion.model };
              const deltaChunk = { ...base, choices: [{ index: 0, delta: { role: message.role ?? 'assistant', content }, finish_reason: null }] };
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
          } catch {
            /* fallthrough */
          }
        }
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
