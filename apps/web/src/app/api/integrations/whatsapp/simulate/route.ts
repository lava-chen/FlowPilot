import { z } from 'zod';
import { requireActorOr401 } from '@/lib/auth';
import { getCore } from '@/lib/runtime';
import { errorResponse, ok, parseBody } from '@/lib/http';
import { handleWhatsAppEvents } from '@flowpilot/integrations';
import { getEnv } from '@flowpilot/shared';

export const dynamic = 'force-dynamic';

/**
 * "Simulate inbound WhatsApp" — the dashboard demo button that exercises the same code path
 * a real webhook would: signature verification is skipped because this is a self-signed
 * event, but the rest of the pipeline (payload normalization, ingestion, dedupe, AI analysis,
 * draft creation) is exercised verbatim.
 *
 * Gated on `FLOWPILOT_DEMO_MODE` so production never has a way to forge an event.
 */
const SimulateSchema = z.object({
  from: z.string().min(1),
  fromName: z.string().optional(),
  body: z.string().min(1),
  phoneNumberId: z.string().default('mock-phone-id'),
  externalId: z.string().optional(),
  businessAccountId: z.string().optional(),
});

export async function POST(request: Request): Promise<Response> {
  try {
    const auth = await requireActorOr401(request);
    if ('response' in auth) return auth.response;
    if (!getEnv().FLOWPILOT_DEMO_MODE) {
      return Response.json(
        { error: { code: 'forbidden', message: 'Simulated WhatsApp is disabled (FLOWPILOT_DEMO_MODE=false).' } },
        { status: 403 },
      );
    }
    const input = await parseBody(request, SimulateSchema);
    const externalId = input.externalId ?? `sim-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const result = await handleWhatsAppEvents({
      core: getCore(),
      actor: auth.actor,
      events: {
        messages: [
          {
            externalId,
            from: input.from,
            fromName: input.fromName ?? null,
            phoneNumberId: input.phoneNumberId,
            type: 'text',
            body: input.body,
            receivedAt: new Date().toISOString(),
            businessAccountId: input.businessAccountId ?? null,
            displayPhoneNumber: null,
          },
        ],
        statuses: [],
      },
    });
    return ok({
      externalId,
      ingested: result.ingested,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
