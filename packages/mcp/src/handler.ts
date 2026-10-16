import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { isAppError, logger, toMessage } from '@flowpilot/shared';
import type { Actor } from '@flowpilot/domain';
import type { CoreServices } from '@flowpilot/core';
import { registerTools } from './tools.js';

const log = logger.child({ app: 'mcp' });

export interface McpDeps {
  core: CoreServices;
  /**
   * Resolves a bearer token to an agent actor.
   *
   * The organization comes from the credential row, never from the request body — that is the
   * whole of tenant isolation on this surface.
   */
  authenticate(token: string): Promise<Actor>;
}

/**
 * The MCP request handler, expressed against the web `Request`/`Response` standard.
 *
 * Framework-agnostic on purpose: the standalone Node server adapts it to `node:http`, and the
 * Next.js route (`apps/web/src/app/mcp`) mounts it directly. Both therefore run *this* code
 * against the *same* services, so "MCP and the dashboard share one brain" is a structural fact
 * rather than a convention.
 *
 * Transport notes:
 *  - Stateless Streamable HTTP: `sessionIdGenerator: undefined`, so every POST is self-contained.
 *    That scales horizontally and means a crashed request cannot wedge a client. Add SSE
 *    resumability / notifications later and revisit this choice.
 *  - `enableJsonResponse: true` keeps responses as plain JSON instead of an SSE stream, which is
 *    what most agent clients prefer for short tool calls.
 */
export function createMcpHandler(deps: McpDeps): (request: Request) => Promise<Response> {
  return async function handleMcpRequest(request: Request): Promise<Response> {
    const token = bearerToken(request.headers.get('authorization') ?? undefined);
    if (!token) {
      // A JSON-RPC shaped error, not an HTML 401: an MCP client should see a protocol failure.
      return rpcError(401, -32001, 'Missing Authorization: Bearer <agent token> header.');
    }

    let actor: Actor;
    try {
      actor = await deps.authenticate(token);
    } catch (error) {
      const code = isAppError(error) ? error.jsonRpcCode : -32001;
      return rpcError(401, code, toMessage(error));
    }

    // One server + one transport per request (stateless mode).
    const server = new McpServer(
      { name: 'flowpilot', version: '0.1.0' },
      { capabilities: { tools: {} }, instructions: MCP_INSTRUCTIONS },
    );
    registerTools(server, { core: deps.core, actor });

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    try {
      await server.connect(transport);
      return await transport.handleRequest(request);
    } catch (error) {
      log.error('mcp request failed', { error: toMessage(error), path: new URL(request.url).pathname });
      return rpcError(500, -32603, 'Internal server error.');
    } finally {
      await transport.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  };
}

function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? null;
}

function rpcError(status: number, code: number, message: string): Response {
  return Response.json({ jsonrpc: '2.0', error: { code, message }, id: null }, { status });
}

const MCP_INSTRUCTIONS = `FlowPilot exposes the workflow of a creative agency: inbound client requests,
AI-extracted task drafts, and the approval pipeline behind them.

Typical flow:
  1. list_requests(status=["new"])  — find work that has not been processed.
  2. analyze_request(requestId)    — extract client/project/priority/due date/assignee.
  3. create_task_draft(requestId)  — propose a task. It stays a draft.
  4. request_task_approval(taskId)  — ask a project manager to review it.

Use get_team_capacity for estimated work due this week against member capacity, and get_task for blockers,
checklist progress, delivery links, logged time and separate client sign-off status. Estimates are not actual time.

You cannot approve work, and you cannot act on behalf of another organization: the credential is
bound to one tenant. Never invent client, project or user ids — list_projects and list_tasks
return the real ones.`;
