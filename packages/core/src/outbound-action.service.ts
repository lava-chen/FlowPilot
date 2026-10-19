import type { FlowPilotDb } from '@flowpilot/database';
import type {
  Actor,
  OutboundAction,
  OutboundActionChannel,
  OutboundActionStatus,
} from '@flowpilot/domain';
import {
  canTransitionOutbound,
  getOutboundTransition,
  outboundAllowedByGuard,
} from '@flowpilot/domain';
import { ForbiddenError, ValidationError, newId, nowIso } from '@flowpilot/shared';
import { assertCan } from './permissions.js';
import type { AuditService } from './audit.service.js';
import type { ChannelDriver } from '@flowpilot/integrations';

/**
 * Outbound action service.
 *
 * Sole entry point for the lifecycle of a customer-visible send:
 *   draft → pending_approval → approved → sending → sent | failed
 *
 * Rules:
 *   1. State transitions are validated by the pure state machine in `@flowpilot/domain`.
 *   2. Only human actors may approve / reject. Agent and System actors may *submit* drafts
 *      for approval but never move past `approved` themselves.
 *   3. Sending is always driven by `ChannelDriver`. The service does not import any provider
 *      library directly: the wiring is done in the apps, where the channel driver matches
 *      the org's `integration_connections.config`.
 */
export interface CreateOutboundDraftInput {
  channel: OutboundActionChannel;
  provider: string;
  to: string;
  subject?: string | null;
  body: string;
  requestId?: string | null;
  leadId?: string | null;
  /** Defaults to a deterministic hash of (channel, to, body). */
  dedupeKey?: string;
}

export interface DecideOutboundInput {
  actionId: string;
  decision: 'approved' | 'rejected';
  note?: string | null;
}

export class OutboundActionService {
  constructor(
    private readonly db: FlowPilotDb,
    private readonly audit: AuditService,
  ) {}

  async createDraft(actor: Actor, input: CreateOutboundDraftInput): Promise<OutboundAction> {
    // Composing a draft is cheap and reversible. The hard gate is approval, where agents are
    // explicitly blocked. We grant `outbounds:write` to every role and to every agent scope
    // that *also* already has `tasks:write`; agents with only `outbounds:read` cannot create
    // drafts, but humans with `member` can (e.g. an editor composing a courtesy reply).
    if (actor.kind === 'user') {
      assertCan(actor, 'outbounds:write');
    } else if (actor.kind === 'agent') {
      assertCan(actor, 'outbounds:write');
    }
    // system actor (webhook-driven drafts): no check.

    const validation = validateDraft(input);
    if (validation) throw new ValidationError(validation, { field: 'body' });

    const dedupeKey = input.dedupeKey ?? defaultDedupeKey(input);

    const existing = await this.db.repos.outboundActions.findByDedupeKey(
      actor.orgId,
      input.channel,
      dedupeKey,
    );
    if (existing) {
      await this.audit.record(actor, 'outbound_action.deduplicated', 'outbound_action', existing.id, {
        channel: existing.channel,
        provider: existing.provider,
        to: existing.to,
      });
      return existing;
    }

    const action = await this.db.repos.outboundActions.create({
      id: newId('outbound'),
      orgId: actor.orgId,
      channel: input.channel,
      provider: input.provider,
      to: input.to,
      subject: input.subject ?? null,
      body: input.body,
      requestId: input.requestId ?? null,
      leadId: input.leadId ?? null,
      dedupeKey,
      createdBy: actor.kind === 'user' ? actor.userId : actor.kind === 'agent' ? actor.credentialId : 'system',
      status: 'draft',
    });

    await this.db.repos.outboundActions.recordEvent({
      id: newId('outboundEvent'),
      orgId: actor.orgId,
      actionId: action.id,
      fromStatus: null,
      toStatus: 'draft',
      actorKind: actor.kind,
      actorId: actor.kind === 'user' ? actor.userId : actor.kind === 'agent' ? actor.credentialId : 'system',
      actorLabel:
        actor.kind === 'user' ? actor.displayName : actor.kind === 'agent' ? actor.label : 'system',
    });

    await this.audit.record(actor, 'outbound_action.drafted', 'outbound_action', action.id, {
      channel: action.channel,
      provider: action.provider,
      to: action.to,
    });

    return action;
  }

  /**
   * Move a draft to `pending_approval`.
   *
   * Both humans and agents may submit a draft for approval — but only humans may decide. The
   * gate at the `approved` transition prevents Agent -> `approve` even when the credential
   * somehow has the scope, because the state machine marks that transition `human-only`.
   */
  async submitForApproval(actor: Actor, actionId: string): Promise<OutboundAction> {
    return this.transitionBySystemOrHuman(actor, actionId, 'pending_approval');
  }

  async decide(
    actor: Actor,
    input: DecideOutboundInput,
  ): Promise<OutboundAction> {
    if (actor.kind !== 'user') {
      throw new ForbiddenError(
        'Only a human user can approve or reject an outbound action. The agent owns the draft; the human owns the send.',
        { capability: 'approvals:decide' },
      );
    }
    assertCan(actor, 'approvals:decide');

    const action = await this.require(actor, input.actionId);
    const target: OutboundActionStatus = input.decision === 'approved' ? 'approved' : 'rejected';
    const transition = getOutboundTransition(action.status, target);
    if (!transition) {
      throw new ValidationError(`Outbound action cannot move ${action.status} -> ${target}.`, {
        field: 'status',
      });
    }
    if (!outboundAllowedByGuard(transition, 'human')) {
      throw new ForbiddenError('This transition is not allowed for humans.', {
        capability: 'approvals:decide',
      });
    }

    const updated = await this.db.repos.outboundActions.updateStatus(actor.orgId, action.id, target, {
      approvedBy: actor.userId,
      approvedByLabel: actor.displayName,
      approvedAt: nowIso(),
      approvalNote: input.note ?? null,
    });

    await this.db.repos.outboundActions.recordEvent({
      id: newId('outboundEvent'),
      orgId: actor.orgId,
      actionId: updated.id,
      fromStatus: action.status,
      toStatus: target,
      actorKind: actor.kind,
      actorId: actor.userId,
      actorLabel: actor.displayName,
      note: input.note ?? null,
    });

    await this.audit.record(actor, `outbound_action.${input.decision}`, 'outbound_action', updated.id, {
      from: action.status,
      to: target,
      note: input.note ?? null,
    });

    return updated;
  }

  /**
   * Send the action through the supplied channel driver.
   *
   * The state machine constraint `approved -> sending` (system-only) is what stands between
   * a stale credential approval and an actual delivery. A path that skipped this service
   * would also have to remember to flip `approved → sending → sent`, which is why we kept
   * sending inside the service rather than exposing a free `send()` to the web layer.
   */
  async send(actor: Actor, actionId: string, channel: ChannelDriver): Promise<OutboundAction> {
    if (!channel) throw new ValidationError('A channel driver is required.', { field: 'channel' });
    const action = await this.require(actor, actionId);

    const sysTransition = getOutboundTransition(action.status, 'sending');
    if (!sysTransition || !outboundAllowedByGuard(sysTransition, 'system')) {
      // Forces a non-`approved` action through the right gate (re-submit, re-approve, ...).
      throw new ValidationError(`Outbound action cannot be sent from status "${action.status}".`, {
        field: 'status',
      });
    }

    const sending = await this.db.repos.outboundActions.updateStatus(actor.orgId, action.id, 'sending');
    await this.db.repos.outboundActions.recordEvent({
      id: newId('outboundEvent'),
      orgId: actor.orgId,
      actionId: sending.id,
      fromStatus: action.status,
      toStatus: 'sending',
      actorKind: 'system',
      actorId: 'system',
      actorLabel: 'Outbound dispatcher',
    });

    const result = await channel.send({
      to: action.to,
      body: action.body,
      subject: action.subject,
      dedupeKey: action.dedupeKey,
    });

    if (result.ok && result.externalMessageId) {
      const sent = await this.db.repos.outboundActions.updateStatus(actor.orgId, action.id, 'sent', {
        externalMessageId: result.externalMessageId,
        sentAt: nowIso(),
        errorMessage: null,
      });
      await this.db.repos.outboundActions.recordEvent({
        id: newId('outboundEvent'),
        orgId: actor.orgId,
        actionId: sent.id,
        fromStatus: 'sending',
        toStatus: 'sent',
        actorKind: 'system',
        actorId: 'system',
        actorLabel: channel.providerId,
      });
      await this.audit.record(actor, 'outbound_action.sent', 'outbound_action', sent.id, {
        provider: channel.providerId,
        externalMessageId: result.externalMessageId,
      });
      return sent;
    }

    // Failure path. The action stays in `failed`; a reviewer can compose a follow-up draft
    // rather than retrying the same one, which prevents accidental double sends.
    const failed = await this.db.repos.outboundActions.updateStatus(actor.orgId, action.id, 'failed', {
      errorMessage: [
        result.errorTitle ?? 'Provider failed',
        result.errorCode ? `(${result.errorCode})` : '',
        result.errorBody ?? '',
      ]
        .filter(Boolean)
        .join(' ')
        .trim(),
    });
    await this.db.repos.outboundActions.recordEvent({
      id: newId('outboundEvent'),
      orgId: actor.orgId,
      actionId: failed.id,
      fromStatus: 'sending',
      toStatus: 'failed',
      actorKind: 'system',
      actorId: 'system',
      actorLabel: channel.providerId,
      errorCode: result.errorCode ?? null,
      errorTitle: result.errorTitle ?? null,
      errorBody: result.errorBody ?? null,
    });
    await this.audit.record(actor, 'outbound_action.failed', 'outbound_action', failed.id, {
      provider: channel.providerId,
      code: result.errorCode,
      title: result.errorTitle,
    });
    return failed;
  }

  async require(actor: Actor, actionId: string): Promise<OutboundAction> {
    return this.db.repos.outboundActions.require(actor.orgId, actionId);
  }

  async list(
    actor: Actor,
    filter: { status?: OutboundActionStatus[]; limit: number; requestId?: string },
  ): Promise<OutboundAction[]> {
    return this.db.repos.outboundActions.list(actor.orgId, filter);
  }

  async listEvents(actor: Actor, actionId: string) {
    return this.db.repos.outboundActions.listEvents(actor.orgId, actionId);
  }

  private async transitionBySystemOrHuman(
    actor: Actor,
    actionId: string,
    target: OutboundActionStatus,
  ): Promise<OutboundAction> {
    const action = await this.require(actor, actionId);
    const transition = getOutboundTransition(action.status, target);
    if (!transition) {
      throw new ValidationError(`Outbound action cannot move ${action.status} -> ${target}.`, {
        field: 'status',
      });
    }
    const role: 'system' | 'human' = actor.kind === 'user' ? 'human' : 'system';
    if (!outboundAllowedByGuard(transition, role)) {
      throw new ForbiddenError('This transition is not allowed for the current actor.', {
        capability: 'approvals:decide',
      });
    }
    const updated = await this.db.repos.outboundActions.updateStatus(actor.orgId, action.id, target);
    await this.db.repos.outboundActions.recordEvent({
      id: newId('outboundEvent'),
      orgId: actor.orgId,
      actionId: updated.id,
      fromStatus: action.status,
      toStatus: target,
      actorKind: actor.kind,
      actorId: actor.kind === 'user' ? actor.userId : actor.kind === 'agent' ? actor.credentialId : 'system',
      actorLabel:
        actor.kind === 'user' ? actor.displayName : actor.kind === 'agent' ? actor.label : 'system',
    });
    await this.audit.record(actor, `outbound_action.${target}`, 'outbound_action', updated.id, {
      from: action.status,
      to: target,
    });
    return updated;
  }
}

function validateDraft(input: CreateOutboundDraftInput): string | null {
  if (!input.body || input.body.trim().length === 0) return 'Outbound body cannot be empty.';
  if (input.body.length > 4000) return 'Outbound body exceeds 4000 characters.';
  if (!input.to || input.to.trim().length === 0) return 'Outbound recipient (to) is required.';
  if (!input.provider) return 'Outbound provider is required.';
  return null;
}

function defaultDedupeKey(input: CreateOutboundDraftInput): string {
  // Cheap deterministic fingerprint; collisions across different bodies to the same to
  // matter only when the *generator* repeats — and in that case reusing the row is what we
  // want.
  return `${input.channel}:${input.to}:${hashStr(input.body)}`;
}

function hashStr(s: string): string {
  // A 32-bit FNV-1a is enough for a same-to dedupe key — not used for security.
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export function canTransition(from: OutboundActionStatus, to: OutboundActionStatus): boolean {
  return canTransitionOutbound(from, to);
}

/** Re-exported so consumers don't need to import the domain package directly. */
export type { OutboundAction };
