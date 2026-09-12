/**
 * POST /api/conversations/title — придумать и сохранить название диалога.
 *
 * Зовётся с клиента фоном сразу после отправки первого сообщения, параллельно
 * основному ответу агента. Отдельный роут, а не ветка /api/chat: там уже
 * роутинг агентов, RAG, анонимизация и два SSE-потока, и в облачном режиме он
 * работает через OpenRouter — а название генерируем ВСЕГДА локально.
 *
 * ПОЧЕМУ ВСЕГДА OLLAMA. Исходник — сырое сообщение пользователя и начало
 * расшифровки, то есть ПДн, которые ещё не проходили анонимизатор. Отправить
 * их во внешнего провайдера нельзя (152-ФЗ), даже ради двух слов заголовка.
 */
import { generateText } from 'ai';
import { extractAttachmentTextCached } from '@/lib/attachment-extract';
import { resolveRequestUserId } from '@/lib/auth-session';
import { isGenericChatTitle } from '@/lib/chat-display';
import { buildTitleSource, fallbackTitleFromSource, sanitizeGeneratedTitle } from '@/lib/chat-title';
import {
  assertConversationOwnership,
  ForbiddenError,
  getConversationTitle,
  renameConversation,
} from '@/lib/getPromt';
import { SGR_CHAT_TITLE_PROMPT } from '@/lib/prompts/sgr-prompts';
import { resolveChatLanguageModel } from '@/lib/resolve-chat-model';

export const runtime = 'nodejs';

function ok(title: string, generated: boolean) {
  return Response.json({ success: true, title, generated }, { status: 200 });
}

function fail(message: string, status: number) {
  return Response.json({ success: false, message }, { status });
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const conversationId = typeof body.conversationId === 'string' ? body.conversationId : '';
    if (!conversationId || conversationId.startsWith('local-')) {
      return fail('conversationId required', 400);
    }

    const userId = resolveRequestUserId(req, body.userId as string | undefined);

    // Изоляция диалогов: тот же гард, что в /api/conversations и /api/chat.
    try {
      await assertConversationOwnership(conversationId, userId);
    } catch (e) {
      if (e instanceof ForbiddenError) return fail('Forbidden', 403);
      console.error('[title] ownership check failed:', e);
      return fail('Проверка доступа временно недоступна', 503);
    }

    // Идемпотентность именно ЗДЕСЬ, а не только на клиенте: две вкладки могут
    // прийти одновременно, а ручное переименование не должно затираться.
    let currentTitle: string | null;
    try {
      currentTitle = await getConversationTitle(conversationId);
    } catch (e) {
      console.error('[title] не удалось прочитать текущий заголовок:', e);
      return fail('Хранилище временно недоступно', 503);
    }
    if (currentTitle && !isGenericChatTitle(currentTitle)) {
      return ok(currentTitle, false);
    }

    const text = typeof body.text === 'string' ? body.text : '';
    const files = Array.isArray(body.files) ? body.files : [];
    // Кэш разбора общий с /api/chat — docx/pdf второй раз не парсится.
    const attachmentTexts = await Promise.all(
      files.map((att) => extractAttachmentTextCached(att).catch(() => null)),
    );
    const source = buildTitleSource(text, attachmentTexts);
    if (!source) return ok(currentTitle || 'Чат', false);

    let title: string | null = null;
    try {
      const model = resolveChatLanguageModel({ chatProvider: 'ollama', useThinking: false });
      const { text: rawOutput } = await generateText({
        model,
        temperature: 0.2,
        /**
         * Лимит обязателен. Без него fetch-обёртка resolve-chat-model.ts
         * подставляет ollamaHardCapOutputTokens(), запрос уходит с
         * max_tokens во весь контекст модели, и шлюз отвечает 400 ДО
         * генерации. Ровно на это уже наступал классификатор интента.
         */
        maxOutputTokens: 120,
        prompt: SGR_CHAT_TITLE_PROMPT.replace('{{SOURCE}}', source),
      });
      title = sanitizeGeneratedTitle(rawOutput);
    } catch (e) {
      // Модель недоступна — это не повод отдавать 500: заголовок штука
      // необязательная, но и оставлять «Чат» незачем, когда есть исходник.
      console.warn('[title] генерация названия не удалась:', (e as Error)?.message);
    }

    const generated = title !== null;
    if (!title) title = fallbackTitleFromSource(source);
    if (!title) return ok(currentTitle || 'Чат', false);

    await renameConversation(conversationId, title);
    return ok(title, generated);
  } catch (err) {
    console.error('Conversations title POST error', err);
    return fail((err as Error)?.message || 'error', 500);
  }
}
