import { NextRequest } from 'next/server';
import { z } from 'zod';
import { requireActorOr401 } from '@/lib/auth';
import { getCore, isOutlookConfigured } from '@/lib/runtime';
import { errorResponse, ok, parseBody } from '@/lib/http';
import { ValidationError } from '@flowpilot/shared';

export const dynamic = 'force-dynamic';

const SyncSchema = z.object({
  folder: z.enum(['inbox', 'junkemail']).optional(),
  resetCursor: z.boolean().optional(),
});

/**
 * POST /api/integrations/outlook-graph/sync
 *
 * Triggers one delta-query round through Microsoft Graph. Returns the cycle summary so
 * the dashboard button can render a "5 ingested · 0 duplicates" toast.
 */
export async function POST(request: NextRequest): Promise<Response> {
  try {
    const auth = await requireActorOr401(request);
    if ('response' in auth) return auth.response;
    if (!isOutlookConfigured()) {
      return errorResponse(
        new ValidationError('Outlook is not configured on this deployment.'),
      );
    }
    let input: z.infer<typeof SyncSchema> = {};
    if (request.headers.get('content-length') && request.headers.get('content-length') !== '0') {
      input = await parseBody(request, SyncSchema);
    }
    const core = getCore();
    if (input.resetCursor) {
      await core.outlookSync.resetCursor(auth.actor, 'outlook-graph');
    }
    const result = await core.outlookSync.syncOnce(auth.actor, {
      folder: input.folder,
      maxPages: 5,
    });
    const cursor = await core.outlookSync.getCursor(auth.actor, 'outlook-graph');
    return ok({
      result,
      cursor: cursor
        ? {
            lastSyncedAt: cursor.lastSyncedAt,
            totalIngested: cursor.totalIngested,
          }
        : null,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

/** GET — peek at cursor metadata without running a sync. */
export async function GET(request: NextRequest): Promise<Response> {
  try {
    const auth = await requireActorOr401(request);
    if ('response' in auth) return auth.response;
    if (!isOutlookConfigured()) {
      return errorResponse(
        new ValidationError('Outlook is not configured on this deployment.'),
      );
    }
    const cursor = await getCore().outlookSync.getCursor(auth.actor, 'outlook-graph');
    const tokens = await getCore().db.repos.oauthTokens.get(auth.actor.orgId, 'outlook-graph');
    return ok({
      cursor: cursor
        ? {
            lastSyncedAt: cursor.lastSyncedAt,
            totalIngested: cursor.totalIngested,
            metadata: cursor.metadata,
          }
        : null,
      connected: tokens !== null,
      accountLabel: tokens?.accountLabel ?? null,
      scopes: tokens?.scopes ?? [],
    });
  } catch (error) {
    return errorResponse(error);
  }
}
