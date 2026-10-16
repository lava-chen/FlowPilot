import { existsSync, mkdirSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import pg from 'pg';
import { getEnv, logger } from '@flowpilot/shared';

/**
 * The database abstraction the whole system talks to.
 *
 * Two implementations exist on purpose:
 *  * `PgClient` — production / local dev, `pg` over a TCP connection (Supabase included).
 *  * `PgliteClient` — real Postgres compiled to WASM, used by the test suite.
 *
 * They run the *same* SQL files, so a migration that breaks the app breaks the tests instead of
 * waiting to be discovered in production.
 */
export interface SqlClient {
  query<T = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<T[]>;
  one<T = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<T | null>;
  /** Runs raw multi-statement SQL (migrations only). */
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export type Queryable = Pick<SqlClient, 'query' | 'one'>;

export class PgClient implements SqlClient {
  private readonly pool: pg.Pool;
  private readonly log = logger.child({ layer: 'db' });

  constructor(connectionString: string = getEnv().DATABASE_URL) {
    this.pool = new pg.Pool({
      connectionString,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      ssl: connectionString.includes('supabase.co') ? { rejectUnauthorized: false } : undefined,
    });
  }

  async query<T = Record<string, unknown>>(text: string, params: readonly unknown[] = []): Promise<T[]> {
    const started = Date.now();
    const result = await this.pool.query(text, params as unknown[]);
    const ms = Date.now() - started;
    if (ms > 500) this.log.warn('slow query', { ms, sql: text.slice(0, 120) });
    return result.rows as T[];
  }

  async one<T = Record<string, unknown>>(text: string, params: readonly unknown[] = []): Promise<T | null> {
    const rows = await this.query<T>(text, params);
    return rows[0] ?? null;
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    const tx = new PooledClient(client);
    try {
      await client.query('begin');
      const result = await fn(tx);
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

class PooledClient implements SqlClient {
  constructor(private readonly client: pg.PoolClient) {}

  async query<T = Record<string, unknown>>(text: string, params: readonly unknown[] = []): Promise<T[]> {
    const result = await this.client.query(text, params as unknown[]);
    return result.rows as T[];
  }

  async one<T = Record<string, unknown>>(text: string, params: readonly unknown[] = []): Promise<T | null> {
    const rows = await this.query<T>(text, params);
    return rows[0] ?? null;
  }

  async exec(sql: string): Promise<void> {
    await this.client.query(sql);
  }

  async transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T> {
    return fn(this);
  }

  async close(): Promise<void> {
    /* connection is owned by the pool */
  }
}

type PgliteModule = typeof import('@electric-sql/pglite');

/**
 * A client whose underlying connection is still being opened.
 *
 * PGlite has to boot asynchronously, but callers (Next route handlers, MCP handlers) want a
 * synchronous `FlowPilotDb`. Rather than push `await` through every call site, this resolves on
 * first use — the first query pays the startup cost, the rest are ordinary.
 */
export class DeferredSqlClient implements SqlClient {
  private readonly ready: Promise<SqlClient>;

  constructor(ready: Promise<SqlClient>) {
    this.ready = ready;
  }

  private async client(): Promise<SqlClient> {
    return this.ready;
  }

  async query<T = Record<string, unknown>>(text: string, params: readonly unknown[] = []): Promise<T[]> {
    return (await this.client()).query<T>(text, params);
  }

  async one<T = Record<string, unknown>>(text: string, params: readonly unknown[] = []): Promise<T | null> {
    return (await this.client()).one<T>(text, params);
  }

  async exec(sql: string): Promise<void> {
    return (await this.client()).exec(sql);
  }

  async transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T> {
    return (await this.client()).transaction(fn);
  }

  async close(): Promise<void> {
    await (await this.client()).close();
  }
}

export async function createPgliteClient(options: { dataDir?: string } = {}): Promise<SqlClient> {
  const mod = (await import('@electric-sql/pglite')) as unknown as {
    PGlite?: PgliteModule['PGlite'];
    default?: { PGlite?: PgliteModule['PGlite'] };
  };
  // PGlite exposes its class as a named export in ESM and under `default` when a CJS interop
  // loader resolves it (tsx on Windows does). Accept either shape rather than guessing.
  const Pglite = mod.PGlite ?? mod.default?.PGlite;
  if (!Pglite) throw new Error('Could not load @electric-sql/pglite (no PGlite export found).');

  const dataDir = options.dataDir ? resolveDataDir(options.dataDir) : null;
  if (dataDir) mkdirSync(dataDir, { recursive: true });
  const db = dataDir ? await Pglite.create({ dataDir }) : await Pglite.create();
  return new PgliteClient(db);
}

/**
 * Anchors a relative data directory at the workspace root (the directory holding
 * `pnpm-workspace.yaml`).
 *
 * Without this, a relative path would mean different things to different processes — `pnpm
 * db:seed` runs with cwd `packages/database` while `next dev` runs at the repo root — and the two
 * would silently use different databases.
 */
export function resolveDataDir(dataDir: string): string {
  if (isAbsolute(dataDir)) return dataDir;

  let dir = process.cwd();
  for (let depth = 0; depth <= 6; depth += 1) {
    if (existsSync(resolve(dir, 'pnpm-workspace.yaml'))) return resolve(dir, dataDir);
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(process.cwd(), dataDir);
}

/** Synchronous handle over a PGlite database that is still booting. */
export function connectPglite(options: { dataDir?: string } = {}): SqlClient {
  return new DeferredSqlClient(createPgliteClient(options));
}

/**
 * Parses a `pglite:` connection URL into a data directory.
 * `pglite://./.data/flowpilot` -> `.data/flowpilot`
 */
export function pgliteDataDir(url: string): string | undefined {
  const rest = url.replace(/^pglite:(\/\/)?/, '');
  return rest && rest !== ':memory:' ? rest : undefined;
}

export class PgliteClient implements SqlClient {
  constructor(private readonly db: import('@electric-sql/pglite').PGlite) {}

  static async create(options: { dataDir?: string } = {}): Promise<PgliteClient> {
    const mod = (await import('@electric-sql/pglite')) as PgliteModule;
    const db = options.dataDir ? await mod.PGlite.create({ dataDir: options.dataDir }) : await mod.PGlite.create();
    return new PgliteClient(db);
  }

  async query<T = Record<string, unknown>>(text: string, params: readonly unknown[] = []): Promise<T[]> {
    const result = await this.db.query<T>(text, params as unknown[]);
    return result.rows as T[];
  }

  async one<T = Record<string, unknown>>(text: string, params: readonly unknown[] = []): Promise<T | null> {
    const rows = await this.query<T>(text, params);
    return rows[0] ?? null;
  }

  async exec(sql: string): Promise<void> {
    await this.db.exec(sql);
  }

  async transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => fn(new PgliteTx(tx))) as Promise<T>;
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}

class PgliteTx implements SqlClient {
  constructor(private readonly tx: import('@electric-sql/pglite').Transaction) {}

  async query<T = Record<string, unknown>>(text: string, params: readonly unknown[] = []): Promise<T[]> {
    const result = await this.tx.query<T>(text, params as unknown[]);
    return result.rows as T[];
  }

  async one<T = Record<string, unknown>>(text: string, params: readonly unknown[] = []): Promise<T | null> {
    const rows = await this.query<T>(text, params);
    return rows[0] ?? null;
  }

  async exec(sql: string): Promise<void> {
    await this.tx.exec(sql);
  }

  async transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T> {
    return fn(this);
  }

  async close(): Promise<void> {
    /* transaction lifetime is managed by PGlite */
  }
}
