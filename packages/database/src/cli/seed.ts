#!/usr/bin/env node
import { FlowPilotDb } from '../db.js';
import { migrate } from '../migrator.js';
import { seed } from '../seed.js';
import { getEnv } from '@flowpilot/shared';

async function main(): Promise<void> {
  const env = getEnv();
  const db = FlowPilotDb.connect();

  try {
    await migrate(db.client, { skip: env.FLOWPILOT_ENABLE_RLS ? [] : ['0002_rls.sql'] });
    const result = await seed(db.client, { demoToken: env.FLOWPILOT_DEMO_MODE });

    if (!result.created) {
      console.log('ℹ Demo tenant already present — nothing to seed.');
    } else {
      console.log('✔ Seeded Northline Creative (simulated demo data):');
      for (const [table, count] of Object.entries(result.counts)) {
        console.log(`    ${table.padEnd(14)} ${count}`);
      }
    }

    if (result.demoToken) {
      console.log('');
      console.log('  Demo MCP agent token (local development only — revoke it after the demo):');
      console.log(`    ${result.demoToken}`);
      console.log('');
      console.log('  Dashboard sign-in (password: demo1234):');
      console.log('    dana@northlinecreative.com (owner)   marcus@northlinecreative.com (admin)');
      console.log('    priya@northlinecreative.com (manager) theo@northlinecreative.com (member)');
    }
  } catch (error) {
    console.error('✖ Seed failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    await db.close();
  }
}

void main();
