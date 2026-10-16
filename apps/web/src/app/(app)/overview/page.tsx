import { requireActor } from '@/lib/auth';
import { getCore } from '@/lib/runtime';
import { ErrorNote } from '@/components/ui/primitives';
import { OverviewClient } from './overview-client';

export const dynamic = 'force-dynamic';

export default async function OverviewPage() {
  const actor = await requireActor();

  try {
    const core = getCore();
    const data = await core.queries.overview(actor);
    return <OverviewClient data={data} />;
  } catch (error) {
    return (
      <div className="space-y-4">
        <h1 className="text-lg font-semibold text-ink-900">Overview</h1>
        <ErrorNote message={error instanceof Error ? error.message : 'The overview could not be loaded.'} />
      </div>
    );
  }
}
