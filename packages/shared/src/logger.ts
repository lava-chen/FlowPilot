/**
 * Structured logger with mandatory redaction.
 *
 * Credentials must never reach logs, so redaction is applied to *every* value that looks like a
 * secret key, plus to any string value that starts with the bearer-token prefix. This is not a
 * "be careful" convention — it is a code path that runs on each log line.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const REDACTED = '[redacted]';
const SECRET_KEY_PATTERN = /(authorization|token|secret|password|passwd|api[-_]?key|bearer|credential|cookie|session[-_]?secret)/i;
const BEARER_PATTERN = /\b(fp_(live|test)_[A-Za-z0-9_-]+|Bearer\s+[A-Za-z0-9._-]+)/gi;

export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  bindings?: Record<string, unknown>;
  /** Injection seam for tests. */
  sink?: (line: string) => void;
  name?: string;
}

export function redactString(input: string): string {
  return input.replace(BEARER_PATTERN, REDACTED);
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth-limit]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return value;
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message) };
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY_PATTERN.test(key) ? REDACTED : redact(val, depth + 1);
    }
    return out;
  }
  return String(value);
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? defaultLevel();
  const bindings = options.bindings ?? {};
  const sink = options.sink ?? ((line: string) => process.stdout.write(`${line}\n`));
  const name = options.name ?? 'flowpilot';

  const emit = (logLevel: LogLevel, message: string, context?: Record<string, unknown>) => {
    if (LEVEL_ORDER[logLevel] < LEVEL_ORDER[level]) return;
    const payload = {
      ts: new Date().toISOString(),
      level: logLevel,
      name,
      msg: redactString(message),
      ...(redact({ ...bindings, ...(context ?? {}) }) as Record<string, unknown>),
    };
    try {
      sink(JSON.stringify(payload));
    } catch {
      sink(JSON.stringify({ ts: payload.ts, level: logLevel, name, msg: payload.msg, logError: 'unserializable context' }));
    }
  };

  return {
    debug: (m, c) => emit('debug', m, c),
    info: (m, c) => emit('info', m, c),
    warn: (m, c) => emit('warn', m, c),
    error: (m, c) => emit('error', m, c),
    child: (extra) => createLogger({ ...options, level, name, bindings: { ...bindings, ...extra } }),
  };
}

function defaultLevel(): LogLevel {
  const raw = (process.env['LOG_LEVEL'] ?? '').toLowerCase();
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') return raw;
  if (process.env['NODE_ENV'] === 'production') return 'info';
  return 'debug';
}

export const logger = createLogger();
