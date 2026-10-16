import { SimulateEmailInputSchema } from '@flowpilot/domain';
import { getEnv } from '@flowpilot/shared';
import { requireActorOr401 } from '@/lib/auth';
import { getInbox } from '@/lib/runtime';
import { errorResponse, ok, parseBody } from '@/lib/http';

export const dynamic = 'force-dynamic';

/**
 * Triggers the mock inbound email 鈥?the demo's "a client just sent something" button.
 *
 * Gated on FLOWPILOT_DEMO_MODE so it cannot be mistaken for a real ingestion endpoint, and it
 * runs the same adapter 鈫?ingest 鈫?analyze 鈫?draft path a Gmail connector will run later.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const auth = await requireActorOr401(request);
    if ('response' in auth) return auth.response;

    if (!getEnv().FLOWPILOT_DEMO_MODE) {
      return Response.json(
        { error: { code: 'forbidden', message: 'Simulated email is disabled (FLOWPILOT_DEMO_MODE=false).', details: {} } },
        { status: 403 },
      );
    }

    const input = await parseBody(request, SimulateEmailInputSchema);
    const inbox = getInbox();
    const result = await inbox.simulate(auth.actor, { templateId: input.templateId, createDraft: input.autoCreateDraft });

    return ok(result);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function GET(request: Request): Promise<Response> {
  try {
    const auth = await requireActorOr401(request);
    if ('response' in auth) return auth.response;

    const { MockEmailAdapter } = await import('@flowpilot/integrations');
    return ok({ templates: new MockEmailAdapter().listTemplates() });
  } catch (error) {
    return errorResponse(error);
  }
}
