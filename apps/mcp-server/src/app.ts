import { randomUUID } from 'node:crypto';
import express, { type Express, type Request, type Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolResultSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { isAppError, logger, toMessage } from '@flowpilot/shared';
import type { Actor } from '@flowpilot/domain';
import type { CoreServices } from '@flowpilot/core';
import { registerTools } from './tools.js';

const log = logger.child({ app: 'mcp-server' });

export interface McpAppOptions {
  core: CoreServices;
  /** Resolves a bearer token to an agent actor. Throws UnauthenticatedError when invalid. */
  authenticate(token: string): Promise<Actor>;
  /** Exposed for the dashboard bridge. */
  enableJsonRpcAlias?: boolean;
}

function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? null;
}

/**
 * Builds the MCP HTTP app.
 *
 * Transport choice — **stateless Streamable HTTP**: `sessionIdGenerator: undefined` means each
 * POST is self-contained, so the server can scale horizontally and a crashed request cannot wedge
 * a client. That is the right trade for an agent tool API whose calls are individually small.
 * A server with SSE resumption streams or subscriptions would want stateful sessions instead;
 * `docs/architecture.md` records that trade-off.
 */
export function createMcpApp(options: McpAppOptions): Express {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ ok: true, service: 'flowpilot-mcp', transport: 'streamable-http', mode: 'stateless' });
  });

  const handler = async (req: Request, res: Response): Promise<void> => {
    const token = bearerToken(req.header('authorization') ?? undefined);
    if (!token) {
      // JSON-RPC shaped, not an HTML 401: an MCP client should see a protocol error.
      res.status(401).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Missing Authorization: Bearer <agent token> header.' },
        id: null,
      });
      return;
    }

    let actor: Actor;
    try {
      actor = await options.authenticate(token);
    } catch (error) {
      const code = isAppError(error) ? error.jsonRpcCode : -32001;
      res.status(401).json({ jsonrpc: '2.0', error: { code, message: toMessage(error) }, id: null });
      return;
    }

    // One server + one transport per request (stateless mode).
    const server = new McpServer(
      { name: 'flowpilot', version: '0.1.0' },
      { capabilities: { tools: {} }, instructions: MCP_INSTRUCTIONS },
    );
    registerTools(server, { core: options.core, actor });

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    res.on('close', () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      log.error('mcp request failed', { error: toMessage(error), path: req.path, requestId: randomUUID() });
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error.' }, id: null });
      }
    }
  };

  app.post('/mcp', handler);
  app.post('/messages', handler); // legacy Claude Desktop transport alias
  if (options.enableJsonRpcAlias !== false) app.post('/', handler);

  app.all('/mcp', (_req: Request, res: Response) => {
    res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Use POST for MCP requests.' }, id: null });
  });

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: { code: 'not_found', message: 'Unknown endpoint.' } });
  });

  return app;
}

const MCP_INSTRUCTIONS = `FlowPilot exposes the workflow of a creative agency: inbound client requests,
AI-extracted task drafts, and the approval pipeline behind them.

Typical flow:
  1. list_requests(status=["new"])  — find work that has not been processed.
  2. analyze_request(requestId)    — extract client/project/priority/due date/assignee.
  3. create_task_draft(requestId)  — propose a task. It stays a draft.
  4. request_task_approval(taskId)  — ask a project manager to review it.

You cannot approve work, and you cannot act on behalf of another organization: the credential is
bound to one tenant. Never invent client, project or user ids — list_projects and list_tasks
return the real ones.`;

export { CallToolResultSchema, ListToolsRequestSchema };
