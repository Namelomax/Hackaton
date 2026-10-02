/**
 * Доступ к /api/rag/*: раньше эти роуты не проверяли сессию вовсе, и любой,
 * кто знал id диалога, мог читать и удалять его документы.
 *
 *  - нужен вход;
 *  - `conversation_id` — только свой диалог;
 *  - без `conversation_id` (глобальный индекс) — только администратор;
 *  - индексы папок (`folder_…`) сюда не пускаем: у них свои права,
 *    работа с ними — через /api/folders/sources.
 */
import { requireUser } from '@/lib/auth-guard';
import { assertConversationOwnership, ForbiddenError } from '@/lib/getPromt';

export async function ragScopeOrResponse(req: Request, conversationId: string | null | undefined): Promise<string | null | Response> {
  const user = await requireUser(req);
  if (user instanceof Response) return user;

  const scope = typeof conversationId === 'string' && conversationId.trim() ? conversationId.trim() : null;
  if (!scope) {
    if (user.role !== 'admin') {
      return Response.json({ error: 'conversation_id required' }, { status: 400 });
    }
    return null;
  }
  if (scope.startsWith('folder_')) {
    return Response.json({ error: 'Источники папки — через /api/folders/sources' }, { status: 400 });
  }
  try {
    await assertConversationOwnership(scope, user.id);
  } catch (e) {
    if (e instanceof ForbiddenError) {
      return Response.json({ error: 'Доступ к этому диалогу запрещён' }, { status: 403 });
    }
    console.error('[rag] ownership check failed:', e);
    return Response.json({ error: 'Проверка доступа временно недоступна' }, { status: 503 });
  }
  return scope;
}
