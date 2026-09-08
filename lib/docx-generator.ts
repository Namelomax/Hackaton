import { renderProtocolDocx } from './docx-template/render';
import type { Protocol } from './schemas/protocol-schema';

/**
 * Собирает протокол в .docx по корпоративному шаблону заказчика.
 *
 * Вся вёрстка живёт в lib/docx-template: оформление берётся из самого шаблона,
 * здесь остаётся только точка входа с исторической сигнатурой.
 */
export async function generateProtocolDocx(protocol: Protocol): Promise<Buffer> {
  return renderProtocolDocx(protocol);
}
