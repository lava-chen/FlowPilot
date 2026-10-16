import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '@flowpilot/shared';
import type { SqlClient } from './client.js';

const log = logger.child({ layer: 'migrate' });

/**
 * Forward-only SQL migration runner.
 *
 * Migrations are plain `.sql` files applied in filename order and recorded with a checksum, so
 * editing an already-applied migration is reported instead of silently ignored. Each file runs
 * inside one transaction: a failure leaves no half-applied schema.
 */

const MIGRATIONS_TABLE = `
create table if not exists flowpilot_migrations (
  name        text primary key,
  checksum    text not null,
  applied_at  timestamptz not null default now()
);
`;

export interface MigrationFile {
  name: string;
  sql: string;
  checksum: string;
}

function migrationsDir(): string {
  // packages/database/src -> packages/database/migrations
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', 'migrations');
}

export function loadMigrations(dir: string = migrationsDir()): MigrationFile[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b));

  return files.map((name) => {
    const sql = readFileSync(join(dir, name), 'utf8');
    return { name, sql, checksum: checksum(sql) };
  });
}

function checksum(sql: string): string {
  // Small, dependency-free FNV-1a — only used to detect edited migrations.
  let hash = 0x811c9dc5;
  for (let i = 0; i < sql.length; i += 1) {
    hash ^= sql.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${hash.toString(16)}-${sql.length}`;
}

export interface MigrateOptions {
  /** Apply this migration only when present (used for the opt-in RLS migration). */
  only?: string;
  /** Skip this migration (e.g. 0002_rls.sql when the dev role owns the tables). */
  skip?: string[];
}

export interface MigrateResult {
  applied: string[];
  skipped: string[];
}

export async function migrate(db: SqlClient, options: MigrateOptions = {}): Promise<MigrateResult> {
  await db.exec(MIGRATIONS_TABLE);

  const files = loadMigrations();
  const skip = new Set(options.skip ?? []);
  const applied: string[] = [];
  const skipped: string[] = [];

  for (const file of files) {
    if (options.only && file.name !== options.only) {
      skipped.push(file.name);
      continue;
    }
    if (skip.has(file.name)) {
      skipped.push(file.name);
      continue;
    }

    const existing = await db.one<{ checksum: string }>('select checksum from flowpilot_migrations where name = $1', [
      file.name,
    ]);

    if (existing) {
      if (existing.checksum !== file.checksum) {
        throw new Error(
          `Migration ${file.name} was already applied with a different checksum. ` +
            'Migrations are forward-only — add a new file instead of editing this one.',
        );
      }
      continue;
    }

    log.info('applying migration', { name: file.name });
    await db.transaction(async (tx) => {
      await tx.exec(file.sql);
      await tx.query('insert into flowpilot_migrations (name, checksum) values ($1, $2)', [file.name, file.checksum]);
    });
    applied.push(file.name);
  }

  return { applied, skipped };
}
