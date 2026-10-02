/**
 * Режим развёртывания.
 *
 * `CLOUD_MODE=off` — закрытый контур: облачная модель (OpenRouter, режим
 * «Облако + анонимизация») выключена целиком. Переключатель в интерфейсе
 * скрывается, а сервер не обращается к облаку, даже если клиент попросит.
 * По умолчанию режим включён — как на текущем проде.
 */
export function isCloudModeEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = env.CLOUD_MODE?.trim().toLowerCase();
  return !(v === 'off' || v === 'false' || v === '0' || v === 'no');
}
