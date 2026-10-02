import { ragUpload } from '@/lib/rag-proxy';
import { ragScopeOrResponse } from '@/lib/rag-route-guard';

export const maxDuration = 300;
export const runtime = 'nodejs';

export async function POST(req: Request) {
  // conversation_id из query — индекс диалога. Доступ проверяем до чтения тела.
  const scope = await ragScopeOrResponse(req, new URL(req.url).searchParams.get('conversation_id'));
  if (scope instanceof Response) return scope;

  const formData = await req.formData();
  const file = formData.get('file');
  if (!(file instanceof Blob)) {
    return Response.json({ error: 'file field required' }, { status: 400 });
  }
  return ragUpload(file, scope);
}
