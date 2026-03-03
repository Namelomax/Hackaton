import { NextRequest } from 'next/server';
import { createConversation, deleteConversation, getConversations, renameConversation, saveConversation, updateConversation } from '@/lib/getPromt';

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const userId = url.searchParams.get('userId');
    if (!userId) return new Response(JSON.stringify({ success: false, message: 'userId required' }), { status: 400 });
    const convs = await getConversations(userId);
    try {
      console.log('GET /api/conversations: returning', JSON.stringify(convs.slice(0,5)));
    } catch (e) {
      console.log('GET /api/conversations: returning [unserializable]');
    }
    return new Response(JSON.stringify({ success: true, conversations: convs }), { status: 200 });
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
    const { conversationId, messages, title, documentContent } = body as any;
    if (!conversationId) return new Response(JSON.stringify({ success: false, message: 'conversationId required' }), { status: 400 });
    const hasMessages = Array.isArray(messages);
    const hasTitle = typeof title === 'string' && title.trim().length > 0;
    const hasDocument = typeof documentContent === 'string';

    if (!hasMessages && !hasTitle && !hasDocument) {
      return new Response(JSON.stringify({ success: false, message: 'messages, title or documentContent required' }), { status: 400 });
    }
    
    let updated = null;
    
    // Сначала обновляем messages и/или documentContent
    if (hasMessages || hasDocument) {
      console.log('[PUT] Updating conversation with:', {
        conversationId,
        hasMessages,
        hasDocument,
        documentContentLength: documentContent?.length,
      });
      updated = await updateConversation(conversationId, messages || [], documentContent);
      console.log('[PUT] updateConversation result:', {
        id: updated?.id,
        document_content: updated?.document_content?.slice(0, 100),
      });
    }
    
    // Затем обновляем title (если есть), но сохраняем documentContent
    if (hasTitle) {
      console.log('[PUT] Renaming conversation:', { title });
      updated = await renameConversation(conversationId, title.trim());
      // renameConversation может не вернуть document_content, поэтому явно добавляем его
      if (updated && hasDocument && documentContent) {
        updated.document_content = documentContent;
      }
      console.log('[PUT] renameConversation result:', {
        id: updated?.id,
        title: updated?.title,
        document_content: updated?.document_content?.slice(0, 100),
      });
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
