# FlowPilot — Technical Architecture (v0.1)

## 1. Why this shape

FlowPilot's promise is that an **agent** and a **human** can touch the same workflow without
either one being able to break the rules. That single requirement drives every decision:

- All business rules live in `packages/core`, reachable only through service methods.
- Both entry points (Next.js API routes, MCP tools) are thin adapters over the same services.
- Identity is resolved server-side. An agent can claim *who it is* only via a revocable
  credential bound to an organization.

## 2. Layers

```text
            ┌────────────────────────┐        ┌────────────────────────┐
 HTTP       │ apps/web (Next.js)     │        │ apps/mcp-server        │  MCP
 clients →  │  route handlers + UI   │        │  Streamable HTTP       │  clients
            └───────────┬────────────┘        └───────────┬────────────┘
                        │  SessionResolver / AgentAuthenticator
                        ▼                                  ▼
                     packages/core  ← the only place business rules are enforced
                        │
                        ▼
                   packages/domain   pure contracts + task state machine
                        │
                        ▼
                   packages/database repositories (Postgres, org-scoped)
                        │
        packages/integrations  (mock email, future Gmail/Slack/…)
```

`shared` is dependency-free utilities used by everything.

**Enforced rule:** only `packages/core` may import `packages/database`. The dashboard and the
MCP server never see SQL, never construct a repository, and never write a task status.

### Why not Next.js API routes only?

Both exist on purpose. `apps/mcp-server` runs as a standalone Node process so an external
agent can reach it without the dashboard being up, and so it can scale independently. It
imports the *same* `@flowpilot/core` build — verified in `packages/core` integration tests by
constructing the services twice and asserting identical behavior.

`apps/web` additionally exposes `/mcp` by delegating to the same server module, for
single-process deployments.

## 3. Request → task pipeline

```text
mock email (or manual submission)
   │  integrations/mock-email
   ▼
IngestionService.ingestEmail()            idempotency: (org, provider, externalId)
   │  dedupe → requests row (status=new)
   ▼
AnalysisService.analyze(requestId)        AiProvider.analyze() → RequestAnalysis (zod)
   │  requests.analysis = {...}, status=analyzed
   ▼
DraftService.createDraft(requestId)       analysis → tasks row (status=draft)
   │  requests.status=drafted, workflow_run step recorded
   ▼
Human opens AI Inbox → edits → Approve
   │  ApprovalService.decide()  (requires 'approvals:decide' scope + membership role)
   │  task: pending_approval → ready, assignee set
   ▼
Employee transitions the task              TaskService.transition()
   │  state machine validated in domain layer, every hop audited
   ▼
completed  |  rejected  |  cancelled
```

Each arrow is a `WorkflowRun` step, persisted in `workflow_runs.steps` as JSONB, so the
Activity page can render the exact history of a run.

Organization owners/admins configure an optional OpenAI-compatible analyzer in the Dashboard.
Core resolves that setting from the current actor's organization for both web and MCP analysis.
The API key is AES-256-GCM encrypted before it reaches the database, using a domain-separated
key derived from `SESSION_SECRET`; settings responses expose only whether a key is present. The
connection probe sends synthetic data only. Inbox analysis sends the request text and organization
candidate names to the configured provider.

## 4. The task state machine

Defined once, in `packages/domain/src/task-state.ts`:

```text
draft ──────────► pending_approval ──approve──► ready ──start──► in_progress ──submit──► in_review ──accept──► completed
  │                     │  │                                                    │  │
  │                     │  └──reject──► rejected ◄──request changes──┘             │  └──request changes──┘
  │                     └──revise───► draft                                      │
  └──────────── cancel ─────────────────────────────────────────────────────────┴──► cancelled
```

Transitions are a pure function `canTransition(from, to)` plus a table of guards. Core is the
only caller. `PATCH /api/tasks/:id` cannot set an arbitrary status — it can only *request a
transition*, which the state machine accepts or rejects with `InvalidTransitionError`.

## 5. Authentication and identity

Two resolvers implement the same interface (`SessionResolver`), both returning an `Actor`:

```ts
type Actor =
  | { kind: 'user';  userId; orgId; role: MembershipRole; email; displayName }
  | { kind: 'agent';  credentialId; orgId; scopes: Scope[]; label }
  | { kind: 'system'; orgId; label }
```

- **User actors** come from a signed JWT in an httpOnly cookie (`jose`, HS256). In Supabase
  mode, the same resolver validates a Supabase-issued JWT instead — claims are identical
  (`sub`, `app_metadata.org_id`), so nothing downstream changes.
- **Agent actors** come from `Authorization: Bearer fp_live_…`. Only the SHA-256 hash is
  stored; the plaintext is shown once at creation. The token → org binding is resolved from
  the database, **never** from agent-supplied parameters.
- **Credentials never reach the frontend** and never appear in logs: the logger redacts
  `authorization`, `token`, `secret` keys, and the MCP layer logs actor/credential *ids*.

## 6. Permissions

| Capability | owner | admin | manager | member | agent scope |
| --- | :-: | :-: | :-: | :-: | --- |
| read projects/tasks/requests | ✅ | ✅ | ✅ | ✅ | `projects:read` / `tasks:read` / `requests:read` |
| run ingestion / analyze | ✅ | ✅ | ✅ | ❌ | `requests:write` |
| create task draft | ✅ | ✅ | ✅ | ❌ | `tasks:write` |
| edit a draft | ✅ | ✅ | ✅ | ❌ | `tasks:write` |
| **approve / reject** | ✅ | ✅ | ✅ | ❌ | *never granted* |
| transition an assigned task | ✅ | ✅ | ✅ | ✅ (own) | `tasks:write` |
| manage integrations / credentials | ✅ | ✅ | ❌ | ❌ | *never granted* |

`permissions.ts` holds one matrix consumed by both apps. Approval is the one action an agent
can never take, which is what keeps the "AI proposes, human decides" promise honest —
`request_task_approval` only moves `draft → pending_approval` and flags
`requiresHumanConfirmation: true`.

## 7. Organization isolation

Three layers, deliberately redundant:

1. **Repository** — every method takes `orgId` and filters on it. No query can be issued
   without an org, enforced by the `OrgScopedRepository` base class.
2. **Request context** — the web app resolves an actor per request and passes its `orgId`; no
   route handler accepts an `orgId` from the client (that parameter is not in the API
   surface at all).
3. **Postgres RLS** — `migrations/0002_rls.sql` adds `org_id`-based policies plus
   `app.current_org` helpers. Active under Supabase, where the app role is not the table
   owner. Documented as opt-in because it requires a non-superuser role.

Integration tests assert cross-organization reads return empty and cross-organization writes
throw `OrganizationMismatchError`.

## 8. MCP transport

- SDK: `@modelcontextprotocol/sdk`, `StreamableHTTPServerTransport`, session-less
  (stateless) mode for horizontal scale, `JSON` response mode.
- Endpoint: `POST /mcp`. Tool listing and invocation are separated (`GET` returns 405 with the
  JSON-RPC error), which is the SDK's stateless recommendation.
- Auth: bearer token → agent actor. Unauthorized → JSON-RPC error `-32001`, never an HTTP 500
  with a stack trace.
- Each tool is a thin wrapper: validate input with zod → call a core service → return a
  projection of the entity (never raw rows, never another org's data).
- Verified in tests with the SDK's real `Client` over `StreamableHTTPClientTransport`
  (`apps/mcp-server/test/remote.test.ts`), so the wire protocol is exercised, not mocked.

## 9. Testing strategy

| Layer | Tool | What it proves |
| --- | --- | --- |
| Domain | Vitest | state machine accepts/rejects the full transition matrix |
| Database | Vitest + PGlite | repositories work against real Postgres SQL, org isolation holds |
| Core | Vitest + PGlite | the pipeline produces the right rows and audit trail |
| API | Vitest + PGlite + route handlers | HTTP in → DB → HTTP out, including 401/403/409 |
| MCP | Vitest + real MCP SDK client | tool discovery and invocation over Streamable HTTP |
| UI | manual browser check | the four pages render and persist |

PGlite runs the *same* migration files as production, so a schema change that breaks the app
breaks the tests.

## 10. Deliberate non-goals for v0.1

Billing, plan tiers, a visual workflow editor, real OAuth/webhook connections, a background job
queue, and production monitoring are out of scope — but each has a named extension point
(`IntegrationAdapter`, `WorkflowStepRunner`, `AiProvider`, `AuditSink`).

## 11. Outbound action subsystem (v0.2)

Sends to external channels (WhatsApp, email, webhook) are not internal `Task` objects — they
are a separate entity, `OutboundAction`, with their own state machine. The split is
load-bearing: a customer-visible message must clear an approval gate, carry its own
provider-issued message id, and survive webhook redelivery without duplicating. Squeezing
those concerns into `tasks` would force the existing task transitions to grow a second
"draft an external send" subgraph.

```text
draft ──────► pending_approval ──approve(human)─► approved ──send(system)──► sending ─► sent
  │                  │  │                                                                       │
  │                  │  └──reject(human)──► rejected ◄──────────────────────────► failed ◄───┘
  │                  └──revise(human)──► draft
  └───── cancel (omitted for brevity) ─────────────────────────────────────────────────────────────►
```

Guards:

- `draft → pending_approval` is `system-or-human`: an agent or a webhook may submit a draft, but
  may not move past `approved`.
- `pending_approval → approved | rejected | draft` is human-only. `permissions.ts` carries an
  `outbounds:decide` capability that no agent scope unlocks — identical pattern to
  `approvals:decide`.
- `approved → sending` and `sending → sent | failed` are system-only; the dispatcher is the
  `ChannelDriver` interface, which has both `MockWhatsAppChannel` (offline / tests) and
  `WhatsAppCloudChannel` (real Meta Cloud API).

Idempotency is enforced by `unique (org_id, channel, dedupe_key)` on `outbound_actions`; the
unique key is what makes a webhook redelivery safe. The webhook signature verifier
(`verifyWhatsAppSignature`) is HMAC-SHA256 over the raw request body and uses
`timingSafeEqual` — see `packages/integrations/src/signature.ts`.

See `docs/phase-1-whatsapp.md` for the Phase 1 implementation report.
