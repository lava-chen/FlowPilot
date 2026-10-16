# FlowPilot

**Agent-native workflow automation for creative agencies.** FlowPilot connects the SaaS a
service business already uses (email, chat, files) into one workflow engine where **AI agents
propose work and humans keep the decision rights**.

Two equal entry points share one business core, one permission system and one database:

- **Web Dashboard** — Overview, AI Inbox, Tasks (Kanban), Activity, AI settings, and an owner/admin Integrations catalog. The catalog clearly separates demo intake from external connectors that still need OAuth setup.
- **Remote MCP Server** — lets Claude / Codex / Duya style agents query projects, analyze
  inbound requests and prepare task drafts for human approval.

Demo tenant: **Northline Creative**, a fictional 8-person US creative marketing agency
(see `docs/product-spec.md`).

---

## Quick start

Prerequisites: **Node.js >= 20**, **pnpm 9+** (`corepack enable`), and
**PostgreSQL 14+** (a local instance, a Docker container, or a Supabase project).

```bash
# 0. install pnpm if needed
corepack enable && corepack prepare pnpm@9.15.0 --activate

# 1. install dependencies
pnpm install

# 2. configure environment
cp .env.example .env.local      # then edit DATABASE_URL / SESSION_SECRET / MCP token

# 3. create the schema + demo data (idempotent)
pnpm db:migrate
pnpm db:seed

# 4. run the dashboard (it also exposes /mcp)
pnpm dev
```

`pnpm dev` starts the dashboard:

| App | URL | Notes |
| --- | --- | --- |
| Web Dashboard | http://localhost:3000 | Next.js, serves the internal API and Streamable HTTP MCP endpoint |

The MCP endpoint is mounted in the web app at `http://localhost:3000/mcp` (see
`docs/architecture.md`). To run the standalone MCP server beside the dashboard, configure a
shared PostgreSQL database first and use `pnpm dev:stack`; both processes must see the same live
database. Do not run both against the same local PGlite data directory.

When `DATABASE_URL` uses `pglite://`, each Node process opens its own PGlite instance. For a
local demo that runs the dashboard and standalone MCP server together, use PostgreSQL so both
processes share live data. With PGlite, call the web app's `/mcp` endpoint to keep MCP changes in
the dashboard's process and data view.

Sign in with any seeded demo account (password `demo1234`):

| Email | Role | Can |
| --- | --- | --- |
| `dana@northlinecreative.com` | Owner | everything |
| `marcus@northlinecreative.com` | PM (manager) | approve/reject drafts, run workflows |
| `priya@northlinecreative.com` | Producer (manager) | manage work, approve/reject drafts |
| `theo@northlinecreative.com` | Editor (member) | update assigned tasks, contribute comments/checklists/time |

### Try the end-to-end loop

1. Open **AI Inbox → “Simulate inbound email”** and send one of the canned customer emails.
   A `WorkflowRun` starts, the configured analyzer produces a structured extraction, and a task
   draft appears in the inbox. Owners/admins can choose offline rules or configure a model in
   **AI settings** first. In local development, available provider names from `~/.duya/secrets.json`
   can be selected for server-side key import; enter the provider's compatible base URL and model.
   Production only accepts keys through the settings form.
2. Open the draft, edit the title/priority/assignee, then **Approve**. The task moves
   `pending_approval → ready` and is assigned.
3. Open **Tasks** and inspect estimates, prerequisites and the delivery checklist. A task cannot
   start before its prerequisites finish, or move to review while its checklist is incomplete.
4. Add the actual delivery URL, log time and move the task through
   `ready → in_progress → in_review`.
5. Create a client-review link and open it in a private window. The client can approve or request
   changes; if they request changes, the task returns to work and a new review round can be sent.
   The final task completion remains a separate team action after client approval.
6. Open **Overview** to compare estimated hours due this week with member capacity, then **Activity**
   to inspect the audit trail. Refresh to confirm persisted state.

The seeded Cedar review task includes illustrative coordination records. Its `example.com` links
are placeholders; replace them with real delivery URLs before using the client-review link outside
the local demo.

### Try the agent loop

Any MCP client that speaks Streamable HTTP:

```jsonc
{
  "mcpServers": {
    "flowpilot": {
      "type": "http",
      "url": "http://localhost:3001/mcp",
      "headers": { "Authorization": "Bearer fp_live_<token>" }
    }
  }
}
```

Then, in the agent:

> Find the pending requests for Northline Creative, analyze them and prepare task drafts
> for my review.

The agent calls `list_requests` → `analyze_request` → `create_task_draft`, and the drafts show
up in your Dashboard immediately. Approval still requires a human.

The MCP surface also exposes `get_task` coordination detail and `get_team_capacity`. Optional
estimated hours can be included when creating an explicit task draft.

Create a fresh agent token:

```bash
pnpm --filter @flowpilot/mcp-server agent:token --name "Demo agent" --scopes requests:read,tasks:read,tasks:write,requests:write
```

---

## Scripts

| Command | What it does |
| --- | --- |
| `pnpm dev` | run the Next.js dashboard in watch mode (includes `/mcp`) |
| `pnpm dev:stack` | run web + standalone MCP in watch mode; requires shared PostgreSQL |
| `pnpm dev:web` | run only the Next.js dashboard in watch mode |
| `pnpm dev:mcp` | run only the standalone MCP server in watch mode |
| `pnpm build` | typecheck the workspace and build the production Next.js app |
| `pnpm start` | run the built Next.js dashboard (includes `/mcp`) |
| `pnpm start:stack` | run the dashboard + standalone MCP server; requires shared PostgreSQL |
| `pnpm typecheck` | `tsc --noEmit -p tsconfig.json` for application and package sources |
| `pnpm test` | Vitest: state machine, repositories, API + MCP integration |
| `pnpm test:watch` | run Vitest in watch mode |
| `pnpm db:migrate` | apply `packages/database/migrations/*.sql` in order |
| `pnpm db:seed` | insert the Northline demo tenant (idempotent) |
| `pnpm db:reset` | drop + recreate + migrate + seed (destructive) |

Tests run against **PGlite** (real Postgres compiled to WASM) in an isolated schema, so
`pnpm test` needs no database server. The application itself talks plain Postgres over `pg`,
which is what Supabase gives you.

---

## Repository layout

```text
flowpilot/
  apps/
    web/            Next.js dashboard + internal API routes + /mcp bridge
    mcp-server/     standalone Streamable HTTP MCP server
  packages/
    shared/         ids, errors, logging, env parsing
    domain/         zod contracts + task state machine (pure, no I/O)
    database/       SQL migrations, migration runner, repositories, seed
    core/           business services, AI provider interface, permissions, audit
    integrations/   integration adapter interface + mock email adapter
  docs/
    architecture.md
    product-spec.md
    implementation-plan.md
```

**Layering rule:** `shared → domain → database → core → apps`. `core` owns every business
rule; the dashboard and the MCP server are only clients of it. Neither app may touch a
repository or write a task status directly — see `docs/architecture.md`.

---

## Configuration and product limits

Being explicit about this, because it matters for the demo:

- **AI analysis** defaults to a deterministic rule-based analyzer. Organization owners/admins can
  configure an OpenAI Chat Completions-compatible endpoint in **AI settings**: base URL, model,
  and API key. The key is encrypted at rest using a key derived from `SESSION_SECRET`, never sent
  back to the browser, and can be replaced or cleared by switching back to offline rules. The
  connection test sends a synthetic request only. Alternatively, set `FLOWPILOT_AI_PROVIDER`,
  `FLOWPILOT_AI_BASE_URL`, `FLOWPILOT_AI_API_KEY`, and `FLOWPILOT_AI_MODEL` as the server-wide
  fallback. Real inbox analysis sends the request text and organization candidate names to the
  configured provider; responses are schema-checked and candidate IDs/evidence are validated.
- **Email** is still a mock adapter triggered from the UI. Gmail/Slack OAuth and webhook ingestion,
  ClickUp/Hubstaff synchronization, Google Drive/Figma uploads, background notifications and
  scheduled reports are not connected.
- **Coordination** includes estimates, dependencies, checklists, comments, HTTP(S) links, time
  entries, and expiring client-review links. Links point to external files; FlowPilot does not
  upload or version files. Client reviews require a manager to copy/send the URL manually.
- **Auth** runs on a local session issuer that mints the same JWT claims Supabase Auth issues,
  so switching to Supabase Auth is a provider swap. See `docs/architecture.md § Auth`.
- **Postgres** is plain Postgres. `supabase/migrations/` + `0002_rls.sql` carry row-level
  security policies for when you run it under Supabase.

These task operations, lifecycle gates, client decisions, capacity calculations and audit events
write through the shared Core and tenant-scoped repositories. Estimates are planning data; time
entries are manually logged actuals.

---

## Documentation

- `docs/architecture.md` — layers, request flow, auth, permissions, MCP transport.
- `docs/product-spec.md` — entities, states, roles, demo data.
- `docs/implementation-plan.md` — phases, status, known gaps.
