# Round 1 — End-to-End Acceptance

**Date:** 16 October 2026  
**Scope:** A synthetic client request from intake through delivery approval and audit review.

## Result

The cross-surface workflow passed locally. A simulated email was ingested by the Dashboard API, an external MCP SDK client discovered and analyzed the request over Streamable HTTP, and the agent created a draft and requested human approval. A manager assigned and approved the task, the team completed its checklist and attached a delivery link, and a client reviewer accepted the delivery through the review link. The task reached `completed`, and the Activity API returned the human, agent, approval, and client-review events.

The agent's exposed MCP tools do not include `approve_task`. The workflow test verifies that a draft remains pending human confirmation until the manager approves it.

## Evidence

- `apps/web/test/api.test.ts`: one integration test exercises sample-email intake, a real MCP SDK client over an ephemeral local HTTP server, task drafting, human approval, assignment, checklist completion, delivery link, client review, completion, and audit reads.
- `packages/core/test/ai-provider.test.ts`: MiniMax-specific request formatting has offline regression coverage; generic OpenAI-compatible endpoints do not receive MiniMax-only options.
- Local Vitest suite: **84 tests passed** across 9 files.
- Root TypeScript check: passed.
- Next.js production build: passed.
- GitHub Actions workflow: `.github/workflows/ci.yml` installs from the frozen pnpm lockfile, runs the test suite, then runs the root build (including typecheck).

## Live model smoke test

MiniMax CN `MiniMax-M2.7` passed both a synthetic connection check and a synthetic request-analysis call through FlowPilot's provider. MiniMax returns reasoning separately when `reasoning_split` is enabled; the adapter now enables this option for MiniMax endpoints only. The analysis result passed FlowPilot's existing structured-output and grounding validation. The API key and response body were not printed or committed, and the test used fabricated request text and empty candidate records. The provider was not saved to the demo organization, which remains on offline rules.

## Limits

This is a local integration test using an in-memory PGlite database. The MCP transport is real, but the test server and Dashboard route handlers run in the same test process. It does not prove that two separately deployed processes share state, that PostgreSQL migrations and RLS are production-ready, or that a real Gmail/Slack/ClickUp connector works. The request intake is simulated, and the customer review response is a test client call rather than an external browser session.

GitHub Actions has been added to the public repository; its first hosted run must complete before CI itself can be reported as remotely verified.
