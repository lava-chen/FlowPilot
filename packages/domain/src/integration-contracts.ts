import { z } from 'zod';
import { PrioritySchema } from './entities.js';

/**
 * Integration webhook / event contracts.
 *
 * These are provider-side payload types. Each integration has its own narrow shape so the
 * caller can decide *which* provider produced the body, the parsing layer rejects anything that
 * does not match, and a malformed payload never reaches the business pipeline.
 *
 * Keep the shape *small*: anything more than what the unified inbox needs is preserved in
 * `metadata` for audit and replay, not parsed into the typed shape.
 */

/* -------------------------------------------------------------------------- */
/* WhatsApp Cloud API                                                          */
/* -------------------------------------------------------------------------- */

/**
 * POST body for the verification handshake (Meta sends this as a query string).
 * The webhook controller short-circuits before the signature verify when this matches.
 */
export const WhatsAppVerificationChallengeSchema = z.object({
  'hub.mode': z.literal('subscribe'),
  'hub.verify_token': z.string(),
  'hub.challenge': z.string(),
});

/**
 * Raw Meta webhook payload. Either:
 *   { object: 'whatsapp_business_account', entry: [...] }   business events
 *   { object: 'whatsapp_business_account', entry: [...] }   status events
 * We keep the parser permissive so the same payload can carry either.
 */
export const WhatsAppWebhookPayloadSchema = z.object({
  object: z.literal('whatsapp_business_account'),
  entry: z.array(
    z
      .object({
        id: z.string().optional(),
        changes: z
          .array(
            z.object({
              field: z.string(),
              value: z
                .object({
                  messaging_product: z.literal('whatsapp').optional(),
                  metadata: z
                    .object({
                      display_phone_number: z.string().optional(),
                      phone_number_id: z.string().optional(),
                    })
                    .passthrough()
                    .optional(),
                  contacts: z
                    .array(
                      z
                        .object({
                          profile: z.object({ name: z.string().optional() }).passthrough().optional(),
                          wa_id: z.string().optional(),
                        })
                        .passthrough(),
                    )
                    .optional(),
                  messages: z
                    .array(
                      z
                        .object({
                          id: z.string().optional(),
                          from: z.string().optional(),
                          timestamp: z.union([z.string(), z.number()]).optional(),
                          type: z.string().optional(),
                          text: z.object({ body: z.string() }).optional(),
                          image: z
                            .object({ id: z.string().optional(), mime_type: z.string().optional(), caption: z.string().optional() })
                            .passthrough()
                            .optional(),
                          // We deliberately keep the parser broad here: features vary per
                          // business account, and the dashboard surfaces raw text only.
                        })
                        .passthrough(),
                    )
                    .optional(),
                  statuses: z
                    .array(
                      z
                        .object({
                          id: z.string().optional(),
                          status: z.string().optional(),
                          timestamp: z.union([z.string(), z.number()]).optional(),
                          recipient_id: z.string().optional(),
                          errors: z
                            .array(z.object({ code: z.union([z.string(), z.number()]).optional(), title: z.string().optional() }).passthrough())
                            .optional(),
                        })
                        .passthrough(),
                    )
                    .optional(),
                })
                .passthrough(),
            }),
          )
          .optional(),
      })
      .passthrough(),
  ),
});

export type WhatsAppWebhookPayload = z.infer<typeof WhatsAppWebhookPayloadSchema>;

export type WhatsAppMessageType = 'text' | 'image' | 'document' | 'audio' | 'video' | 'unknown';

/**
 * Result of normalizing a single Meta message into a FlowPilot-side record.
 * The webhook controller turns one of these into either an inbound `Request` (text/image)
 * or a status update for an `OutboundAction`.
 */
export interface WhatsAppMessageEvent {
  /** Provider message id, used as the idempotency key. */
  externalId: string;
  /** Sender's WhatsApp id (phone number, E.164 without the plus). */
  from: string;
  /** Profile display name, if provided. */
  fromName: string | null;
  /** The phone_number_id the message arrived on. Used for routing/replies. */
  phoneNumberId: string;
  type: WhatsAppMessageType;
  body: string;
  receivedAt: string;
  businessAccountId: string | null;
  displayPhoneNumber: string | null;
}

export interface WhatsAppStatusEvent {
  externalId: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  recipientId: string;
  at: string;
  errorCode: string | null;
  errorTitle: string | null;
}

/* -------------------------------------------------------------------------- */
/* Microsoft Outlook (Microsoft Graph)                                         */
/* -------------------------------------------------------------------------- */

/**
 * Handshake parameters for `GET /api/integrations/outlook-graph/oauth/start`.
 * Microsoft Entra's `common` tenant works for multi-tenant apps; production
 * deployments usually pin a single tenant id.
 */
export const OutlookOAuthStartQuerySchema = z.object({
  /** Optional `state` nonce. The server always generates a strong verifier
   *  server-side, so this is purely an extra tag. */
  returnTo: z.string().optional(),
});

export type OutlookOAuthStartQuery = z.infer<typeof OutlookOAuthStartQuerySchema>;

/**
 * Outlook mail sync cursor — Microsoft Graph returns a `@odata.deltaLink` that the
 * caller passes back to fetch only the changes since the previous call. We persist
 * the cursor as part of `integration_connections.config` (`outlook.deltaLink`) so
 * a server restart doesn't lose progress.
 */
export interface OutlookSyncCursor {
  /** Full deltaLink URL returned by Graph (contains the next skip token). */
  deltaLink: string;
  /** ISO timestamp of the last sync. Used for logs and audit, not for filtering. */
  syncedAt: string;
  /** Number of messages ingested across all sync runs since this cursor was stored. */
  totalIngested: number;
}

/**
 * Normalized inbox message derived from a Graph `mailFolder.messages` payload.
 * Field selection is intentionally minimal: we surface what the AI inbox + reply
 * draft need. Anything else stays in the raw JSONB `analysis` blob for replay.
 */
export interface OutlookMessageEvent {
  /** Microsoft Graph message id — the idempotency key for ingestion. */
  externalId: string;
  /** Sender SMTP address. */
  from: string;
  fromName: string | null;
  /** List of additional recipients (To/Cc/Bcc SMTP addresses). */
  to: string[];
  subject: string;
  /** Body as plain text. We deliberately don't store HTML — the AI analyzer + the
   *  reply draft both work in plain text. */
  body: string;
  receivedAt: string;
  /** Mail folder path ("inbox", "junkemail", ...). Used to filter junk. */
  folder: string;
  /** True when the user is in the To/Cc list (not Bcc). */
  directlyAddressed: boolean;
  /** Incremental ChangeTracking token from the previous /messages?$delta= call,
   *  stored alongside the message so future syncs can correlate. */
  changeKey: string | null;
}

export const ReplyGenerationInputSchema = z.object({
  requestId: z.string(),
  incomingBody: z.string(),
  inferredIntent: z.string().nullable(),
  products: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        priceCents: z.number().int().nonnegative().nullable(),
        currency: z.string(),
        inStock: z.boolean(),
        description: z.string().nullable(),
      }),
    )
    .default([]),
  faq: z
    .array(z.object({ id: z.string(), question: z.string(), answer: z.string() }))
    .default([]),
  businessHours: z
    .object({
      timezone: z.string(),
      lines: z.array(z.object({ day: z.string(), open: z.string(), close: z.string() })),
    })
    .nullable()
    .default(null),
  today: z.string(),
});

export const ReplyGenerationOutputSchema = z.object({
  intent: z.enum([
    'order',
    'product_question',
    'hours_location',
    'pricing',
    'reservation',
    'complaint',
    'general_inquiry',
    'unknown',
  ]),
  confidence: z.number().min(0).max(1),
  body: z.string().min(1).max(4000),
  /** Product ids cited in `body` so the draft can hyperlink back to the catalog. */
  citedProductIds: z.array(z.string()).default([]),
  /** True if the bot could not resolve the question — a human must step in. */
  needsHuman: z.boolean(),
  reason: z.string().nullable(),
  /** Suggested priority the reviewer should assign to the resulting outbound action. */
  priority: PrioritySchema,
});

export type ReplyGenerationInput = z.infer<typeof ReplyGenerationInputSchema>;
export type ReplyGenerationOutput = z.infer<typeof ReplyGenerationOutputSchema>;
