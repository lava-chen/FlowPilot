import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

const r = (p: string) => resolve(__dirname, p);

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    // Each suite creates its own throwaway PGlite database; keep them from thrashing.
    pool: 'forks',
    poolOptions: { forks: { singleFork: false } },
    testTimeout: 60_000,
    hookTimeout: 60_000,
    reporters: ['default'],
  },
  resolve: {
    alias: [
      // The web app's own "@/..." convention (matches apps/web/tsconfig.json paths).
      { find: /^@\/(.*)$/, replacement: r('apps/web/src/$1') },
      { find: /^@flowpilot\/shared$/, replacement: r('packages/shared/src/index.ts') },
      { find: /^@flowpilot\/domain$/, replacement: r('packages/domain/src/index.ts') },
      { find: /^@flowpilot\/database$/, replacement: r('packages/database/src/index.ts') },
      { find: /^@flowpilot\/core$/, replacement: r('packages/core/src/index.ts') },
      { find: /^@flowpilot\/integrations$/, replacement: r('packages/integrations/src/index.ts') },
      { find: /^@flowpilot\/mcp$/, replacement: r('packages/mcp/src/index.ts') },
      { find: /^@flowpilot\/mcp\/(.*)$/, replacement: r('packages/mcp/src/$1') },
    ],
  },
});
