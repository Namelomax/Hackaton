import {
  hashPassword,
  verifyPassword,
  legacySha256,
  isLegacyHash,
} from '../auth-password';

jest.setTimeout(30000);

describe('scrypt', () => {
  it('правильный пароль проходит, неправильный — нет', async () => {
    const stored = await hashPassword('корректная лошадь батарейка');
    await expect(verifyPassword('корректная лошадь батарейка', stored)).resolves.toEqual({
      ok: true,
      needsRehash: false,
    });
    await expect(verifyPassword('другой пароль', stored)).resolves.toMatchObject({ ok: false });
  });

  it('одинаковые пароли дают РАЗНЫЕ хеши — соль индивидуальная', async () => {
    const a = await hashPassword('одинаковый');
    const b = await hashPassword('одинаковый');
    expect(a).not.toBe(b);
    // Именно это ломало старый sha256: одинаковый хеш выдавал общий пароль.
    await expect(verifyPassword('одинаковый', a)).resolves.toMatchObject({ ok: true });
    await expect(verifyPassword('одинаковый', b)).resolves.toMatchObject({ ok: true });
  });

  it('хеш содержит параметры и соль', async () => {
    const stored = await hashPassword('пароль');
    expect(stored.split('$')).toHaveLength(6);
    expect(stored.startsWith('scrypt$')).toBe(true);
  });

  it('испорченный хеш не проходит и не роняет проверку', async () => {
    for (const bad of ['', 'scrypt$', 'scrypt$a$b$c$d$e', 'мусор']) {
      await expect(verifyPassword('пароль', bad)).resolves.toMatchObject({ ok: false });
    }
  });
});

describe('миграция со старого sha256', () => {
  it('старый хеш распознаётся', () => {
    expect(isLegacyHash(legacySha256('пароль'))).toBe(true);
    expect(isLegacyHash('scrypt$16384$8$1$c2FsdA==$aGFzaA==')).toBe(false);
  });

  it('вход по старому хешу работает и просит пересчёт', async () => {
    const stored = legacySha256('старый пароль');
    await expect(verifyPassword('старый пароль', stored)).resolves.toEqual({
      ok: true,
      needsRehash: true,
    });
  });

  it('неверный пароль против старого хеша не проходит', async () => {
    await expect(verifyPassword('не тот', legacySha256('старый пароль'))).resolves.toMatchObject({
      ok: false,
    });
  });

  it('новый хеш пересчёта не требует', async () => {
    const stored = await hashPassword('пароль');
    await expect(verifyPassword('пароль', stored)).resolves.toEqual({
      ok: true,
      needsRehash: false,
    });
  });
});
