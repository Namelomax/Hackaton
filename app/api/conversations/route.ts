import { NextRequest } from 'next/server';
import { createConversation, deleteConversation, getConversations, renameConversation, saveConversation, updateConversation, getConversationMapping, assertConversationOwnership } from '@/lib/getPromt';
import { deanonymize } from '@/lib/anonymization';

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
    const userId = url.searchParams.get('userId');
    if (!userId) return new Response(JSON.stringify({ success: false, message: 'userId required' }), { status: 400 });
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
    const { userId, title, messages } = body as any;
    if (!userId) return new Response(JSON.stringify({ success: false, message: 'userId required' }), { status: 400 });

    // If client provided messages, create the conversation with those messages attached.
    if (Array.isArray(messages) && messages.length > 0) {
      const conv = await saveConversation(userId, messages);
      return new Response(JSON.stringify({ success: true, conversation: conv }), { status: 201 });
    }

    const conv = await createConversation(userId, title).catch((e) => { throw e; });
    return new Response(JSON.stringify({ success: true, conversation: conv }), { status: 201 });
  } catch (err: any) {
    console.error('Conversations POST error', err);
    return new Response(JSON.stringify({ success: false, message: err?.message || 'error' }), { status: 500 });
  }
}

export async function PUT(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const { conversationId, messages, title, documentContent, userId } = body as any;
    if (!conversationId) return new Response(JSON.stringify({ success: false, message: 'conversationId required' }), { status: 400 });

    // ИЗОЛЯЦИЯ: нельзя писать в чужой диалог.
    try {
      await assertConversationOwnership(conversationId, userId);
    } catch (e) {
      if (e instanceof Error && e.message === 'Forbidden') {
        return new Response(JSON.stringify({ success: false, message: 'Forbidden' }), { status: 403 });
      }
    }
    const hasMessages = Array.isArray(messages);
    const hasTitle = typeof title === 'string' && title.trim().length > 0;
    const hasDocument = typeof documentContent === 'string';

    if (!hasMessages && !hasTitle && !hasDocument) {
      return new Response(JSON.stringify({ success: false, message: 'messages, title or documentContent required' }), { status: 400 });
    }
    
    let updated = null;

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
    const { conversationId, userId } = body as any;
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
      const status = message === 'Forbidden' ? 403 : message === 'Conversation not found' ? 404 : 500;
      return new Response(JSON.stringify({ success: false, message }), { status });
    }

    return new Response(JSON.stringify({ success: true }), { status: 200 });
  } catch (err: any) {
    console.error('Conversations DELETE error', err);
    return new Response(JSON.stringify({ success: false, message: err?.message || 'error' }), { status: 500 });
  }
}
