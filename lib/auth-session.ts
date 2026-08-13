/**
 * Серверная сессия в httpOnly-cookie.
 *
 * ПРОБЛЕМА, КОТОРУЮ ЭТО ЗАКРЫВАЕТ. `/api/auth` при входе не выдавал ни cookie,
 * ни токена — только объект пользователя. Клиент клал его в localStorage и
 * дальше слал `userId` в теле или query каждого запроса. Гард владения
 * диалогом проверял лишь то, что диалог принадлежит ЗАЯВЛЕННОМУ id, поэтому
 * подстановка чужого `userId` открывала чужие диалоги, промпты и таблицу
 * `anonymization_mappings` — то есть соответствия «плейсхолдер → настоящие ФИО».
 *
 * Токен подписан HMAC-SHA256, лежит в httpOnly-cookie (JS его не читает) и
 * содержит только id пользователя и срок. Ничего расшифровывать не нужно:
 * подпись либо сходится, либо нет.
 */
import crypto from 'node:crypto';

const COOKIE_NAME = 'protokoler_session';
const MAX_AGE_SEC = 30 * 24 * 60 * 60;

/**
 * Секрет подписи. Если `SESSION_SECRET` не задан — генерируем случайный на
 * время жизни процесса: сессии переживут работу сервера, но не перезапуск.
 * Это НАМЕРЕННО хуже, чем настроенный секрет, и лучше, чем зашитый по
 * умолчанию: с константой в коде подделать токен может кто угодно.
 */
function sessionSecret(): string {
  const fromEnv = process.env.SESSION_SECRET?.trim();
  if (fromEnv && fromEnv.length >= 16) return fromEnv;
  const g = globalThis as unknown as { __sessionSecret?: string };
  if (!g.__sessionSecret) {
    g.__sessionSecret = crypto.randomBytes(32).toString('hex');
    console.warn(
      '[auth] SESSION_SECRET не задан — использую временный секрет процесса. ' +
        'После перезапуска все войдут заново. Задайте SESSION_SECRET в .env.',
    );
  }
  return g.__sessionSecret;
}

const b64url = (b: Buffer) => b.toString('base64url');

function sign(payload: string): string {
  return b64url(crypto.createHmac('sha256', sessionSecret()).update(payload).digest());
}

/** Токен вида `<userId>.<expSec>.<подпись>`. */
export function createSessionToken(userId: string, nowMs = Date.now()): string {
  const exp = Math.floor(nowMs / 1000) + MAX_AGE_SEC;
  const payload = `${b64url(Buffer.from(String(userId)))}.${exp}`;
  return `${payload}.${sign(payload)}`;
}

/** id пользователя из токена или null: подпись не сошлась либо срок истёк. */
export function verifySessionToken(token: string | null | undefined, nowMs = Date.now()): string | null {
  if (!token) return null;
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  const [idPart, expPart, signature] = parts;
  const payload = `${idPart}.${expPart}`;

  const expected = sign(payload);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  const exp = Number(expPart);
  if (!Number.isFinite(exp) || exp * 1000 <= nowMs) return null;

  try {
    const userId = Buffer.from(idPart, 'base64url').toString();
    return userId || null;
  } catch {
    return null;
  }
}

/** Разбор заголовка Cookie — без зависимостей. */
export function readCookie(header: string | null | undefined, name: string): string | null {
  if (!header) return null;
  for (const chunk of header.split(';')) {
    const eq = chunk.indexOf('=');
    if (eq === -1) continue;
    if (chunk.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(chunk.slice(eq + 1).trim());
    } catch {
      return chunk.slice(eq + 1).trim();
    }
  }
  return null;
}

/** id пользователя из cookie запроса. null — сессии нет. */
export function userIdFromRequest(req: Request): string | null {
  const raw = readCookie(req.headers.get('cookie'), COOKIE_NAME);
  return verifySessionToken(raw);
}

function isSecureRequest(req: Request): boolean {
  if (req.headers.get('x-forwarded-proto')?.split(',')[0].trim() === 'https') return true;
  try {
    return new URL(req.url).protocol === 'https:';
  } catch {
    return false;
  }
}

/** Заголовок Set-Cookie с сессией. */
export function sessionCookieHeader(req: Request, userId: string): string {
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(createSessionToken(userId))}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${MAX_AGE_SEC}`,
  ];
  if (isSecureRequest(req)) parts.push('Secure');
  return parts.join('; ');
}

/** Заголовок Set-Cookie, стирающий сессию. */
export function clearSessionCookieHeader(req: Request): string {
  const parts = [`${COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (isSecureRequest(req)) parts.push('Secure');
  return parts.join('; ');
}

/**
 * Кто делает запрос.
 *
 * ПЕРЕХОДНЫЙ ПЕРИОД: пока у части клиентов ещё нет cookie (старая вкладка,
 * сохранённый localStorage), значение из тела запроса принимается — иначе
 * деплой разлогинил бы всех разом. Cookie при этом ВСЕГДА в приоритете, а
 * использование запасного пути логируется. Убрать запасной путь — отдельный
 * шаг, после которого подстановка чужого userId перестанет работать.
 */
export function resolveRequestUserId(req: Request, bodyUserId?: string | null): string | null {
  const fromCookie = userIdFromRequest(req);
  if (fromCookie) return fromCookie;
  const fallback = typeof bodyUserId === 'string' && bodyUserId.trim() ? bodyUserId.trim() : null;
  if (fallback) {
    console.warn(
      `[auth] запрос без сессии — userId взят из тела (${fallback}). Клиенту нужно перелогиниться.`,
    );
  }
  return fallback;
}

export const SESSION_COOKIE_NAME = COOKIE_NAME;
