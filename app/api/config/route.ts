/**
 * Публичные настройки развёртывания для интерфейса. Только флаги, без секретов
 * и адресов — отдаётся и гостю.
 */
import { isCloudModeEnabled } from '@/lib/deployment-mode';

export const dynamic = 'force-dynamic';

export function GET() {
  return Response.json({ cloudMode: isCloudModeEnabled() });
}
