import { runDocumentReview } from '@/app/api/chat/agents/review-agent';
import { assertConversationOwnership, ForbiddenError } from '@/lib/getPromt';
import { activeUserIdOrResponse } from '@/lib/auth-guard';

export const maxDuration = 90;
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic'; // Отключаем кэширование

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const { content, chatModel, useThinking, conversationId, userId } = body as {
    content?: string;
    chatModel?: string;
    useThinking?: boolean;
    conversationId?: string;
    userId?: string;
  };

  if (!content || typeof content !== 'string') {
    return Response.json(
      { error: 'Missing or invalid content' },
      { status: 400 }
    );
  }

  // ИЗОЛЯЦИЯ: проверяется документ конкретного диалога — только его владельцем.
  const auth = await activeUserIdOrResponse(req, userId);
  if (auth instanceof Response) return auth;
  try {
    // Личность — из подписанной сессии; тело запроса лишь запасной путь.
    await assertConversationOwnership(conversationId, auth.userId);
  } catch (e) {
    if (e instanceof ForbiddenError) {
      return Response.json({ error: 'Доступ к этому диалогу запрещён' }, { status: 403 });
    }
    // Не удалось проверить — отказываем, а не пропускаем.
    console.error('ownership check failed:', e);
    return Response.json(
      { error: 'Сервис временно недоступен: не удалось проверить доступ к диалогу.' },
      { status: 503 },
    );
  }

  try {
    // Проверка — локальной моделью: данные не покидают сервер.
    const review = await runDocumentReview(content, {
      chatModel: typeof chatModel === 'string' ? chatModel : undefined,
      useThinking: Boolean(useThinking),
    });
    return Response.json(review);
  } catch (error) {
    console.error('[review-document] Error:', error);
    return Response.json(
      { error: String(error) },
      { status: 500 }
    );
  }
}
