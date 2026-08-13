/**
 * Хеширование паролей.
 *
 * Было: `sha256(password)` в один проход, без соли. Утечка таблицы `users`
 * означала мгновенный подбор по радужным таблицам, а одинаковые пароли давали
 * одинаковые хеши — видно, у кого пароль общий. Плюс сравнение шло прямо в
 * SQL-запросе (`WHERE passwordHash = $passwordHash`), что возможно только для
 * детерминированного хеша.
 *
 * Стало: `scrypt` с индивидуальной солью и параметрами в самой строке. Ничего
 * доустанавливать не пришлось — scrypt есть во встроенном `node:crypto`.
 *
 * Миграция без сброса паролей: старый формат по-прежнему проверяется, и при
 * первом успешном входе хеш молча пересчитывается в новый (см. `needsRehash`).
 */
import crypto from 'node:crypto';

/** Параметры scrypt. N — работа по CPU/памяти, 2^14 — разумный минимум. */
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;
const SALT_LEN = 16;

const LEGACY_SHA256_RE = /^[0-9a-f]{64}$/i;

function scryptAsync(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      password,
      salt,
      KEY_LEN,
      { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P },
      (err, derived) => (err ? reject(err) : resolve(derived as Buffer)),
    );
  });
}

/** Новый хеш: `scrypt$N$r$p$saltB64$hashB64`. */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(SALT_LEN);
  const derived = await scryptAsync(password, salt);
  return [
    'scrypt',
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

/** Хеш старого формата — только для проверки при миграции. */
export function legacySha256(password: string): string {
  return crypto.createHash('sha256').update(password).digest('hex');
}

/** Строка выглядит как хеш старого формата. */
export function isLegacyHash(stored: string): boolean {
  return LEGACY_SHA256_RE.test(String(stored ?? '').trim());
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  // timingSafeEqual требует равной длины — разную длину отсеиваем заранее,
  // она и так видна по самому факту сравнения.
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * Проверка пароля. `needsRehash` — пароль верный, но хеш в старом формате:
 * вызывающий обязан пересчитать и сохранить новый.
 */
export async function verifyPassword(
  password: string,
  stored: string,
): Promise<{ ok: boolean; needsRehash: boolean }> {
  const value = String(stored ?? '').trim();
  if (!value || !password) return { ok: false, needsRehash: false };

  if (isLegacyHash(value)) {
    return { ok: timingSafeEqualStr(legacySha256(password), value), needsRehash: true };
  }

  const parts = value.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return { ok: false, needsRehash: false };
  const [, nRaw, rRaw, pRaw, saltB64, hashB64] = parts;
  const N = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) {
    return { ok: false, needsRehash: false };
  }

  try {
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const derived = await new Promise<Buffer>((resolve, reject) => {
      crypto.scrypt(password, salt, expected.length, { N, r, p }, (err, out) =>
        err ? reject(err) : resolve(out as Buffer),
      );
    });
    const ok = derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
    // Параметры устарели относительно текущих — обновим хеш при случае.
    const needsRehash = ok && (N !== SCRYPT_N || r !== SCRYPT_R || p !== SCRYPT_P);
    return { ok, needsRehash };
  } catch {
    return { ok: false, needsRehash: false };
  }
}
