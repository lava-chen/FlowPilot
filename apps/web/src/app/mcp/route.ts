/**
 * Single-process MCP bridge.
 *
 * This mounts the *same* `@flowpilot/mcp` handler the standalone server uses, so a tool call
 * arriving here and a tool call arriving at `apps/mcp-server` run identical code against
 * identical services and the same database. Useful for Vercel-style one-service deploys; run the
 * standalone process when the agent surface must be up independently of the dashboard.
 */
import { createMcpHandler } from '@flowpilot/mcp';
import { getCore } from '@/lib/runtime';

export const dynamic = 'force-dynamic';
// The MCP transport needs the raw body; Next's body parser must not consume it first.
export const config = { api: { bodyParser: false } };

let handler: ((request: Request) => Promise<Response>) | null = null;

function getHandler(): (request: Request) => Promise<Response> {
  // Built lazily on first use so `next build` never opens a database connection.
  handler ??= createMcpHandler({
    core: getCore(),
    authenticate: (token: string) => getCore().credentials.authenticate(token),
  });
  return handler;
}

export const GET = (request: Request) => getHandler()(request);
export const POST = (request: Request) => getHandler()(request);
export const DELETE = (request: Request) => getHandler()(request);
