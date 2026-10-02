import {
  accountState,
  adminActionDenial,
  canJoinFolder,
  canManageMembers,
  inviteExpiresAt,
  canCreateFolder,
  canManageFolder,
  canSeeFolder,
  effectiveRole,
  envAdminUsernames,
  folderRagScope,
  isEnvAdmin,
  isWellFormedConversationId,
  normalizeFolderName,
  passwordProblem,
} from '../access';

const admin = { id: 'users:a1', username: 'Jacob', role: 'admin' as const };
const alice = { id: 'users:u1', username: 'alice', role: 'user' as const };
const bob = { id: 'u2', username: 'bob', role: 'user' as const };

describe('ADMIN_USERNAMES', () => {
  it('разбирает список: пробелы, регистр, пустые элементы', () => {
    expect([...envAdminUsernames(' Jacob , ,MASHKOVSKAYA,')]).toEqual(['jacob', 'mashkovskaya']);
  });

  it('пустая переменная — администраторов из конфига нет', () => {
    expect(envAdminUsernames(undefined).size).toBe(0);
    expect(isEnvAdmin('jacob', '')).toBe(false);
  });

  it('логин из конфига — admin независимо от роли в БД', () => {
    expect(effectiveRole('JACOB', 'user', 'jacob')).toBe('admin');
    expect(effectiveRole('alice', undefined, 'jacob')).toBe('user');
    expect(effectiveRole('alice', 'admin', 'jacob')).toBe('admin');
    expect(effectiveRole('alice', 'superuser', 'jacob')).toBe('user');
  });
});

describe('папки', () => {
  const shared = { kind: 'shared' as const, ownerId: null };
  const alicePersonal = { kind: 'personal' as const, ownerId: 'users:u1' };

  it('общую папку видят участники и админ, управляет только admin', () => {
    expect(canSeeFolder(alice, shared)).toBe(false);
    expect(canSeeFolder(alice, { ...shared, memberIds: ['users:u1'] })).toBe(true);
    expect(canSeeFolder(admin, shared)).toBe(true);
    expect(canManageFolder(alice, { ...shared, memberIds: ['users:u1'] })).toBe(false);
    expect(canManageFolder(admin, shared)).toBe(true);
  });

  it('вступить в общую папку может любой, кто ещё не участник', () => {
    expect(canJoinFolder(alice, shared)).toBe(true);
    expect(canJoinFolder(alice, { ...shared, memberIds: ['u1'] })).toBe(false);
    expect(canJoinFolder(alice, alicePersonal)).toBe(false);
  });

  it('участниками управляет только админ и только у общих папок', () => {
    expect(canManageMembers(admin, shared)).toBe(true);
    expect(canManageMembers(alice, { ...shared, memberIds: ['users:u1'] })).toBe(false);
    expect(canManageMembers(admin, { kind: 'personal', ownerId: 'users:a1' })).toBe(false);
  });

  it('личную папку видит и ведёт только владелец — админ тоже не видит', () => {
    expect(canSeeFolder(alice, alicePersonal)).toBe(true);
    expect(canManageFolder(alice, alicePersonal)).toBe(true);
    expect(canSeeFolder(bob, alicePersonal)).toBe(false);
    expect(canSeeFolder(admin, alicePersonal)).toBe(false);
    expect(canManageFolder(admin, alicePersonal)).toBe(false);
  });

  it('id владельца сравнивается без учёта префикса users:', () => {
    expect(canSeeFolder({ ...alice, id: 'u1' }, alicePersonal)).toBe(true);
  });

  it('личная папка без владельца не видна никому', () => {
    expect(canSeeFolder(alice, { kind: 'personal', ownerId: null })).toBe(false);
  });

  it('общую создаёт только admin, личную — любой', () => {
    expect(canCreateFolder(alice, 'shared')).toBe(false);
    expect(canCreateFolder(alice, 'personal')).toBe(true);
    expect(canCreateFolder(admin, 'shared')).toBe(true);
  });

  it('имя нормализуется', () => {
    expect(normalizeFolderName('  Проект   «Альфа»\n ')).toBe('Проект «Альфа»');
    expect(normalizeFolderName('x'.repeat(500))).toHaveLength(120);
  });

  it('scope RAG не совпадает с id записи и не содержит двоеточия', () => {
    expect(folderRagScope('folders:abc')).toBe('folder_abc');
    expect(folderRagScope('abc')).toBe('folder_abc');
  });
});

describe('ограничения администрирования', () => {
  it('нельзя трогать себя', () => {
    expect(adminActionDenial(admin, { id: 'a1', username: 'Jacob' }, 'block', '')).toMatch(/себя/);
    expect(adminActionDenial(admin, admin, 'demote', '')).toMatch(/себя/);
    expect(adminActionDenial(admin, admin, 'delete', '')).toMatch(/свою/);
  });

  it('нельзя трогать администратора из конфига', () => {
    expect(adminActionDenial(admin, { id: 'users:x', username: 'Boss' }, 'block', 'jacob,boss')).toMatch(
      /ADMIN_USERNAMES/,
    );
  });

  it('свой пароль сбросить нельзя — для этого «Сменить пароль»', () => {
    expect(adminActionDenial(admin, admin, 'reset', '')).toMatch(/Сменить пароль/);
  });

  it('обычного пользователя можно', () => {
    expect(adminActionDenial(admin, alice, 'delete', 'jacob')).toBeNull();
  });
});

describe('пароль', () => {
  it('короткий отклоняется', () => {
    expect(passwordProblem('1234567')).toMatch(/8/);
    expect(passwordProblem('12345678')).toBeNull();
    expect(passwordProblem(undefined)).not.toBeNull();
  });
});

describe('isWellFormedConversationId', () => {
  it('принимает настоящие id', () => {
    expect(isWellFormedConversationId('conversations:abc123XYZ')).toBe(true);
    expect(isWellFormedConversationId('abc123')).toBe(true);
    expect(isWellFormedConversationId('local-1727000000000')).toBe(true);
  });

  it('отвергает подмену scope RAG через двоеточие и индексы папок', () => {
    expect(isWellFormedConversationId('x:victim123')).toBe(false);
    expect(isWellFormedConversationId('local-1:victim123')).toBe(false);
    expect(isWellFormedConversationId('conversations:folder_abc')).toBe(false);
    expect(isWellFormedConversationId('folder_abc')).toBe(false);
    expect(isWellFormedConversationId('../etc')).toBe(false);
    expect(isWellFormedConversationId('')).toBe(false);
  });
});

describe('приглашение и первый вход', () => {
  const day = 24 * 60 * 60 * 1000;
  const invited = '2026-10-01T10:00:00.000Z';
  const t0 = new Date(invited).getTime();

  it('учётка с паролем — активна, дата приглашения не важна', () => {
    expect(accountState('scrypt$…', undefined)).toBe('active');
  });

  it('без пароля — ждёт первого входа 14 дней, потом приглашение истекает', () => {
    expect(accountState('', invited, t0 + 13 * day)).toBe('pending');
    expect(accountState('', invited, t0 + 15 * day)).toBe('expired');
    expect(accountState(undefined, invited, t0)).toBe('pending');
  });

  it('пустой пароль без даты приглашения не открывается', () => {
    expect(accountState('', undefined)).toBe('expired');
    expect(accountState('  ', 'мусор')).toBe('expired');
  });

  it('срок приглашения', () => {
    expect(inviteExpiresAt(invited)).toBe('2026-10-15T10:00:00.000Z');
    expect(inviteExpiresAt(null)).toBeNull();
  });
});
