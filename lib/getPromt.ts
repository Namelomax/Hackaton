import Surreal, { u } from "surrealdb";
import { RecordId } from "surrealdb";
import crypto from 'crypto';
import { DEFAULT_PROMPT } from '@/lib/db/repositories/default-promt';

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

  await db.connect(
    "wss://wild-mountain-06cupioiq9vpbadmqsbcb609a8.aws-euw1.surreal.cloud/rpc",
    {
      namespace: process.env.SURREAL_NAMESPACE,
      database: process.env.SURREAL_DATABASE,
      auth: {
        username: String(process.env.SURREAL_USER),
        password: String(process.env.SURREAL_PASS),
      },
    }
  );

  surrealState.isConnected = true;
  if (!surrealState.logged && process.env.SURREAL_LOG === '1') {
    surrealState.logged = true;
    console.log("✅ Connected to SurrealDB");
  }

  try {
    await db.query(`
      DEFINE TABLE users SCHEMAFULL;
      DEFINE FIELD username ON users TYPE string;
      DEFINE FIELD passwordHash ON users TYPE string;
      DEFINE FIELD created ON users TYPE datetime DEFAULT time::now() READONLY;
      DEFINE FIELD selectedPrompt ON users TYPE option<record<prompts>>;

      DEFINE TABLE prompts SCHEMAFULL;
      DEFINE FIELD title ON prompts TYPE string;
      DEFINE FIELD content ON prompts TYPE string;
      DEFINE FIELD isDefault ON prompts TYPE bool DEFAULT false;
      DEFINE FIELD owner ON prompts TYPE option<record<users>>;
      DEFINE FIELD created ON prompts TYPE datetime DEFAULT time::now() READONLY;
      DEFINE FIELD updated ON prompts TYPE datetime VALUE time::now();

DEFINE TABLE conversations SCHEMAFULL;

-- ссылка на пользователей
DEFINE FIELD user ON conversations TYPE record<users>;

-- массив объектов — разрешено!
DEFINE FIELD messages ON conversations TYPE array<object> DEFAULT [];

-- сохраняем "сырые" сообщения для fallback
DEFINE FIELD messages_raw ON conversations TYPE string;

-- заголовок (опционально)
DEFINE FIELD title ON conversations TYPE string;

-- контент документа (опционально)
DEFINE FIELD document_content ON conversations TYPE option<string>;

DEFINE FIELD created ON conversations TYPE datetime DEFAULT time::now() READONLY;

    `);
  } catch (error: any) {
    if (!error.message.includes("already exists")) {
      console.error("Error defining schema:", error);
    }
  }
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
};

export type Conversation = {
  id: string;
  user: string;
  messages: any;
  created: string;
  title?: string;
  messages_raw?: string;
  document_content?: string;
};

function sanitizeMessagePart(part: any): any {
  if (!part || typeof part !== 'object') return part;
  const type = String((part as any).type ?? '');

  if (type === 'text') {
    return { type: 'text', text: typeof (part as any).text === 'string' ? (part as any).text : '' };
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

function sanitizeMessage(message: any): any {
  const id =
    message?.id ||
    (typeof crypto !== 'undefined' && (crypto as any).randomUUID
      ? (crypto as any).randomUUID()
      : String(Date.now()));

  const parts = Array.isArray(message?.parts)
    ? message.parts.map(sanitizeMessagePart)
    : [];

  const text =
    message?.content ||
    (Array.isArray(message?.parts)
      ? message.parts.find((p: any) => p?.type === 'text')?.text
      : '') ||
    '';

  const metadata = message?.metadata && typeof message.metadata === 'object' ? message.metadata : {};

  return {
    id,
    role: message?.role || 'user',
    text,
    parts,
    metadata,
  };
}

// Create a new user
export async function createUser(username: string, passwordHash: string): Promise<User> {
  await connectDB();
  const [user] = await db.create('users', { username, passwordHash });
  return {
    id: user.id.toString(),
    username: String((user as any).username),
    created: String((user as any).created),
  };
}

export async function getUserByUsername(username: string): Promise<User | null> {
  await connectDB();
  const result = (await db.query(`SELECT * FROM users WHERE username = $username LIMIT 1;`, { username })) as [any[]];
  const rec = (result?.[0] ?? [])[0];
  if (!rec) return null;
  return {
    id: rec.id.toString(),
    username: String((rec as any).username),
    created: String((rec as any).created),
  };
}

export async function authenticateUser(username: string, passwordHash: string): Promise<User | null> {
  await connectDB();
  const result = (await db.query(`SELECT * FROM users WHERE username = $username AND passwordHash = $passwordHash LIMIT 1;`, { username, passwordHash })) as [any[]];
  const rec = (result?.[0] ?? [])[0];
  if (!rec) return null;
  return {
    id: rec.id.toString(),
    username: String((rec as any).username),
    created: String((rec as any).created),
  };
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
export async function saveConversation(userId: string, messages: any, documentContent?: string): Promise<Conversation> {
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
    document_content: documentContent || ""
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
      messages: sanitizedClean,
      created: (conv as any)?.created ?? new Date().toISOString(),
    };
    return fallback as Conversation;
  }

  return {
    id: storedConv.id.toString(),
    user: String((storedConv as any).user),
    messages: storedConv.messages,
    messages_raw: (storedConv as any).messages_raw,
    created: String((storedConv as any).created),
    document_content: (storedConv as any).document_content,
  };
}

// Update existing conversation by id
export async function updateConversation(conversationId: string, messages: any, documentContent?: string): Promise<Conversation> {
  await connectDB();
  const clean = conversationId.replace(/^conversations:/, '');
  const recordObj = new RecordId('conversations', clean);
  const recordIdString = `conversations:${clean}`;

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
      messages: sanitizedClean,
      messages_raw: JSON.stringify(sanitizedClean),
      created: new Date().toISOString(),
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

  // If messages empty but messages_raw exists, try to parse it
  let storedMessages: any = convData?.messages;
  if ((!Array.isArray(storedMessages) || storedMessages.length === 0) && convData?.messages_raw) {
    try {
      const parsed = JSON.parse(String(convData.messages_raw));
      if (Array.isArray(parsed)) storedMessages = parsed;
    } catch (e) {
      // ignore parse errors
    }
  }

  return {
    id: convData.id?.toString?.() ?? recordIdString,
    user: String((convData as any).user ?? ''),
    messages: storedMessages ?? sanitizedClean,
    messages_raw: String((convData as any).messages_raw ?? JSON.stringify(sanitizedClean)),
    created: String((convData as any).created ?? new Date().toISOString()),
    document_content: (convData as any).document_content,
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

  let messages = convData.messages;
  if ((!Array.isArray(messages) || messages.length === 0) && convData.messages_raw) {
    try {
      const parsed = JSON.parse(String(convData.messages_raw));
      if (Array.isArray(parsed)) messages = parsed;
    } catch (e) {
      /* ignore */
    }
  }

  return {
    id: convData.id?.toString?.() ?? `conversations:${clean}`,
    user: String((convData as any).user ?? ''),
    messages: messages ?? [],
    messages_raw: String((convData as any).messages_raw ?? ''),
    created: String((convData as any).created ?? new Date().toISOString()),
    title: trimmedTitle,
    document_content: (convData as any).document_content,
  };
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
      throw new Error('Forbidden');
    }
  }

  await db.delete(convRecord);
}

// Create a new empty conversation for a user (returns created conversation)
export async function createConversation(userId: string, title?: string): Promise<Conversation> {
  await connectDB();
  const userRef = userId.startsWith('users:') ? userId.replace(/^users:/, '') : userId;
  const userRecord = new RecordId('users', userRef);
  const [conv] = await db.create('conversations', { 
    user: userRecord, 
    messages: [], 
    messages_raw: JSON.stringify([]), 
    title: title ?? 'New conversation',
    document_content: "" 
  });
  return {
    id: conv.id.toString(),
    user: String((conv as any).user),
    messages: (conv as any).messages,
    messages_raw: (conv as any).messages_raw,
    created: String((conv as any).created),
    document_content: (conv as any).document_content,
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
    let messages = r.messages;
    // If messages array is empty but we stored messages_raw fallback, try to parse it
    if ((!Array.isArray(messages) || messages.length === 0) && r.messages_raw) {
      try {
        const parsed = JSON.parse(r.messages_raw);
        if (Array.isArray(parsed)) messages = parsed;
      } catch (e) {
        // ignore parse errors
      }
    }

    return {
      id: r.id.toString(),
      user: String((r.user as any)?.toString?.() ?? r.user),
      messages: messages,
      messages_raw: r.messages_raw,
      created: String(r.created),
      title: r.title ?? '',
      document_content: r.document_content,
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


// Получить дефолтный промпт
export async function getPrompt(): Promise<string> {
  await connectDB();
  const result = (await db.query(`SELECT * FROM prompts WHERE isDefault = true LIMIT 1;`)) as [any[]];
  const records = result?.[0] ?? [];
  const record = records[0];

  if (!record) {
    const [newPrompt] = await db.create("prompts", {
      title: "Default Assistant",
      content: DEFAULT_PROMPT,
      isDefault: true,
    });
    return convertToPrompt(newPrompt).content;
  }
  return record.content || DEFAULT_PROMPT;
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
