import { describe, expect, it, beforeEach } from 'vitest';
import { createTestContext, MANAGER_EMAIL, type TestContext } from './harness.js';
import { ValidationError } from '@flowpilot/shared';
import type { ChannelDriver, SendInput, SendResult } from '@flowpilot/integrations';

/**
 * Concurrent-send regression.
 *
 * Before the compare-and-swap fix, `updateStatus` had no expected-status predicate, so two
 * requests could both read `approved`, both pass the in-process transition check, and both call
 * the channel. A customer received the same message twice.
 *
 * These tests assert the *observable* invariant — the provider is called exactly once — rather
 * than asserting that a particular SQL clause exists.
 */

/** Records every send and resolves slowly enough that two callers genuinely overlap. */
class CountingChannel implements ChannelDriver {
  readonly providerId = 'counting';
  readonly live = true;
  calls: SendInput[] = [];

  constructor(private readonly delayMs = 25) {}

  async send(input: SendInput): Promise<SendResult> {
    this.calls.push(input);
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    return { ok: true, externalMessageId: `counted-${this.calls.length}`, retryable: false };
  }
}

describe('Outbound send concurrency', () => {
  let ctx: TestContext;
  beforeEach(async () => {
    ctx = await createTestContext();
  });

  async function approvedAction() {
    const actor = await ctx.actorFor(MANAGER_EMAIL);
    const draft = await ctx.core.outbounds.createDraft(actor, {
      channel: 'whatsapp',
      provider: 'whatsapp-cloud',
      to: '+15555550100',
      body: 'Concurrency probe — this must be delivered exactly once.',
    });
    await ctx.core.outbounds.submitForApproval(actor, draft.id);
    return ctx.core.outbounds.decide(actor, { actionId: draft.id, decision: 'approved' });
  }

  it('delivers exactly once when two senders race', async () => {
    const action = await approvedAction();
    const actor = await ctx.actorFor(MANAGER_EMAIL);
    const channel = new CountingChannel();

    const results = await Promise.allSettled([
      ctx.core.outbounds.send(actor, action.id, channel),
      ctx.core.outbounds.send(actor, action.id, channel),
    ]);

    // The provider must have been called once, not twice.
    expect(channel.calls.length).toBe(1);

    // Exactly one caller wins; the other is told it lost the race.
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);

    const final = await ctx.core.outbounds.require(actor, action.id);
    expect(final.status).toBe('sent');
    expect(final.externalMessageId).toBe('counted-1');
    await ctx.close();
  });

  it('stays single-delivery across a burst of eight concurrent senders', async () => {
    const action = await approvedAction();
    const actor = await ctx.actorFor(MANAGER_EMAIL);
    const channel = new CountingChannel();

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => ctx.core.outbounds.send(actor, action.id, channel)),
    );

    expect(channel.calls.length).toBe(1);
    expect(results.filter((r) => r.status === 'fulfilled').length).toBe(1);
    expect(results.filter((r) => r.status === 'rejected').length).toBe(7);
    await ctx.close();
  });

  it('rejects the loser with a message that tells the operator what happened', async () => {
    const action = await approvedAction();
    const actor = await ctx.actorFor(MANAGER_EMAIL);
    const channel = new CountingChannel();

    const [, second] = await Promise.allSettled([
      ctx.core.outbounds.send(actor, action.id, channel),
      ctx.core.outbounds.send(actor, action.id, channel),
    ]);

    expect(second?.status).toBe('rejected');
    if (second?.status === 'rejected') {
      expect(second.reason).toBeInstanceOf(ValidationError);
      expect((second.reason as Error).message).toMatch(/already picked up|changed state/i);
    }
    await ctx.close();
  });

  it('records a single sending event, not one per racing caller', async () => {
    const action = await approvedAction();
    const actor = await ctx.actorFor(MANAGER_EMAIL);
    const channel = new CountingChannel();

    await Promise.allSettled([
      ctx.core.outbounds.send(actor, action.id, channel),
      ctx.core.outbounds.send(actor, action.id, channel),
    ]);

    const events = await ctx.core.outbounds.listEvents(actor, action.id);
    const sendingEvents = events.filter((e) => e.toStatus === 'sending');
    const sentEvents = events.filter((e) => e.toStatus === 'sent');
    expect(sendingEvents.length).toBe(1);
    expect(sentEvents.length).toBe(1);
    await ctx.close();
  });

  it('a sequential re-send after a completed send is refused, not re-delivered', async () => {
    const action = await approvedAction();
    const actor = await ctx.actorFor(MANAGER_EMAIL);
    const channel = new CountingChannel();

    await ctx.core.outbounds.send(actor, action.id, channel);
    await expect(ctx.core.outbounds.send(actor, action.id, channel)).rejects.toBeInstanceOf(ValidationError);

    expect(channel.calls.length).toBe(1);
    await ctx.close();
  });

  it('two reviewers deciding the same action produce one approval', async () => {
    const actor = await ctx.actorFor(MANAGER_EMAIL);
    const draft = await ctx.core.outbounds.createDraft(actor, {
      channel: 'whatsapp',
      provider: 'whatsapp-cloud',
      to: '+15555550199',
      body: 'Double-approval probe.',
    });
    await ctx.core.outbounds.submitForApproval(actor, draft.id);

    const results = await Promise.allSettled([
      ctx.core.outbounds.decide(actor, { actionId: draft.id, decision: 'approved' }),
      ctx.core.outbounds.decide(actor, { actionId: draft.id, decision: 'rejected' }),
    ]);

    // One decision lands; the other observes that the state moved under it.
    expect(results.filter((r) => r.status === 'fulfilled').length).toBe(1);

    const final = await ctx.core.outbounds.require(actor, draft.id);
    expect(['approved', 'rejected']).toContain(final.status);
    await ctx.close();
  });

  it('a failed send leaves the action retryable-by-draft, never silently re-sent', async () => {
    const action = await approvedAction();
    const actor = await ctx.actorFor(MANAGER_EMAIL);
    const failing: ChannelDriver = {
      providerId: 'always-fails',
      live: true,
      async send(): Promise<SendResult> {
        return { ok: false, errorCode: 'E_FAIL', errorTitle: 'provider rejected', errorBody: '', retryable: false };
      },
    };

    const failed = await ctx.core.outbounds.send(actor, action.id, failing);
    expect(failed.status).toBe('failed');
    // `failed` is not a valid send origin, so pressing send again cannot double-send.
    await expect(ctx.core.outbounds.send(actor, action.id, failing)).rejects.toBeInstanceOf(ValidationError);
    await ctx.close();
  });
});
