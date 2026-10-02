import { createConversation, deleteConversation, getConversations, renameConversation, saveConversation, updateConversation, getConversationMapping, assertConversationOwnership, ForbiddenError, setConversationFolder } from '@/lib/getPromt';
import { deanonymize } from '@/lib/anonymization';
import { requireUser } from '@/lib/auth-guard';
import { visibleFolderOrResponse } from '@/lib/folder-guard';

const PLACEHOLDER_RX = /\[(?:PERSON|ORG|DATE|SENSITIVE|FILE|EMAIL|PHONE)_\d+\]/;

/**
 * Страховка: в сохранённом документе плейсхолдеров быть не должно.
 *
 * Панель получает текст через SSE, и если хоть один тип события пройдёт мимо
 * деанонимизатора (так было с новыми data-documentSet/data-documentEdits),
 * клиент сохранит в БД текст с `[PERSON_3]`, и пользователь увидит его снова
 * после перезагрузки. Подстановка тут детерминированная, по сохранённому
 * mapping диалога — без всякой модели.
 */
async function restoreRealData(conversationId: string, text: string): Promise<string> {
  if (!text || !PLACEHOLDER_RX.test(text)) return text;
  try {
    const stored = await getConversationMapping(conversationId);
    const mapping = stored?.mapping ?? {};
    if (Object.keys(mapping).length === 0) return text;
    const restored = deanonymize(text, mapping);
    console.warn(
      `[conversations] в документе диалога ${conversationId} были плейсхолдеры — подставлены оригиналы`,
    );
    return restored;
  } catch (e) {
    console.warn('[conversations] деанонимизация документа не удалась:', (e as Error)?.message);
    return text;
  }
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    // Личность — только из подписанной сессии, с проверкой блокировки по БД.
    // 401, а не 400: у клиента нет сессии, и он должен это понять — показать
    // форму входа, а не пустой список диалогов при виде «вы вошли как …».
    const user = await requireUser(req, url.searchParams.get('userId'));
    if (user instanceof Response) return user;
    const userId = user.id;
    const convs = await getConversations(userId);
    // Чиним уже испорченные записи на чтении: документ мог сохраниться с
    // плейсхолдерами до фикса деанонимизации SSE.
    const cleaned = await Promise.all(
      (convs ?? []).map(async (c: any) => {
        const doc = typeof c?.document_content === 'string' ? c.document_content : '';
        if (!doc || !PLACEHOLDER_RX.test(doc)) return c;
        return { ...c, document_content: await restoreRealData(String(c.id), doc) };
      }),
    );
    return new Response(JSON.stringify({ success: true, conversations: cleaned }), { status: 200 });
  } catch (err) {
    console.error('Conversations GET error', err);
    return new Response(JSON.stringify({ success: false }), { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const { userId: claimedUserId, title, messages, folderId: rawFolderId } = body as any;
    const user = await requireUser(req, claimedUserId);
    if (user instanceof Response) return user;
    const userId = user.id;

    // Чат можно создать только в папке, которую пользователь видит.
    let folderId: string | null = null;
    if (typeof rawFolderId === 'string' && rawFolderId.trim()) {
      const folder = await visibleFolderOrResponse(user, rawFolderId);
      if (folder instanceof Response) return folder;
      folderId = folder.id;
    }

    // If client provided messages, create the conversation with those messages attached.
    if (Array.isArray(messages) && messages.length > 0) {
      const conv = await saveConversation(userId, messages, undefined, folderId);
      return new Response(JSON.stringify({ success: true, conversation: conv }), { status: 201 });
    }

    const conv = await createConversation(userId, title, folderId);
    return new Response(JSON.stringify({ success: true, conversation: conv }), { status: 201 });
  } catch (err: any) {
    console.error('Conversations POST error', err);
    return new Response(JSON.stringify({ success: false, message: err?.message || 'error' }), { status: 500 });
  }
}

export async function PUT(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const { conversationId, messages, title, documentContent, userId: claimedUserId } = body as any;
    const user = await requireUser(req, claimedUserId);
    if (user instanceof Response) return user;
    const userId = user.id;
    if (!conversationId) return new Response(JSON.stringify({ success: false, message: 'conversationId required' }), { status: 400 });

    // ИЗОЛЯЦИЯ: нельзя писать в чужой диалог.
    try {
      await assertConversationOwnership(conversationId, userId);
    } catch (e) {
      if (e instanceof ForbiddenError) {
        return new Response(JSON.stringify({ success: false, message: 'Forbidden' }), { status: 403 });
      }
      // Проверить не удалось — не пишем. Иначе при сбое БД можно было записать
      // сообщения в чужой диалог.
      console.error('ownership check failed:', e);
      return new Response(
        JSON.stringify({ success: false, message: 'Проверка доступа временно недоступна' }),
        { status: 503 },
      );
    }
    const hasMessages = Array.isArray(messages);
    const hasTitle = typeof title === 'string' && title.trim().length > 0;
    const hasDocument = typeof documentContent === 'string';
    // folderId: строка — перенести в папку, null — убрать из папки.
    const hasFolder = body !== null && typeof body === 'object' && 'folderId' in body;

    if (!hasMessages && !hasTitle && !hasDocument && !hasFolder) {
      return new Response(JSON.stringify({ success: false, message: 'messages, title, documentContent or folderId required' }), { status: 400 });
    }

    let updated = null;

    if (hasFolder) {
      const rawFolderId = (body as any).folderId;
      if (rawFolderId === null || rawFolderId === '') {
        await setConversationFolder(conversationId, null);
      } else {
        const folder = await visibleFolderOrResponse(user, rawFolderId);
        if (folder instanceof Response) return folder;
        await setConversationFolder(conversationId, folder.id);
      }
      if (!hasMessages && !hasTitle && !hasDocument) {
        return new Response(
          JSON.stringify({ success: true, folderId: rawFolderId || null }),
          { status: 200 },
        );
      }
    }

    // Плейсхолдеры не должны попадать в хранилище — подставляем оригиналы.
    const safeDocument = hasDocument
      ? await restoreRealData(conversationId, documentContent)
      : documentContent;

    // Сначала обновляем messages и/или documentContent
    if (hasMessages || hasDocument) {
      updated = await updateConversation(conversationId, messages || [], safeDocument);
    }

    if (hasTitle) {
      updated = await renameConversation(conversationId, title.trim());
      if (updated && hasDocument && safeDocument) {
        updated.document_content = safeDocument;
      }
    }
    
    return new Response(JSON.stringify({ success: true, conversation: updated }), { status: 200 });
  } catch (err: any) {
    console.error('Conversations PUT error', err);
    return new Response(JSON.stringify({ success: false, message: err?.message || 'error' }), { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const { conversationId, userId: claimedUserId } = body as any;
    const user = await requireUser(req, claimedUserId);
    if (user instanceof Response) return user;
    const userId = user.id;
    if (!conversationId) {
      return new Response(
        JSON.stringify({ success: false, message: 'conversationId required' }),
        { status: 400 },
      );
    }

    try {
      await deleteConversation(conversationId, userId);
    } catch (err: any) {
      const message = err?.message || 'error';
      const status =
        err instanceof ForbiddenError || message === 'Forbidden'
          ? 403
          : message === 'Conversation not found'
            ? 404
            : 500;
      return new Response(JSON.stringify({ success: false, message }), { status });
    }

    return new Response(JSON.stringify({ success: true }), { status: 200 });
  } catch (err: any) {
    console.error('Conversations DELETE error', err);
    return new Response(JSON.stringify({ success: false, message: err?.message || 'error' }), { status: 500 });
  }
}
