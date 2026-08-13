import {
  createSessionToken,
  verifySessionToken,
  readCookie,
  resolveRequestUserId,
  sessionCookieHeader,
  clearSessionCookieHeader,
  SESSION_COOKIE_NAME,
} from '../auth-session';

const OLD_SECRET = process.env.SESSION_SECRET;
beforeAll(() => {
  process.env.SESSION_SECRET = 'test-secret-not-for-production';
});
afterAll(() => {
  process.env.SESSION_SECRET = OLD_SECRET;
});

const req = (headers: Record<string, string> = {}, url = 'https://protocol.example/api/chat') =>
  new Request(url, { headers });

describe('токен сессии', () => {
  it('подписанный токен читается обратно', () => {
    const token = createSessionToken('users:abc123');
    expect(verifySessionToken(token)).toBe('users:abc123');
  });

  it('подделанная подпись отвергается', () => {
    const token = createSessionToken('users:abc123');
    const tampered = `${token.slice(0, -4)}0000`;
    expect(verifySessionToken(tampered)).toBeNull();
  });

  it('подмена id в токене отвергается — подпись перестаёт сходиться', () => {
    const token = createSessionToken('users:victim');
    const [, exp, sig] = token.split('.');
    const forged = `${Buffer.from('users:attacker').toString('base64url')}.${exp}.${sig}`;
    expect(verifySessionToken(forged)).toBeNull();
  });

  it('истёкший токен отвергается', () => {
    const token = createSessionToken('users:abc', Date.now() - 31 * 24 * 60 * 60 * 1000);
    expect(verifySessionToken(token)).toBeNull();
  });

  it('мусор вместо токена отвергается', () => {
    for (const bad of ['', 'abc', 'a.b', 'a.b.c.d', null, undefined]) {
      expect(verifySessionToken(bad as string)).toBeNull();
    }
  });
});

describe('readCookie', () => {
  it('находит нужную куку среди прочих', () => {
    expect(readCookie('a=1; protokoler_session=xyz; b=2', SESSION_COOKIE_NAME)).toBe('xyz');
  });

  it('нет заголовка — null', () => {
    expect(readCookie(null, SESSION_COOKIE_NAME)).toBeNull();
    expect(readCookie('other=1', SESSION_COOKIE_NAME)).toBeNull();
  });
});

describe('resolveRequestUserId', () => {
  it('cookie важнее того, что прислал клиент', () => {
    const token = createSessionToken('users:real');
    const r = req({ cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}` });
    // Именно этот случай и был дырой: клиент заявляет чужой id.
    expect(resolveRequestUserId(r, 'users:attacker')).toBe('users:real');
  });

  it('без cookie значение из тела НЕ принимается — это и была дыра', () => {
    expect(resolveRequestUserId(req(), 'users:legacy')).toBeNull();
  });

  it('без cookie и без тела — null', () => {
    expect(resolveRequestUserId(req(), null)).toBeNull();
    expect(resolveRequestUserId(req(), '   ')).toBeNull();
  });

  it('свой id в теле не мешает — берётся тот же из сессии', () => {
    const token = createSessionToken('users:me');
    const r = req({ cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}` });
    expect(resolveRequestUserId(r, 'users:me')).toBe('users:me');
  });

  it('битая cookie не выдаёт себя за сессию', () => {
    // Значение ASCII: в HTTP-заголовок кириллица не пролезет и от браузера
    // такая кука не придёт — подделывать будут именно валидными байтами.
    const r = req({ cookie: `${SESSION_COOKIE_NAME}=forged-value` });
    expect(resolveRequestUserId(r, null)).toBeNull();
  });

  it('чужой токен, подписанный другим секретом, не проходит', () => {
    const real = process.env.SESSION_SECRET;
    process.env.SESSION_SECRET = 'secret-of-another-deployment';
    const foreign = createSessionToken('users:victim');
    process.env.SESSION_SECRET = real;
    const r = req({ cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(foreign)}` });
    expect(resolveRequestUserId(r, null)).toBeNull();
  });
});

describe('заголовки cookie', () => {
  it('httpOnly и SameSite выставлены, по https добавляется Secure', () => {
    const h = sessionCookieHeader(req({}, 'https://protocol.example/api/auth'), 'users:1');
    expect(h).toContain('HttpOnly');
    expect(h).toContain('SameSite=Lax');
    expect(h).toContain('Secure');
    expect(h).toContain('Path=/');
  });

  it('по http Secure не ставится — иначе кука не доедет в локальной разработке', () => {
    const h = sessionCookieHeader(req({}, 'http://localhost:3000/api/auth'), 'users:1');
    expect(h).not.toContain('Secure');
  });

  it('заголовок выхода гасит куку', () => {
    const h = clearSessionCookieHeader(req({}, 'https://protocol.example/api/auth'));
    expect(h).toContain('Max-Age=0');
    expect(h).toContain('HttpOnly');
  });
});
