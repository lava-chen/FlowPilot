/**
 * Server-side wiring: one database connection and one service graph per server process.
 *
 * Cached on `globalThis` because Next's dev server re-evaluates modules on every hot reload —
 * without this you would leak a Postgres pool per edit.
 */
import { FlowPilotDb } from '@flowpilot/database';
import { createAiProviderFromEnv, createCoreServices, type CoreServices } from '@flowpilot/core';
import { InboxTriggerService } from '@flowpilot/integrations';
import { getEnv } from '@flowpilot/shared';

interface Runtime {
  db: FlowPilotDb;
  core: CoreServices;
  inbox: InboxTriggerService;
}

const globalRef = globalThis as typeof globalThis & { __flowpilot?: Runtime };

export function getRuntime(): Runtime {
  if (!globalRef.__flowpilot) {
    const env = getEnv();
    const db = FlowPilotDb.connect(env.DATABASE_URL);
    const core = createCoreServices({ db, ai: createAiProviderFromEnv(env), encryptionSecret: env.SESSION_SECRET });
    globalRef.__flowpilot = { db, core, inbox: new InboxTriggerService(core) };
  }
  return globalRef.__flowpilot;
}

export function getCore(): CoreServices {
  return getRuntime().core;
}

export function getDb(): FlowPilotDb {
  return getRuntime().db;
}

export function getInbox(): InboxTriggerService {
  return getRuntime().inbox;
}
