import type { OutboundActionStatus } from './entities.js';

/**
 * Outbound-action state machine.
 *
 * Why a separate machine from tasks: an outbound action is a *platform* operation, not internal
 * work, and the only way a customer-visible message leaves the system is by walking through
 * `approved → sending → sent`. Squeezing that into `tasks` would force the existing task
 * transitions to grow a second "draft an external send" subgraph.
 *
 * Guards are load-bearing — `approved → sending` and `sending → sent | failed` are *system*
 * transitions that the channel driver performs; `draft | pending_approval → *` are *human*
 * transitions; `draft → pending_approval` can be requested by the system (an agent or webhook)
 * but the approval itself is always human.
 */
export type TransitionGuard = 'system' | 'human' | 'system-or-human';

export interface OutboundTransition {
  from: OutboundActionStatus;
  to: OutboundActionStatus;
  guard: TransitionGuard;
}

const TERMINAL: ReadonlySet<OutboundActionStatus> = new Set<OutboundActionStatus>([
  'sent',
  'rejected',
]);

const TRANSITIONS: readonly OutboundTransition[] = [
  // System-OR-human can submit a draft for approval.
  { from: 'draft', to: 'pending_approval', guard: 'system-or-human' },
  // A human reviewer's fast path without an explicit submit step.
  { from: 'draft', to: 'approved', guard: 'human' },
  { from: 'draft', to: 'rejected', guard: 'human' },
  // Pending approval: only a human decides. Sending back to `draft` lets the reviewer edit.
  { from: 'pending_approval', to: 'approved', guard: 'human' },
  { from: 'pending_approval', to: 'rejected', guard: 'human' },
  { from: 'pending_approval', to: 'draft', guard: 'human' },
  // Approval gate cleared — now the channel driver takes over.
  { from: 'approved', to: 'sending', guard: 'system' },
  { from: 'approved', to: 'failed', guard: 'system' },
  { from: 'sending', to: 'sent', guard: 'system' },
  { from: 'sending', to: 'failed', guard: 'system' },
];

export function canTransitionOutbound(
  from: OutboundActionStatus,
  to: OutboundActionStatus,
): boolean {
  return TRANSITIONS.some((t) => t.from === from && t.to === to);
}

export function getOutboundTransition(
  from: OutboundActionStatus,
  to: OutboundActionStatus,
): OutboundTransition | null {
  return TRANSITIONS.find((t) => t.from === from && t.to === to) ?? null;
}

export function outboundNextStates(from: OutboundActionStatus): OutboundActionStatus[] {
  return TRANSITIONS.filter((t) => t.from === from).map((t) => t.to);
}

export function outboundIsTerminal(status: OutboundActionStatus): boolean {
  return TERMINAL.has(status);
}

export function outboundAllowedByGuard(
  transition: OutboundTransition,
  by: 'system' | 'human' | 'system-or-human',
): boolean {
  if (transition.guard === by) return true;
  // `system-or-human` is the "both can perform this" guard. Webhook-driven drafts and
  // human-initiated drafts both flow through it.
  if (transition.guard === 'system-or-human') return by === 'system' || by === 'human';
  return false;
}

/** Pure structural data — keeps the dependency graph clean (no @flowpilot/shared here). */
export const outboundTransitions = TRANSITIONS;
