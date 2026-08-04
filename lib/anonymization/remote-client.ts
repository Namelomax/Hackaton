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
import { chunkText } from './chunking';
import { canonicalizeEntities } from './canonicalize';
import { applySpans, assignPlaceholders, findPlaceholderSpans } from './placeholders';
import { rebalanceQuotes, resolveOverlaps, type Span } from './spans';
import type { AnonymizeWarning, RemoteAnonymizeResult } from './types';

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

function glinerBaseUrl(): string {
  const url = process.env.GLINER_URL?.trim();
  if (!url) {
    throw new AnonymizerUnavailableError('GLINER_URL не задан в окружении');
  }
  return url.replace(/\/+$/, '');
}

/** Метки по умолчанию, если GLINER_LABELS не задан в окружении. */
const DEFAULT_GLINER_LABELS = [
  'person',
  'organization',
  'location',
  'date',
  'email',
  'phone number',
  'contract number',
];

/**
 * Метка GLiNER → placeholder-label (UPPERCASE, [A-Z_]).
 *
 * Синонимы (`first name`, `city`, `company`…) взяты из `_DEFAULT_LABEL_MAP`
 * Python-версии: набор меток задаётся через GLINER_LABELS и может отличаться
 * от нашего дефолтного, а неизвестная метка иначе улетит в fallback-ветку и
 * породит мусорный placeholder вроде `[FIRST_NAME]` вместо `[PERSON_N]`.
 */
const GLINER_LABEL_MAP: Record<string, string> = {
  person: 'PERSON',
  name: 'PERSON',
  'first name': 'PERSON',
  'last name': 'PERSON',
  nickname: 'PERSON',
  organization: 'ORG',
  company: 'ORG',
  location: 'LOCATION',
  address: 'LOCATION',
  city: 'LOCATION',
  street: 'LOCATION',
  region: 'LOCATION',
  country: 'LOCATION',
  date: 'DATE',
  email: 'EMAIL',
  'phone number': 'PHONE',
  'contract number': 'CONTRACT',
};

/**
 * Размер куска, отправляемого в /extract.
 *
 * НЕ поднимать до лимита API (50 000 символов): GLiNER перестаёт видеть текст
 * примерно после 1800 символов и молча отдаёт пустой список сущностей. Тихий
 * пропуск опаснее HTTP 422 — документ «анонимизируется» успешно, а ПДн уходят
 * в облако. 800 — то же значение, что в `RemoteGLiNERConfig.max_chars`.
 */
function glinerMaxChars(): number {
  const raw = Number(process.env.GLINER_MAX_CHARS);
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, 50_000) : 800;
}

/**
 * Сколько запросов к /extract держать в полёте одновременно.
 *
 * Эндпоинт упирается в задержку сети, а не в вычисления: модель отвечает за
 * 10–20 мс, а вызов целиком занимает ~1.2 с — это постоянные накладные расходы
 * round-trip. Замер на Python-клиенте: 32 вызова за 40.7 с в один поток против
 * 1.9 с в 32 потока. 16 — компромисс между скоростью и нагрузкой на общий шлюз.
 */
function glinerConcurrency(): number {
  const raw = Number(process.env.GLINER_CONCURRENCY);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 16;
}

/** Сырая сущность из ответа GLiNER /extract. */
export interface GlinerEntity {
  text: string;
  label: string;
  start: number;
  end: number;
  score: number;
}

function glinerLabels(): string[] {
  const csv = process.env.GLINER_LABELS?.trim();
  if (!csv) return DEFAULT_GLINER_LABELS;
  const parsed = csv
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : DEFAULT_GLINER_LABELS;
}

function glinerThreshold(): number {
  const raw = Number(process.env.GLINER_THRESHOLD);
  return Number.isFinite(raw) && raw > 0 ? raw : 0.45;
}

/** Каноническая метка GLiNER → placeholder-label; неизвестная метка — fallback. */
function canonicalLabel(rawLabel: string): string {
  const known = GLINER_LABEL_MAP[rawLabel.toLowerCase()];
  if (known) return known;
  return rawLabel
    .toUpperCase()
    .replace(/[^A-Z]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** Пересекается ли спан хотя бы с одним из защищённых диапазонов. */
function overlapsAny(start: number, end: number, ranges: [number, number][]): boolean {
  return ranges.some(([a, b]) => start < b && a < end);
}

/**
 * Превратить сырые сущности GLiNER в спаны: отфильтровать неизвестные метки,
 * проверить границы, срезать всё, что налезает на уже существующие в тексте
 * плейсхолдеры.
 *
 * @param offset Смещение куска в исходном тексте — координаты сущностей
 *   приходят локальные, относительно куска.
 */
function entitiesToSpans(
  text: string,
  entities: GlinerEntity[],
  offset: number,
  protectedRanges: [number, number][],
): Span[] {
  const out: Span[] = [];
  for (const ent of entities) {
    const label = canonicalLabel(String(ent?.label ?? ''));
    if (!label) continue; // метка выродилась в пустую строку
    const start = offset + Number(ent?.start);
    const end = offset + Number(ent?.end);
    if (!Number.isInteger(start) || !Number.isInteger(end)) continue;
    if (end <= start || end > text.length || start < 0) continue;
    if (overlapsAny(start, end, protectedRanges)) continue;
    out.push({
      start,
      end,
      label,
      // Берём подстроку оригинала, а не ent.text: сервис мог вернуть текст с
      // нормализованными пробелами, и тогда замена по offset'ам разъедется.
      text: text.slice(start, end),
      source: 'gliner',
      score: Number.isFinite(ent?.score) ? ent.score : 0,
    });
  }
  return out;
}

/**
 * Полный пайплайн из спанов в результат: выравнивание кавычек → разрешение
 * перекрытий по приоритету меток → канонизация падежных форм → назначение
 * плейсхолдеров → подстановка.
 */
function buildResultFromSpans(
  text: string,
  rawSpans: Span[],
  warnings: AnonymizeWarning[],
): RemoteAnonymizeResult {
  const balanced = rawSpans.map((s) => rebalanceQuotes(text, s));
  const resolved = resolveOverlaps(balanced);
  const canonical = canonicalizeEntities(resolved);
  const { mapping, placeholderBySpan, summary } = assignPlaceholders(canonical);

  return {
    anonymized_text: applySpans(text, canonical, placeholderBySpan),
    mapping,
    summary,
    spans: canonical.map((s) => ({ start: s.start, end: s.end, label: s.label, text: s.text })),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

/**
 * Собрать результат анонимизации из сырых NER-сущностей GLiNER. Чистая функция —
 * без сети; используется и однокусковым путём, и тестами.
 */
export function buildAnonymizationFromEntities(
  text: string,
  entities: GlinerEntity[],
): RemoteAnonymizeResult {
  const protectedRanges = findPlaceholderSpans(text);
  return buildResultFromSpans(text, entitiesToSpans(text, entities, 0, protectedRanges), []);
}

/**
 * Сборка результата из ПОКУСКОВЫХ ответов GLiNER. Вся логика, идущая после
 * сети, — здесь: сдвиг offset'ов, учёт упавших кусков, защита от повторной
 * анонимизации. Чистая функция, поэтому тестируется без моков HTTP.
 *
 * Бросает `AnonymizerUnavailableError`, если не обработан НИ ОДИН кусок:
 * молча вернуть исходный текст нельзя — вызывающий код счёл бы его
 * анонимизированным и отправил в облако как есть.
 */
export function buildAnonymizationFromChunks(
  text: string,
  chunks: { offset: number; chunk: string }[],
  results: (GlinerEntity[] | Error)[],
): RemoteAnonymizeResult {
  const protectedRanges = findPlaceholderSpans(text);
  const spans: Span[] = [];
  const warnings: AnonymizeWarning[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const { offset, chunk } = chunks[i];
    const result = results[i];
    if (result instanceof Error || result === undefined) {
      const reason = result instanceof Error ? result.message : 'ответ не получен';
      const message =
        `Фрагмент текста не удалось проверить через GLiNER (${reason}). ` +
        'Персональные данные в этом фрагменте могли остаться незамаскированными.';
      warnings.push({ kind: 'gliner_chunk_failed', offset, chars: chunk.length, message });
      console.error(
        `[anonymize] GLiNER: фрагмент ${offset}-${offset + chunk.length} не обработан ` +
          `(${reason}) — возможна утечка ПДн`,
      );
      continue;
    }
    spans.push(...entitiesToSpans(text, result, offset, protectedRanges));
  }

  if (chunks.length > 0 && warnings.length === chunks.length) {
    const first = results.find((r): r is Error => r instanceof Error);
    throw new AnonymizerUnavailableError(
      `Анонимизатор недоступен: ${first?.message ?? 'все фрагменты не обработаны'}`,
    );
  }

  return buildResultFromSpans(text, spans, warnings);
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
 * Асинхронный режим анонимизатора: POST /jobs/anonymize -> 202 {job_id},
 * дальше опрос GET /jobs/<id> до status=done|error.
 *
 * Зачем он вообще: на пути к анонимизатору стоят ДВА независимых потолка, и
 * оба режут ОДИН запрос, а не общую работу.
 *   1. Релей dev tunnel — фиксированный таймаут ~100 с, не настраивается
 *      (ловили от него HTTP 504 на 101-103-й секунде).
 *   2. Vercel maxDuration — потолок ОДНОЙ инвокации функции; поллинг внутри
 *      функции его не обходит, потому что инвокация живёт всё это время.
 * Поэтому опрос вынесен в браузер (см. app/api/anonymize/route.ts): submit и
 * каждый poll — отдельные короткие запросы, и ни один из двух потолков больше
 * не касается длительности самой анонимизации.
 */

export type JobState =
  | { status: 'pending' | 'running' }
  | { status: 'done'; result: RemoteAnonymizeResult }
  | { status: 'error'; error: string };

/**
 * Поставить задачу. Возвращает job_id, либо null — если анонимизатор старой
 * версии и не знает про /jobs (ответит 404); вызывающий код тогда откатывается
 * на синхронный /anonymize.
 */
export async function submitAnonymizeJob(
  text: string,
  stages?: AnonymizeStages,
): Promise<string | null> {
  // GLiNER не имеет job-API — сразу уходим на синхронный anonymizeNewText →
  // anonymizeRemote (POST /extract).
  if (process.env.GLINER_URL?.trim()) return null;

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

/**
 * Вызвать GLiNER `/extract`. GLiNER отдаёт только сырые NER-сущности —
 * плейсхолдеры/mapping/anonymized_text собираем сами (buildAnonymizationFromEntities),
 * остальной пайплайн (mergeRemoteResult, scrub, restoreNonSensitivePlaceholders)
 * работает поверх этого результата без изменений.
 *
 * Бросает AnonymizerUnavailableError при сбое.
 */
export async function anonymizeRemote(
  text: string,
  _stages?: AnonymizeStages,
): Promise<RemoteAnonymizeResult> {
  const base = glinerBaseUrl();
  const token = process.env.GLINER_API_KEY?.trim() || process.env.OLLAMA_API_KEY?.trim() || '';
  // По умолчанию БЕЗ таймаута (0), как и для прежнего анонимизатора — см.
  // ANONYMIZER_TIMEOUT_MS.
  const timeoutMs = Number(process.env.ANONYMIZER_TIMEOUT_MS ?? 0);

  if (!text || !text.trim()) {
    return { anonymized_text: text, mapping: {}, summary: {}, spans: [] };
  }

  const labels = glinerLabels();
  const threshold = glinerThreshold();

  /** Один вызов /extract. Бросает Error — вызывающий ловит её по-кусочно. */
  const extractChunk = async (chunk: string): Promise<GlinerEntity[]> => {
    const payload = { text: chunk, labels, threshold };

    let res: { status: number; body: string };
    try {
      res = await postJson(`${base}/extract`, payload, token, timeoutMs);
    } catch (err) {
      // Мгновенный обрыв (connection reset / refused) — не «сервис упал», а
      // транзиентная сеть: пробуем ещё раз. Настоящий таймаут не ретраим —
      // время уже потрачено, а кусков впереди ещё много.
      const message = String(err instanceof Error ? err.message : err);
      if (/таймаут|timeout/i.test(message)) throw err;
      await new Promise((r) => setTimeout(r, 1000));
      res = await postJson(`${base}/extract`, payload, token, timeoutMs);
    }

    if (res.status < 200 || res.status >= 300) {
      throw new Error(`GLiNER вернул HTTP ${res.status}: ${res.body.slice(0, 200)}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(res.body);
    } catch {
      throw new Error(`GLiNER вернул не-JSON: ${res.body.slice(0, 200)}`);
    }
    // Сервис отдаёт {"entities": [...]}; принимаем и голый список — контракт у
    // подобных обёрток любит меняться.
    const entities = Array.isArray(parsed)
      ? parsed
      : (parsed as { entities?: unknown } | null)?.entities;
    if (!Array.isArray(entities)) {
      throw new Error('GLiNER вернул некорректную структуру');
    }
    return entities.filter((e): e is GlinerEntity => typeof e === 'object' && e !== null);
  };

  const chunks = chunkText(text, glinerMaxChars(), { group: false });
  if (chunks.length === 0) {
    return { anonymized_text: text, mapping: {}, summary: {}, spans: [] };
  }

  // Результаты собираются ПО ИНДЕКСУ куска, а не по порядку завершения —
  // вывод детерминирован независимо от того, какой запрос ответил первым.
  const results: (GlinerEntity[] | Error)[] = new Array(chunks.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= chunks.length) return;
      try {
        results[i] = await extractChunk(chunks[i].chunk);
      } catch (err) {
        results[i] = err instanceof Error ? err : new Error(String(err));
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(glinerConcurrency(), chunks.length) }, worker),
  );

  return buildAnonymizationFromChunks(text, chunks, results);
}

/** Проверка доступности (GET /health). */
export async function anonymizerHealthy(): Promise<boolean> {
  // GLiNER не обязан иметь /health — реальная доступность проверится при
  // первом /extract; ошибка там штатно уводит в fallback на локальную LLM.
  if (process.env.GLINER_URL?.trim()) return true;

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
