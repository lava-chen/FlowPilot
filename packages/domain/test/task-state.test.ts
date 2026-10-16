import { describe, expect, it } from 'vitest';
import {
  allowedTargets,
  allowedTransitions,
  boardColumns,
  canTransition,
  findTransition,
  isTerminal,
  transitions,
  taskStatuses,
} from '@flowpilot/domain';

/**
 * Exhaustive state-machine tests.
 *
 * These enumerate the full 8x8 matrix rather than spot-checking a few hops, because the matrix is
 * small enough to check completely and that is the only way to know the "reject everything not
 * listed" property actually holds.
 */
describe('task state machine', () => {
  const declaredPairs = new Set(transitions.map((t) => `${t.from}->${t.to}`));

  it('declares no duplicate transitions', () => {
    expect(declaredPairs.size).toBe(transitions.length);
  });

  it('never allows a transition into or out of an unknown status', () => {
    for (const rule of transitions) {
      expect(taskStatuses).toContain(rule.from);
      expect(taskStatuses).toContain(rule.to);
    }
  });

  it('has terminal statuses with no outgoing transitions', () => {
    for (const status of taskStatuses) {
      if (!isTerminal(status)) continue;
      expect(allowedTargets(status)).toEqual([]);
    }
  });

  it('covers every non-terminal status with at least one way out', () => {
    for (const status of taskStatuses) {
      if (isTerminal(status)) continue;
      expect(allowedTargets(status).length).toBeGreaterThan(0);
    }
  });

  it('allows exactly the declared transitions and rejects everything else', () => {
    for (const from of taskStatuses) {
      for (const to of taskStatuses) {
        const expected = declaredPairs.has(`${from}->${to}`);
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(expected);
      }
    }
  });

  it('never allows a task to skip straight from draft to completed', () => {
    expect(canTransition('draft', 'completed')).toBe(false);
    expect(canTransition('pending_approval', 'in_progress')).toBe(false);
    expect(canTransition('ready', 'completed')).toBe(false);
  });

  it('requires human approval before work is released', () => {
    expect(canTransition('draft', 'pending_approval')).toBe(true);
    expect(canTransition('pending_approval', 'ready')).toBe(true);
    expect(canTransition('pending_approval', 'rejected')).toBe(true);
  });

  it('allows a reviewer to send work back from review', () => {
    expect(findTransition('in_review', 'in_progress')?.action).toBe('request_changes');
    expect(findTransition('in_review', 'completed')?.action).toBe('complete');
  });

  it('lets a rejected draft be reopened', () => {
    expect(canTransition('rejected', 'draft')).toBe(true);
    expect(canTransition('rejected', 'ready')).toBe(false);
  });

  it('lets any active task be cancelled but never a finished one', () => {
    expect(canTransition('draft', 'cancelled')).toBe(true);
    expect(canTransition('in_progress', 'cancelled')).toBe(true);
    expect(canTransition('completed', 'cancelled')).toBe(false);
  });

  it('exposes every transition rule with a human-readable effect', () => {
    for (const rule of transitions) {
      expect(rule.effect.length).toBeGreaterThan(0);
      expect(rule.action.length).toBeGreaterThan(0);
    }
  });

  it('lists board columns in pipeline order without terminal "cancelled"', () => {
    expect(boardColumns).toEqual(['draft', 'pending_approval', 'ready', 'in_progress', 'in_review', 'completed']);
  });

  it('returns no rules for an unknown status instead of throwing', () => {
    // @ts-expect-error deliberately invalid status
    expect(allowedTransitions('nonsense')).toEqual([]);
  });
});
