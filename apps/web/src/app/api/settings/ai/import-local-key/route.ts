import { z } from 'zod';
import { requireActorOr401 } from '@/lib/auth';
import { getCore } from '@/lib/runtime';
import { LOCAL_AI_CREDENTIAL_PROVIDERS, readLocalAiCredential } from '@/lib/local-ai-credentials';
import { errorResponse, ok, parseBody } from '@/lib/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ImportSchema = z.object({
  localProvider: z.enum(LOCAL_AI_CREDENTIAL_PROVIDERS),
  baseUrl: z.string().min(1).max(2048),
  model: z.string().min(1).max(160),
});

export async function POST(request: Request): Promise<Response> {
  try {
    const auth = await requireActorOr401(request);
    if ('response' in auth) return auth.response;
    const input = await parseBody(request, ImportSchema);
    const core = getCore();
    await core.aiSettings.get(auth.actor);
    const apiKey = await readLocalAiCredential(input.localProvider);
    const settings = await core.aiSettings.save(auth.actor, {
      provider: 'openai-compatible',
      baseUrl: input.baseUrl,
      model: input.model,
      apiKey,
    });
    return ok({ settings, importedFrom: input.localProvider });
  } catch (error) {
    return errorResponse(error);
  }
}
