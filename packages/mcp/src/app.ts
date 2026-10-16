import express, { type Express, type Request as ExpressRequest, type Response as ExpressResponse } from 'express';
import { createMcpHandler, type McpDeps } from './handler.js';

/**
 * Node/Express wrapper around the framework-agnostic MCP handler.
 *
 * Kept deliberately thin: it converts a Node request into a web `Request`, calls the shared
 * handler, and writes the resulting `Response` back. All protocol logic lives in `handler.ts`,
 * which the Next.js route also uses.
 */
export function createMcpApp(deps: McpDeps): Express {
  const handleMcp = createMcpHandler(deps);
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'flowpilot-mcp', transport: 'streamable-http', mode: 'stateless' });
  });

  app.post('/mcp', (req, res) => void bridge(req, res, handleMcp));
  app.post('/messages', (req, res) => void bridge(req, res, handleMcp)); // Claude Desktop legacy alias

  app.all('/mcp', (_req, res) => {
    res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Use POST for MCP requests.' }, id: null });
  });

  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'not_found', message: 'Unknown endpoint.' } });
  });

  return app;
}

async function bridge(
  req: ExpressRequest,
  res: ExpressResponse,
  handleMcp: (request: Request) => Promise<Response>,
): Promise<void> {
  const url = `http://${req.headers.host ?? 'localhost'}${req.originalUrl}`;
  const webRequest = new Request(url, {
    method: req.method,
    headers: req.headers as Record<string, string>,
    // `express.json()` already parsed the body; pass it through so the transport does not
    // re-read a consumed stream.
    body: JSON.stringify(req.body ?? {}),
  });

  const response = await handleMcp(webRequest);
  res.status(response.status);
  response.headers.forEach((value, key) => res.append(key, value));
  res.send(await response.text());
}
