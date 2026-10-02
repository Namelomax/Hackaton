/**
 * Публичные настройки развёртывания для интерфейса. Только флаги, без секретов
 * и адресов — отдаётся и гостю.
 */
import { resolveRagApiBaseUrl } from '@/lib/rag-api-url';

export const dynamic = 'force-dynamic';

export function GET() {
  return Response.json({
    // Источники папок работают через сервис поиска по документам. Не настроен —
    // интерфейс вообще не показывает раздел источников.
    folderSources: Boolean(resolveRagApiBaseUrl()),
  });
}
