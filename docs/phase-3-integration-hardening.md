# Phase 3 — Integration Hardening

**Status:** code complete and verified in CI · live Meta/Entra verification still **blocked on credentials**

This phase fixes three defects found in `398bb8d` by external review. All three were real; all
three are now covered by tests that were shown to fail against the old behaviour.

---

## What was wrong

### P0 #1 — WhatsApp credentials were discarded before persistence

`IntegrationService.upsert` ran every incoming config blob through a `redactConfig()` helper that
**deleted** `accessToken`, `appSecret`, and `apiKey` before writing to
`integration_connections.config`. The class comment claimed secrets "live encrypted" in that
column; no encryption existed.

Three downstream consumers read those fields back:

| Consumer | Field read | Consequence |
| --- | --- | --- |
| `GET /api/webhooks/whatsapp/[orgSlug]` | `config['verifyToken']` | worked — `verifyToken` was in the allow-list |
| `POST /api/webhooks/whatsapp/[orgSlug]` | `config['appSecret']` | always `''` → **every real webhook POST returned 401** |
| `POST /api/outbound-actions/[id]/send` | `config['accessToken']` | always `''` → **silently fell back to `MockWhatsAppChannel`** |

The send path was the dangerous one: an org with genuinely configured Meta credentials pressed
Send, saw a green `sent` with an `externalMessageId`, and no message left the building. The demo
was indistinguishable from production.

The test suite stayed green because nothing asserted that a saved credential could be read back.

### P0 #2 — Outlook had no send path, and no draft path

- The send route returned `MockWhatsAppChannel` for every non-`whatsapp-cloud` provider. An
  `outlook-graph` outbound action was dispatched over the **wrong channel entirely** — and this
  was reachable, since `OutboundActionChannelSchema` includes `'email'` and
  `CreateDraftSchema.provider` accepts any non-empty string.
- `OutlookSyncService.tryCreateDraft()` returned `false` unconditionally. Mail synced into the
  inbox and stopped there; there was no route from "email arrived" to "human approves a reply".

### P1 #1 — `approved → sending` was not atomic

`OutboundActionRepo.updateStatus` issued `where id = $1 and org_id = $2` with no expected-status
predicate. `OutboundActionService.send()` read the status, validated the transition in JS, then
wrote `'sending'` unconditionally. Two concurrent requests both read `approved`, both passed
validation, both called `channel.send()`. **The customer received the message twice.**

---

## What changed

### Credential storage

New migration `0008_integration_secrets.sql`, deliberately mirroring `0007_outlook_oauth.sql` so
both secret stores share one mental model — ciphertext + iv + auth_tag per secret, never
plaintext.

```
integration_secrets (org_id, provider, secret_name) -> ciphertext, iv, auth_tag
```

One row per secret, so rotating an access token never read-modify-writes the app secret.

Two new `SecretContext` keys in `settings-crypto.ts`:

```
integrationAccessToken : flowpilot:integration-access-token:v1\0
integrationAppSecret   : flowpilot:integration-app-secret:v1\0
```

Split from `oauthAccess` deliberately: a leaked Entra token must not expose a Meta token, and the
two live in the same database read by different subsystems.

`IntegrationService` now **encrypts on write** instead of stripping, and exposes one
server-side read path:

- `readSecret(orgId, provider, name)` → `string | null`. Never reachable from an HTTP route.
  Returns `null` for "never configured" but **throws** `ValidationError` when a stored secret
  cannot be decrypted — silently returning `''` would push callers back into mock delivery, which
  is the exact failure this store exists to remove.
- `listSecretNames(orgId, provider)` → `string[]`. Safe for the dashboard.
- `getConnectionConfig(orgId, provider)` / `getConnectionStatus(orgId, provider)` — dispatcher
  accessors with no permission check, for callers that already resolved the org.

`disconnect()` now purges credentials. A "disconnected" integration that still holds a usable
token is the kind of thing that gets reconnected without anyone realising the old credential is
on disk.

### No silent mock fallback

The send route now dispatches **per provider** and fails loudly on a misconfigured integration:

| State | WhatsApp | Outlook |
| --- | --- | --- |
| No credentials at all | `MockWhatsAppChannel` (legitimate demo) | `MockOutlookGraphChannel` |
| Config present, no token | **throws** | n/a |
| Token present, incomplete config | **throws** | **throws** |
| Fully configured | `WhatsAppCloudChannel` (live) | `OutlookGraphChannel` (live, token via OAuth service) |

The Outlook driver takes a `tokenProvider` rather than a fixed token, so an expired access token
is refreshed by the OAuth service at send time instead of failing the send.

### Outlook draft path

`tryCreateDraft` is implemented. `OutlookSyncService` receives `OutboundActionService` as an
**injected dependency** — the original stub existed because the service had no way to reach it
without risking a cycle; injection keeps the layering rule intact (`core` never imports the web
app's channel wiring).

The draft is created in `draft` status and nothing further. A human still submits and approves,
so the auto-draft has no external effect by construction. Dedupe key is
`outlook-graph:reply:<messageId>`, mirroring the WhatsApp convention.

The auto-drafted body is a deliberately neutral acknowledgement. The Bakery catalog grounding
from Phase 1 does not apply to arbitrary inbound mail, so inventing a commitment ("your order
ships Tuesday") would reproduce the failure the catalog grounding exists to prevent. A human
edits it in the Outbox before approving.

### Concurrency

`updateStatus` takes an optional `expectedStatus`, making it a compare-and-swap:

```sql
update outbound_actions set status = $1, ...
 where id = $n and org_id = $n+1 and status = $n+2   -- CAS
returning *
```

A lost race returns `null` rather than throwing `NotFoundError` (the id does exist; it is simply
no longer in the expected state). Callers that pass `expectedStatus` treat `null` as "someone else
got there first."

Applied to all four status-writing paths: `send()` claiming `sending`, `send()` writing `sent` /
`failed`, `decide()` writing the approval verdict, and the WhatsApp status-webhook callback — Meta
retries status webhooks, so those race too.

---

## Verification

| Check | Result |
| --- | --- |
| `pnpm typecheck` | clean |
| `pnpm test` | **183 passed / 183** across 19 files (was 155/16) |
| `pnpm build` | green |

### Tests added (28)

`packages/core/test/integration-secrets.test.ts` (14) — round-trip, no secrets in `config`,
ciphertext on disk, distinct keys per secret, non-secret config still readable, omitted-secret
saves preserve stored credentials, rotation, disconnect purge, cross-org isolation, undecryptable
→ throws, and a live-driver construction check.

`packages/core/test/outbound-concurrency.test.ts` (7) — asserts the **observable** invariant
(provider called exactly once) rather than that a SQL clause exists: two senders race, eight
senders burst, loser gets an actionable message, one `sending` event not two, sequential re-send
refused, competing approvals produce one verdict, failed send not silently retried.

`packages/core/test/outlook-draft.test.ts` (7) — drafts created per synced message, correct
recipient and single `Re:` prefix, body invents no commitments, idempotent across re-sync, full
draft → approval → send chain over the Outlook channel, sync still works with no
`OutboundActionService` injected, no draft for a sender-less message.

### Mutation-verified

New tests were confirmed to fail against the old behaviour before being accepted:

| Mutation | Result |
| --- | --- |
| Revert `splitSecrets` to strip-instead-of-store | **8 of 14 fail** |
| Remove `expectedStatus` from `send()`'s CAS | **3 of 7 fail**, including the double-send assertion |

Without this step a green suite proves nothing — these are exactly the guards that were
ineffective when the defects shipped.

---

## Still blocked

Unchanged from Phase 1/2, and not fixable in code:

- **Live Meta verification** — needs a Meta developer account, a public webhook URL, App Secret,
  Verify Token, Access Token, Phone Number ID.
- **Live Microsoft Graph verification** — needs an Entra app registration, client secret, tenant,
  and a public callback URL.

What changed is that when credentials are supplied, the code path is now reachable and will
report real results. Previously supplying credentials could not have worked, and would not have
told you so.

A third item from the review remains open by choice:

- **P1 #2 — background job runner.** WhatsApp webhook processing is synchronous inside the
  request; Outlook sync is manual-trigger. No durable queue, retry, or recovery. This is a new
  subsystem rather than a defect, and was deliberately deferred to keep this change reviewable.

---

## Honest status

| Claim | Status |
| --- | --- |
| WhatsApp real send + webhook signature verification | **Code ready. Live verification blocked.** |
| Outlook read → draft → approval → send | **Code ready. Live verification blocked.** |
| Concurrent double-send | **Fixed and tested.** |
| Credential encryption at rest | **Done and tested.** |
| Background job runner | **Not started.** |
| n8n / generic webhook bridge | **Not started** (Phase 4, never claimed). |
