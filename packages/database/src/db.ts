import { PgClient, PgliteClient, connectPglite, pgliteDataDir, type SqlClient } from './client.js';
import { createRepositories, type Repositories } from './repositories.js';
import { getEnv } from '@flowpilot/shared';

/**
 * `FlowPilotDb` bundles the connection with the repository set.
 *
 * `withTransaction` rebuilds the repositories against the transactional client, so a service
 * that opens a transaction automatically gets transaction-scoped repositories — there is no way
 * to accidentally mix a transactional write with a non-transactional read.
 */
export class FlowPilotDb {
  private constructor(
    readonly client: SqlClient,
    readonly repos: Repositories,
  ) {}

  static fromClient(client: SqlClient): FlowPilotDb {
    return new FlowPilotDb(client, createRepositories(client));
  }

  /**
   * Connects using DATABASE_URL.
   *
   * A normal `postgresql://` URL goes through `pg` (local Postgres, Docker, or Supabase). A
   * `pglite://<dir>` URL boots PGlite instead — the same Postgres engine compiled to WASM — which
   * is how you run the whole app with zero external services. Same SQL, same migrations.
   */
  static connect(connectionString?: string): FlowPilotDb {
    const url = connectionString ?? getEnv().DATABASE_URL;
    if (url.startsWith('pglite:')) {
      return FlowPilotDb.fromClient(connectPglite({ dataDir: pgliteDataDir(url) }));
    }
    return FlowPilotDb.fromClient(new PgClient(url));
  }

  static async pglite(options: { dataDir?: string } = {}): Promise<FlowPilotDb> {
    return FlowPilotDb.fromClient(await PgliteClient.create(options));
  }

  async withTransaction<T>(fn: (db: FlowPilotDb) => Promise<T>): Promise<T> {
    return this.client.transaction(async (tx) => {
      const scoped = new FlowPilotDb(tx, createRepositories(tx));
      return fn(scoped);
    });
  }

  /** Repositories bound to a single queryable — handy for read-only helpers. */
  get queries(): Repositories {
    return this.repos;
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
