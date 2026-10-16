import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ArrowRight, Mail } from 'lucide-react';
import { can } from '@flowpilot/core';
import { requireActor } from '@/lib/auth';
import { getDb } from '@/lib/runtime';
import { ErrorNote } from '@/components/ui/primitives';

const PLANNED_CONNECTORS = ['Gmail', 'Slack', 'ClickUp', 'Drive', 'Figma', 'Hubstaff'];

export const dynamic = 'force-dynamic';

export default async function IntegrationsPage() {
  const actor = await requireActor();
  if (!can(actor, 'integrations:manage')) redirect('/overview');

  try {
    const connections = await getDb().repos.integrations.list(actor.orgId);
    const demoEmail = connections.find((connection) => connection.provider === 'mock-email');
    const connectedCount = connections.filter((connection) => connection.provider !== 'mock-email' && connection.status === 'connected').length;

    return (
      <div className="mx-auto max-w-3xl space-y-6">
        <header className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-ink-900">Connect your tools</h1>
            <p className="mt-1 text-sm text-ink-500">Choose one workflow to start.</p>
          </div>
          <Link href="/settings/ai" className="shrink-0 rounded-lg px-2 py-1 text-sm font-medium text-ink-600 transition-colors hover:bg-slate-100 hover:text-ink-900">
            AI settings <span aria-hidden>→</span>
          </Link>
        </header>

        <Link href="/inbox" className="group flex items-center gap-4 rounded-xl border border-line bg-white p-4 transition-colors hover:border-indigo-200 hover:bg-indigo-50/40 sm:p-5">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-indigo-50 text-indigo-700">
            <Mail className="h-5 w-5" aria-hidden />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold text-ink-900">Try sample email intake</span>
            <span className="mt-0.5 block text-sm text-ink-500">A demo message shows how requests enter FlowPilot.</span>
          </span>
          <span className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white transition-colors group-hover:bg-accent/90">
            Open inbox <ArrowRight className="h-4 w-4" aria-hidden />
          </span>
        </Link>

        <section className="rounded-xl border border-line bg-white p-4 sm:p-5" aria-labelledby="real-connections-heading">
          <div className="flex items-center justify-between gap-3">
            <h2 id="real-connections-heading" className="text-sm font-semibold text-ink-900">Real connections</h2>
            <span className="text-xs text-ink-500">{connectedCount} connected</span>
          </div>
          <p className="mt-1 text-sm text-ink-500">
            {connectedCount === 0 ? 'External sign-in is not available yet.' : 'Manage connected services here.'}
          </p>
          <details className="mt-4 border-t border-line pt-3">
            <summary className="w-fit cursor-pointer text-sm font-medium text-accent hover:text-indigo-700">
              See planned services
            </summary>
            <p className="mt-2 text-sm text-ink-600">{PLANNED_CONNECTORS.join(' · ')}</p>
          </details>
        </section>

        <p className="text-xs text-ink-500">
          {demoEmail?.status === 'connected' ? 'Sample intake is ready.' : 'Sample intake is for demo use only; it does not access a real mailbox.'}
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
