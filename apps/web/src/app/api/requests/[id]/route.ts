import { z } from 'zod';
import { AnalyzeRequestInputSchema } from '@flowpilot/domain';
import { requireActorOr401 } from '@/lib/auth';
import { getCore } from '@/lib/runtime';
import { errorResponse, ok, parseBody } from '@/lib/http';

export const dynamic = 'force-dynamic';

/** Run (or re-run) the AI analysis for one request. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const auth = await requireActorOr401(request);
    if ('response' in auth) return auth.response;

    const { id } = await context.params;
    const input = await parseBody(request, AnalyzeRequestInputSchema);
    const core = getCore();

    const result = await core.requests.analyze(auth.actor, await core.aiFor(auth.actor), { requestId: input.requestId ?? id });
    if (result.analyzed.length === 0 && result.errors.length > 0) {
      return Response.json({ error: { code: 'integration_error', message: result.errors[0]?.error, details: {} } }, { status: 502 });
    }

    return ok({ request: result.analyzed[0], errors: result.errors });
  } catch (error) {
    return errorResponse(error);
  }
}

const PatchRequestSchema = z.object({
  projectId: z.string().min(1),
  clientId: z.string().nullable().optional(),
});

/** A human correcting the analyzer's project/client guess. */
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const auth = await requireActorOr401(request);
    if ('response' in auth) return auth.response;

    const { id } = await context.params;
    const input = await parseBody(request, PatchRequestSchema);
    const core = getCore();

    const project = await core.db.repos.projects.require(auth.actor.orgId, input.projectId);
    await core.requests.linkRequest(auth.actor, id, project.id, input.clientId ?? project.clientId);
    await core.audit.record(auth.actor, 'request.project_linked', 'request', id, { projectId: project.id });

    return ok({ request: await core.requests.require(auth.actor, id) });
  } catch (error) {
    return errorResponse(error);
  }
}
