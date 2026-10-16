import { requireActor } from '@/lib/auth';
import { getCore } from '@/lib/runtime';
import { ErrorNote } from '@/components/ui/primitives';
import { TasksClient } from './tasks-client';

export const dynamic = 'force-dynamic';

export default async function TasksPage({
  searchParams,
}: {
  searchParams: Promise<{ taskId?: string }>;
}) {
  const actor = await requireActor();
  const { taskId } = await searchParams;

  try {
    const core = getCore();
    const board = await core.queries.taskBoard(actor, {});
    return <TasksClient tasks={board.tasks} projects={board.projects} members={board.members} initialTaskId={taskId} />;
  } catch (error) {
    return (
      <div className="space-y-4">
        <h1 className="text-lg font-semibold text-ink-900">Tasks</h1>
        <ErrorNote message={error instanceof Error ? error.message : 'The task board could not be loaded.'} />
      </div>
    );
  }
}
