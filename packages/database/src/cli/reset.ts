#!/usr/bin/env node
import { FlowPilotDb } from '../db.js';
import { migrate } from '../migrator.js';
import { seed } from '../seed.js';
import { getEnv } from '@flowpilot/shared';

/** Destructive: drops every FlowPilot table, then migrates and seeds from scratch. */
async function main(): Promise<void> {
  const env = getEnv();
  if (!/localhost|127\.0\.0\.1|database\.url|db\.internal|test/i.test(env.DATABASE_URL)) {
    console.error(`✖ Refusing to reset a non-local database (${new URL(env.DATABASE_URL).host}).`);
    process.exitCode = 1;
    return;
  }

  const db = FlowPilotDb.connect();
  try {
    console.log('… dropping schema public cascade');
    await db.client.exec('drop schema public cascade; create schema public;');
    await migrate(db.client, { skip: env.FLOWPILOT_ENABLE_RLS ? [] : ['0002_rls.sql'] });
    const result = await seed(db.client, { demoToken: env.FLOWPILOT_DEMO_MODE });
    console.log(result.created ? '✔ Reset complete and demo data reseeded.' : 'ℹ Reset complete.');
  } catch (error) {
    console.error('✖ Reset failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    await db.close();
  }
}

void main();
