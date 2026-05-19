/** Заголовок чата по умолчанию (Conversation / New conversation / «Новый чат …»). */
export function isGenericChatTitle(title: string | null | undefined): boolean {
  const t = String(title ?? '').trim().toLowerCase();
  if (!t) return true;
  if (t === 'чат' || t === 'chat') return true;
  if (t === 'new conversation') return true;
  if (t.startsWith('conversation ')) return true;
  if (t.startsWith('новый чат')) return true;
  return false;
}

export function getChatSidebarLabel(title: string | null | undefined): string {
  const trimmed = String(title ?? '').trim();
  if (isGenericChatTitle(trimmed)) return 'Чат';
  return trimmed || 'Чат';
}

export function formatChatListDate(created: string | null | undefined): string {
  if (!created) return '';
  const d = new Date(created);
  if (Number.isNaN(d.getTime())) {
    return String(created).replace('T', ' ').slice(0, 16);
  }
  return d.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
