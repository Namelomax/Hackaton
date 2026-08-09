import { runDocumentReview } from '@/app/api/chat/agents/review-agent';
import {
  anonymizeWithMapping,
  deepDeanonymize,
  loadConversationMapping,
} from '@/lib/anonymization';
import { assertConversationOwnership } from '@/lib/getPromt';

export const maxDuration = 90;
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic'; // Отключаем кэширование

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const { content, chatProvider, chatModel, useThinking, conversationId, userId } = body as {
    content?: string;
    chatProvider?: string;
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

  // ИЗОЛЯЦИЯ: ниже читается mapping диалога, а он содержит пары
  // «плейсхолдер → настоящие ПДн». Без проверки владения любой мог бы получить
  // расшифровку чужих персональных данных, подставив чужой conversationId.
  try {
    await assertConversationOwnership(conversationId, userId);
  } catch (e) {
    if (e instanceof Error && e.message === 'Forbidden') {
      return Response.json({ error: 'Доступ к этому диалогу запрещён' }, { status: 403 });
    }
  }

  try {
    const isCloud = chatProvider === 'openrouter';

    // Облако: документ правой панели содержит реальные ПДн — зачищаем по
    // mapping диалога перед отправкой; результат (цитаты в замечаниях)
    // возвращаем с реальными данными. Локальная модель получает документ как есть.
    let mapping: Record<string, string> = {};
    let contentForReview = content;
    if (isCloud && typeof conversationId === 'string' && conversationId) {
      mapping = await loadConversationMapping(conversationId);
      if (Object.keys(mapping).length > 0) {
        contentForReview = anonymizeWithMapping(content, mapping);
      }
    }

    let review = await runDocumentReview(contentForReview, {
      chatProvider: isCloud ? 'openrouter' : 'ollama',
      chatModel: typeof chatModel === 'string' ? chatModel : undefined,
      useThinking: Boolean(useThinking),
    });
    if (isCloud && Object.keys(mapping).length > 0) {
      review = deepDeanonymize(review, mapping);
    }
    return Response.json(review);
  } catch (error) {
    console.error('[review-document] Error:', error);
    return Response.json(
      { error: String(error) },
      { status: 500 }
    );
  }
}
