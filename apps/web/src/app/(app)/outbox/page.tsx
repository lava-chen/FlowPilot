import { requireActor } from '@/lib/auth';
import { getCore } from '@/lib/runtime';
import { OutboxClient } from './outbox-client';

export const dynamic = 'force-dynamic';

export default async function OutboxPage() {
  const actor = await requireActor();
  const core = getCore();
  const [pending, recent] = await Promise.all([
    core.outbounds.list(actor, { status: ['draft', 'pending_approval'], limit: 50 }),
    core.outbounds.list(actor, {
      status: ['approved', 'sending', 'sent', 'failed', 'rejected'],
      limit: 100,
    }),
  ]);
  return <OutboxClient pending={pending} recent={recent} actorLabel={actor.kind === 'user' ? actor.displayName : actor.label} />;
}
