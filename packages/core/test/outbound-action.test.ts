import { describe, expect, it, beforeEach } from 'vitest';
import {
  ADMIN_EMAIL,
  agentActor,
  createTestContext,
  MANAGER_EMAIL,
  type TestContext,
} from './harness.js';
import { MockWhatsAppChannel } from '@flowpilot/integrations';
import { ForbiddenError, ValidationError } from '@flowpilot/shared';

describe('OutboundActionService', () => {
  let ctx: TestContext;
  beforeEach(async () => {
    ctx = await createTestContext();
  });

  async function teardown() {
    await ctx.close();
  }

  it('creates a draft and prevents double-submission via dedupeKey', async () => {
    const actor = await ctx.actorFor(MANAGER_EMAIL);
    const draftA = await ctx.core.outbounds.createDraft(actor, {
      channel: 'whatsapp',
      provider: 'whatsapp-cloud',
      to: '+15555550100',
      body: 'Hello — your order is ready for pickup.',
    });
    expect(draftA.status).toBe('draft');
    expect(draftA.dedupeKey).toMatch(/^whatsapp:\+15555550100:/);

    // Sending the same body to the same number reuses the existing draft.
    const draftB = await ctx.core.outbounds.createDraft(actor, {
      channel: 'whatsapp',
      provider: 'whatsapp-cloud',
      to: '+15555550100',
      body: 'Hello — your order is ready for pickup.',
    });
    expect(draftB.id).toBe(draftA.id);
    await teardown();
  });

  it('rejects empty body or recipient', async () => {
    const actor = await ctx.actorFor(MANAGER_EMAIL);
    await expect(
      ctx.core.outbounds.createDraft(actor, {
        channel: 'whatsapp',
        provider: 'whatsapp-cloud',
        to: '+1',
        body: '   ',
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    await expect(
      ctx.core.outbounds.createDraft(actor, {
        channel: 'whatsapp',
        provider: 'whatsapp-cloud',
        to: '',
        body: 'ok',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await teardown();
  });

  it('walks the full lifecycle: draft -> pending_approval -> approved -> sending -> sent', async () => {
    const actor = await ctx.actorFor(MANAGER_EMAIL);
    const draft = await ctx.core.outbounds.createDraft(actor, {
      channel: 'whatsapp',
      provider: 'whatsapp-cloud',
      to: '+15555550100',
      body: 'Pickup at 4pm today.',
      dedupeKey: 'test:full-lifecycle:001',
    });

    const pending = await ctx.core.outbounds.submitForApproval(actor, draft.id);
    expect(pending.status).toBe('pending_approval');

    const decided = await ctx.core.outbounds.decide(actor, {
      actionId: draft.id,
      decision: 'approved',
      note: 'looks good',
    });
    expect(decided.status).toBe('approved');
    expect(decided.approvedBy).toBe(actor.userId);
    expect(decided.approvalNote).toBe('looks good');

    const ch = new MockWhatsAppChannel();
    const sent = await ctx.core.outbounds.send(actor, draft.id, ch);
    expect(sent.status).toBe('sent');
    expect(sent.externalMessageId).toMatch(/^mock-msg-/);
    expect(ch.calls).toHaveLength(1);
    await teardown();
  });

  it('refuses to send when the action is not approved', async () => {
    const actor = await ctx.actorFor(MANAGER_EMAIL);
    const draft = await ctx.core.outbounds.createDraft(actor, {
      channel: 'whatsapp',
      provider: 'whatsapp-cloud',
      to: '+1',
      body: 'test',
      dedupeKey: 'test:invalid-send:001',
    });
    const ch = new MockWhatsAppChannel();
    await expect(ctx.core.outbounds.send(actor, draft.id, ch)).rejects.toBeInstanceOf(ValidationError);
    await teardown();
  });

  it('records a failed status when the channel driver returns a non-ok result', async () => {
    const actor = await ctx.actorFor(MANAGER_EMAIL);
    const draft = await ctx.core.outbounds.createDraft(actor, {
      channel: 'whatsapp',
      provider: 'whatsapp-cloud',
      to: '+1',
      body: 'test',
      dedupeKey: 'test:failed-send:001',
    });
    await ctx.core.outbounds.submitForApproval(actor, draft.id);
    await ctx.core.outbounds.decide(actor, { actionId: draft.id, decision: 'approved' });
    const ch = new MockWhatsAppChannel();
    ch.defaultFailure = { ok: false, errorCode: '131030', errorTitle: 'Recipient not allowed', retryable: false };
    const result = await ctx.core.outbounds.send(actor, draft.id, ch);
    expect(result.status).toBe('failed');
    expect(result.errorMessage).toContain('Recipient not allowed');
    await teardown();
  });

  it('blocks agents from approving (only humans may decide)', async () => {
    const adminActor = await ctx.actorFor(ADMIN_EMAIL);
    const draft = await ctx.core.outbounds.createDraft(adminActor, {
      channel: 'whatsapp',
      provider: 'whatsapp-cloud',
      to: '+1',
      body: 'hi',
      dedupeKey: 'test:agent-approve:001',
    });
    await ctx.core.outbounds.submitForApproval(adminActor, draft.id);

    const agent = agentActor({
      orgId: ctx.orgId,
      scopes: ['projects:read', 'requests:read', 'requests:write', 'tasks:read', 'tasks:write', 'outbounds:read', 'outbounds:write'],
    });
    await expect(
      ctx.core.outbounds.decide(agent, { actionId: draft.id, decision: 'approved' }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await teardown();
  });

  it('forbids duplicate drafts across orgs with the same dedupe key', async () => {
    const adminActor = await ctx.actorFor(ADMIN_EMAIL);
    const draft = await ctx.core.outbounds.createDraft(adminActor, {
      channel: 'whatsapp',
      provider: 'whatsapp-cloud',
      to: '+1',
      body: 'a',
      dedupeKey: 'cross-org:001',
    });
    expect(draft.status).toBe('draft');

    // Set up a foreign org and ensure a draft in that org does NOT collide.
    const foreign = await ctx.db.repos.organizations.create({
      id: 'org_rival_ob',
      name: 'Rival',
      slug: 'rival-ob',
    });
    // Re-create the outbounds + audit on a separate service for the foreign org, by reusing the same db.
    const foreignActor = { kind: 'system' as const, orgId: foreign.id, label: 'foreign' };
    const foreignDraft = await ctx.core.outbounds.createDraft(foreignActor, {
      channel: 'whatsapp',
      provider: 'whatsapp-cloud',
      to: '+1',
      body: 'b',
      dedupeKey: 'cross-org:001',
    });
    expect(foreignDraft.orgId).toBe(foreign.id);
    expect(foreignDraft.id).not.toBe(draft.id);
    await teardown();
  });
});
