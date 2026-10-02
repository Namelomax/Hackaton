import { Surreal, RecordId, u } from "surrealdb";
import crypto from 'crypto';
// Раньше шло через lib/db/repositories/default-promt — трёхстрочный
// ре-экспорт, единственная живая ниточка к мёртвому слою lib/db/ (там лежала
// вторая, недостижимая схема БД, и именно её описывал CLAUDE.md). Слой удалён,
// импорт ведёт прямо к источнику.
import { DEFAULT_PROMPT } from '@/lib/config/prompt-config';
import { SGR_MAIN_AGENT_PROMPT } from '@/lib/prompts/sgr-prompts';
import { messagesArrayLooksCorrupt, resolveMessagesFromRecord } from '@/lib/conversationMessages';
import {
  readSurrealConnectionEnv,
  surrealEnvMissingMessage,
} from '@/lib/surreal-env';
import { surrealConnectionFingerprint } from '@/lib/surreal-connection-info';
import { surrealQueryFirst, surrealQueryRows } from '@/lib/surreal-query';
import { normalizeUsername, usernameLookupKey } from '@/lib/surreal-users';
import {
  accountState,
  type AccountState,
  effectiveRole,
  envAdminUsernames,
  inviteExpiresAt,
  isWellFormedConversationId,
  normalizeUserRef,
  type FolderKind,
  type Role,
} from '@/lib/access';

const db = new Surreal();
const surrealState = (globalThis as any).__surrealState || ((globalThis as any).__surrealState = {
  isConnected: false,
  logged: false,
});

export type Prompt = {
  id: string;
  title: string;
  content: string;
  isDefault: boolean;
  created: string;
  updated: string;
  ownerId?: string | null;
};

function toRecordString(record: any): string | null {
  if (!record) return null;
  if (typeof record === 'string') return record;
  if (typeof record === 'object' && typeof record.toString === 'function') {
    try {
      return record.toString();
    } catch {
      return null;
    }
  }
  return null;
}

function convertToPrompt(record: any): Prompt {
  return {
    id: record.id.toString(),
    title: record.title,
    content: record.content,
    isDefault: record.isDefault,
    created: record.created,
    updated: record.updated,
    ownerId: toRecordString(record.owner),
  };
}

// Функция для подключения к бд
async function connectDB() {
  if (surrealState.isConnected) {
    try {
      // Probe the connection; if socket is dead, Surreal will throw.
      await db.query('RETURN 1;');
      return;
    } catch {
      surrealState.isConnected = false;
    }
  }

  const { url, namespace, database, username, password } =
    readSurrealConnectionEnv();

  if (!url || !namespace || !database || !username || !password) {
    throw new Error(surrealEnvMissingMessage());
  }

  await db.connect(url, { reconnect: true });
  await db.use({ namespace, database });
  await db.signin({
    username: String(username),
    password: String(password),
  });

  surrealState.isConnected = true;
  if (!surrealState.logged) {
    surrealState.logged = true;
    const fp = surrealConnectionFingerprint();
    if (fp) {
      console.log(
        `[SurrealDB] connected ns=${fp.namespace} db=${fp.database} host=${fp.urlHost} (users persist only in this database)`,
      );
    } else if (process.env.SURREAL_LOG === '1') {
      console.log('✅ Connected to SurrealDB');
    }
  }

  try {
    await db.query(`
      DEFINE TABLE users SCHEMAFULL;
      DEFINE FIELD username ON users TYPE string;
      DEFINE FIELD usernameLower ON users TYPE string;
      DEFINE FIELD passwordHash ON users TYPE string;
      DEFINE FIELD created ON users TYPE datetime DEFAULT time::now() READONLY;
      DEFINE FIELD selectedPrompt ON users TYPE option<record<prompts>>;
      DEFINE INDEX idx_users_username_lower ON users FIELDS usernameLower UNIQUE;

      DEFINE TABLE prompts SCHEMAFULL;
      DEFINE FIELD title ON prompts TYPE string;
      DEFINE FIELD content ON prompts TYPE string;
      DEFINE FIELD isDefault ON prompts TYPE bool DEFAULT false;
      DEFINE FIELD owner ON prompts TYPE option<record<users>>;
      DEFINE FIELD created ON prompts TYPE datetime DEFAULT time::now() READONLY;
      DEFINE FIELD updated ON prompts TYPE datetime VALUE time::now();

      DEFINE TABLE protocol_examples SCHEMAFULL;
      DEFINE FIELD content ON protocol_examples TYPE string;
      DEFINE FIELD created ON protocol_examples TYPE datetime DEFAULT time::now() READONLY;

      DEFINE TABLE protocol_instructions SCHEMAFULL;
      DEFINE FIELD conversation ON protocol_instructions TYPE record<conversations>;
      DEFINE FIELD content ON protocol_instructions TYPE string;
      DEFINE FIELD openQuestions ON protocol_instructions TYPE array<string> DEFAULT [];
      DEFINE FIELD updated ON protocol_instructions TYPE datetime VALUE time::now();

DEFINE TABLE conversations SCHEMALESS;

DEFINE FIELD created ON conversations TYPE datetime DEFAULT time::now() READONLY;

DEFINE TABLE anonymization_mappings SCHEMALESS;
DEFINE FIELD updated ON anonymization_mappings TYPE datetime VALUE time::now();

    `);
  } catch (error: any) {
    if (!error.message?.includes?.('already exists')) {
      console.error("Error defining schema:", error);
    }
  }

  try {
    await db.query(`
      UPDATE users
      SET usernameLower = string::lowercase(username)
      WHERE usernameLower IS NONE AND username IS NOT NONE;
    `);
  } catch {
    /* optional backfill */
  }

  // Роли, блокировка, папки. Отдельным запросом и с IF NOT EXISTS: основной
  // DDL выше на живой базе отвечает «already exists», и смешивать с ним новые
  // определения — значит гадать, какие из них применились.
  try {
    await db.query(`
      -- option<…>: у существующих записей полей нет, и строгий TYPE ронял бы
      -- любой merge по ним (смена хеша пароля, lastLogin). NONE = 'user' / не
      -- заблокирован — так их и читает userFromRecord.
      DEFINE FIELD IF NOT EXISTS role ON users TYPE option<string> ASSERT $value = NONE OR $value IN ['admin', 'user'];
      DEFINE FIELD IF NOT EXISTS blocked ON users TYPE option<bool>;

      DEFINE TABLE IF NOT EXISTS folders SCHEMAFULL;
      DEFINE FIELD IF NOT EXISTS name ON folders TYPE string;
      DEFINE FIELD IF NOT EXISTS kind ON folders TYPE string ASSERT $value IN ['shared', 'personal'];
      DEFINE FIELD IF NOT EXISTS owner ON folders TYPE option<record<users>>;
      DEFINE FIELD IF NOT EXISTS instructions ON folders TYPE string DEFAULT '';
      DEFINE FIELD IF NOT EXISTS created ON folders TYPE datetime DEFAULT time::now() READONLY;
      DEFINE FIELD IF NOT EXISTS updated ON folders TYPE datetime VALUE time::now();
      DEFINE INDEX IF NOT EXISTS idx_folders_owner ON folders FIELDS owner;
      DEFINE FIELD IF NOT EXISTS lastLogin ON users TYPE option<datetime>;
      -- Приглашение: пароль пуст, пока пользователь не придумает его при первом входе.
      DEFINE FIELD IF NOT EXISTS invitedAt ON users TYPE option<datetime>;
      -- Участники общей папки.
      DEFINE FIELD IF NOT EXISTS members ON folders TYPE option<array<record<users>>>;
      DEFINE INDEX IF NOT EXISTS idx_conversations_user ON conversations FIELDS user;
      DEFINE FIELD IF NOT EXISTS updated ON conversations TYPE datetime VALUE time::now();
      -- Папка чата. На живой базе conversations объявлена SCHEMAFULL, и без
      -- этого определения SurrealDB МОЛЧА отбрасывала поле: чат «переносился»
      -- в папку, а после перезагрузки снова оказывался «без папки».
      DEFINE FIELD IF NOT EXISTS folder ON conversations TYPE option<record<folders>>;
    `);
  } catch (error: any) {
    console.error('Error defining access schema:', error?.message ?? error);
  }

  await backfillLegacyUsers();

  if (!surrealState.adminChecked) {
    surrealState.adminChecked = true;
    void warnIfNoAdmins();
  }
}

/**
 * Достроить старые записи users. На живой базе у 22 из 28 пользователей не
 * было usernameLower (поле обязательное), а значит ЛЮБОЙ UPDATE такой записи
 * падал: админ не мог её заблокировать, сменить роль или сбросить пароль.
 * Массовый UPDATE не годится — одна запись с конфликтом откатывает все
 * (так и было: логины «test» и «Test» дают одинаковый ключ уникального
 * индекса). Поэтому по одной, а дублю регистра — ключ с суффиксом id.
 */
async function backfillLegacyUsers(): Promise<void> {
  let rows: Record<string, unknown>[] = [];
  try {
    rows = surrealQueryRows(
      await db.query(
        'SELECT id, username, usernameLower FROM users WHERE usernameLower IS NONE OR role IS NONE OR blocked IS NONE;',
      ),
    );
  } catch (e) {
    console.warn('[users] не удалось найти записи для бэкфилла:', (e as Error)?.message);
    return;
  }
  if (rows.length === 0) return;

  let fixed = 0;
  for (const row of rows) {
    const id = row.id as RecordId;
    const key = usernameLookupKey(String(row.username ?? ''));
    const update = (lower: string | null) =>
      db.query(
        `UPDATE $id SET usernameLower = usernameLower ?? $lower, role = role ?? 'user', blocked = blocked ?? false RETURN NONE;`,
        { id, lower },
      );
    try {
      await update(row.usernameLower ? null : key);
      fixed++;
    } catch (e) {
      const message = String((e as Error)?.message ?? e);
      if (!message.includes('idx_users_username_lower')) {
        console.warn(`[users] бэкфилл ${String(id)} не удался:`, message);
        continue;
      }
      // Такой ключ уже занят другим логином, отличающимся регистром.
      const unique = `${key}~${String(id).replace(/^users:/, '')}`;
      try {
        await update(unique);
        fixed++;
        console.warn(
          `[users] логин «${String(row.username)}» совпадает с другим без учёта регистра — ` +
            `ключ поиска «${unique}». Удалите лишнюю учётку на /admin.`,
        );
      } catch (e2) {
        console.warn(`[users] бэкфилл ${String(id)} не удался:`, (e2 as Error)?.message);
      }
    }
  }
  console.log(`[users] бэкфилл старых записей: ${fixed}/${rows.length}`);
}

/**
 * Пользователей создаёт только администратор. Если нет ни логинов в
 * ADMIN_USERNAMES, ни админов в БД — создать учётку некому, и это надо видеть
 * в логе сразу, а не после жалобы «не могу зарегистрироваться».
 */
async function warnIfNoAdmins(): Promise<void> {
  if (envAdminUsernames().size > 0) return;
  try {
    const rows = surrealQueryRows(await db.query(`SELECT id FROM users WHERE role = 'admin' LIMIT 1;`));
    if (rows.length === 0) {
      console.warn(
        '[auth] нет ни одного администратора: задайте ADMIN_USERNAMES в .env — иначе создавать пользователей некому.',
      );
    }
  } catch {
    /* только диагностика */
  }
}

/** Для /api/health/db — гарантирует подключение и схему. */
export async function connectDBForHealth(): Promise<void> {
  await connectDB();
}

export async function countUsers(): Promise<number> {
  await connectDB();
  const result = await db.query(`SELECT * FROM users;`);
  return surrealQueryRows(result).length;
}

// Вспомогательная функция — всегда возвращает корректный формат id
type PromptIdParts = { table: string; value: string };

function parsePromptId(id: string): PromptIdParts {
  const raw = String(id ?? '').trim();
  if (!raw) {
    return { table: 'prompts', value: '' };
  }

  if (raw.includes(':')) {
    const [table, ...rest] = raw.split(':');
    return { table: table || 'prompts', value: rest.join(':') };
  }

  return { table: 'prompts', value: raw };
}

function promptRecordId(id: string): RecordId {
  const { table, value } = parsePromptId(id);
  return new RecordId(table || 'prompts', value);
}

function promptRecordCandidates(id: string): RecordId[] {
  const raw = String(id ?? '').trim();
  if (!raw) return [];

  if (raw.includes(':')) {
    return [promptRecordId(raw)];
  }

  return [new RecordId('prompts', raw), new RecordId('prompt', raw)];
}

async function getPromptRecord(id: string): Promise<{ data: any; recordId: RecordId } | null> {
  await connectDB();
  const candidates = promptRecordCandidates(id);

  for (const candidate of candidates) {
    const prompt = await db.select(candidate).catch(() => undefined);
    const record = Array.isArray(prompt) ? prompt?.[0] : prompt;
    if (record) {
      return { data: record, recordId: candidate };
    }
  }

  return null;
}

function normalizeUserId(id: string): string {
  return id.startsWith('users:') ? id : `users:${id}`;
}

// Получить все промпты
export async function getAllPrompts(userId?: string): Promise<Prompt[]> {
  await connectDB();

  if (!userId) {
    const result = (await db.query(`SELECT * FROM prompts WHERE isDefault = true ORDER BY updated DESC;`)) as [any[]];
    return (result?.[0] ?? []).map(convertToPrompt);
  }

  const normalizedUser = normalizeUserId(userId);
  const cleanUser = normalizedUser.replace(/^users:/, '');
  const ownerRecord = new RecordId('users', cleanUser);

  const result = (await db.query(
    `SELECT * FROM prompts WHERE isDefault = true OR owner = $owner ORDER BY isDefault DESC, updated DESC;`,
    { owner: ownerRecord },
  )) as [any[]];

  return (result?.[0] ?? []).map(convertToPrompt);
}

export type User = {
  id: string;
  username: string;
  created: string;
  /** Эффективная роль: с учётом ADMIN_USERNAMES (см. lib/access.ts). */
  role: Role;
  blocked: boolean;
  /** active — пароль задан; pending — ждёт первого входа; expired — приглашение истекло. */
  state: AccountState;
  /** До какого момента можно придумать пароль (только для pending/expired). */
  inviteExpiresAt: string | null;
};

export type Conversation = {
  id: string;
  user: string;
  messages: any;
  created: string;
  title?: string;
  messages_raw?: string;
  document_content?: string;
  /** `folders:…` или null — «Без папки». */
  folderId?: string | null;
};

export type ProtocolExample = {
  id: string;
  content: string;
  created: string;
};

export type ProtocolInstruction = {
  id: string;
  conversationId: string;
  content: string;
  openQuestions: string[];
  updated: string;
};

function sanitizeMessagePart(part: any): any {
  if (!part || typeof part !== 'object') return part;
  const type = String((part as any).type ?? '');

  if (type === 'text') {
    const raw = (part as any).text;
    const alt = (part as any).content;
    const text =
      typeof raw === 'string'
        ? raw
        : typeof alt === 'string'
          ? alt
          : '';
    return { type: 'text', text };
  }

  if (type === 'file') {
    // Preserve attachment info so UI can restore filename/type and allow download.
    return {
      type: 'file',
      id: (part as any).id,
      filename: (part as any).filename,
      url: (part as any).url,
      mediaType: (part as any).mediaType,
    };
  }

  // Best-effort for other part types: keep type and common fields.
  const out: any = { type };
  if (typeof (part as any).text === 'string') out.text = (part as any).text;
  if ((part as any).metadata && typeof (part as any).metadata === 'object') out.metadata = (part as any).metadata;
  return out;
}

function textFromContentField(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const chunks: string[] = [];
  for (const item of content) {
    if (typeof item === 'string') {
      chunks.push(item);
      continue;
    }
    if (item && typeof item === 'object') {
      const t = (item as any).text;
      if (typeof t === 'string') chunks.push(t);
    }
  }
  return chunks.join('');
}

function sanitizeMessage(message: any): any {
  const id =
    message?.id ||
    (typeof crypto !== 'undefined' && (crypto as any).randomUUID
      ? (crypto as any).randomUUID()
      : String(Date.now()));

  const parts = Array.isArray(message?.parts)
    ? message.parts.map(sanitizeMessagePart)
    : [];

  const fromParts = Array.isArray(message?.parts)
    ? message.parts
        .filter((p: any) => p && (p.type === 'text' || String(p.type ?? '') === 'text'))
        .map((p: any) => (typeof p.text === 'string' ? p.text : typeof p.content === 'string' ? p.content : ''))
        .join('')
    : '';

  const fromContent = textFromContentField(message?.content);
  const fromTopLevel = typeof message?.text === 'string' ? message.text : '';
  const text = fromParts || fromContent || fromTopLevel;

  let finalParts = parts;
  const hasNonEmptyTextPart = finalParts.some(
    (p: any) => p && String(p.type) === 'text' && typeof p.text === 'string' && p.text.trim() !== '',
  );
  if (!hasNonEmptyTextPart && String(text).trim()) {
    finalParts = [{ type: 'text', text: String(text) }, ...finalParts.filter((p: any) => String(p?.type) !== 'text')];
  }

  const metadata = message?.metadata && typeof message.metadata === 'object' ? message.metadata : {};

  return {
    id,
    role: message?.role || 'user',
    text,
    parts: finalParts,
    metadata,
  };
}

/**
 * После чтения из Surreal в `parts` иногда пусто или текстовые части без `text`,
 * при этом поле `text` на верхнем уровне сообщения заполнено — иначе UI показывает пустые пузыри.
 */
export function repairMessagesForApi(messages: unknown): any[] {
  if (!Array.isArray(messages)) return [];
  return messages.map((raw) => {
    const msg = raw && typeof raw === 'object' ? { ...(raw as Record<string, unknown>) } : {};
    const textFallback =
      typeof (msg as any).text === 'string'
        ? (msg as any).text
        : typeof (msg as any).content === 'string'
          ? (msg as any).content
          : '';
    let parts = Array.isArray((msg as any).parts) ? [...((msg as any).parts as any[])] : [];
    parts = parts.map((p: any) => {
      if (!p || typeof p !== 'object') return p;
      if (String(p.type) === 'text') {
        const t = typeof p.text === 'string' ? p.text : '';
        const c = typeof p.content === 'string' ? p.content : '';
        const merged = t.trim() ? t : c;
        return { ...p, type: 'text', text: merged };
      }
      return p;
    });
    const hasNonEmptyText = parts.some(
      (p: any) => p && String(p.type) === 'text' && typeof p.text === 'string' && p.text.trim() !== '',
    );
    if (!hasNonEmptyText && textFallback.trim()) {
      parts = [{ type: 'text', text: textFallback }, ...parts.filter((p: any) => String(p?.type) !== 'text')];
    }
    if (parts.length === 0) {
      parts = [{ type: 'text', text: textFallback }];
    }
    return { ...msg, parts };
  });
}

function userFromRecord(rec: Record<string, unknown>): User {
  const id = rec.id as { toString?: () => string };
  return {
    id: typeof id?.toString === 'function' ? id.toString() : String(rec.id),
    username: String(rec.username ?? ''),
    created: String(rec.created ?? ''),
    role: effectiveRole(String(rec.username ?? ''), rec.role),
    blocked: rec.blocked === true,
    state: accountState(rec.passwordHash, rec.invitedAt),
    inviteExpiresAt:
      typeof rec.passwordHash === 'string' && rec.passwordHash.trim() ? null : inviteExpiresAt(rec.invitedAt),
  };
}

// Create a new user
export async function createUser(
  username: string,
  passwordHash: string,
  role: Role = 'user',
): Promise<User> {
  await connectDB();
  const displayName = normalizeUsername(username);
  const usernameLower = usernameLookupKey(username);
  if (!displayName || !usernameLower) {
    throw new Error('username required');
  }

  const created = await db.create('users', {
    username: displayName,
    usernameLower,
    passwordHash,
    role,
    blocked: false,
  });
  const user = Array.isArray(created) ? created[0] : created;
  if (!user) {
    throw new Error('Failed to create user record');
  }
  const row = userFromRecord(user as Record<string, unknown>);
  console.log(`[auth] user created id=${row.id} username=${row.username} key=${usernameLower}`);
  return row;
}

export async function getUserByUsername(username: string): Promise<User | null> {
  await connectDB();
  const usernameLower = usernameLookupKey(username);
  if (!usernameLower) return null;

  const result = await db.query(
    `SELECT * FROM users
     WHERE usernameLower = $usernameLower
        OR string::lowercase(username) = $usernameLower
     LIMIT 1;`,
    { usernameLower },
  );
  const rec = surrealQueryFirst(result);
  if (!rec) return null;
  return userFromRecord(rec);
}

/**
 * Пользователь вместе с хешем пароля — для проверки В КОДЕ.
 *
 * `authenticateUser` ниже сравнивает хеш прямо в SQL (`WHERE passwordHash =
 * $passwordHash`), а это возможно только для детерминированного хеша без соли.
 * У scrypt соль индивидуальная, поэтому сравнивать нужно после выборки.
 */
export async function findUserForLogin(
  username: string,
): Promise<{ user: User; passwordHash: string } | null> {
  await connectDB();
  const usernameLower = usernameLookupKey(username);
  if (!usernameLower) return null;

  const result = await db.query(
    `SELECT * FROM users
     WHERE usernameLower = $usernameLower OR string::lowercase(username) = $usernameLower
     LIMIT 1;`,
    { usernameLower },
  );
  const rec = surrealQueryFirst(result);
  if (!rec) return null;
  // Пустой хеш — приглашённый пользователь, ещё не придумавший пароль. Его
  // тоже возвращаем: решает роут по user.state, а verifyPassword на пустом
  // хеше всегда даёт отказ.
  const passwordHash = String((rec as Record<string, unknown>).passwordHash ?? '');
  return { user: userFromRecord(rec), passwordHash };
}

/** Перезаписать хеш пароля — используется при миграции со старого формата. */
export async function updateUserPasswordHash(userId: string, passwordHash: string): Promise<void> {
  await connectDB();
  const clean = String(userId).replace(/^users:/, '');
  try {
    await db.merge(new RecordId('users', clean), { passwordHash } as any);
  } catch (e) {
    console.warn('updateUserPasswordHash failed:', (e as Error)?.message);
  }
}

/** @deprecated Сравнение хеша в запросе. Работает только со старым sha256. */
export async function authenticateUser(username: string, passwordHash: string): Promise<User | null> {
  await connectDB();
  const usernameLower = usernameLookupKey(username);
  if (!usernameLower) return null;

  const result = await db.query(
    `SELECT * FROM users
     WHERE (usernameLower = $usernameLower OR string::lowercase(username) = $usernameLower)
       AND passwordHash = $passwordHash
     LIMIT 1;`,
    { usernameLower, passwordHash },
  );
  const rec = surrealQueryFirst(result);
  if (!rec) return null;
  return userFromRecord(rec);
}

// Create prompt owned by a user
export async function createPromptForUser(userId: string, title: string, content: string) {
  await connectDB();
  const owner = userId.startsWith('users:') ? userId.replace(/^users:/, '') : userId;
  const recordId = new RecordId('users', owner);
  const [prompt] = await db.create('prompts', { title, content, isDefault: false, owner: recordId });
  return convertToPrompt(prompt);
}

// Get prompts for a specific user
export async function getUserPrompts(userId: string): Promise<Prompt[]> {
  await connectDB();
  const owner = normalizeUserId(userId);
  const cleanOwner = owner.replace(/^users:/, '');
  const ownerRecord = new RecordId('users', cleanOwner);
  const result = (await db.query(`SELECT * FROM prompts WHERE owner = $owner ORDER BY updated DESC;`, { owner: ownerRecord })) as [any[]];
  return (result?.[0] ?? []).map(convertToPrompt);
}

// Save conversation
export async function saveConversation(
  userId: string,
  messages: any,
  documentContent?: string,
  folderId?: string | null,
): Promise<Conversation> {
  await connectDB();
  const userRef = userId.startsWith('users:') ? userId : `users:${userId}`;
  // create conversation with user reference
  const userClean = userRef.replace(/^users:/, '');
  const userRecord = new RecordId('users', userClean);
  // sanitize messages to plain JSON-friendly objects
  if (process.env.SURREAL_LOG === '1') {
    console.log('saveConversation: incoming messages type=', typeof messages, 'isArray=', Array.isArray(messages), 'length=', Array.isArray(messages) ? messages.length : 'N/A');
  }
  const sanitized = Array.isArray(messages) ? messages.map(sanitizeMessage) : [];

  // Ensure we pass a pure JSON structure (no prototype/functions)
  const sanitizedClean = JSON.parse(JSON.stringify(sanitized));

  if (process.env.SURREAL_LOG === '1') {
    console.log('saveConversation: sanitized length=', Array.isArray(sanitizedClean) ? sanitizedClean.length : 'N/A', 'sample=', sanitizedClean[0]);
  }
  /*
  try {
    console.log('saveConversation: final DB payload userRef=', userRef, 'messages=', JSON.stringify(sanitizedClean));
  } catch (e) {
    console.log('saveConversation: final DB payload userRef=', userRef, 'messages=[unserializable]');
  }
  */

  const createPayload: any = { 
    user: userRecord, 
    messages: sanitizedClean, 
    title: "Чат",
    messages_raw: JSON.stringify(sanitizedClean),
    document_content: documentContent || "",
    ...(folderId ? { folder: folderRecord(folderId) } : {}),
  };

  const [conv] = await db.create('conversations', createPayload);
  // Create a RecordId for this conversation so further operations use the proper record object
  const convClean = String((conv as any).id).replace(/^conversations:/, '');
  const convRecord = new RecordId('conversations', convClean);
  let storedConv: any = conv;
  /*
  try {
    console.log('✅ Created conversation (create response) for', userRef, 'id=', String((conv as any).id), 'rawConv=', JSON.stringify(conv));
  } catch (e) {
    console.log('✅ Created conversation (create response) for', userRef, 'id=', String((conv as any).id), 'rawConv=[unserializable]');
  }
  */

  // Some SurrealDB setups may not persist nested arrays immediately in the create response.
  // Ensure messages are explicitly merged/set after creation to avoid empty arrays.
  try {
    // Use the RecordId when merging so Surreal treats this as the same record
    await db.merge(convRecord, { messages: sanitizedClean, messages_raw: JSON.stringify(sanitizedClean) });
    // Re-select to get the stored result
    let sel = await db.select(convRecord).catch(() => undefined);
    storedConv = Array.isArray(sel) ? sel[0] : sel;

    // If select didn't return anything, try a fallback query
    if (!storedConv) {
      try {
        const q = await db.query(`SELECT * FROM ${convRecord} LIMIT 1;`).catch(() => undefined) as any;
        const rows = (q?.[0] ?? []);
        storedConv = rows[0];
      } catch (qe) {
        storedConv = undefined;
      }
    }

    if (storedConv) {
      /*
      try {
        console.log('saveConversation: after merge select storedConv=', JSON.stringify(storedConv));
      } catch (e) {
        console.log('saveConversation: after merge storedConv=[unserializable]');
      }
      */
    } else {
      console.warn('saveConversation: unable to read back stored conversation after merge for id=', String(conv.id));
    }
  } catch (e) {
    console.error('saveConversation: failed to merge messages after create', e);
  }

  // If after merge/select we still have no messages, try an explicit UPDATE query as a stronger fallback.
  try {
    const currentMessages = (storedConv as any)?.messages;
    if (!Array.isArray(currentMessages) || currentMessages.length === 0) {
      if (process.env.SURREAL_LOG === '1') {
        console.log('saveConversation: attempting explicit UPDATE to set messages via SQL for', String(conv.id));
      }
      // Use CONTENT to set the messages fields explicitly as a stronger fallback
      const uq = await db.query(`UPDATE ${convRecord} CONTENT $content RETURN AFTER;`, { content: { messages: sanitizedClean, messages_raw: JSON.stringify(sanitizedClean) } }).catch(() => undefined) as any;
      /*
      try {
        console.log('saveConversation: UPDATE result=', JSON.stringify(uq));
      } catch (e) {
        console.log('saveConversation: UPDATE result=[unserializable]');
      }
      */

      const sel2 = await db.select(convRecord).catch(() => undefined);
      const newConv = Array.isArray(sel2) ? sel2[0] : sel2;
      if (newConv) {
        storedConv = newConv;
        /*
        try {
          console.log('saveConversation: after UPDATE select storedConv=', JSON.stringify(storedConv));
        } catch (e) {
          console.log('saveConversation: after UPDATE storedConv=[unserializable]');
        }
        */
      } else {
        console.warn('saveConversation: UPDATE did not persist messages for', String(convRecord));
      }
    }
  } catch (e) {
    console.error('saveConversation: explicit UPDATE attempt failed', e);
  }

  // Final fallback: persist messages as a JSON string in `messages_raw` field
  if (!Array.isArray((storedConv as any)?.messages) || (storedConv as any)?.messages?.length === 0) {
      try {
        // console.log('saveConversation: persisting messages as JSON string in `messages_raw` for', String(convRecord));
        await db.merge(convRecord, { messages_raw: JSON.stringify(sanitizedClean) }).catch(() => undefined);
        const sel3 = await db.select(convRecord).catch(() => undefined);
        const got = Array.isArray(sel3) ? sel3[0] : sel3;
      if (got) {
        storedConv = got;
        /*
        try {
          console.log('saveConversation: after messages_raw merge storedConv=', JSON.stringify(storedConv));
        } catch (e) {
          console.log('saveConversation: after messages_raw storedConv=[unserializable]');
        }
        */
      }
    } catch (e) {
      console.error('saveConversation: failed to persist messages_raw fallback', e);
    }
  }

  // If storedConv is still missing, fall back to returning a best-effort object so caller doesn't crash.
  if (!storedConv) {
    const fallback = {
      id: String(conv.id),
      user: String(userRecord),
      messages: repairMessagesForApi(sanitizedClean),
      created: (conv as any)?.created ?? new Date().toISOString(),
      title: 'Чат',
      messages_raw: JSON.stringify(sanitizedClean),
      document_content: documentContent ?? '',
    };
    return fallback as Conversation;
  }

  let outMessages = resolveMessagesFromRecord(
    (storedConv as any).messages,
    (storedConv as any).messages_raw,
  );
  if (outMessages.length === 0 || messagesArrayLooksCorrupt(outMessages)) {
    outMessages = sanitizedClean;
  }

  return {
    id: storedConv.id.toString(),
    user: String((storedConv as any).user),
    messages: repairMessagesForApi(outMessages ?? sanitizedClean),
    messages_raw: String((storedConv as any).messages_raw ?? JSON.stringify(sanitizedClean)),
    created: String((storedConv as any).created),
    title: String((storedConv as any).title ?? 'Чат'),
    folderId: folderIdOf(storedConv),
    document_content:
      typeof (storedConv as any).document_content === 'string'
        ? (storedConv as any).document_content
        : '',
  };
}

// Update existing conversation by id
export async function updateConversation(conversationId: string, messages: any, documentContent?: string): Promise<Conversation> {
  await connectDB();
  const clean = conversationId.replace(/^conversations:/, '');
  const recordObj = new RecordId('conversations', clean);
  const recordIdString = `conversations:${clean}`;

  // verbose update log removed — was dumping full message content to stdout

  // Sanitize messages before update
  // console.log('updateConversation: incoming messages type=', typeof messages, 'isArray=', Array.isArray(messages), 'length=', Array.isArray(messages) ? messages.length : 'N/A');
  const sanitized = Array.isArray(messages) ? messages.map(sanitizeMessage) : [];

  const sanitizedClean = JSON.parse(JSON.stringify(sanitized));

  // console.log('updateConversation: sanitized length=', Array.isArray(sanitizedClean) ? sanitizedClean.length : 'N/A', 'sample=', sanitizedClean[0]);
  /*
  try {
    console.log('updateConversation: final DB payload recordId=', recordIdString, 'messages=', JSON.stringify(sanitizedClean));
  } catch (e) {
    console.log('updateConversation: final DB payload recordId=', recordIdString, 'messages=[unserializable]');
  }
  */

  // Attempt merge first using RecordId object for consistency
  const updatePayload: any = { 
    messages: sanitizedClean, 
    messages_raw: JSON.stringify(sanitizedClean) 
  };
  if (documentContent !== undefined) {
    updatePayload.document_content = documentContent;
  }

  await db.merge(recordObj, updatePayload).catch(async (e: any) => {
    console.warn('updateConversation: merge failed, falling back to UPDATE SQL', e?.message);
    await db.query(`UPDATE ${recordIdString} SET messages = $messages, messages_raw = $messages_raw${documentContent !== undefined ? ', document_content = $document_content' : ''} RETURN AFTER;`, { 
      messages: sanitizedClean, 
      messages_raw: JSON.stringify(sanitizedClean),
      document_content: documentContent
    }).catch((ee) => {
      console.error('updateConversation: UPDATE fallback failed', ee);
    });
  });

  // Read back the record using select
  let conv = await db.select(recordObj).catch(() => undefined) as any;
  let convData = Array.isArray(conv) ? conv[0] : conv;

  // If still missing, try explicit query
  if (!convData) {
    try {
      const q = await db.query(`SELECT * FROM ${recordIdString} LIMIT 1;`).catch(() => undefined) as any;
      const rows = (q?.[0] ?? []);
      convData = rows[0];
    } catch (e) {
      convData = undefined;
    }
  }

  if (!convData) {
    console.error('updateConversation: conversation not found for id', recordIdString, 'returning fallback object');
    // Best-effort fallback so caller does not crash
    return {
      id: recordIdString,
      user: '',
      messages: repairMessagesForApi(sanitizedClean),
      messages_raw: JSON.stringify(sanitizedClean),
      created: new Date().toISOString(),
      title: 'Чат',
      document_content: typeof documentContent === 'string' ? documentContent : '',
    };
  }

  /*
  try {
    console.log('updateConversation: stored conversation messages length=', Array.isArray((convData as any)?.messages) ? (convData as any).messages.length : 'N/A', 'sample=', (convData as any)?.messages?.[0]);
    console.log('updateConversation: stored conversation raw=', JSON.stringify(convData));
  } catch (e) {
    console.log('updateConversation: stored conversation raw=[unserializable]');
  }
  */

  let mergedMessages = resolveMessagesFromRecord(convData?.messages, convData?.messages_raw);
  if (mergedMessages.length === 0 || messagesArrayLooksCorrupt(mergedMessages)) {
    mergedMessages = sanitizedClean;
  }

  // verbose return log removed

  return {
    id: convData.id?.toString?.() ?? recordIdString,
    user: String((convData as any).user ?? ''),
    messages: repairMessagesForApi(mergedMessages),
    messages_raw: String((convData as any).messages_raw ?? JSON.stringify(sanitizedClean)),
    created: String((convData as any).created ?? new Date().toISOString()),
    title: String((convData as any).title ?? 'Чат'),
    folderId: folderIdOf(convData),
    document_content:
      typeof (convData as any).document_content === 'string' ? (convData as any).document_content : '',
  };
}

export async function renameConversation(convId: string, title: string): Promise<Conversation> {
  await connectDB();
  const clean = convId.replace(/^conversations:/, '');
  const recordObj = new RecordId('conversations', clean);
  const trimmedTitle = title.trim();

  await db.merge(recordObj, { title: trimmedTitle });

  const conv = await db.select(recordObj).catch(() => undefined) as any;
  const convData = Array.isArray(conv) ? conv[0] : conv;
  if (!convData) {
    return {
      id: `conversations:${clean}`,
      user: '',
      messages: [],
      created: new Date().toISOString(),
      title: trimmedTitle,
    };
  }

  const messages = resolveMessagesFromRecord(convData.messages, convData.messages_raw);

  return {
    id: convData.id?.toString?.() ?? `conversations:${clean}`,
    user: String((convData as any).user ?? ''),
    messages: repairMessagesForApi(messages ?? []),
    messages_raw: String((convData as any).messages_raw ?? ''),
    created: String((convData as any).created ?? new Date().toISOString()),
    title: trimmedTitle,
    folderId: folderIdOf(convData),
    document_content:
      typeof (convData as any).document_content === 'string' ? (convData as any).document_content : '',
  };
}

/**
 * Текущий заголовок диалога, либо null если записи нет.
 *
 * Ошибку чтения ПРОБРАСЫВАЕМ, а не превращаем в null: вызывающий роут по null
 * решает «заголовок дефолтный, можно перезаписать», и проглоченный сбой БД
 * означал бы затирание названия, которое пользователь задал руками.
 */
export async function getConversationTitle(convId: string): Promise<string | null> {
  await connectDB();
  const clean = convId.replace(/^conversations:/, '');
  const recordObj = new RecordId('conversations', clean);
  const raw = await db.select(recordObj);
  const convData = Array.isArray(raw) ? raw[0] : raw;
  if (!convData) return null;
  const title = (convData as any).title;
  return typeof title === 'string' ? title : null;
}

export async function deleteConversation(convId: string, userId?: string): Promise<void> {
  await connectDB();
  const cleanConvId = convId.replace(/^conversations:/, '');
  const convRecord = new RecordId('conversations', cleanConvId);

  if (userId) {
    const convRaw = await db.select(convRecord).catch(() => undefined);
    const convData = Array.isArray(convRaw) ? convRaw[0] : convRaw;
    if (!convData) {
      throw new Error('Conversation not found');
    }
    const ownerRef = convData.user?.toString?.() ?? String(convData.user ?? '');
    const normalizedUser = userId.startsWith('users:') ? userId : `users:${userId}`;
    if (ownerRef && normalizedUser && ownerRef !== normalizedUser) {
      throw new ForbiddenError();
    }
  }

  await db.delete(convRecord);
}

/**
 * Диалог принадлежит другому пользователю. Отдельный класс, а не строка в
 * `message`: раньше вызывающие сравнивали `e.message === 'Forbidden'`, и любая
 * ДРУГАЯ ошибка внутри гарда (обрыв WebSocket к SurrealDB, таймаут, правка
 * текста исключения) просто логировалась, а запрос шёл дальше уже без проверки.
 * Гард открывался ровно тогда, когда база нестабильна.
 */
export class ForbiddenError extends Error {
  constructor(message = 'Forbidden') {
    super(message);
    this.name = 'ForbiddenError';
  }
}

/** Проверить владельца не удалось. Это НЕ «доступ разрешён» — это 503. */
export class OwnershipCheckUnavailableError extends Error {
  constructor(cause: unknown) {
    super(`Проверка владельца диалога недоступна: ${(cause as Error)?.message ?? cause}`);
    this.name = 'OwnershipCheckUnavailableError';
  }
}

/**
 * ЕДИНЫЙ гард изоляции диалогов. Бросает ForbiddenError, если диалог существует
 * и принадлежит ДРУГОМУ пользователю (или запрос анонимный, а диалог — с
 * владельцем). Применяется во ВСЕХ эндпоинтах с conversationId (/api/chat,
 * /api/conversations), чтобы сообщения одного
 * пользователя НИКОГДА не попадали в чужой диалог. Незаписанные (local-...) и
 * несуществующие id пропускаются — красть в них нечего.
 */
export async function assertConversationOwnership(
  conversationId?: string | null,
  userId?: string | null,
): Promise<void> {
  if (!conversationId) return;
  // Форма id — ДО любых ранних выходов. RAG-сервис берёт часть после
  // последнего «:», а несуществующую запись гард ниже пропускает. Без этой
  // проверки `x:<чужой id>` или `local-1:<чужой id>` проходил гард и открывал
  // чужой RAG-индекс; `folder_…` — индекс папки в обход её прав.
  if (!isWellFormedConversationId(conversationId)) throw new ForbiddenError();
  if (conversationId.startsWith('local-')) return;
  await connectDB();
  const cleanConvId = conversationId.replace(/^conversations:/, '');
  const convRecord = new RecordId('conversations', cleanConvId);
  // Ошибку чтения НЕЛЬЗЯ трактовать как «записи нет»: раньше здесь стоял
  // `.catch(() => undefined)`, и при недоступной БД гард пропускал кого угодно.
  let convRaw: unknown;
  try {
    convRaw = await db.select(convRecord);
  } catch (e) {
    throw new OwnershipCheckUnavailableError(e);
  }
  const convData = Array.isArray(convRaw) ? convRaw[0] : convRaw;
  if (!convData) return; // записи нет — новый диалог, красть нечего
  const ownerRef = (convData as any).user?.toString?.() ?? String((convData as any).user ?? '');
  if (!ownerRef) return; // безвладельный (legacy/system) — не трогаем

  // У диалога ЕСТЬ владелец → аноним к нему не допускается. Раньше здесь стоял
  // ранний выход при отсутствии userId, и защиту можно было обойти, просто не
  // прислав его. Теперь клиент передаёт userId в теле запроса явно, поэтому
  // требуем совпадения всегда.
  if (!userId) throw new ForbiddenError();
  const normalizedUser = userId.startsWith('users:') ? userId : `users:${userId}`;
  if (ownerRef !== normalizedUser) {
    throw new ForbiddenError();
  }
}

// Create a new empty conversation for a user (returns created conversation)
export async function createConversation(
  userId: string,
  title?: string,
  folderId?: string | null,
): Promise<Conversation> {
  await connectDB();
  const userRef = userId.startsWith('users:') ? userId.replace(/^users:/, '') : userId;
  const userRecord = new RecordId('users', userRef);
  const [conv] = await db.create('conversations', { 
    user: userRecord, 
    messages: [], 
    messages_raw: JSON.stringify([]), 
    title: title ?? 'Чат',
    document_content: "",
    ...(folderId ? { folder: folderRecord(folderId) } : {}),
  });
  return {
    id: conv.id.toString(),
    user: String((conv as any).user),
    messages: repairMessagesForApi((conv as any).messages ?? []),
    messages_raw: String((conv as any).messages_raw ?? JSON.stringify([])),
    created: String((conv as any).created),
    title: String((conv as any).title ?? title ?? 'Чат'),
    folderId: folderIdOf(conv),
    document_content:
      typeof (conv as any).document_content === 'string' ? (conv as any).document_content : '',
  };
}

export async function getConversations(userId: string): Promise<Conversation[]> {
  await connectDB();
  const userRef = userId.startsWith('users:') ? userId : `users:${userId}`;
  const userClean = userRef.replace(/^users:/, '');
  const userRecord = new RecordId('users', userClean);
  // Query by passing the user as a record id so Surreal can match the record field correctly
  const result = (await db.query(`SELECT * FROM conversations WHERE user = $user ORDER BY created DESC;`, { user: userRecord })) as [any[]];

  const records = (result?.[0] ?? []);
  return records.map((r: any) => {
    const messages = resolveMessagesFromRecord(r.messages, r.messages_raw);

    return {
      id: r.id.toString(),
      user: String((r.user as any)?.toString?.() ?? r.user),
      messages: repairMessagesForApi(messages),
      messages_raw: typeof r.messages_raw === 'string' ? r.messages_raw : String(r.messages_raw ?? ''),
      created: String(r.created),
      title: typeof r.title === 'string' && r.title.trim() ? r.title : 'Чат',
      folderId: folderIdOf(r),
      document_content: typeof r.document_content === 'string' ? r.document_content : '',
    };
  });
}

// Получить промпт по id
export async function getPromptById(id: string): Promise<Prompt | null> {
  const record = await getPromptRecord(id);
  if (!record) return null;
  return convertToPrompt(record.data);
}

// Создать промпт
export async function createPrompt(title: string, content: string, userId?: string): Promise<Prompt> {
  await connectDB();

  if (userId) {
    return createPromptForUser(userId, title, content);
  }

  // Ensure there is a system user to own global prompts (avoid NULL owner errors)
  let ownerRef: any = undefined;
  try {
    let sys = await getUserByUsername('__system__');
    if (!sys) {
      const hash = crypto.createHash('sha256').update('__system__').digest('hex');
      sys = await createUser('__system__', hash);
    }
    const ownerIdClean = sys.id.replace(/^users:/, '');
    ownerRef = new RecordId('users', ownerIdClean);
  } catch (e) {
    // If anything fails, we'll omit owner (best-effort)
    ownerRef = undefined;
  }

  if (ownerRef) {
    const [prompt] = await db.create('prompts', { title, content, isDefault: false, owner: ownerRef });
    return convertToPrompt(prompt);
  }

  const [prompt] = await db.create('prompts', { title, content, isDefault: false });
  return convertToPrompt(prompt);
}

// Обновить промпт
export async function updatePromptById(
  id: string,
  title: string,
  content: string,
  userId?: string,
): Promise<Prompt> {
  const record = await getPromptRecord(id);
  if (!record) {
    throw new Error("Prompt not found");
  }

  const promptData = record.data;

  if (promptData.isDefault) {
    throw new Error("Cannot edit default prompt");
  }

  if (userId) {
    const normalizedUser = normalizeUserId(userId);
    const ownerRef = toRecordString(promptData.owner);
    if (ownerRef && ownerRef !== normalizedUser) {
      throw new Error("Access denied");
    }
  }

  const result = await db.query(
    `UPDATE ${record.recordId} SET title = $title, content = $content, updated = time::now() RETURN AFTER;`,
    { title, content }
  );

  const updatedRecords = (result as any)[0]?.result ?? [];
  if (!updatedRecords.length) {
    throw new Error("Failed to update prompt");
  }

  return convertToPrompt(updatedRecords[0]);
}


// Удалить промпт
export async function deletePromptById(id: string, userId?: string): Promise<void> {
  const record = await getPromptRecord(id);
  if (!record) {
    throw new Error("Prompt not found");
  }

  const promptData = record.data;

  if (promptData.isDefault) {
    throw new Error("Cannot delete default prompt");
  }

  if (userId) {
    const normalizedUser = normalizeUserId(userId);
    const ownerRef = toRecordString(promptData.owner);
    if (ownerRef && ownerRef !== normalizedUser) {
      throw new Error("Access denied");
    }
  }

  await db.delete(record.recordId);
  console.log("✅ Prompt deleted:", record.recordId.toString());
}

export async function getUserSelectedPrompt(userId: string): Promise<string | null> {
  await connectDB();
  const normalizedUser = normalizeUserId(userId);
  const cleanUser = normalizedUser.replace(/^users:/, '');
  const userRecord = new RecordId('users', cleanUser);
  const userData = await db.select(userRecord).catch(() => undefined);
  const data = Array.isArray(userData) ? userData[0] : userData;
  if (!data) return null;
  return toRecordString(data.selectedPrompt);
}

export async function setUserSelectedPrompt(userId: string, promptId: string): Promise<void> {
  await connectDB();
  const prompt = await getPromptById(promptId);
  if (!prompt) {
    throw new Error('Prompt not found');
  }

  if (!prompt.isDefault) {
    const normalizedUser = normalizeUserId(userId);
    if (!prompt.ownerId || prompt.ownerId !== normalizedUser) {
      throw new Error('Access denied');
    }
  }

  const normalizedUser = normalizeUserId(userId);
  const cleanUser = normalizedUser.replace(/^users:/, '');
  const userRecord = new RecordId('users', cleanUser);
  const promptRecord = promptRecordId(prompt.id);

  await db.merge(userRecord, { selectedPrompt: promptRecord });
}

export async function saveProtocolExample(content: string): Promise<ProtocolExample> {
  await connectDB();
  const trimmed = String(content || '').trim();
  const [rec] = await db.create('protocol_examples', { content: trimmed });
  return {
    id: rec.id.toString(),
    content: String((rec as any).content ?? trimmed),
    created: String((rec as any).created ?? new Date().toISOString()),
  };
}

// ВНИМАНИЕ: таблица protocol_examples сейчас ТОЛЬКО пишется.
// Читателя (getRecentProtocolExamples) удалили — он не вызывался ниоткуда.
// Запись идёт из DocumentPanel через POST /api/protocol-examples, причём без
// авторизации и без ограничения объёма: таблица растёт, данные никто не
// использует. Либо появляется потребитель, либо роут стоит убрать вместе с
// saveProtocolExample.

export async function upsertProtocolInstruction(
  conversationId: string,
  content: string,
  openQuestions: string[] = []
): Promise<ProtocolInstruction | null> {
  await connectDB();
  const clean = conversationId.replace(/^conversations:/, '');
  const recordId = new RecordId('protocol_instructions', clean);
  const convRecord = new RecordId('conversations', clean);

  const payload = {
    conversation: convRecord,
    content: String(content || '').trim(),
    openQuestions: Array.isArray(openQuestions) ? openQuestions : [],
  };

  await db.merge(recordId, payload).catch(() => undefined);
  const rec = await db.select(recordId).catch(() => undefined) as any;
  const row = Array.isArray(rec) ? rec[0] : rec;
  if (!row) return null;

  return {
    id: row.id.toString(),
    conversationId: String((row as any).conversation ?? ''),
    content: String((row as any).content ?? ''),
    openQuestions: Array.isArray((row as any).openQuestions) ? (row as any).openQuestions : [],
    updated: String((row as any).updated ?? ''),
  };
}

export async function getProtocolInstruction(conversationId: string): Promise<ProtocolInstruction | null> {
  await connectDB();
  const clean = conversationId.replace(/^conversations:/, '');
  const recordId = new RecordId('protocol_instructions', clean);
  const rec = await db.select(recordId).catch(() => undefined) as any;
  const row = Array.isArray(rec) ? rec[0] : rec;
  if (!row) return null;
  return {
    id: row.id.toString(),
    conversationId: String((row as any).conversation ?? ''),
    content: String((row as any).content ?? ''),
    openQuestions: Array.isArray((row as any).openQuestions) ? (row as any).openQuestions : [],
    updated: String((row as any).updated ?? ''),
  };
}


// Получить дефолтный промпт
export async function getPrompt(): Promise<string> {
  // ВСЕГДА возвращаем промпт из файла (SGR_MAIN_AGENT_PROMPT), не из БД
  // БД больше не используется для хранения промптов
  return SGR_MAIN_AGENT_PROMPT;
}

// Обновить дефолтный промпт
export async function updatePrompt(content: string): Promise<void> {
  await connectDB();
  const result = (await db.query(`SELECT * FROM prompts WHERE isDefault = true LIMIT 1;`)) as [any[]];
  const records = result?.[0] ?? [];
  const record = records[0];

  if (record) {
    await db.merge(record.id.toString(), { content });
  } else {
    await db.create("prompts", {
      title: "Default Assistant",
      content,
      isDefault: true,
    });
  }
}

// ===== Анонимизация: канонический mapping диалога (placeholder -> оригинал) =====

/**
 * Соответствия «плейсхолдер → оригинал» диалога, оставшиеся от удалённого
 * облачного режима. Нужны только чтобы восстановить имена в старых протоколах
 * (lib/legacy-placeholders.ts). Новых записей не появляется.
 */
export type StoredConversationMapping = { mapping: Record<string, string> };

export async function getConversationMapping(
  conversationId: string,
): Promise<StoredConversationMapping> {
  await connectDB();
  const clean = String(conversationId).replace(/^anonymization_mappings:/, '').replace(/^conversations:/, '');
  try {
    const rec = await db.select(new RecordId('anonymization_mappings', clean));
    const row: any = Array.isArray(rec) ? rec[0] : rec;
    if (row?.mapping && typeof row.mapping === 'object') return { mapping: row.mapping };
  } catch (e) {
    console.warn('getConversationMapping failed:', (e as Error)?.message);
  }
  return { mapping: {} };
}

/**
 * Сохранить последний валидный Protocol JSON диалога (с реальными данными).
 * Нужен для точечных правок: без базового объекта единственный вариант —
 * пересобирать весь протокол заново, что переписывает и незатронутые места.
 *
 * Хранится в таблице anonymization_mappings (SCHEMALESS, per-conversation
 * side-storage), а не в conversations: у последней в облачной БД сохранилось
 * legacy-ограничение на обязательное поле document_content TYPE string,
 * из-за которого upsert/merge новой записи только с document_json падает
 * либо молча ничего не пишет.
 */
export async function saveConversationProtocolJson(
  conversationId: string,
  protocol: unknown,
): Promise<void> {
  await connectDB();
  const clean = String(conversationId).replace(/^anonymization_mappings:/, '').replace(/^conversations:/, '');
  const rid = new RecordId('anonymization_mappings', clean);
  let payload: string;
  try {
    payload = JSON.stringify(protocol);
  } catch {
    return;
  }
  try {
    await db.upsert(rid, { document_json: payload } as any);
  } catch (e) {
    // Фолбек на merge, если upsert недоступен в этой версии SDK.
    try {
      await db.merge(rid, { document_json: payload } as any);
    } catch (ee) {
      console.warn('saveConversationProtocolJson failed:', (ee as Error)?.message);
    }
  }
}

/** Прочитать последний Protocol JSON диалога. null — если его ещё нет. */
export async function getConversationProtocolJson(
  conversationId: string,
): Promise<unknown | null> {
  await connectDB();
  const clean = String(conversationId).replace(/^anonymization_mappings:/, '').replace(/^conversations:/, '');
  try {
    const rec = await db.select(new RecordId('anonymization_mappings', clean));
    const row: any = Array.isArray(rec) ? rec[0] : rec;
    const raw = row?.document_json;
    if (typeof raw === 'string' && raw.trim()) return JSON.parse(raw);
    if (raw && typeof raw === 'object') return raw;
  } catch (e) {
    console.warn('getConversationProtocolJson failed:', (e as Error)?.message);
  }
  return null;
}

// ===== Администрирование пользователей и папки =====
// Спека: docs/superpowers/specs/2026-10-02-admin-and-folders-design.md

function cleanId(id: string, table: string): string {
  return String(id ?? '').trim().replace(new RegExp(`^${table}:`), '');
}

function userRecord(userId: string): RecordId {
  return new RecordId('users', cleanId(userId, 'users'));
}

function folderRecord(folderId: string): RecordId {
  return new RecordId('folders', cleanId(folderId, 'folders'));
}

function folderIdOf(rec: unknown): string | null {
  const f = (rec as { folder?: unknown } | null | undefined)?.folder;
  if (!f) return null;
  return toRecordString(f);
}

/** Пользователь по id — для проверки сессии на каждом запросе. */
export async function getUserById(userId: string): Promise<User | null> {
  await connectDB();
  if (!cleanId(userId, 'users')) return null;
  const raw = await db.select(userRecord(userId));
  const rec = Array.isArray(raw) ? raw[0] : raw;
  if (!rec) return null;
  return userFromRecord(rec as Record<string, unknown>);
}

export async function touchUserLastLogin(userId: string): Promise<void> {
  await connectDB();
  try {
    await db.query('UPDATE $u SET lastLogin = time::now();', { u: userRecord(userId) });
  } catch (e) {
    console.warn('touchUserLastLogin failed:', (e as Error)?.message);
  }
}

export type AdminUserRow = User & {
  /** Роль задана ADMIN_USERNAMES — в интерфейсе её не изменить. */
  roleFromEnv: boolean;
  conversationsCount: number;
  lastLogin: string | null;
  lastChatActivity: string | null;
};

export async function listUsersForAdmin(): Promise<AdminUserRow[]> {
  await connectDB();
  const users = surrealQueryRows(await db.query('SELECT * FROM users ORDER BY created ASC;'));
  // Агрегируем в коде: тянем только три поля, без сообщений и документов.
  const convRows = surrealQueryRows(await db.query('SELECT user, created, updated FROM conversations;'));
  const byUser = new Map<string, { n: number; last: string | null; lastMs: number }>();
  for (const row of convRows) {
    const key = toRecordString((row as any).user);
    if (!key) continue;
    const stamp = (row as any).updated ?? (row as any).created;
    const ms = stamp ? new Date(String(stamp)).getTime() : Number.NaN;
    const prev = byUser.get(key) ?? { n: 0, last: null, lastMs: -Infinity };
    prev.n += 1;
    if (Number.isFinite(ms) && ms > prev.lastMs) {
      prev.lastMs = ms;
      prev.last = new Date(ms).toISOString();
    }
    byUser.set(key, prev);
  }
  const envAdmins = envAdminUsernames();
  return users.map((rec) => {
    const user = userFromRecord(rec);
    const st = byUser.get(user.id);
    return {
      ...user,
      roleFromEnv: envAdmins.has(usernameLookupKey(user.username)),
      conversationsCount: st?.n ?? 0,
      lastLogin: (rec as any).lastLogin ? String((rec as any).lastLogin) : null,
      lastChatActivity: st?.last ?? null,
    };
  });
}

export async function updateUserByAdmin(
  userId: string,
  patch: { role?: Role; blocked?: boolean; passwordHash?: string },
): Promise<User | null> {
  await connectDB();
  const data: Record<string, unknown> = {};
  if (patch.role) data.role = patch.role;
  if (typeof patch.blocked === 'boolean') data.blocked = patch.blocked;
  if (patch.passwordHash) data.passwordHash = patch.passwordHash;
  if (Object.keys(data).length > 0) {
    await db.merge(userRecord(userId), data as any);
  }
  return getUserById(userId);
}

/**
 * Удалить пользователя вместе со всем, что ему принадлежит. Чаты содержат
 * расшифровки с ПДн, mapping анонимизации — настоящие ФИО: оставлять их
 * «сиротами» после удаления учётки нельзя.
 */
export async function deleteUserCascade(userId: string): Promise<void> {
  await connectDB();
  const u = userRecord(userId);
  const convIds = surrealQueryRows(await db.query('SELECT id FROM conversations WHERE user = $u;', { u }))
    .map((row) => toRecordString((row as any).id))
    .filter((id): id is string => Boolean(id));

  // mapping анонимизации хранится под тем же id, что и диалог.
  for (const convId of convIds) {
    await db.delete(new RecordId('anonymization_mappings', cleanId(convId, 'conversations')));
  }
  if (convIds.length > 0) {
    await db.query('DELETE protocol_instructions WHERE conversation IN $convs;', {
      convs: convIds.map((id) => new RecordId('conversations', cleanId(id, 'conversations'))),
    });
  }
  await db.query(
    `DELETE conversations WHERE user = $u;
     DELETE prompts WHERE owner = $u;
     DELETE folders WHERE kind = 'personal' AND owner = $u;`,
    { u },
  );
  // Убираем из участников общих папок, иначе там останутся ссылки в никуда.
  const me = normalizeUserRef(userId);
  const shared = surrealQueryRows(await db.query("SELECT * FROM folders WHERE kind = 'shared';"))
    .map(folderFromRecord)
    .filter((f) => f.memberIds.some((m) => normalizeUserRef(m) === me));
  for (const f of shared) {
    await writeFolderMembers(f.id, f.memberIds.filter((m) => normalizeUserRef(m) !== me));
  }
  await db.delete(u);
}

export type Folder = {
  id: string;
  name: string;
  kind: FolderKind;
  ownerId: string | null;
  /** Участники общей папки (`users:…`). */
  memberIds: string[];
  instructions: string;
  created: string;
  updated: string;
};

function folderFromRecord(rec: Record<string, unknown>): Folder {
  const members = Array.isArray(rec.members) ? rec.members : [];
  return {
    id: toRecordString(rec.id) ?? String(rec.id),
    name: String(rec.name ?? ''),
    kind: rec.kind === 'personal' ? 'personal' : 'shared',
    ownerId: toRecordString(rec.owner),
    memberIds: members.map((m) => toRecordString(m)).filter((m): m is string => Boolean(m)),
    instructions: typeof rec.instructions === 'string' ? rec.instructions : '',
    created: String(rec.created ?? ''),
    updated: String(rec.updated ?? ''),
  };
}

export async function getFolder(folderId: string): Promise<Folder | null> {
  await connectDB();
  if (!cleanId(folderId, 'folders')) return null;
  const raw = await db.select(folderRecord(folderId));
  const rec = Array.isArray(raw) ? raw[0] : raw;
  return rec ? folderFromRecord(rec as Record<string, unknown>) : null;
}

/**
 * Все общие папки + личные папки пользователя. Кому что показывать (участник
 * или нет) решает вызывающий через lib/access.ts — общих папок немного, а
 * фильтр в коде не зависит от того, как SurrealDB сравнивает массив с NONE.
 */
export async function listFoldersForUser(userId: string): Promise<Folder[]> {
  await connectDB();
  const rows = surrealQueryRows(
    await db.query(
      `SELECT * FROM folders
       WHERE kind = 'shared' OR (kind = 'personal' AND owner = $u)
       ORDER BY name ASC;`,
      { u: userRecord(userId) },
    ),
  );
  return rows.map(folderFromRecord);
}

export async function createFolder(input: {
  name: string;
  kind: FolderKind;
  ownerId?: string | null;
  /** Первые участники общей папки — обычно создавший её админ. */
  memberIds?: string[];
  instructions?: string;
}): Promise<Folder> {
  await connectDB();
  const created = await db.create('folders', {
    name: input.name,
    kind: input.kind,
    instructions: input.instructions ?? '',
    ...(input.kind === 'personal' && input.ownerId ? { owner: userRecord(input.ownerId) } : {}),
    ...(input.kind === 'shared' ? { members: (input.memberIds ?? []).map(userRecord) } : {}),
  } as any);
  const rec = Array.isArray(created) ? created[0] : created;
  return folderFromRecord(rec as Record<string, unknown>);
}

export async function updateFolder(
  folderId: string,
  patch: { name?: string; instructions?: string },
): Promise<Folder | null> {
  await connectDB();
  const data: Record<string, unknown> = {};
  if (typeof patch.name === 'string') data.name = patch.name;
  if (typeof patch.instructions === 'string') data.instructions = patch.instructions;
  if (Object.keys(data).length > 0) {
    await db.merge(folderRecord(folderId), data as any);
  }
  return getFolder(folderId);
}

/** Удалить папку. Чаты не трогаем — они уходят в «Без папки». */
export async function deleteFolder(folderId: string): Promise<void> {
  await connectDB();
  const f = folderRecord(folderId);
  await db.query('UPDATE conversations UNSET folder WHERE folder = $f; DELETE $f;', { f });
}

export async function getConversationFolderId(conversationId: string): Promise<string | null> {
  if (!conversationId || conversationId.startsWith('local-')) return null;
  await connectDB();
  const raw = await db.select(new RecordId('conversations', cleanId(conversationId, 'conversations')));
  const rec = Array.isArray(raw) ? raw[0] : raw;
  return folderIdOf(rec);
}

export async function setConversationFolder(conversationId: string, folderId: string | null): Promise<void> {
  await connectDB();
  const c = new RecordId('conversations', cleanId(conversationId, 'conversations'));
  if (folderId) {
    await db.query('UPDATE $c SET folder = $f;', { c, f: folderRecord(folderId) });
  } else {
    await db.query('UPDATE $c UNSET folder;', { c });
  }
}

async function writeFolderMembers(folderId: string, memberIds: string[]): Promise<void> {
  // Без дублей, в виде record id — поле типизировано как array<record<users>>.
  const unique = [...new Set(memberIds.map(normalizeUserRef))];
  await db.merge(folderRecord(folderId), { members: unique.map(userRecord) } as any);
}

/** Добавить участника общей папки. Повторное добавление ничего не меняет. */
export async function addFolderMember(folderId: string, userId: string): Promise<Folder | null> {
  await connectDB();
  const folder = await getFolder(folderId);
  if (!folder) return null;
  if (!folder.memberIds.some((m) => normalizeUserRef(m) === normalizeUserRef(userId))) {
    await writeFolderMembers(folder.id, [...folder.memberIds, userId]);
  }
  return getFolder(folderId);
}

/**
 * Убрать участника. Его чаты из этой папки переезжают в «Без папки»: доступа к
 * папке у него больше нет, а прятать собственные чаты человека нельзя.
 */
export async function removeFolderMember(folderId: string, userId: string): Promise<Folder | null> {
  await connectDB();
  const folder = await getFolder(folderId);
  if (!folder) return null;
  const me = normalizeUserRef(userId);
  await writeFolderMembers(
    folder.id,
    folder.memberIds.filter((m) => normalizeUserRef(m) !== me),
  );
  await db.query('UPDATE conversations UNSET folder WHERE folder = $f AND user = $u;', {
    f: folderRecord(folder.id),
    u: userRecord(userId),
  });
  return getFolder(folderId);
}

/** Участники папки: id и логин. Нет записи пользователя — пропускаем. */
export async function listFolderMembers(folderId: string): Promise<Array<{ id: string; username: string }>> {
  await connectDB();
  const folder = await getFolder(folderId);
  if (!folder) return [];
  const out: Array<{ id: string; username: string }> = [];
  for (const id of folder.memberIds) {
    const user = await getUserById(id);
    if (user) out.push({ id: user.id, username: user.username });
  }
  return out.sort((a, b) => a.username.localeCompare(b.username, 'ru'));
}

/** Завести приглашённого пользователя: только логин, пароль он придумает сам. */
export async function createInvitedUser(username: string, role: Role = 'user'): Promise<User> {
  await connectDB();
  const displayName = normalizeUsername(username);
  const usernameLower = usernameLookupKey(username);
  if (!displayName || !usernameLower) throw new Error('username required');
  const rows = surrealQueryRows(
    await db.query(
      `CREATE users SET username = $username, usernameLower = $usernameLower,
         passwordHash = '', role = $role, blocked = false, invitedAt = time::now();`,
      { username: displayName, usernameLower, role },
    ),
  );
  if (!rows[0]) throw new Error('Failed to create user record');
  const user = userFromRecord(rows[0]);
  console.log(`[auth] приглашён пользователь ${user.username} (${user.role})`);
  return user;
}

/**
 * Первый вход: сохранить придуманный пароль. Условие `passwordHash = ''` в
 * самом UPDATE делает это атомарным — если двое придумывают пароль
 * одновременно, выиграет один, второй получит false.
 */
export async function claimInvitedUser(userId: string, passwordHash: string): Promise<boolean> {
  await connectDB();
  const rows = surrealQueryRows(
    await db.query(
      `UPDATE $u SET passwordHash = $hash, invitedAt = NONE
       WHERE (passwordHash = '' OR passwordHash IS NONE) AND blocked != true;`,
      { u: userRecord(userId), hash: passwordHash },
    ),
  );
  return rows.length > 0;
}

/** Сброс пароля админом: пользователь снова придумает его при входе. */
export async function resetUserPassword(userId: string): Promise<User | null> {
  await connectDB();
  await db.query("UPDATE $u SET passwordHash = '', invitedAt = time::now();", { u: userRecord(userId) });
  return getUserById(userId);
}
