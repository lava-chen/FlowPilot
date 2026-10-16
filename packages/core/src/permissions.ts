import { ForbiddenError } from '@flowpilot/shared';
import type { Actor, MembershipRole, Scope } from '@flowpilot/domain';

/**
 * The single permission matrix.
 *
 * Both entry points call into this file — there is no second copy in the web app or the MCP
 * server. Two rules are load-bearing:
 *
 *  1. **Approvals are human-only.** No agent scope maps to `approve`. An agent can move a task
 *     to `pending_approval`, but releasing work to a crew is a person's decision.
 *  2. **A member may only transition their own assigned tasks.** Owning the `tasks:transition`
 *     capability does not let a member touch somebody else's board.
 */

export type Capability =
  | 'projects:read'
  | 'tasks:read'
  | 'tasks:write'
  | 'tasks:contribute'
  | 'tasks:transition'
  | 'tasks:transition:any'
  /** draft -> pending_approval only. Grants "ask a human to look", never "approve". */
  | 'tasks:submit'
  | 'requests:read'
  | 'requests:ingest'
  | 'requests:analyze'
  | 'drafts:create'
  | 'approvals:decide'
  | 'credentials:manage'
  | 'integrations:manage';

const ROLE_CAPABILITIES: Record<MembershipRole, readonly Capability[]> = {
  owner: [
    'projects:read',
    'tasks:read',
    'tasks:write',
    'tasks:contribute',
    'tasks:transition',
    'tasks:transition:any',
    'requests:read',
    'requests:ingest',
    'requests:analyze',
    'drafts:create',
    'tasks:submit',
    'approvals:decide',
    'credentials:manage',
    'integrations:manage',
  ],
  admin: [
    'projects:read',
    'tasks:read',
    'tasks:write',
    'tasks:contribute',
    'tasks:transition',
    'tasks:transition:any',
    'requests:read',
    'requests:ingest',
    'requests:analyze',
    'drafts:create',
    'tasks:submit',
    'approvals:decide',
    'credentials:manage',
    'integrations:manage',
  ],
  manager: [
    'projects:read',
    'tasks:read',
    'tasks:write',
    'tasks:contribute',
    'tasks:transition',
    'tasks:transition:any',
    'requests:read',
    'requests:ingest',
    'requests:analyze',
    'drafts:create',
    'tasks:submit',
    'approvals:decide',
  ],
  member: ['projects:read', 'tasks:read', 'tasks:transition', 'tasks:contribute', 'requests:read'],
};

/**
 * Which agent scopes satisfy which capability.
 *
 * `approvals:decide` is intentionally unreachable — the absence is the feature.
 */
const SCOPE_CAPABILITIES: Record<Scope, readonly Capability[]> = {
  'projects:read': ['projects:read'],
  'requests:read': ['requests:read'],
  'requests:write': ['requests:analyze', 'requests:ingest'],
  'tasks:read': ['tasks:read'],
  'tasks:write': ['tasks:write', 'drafts:create', 'tasks:submit'],
};

export function can(actor: Actor, capability: Capability, context: { assigneeId?: string | null } = {}): boolean {
  if (actor.kind === 'system') return true;

  if (actor.kind === 'agent') {
    return actor.scopes.some((scope) => SCOPE_CAPABILITIES[scope].includes(capability));
  }

  if (!ROLE_CAPABILITIES[actor.role].includes(capability)) return false;

  // Members work their own board, not the whole agency's.
  if ((capability === 'tasks:transition' || capability === 'tasks:contribute') && actor.role === 'member') {
    return Boolean(context.assigneeId) && context.assigneeId === actor.userId;
  }
  return true;
}

export function assertCan(actor: Actor, capability: Capability, context: { assigneeId?: string | null } = {}): void {
  if (!can(actor, capability, context)) {
    const who =
      actor.kind === 'agent'
        ? `This agent credential lacks the scope required for "${capability}"`
        : actor.kind === 'user'
          ? `Your role (${actor.role}) cannot perform "${capability}"`
          : `This actor cannot perform "${capability}"`;
    throw new ForbiddenError(`${who}.`, { capability, actorKind: actor.kind });
  }
}

export function describeCapabilities(actor: Actor): Capability[] {
  if (actor.kind === 'system') return ['tasks:transition:any'];
  if (actor.kind === 'agent') {
    const set = new Set<Capability>();
    for (const scope of actor.scopes) for (const cap of SCOPE_CAPABILITIES[scope]) set.add(cap);
    return [...set];
  }
  return [...ROLE_CAPABILITIES[actor.role]];
}

export function listRoleCapabilities(role: MembershipRole): readonly Capability[] {
  return ROLE_CAPABILITIES[role];
}
