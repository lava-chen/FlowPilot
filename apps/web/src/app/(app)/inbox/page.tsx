import { requireActor } from '@/lib/auth';
import { getCore } from '@/lib/runtime';
import { ErrorNote } from '@/components/ui/primitives';
import { InboxClient } from './inbox-client';

export const dynamic = 'force-dynamic';

export default async function InboxPage() {
  const actor = await requireActor();

  try {
    const core = getCore();
    const [inbox, projects] = await Promise.all([
      core.queries.inbox(actor, { limit: 50 }),
      core.queries.projects(actor),
    ]);
    return <InboxClient requests={inbox.requests} projects={projects} />;
  } catch (error) {
    return (
      <div className="space-y-4">
        <h1 className="text-lg font-semibold text-ink-900">AI Inbox</h1>
        <ErrorNote message={error instanceof Error ? error.message : 'The inbox could not be loaded.'} />
      </div>
    );
  }
}
