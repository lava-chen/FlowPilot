# FlowPilot — Product Specification (v0.1)

## 1. Positioning

FlowPilot is an **agent-native workflow automation platform** for small creative marketing
agencies, content production teams and other service businesses whose client work arrives as
scattered requests (email, chat, documents) and whose project managers spend their day
manually turning those requests into tasks.

It is not another SaaS to migrate into. It sits on top of the SaaS the team already uses and
turns inbound noise into reviewable, assignable, auditable work.

**Northline Creative** is the demo tenant: a fictional 8-person US creative marketing agency
managing short-form video production for several consumer brands.

## 2. Personas and roles

| Role | Persona | Goal |
| --- | --- | --- |
| Owner / Admin | Dana Reyes, co-founder | visibility, credentials, client roster |
| Manager (PM) | Marcus Webb, account lead | clear the inbox, approve drafts, protect deadlines |
| Member (Producer) | Priya Natarajan | keep the board honest, unblock crew |
| Member (Editor/Creator) | Theo Brandt, Jordan Ellis | execute and submit work |
| Agent | Claude / Codex / Duya | prepare work so the PM only decides |

## 3. Entities

- **Organization** — tenant boundary; every row carries `org_id`.
- **User / Membership** — a user may belong to several orgs with a different role in each.
- **Client** — brand the agency serves (e.g. *Harbor Coffee Co.*).
- **Project** — an engagement with a client, has a code, status and due date.
- **Request** — raw inbound ask, normalized from an integration. Holds the original payload
  and the AI analysis.
- **Task** — the unit of work. Belongs to a project, optionally derived from a request.
- **WorkflowRun** — one execution of the pipeline, with per-step status.
- **Approval** — a human decision on a draft (approve/reject + note).
- **IntegrationConnection** — provider connection record (mock in v0.1).
- **AgentCredential** — revocable bearer token bound to an org with explicit scopes.
- **AuditEvent** — append-only log of every state-changing action.

## 4. Task lifecycle

```text
draft → pending_approval → ready → in_progress → in_review → completed
          ↓        ↓                                    ↓
       rejected   (revise→draft)                 (request changes→in_progress)
          ↓ (revise→draft)
      cancelled   (from draft / pending_approval / ready / in_progress)
```

| From | Allowed to |
| --- | --- |
| `draft` | `pending_approval`, `cancelled` |
| `pending_approval` | `ready`, `rejected`, `draft`, `cancelled` |
| `rejected` | `draft`, `cancelled` |
| `ready` | `in_progress`, `cancelled` |
| `in_progress` | `in_review`, `cancelled` |
| `in_review` | `completed`, `in_progress` |
| `completed` | — terminal |
| `cancelled` | — terminal |

Only `packages/core` may perform a transition. Both entry points request transitions and are
refused with `InvalidTransitionError` (HTTP 409 / JSON-RPC error) when illegal.

## 5. First end-to-end scenario

A client sends a video revision request by email:

1. The mock email adapter emits a normalized inbound message.
2. Ingestion creates a **Request** (deduped on `provider + externalId`).
3. The **AI analysis service** extracts client, project, title, description, priority,
   due date and a suggested assignee, with confidence and the evidence it used.
4. A **Task draft** is created from that analysis and linked to the request.
5. A project manager reviews, edits and **approves** it in the Dashboard.
6. The task becomes `ready` and is assigned to a member.
7. The employee moves it through `in_progress → in_review → completed`.
8. Every hop, edit, approval and agent call lands in `audit_events` and the run history.

## 6. Dashboard pages

- **Overview** — workflow runs (running/failed/waiting), pending approvals, weekly estimated hours
  vs. each member's configured capacity, unscheduled estimate totals, recent activity and metrics.
- **AI Inbox** — request list with raw content and AI extraction side by side; edit, approve,
  reject, re-analyze; a "simulate inbound email" action drives the pipeline.
- **AI settings** — organization owners/admins can select the deterministic analyzer or configure
  an OpenAI-compatible base URL, model and API key. Keys are encrypted at rest with a key derived
  from `SESSION_SECRET`, never returned by the settings API, and connection checks use synthetic
  data. Real analysis sends the inbound request and organization candidate names to that provider.
  Local development can import an allow-listed key from `~/.duya/secrets.json` on the server;
  provider credentials are never returned to the browser.
- **Tasks** — Kanban board with assignee, priority, due date, estimated effort, and only allowed
  state transitions. The detail drawer supports dependency blockers, checklists, team comments,
  delivery/reference links, manually logged time and client review rounds. Prerequisites must be
  completed before work starts; checklist items must be complete before review; if client sign-off
  has been requested, the latest review must be approved before the task can be completed.
- **Client review** — a one-time 256-bit bearer link, stored as a SHA-256 token hash, expires after
  14 days and allows the client to approve or request changes. It exposes task title/project and
  delivery links only; it does not expose internal comments, estimates or the original inbound email.
- **Activity** — workflow runs, approvals, MCP agent calls, errors.

## 7. MCP surface (v0.1)

| Tool | Scope | Notes |
| --- | --- | --- |
| `list_projects` | `projects:read` | projects + open task counts |
| `list_requests` | `requests:read` | filter by `status`, used by the demo prompt |
| `analyze_request` | `requests:write` | returns the structured extraction |
| `create_task_draft` | `tasks:write` | draft only — never auto-approved |
| `list_tasks` | `tasks:read` | filter by status/assignee/project |
| `get_task` | `tasks:read` | full detail + allowed transitions |
| `request_task_approval` | `tasks:write` | `draft → pending_approval`; returns `requiresHumanConfirmation` |
| `get_workflow_status` | `requests:read` | runs + steps + errors |
| `get_team_capacity` | `tasks:read` | estimated work due this week vs. weekly capacity |

## 8. Demo data

Northline Creative, seeded and clearly labelled as simulated:

- **Clients**: Harbor Coffee Co., Lumen Fitness, Cedar & Sage Skincare, Northline's own test brand.
- **Projects**: `HBC-FALL-LAUNCH`, `LUMEN-30S-Q3`, `CEDAR-TEASER`, `HLM-RETOUCH`.
- **Team**: Dana, Marcus, Priya, Theo, Jordan (+ 3 part-time crew).
- **Requests**: a mix of `new`, `analyzed`, `drafted`, `approved`, `rejected`.
- **Tasks**: spread across all columns so the Kanban is populated on first load.

## 9. Explicitly simulated

Deterministic analyzer is the default; an OpenAI Chat Completions-compatible provider is optional
and must be explicitly configured. Email remains a mock adapter; there are no live OAuth/webhook
connections, cloud file uploads, billing, background notifications or scheduled reports. See
`docs/architecture.md` for the swap points.
