import type { TaskStatus } from './entities.js';

/**
 * The task state machine — the single authority on what may follow what.
 *
 * Both the dashboard and the MCP server can only *ask* for a transition. This module decides,
 * and it is pure: no I/O, no clock, no database. That is what makes it exhaustively testable
 * and what stops the two entry points from drifting apart.
 */

export interface TransitionRule {
  from: TaskStatus;
  to: TaskStatus;
  /** Human-readable effect, used for audit entries and the UI. */
  effect: string;
  /** The action key an approval/member must hold for this hop. */
  action: 'submit_for_approval' | 'approve' | 'reject' | 'revise' | 'start' | 'submit' | 'complete' | 'request_changes' | 'cancel';
}

export const transitions: readonly TransitionRule[] = [
  { from: 'draft', to: 'pending_approval', action: 'submit_for_approval', effect: 'Submitted for approval' },
  { from: 'draft', to: 'cancelled', action: 'cancel', effect: 'Cancelled' },

  { from: 'pending_approval', to: 'ready', action: 'approve', effect: 'Approved and released to the team' },
  { from: 'pending_approval', to: 'rejected', action: 'reject', effect: 'Rejected' },
  { from: 'pending_approval', to: 'draft', action: 'revise', effect: 'Sent back for edits' },
  { from: 'pending_approval', to: 'cancelled', action: 'cancel', effect: 'Cancelled' },

  { from: 'rejected', to: 'draft', action: 'revise', effect: 'Reopened as a draft' },
  { from: 'rejected', to: 'cancelled', action: 'cancel', effect: 'Cancelled' },

  { from: 'ready', to: 'in_progress', action: 'start', effect: 'Work started' },
  { from: 'ready', to: 'cancelled', action: 'cancel', effect: 'Cancelled' },

  { from: 'in_progress', to: 'in_review', action: 'submit', effect: 'Submitted for review' },
  { from: 'in_progress', to: 'cancelled', action: 'cancel', effect: 'Cancelled' },

  { from: 'in_review', to: 'completed', action: 'complete', effect: 'Completed' },
  { from: 'in_review', to: 'in_progress', action: 'request_changes', effect: 'Changes requested' },
];

const BY_FROM = new Map<TaskStatus, TransitionRule[]>(transitions.map((t) => [t.from, []]));
for (const rule of transitions) BY_FROM.get(rule.from)?.push(rule);

export const terminalStatuses: readonly TaskStatus[] = ['completed', 'cancelled'];

/** Kanban column order. */
export const boardColumns: readonly TaskStatus[] = [
  'draft',
  'pending_approval',
  'ready',
  'in_progress',
  'in_review',
  'completed',
];

export function isTerminal(status: TaskStatus): boolean {
  return terminalStatuses.includes(status);
}

export function allowedTransitions(from: TaskStatus): TransitionRule[] {
  return BY_FROM.get(from) ?? [];
}

export function allowedTargets(from: TaskStatus): TaskStatus[] {
  return allowedTransitions(from).map((t) => t.to);
}

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return allowedTargets(from).includes(to);
}

export function findTransition(from: TaskStatus, to: TaskStatus): TransitionRule | undefined {
  return allowedTransitions(from).find((t) => t.to === to);
}

/** Columns a task can still move to, used to render only legal actions in the UI. */
export function boardTransitions(status: TaskStatus): TransitionRule[] {
  return allowedTransitions(status).filter((t) => !terminalStatuses.includes(t.to) || t.to === 'cancelled');
}
