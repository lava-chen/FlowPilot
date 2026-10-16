import { ClientReviewDecisionInputSchema } from '@flowpilot/domain';
import { getCore } from '@/lib/runtime';
import { errorResponse, ok, parseBody } from '@/lib/http';

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, context: { params: Promise<{ token: string }> }): Promise<Response> {
  try {
    const { token } = await context.params;
    const portal = await getCore().taskOperations.clientReviewPortal(token);
    return ok(portal, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request, context: { params: Promise<{ token: string }> }): Promise<Response> {
  try {
    const { token } = await context.params;
    const input = await parseBody(request, ClientReviewDecisionInputSchema);
    const review = await getCore().taskOperations.respondToClientReview(token, input);
    return ok({ review }, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
  } catch (error) {
    return errorResponse(error);
  }
}
