import { authenticateWithPassword } from '@flowpilot/core';
import { LoginInputSchema } from '@flowpilot/domain';
import { getDb } from '@/lib/runtime';
import { errorResponse, ok, parseBody } from '@/lib/http';
import { SESSION_COOKIE } from '@/lib/auth';
import { getEnv } from '@flowpilot/shared';

export async function POST(request: Request): Promise<Response> {
  try {
    const input = await parseBody(request, LoginInputSchema);
    const db = getDb();
    const result = await authenticateWithPassword(db, input);

    const response = ok({
      user: { id: result.user.id, email: result.user.email, name: result.user.fullName },
      organization: result.organization,
      role: result.actor.role,
      expiresAt: result.expiresAt,
    });

    response.headers.append(
      'set-cookie',
      serializeCookie(SESSION_COOKIE, result.token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: getEnv().NODE_ENV === 'production',
        path: '/',
        maxAge: 60 * 60 * 12,
      }),
    );
    return response;
  } catch (error) {
    return errorResponse(error);
  }
}

/** Small, dependency-free cookie serializer so the login route has no extra moving parts. */
function serializeCookie(
  name: string,
  value: string,
  options: { httpOnly: boolean; sameSite: 'lax' | 'strict'; secure: boolean; path: string; maxAge: number },
): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${options.path}`,
    `Max-Age=${options.maxAge}`,
    `SameSite=${options.sameSite === 'lax' ? 'Lax' : 'Strict'}`,
  ];
  if (options.httpOnly) parts.push('HttpOnly');
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}
