import { redirect } from 'next/navigation';
import { can } from '@flowpilot/core';
import { requireActor } from '@/lib/auth';
import { getCore, isOutlookConfigured } from '@/lib/runtime';
import { ErrorNote } from '@/components/ui/primitives';
import { OutlookIntegrationClient } from './outlook-client';

export const dynamic = 'force-dynamic';

export default async function OutlookIntegrationPage({
  searchParams,
}: {
  searchParams?: Promise<{ outlook?: string; reason?: string }>;
}) {
  const actor = await requireActor();
  if (!can(actor, 'integrations:read')) redirect('/overview');

  const params = searchParams ? await searchParams : {};
  const flash = params.outlook ?? null;
  const flashReason = params.reason ?? null;

  if (!isOutlookConfigured()) {
    return (
      <div className="mx-auto max-w-3xl space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight text-ink-900">Microsoft Outlook</h1>
        <ErrorNote message="Outlook is not configured on this FlowPilot deployment. Set FLOWPILOT_OUTLOOK_CLIENT_ID, FLOWPILOT_OUTLOOK_TENANT_ID, and FLOWPILOT_OUTLOOK_REDIRECT_URI in the environment, register the redirect URI in your Entra (Azure AD) app, then reload." />
      </div>
    );
  }

  try {
    const core = getCore();
    const status = await fetch('http://placeholder').catch(() => null);
    void status;
    const conns = await core.integrations.listConnections(actor).catch(() => []);
    const conn = conns.find((c) => c.provider === 'outlook-graph') ?? null;
    const tokens = await core.db.repos.oauthTokens.get(actor.orgId, 'outlook-graph');
    const cursor = await core.outlookSync.getCursor(actor, 'outlook-graph');
    return (
      <OutlookIntegrationClient
        canManage={can(actor, 'integrations:manage')}
        connection={
          conn
            ? {
                id: conn.id,
                status: conn.status,
                config: (conn.config as Record<string, unknown>) ?? {},
                lastEventAt: conn.lastEventAt,
                createdAt: conn.createdAt,
              }
            : null
        }
        tokens={
          tokens
            ? {
                accountLabel: tokens.accountLabel,
                scopes: tokens.scopes,
                refreshedAt: tokens.refreshedAt,
                accessExpiresAt: tokens.accessExpiresAt,
              }
            : null
        }
        cursor={
          cursor
            ? {
                lastSyncedAt: cursor.lastSyncedAt,
                totalIngested: cursor.totalIngested,
                metadata: cursor.metadata,
              }
            : null
        }
        flash={flash}
        flashReason={flashReason}
      />
    );
  } catch (error) {
    return (
      <div className="space-y-4">
        <h1 className="text-lg font-semibold text-ink-900">Microsoft Outlook</h1>
        <ErrorNote message={error instanceof Error ? error.message : 'Outlook configuration could not be loaded.'} />
      </div>
    );
  }
}
