import { describe, expect, it, beforeEach } from 'vitest';
import { createTestContext, MANAGER_EMAIL, type TestContext } from './harness.js';
import { generateReplyDeterministic } from '../src/whatsapp-reply.service.js';
import type { ReplyGenerationInput } from '@flowpilot/domain';

function build(overrides: Partial<ReplyGenerationInput> = {}): ReplyGenerationInput {
  return {
    requestId: 'req_1',
    incomingBody: 'Do you have a chocolate cake?',
    inferredIntent: null,
    products: [],
    faq: [],
    businessHours: null,
    today: '2026-10-18',
    ...overrides,
  };
}

describe('generateReplyDeterministic', () => {
  it('detects a product question and lists matching products', () => {
    const out = generateReplyDeterministic(
      build({
        incomingBody: 'Do you have a chocolate cake for Saturday?',
        products: [
          {
            id: 'p1',
            name: 'Chocolate Cake',
            priceCents: 4500,
            currency: 'USD',
            inStock: true,
            description: null,
          },
          {
            id: 'p2',
            name: 'Vanilla Sponge',
            priceCents: 4200,
            currency: 'USD',
            inStock: true,
            description: null,
          },
        ],
      }),
    );
    expect(out.intent).toBe('product_question');
    expect(out.citedProductIds).toEqual(['p1']);
    expect(out.needsHuman).toBe(false);
    expect(out.body).toContain('Chocolate Cake');
    expect(out.body).toContain('$45.00 USD');
  });

  it('flags needsHuman when the matched product is out of stock', () => {
    const out = generateReplyDeterministic(
      build({
        incomingBody: 'Is the chocolate babka available?',
        products: [
          {
            id: 'p1',
            name: 'Chocolate Babka',
            priceCents: 2200,
            currency: 'USD',
            inStock: false,
            description: null,
          },
        ],
      }),
    );
    expect(out.citedProductIds).toEqual(['p1']);
    expect(out.needsHuman).toBe(true);
    expect(out.priority).toBe('high');
  });

  it('falls back to FAQ when no product matches and surfaces the answer', () => {
    const out = generateReplyDeterministic(
      build({
        incomingBody: 'Do you deliver locally?',
        products: [],
        faq: [
          {
            id: 'faq_delivery',
            question: 'Do you offer delivery?',
            answer: 'Yes — local courier same-day for orders placed before noon.',
          },
        ],
      }),
    );
    expect(out.body).toContain('local courier');
    expect(out.needsHuman).toBe(false);
  });

  it('always marks orders and reservations as needsHuman', () => {
    const order = generateReplyDeterministic(
      build({
        incomingBody: 'I want to order a birthday cake',
        products: [
          {
            id: 'p1',
            name: 'Birthday Cake',
            priceCents: 4500,
            currency: 'USD',
            inStock: true,
            description: null,
          },
        ],
      }),
    );
    expect(order.intent).toBe('order');
    expect(order.needsHuman).toBe(true);

    const reservation = generateReplyDeterministic(
      build({ incomingBody: 'Can I book a table for 6?' }),
    );
    expect(reservation.intent).toBe('reservation');
    expect(reservation.needsHuman).toBe(true);
  });

  it('lists business hours when asked', () => {
    const out = generateReplyDeterministic(
      build({
        incomingBody: 'What are your hours today?',
        businessHours: {
          timezone: 'America/Los_Angeles',
          lines: [
            { day: 'mon', open: 'closed', close: 'closed' },
            { day: 'tue', open: '07:00', close: '17:00' },
            { day: 'sat', open: '08:00', close: '17:00' },
          ],
        },
      }),
    );
    expect(out.intent).toBe('hours_location');
    expect(out.body).toContain('07:00–17:00');
    expect(out.body).toContain('America/Los_Angeles');
  });

  it('does not invent products; unknown asks route to needsHuman', () => {
    const out = generateReplyDeterministic(build({ incomingBody: 'lorem ipsum dolor' }));
    expect(out.needsHuman).toBe(true);
    expect(out.intent).toBe('unknown');
  });
});

describe('WhatsAppReplyService.generateAndQueue (DB-touching)', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestContext();
  });

  async function teardown() {
    await ctx.close();
  }

  it('seeds a product catalog, generates a draft outbound action, and is idempotent on rerun', async () => {
    const actor = await ctx.actorFor(MANAGER_EMAIL);
    // Set up a single product so the catalog has something to ground against.
    await ctx.db.repos.products.create({
      id: 'prd_test_choc',
      orgId: ctx.orgId,
      name: 'Chocolate Cake',
      priceCents: 4500,
      currency: 'USD',
      inStock: true,
      description: 'delicious',
    });
    // Seed a request so we have something to attach to.
    const req = await ctx.db.repos.requests.create({
      id: 'req_test_whatsapp',
      orgId: ctx.orgId,
      source: 'email',
      sourceRef: 'whatsapp:test',
      externalId: 'wamid.test.001',
      rawFrom: '+15555550100',
      rawSubject: 'WhatsApp message',
      rawBody: 'Do you have a chocolate cake for Saturday?',
      rawReceivedAt: new Date().toISOString(),
    });

    const result = await ctx.core.whatsappReply.generateAndQueue(actor, {
      requestId: req.id,
      incomingBody: req.rawBody,
    });
    expect(result.draftId).not.toBeNull();
    const draft = await ctx.core.outbounds.require(actor, result.draftId!);
    expect(draft.status).toBe('draft');
    expect(draft.channel).toBe('whatsapp');
    expect(draft.provider).toBe('whatsapp-cloud');
    expect(draft.to).toBe('+15555550100');

    // Re-running yields the same draft because of the dedupe key.
    const second = await ctx.core.whatsappReply.generateAndQueue(actor, {
      requestId: req.id,
      incomingBody: req.rawBody,
    });
    expect(second.draftId).toBe(result.draftId);
    await teardown();
  });
});
