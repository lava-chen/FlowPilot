/**
 * Server-side wiring: one database connection and one service graph per server process.
 *
 * Cached on `globalThis` because Next's dev server re-evaluates modules on every hot reload —
 * without this you would leak a Postgres pool per edit.
 */
import { FlowPilotDb } from '@flowpilot/database';
import {
  createAiProviderFromEnv,
  createCoreServices,
  outlookProviderFromEnv,
  type CoreServices,
} from '@flowpilot/core';
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
    const outlookProvider = outlookProviderFromEnv(env);
    const core = createCoreServices({
      db,
      ai: createAiProviderFromEnv(env),
      encryptionSecret: env.SESSION_SECRET,
      outlookProvider,
    });
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

export function isOutlookConfigured(): boolean {
  const env = getEnv();
  return Boolean(
    env.FLOWPILOT_OUTLOOK_CLIENT_ID &&
      env.FLOWPILOT_OUTLOOK_TENANT_ID &&
      env.FLOWPILOT_OUTLOOK_REDIRECT_URI,
  );
}
