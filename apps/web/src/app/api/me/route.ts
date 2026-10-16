import { getActor } from '@/lib/auth';
import { getDb } from '@/lib/runtime';
import { ok } from '@/lib/http';

export const dynamic = 'force-dynamic';

/** Who am I? Used by the shell to render the sidebar without duplicating auth logic. */
export async function GET(): Promise<Response> {
  const actor = await getActor();
  if (!actor) return ok({ actor: null });

  const db = getDb();
  const organization = await db.repos.organizations.findById(actor.orgId);
  const capabilities =
    actor.kind === 'user' ? (await import('@flowpilot/core')).describeCapabilities(actor) : [];

  return ok({
    actor: {
      kind: actor.kind,
      name: actor.kind === 'user' ? actor.displayName : actor.label,
      email: actor.kind === 'user' ? actor.email : null,
      role: actor.kind === 'user' ? actor.role : 'agent',
      orgId: actor.orgId,
    },
    organization: organization ? { id: organization.id, name: organization.name, slug: organization.slug } : null,
    capabilities,
  });
}
