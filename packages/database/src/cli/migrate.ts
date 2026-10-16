#!/usr/bin/env node
import { FlowPilotDb } from '../db.js';
import { migrate } from '../migrator.js';
import { getEnv } from '@flowpilot/shared';

async function main(): Promise<void> {
  const env = getEnv();
  const db = FlowPilotDb.connect();

  try {
    const result = await migrate(db.client, {
      skip: env.FLOWPILOT_ENABLE_RLS ? [] : ['0002_rls.sql'],
    });
    if (result.applied.length === 0) {
      console.log('✔ Database is up to date (no pending migrations).');
    } else {
      console.log(`✔ Applied ${result.applied.length} migration(s): ${result.applied.join(', ')}`);
    }
    if (result.skipped.length > 0) {
      console.log(`  skipped: ${result.skipped.join(', ')} (set FLOWPILOT_ENABLE_RLS=true to include RLS)`);
    }
  } catch (error) {
    console.error('✖ Migration failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    await db.close();
  }
}

void main();
