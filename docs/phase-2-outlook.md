# FlowPilot — Phase 2: Microsoft Outlook via Microsoft Graph

> Status: code implemented + tested. **Live Graph verification is Blocked** until an
> Entra (Azure AD) app registration is available — every code path is exercised against
> a mocked fetch + the in-process unit tests, and the operations match Microsoft docs
> 1:1 with the v2.0 endpoint.

The single-line summary, again, is unchanged: **FlowPilot does not bypass the
human approval gate.** A real Outlook-sourced email goes through the same
ingestion, analysis, draft, approve, send loop; only the *transport* is real now.

## What shipped

### Domain (`packages/domain`)
- New shape: `OutlookMessageEvent` (delta-query message envelope).
- New shape: `OutlookSyncCursor` (the `@odata.deltaLink` we persist).
- zod validation: `OutlookOAuthStartQuerySchema`.

### Database (`packages/database`)
- Migration `0007_outlook_oauth.sql`:
  - `oauth_states` — short-lived PKCE state rows (org-scoped, expires in 10 min)
  - `oauth_tokens` — encrypted blob per `(org, provider)` carrying access/refresh
    tokens; AES-256-GCM with domain-separated keys (`oauthAccess` / `oauthRefresh`
    contexts so a leaked AI key does not also leak OAuth tokens)
  - `integration_sync_cursors` — generic delta cursor table (not Outlook-specific;
    Phase 4 will reuse it for n8n / generic webhooks)
- New repos: `OAuthStateRepo`, `OAuthTokenRepo`, `SyncCursorRepo`, plus the
  sharded email helper repos.

### Integrations (`packages/integrations`)
- `outlook-channel.ts`:
  - `OutlookGraphChannel` — real driver. Hits `POST /me/sendMail` with the access
    token from the OAuth service; 5xx/429 ⇒ retryable, 4xx ⇒ permanent.
  - `MockOutlookGraphChannel` — offline / test driver with scripted outcomes.
- `outlook-normalizer.ts`:
  - `normalizeOutlookMessage` / `normalizeOutlookMessages` — Graph envelope → event
  - HTML body → plain text with paragraph-preserving newline substitution
  - Junk-email folder tagging so the sync service can drop spam automatically
- `outlook-adapter.ts`:
  - `OutlookAdapter implements IntegrationAdapter` — `poll` is a no-op (push from our
    side), `verifyWebhook` returns false (Phase 2 uses delta-query polling only)

### Core (`packages/core`)
- `outlook-oauth.service.ts`:
  - `OAuthService.startHandshake` — issues a 64-byte PKCE verifier, stores only the
    SHA-256 hash in `oauth_states`, returns the Microsoft authorize URL
  - `OAuthService.completeHandshake` — exchanges `code` + verifier for tokens,
    encrypts the access + refresh blobs, persists the connection row
  - `OAuthService.getAccessToken` — transparently refreshes when the access token
    is within a minute of expiry
  - `OAuthService.disconnect` — clears tokens + cursors, marks the connection
    `disconnected`, audits the action
  - `OAuthService.isConnected` for the dashboard tile
  - Hard human-only guard on start + complete — agents with the right scope still
    fail before the actual handshake starts, matching the same human gate that
    guards task approval
- `outlook-sync.service.ts`:
  - `OutlookSyncService.syncOnce` — walks `@odata.nextLink`s until it gets a
    `@odata.deltaLink`, persists the cursor, ingests each message through the
    existing `IngestionService.ingest` pipe
  - Junk emails (`parentFolderId` contains "junk") dropped before write
  - Idempotent via `(provider:externalId)` dedupe key
  - `OutlookSyncService.resetCursor` — owner-only
  - `OutlookSyncService.getCursor` — read-only progress

### Domain-side crypto generalization
- `settings-crypto.ts`:
  - `encryptSecret` / `decryptSecret` now take a `SecretContext` (defaults to
    `aiProvider`). New contexts (`oauthAccess`, `oauthRefresh`) derive independent
    AES keys from `SESSION_SECRET`, so a leak of one ciphertext type does not
    expose the other.

### Web (`apps/web`)
- `apps/web/src/lib/runtime.ts`:
  - `outlookProviderFromEnv(env)` builds the OAuth provider config from the four
    `FLOWPILOT_OUTLOOK_*` env vars; the runtime only constructs the OAuth service if
    they're all present
  - `isOutlookConfigured()` — quick check for the dashboard
- API routes:
  - `GET /api/integrations/outlook-graph/oauth/start` — set the PKCE verifier cookie
    and return `authorizeUrl` for the dashboard button
  - `GET /api/integrations/outlook-graph/oauth/callback` — read the verifier, finish
    the handshake, redirect to `/settings/integrations?outlook=connected` (or
    `?outlook=error&reason=...` on failure)
  - `POST /api/integrations/outlook-graph/sync` — one round of delta sync
  - `GET /api/integrations/outlook-graph/sync` — read cursor + connection state
    without running a sync
  - `POST /api/integrations/outlook-graph/disconnect` — drop tokens + cursor
- Dashboard:
  - `/settings/integrations` shows an Outlook tile linking to the configuration page
  - `/settings/integrations/outlook-graph` shows status, account label, scopes, a
    sign-in button (PKCE flow), a Sync button, a Reset cursor + sync button, and a
    clear copy explaining the mock-vs-live channel driver split

### Tests (Phase 2)
- `packages/integrations/test/outlook.test.ts` — 15 tests:
  - Normalize text body / fallback to `bodyPreview` / strip HTML / junk detection /
    null-id + null-sender guard
  - Adapter shape (`verifyWebhook` rejects, `normalize` pass-through)
  - Mock channel: success + scripted failure
  - Real channel: 202 Accepted → success with generated id, 4xx → non-retryable,
    5xx → retryable
- `packages/core/test/outlook-oauth.test.ts` — 11 tests:
  - PKCE state row stores SHA-256 hash, not raw verifier
  - Agent credentials rejected at `startHandshake` (human-first guard)
  - Full Microsoft token exchange round trip with global fetch stubbing
  - PKCE mismatch rejected
  - Cached access token returned without a refresh round trip when not expired
  - Transparent refresh path when within the 60s skew window
  - `disconnect` clears tokens, cursors, and integration row
  - Cross-org state rejection, missing-state rejection, consumed-state rejection
- `packages/core/test/outlook-sync.test.ts` — 5 tests:
  - Single-page sync: ingests 1, drops junk, stores deltaLink, sets `cursorStored=true`
  - Paginates through `@odata.nextLink` until `@odata.deltaLink` arrives
  - `resetCursor` requires a human (admin allowed, system rejected)
  - 401 from Graph surfaces a clear `ValidationError`

Phase 2 test totals: 31 new tests across 3 files. Cumulative: 155/155 tests passing.

## How to run it offline / without Entra credentials

The new tests pass entirely offline. The integration page refuses to render
synced paths until `FLOWPILOT_OUTLOOK_CLIENT_ID` etc. are set; in local dev you
can leave them unset and the catalog still surfaces the Outlook tile but the
configuration page explains the env vars you need.

For a fully live setup:

1. Register an app in **Microsoft Entra (Azure AD)**. Use these platform settings:
   - Account types: *Single tenant* (or *Multitenant*).
   - Redirect URI: `https://<host>/api/integrations/outlook-graph/oauth/callback`.
   - API permissions → Microsoft Graph → delegated:
     `Mail.Read`, `Mail.ReadWrite`, `Mail.Send`, `offline_access`,
     `openid`, `profile`, `email`.
   - Generate a client secret.
2. Set the env (in `.env.local`):
   ```
   FLOWPILOT_OUTLOOK_CLIENT_ID=<app id>
   FLOWPILOT_OUTLOOK_CLIENT_SECRET=<secret>
   FLOWPILOT_OUTLOOK_TENANT_ID=common
   FLOWPILOT_OUTLOOK_REDIRECT_URI=https://<host>/api/integrations/outlook-graph/oauth/callback
   ```
3. Restart `pnpm dev` and visit `/settings/integrations/outlook-graph`.
4. Click **Sign in with Microsoft**. After consent, the callback sets
   `integration_connections.status = 'connected'`.
5. Click **Sync inbox** — one delta-query round ingests new mail. The cursor
   persists so the next sync only re-fetches what changed.

If your test tenant blocks `Mail.Send`, you'll see a Graph `403` flow back through
the channel driver and the Outbox row flips to `failed` with the error code
visible in the per-action timeline — exactly the same audit shape the WhatsApp
demo already exercises.

## What is required to talk to the real Microsoft Graph API

The code is wired and tested. What's still operational:

1. **Microsoft Entra app registration.** Until that exists,
   `live verification: blocked`. The app cannot ship a "Connect" button in
   production until this is resolved.
2. **A public HTTPS callback URL.** For local development, ngrok or Cloudflare
   Tunnel provides one. The exact callback is logged in the configuration page.
3. **Outbound `Mail.Send` privilege.** A common gotcha is admin consent — without
   it, the IdP redirects back with the canonical `AADSTS65001` and the catalog
   stays in `not_configured`.
4. **Token refresh.** The OAuth service transparently refreshes when the access
   token is within a minute of expiry. If the refresh token itself expires
   (default Entra policy: 90 days idle for `offline_access`), `getAccessToken`
   throws `IntegrationError` and the dashboard surfaces a clear "reconnect"
   banner.

## File map (Phase 2 only)

```
packages/
  domain/src/
    integration-contracts.ts        OutlookSyncCursor, OutlookMessageEvent, OAuth schemas
  database/
    migrations/0007_outlook_oauth.sql
    repos/oauth.ts                  OAuthStateRepo, OAuthTokenRepo, SyncCursorRepo
  integrations/src/
    outlook-channel.ts              OutlookGraphChannel + MockOutlookGraphChannel
    outlook-normalizer.ts           Graph envelope → event
    outlook-adapter.ts              OutlookAdapter (IntegrationAdapter)
  core/src/
    ai/settings-crypto.ts           SecretContext enum (multi-key derivation)
    outlook-oauth.service.ts        OAuthService: PKCE start, complete, refresh, disconnect
    outlook-sync.service.ts         OutlookSyncService: delta + ingestion

apps/web/src/
  lib/runtime.ts                    outlookProviderFromEnv, isOutlookConfigured
  app/api/integrations/outlook-graph/
    oauth/start/route.ts            GET → sets verifier cookie, returns authorizeUrl
    oauth/callback/route.ts         GET → exchanges code, redirects to dashboard
    sync/route.ts                   POST/GET → one delta round + cursor peek
    disconnect/route.ts             POST → drops tokens + cursor

apps/web/src/app/(app)/settings/integrations/
    page.tsx                        Adds Outlook tile + Connect link
    outlook-graph/
      page.tsx                      Server component
      outlook-client.tsx            Connect, Sync, Reset + Status card
```

## Known limits / non-goals (Phase 2)

- **Microsoft Graph change notifications** (webhook-style push) are out of scope
  for Phase 2. `OutlookAdapter.verifyWebhook` deliberately returns `false` so a
  misconfigured subscription shows up loudly instead of silently.
- **Per-folder sync (Sent, Junk, custom folders)** is wired but the demo only
  ingests `inbox`. Phase 4 will add a folder-picker to the dashboard.
- **Draft + send via Graph** uses `sendMail` rather than the more permissive
  `createMessage` flow; if you need to *edit* drafts in Outlook, swap that in.
- **HTML body parsing** strips tags but does not pull out attachment lists. Phase
  4 attaches file links alongside the draft.

## Roll-forward plan

Phase 3 (unified workflow + lead model + generic webhook) and Phase 4 (n8n
example + scheduler + change-notification inbox subscription) build on top of
the same `OAuthService` + `SyncCursorRepo` + `ChannelDriver` machinery that
Phase 2 introduces. Outlook will reuse them by swapping `provider: 'outlook-graph'`
for `'generic-webhook'` or any future IdP.
