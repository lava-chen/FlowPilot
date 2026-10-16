import { Sidebar, DemoBanner } from '@/components/shell';
import { requireActor } from '@/lib/auth';
import { getDb } from '@/lib/runtime';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const actor = await requireActor();
  const db = getDb();
  const organization = await db.repos.organizations.findById(actor.orgId);

  return (
    <div className="flex min-h-screen flex-col md:h-dvh md:min-h-0 md:flex-row md:overflow-hidden">
      <Sidebar
        organizationName={organization?.name ?? 'Organization'}
        userName={actor.kind === 'user' ? actor.displayName : actor.label}
        userRole={actor.kind === 'user' ? actor.role : 'agent'}
      />
      <div className="flex min-w-0 flex-1 flex-col md:h-dvh md:min-h-0 md:overflow-y-auto">
        <DemoBanner />
        <main className="min-w-0 flex-1 px-4 py-6 md:px-8">{children}</main>
      </div>
    </div>
  );
}
