import { requireActor } from '@/lib/auth';
import { getCore } from '@/lib/runtime';
import { ErrorNote } from '@/components/ui/primitives';
import { ActivityClient } from './activity-client';

export const dynamic = 'force-dynamic';

export default async function ActivityPage() {
  const actor = await requireActor();

  try {
    const core = getCore();
    const data = await core.queries.activity(actor, 40);
    return <ActivityClient data={data} />;
  } catch (error) {
    return (
      <div className="space-y-4">
        <h1 className="text-lg font-semibold text-ink-900">Activity</h1>
        <ErrorNote message={error instanceof Error ? error.message : 'Activity could not be loaded.'} />
      </div>
    );
  }
}
