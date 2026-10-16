import type { FlowPilotDb } from '@flowpilot/database';
import { actorId, actorLabel, type Actor } from '@flowpilot/domain';
import { newId } from '@flowpilot/shared';

/**
 * Append-only audit trail.
 *
 * Every state-changing action goes through here. Writes take an optional transactional db so an
 * action and its audit record commit together — an audit log that can disagree with the data it
 * describes is worse than none.
 */
export class AuditService {
  constructor(private readonly db: FlowPilotDb) {}

  async record(
    actor: Actor,
    action: string,
    entityType: string,
    entityId: string,
    metadata: Record<string, unknown> = {},
    db: FlowPilotDb = this.db,
  ): Promise<void> {
    await db.repos.audit.record({
      id: newId('audit'),
      orgId: actor.orgId,
      actorKind: actor.kind,
      actorId: actorId(actor),
      actorLabel: actorLabel(actor),
      action,
      entityType,
      entityId,
      metadata,
    });
  }

  async list(
    orgId: string,
    filter: { limit: number; entityType?: string; entityId?: string; actorKind?: string },
  ) {
    return this.db.repos.audit.list(orgId, filter);
  }
}
