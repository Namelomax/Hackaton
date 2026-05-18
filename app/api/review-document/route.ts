import { runDocumentReview } from '@/app/api/chat/agents/review-agent';

export const maxDuration = 90;
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic'; // Отключаем кэширование

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const { content, chatProvider, chatModel, useThinking } = body as {
    content?: string;
    chatProvider?: string;
    chatModel?: string;
    useThinking?: boolean;
  };

  if (!content || typeof content !== 'string') {
    return Response.json(
      { error: 'Missing or invalid content' },
      { status: 400 }
    );
  }

  try {
    const review = await runDocumentReview(content, {
      chatProvider: chatProvider === 'openrouter' ? 'openrouter' : 'ollama',
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
