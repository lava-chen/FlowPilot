import { FlowPilotDb } from '@flowpilot/database';
import { createAiProviderFromEnv, createCoreServices } from '@flowpilot/core';
import { getEnv, logger, UnauthenticatedError } from '@flowpilot/shared';
import { createMcpApp } from '@flowpilot/mcp';

const log = logger.child({ app: 'mcp-server' });

/**
 * Standalone MCP server process.
 *
 * It is a thin entrypoint: the transport and every tool live in `@flowpilot/mcp`, which the web
 * app also mounts at `/mcp`. Running this separately means an external agent can reach FlowPilot
 * while the dashboard is down (or on a different host).
 */
async function main(): Promise<void> {
  const env = getEnv();
  const db = FlowPilotDb.connect();
  const core = createCoreServices({ db, ai: createAiProviderFromEnv(env), encryptionSecret: env.SESSION_SECRET });

  const app = createMcpApp({
    core,
    authenticate: async (token) => {
      try {
        return await core.credentials.authenticate(token);
      } catch (error) {
        throw error instanceof UnauthenticatedError ? error : new UnauthenticatedError('Agent token rejected.');
      }
    },
  });

  app.listen(env.MCP_PORT, () => {
    log.info('mcp server listening', {
      port: env.MCP_PORT,
      endpoint: env.MCP_PUBLIC_URL,
      auth: 'bearer agent credential (organization is resolved from the token, never from arguments)',
    });
  });

  const shutdown = async () => {
    log.info('shutting down');
    await db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

void main().catch((error: unknown) => {
  log.error('failed to start mcp server', { error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
