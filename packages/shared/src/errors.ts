/**
 * Typed application errors.
 *
 * Every error carries a stable `code` plus an HTTP status and a JSON-RPC code, so the web
 * route handlers and the MCP tools can translate one error object into their own protocol
 * without a pile of `instanceof` branches or duplicated messages.
 */

export type ErrorCode =
  | 'validation_failed'
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'organization_mismatch'
  | 'invalid_transition'
  | 'conflict'
  | 'rate_limited'
  | 'integration_error'
  | 'internal_error';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly jsonRpcCode: number;
  readonly details: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    options: { status?: number; jsonRpcCode?: number; details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.code = code;
    this.status = options.status ?? defaultStatus(code);
    this.jsonRpcCode = options.jsonRpcCode ?? defaultRpcCode(code);
    this.details = options.details ?? {};
  }

  toJSON(): { error: { code: ErrorCode; message: string; details: Record<string, unknown> } } {
    return { error: { code: this.code, message: this.message, details: this.details } };
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('validation_failed', message, { status: 400, jsonRpcCode: -32602, details });
  }
}

export class UnauthenticatedError extends AppError {
  constructor(message = 'Authentication required.') {
    super('unauthenticated', message, { status: 401, jsonRpcCode: -32001 });
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'You do not have permission to perform this action.', details?: Record<string, unknown>) {
    super('forbidden', message, { status: 403, jsonRpcCode: -32003, details });
  }
}

export class NotFoundError extends AppError {
  constructor(entity: string, id?: string) {
    super('not_found', id ? `${entity} ${id} was not found.` : `${entity} was not found.`, {
      status: 404,
      jsonRpcCode: -32002,
      details: id ? { entity, id } : { entity },
    });
  }
}

export class OrganizationMismatchError extends AppError {
  constructor(entity: string, id: string) {
    super(
      'organization_mismatch',
      `${entity} ${id} does not belong to the active organization.`,
      { status: 404, jsonRpcCode: -32002, details: { entity, id } },
    );
  }
}

export class InvalidTransitionError extends AppError {
  readonly from: string;
  readonly to: string;

  constructor(from: string, to: string, allowed: readonly string[]) {
    super('invalid_transition', `Cannot move a task from "${from}" to "${to}".`, {
      status: 409,
      jsonRpcCode: -32004,
      details: { from, to, allowed },
    });
    this.from = from;
    this.to = to;
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('conflict', message, { status: 409, jsonRpcCode: -32009, details });
  }
}

export class IntegrationError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('integration_error', message, { status: 502, jsonRpcCode: -32010, details });
  }
}

function defaultStatus(code: ErrorCode): number {
  switch (code) {
    case 'validation_failed':
      return 400;
    case 'unauthenticated':
      return 401;
    case 'forbidden':
      return 403;
    case 'not_found':
    case 'organization_mismatch':
      return 404;
    case 'invalid_transition':
    case 'conflict':
      return 409;
    case 'rate_limited':
      return 429;
    case 'integration_error':
      return 502;
    case 'internal_error':
      return 500;
  }
}

function defaultRpcCode(code: ErrorCode): number {
  switch (code) {
    case 'validation_failed':
      return -32602;
    case 'internal_error':
      return -32603;
    case 'unauthenticated':
      return -32001;
    case 'not_found':
    case 'organization_mismatch':
      return -32002;
    case 'forbidden':
      return -32003;
    default:
      return -32000;
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

/** Best-effort message extraction for unknown throwables. */
export function toMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Unexpected error.';
}
