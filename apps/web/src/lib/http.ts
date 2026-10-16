import { isAppError, toMessage, ValidationError } from '@flowpilot/shared';

/**
 * One place that turns a thrown error into an HTTP response.
 *
 * Route handlers therefore never hand-roll status codes, and an unexpected error still comes
 * back as JSON with a generic message — stack traces stay in the logs, not in the response body.
 */
export function errorResponse(error: unknown): Response {
  if (error instanceof ValidationError || isAppError(error)) {
    const appError = error as { status: number; toJSON?: () => unknown };
    return Response.json(appError.toJSON ? appError.toJSON() : { error: { code: 'error', message: error.message } }, {
      status: appError.status,
    });
  }

  console.error('[api] unhandled error:', error);
  return Response.json(
    { error: { code: 'internal_error', message: 'Something went wrong on our side.', details: {} } },
    { status: 500 },
  );
}

export function ok<T>(data: T, init?: ResponseInit): Response {
  return Response.json(data, { status: 200, ...init });
}

export function created<T>(data: T): Response {
  return Response.json(data, { status: 201 });
}

/** Parses and validates a JSON body, converting zod issues into our ValidationError shape. */
export async function parseBody<T>(request: Request, schema: { safeParse: (input: unknown) => { success: true; data: T } | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } } }): Promise<T> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new ValidationError('Request body must be valid JSON.');
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const details: Record<string, string[]> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path.map(String).join('.') || '_root';
      (details[key] ??= []).push(issue.message);
    }
    throw new ValidationError('Some fields need attention.', details);
  }
  return parsed.data;
}

export function errorMessage(error: unknown): string {
  return toMessage(error);
}
