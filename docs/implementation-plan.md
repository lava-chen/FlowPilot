# FlowPilot — Implementation Plan (v0.1 + customer-fit follow-up)

Status legend: `[x]` done and verified · `[~]` partial · `[ ]` not started.

## Step 1 — Architecture

- [x] Inspect the working directory (`E:\Projects\FlowPilot` was empty; no prior prototype to
      port). The Duya project is untouched.
- [x] Decide the dependency graph: `shared → domain → database → core → apps`.
- [x] Decide the DB story: plain Postgres via `pg`, migrations as portable SQL, **PGlite** for
      tests so `pnpm test` needs no server. Supabase compatibility preserved via SQL +
      `0002_rls.sql`.
- [x] Decide the auth story: local JWT issuer with the same claims Supabase Auth issues, behind
      a `SessionResolver` interface.
- [x] Write `docs/architecture.md`, `docs/product-spec.md`, this file.

## Step 2 — Foundation

- [x] pnpm workspace: `apps/web`, `apps/mcp-server`, `packages/{shared,domain,database,core,integrations}`.
- [x] Strict TypeScript, path aliases `@flowpilot/*`, root `tsconfig.base.json`.
- [x] `packages/shared`: id generation, typed errors, redacting logger, env schema validation.
- [x] `packages/domain`: entity types, zod contracts, the task state machine + tests.
- [x] `packages/database`: `0001_init.sql`, migration runner, repositories, `seed.ts`,
      `db:reset` script.
- [x] Auth: local session issuer, cookie handling, agent bearer authenticator, permission matrix.

## Step 3 — Business workflow

- [x] `IngestionService` (idempotent, dedupes `provider + externalId`).
- [x] `AiProvider` interface + `DeterministicAiProvider` (client/project/priority/due date/
      assignee extraction with confidence + evidence).
- [x] `AnalysisService`, `DraftService`, `ApprovalService`, `TaskService.transition`,
      `AssignmentService`.
- [x] `WorkflowRunService` recording every step; `AuditService` recording every action.
- [x] Core integration tests over PGlite proving rows + audit trail.

## Step 4 — Web UI

- [x] API routes: auth, overview, requests, tasks, activity, mock-email trigger, `/mcp` bridge.
- [x] Four pages: Overview, AI Inbox, Tasks (Kanban), Activity.
- [x] Light theme with a dark sidebar, empty/loading/error states, responsive down to 375px.
- [x] Every mutation is a server round-trip; no optimistic-only state.

## Step 5 — MCP

- [x] `apps/mcp-server`: Streamable HTTP transport, stateless sessions, bearer auth.
- [x] 8 tools over core services, zod-validated, error-mapped to JSON-RPC.
- [x] Verified with the real SDK client over HTTP (`apps/mcp-server/test/remote.test.ts`).

## Step 6 — Verification

- [x] `pnpm typecheck` clean.
- [x] `pnpm test` green (state machine, repositories/isolation, core pipeline, API, MCP).
- [x] Workspace typecheck and production Next build. The standalone MCP server runs from
      TypeScript through `tsx`; it has no separate compiled build target in v0.1.
- [x] Manual browser check of all four pages against the local PGlite-backed web process.

## Phase 1 — WhatsApp Business (2026-10-18)

- [x] Domain contracts — `OutboundAction`, `OutboundActionStatus`, `OutboundActionChannel`,
      `outbound-action-state.ts` pure state machine, `integration-contracts.ts` (WhatsApp
      envelope + reply generation), `outbounds:read|write|decide` agent scopes.
- [x] Migration `0005_whatsapp_outbound.sql`: `outbound_actions`, `outbound_action_events`,
      `products`, `faqs`, `business_hours`, `leads` (+ RLS policies when enabled).
- [x] Repos: `OutboundActionRepo` (with `listEvents` for the activity drawer), `LeadRepo`,
      `ProductRepo`, `FaqRepo`, `BusinessHoursRepo`.
- [x] `IntegrationService` — catalog projection (`demo | mock | not_configured | connected
      | error | reauth_required`) plus connection CRUD with secret redaction.
- [x] `OutboundActionService` — full lifecycle, dedupe-key idempotency, human-only approval
      gate, channel-driver dispatch, append-only event log.
- [x] WhatsApp adapter: `verifyWhatsAppSignature` (HMAC-SHA256, timing-safe), handshake
      verifier, payload normalizer, `MockWhatsAppChannel` + `WhatsAppCloudChannel`
      (5xx/429 = retryable; 4xx = permanent), `handleWhatsAppEvents` reusing
      `ingestAndDraft`.
- [x] Web routes: `GET/POST /api/webhooks/whatsapp/[orgSlug]`, `GET/PUT/DELETE
      /api/integrations/[provider]`, full `outbound-actions` CRUD, `POST
      /api/integrations/whatsapp/simulate`, `POST /api/whatsapp/generate-reply`.
- [x] Dashboard: catalog list at `/settings/integrations`, full WhatsApp config +
      simulator at `/settings/integrations/whatsapp`, Outbox at `/outbox` with per-action
      timeline.
- [x] Retail Bakery demo seed (`FLOWPILOT_SEED_BAKERY=true`) with product catalog,
      FAQs, weekly hours.
- [x] Tests: 38 new (signature/replay/handshake/normalizer/Mock/Cloud channels,
      OutboundActionService lifecycle/dedupe/agent-blocking/cross-org, deterministic
      Bakery reply generator grounding + FAQ fallback).
- [x] `pnpm typecheck`, `pnpm test` (122/122), `pnpm build` all green.
- [ ] Live Meta verification: **Blocked** — requires Meta developer account, public webhook
      URL, and App Secret / Verify Token / Access Token / Phone Number ID. See
      `docs/phase-1-whatsapp.md` for the exact operational steps.

## Customer-fit follow-up (2026-10-16)

- [x] `0003_collaboration.sql`: effort estimates, tenant-scoped checklist/comments/links/time,
      task dependencies, and expiring client-review records; optional RLS policies are extended.
- [x] Core task gates: dependency cycles rejected; blocked work cannot start; incomplete checklists
      cannot enter review; an outstanding or changes-requested client review blocks completion.
- [x] Dashboard coordination panel and public client-review page; internal approval stays separate
      from client sign-off. Client review response and operational actions are audited.
- [x] Overview and MCP `get_team_capacity`: estimated hours due this week vs. each member's weekly
      capacity, with unscheduled estimated hours called out separately.
- [x] Optional OpenAI Chat Completions-compatible analyzer with timeout, structured JSON parsing,
      organization candidate grounding and exact evidence quote checks. Deterministic analysis stays
      the default.
- [x] Organization AI settings page and API: owners/admins configure compatible base URL, model,
      and encrypted key; web and MCP resolve the setting per organization, with a synthetic-only
      connection test and no key readback.
- [x] Development-only local key import: safely lists allow-listed provider names from either
      dotted or nested `~/.duya/secrets.json` structures and writes a chosen key directly to the
      encrypted server-side setting without sending it through the browser.
- [x] PGlite core smoke exercised dependency/cycle guards, coordination persistence, client changes
      and approval, role/tenant isolation, capacity math, and LLM candidate grounding.
- [x] PGlite AI-settings smoke exercised admin-only access, encrypted-at-rest key persistence,
      key-preserving edits, deterministic reset, endpoint validation and organization isolation.

## Known gaps / honest limits

- The local demo still defaults to deterministic analysis until an owner/admin saves an organization
  provider or a server-wide environment fallback is configured. The live credentials in the local
  user secret store have not been selected for an endpoint/model test yet.
- Gmail/Slack/ClickUp/Hubstaff/Drive/Figma connections are still not implemented. Email intake is
  mock-only; external OAuth, webhook signature verification, provider replay and file upload are
  required before claiming connected operations automation.
- Checklists are task-specific; reusable workflow templates, scheduled reminders, reporting/export,
  and background notification delivery are not implemented. Actual time is manually entered.
- Client review is a shareable portal URL, not an email integration. Demo delivery URLs use
  `example.com` placeholders. Replace them before sharing a review link.
- Auth is the local issuer; Supabase Auth verification is implemented as an alternative
  resolver but was not exercised against a live Supabase project (no credentials available).
- `0002_rls.sql` is not applied in the default migration path because the local dev role owns
  the tables (owner bypasses RLS). It is applied automatically when `FLOWPILOT_ENABLE_RLS=true`
  and documented in the README.
- MCP sessions are stateless; no SSE resumption stream, no notifications/subscriptions.
- No background queue: workflow steps run inline in the request that triggered them.
- The local `pglite://` mode is not a shared live database across the web and standalone MCP
  processes. Use the web app's `/mcp` route for a single-process local demo, or PostgreSQL when
  both services need to see each other's writes.

## Next three

1. **Real inbound connectors** — Gmail + Slack OAuth/webhooks, signature verification, event
   dedupe across providers and replayable failures; use configured secrets in the deployment.
2. **ClickUp + file handoff** — one-way pilot sync first, reconcile external IDs and conflicts,
   then add actual Drive/Figma delivery permissions and file-version metadata.
3. **Agency operations polish** — reusable checklist templates, due-date reminders, weekly time
   reports and a project deadline-risk view; validate these against real PM teams before claiming
   customer fit beyond the current task-to-signoff slice.
