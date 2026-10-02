/**
 * Кто делает запрос — с проверкой по БД.
 *
 * `auth-session.ts` проверяет только подпись cookie. Этого мало с появлением
 * блокировки: токен живёт 30 дней и отозвать его нельзя, поэтому после
 * подписи читаем запись пользователя. Нет записи (удалён) — как без сессии;
 * `blocked` — отказ, даже если подпись верна. Роль берём отсюда же, а не из
 * того, что прислал клиент.
 */
import type { User } from '@/lib/getPromt';
import { getUserById } from '@/lib/getPromt';
import { resolveRequestUserId } from '@/lib/auth-session';

export type RequestAuth =
  | { status: 'ok'; user: User }
  | { status: 'anonymous' }
  | { status: 'blocked'; user: User };

export async function authenticateRequest(req: Request, claimedUserId?: string | null): Promise<RequestAuth> {
  const userId = resolveRequestUserId(req, claimedUserId);
  if (!userId) return { status: 'anonymous' };
  const user = await getUserById(userId);
  if (!user) {
    console.warn(`[auth] сессия ссылается на несуществующего пользователя ${userId}`);
    return { status: 'anonymous' };
  }
  if (user.blocked) return { status: 'blocked', user };
  return { status: 'ok', user };
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function unauthorizedResponse(): Response {
  // `unauthorized: true` клиент уже понимает — показывает форму входа.
  return json({ success: false, unauthorized: true, message: 'Требуется вход' }, 401);
}

export function blockedResponse(): Response {
  return json(
    { success: false, unauthorized: true, blocked: true, message: 'Доступ заблокирован администратором' },
    403,
  );
}

export function forbiddenResponse(message = 'Недостаточно прав'): Response {
  return json({ success: false, message }, 403);
}

export function authUnavailableResponse(): Response {
  return json({ success: false, message: 'Проверка доступа временно недоступна' }, 503);
}

/**
 * Активный пользователь или готовый ответ-отказ. Использование:
 *   const auth = await requireUser(req); if (auth instanceof Response) return auth;
 */
export async function requireUser(req: Request, claimedUserId?: string | null): Promise<User | Response> {
  let auth: RequestAuth;
  try {
    auth = await authenticateRequest(req, claimedUserId);
  } catch (e) {
    // Ошибку БД нельзя превращать в «анонимный» — это 503, а не тихий отказ
    // и тем более не пропуск.
    console.error('[auth] проверка пользователя не удалась:', (e as Error)?.message);
    return authUnavailableResponse();
  }
  if (auth.status === 'anonymous') return unauthorizedResponse();
  if (auth.status === 'blocked') return blockedResponse();
  return auth.user;
}

/**
 * Для роутов, где анонимный запрос допустим, а доступ решает гард владения
 * диалогом (/api/chat, /api/anonymize …): id или null, но заблокированный
 * получает отказ сразу, а не превращается в «анонима».
 */
export async function activeUserIdOrResponse(
  req: Request,
  claimedUserId?: string | null,
): Promise<{ userId: string | null; user: User | null } | Response> {
  try {
    const auth = await authenticateRequest(req, claimedUserId);
    if (auth.status === 'blocked') return blockedResponse();
    if (auth.status === 'anonymous') return { userId: null, user: null };
    return { userId: auth.user.id, user: auth.user };
  } catch (e) {
    console.error('[auth] проверка пользователя не удалась:', (e as Error)?.message);
    return authUnavailableResponse();
  }
}

export async function requireAdmin(req: Request): Promise<User | Response> {
  const user = await requireUser(req);
  if (user instanceof Response) return user;
  if (user.role !== 'admin') return forbiddenResponse('Только для администратора');
  return user;
}
