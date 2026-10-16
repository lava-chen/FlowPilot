import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { ValidationError } from './errors.js';

/**
 * Environment loading + validation.
 *
 * Two rules:
 *  1. Fail fast and loudly. A missing DATABASE_URL must stop the process at boot, not produce
 *     a confusing connection error 200 ms later.
 *  2. Real values already in `process.env` always win over the file, so CI and Docker can
 *     override without editing files.
 */

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required (postgresql://...)'),
  SESSION_SECRET: z.string().min(16, 'SESSION_SECRET must be at least 16 characters'),
  AUTH_PROVIDER: z.enum(['local', 'supabase']).default('local'),
  SUPABASE_URL: z.string().url().optional().or(z.literal('').transform(() => undefined)),
  SUPABASE_ANON_KEY: z.string().optional().or(z.literal('').transform(() => undefined)),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional().or(z.literal('').transform(() => undefined)),
  WEB_PORT: z.coerce.number().int().positive().default(3000),
  MCP_PORT: z.coerce.number().int().positive().default(3001),
  MCP_PUBLIC_URL: z.string().url().default('http://localhost:3001/mcp'),
  APP_ORIGIN: z.string().url().default('http://localhost:3000'),
  FLOWPILOT_ENABLE_RLS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  FLOWPILOT_DEMO_MODE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  FLOWPILOT_AI_PROVIDER: z.enum(['deterministic', 'openai-compatible']).default('deterministic'),
  FLOWPILOT_AI_BASE_URL: z.string().url().default('https://api.openai.com/v1'),
  FLOWPILOT_AI_API_KEY: z.string().optional().or(z.literal('').transform(() => undefined)),
  FLOWPILOT_AI_MODEL: z.string().trim().min(1).optional().or(z.literal('').transform(() => undefined)),
  FLOWPILOT_AI_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(30000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).optional(),
}).superRefine((env, ctx) => {
  if (env.FLOWPILOT_AI_PROVIDER === 'openai-compatible') {
    if (!env.FLOWPILOT_AI_API_KEY) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['FLOWPILOT_AI_API_KEY'], message: 'Required when FLOWPILOT_AI_PROVIDER=openai-compatible.' });
    }
    if (!env.FLOWPILOT_AI_MODEL) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['FLOWPILOT_AI_MODEL'], message: 'Required when FLOWPILOT_AI_PROVIDER=openai-compatible.' });
    }
  }
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;
let fileLoaded = false;

/**
 * Load `.env.local` / `.env` without clobbering real environment values.
 *
 * Walks up from the starting directory to the filesystem root, because a monorepo command can run
 * from `packages/database` while the file lives at the repo root. The *closest* file wins, and a
 * value already present in `process.env` always wins over both.
 */
export function loadEnvFiles(startDir: string = process.cwd(), maxDepth = 6): void {
  if (fileLoaded) return;
  fileLoaded = true;

  const files: string[] = [];
  let dir = resolve(startDir);
  for (let depth = 0; depth <= maxDepth; depth += 1) {
    files.push(resolve(dir, '.env.local'), resolve(dir, '.env'));
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }

  // Reverse so the closest file is applied last and therefore wins.
  for (const file of files.reverse()) {
    let contents: string;
    try {
      contents = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of contents.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }
}

export function getEnv(): Env {
  if (cached) return cached;
  loadEnvFiles();
  loadEnvFiles(dirname(fileURLToPath(import.meta.url)), 3);

  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('\n  - ');
    throw new ValidationError(`Invalid environment configuration:\n  - ${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/** Test helper — forces the next getEnv() to re-validate. */
export function resetEnvCache(): void {
  cached = null;
  fileLoaded = false;
}
