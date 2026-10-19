import { z } from 'zod';
import {
  OutboundActionChannelSchema,
  OutboundActionStatusSchema,
  type OutboundActionStatus,
} from '@flowpilot/domain';
import { requireActorOr401 } from '@/lib/auth';
import { getCore } from '@/lib/runtime';
import { errorResponse, ok, parseBody } from '@/lib/http';

export const dynamic = 'force-dynamic';

const ALLOWED_STATUSES = OutboundActionStatusSchema.options;

const ListQuerySchema = z.object({
  status: z.union([z.string(), z.array(z.string())]).optional(),
  requestId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export async function GET(request: Request): Promise<Response> {
  try {
    const auth = await requireActorOr401(request);
    if ('response' in auth) return auth.response;
    const url = new URL(request.url);
    const parsed = ListQuerySchema.parse(Object.fromEntries(url.searchParams));
    const raw = parsed.status ? (Array.isArray(parsed.status) ? parsed.status : [parsed.status]) : [];
    const status = raw.filter((s): s is OutboundActionStatus =>
      (ALLOWED_STATUSES as readonly string[]).includes(s),
    );
    const actions = await getCore().outbounds.list(auth.actor, {
      status: status.length > 0 ? status : undefined,
      limit: parsed.limit,
      requestId: parsed.requestId,
    });
    return ok({ actions });
  } catch (error) {
    return errorResponse(error);
  }
}

const CreateDraftSchema = z.object({
  channel: OutboundActionChannelSchema,
  provider: z.string().min(1),
  to: z.string().min(1),
  subject: z.string().nullish(),
  body: z.string().min(1).max(4000),
  requestId: z.string().nullish(),
  leadId: z.string().nullish(),
  dedupeKey: z.string().optional(),
});

export async function POST(request: Request): Promise<Response> {
  try {
    const auth = await requireActorOr401(request);
    if ('response' in auth) return auth.response;
    const input = await parseBody(request, CreateDraftSchema);
    const action = await getCore().outbounds.createDraft(auth.actor, {
      channel: input.channel,
      provider: input.provider,
      to: input.to,
      subject: input.subject ?? null,
      body: input.body,
      requestId: input.requestId ?? null,
      leadId: input.leadId ?? null,
      dedupeKey: input.dedupeKey,
    });
    return ok({ action });
  } catch (error) {
    return errorResponse(error);
  }
}
