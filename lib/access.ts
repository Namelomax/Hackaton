/**
 * Правила доступа: роли, папки, ограничения администрирования.
 *
 * Чистые функции без обращения к БД — их проверяют тесты, а роуты вызывают
 * после того, как достали записи. Спека:
 * docs/superpowers/specs/2026-10-02-admin-and-folders-design.md
 */
import { usernameLookupKey } from '@/lib/surreal-users';

export type Role = 'admin' | 'user';
export type FolderKind = 'shared' | 'personal';

export type AccessUser = {
  id: string;
  username: string;
  role: Role;
};

export type FolderAccessInfo = {
  kind: FolderKind;
  /** `users:…` для личной папки, null для общей. */
  ownerId: string | null;
  /** Участники общей папки (`users:…`). У личной не используется. */
  memberIds?: string[];
};

/** Логины из `ADMIN_USERNAMES` — в ключе поиска (trim + нижний регистр). */
export function envAdminUsernames(raw: string | undefined = process.env.ADMIN_USERNAMES): Set<string> {
  const out = new Set<string>();
  for (const part of String(raw ?? '').split(',')) {
    const key = usernameLookupKey(part);
    if (key) out.add(key);
  }
  return out;
}

export function isEnvAdmin(username: string, raw?: string): boolean {
  const key = usernameLookupKey(username);
  return Boolean(key) && envAdminUsernames(raw).has(key);
}

/** Роль из БД; всё, кроме явного 'admin', — обычный пользователь. */
export function normalizeRole(value: unknown): Role {
  return value === 'admin' ? 'admin' : 'user';
}

/** Эффективная роль: логин из конфига всегда admin, иначе роль из БД. */
export function effectiveRole(username: string, storedRole: unknown, raw?: string): Role {
  return isEnvAdmin(username, raw) ? 'admin' : normalizeRole(storedRole);
}

export function normalizeUserRef(id: string): string {
  const s = String(id ?? '').trim();
  return s.startsWith('users:') ? s : `users:${s}`;
}

export function isFolderMember(user: AccessUser, folder: FolderAccessInfo): boolean {
  const me = normalizeUserRef(user.id);
  return (folder.memberIds ?? []).some((id) => normalizeUserRef(id) === me);
}

/**
 * Работать в папке: создавать в ней чаты, видеть источники и инструкции,
 * получать её контекст в промпте.
 *
 * Общая — участникам и администраторам (админ ведёт все общие папки, даже
 * если сам в них не состоит). Вступить может любой активный пользователь
 * (см. canJoinFolder): членство здесь — способ навести порядок в списке, а не
 * секретность. Личная — только владельцу, админу тоже нет.
 */
export function canSeeFolder(user: AccessUser, folder: FolderAccessInfo): boolean {
  if (folder.kind === 'shared') return user.role === 'admin' || isFolderMember(user, folder);
  return Boolean(folder.ownerId) && normalizeUserRef(folder.ownerId as string) === normalizeUserRef(user.id);
}

export function canManageFolder(user: AccessUser, folder: FolderAccessInfo): boolean {
  if (folder.kind === 'shared') return user.role === 'admin';
  return canSeeFolder(user, folder);
}

/** Вступить самому — в любую общую папку, где ещё не состоишь. */
export function canJoinFolder(user: AccessUser, folder: FolderAccessInfo): boolean {
  return folder.kind === 'shared' && !isFolderMember(user, folder);
}

/** Добавлять и убирать участников — администратор, только у общих папок. */
export function canManageMembers(user: AccessUser, folder: FolderAccessInfo): boolean {
  return folder.kind === 'shared' && user.role === 'admin';
}

export function canCreateFolder(user: AccessUser, kind: FolderKind): boolean {
  return kind === 'personal' || user.role === 'admin';
}

export type AdminAction = 'block' | 'demote' | 'delete' | 'reset';

/**
 * Причина отказа в действии над пользователем или null, если можно.
 * Себя трогать нельзя — иначе админ одним кликом теряет доступ, а последний
 * админ оставляет систему без управления. Логин из конфига понизить или
 * заблокировать в интерфейсе бессмысленно: роль вернётся при следующем входе.
 */
export function adminActionDenial(
  actor: AccessUser,
  target: { id: string; username: string },
  action: AdminAction,
  raw?: string,
): string | null {
  if (normalizeUserRef(actor.id) === normalizeUserRef(target.id)) {
    return action === 'delete'
      ? 'Нельзя удалить свою учётную запись'
      : action === 'block'
        ? 'Нельзя заблокировать себя'
        : action === 'reset'
          ? 'Свой пароль меняйте кнопкой «Сменить пароль»'
          : 'Нельзя снять права администратора с себя';
  }
  if (isEnvAdmin(target.username, raw)) {
    return 'Администратор задан в ADMIN_USERNAMES — изменить можно только в конфигурации сервера';
  }
  return null;
}

/** Имя папки: обрезка пробелов, схлопывание повторов, лимит длины. */
export function normalizeFolderName(name: unknown): string {
  return String(name ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

export const FOLDER_INSTRUCTIONS_MAX = 8000;

export function normalizeFolderInstructions(text: unknown): string {
  return String(text ?? '').trim().slice(0, FOLDER_INSTRUCTIONS_MAX);
}

/** Scope RAG-индекса папки. Префикс не пересекается с id диалогов. */
export function folderRagScope(folderId: string): string {
  return `folder_${String(folderId).replace(/^folders:/, '')}`;
}

/**
 * Id диалога безопасен для использования как scope RAG: `conversations:<id>`,
 * `<id>` или `local-<цифры>`, где `<id>` — только буквы, цифры, `_`, `-` и не
 * начинается с `folder_` (это пространство индексов папок).
 */
export function isWellFormedConversationId(id: string): boolean {
  const s = String(id ?? '');
  if (/^local-\d+$/.test(s)) return true;
  const bare = s.replace(/^conversations:/, '');
  return /^[A-Za-z0-9_-]{1,64}$/.test(bare) && !bare.startsWith('folder_');
}

/**
 * Приглашение: админ заводит только логин, пароль пользователь придумывает
 * при первом входе. Пока пароля нет, учётку может «занять» любой, кто знает
 * логин, — поэтому приглашение живёт ограниченное время. Истекло — админ
 * нажимает «Сбросить пароль», и срок начинается заново.
 */
export const INVITE_TTL_DAYS = 14;

export type AccountState = 'active' | 'pending' | 'expired';

export function accountState(
  passwordHash: unknown,
  invitedAt: unknown,
  nowMs = Date.now(),
  ttlDays = INVITE_TTL_DAYS,
): AccountState {
  if (typeof passwordHash === 'string' && passwordHash.trim()) return 'active';
  const invited = invitedAt ? new Date(String(invitedAt)).getTime() : Number.NaN;
  // Без даты приглашения пустой пароль не открываем: это не приглашение, а
  // повреждённая запись.
  if (!Number.isFinite(invited)) return 'expired';
  return nowMs - invited <= ttlDays * 24 * 60 * 60 * 1000 ? 'pending' : 'expired';
}

export function inviteExpiresAt(invitedAt: unknown, ttlDays = INVITE_TTL_DAYS): string | null {
  const invited = invitedAt ? new Date(String(invitedAt)).getTime() : Number.NaN;
  if (!Number.isFinite(invited)) return null;
  return new Date(invited + ttlDays * 24 * 60 * 60 * 1000).toISOString();
}

/** Минимальная длина пароля, который задаёт админ или пользователь. */
export const MIN_PASSWORD_LENGTH = 8;

export function passwordProblem(password: unknown): string | null {
  const p = String(password ?? '');
  if (p.length < MIN_PASSWORD_LENGTH) return `Пароль должен быть не короче ${MIN_PASSWORD_LENGTH} символов`;
  return null;
}
