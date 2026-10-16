import { redirect } from 'next/navigation';
import { requireActor } from '@/lib/auth';
import { getCore } from '@/lib/runtime';
import { can } from '@flowpilot/core';
import { ErrorNote } from '@/components/ui/primitives';
import { AiSettingsClient } from './settings-client';

export const dynamic = 'force-dynamic';

export default async function AiSettingsPage() {
  const actor = await requireActor();
  if (!can(actor, 'integrations:manage')) redirect('/overview');

  try {
    const settings = await getCore().aiSettings.get(actor);
    return <AiSettingsClient initialSettings={settings} />;
  } catch (error) {
    return (
      <div className="space-y-4">
        <h1 className="text-lg font-semibold text-ink-900">AI provider</h1>
        <ErrorNote message={error instanceof Error ? error.message : 'AI provider settings could not be loaded.'} />
      </div>
    );
  }
}
