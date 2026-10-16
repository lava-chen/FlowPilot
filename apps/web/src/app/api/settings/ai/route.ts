import { z } from 'zod';
import { requireActorOr401 } from '@/lib/auth';
import { getCore } from '@/lib/runtime';
import { errorResponse, ok, parseBody } from '@/lib/http';

export const dynamic = 'force-dynamic';

const UpdateAiSettingsSchema = z.object({
  provider: z.enum(['deterministic', 'openai-compatible']),
  baseUrl: z.string().max(2048).optional(),
  model: z.string().max(160).optional(),
  apiKey: z.string().max(4096).optional(),
});

export async function GET(request: Request): Promise<Response> {
  try {
    const auth = await requireActorOr401(request);
    if ('response' in auth) return auth.response;
    const core = getCore();
    return ok({ settings: await core.aiSettings.get(auth.actor) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PUT(request: Request): Promise<Response> {
  try {
    const auth = await requireActorOr401(request);
    if ('response' in auth) return auth.response;
    const input = await parseBody(request, UpdateAiSettingsSchema);
    const core = getCore();
    return ok({ settings: await core.aiSettings.save(auth.actor, input) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const auth = await requireActorOr401(request);
    if ('response' in auth) return auth.response;
    const result = await getCore().aiSettings.testConnection(auth.actor);
    return ok(result);
  } catch (error) {
    return errorResponse(error);
  }
}
