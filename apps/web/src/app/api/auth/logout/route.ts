import { SESSION_COOKIE } from '@/lib/auth';

export async function POST(): Promise<Response> {
  const response = Response.json({ ok: true });
  response.headers.append('set-cookie', `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
  return response;
}
