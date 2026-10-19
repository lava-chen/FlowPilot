import { redirect } from 'next/navigation';
import { can } from '@flowpilot/core';
import { requireActor } from '@/lib/auth';
import { getCore, getDb } from '@/lib/runtime';
import { ErrorNote } from '@/components/ui/primitives';
import { WhatsAppIntegrationClient } from './whatsapp-client';

export const dynamic = 'force-dynamic';

export default async function WhatsappIntegrationPage() {
  const actor = await requireActor();
  if (!can(actor, 'integrations:read')) redirect('/overview');

  try {
    const org = await getDb().repos.organizations.findById(actor.orgId);
    const core = getCore();
    const conns = await core.integrations.listConnections(actor).catch(() => []);
    const conn = conns.find((c) => c.provider === 'whatsapp-cloud') ?? null;

    // Sanitize — never echo back tokens / app secrets.
    const safeConfig = conn
      ? Object.fromEntries(
          Object.entries(conn.config as Record<string, unknown>).filter(
            ([k]) => k !== 'accessToken' && k !== 'appSecret',
          ),
        )
      : {};

    const canManage = can(actor, 'integrations:manage');

    return (
      <div className="mx-auto max-w-3xl space-y-6">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight text-ink-900">WhatsApp Business</h1>
          <p className="mt-1 text-sm text-ink-500">
            Configure the Cloud API webhook and credentials, or run the local demo simulator.
          </p>
        </header>
        {org ? (
          <WhatsAppIntegrationClient
            orgSlug={org.slug}
            connection={
              conn
                ? {
                    id: conn.id,
                    status: conn.status,
                    config: safeConfig,
                    lastEventAt: conn.lastEventAt,
                    createdAt: conn.createdAt,
                  }
                : null
            }
            canManage={canManage}
          />
        ) : (
          <ErrorNote message="Organization could not be loaded." />
        )}
      </div>
    );
  } catch (error) {
    return (
      <div className="space-y-4">
        <h1 className="text-lg font-semibold text-ink-900">WhatsApp Business</h1>
        <ErrorNote message={error instanceof Error ? error.message : 'WhatsApp configuration could not be loaded.'} />
      </div>
    );
  }
}
