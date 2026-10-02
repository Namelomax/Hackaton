import { ragDeleteDocument, ragListDocuments } from '@/lib/rag-proxy';
import { ragScopeOrResponse } from '@/lib/rag-route-guard';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const scope = await ragScopeOrResponse(req, new URL(req.url).searchParams.get('conversation_id'));
  if (scope instanceof Response) return scope;
  return ragListDocuments(scope);
}

export async function DELETE(req: Request) {
  const body = await req.json().catch(() => ({}));
  const id = typeof body?.id === 'string' ? body.id.trim() : '';
  if (!id) {
    return Response.json({ error: 'id required' }, { status: 400 });
  }
  const scope = await ragScopeOrResponse(
    req,
    typeof body?.conversation_id === 'string' ? body.conversation_id : null,
  );
  if (scope instanceof Response) return scope;
  return ragDeleteDocument(id, scope);
}
