import { createUser, getUserByUsername, authenticateUser, getConversations } from '@/lib/getPromt';
import crypto from 'crypto';

async function hashPassword(password: string) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

export async function POST(req: Request) {
  const { action, username, password } = await req.json();

  if (!username || !password) {
    return new Response(JSON.stringify({ success: false, message: 'username and password required' }), { status: 400 });
  }

  const passwordHash = await hashPassword(password);

  try {
    if (action === 'register') {
      const existing = await getUserByUsername(username);
      if (existing) {
        return new Response(JSON.stringify({ success: false, message: 'User already exists' }), { status: 409 });
      }
      const user = await createUser(username, passwordHash);
      const convs = await getConversations(user.id).catch(() => []);
      // No session writes — conversations are stored per-user in `conversations`
      return new Response(JSON.stringify({ success: true, user, conversations: convs }), { status: 201 });
    }

    if (action === 'login') {
      const user = await authenticateUser(username, passwordHash);
      if (!user) {
        return new Response(JSON.stringify({ success: false, message: 'Invalid credentials' }), { status: 401 });
      }

      const convs = await getConversations(user.id).catch(() => []);
      // No session writes on login
      return new Response(JSON.stringify({ success: true, user, conversations: convs }), { status: 200 });
    }

    return new Response(JSON.stringify({ success: false, message: 'Invalid action' }), { status: 400 });
  } catch (err: unknown) {
    console.error('Auth error:', err);
    const detail =
      err instanceof Error ? err.message : typeof err === 'string' ? err : undefined;
    const body: Record<string, unknown> = { success: false, message: 'Server error' };
    if (process.env.NODE_ENV === 'development' && detail) {
      body.detail = detail;
    }
    return new Response(JSON.stringify(body), { status: 500 });
  }
}
