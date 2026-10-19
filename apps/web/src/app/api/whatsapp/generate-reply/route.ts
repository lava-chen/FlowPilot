import { z } from 'zod';
import { requireActorOr401 } from '@/lib/auth';
import { getCore } from '@/lib/runtime';
import { errorResponse, ok, parseBody } from '@/lib/http';

export const dynamic = 'force-dynamic';

/**
 * Generate a draft reply for a WhatsApp request without ever touching the channel.
 *
 * The dashboard calls this when a PM clicks "Generate reply draft" on an inbound WhatsApp
 * request. The resulting draft OutboundAction lives in the same org-scoped table as manual
 * drafts, and is subject to the same approval gate.
 */
const Schema = z.object({
  requestId: z.string().min(1),
});

export async function POST(request: Request): Promise<Response> {
  try {
    const auth = await requireActorOr401(request);
    if ('response' in auth) return auth.response;
    const input = await parseBody(request, Schema);
    const core = getCore();

    const req = await core.requests.require(auth.actor, input.requestId);
    const draft = await core.whatsappReply.generateAndQueue(auth.actor, {
      requestId: req.id,
      incomingBody: req.rawBody,
      fromName: extractName(req.rawFrom) ?? undefined,
    });
    return ok(draft);
  } catch (error) {
    return errorResponse(error);
  }
}

function extractName(raw: string): string | null {
  const m = raw.match(/^\s*([^<]+?)\s*</);
  return m && m[1] ? m[1].trim() : null;
}
