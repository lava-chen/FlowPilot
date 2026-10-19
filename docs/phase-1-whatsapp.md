# FlowPilot — Phase 1: WhatsApp Business Cloud API

> Status: code implemented + tested. Live Meta verification is **Blocked** pending
> Meta developer credentials and a public webhook URL.

This document is the implementation report for Milestone 1 of the customer-fit
expansion. It records what shipped, where the seams are, and exactly what a
contributor must add to run it against the real WhatsApp Cloud API.

The single-line summary is unchanged from v0.1: **FlowPilot does not bypass the
human approval gate.** Every customer-visible send walks the same five-state
machine (`draft → pending_approval → approved → sending → sent`) and only a
human role can move across `pending_approval → approved`.

## What shipped

### Domain (`packages/domain`)
- `OutboundAction` entity + `OutboundActionStatus` / `OutboundActionChannel`
  enums and zod schemas.
- `outbound-action-state.ts` — pure transition table with guards. The state
  machine is the single source of truth; core is the only caller.
- `integration-contracts.ts` — `WhatsAppWebhookPayload`, `WhatsAppMessageEvent`,
  `WhatsAppStatusEvent`, and the `ReplyGenerationInput` / `ReplyGenerationOutput`
  zod schemas (used by both the deterministic Bakery reply analyzer and any
  future LLM-backed analyzer).
- Added `outbounds:read | write | decide` agent scopes.

### Database (`packages/database`)
- New migration `0005_whatsapp_outbound.sql`:
  - `outbound_actions` + `outbound_action_events` (append-only per-action log)
  - `products`, `faqs`, `business_hours` (catalog used by the deterministic
    reply generator; ground truth for AI grounding so we never invent stock or
    prices).
  - `leads` (CRM-lite; lead created from a WhatsApp inbound).
  - Optional row-level-security policies when `FLOWPILOT_ENABLE_RLS=true`.
- New repos: `OutboundActionRepo`, `LeadRepo`, `ProductRepo`, `FaqRepo`,
  `BusinessHoursRepo`.
- Optional seed for the **Retail Bakery** demo tenant
  (`FLOWPILOT_SEED_BAKERY=true pnpm db:seed`). The Bakery ships with a product
  catalog, FAQs, and weekly hours so the reply generator has something to ground
  against.

### Integrations (`packages/integrations`)
- `signature.ts` — HMAC-SHA256 webhook signature verification using
  `timingSafeEqual` (no `===` length leak); handshake verifier for
  `hub.mode=subscribe`; helper to *sign* for testing.
- `whatsapp-normalizer.ts` — turns the raw Meta envelope into a flat list of
  `WhatsAppMessageEvent` and `WhatsAppStatusEvent` records. Image / audio /
  video messages collapse to a short placeholder instead of being guessed at.
- `whatsapp-channel.ts` — `ChannelDriver` interface, `MockWhatsAppChannel`
  (default for offline / tests / demo), and `WhatsAppCloudChannel` (real
  Meta Cloud API). Default timeout 8s; 5xx/429 ⇒ `retryable: true`. All
  secrets are never logged.
- `whatsapp-adapter.ts` — `WhatsAppAdapter` implementing `IntegrationAdapter`
  plus `handleWhatsAppEvents` which funnels inbound messages through
  `ingestAndDraft` and outbound status callbacks into `OutboundActionRepo`.

### Core (`packages/core`)
- `OutboundActionService` — CRUD + lifecycle. The state machine guards every
  transition. Approving is a **human-only** action even when an agent has
  composable scopes; dedupe keys on `(org, channel, dedupeKey)` are enforced by
  the database `unique` constraint.
- `IntegrationService` — connection catalog projection (`demo | mock |
  not_configured | connected | error | reauth_required`). Secrets are stored
  encrypted in `integration_secrets` and read back only server-side (Phase 3;
  before that they were dropped before persistence).
- `WhatsAppReplyService` — deterministic Bakery reply generator that:
  - grounds every claim against the catalog (no invented stock / prices)
  - classifies intent (order / product_question / hours_location / pricing /
    reservation / complaint / unknown)
  - returns a draft `OutboundAction` that the reviewer still has to approve

### Web app (`apps/web`)
- `GET / POST /api/webhooks/whatsapp/[orgSlug]` — handshake + signature
  verification + event dispatch.
- `GET / PUT / DELETE /api/integrations/[provider]` — connection CRUD.
- `GET / POST /api/outbound-actions` + `…/[id]/{submit,decide,send,events}`.
- `POST /api/integrations/whatsapp/simulate` (demo only — gated on
  `FLOWPILOT_DEMO_MODE=true`).
- `POST /api/whatsapp/generate-reply`.
- Dashboard:
  - `/settings/integrations` — full catalog list with status + connection
    management surface.
  - `/settings/integrations/whatsapp` — connection form, webhook URL + verify
    token display, and the **demo simulator** (no real webhook required).
  - `/outbox` — pending approvals and recent activity, with the per-action
    event log so a reviewer can see why a send failed.

### Tests
- `packages/integrations/test/whatsapp.test.ts` — signature verifier
  (acceptance, rejection on tampered body, missing prefix, empty headers),
  handshake verifier (token mismatch, mode mismatch, whitespace tolerance),
  payload normalizer (text/image/status/error scenarios), `MockWhatsAppChannel`
  (scripted + default-failure paths), `WhatsAppCloudChannel` (real-API success,
  5xx retryable, 4xx non-retryable).
- `packages/core/test/outbound-action.test.ts` — full lifecycle
  (`draft → pending_approval → approved → sending → sent` via Mock channel),
  dedupe-key collision, validation, agent vs human approval gate, channel
  failure paths, cross-organization isolation.
- `packages/core/test/whatsapp-reply.test.ts` — Bakery analyzer: product
  matching, out-of-stock flagging, FAQ stem fallback (e.g. "Do you deliver
  locally?" → "Do you offer delivery?"), order/reservation always-`needsHuman`
  policy, business-hours formatting, idempotent draft creation against the
  repo.

Baseline: **84 tests** before Phase 1. After Phase 1: **122 tests** (+38).

## How to run it offline / without Meta credentials

1. `pnpm db:migrate` then `FLOWPILOT_SEED_BAKERY=true pnpm db:seed`. This adds
   the **Retail Bakery** demo tenant with products, FAQs, and weekly hours.
2. Sign in with `owen@saturdaybakery.test / demo1234` (owner).
3. Go to **Integrations → WhatsApp Business** → click **Simulate inbound
   WhatsApp**. Type any message such as
   *"I'd like to order a birthday cake for Saturday. Do you have any chocolate
   options?"* and submit.
4. The request appears in the dashboard inbox alongside the inbox-style
   metadata (sender phone + first line of body).
5. Open **Outbox**: the analyzer has queued a `draft` outbound action. Click
   **Approve**, then **Send now**. The Mock channel records the call and the
   row flips to `sent` with `externalMessageId = mock-msg-000001`.

## What is required to talk to the real Meta Cloud API

The code is wired and tested. The remaining work is operational:

1. **Meta developer account + WhatsApp Business Account.** Until those exist,
   `live verification: blocked`. The app cannot ship a WhatsApp-enabled button
   in production until this is resolved.
2. **A public HTTPS webhook URL.** For local development, ngrok or Cloudflare
   Tunnel provides one. The webhook URL is per-tenant:
   `https://<host>/api/webhooks/whatsapp/<org-slug>`.
3. **App Secret / Verify Token / Access Token / Phone Number ID** saved through
   `PUT /api/integrations/whatsapp-cloud`. The dashboard does NOT echo these
   back. As of [Phase 3](phase-3-integration-hardening.md) they are encrypted at
   rest in the `integration_secrets` table under per-secret AES-GCM keys.
   **Note:** at the `398bb8d` commit this was not true — `redactConfig()` deleted
   `accessToken` and `appSecret` before persisting, so the webhook signature check
   always failed and sends silently used the mock. Phase 3 fixed it; if you are on
   `398bb8d` or earlier, real WhatsApp delivery cannot work.
4. **Webhook verification in Meta dashboard.** Subscribe to the URL above;
   paste the verify token exactly. The `hub.mode=subscribe` handshake is
   handled by the same route.
5. **Allowed recipient list.** WhatsApp's Cloud API only sends free-form
   messages within the 24h customer-service window. Outside that window the
   provider returns error code `131030` ("Recipient not allowed"), which the
   channel surfaces in `outbound_action_events` and the action row flips to
   `failed`. The mock driver scripts the same error code via
   `scripted.set(dedupeKey, { ok: false, errorCode: '131030', ... })`.

When the org has a stored access token, the **Send now** button uses
`WhatsAppCloudChannel`; with no credentials at all it uses `MockWhatsAppChannel`
for the offline demo. Since [Phase 3](phase-3-integration-hardening.md) a
*half-configured* integration (config present but no token) raises an error
instead of silently downgrading to the mock.

## Deliberate non-goals (Phase 1)

These were called out in the task brief but kept out of scope so Phase 1 stays
self-contained:

- Media attachments in inbound messages (audio / video / documents) are
  represented by short placeholders; the dashboard never downloads them.
- Background "queue" job runner: webhook ingestion is inline because the
  Meta retry budget gives us headroom, and the request pipeline is fully
  idempotent. A real production deployment should layer a queue in front of
  `handleWhatsAppEvents` (extension point, marked in the code).
- Multi-locale template management for outbound marketing messages. Phase 1
  sticks to text replies; template messages come with Phase 4 / n8n.
- The WhatsApp conversation window (24h after the customer's last message)
  is enforced by Meta, not by FlowPilot. A `failed` action with code
  `131030` is the system's signal that the window has closed.

## Where things live

```
packages/
  domain/src/
    entities.ts                        OutboundAction + OutboundActionStatus
    outbound-action-state.ts           pure state machine + guards
    integration-contracts.ts           WhatsApp envelope, ReplyGeneration
  database/
    migrations/0005_whatsapp_outbound.sql
    repos/outbound.ts                  OutboundActionRepo / Lead / Catalog
  integrations/src/
    signature.ts                       verifyWhatsAppSignature / Handshake
    whatsapp-normalizer.ts             flatten Meta envelope
    whatsapp-channel.ts                ChannelDriver + Mock + Real
    whatsapp-adapter.ts                WhatsAppAdapter + handleWhatsAppEvents
  core/src/
    outbound-action.service.ts         lifecycle + dedupe + audit
    integration.service.ts             catalog projection
    whatsapp-reply.service.ts          deterministic Bakery reply generator

apps/web/src/app/api/
  webhooks/whatsapp/[orgSlug]/         GET (handshake) + POST (events)
  integrations/
    route.ts                           GET list catalog
    [provider]/route.ts                GET / PUT / DELETE connection
    whatsapp/simulate/route.ts         demo-mode simulator
  outbound-actions/
    route.ts                           GET list, POST create draft
    [id]/submit/route.ts               draft → pending_approval
    [id]/decide/route.ts               pending_approval → approved | rejected
    [id]/send/route.ts                 approved → sending → sent | failed
    [id]/events/route.ts               per-action event log
  whatsapp/generate-reply/route.ts     queue a deterministic Bakery draft

apps/web/src/app/(app)/
  settings/integrations/page.tsx       full catalog list
  settings/integrations/whatsapp/      config + simulator + state machine
  outbox/                              pending approvals + recent activity
```
