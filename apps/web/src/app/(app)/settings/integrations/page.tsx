import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ArrowRight, Bot, Mail, MessageSquare, Send } from 'lucide-react';
import { can } from '@flowpilot/core';
import type { IntegrationCatalogStatus } from '@flowpilot/domain';
import { requireActor } from '@/lib/auth';
import { getCore } from '@/lib/runtime';
import { ErrorNote } from '@/components/ui/primitives';

export const dynamic = 'force-dynamic';

const STATUS_LABEL: Record<IntegrationCatalogStatus, string> = {
  demo: 'Demo',
  mock: 'Mock',
  not_configured: 'Not configured',
  connected: 'Connected',
  error: 'Error',
  reauth_required: 'Reconnect needed',
};

const STATUS_TONE: Record<IntegrationCatalogStatus, string> = {
  demo: 'bg-amber-50 text-amber-700 ring-amber-200',
  mock: 'bg-violet-50 text-violet-700 ring-violet-200',
  not_configured: 'bg-slate-50 text-slate-600 ring-slate-200',
  connected: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  error: 'bg-rose-50 text-rose-700 ring-rose-200',
  reauth_required: 'bg-orange-50 text-orange-700 ring-orange-200',
};

function iconFor(provider: string) {
  if (provider === 'whatsapp-cloud') return MessageSquare;
  if (provider === 'outlook-graph') return Mail;
  if (provider === 'generic-webhook') return Send;
  if (provider === 'mock-email') return Bot;
  return Mail;
}

export default async function IntegrationsPage() {
  const actor = await requireActor();
  if (!can(actor, 'integrations:read')) redirect('/overview');

  try {
    const integrations = await getCore().integrations.catalog(actor);
    const canManage = can(actor, 'integrations:manage');

    return (
      <div className="mx-auto max-w-3xl space-y-6">
        <header className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-ink-900">Connect your tools</h1>
            <p className="mt-1 text-sm text-ink-500">
              Real channels for customer chat, email, and webhook traffic. Mock connections do
              not require credentials.
            </p>
          </div>
          <Link
            href="/settings/ai"
            className="shrink-0 rounded-lg px-2 py-1 text-sm font-medium text-ink-600 transition-colors hover:bg-slate-100 hover:text-ink-900"
          >
            AI settings <span aria-hidden>→</span>
          </Link>
        </header>

        <ul className="grid gap-3">
          {integrations.map((integration) => {
            const Icon = iconFor(integration.provider);
            const statusLabel = STATUS_LABEL[integration.status];
            const tone = STATUS_TONE[integration.status];
            return (
              <li
                key={integration.provider}
                className="flex items-start gap-4 rounded-xl border border-line bg-white p-4 sm:p-5"
              >
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-slate-50 text-slate-700">
                  <Icon className="h-5 w-5" aria-hidden />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <h2 className="text-sm font-semibold text-ink-900">{integration.displayName}</h2>
                    <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${tone}`}>
                      {statusLabel}
                    </span>
                  </div>
                  <p className="mt-0.5 text-sm text-ink-500">{integration.summary}</p>
                  {integration.lastEventAt && (
                    <p className="mt-1 text-xs text-ink-500">
                      Last event {new Date(integration.lastEventAt).toLocaleString()}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {integration.provider === 'mock-email' && (
                    <Link
                      href="/inbox"
                      className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-white px-3 py-2 text-sm font-medium text-ink-700 transition-colors hover:bg-slate-50"
                    >
                      Open inbox <ArrowRight className="h-4 w-4" aria-hidden />
                    </Link>
                  )}
                  {integration.provider === 'whatsapp-cloud' && (
                    <Link
                      href="/settings/integrations/whatsapp"
                      className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-white px-3 py-2 text-sm font-medium text-ink-700 transition-colors hover:bg-slate-50"
                    >
                      Configure <ArrowRight className="h-4 w-4" aria-hidden />
                    </Link>
                  )}
                  {integration.provider === 'outlook-graph' && (
                    <Link
                      href="/settings/integrations/outlook-graph"
                      className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-white px-3 py-2 text-sm font-medium text-ink-700 transition-colors hover:bg-slate-50"
                    >
                      Connect <ArrowRight className="h-4 w-4" aria-hidden />
                    </Link>
                  )}
                  {canManage && integration.status !== 'connected' && (
                    <span className="text-xs text-ink-500">Manage in API</span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>

        <p className="text-xs text-ink-500">
          Connection management APIs live under <code>/api/integrations/&lt;provider&gt;</code>.
          See <code>docs/architecture.md</code> for the full surface.
        </p>
      </div>
    );
  } catch (error) {
    return (
      <div className="space-y-4">
        <h1 className="text-lg font-semibold text-ink-900">Connect your tools</h1>
        <ErrorNote message={error instanceof Error ? error.message : 'Integration status could not be loaded.'} />
      </div>
    );
  }
}
