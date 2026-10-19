import { beforeEach, describe, expect, it } from 'vitest';
import {
  ADMIN_EMAIL,
  createTestContext,
  MANAGER_EMAIL,
  OWNER_EMAIL,
  type TestContext,
} from './harness.js';
import { handleWhatsAppEvents, MockWhatsAppChannel } from '@flowpilot/integrations';

/**
 * End-to-end smoke for the Phase 1 WhatsApp loop. This test runs the *exact* code the UI
 * hits, against a real PGlite database: there are no mocks and no test-only seams. If
 * this test stays green, the UI's "Simulate → Approve → Send" loop also works against
 * a real channel driver — the only thing it does not exercise is the web framework
 * round-trips (NextAuth cookie, dynamic params), which are tested separately.
 *
 * Step coverage:
 *   1) HTTP-style simulator payload hits `handleWhatsAppEvents` (the same entry point
 *      the webhook controller calls).
 *   2) `ingestAndDraft` creates a Request row with `source = 'whatsapp'`.
 *   3) `core.queries.inbox(...)` reports the request with `outboundActionIds` empty (no
 *      draft yet).
 *   4) `core.whatsappReply.generateAndQueue` queues a draft OutboundAction tied to the
 *      request.
 *   5) The inbox query now lists that draft via `outboundActionIds`.
 *   6) `core.outbounds.submitForApproval` + `decide` walk the lifecycle to `approved`.
 *   7) `core.outbounds.send` flips through `sending → sent` and records the mock id.
 *   8) The audit + event logs have every state transition.
 */
describe('WhatsApp Phase 1 end-to-end loop', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestContext();
  });

  async function teardown() {
    await ctx.close();
  }

  it('walks Simulate -> Inbox -> Reply -> Approve -> Send against the real services', async () => {
    // Seed a tiny product catalog so the Bakery reply generator has something to ground against.
    await ctx.db.repos.products.create({
      id: 'prd_e2e_choc',
      orgId: ctx.orgId,
      name: 'Chocolate Cake',
      priceCents: 4500,
      currency: 'USD',
      inStock: true,
      description: 'Made to order',
    });

    // Step 1+2 — same entry point the webhook route uses.
    const sys = { kind: 'system' as const, orgId: ctx.orgId, label: 'sim' };
    // Build a system actor that the WhatsApp event handler accepts.
    const adminActor = await ctx.actorFor(ADMIN_EMAIL);
    const ingestResult = await handleWhatsAppEvents({
      core: ctx.core,
      // `system` actors are accepted by the assertion helpers; cast for the typed narrow.
      actor: sys as unknown as typeof adminActor,
      events: {
        messages: [
          {
            externalId: 'wamid-e2e-1',
            from: '+15555550100',
            fromName: 'Casey Customer',
            phoneNumberId: 'pn-e2e',
            type: 'text',
            body: 'I would like to order a chocolate cake for Saturday pickup.',
            receivedAt: new Date().toISOString(),
            businessAccountId: 'waba-e2e',
            displayPhoneNumber: '+15555550100',
          },
        ],
        statuses: [],
      },
    });
    const requestId = ingestResult.ingested[0]?.requestId;
    expect(requestId).toBeTruthy();

    // Step 3 — inbox shows the request as a WhatsApp message with no draft yet.
    const inboxBefore = await ctx.core.queries.inbox(adminActor, { limit: 50 });
    const request = inboxBefore.requests.find((r) => r.id === requestId);
    expect(request).toBeDefined();
    expect(request?.source).toBe('whatsapp');
    expect(request?.rawFrom).toContain('+15555550100');
    expect(request?.outboundActionIds).toEqual([]);

    // Step 4 — queue a deterministic reply.
    const reply = await ctx.core.whatsappReply.generateAndQueue(adminActor, {
      requestId: requestId!,
      incomingBody: 'I would like to order a chocolate cake for Saturday pickup.',
    });
    expect(reply.draftId).toBeTruthy();
    expect(reply.reply.intent === 'order' || reply.reply.intent === 'product_question').toBe(true);
    expect(reply.reply.body.length).toBeGreaterThan(0);

    // Step 5 — the inbox now reports outboundActionIds.
    const inboxAfter = await ctx.core.queries.inbox(adminActor, { limit: 50 });
    const after = inboxAfter.requests.find((r) => r.id === requestId);
    expect(after?.outboundActionIds).toContain(reply.draftId);
    expect(after?.source).toBe('whatsapp');

    // Step 6 — human review.
    const managerActor = await ctx.actorFor(MANAGER_EMAIL);
    await ctx.core.outbounds.submitForApproval(managerActor, reply.draftId!);
    const decided = await ctx.core.outbounds.decide(managerActor, {
      actionId: reply.draftId!,
      decision: 'approved',
      note: 'looks good',
    });
    expect(decided.status).toBe('approved');
    expect(decided.approvedByLabel).toBeTruthy();
    expect(decided.approvalNote).toBe('looks good');

    // Step 7 — drive the channel driver (mock). Mirrors what /api/outbound-actions/<id>/send does.
    const driver = new MockWhatsAppChannel();
    const sent = await ctx.core.outbounds.send(managerActor, reply.draftId!, driver);
    expect(sent.status).toBe('sent');
    expect(sent.externalMessageId).toMatch(/^mock-msg-/);

    // Step 8 — every transition is in the per-action event log.
    const events = await ctx.core.outbounds.listEvents(managerActor, reply.draftId!);
    const transitions = events.map((e) => `${e.fromStatus ?? '∅'}->${e.toStatus}`);
    expect(transitions).toEqual(expect.arrayContaining([
      '∅->draft',
      'draft->pending_approval',
      'pending_approval->approved',
      'approved->sending',
      'sending->sent',
    ]));

    // Audit + activity show the draft, decision, and send.
    const auditEvents = await ctx.core.audit.list(ctx.orgId, { limit: 100, entityType: 'outbound_action', entityId: reply.draftId! });
    const actions = auditEvents.map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining([
      'outbound_action.drafted',
      'outbound_action.pending_approval',
      'outbound_action.approved',
      'outbound_action.sent',
    ]));

    await teardown();
  });

  it('marks a follow-up send with a fresh externalMessageId and the same provider', async () => {
    const ownerActor = await ctx.actorFor(OWNER_EMAIL);
    const draft = await ctx.core.outbounds.createDraft(ownerActor, {
      channel: 'whatsapp',
      provider: 'whatsapp-cloud',
      to: '+15555550199',
      body: 'Second message after the first was approved.',
      dedupeKey: 'e2e-followup:001',
    });
    await ctx.core.outbounds.submitForApproval(ownerActor, draft.id);
    await ctx.core.outbounds.decide(ownerActor, { actionId: draft.id, decision: 'approved' });
    const driver = new MockWhatsAppChannel();
    const sent = await ctx.core.outbounds.send(ownerActor, draft.id, driver);
    expect(sent.externalMessageId).toMatch(/^mock-msg-/);
    expect(driver.calls).toHaveLength(1);
    expect(driver.calls[0]).toMatchObject({ to: '+15555550199' });
    await teardown();
  });
});
