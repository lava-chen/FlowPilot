'use client';

/**
 * Client-side fetch helper.
 *
 * Every mutation goes through the real API — there is no optimistic-only state in this app. The
 * server response is the source of truth, so a rejected transition cannot look like a success.
 */
export async function apiFetch<T>(input: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const response = await fetch(input, {
    ...rest,
    headers: {
      ...(json !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(rest.headers ?? {}),
    },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
    cache: 'no-store',
  });

  const text = await response.text();
  const payload = text ? (JSON.parse(text) as unknown) : {};

  if (!response.ok) {
    const error = payload as { error?: { message?: string; details?: Record<string, string[]> } };
    const details = error.error?.details ?? {};
    const fieldMessages = Object.entries(details)
      .flatMap(([field, messages]) => messages.map((m) => `${field}: ${m}`))
      .join(' ');
    throw new ApiError(error.error?.message ?? `Request failed (${response.status})`, response.status, details, fieldMessages);
  }

  return payload as T;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly details: Record<string, string[]>,
    readonly fieldMessage: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** e.g. "from: draft, to: completed" — useful for showing why a transition was refused. */
  get explain(): string {
    return this.fieldMessage || this.message;
  }
}
