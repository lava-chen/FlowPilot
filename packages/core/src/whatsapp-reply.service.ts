import type { FlowPilotDb } from '@flowpilot/database';
import type {
  Actor,
  OutboundAction,
  ReplyGenerationInput,
  ReplyGenerationOutput,
} from '@flowpilot/domain';
import { assertCan } from './permissions.js';
import type { IntegrationService } from './integration.service.js';
import { newId } from '@flowpilot/shared';

/**
 * Deterministic reply generator for inbound WhatsApp messages to businesses with a small
 * product / FAQ / hours catalog.
 *
 * This is intentionally NOT a large LLM-based feature:
 *   - The agent must never invent stock levels, prices, or order status. The catalog is the
 *     ground truth.
 *   - When the message is ambiguous (the catalog can't satisfy it) the generator sets
 *     `needsHuman=true` and produces a polite *acknowledgement* the human reviewer can edit
 *     or replace.
 *   - All orders / reservations / complaints → `needsHuman=true`. Only FAQs, hours, and
 *     product-availability questions can be answered automatically.
 *
 * In Phase 2 a configured OpenAI-compatible provider may replace this generator with
 * structured extraction; for now the deterministic rules are the default and must work
 * across tenants without any model configuration.
 */
export interface GenerateReplyInput {
  requestId: string;
  incomingBody: string;
  fromName?: string | null;
  /** When omitted the analyzer uses the catalog state at the moment of generation. */
  catalog?: ReplyGenerationInput;
}

export interface GenerateAndQueueResult {
  reply: ReplyGenerationOutput;
  /** Created draft when one was queued for approval, null otherwise (e.g. needsHuman=false but no body change). */
  draftId: string | null;
}

export interface WhatsappReplyServiceDeps {
  db: FlowPilotDb;
  integrations: IntegrationService;
}

export class WhatsAppReplyService {
  constructor(private readonly deps: WhatsappReplyServiceDeps) {}

  /** Builds a `ReplyGenerationInput` from the org's catalog at the moment of generation. */
  async buildCatalog(
    actor: Actor,
    _today: string = new Date().toISOString().slice(0, 10),
  ): Promise<{
    products: ReplyGenerationInput['products'];
    faq: ReplyGenerationInput['faq'];
    businessHours: ReplyGenerationInput['businessHours'];
  }> {
    assertCan(actor, 'integrations:read');
    const [products, faqs, hours] = await Promise.all([
      this.deps.db.repos.products.list(actor.orgId),
      this.deps.db.repos.faqs.list(actor.orgId),
      this.deps.db.repos.businessHours.list(actor.orgId),
    ]);
    return {
      products: products.map((p) => ({
        id: p.id,
        name: p.name,
        priceCents: p.priceCents,
        currency: p.currency,
        inStock: p.inStock,
        description: p.description,
      })),
      faq: faqs.map((f) => ({ id: f.id, question: f.question, answer: f.answer })),
      businessHours:
        hours.length === 0
          ? null
          : {
              timezone: hours[0]?.timezone ?? 'UTC',
              lines: hours.map((h) => ({
                day: h.weekday,
                open: h.isClosed ? 'closed' : h.openTime ?? '00:00',
                close: h.isClosed ? 'closed' : h.closeTime ?? '00:00',
              })),
            },
    };
  }

  async generate(actor: Actor, input: GenerateReplyInput): Promise<ReplyGenerationOutput> {
    assertCan(actor, 'integrations:read');
    const today = new Date().toISOString().slice(0, 10);
    const built = await this.buildCatalog(actor, today);
    const enriched: ReplyGenerationInput = {
      requestId: input.requestId,
      incomingBody: input.incomingBody,
      inferredIntent: null,
      products: built.products,
      faq: built.faq,
      businessHours: built.businessHours,
      today,
    };
    return generateReplyDeterministic(enriched);
  }

  /**
   * Generate a reply and queue it as a `draft` OutboundAction tied to the request.
   * The reviewer still has to approve it before any message goes out.
   */
  async generateAndQueue(actor: Actor, input: GenerateReplyInput): Promise<GenerateAndQueueResult> {
    const reply = await this.generate(actor, input);
    const action = await createDraftForReply(this.deps.db, actor, input, reply);
    return { reply, draftId: action.id };
  }
}

/* -------------------------------------------------------------------------- */
/* Pure generator (no I/O)                                                     */
/* -------------------------------------------------------------------------- */

export function generateReplyDeterministic(input: ReplyGenerationInput): ReplyGenerationOutput {
  const text = input.incomingBody.toLowerCase();
  const intent = classifyIntent(text);
  const greeting = `Hi${greetee(input)},`;
  const products = input.products;
  const faq = input.faq;

  if (intent === 'hours_location') {
    const hours = formatHours(input.businessHours);
    return {
      intent: 'hours_location',
      confidence: 0.85,
      body: [greeting, hours, 'Thanks for reaching out — see you soon!'].filter(Boolean).join('\n\n'),
      citedProductIds: [],
      needsHuman: false,
      reason: null,
      priority: 'normal',
    };
  }

  if (intent === 'product_question' || intent === 'pricing') {
    const matches = products.filter((p) => text.includes(p.name.toLowerCase()));
    if (matches.length > 0) {
      const lines = matches.map((p) => {
        const price = p.priceCents != null ? formatPrice(p.priceCents, p.currency) : 'price on request';
        const stock = p.inStock ? 'in stock' : 'currently unavailable';
        return `• ${p.name} — ${price} (${stock})${p.description ? `\n  ${p.description}` : ''}`;
      });
      return {
        intent,
        confidence: 0.8,
        body: [greeting, 'Here is what we have available today:', ...lines, 'Reply to place an order or ask anything else.'].join('\n\n'),
        citedProductIds: matches.map((p) => p.id),
        needsHuman: matches.some((p) => !p.inStock),
        reason: matches.some((p) => !p.inStock) ? 'Some items are out of stock; a human should confirm availability.' : null,
        priority: matches.some((p) => !p.inStock) ? 'high' : 'normal',
      };
    }
    // No product match: route to FAQ using a stemmed token overlap so
    // "do you deliver locally?" surfaces the "Do you offer delivery?" entry.
    const faqHit = faq.find((f) => {
      const q = f.question.toLowerCase();
      const tokens = Array.from(new Set(q.split(/[^a-z0-9]+/).filter((t) => t.length >= 4)));
      if (tokens.length === 0) return false;
      let matching = 0;
      for (const t of tokens) {
        // Drop common suffixes so stems overlap: "delivery" → "deliver", "offered" → "offer".
        const stem = t.replace(/(ing|ed|er|ly|ies|ied|ies|s|y)$/, '');
        // Also try the prefix of the token (>= 4 chars) so "delivery" matches "deliver".
        const prefix = t.length > 5 ? t.slice(0, t.length - 2) : t;
        if (text.includes(stem) || text.includes(t) || text.includes(prefix)) matching++;
      }
      return matching >= Math.max(1, tokens.length - 1);
    });
    if (faqHit) {
      return {
        intent: 'product_question',
        confidence: 0.7,
        body: [greeting, faqHit.answer, 'Want to order or ask something specific? Just reply here.'].join('\n\n'),
        citedProductIds: [],
        needsHuman: false,
        reason: null,
        priority: 'normal',
      };
    }
    return needsHumanReply('product_question', greeting, 'We could not match the question to the catalog — a team member will follow up.');
  }

  if (intent === 'order' || intent === 'reservation') {
    return needsHumanReply(
      intent,
      greeting,
      'Orders and reservations are confirmed by the team — we will reach out shortly to confirm timing, price, and pickup/delivery details.',
    );
  }

  if (intent === 'complaint') {
    return needsHumanReply(
      'complaint',
      greeting,
      'Thanks for letting us know — a team member will reach out to make this right.',
      'high',
    );
  }

  // Default: small-talk or unrecognized message — keep it polite, and ask the customer to clarify.
  return {
    intent: 'unknown',
    confidence: 0.3,
    body: [greeting, 'Thanks for the message! Could you tell us a little more about what you need (e.g. product name, pickup date)? A team member will reply shortly.'].join('\n\n'),
    citedProductIds: [],
    needsHuman: true,
    reason: 'Message did not match a known intent; clarification needed.',
    priority: 'normal',
  };
}

function classifyIntent(text: string): ReplyGenerationOutput['intent'] {
  if (/(unhappy|disappointed|complain|wrong|broken|missing|refund)/.test(text)) return 'complaint';
  if (/(book|reserve|reservation|seating|table for)/.test(text)) return 'reservation';
  if (/(hour|open|close|address|location|where are you|when do you|when are you)/.test(text)) return 'hours_location';
  if (/(price|how much|cost)/.test(text)) return 'pricing';
  if (/(available|in stock|do you have|do you sell|do you offer|do you deliver|deliver|delivery|shipping|ship|pickup|gluten|dairy|sweet|vegan|chocolate|wheat|nut)/.test(text)) {
    return 'product_question';
  }
  // Order: must contain an order verb. Plain product mentions without one are questions.
  if (/(order|buy|purchase|place an order|want to|i'd like|i would like|need to)/.test(text)) return 'order';
  return 'unknown';
}

/**
 * Returns `name` from the request if available; we keep the greeting generic to avoid
 * auto-generating PII the customer never consented to share. The reviewer can change it.
 */
function greetee(_input: ReplyGenerationInput | { incomingBody: string }): string {
  return '';
}

export function greeteeName(name: string | null | undefined): string {
  if (!name) return '';
  const cleaned = name.trim();
  if (cleaned.length === 0) return '';
  if (cleaned.length > 32) return ` ${cleaned.slice(0, 30)}…`;
  return ` ${cleaned}`;
}

function formatHours(hours: ReplyGenerationInput['businessHours']): string {
  if (!hours) return 'Our hours are posted in the storefront — feel free to ask in your reply and we will confirm.';
  const lines = hours.lines.map((l) => `• ${capitalize(l.day)} ${l.open && l.close ? `${l.open}–${l.close}` : 'closed'}`);
  return ['Our hours this week:', ...lines, `All times in ${hours.timezone}.`].join('\n');
}

function formatPrice(cents: number, currency: string): string {
  const v = (cents / 100).toFixed(2);
  return `$${v} ${currency}`;
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0]?.toUpperCase() + s.slice(1);
}

function needsHumanReply(
  intent: ReplyGenerationOutput['intent'],
  greeting: string,
  body: string,
  priority: 'normal' | 'high' = 'normal',
): ReplyGenerationOutput {
  return {
    intent,
    confidence: 0.3,
    body: [greeting, body].filter(Boolean).join('\n\n'),
    citedProductIds: [],
    needsHuman: true,
    reason: body,
    priority,
  };
}

/* -------------------------------------------------------------------------- */
/* Draft creation (DB-touching; kept here to avoid an import cycle)            */
/* -------------------------------------------------------------------------- */

async function createDraftForReply(
  db: FlowPilotDb,
  actor: Actor,
  input: GenerateReplyInput,
  reply: ReplyGenerationOutput,
): Promise<OutboundAction> {
  // Look up the request to derive the sender + the right phone number.
  const request = await db.repos.requests.require(actor.orgId, input.requestId);
  const phone = extractPhone(request.rawFrom);

  const dedupeKey = `whatsapp:reply:${request.externalId}`;

  const existing = await db.repos.outboundActions.findByDedupeKey(actor.orgId, 'whatsapp', dedupeKey);
  if (existing) return existing;

  const action = await db.repos.outboundActions.create({
    id: newId('outbound'),
    orgId: actor.orgId,
    channel: 'whatsapp',
    provider: 'whatsapp-cloud',
    to: phone ?? request.rawFrom,
    subject: null,
    body: reply.body,
    requestId: input.requestId,
    leadId: null,
    dedupeKey,
    createdBy: actor.kind === 'user' ? actor.userId : 'system',
    status: 'draft',
  });

  await db.repos.outboundActions.recordEvent({
    id: newId('outboundEvent'),
    orgId: actor.orgId,
    actionId: action.id,
    fromStatus: null,
    toStatus: 'draft',
    actorKind: actor.kind,
    actorId: actor.kind === 'user' ? actor.userId : 'system',
    actorLabel: actor.kind === 'user' ? actor.displayName : 'Reply generator',
  });

  // Mirror `OutboundActionService.createDraft`'s audit call so the activity feed and
  // the e2e test both see a record for the generated draft. Audit is a separate repo
  // because the helper here intentionally bypasses the service to keep the generator
  // self-contained.
  await db.repos.audit.record({
    id: newId('audit'),
    orgId: actor.orgId,
    actorKind: actor.kind,
    actorId: actor.kind === 'user' ? actor.userId : 'system',
    actorLabel: actor.kind === 'user' ? actor.displayName : 'Reply generator',
    action: 'outbound_action.drafted',
    entityType: 'outbound_action',
    entityId: action.id,
    metadata: {
      channel: action.channel,
      provider: action.provider,
      to: action.to,
      generator: 'deterministic_bakery',
      intent: reply.intent,
      needsHuman: reply.needsHuman,
    },
  });

  return action;
}

function extractPhone(rawFrom: string): string | null {
  // rawFrom looks like `Alice <+15551234567>` or just `+15551234567`. Be conservative.
  const match = rawFrom.match(/\+?\d[\d\s-]{6,}/);
  if (!match) return null;
  return match[0].replace(/[\s-]/g, '');
}
