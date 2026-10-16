import { createHash, randomBytes, scryptSync } from 'node:crypto';
import type { SqlClient } from './client.js';
import { createRepositories } from './repositories.js';
import { idempotencyKey } from '@flowpilot/shared';
import type { Priority, RequestAnalysis, TaskStatus, WorkflowStep } from '@flowpilot/domain';

/**
 * Northline Creative demo tenant.
 *
 * Everything here is fictional and clearly labelled as simulated. Ids are fixed (not random) so
 * seeding is idempotent: running it twice updates nothing and creates no duplicates.
 */

export const DEMO_ORG_ID = 'org_northline';
export const DEMO_SLUG = 'northline-creative';

/** Demo-only agent credential, printed by `pnpm db:seed`. Revoke it from the dashboard. */
export const DEMO_AGENT_TOKEN = 'fp_live_demo_northline_2f8c41a97be04d2e';
export const DEMO_AGENT_SCOPES = ['projects:read', 'requests:read', 'requests:write', 'tasks:read', 'tasks:write'] as const;

/** Shared demo password for every seeded account (local Auth provider only). */
export const DEMO_PASSWORD = 'demo1234';

const nowIso = (): string => new Date().toISOString();
const daysFromNow = (days: number): string => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const hoursAgo = (hours: number): string => new Date(Date.now() - hours * 3_600_000).toISOString();

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export interface SeedResult {
  created: boolean;
  orgId: string;
  demoToken: string | null;
  counts: Record<string, number>;
}

export async function seed(db: SqlClient, options: { demoToken?: boolean } = {}): Promise<SeedResult> {
  const repos = createRepositories(db);

  const existing = await repos.organizations.findBySlug(DEMO_SLUG);
  if (existing) {
    await ensureDemoOperationalRecords(db, existing.id);
    return {
      created: false,
      orgId: existing.id,
      demoToken: options.demoToken ? DEMO_AGENT_TOKEN : null,
      counts: await countAll(db),
    };
  }

  const org = await repos.organizations.create({
    id: DEMO_ORG_ID,
    name: 'Northline Creative',
    slug: DEMO_SLUG,
    timezone: 'America/New_York',
  });
  const orgId = org.id;
  /* ---------------------------------------------------------------- team */

  const team = [
    { id: 'usr_dana', email: 'dana@northlinecreative.com', name: 'Dana Reyes', title: 'Co-founder & Managing Director', role: 'owner' as const, capacity: 20 },
    { id: 'usr_marcus', email: 'marcus@northlinecreative.com', name: 'Marcus Webb', title: 'Account Lead', role: 'admin' as const, capacity: 32 },
    { id: 'usr_priya', email: 'priya@northlinecreative.com', name: 'Priya Natarajan', title: 'Senior Producer', role: 'manager' as const, capacity: 36 },
    { id: 'usr_theo', email: 'theo@northlinecreative.com', name: 'Theo Brandt', title: 'Senior Editor', role: 'member' as const, capacity: 40 },
    { id: 'usr_jordan', email: 'jordan@northlinecreative.com', name: 'Jordan Ellis', title: 'Motion Designer', role: 'member' as const, capacity: 40 },
    { id: 'usr_sam', email: 'sam@northlinecreative.com', name: 'Sam Okafor', title: 'Shoot Producer', role: 'member' as const, capacity: 32 },
    { id: 'usr_lena', email: 'lena@northlinecreative.com', name: 'Lena Fischer', title: 'Copywriter', role: 'member' as const, capacity: 24 },
    { id: 'usr_owen', email: 'owen@northlinecreative.com', name: 'Owen Castellanos', title: 'Sound Designer (part-time)', role: 'member' as const, capacity: 16 },
  ];

  for (const member of team) {
    await repos.users.create({ id: member.id, email: member.email, fullName: member.name, title: member.title });
    await repos.memberships.create({
      id: `mem_${member.id.slice(4)}`,
      orgId,
      userId: member.id,
      role: member.role,
      title: member.title,
      weeklyCapacityHours: member.capacity,
    });
  }

  // Local Auth provider only — Supabase Auth owns credentials in its own schema.
  // Every demo account uses the same well-known demo password; it is a fake tenant.
  const salt = randomBytes(16).toString('hex');
  const demoHash = scryptSync(DEMO_PASSWORD, salt, 32).toString('hex');
  for (const member of team) {
    await db.query(
      'insert into local_credentials (user_id, password_hash, password_salt) values ($1, $2, $3) on conflict (user_id) do nothing',
      [member.id, demoHash, salt],
    );
  }

  /* ------------------------------------------------------------- clients */

  const clients = [
    { id: 'cli_harbor', name: 'Harbor Coffee Co.', industry: 'Food & Beverage', contactName: 'Alice Nguyen', contactEmail: 'alice@harborcoffee.com' },
    { id: 'cli_lumen', name: 'Lumen Fitness', industry: 'Health & Fitness', contactName: 'Dev Patel', contactEmail: 'dev@lumenfitness.com' },
    { id: 'cli_cedar', name: 'Cedar & Sage Skincare', industry: 'Beauty', contactName: 'Rosa Iversen', contactEmail: 'rosa@cedarsage.co' },
    { id: 'cli_harborlabs', name: 'Harbor Coffee Co. — Retail', industry: 'Retail', contactName: 'Alice Nguyen', contactEmail: 'alice@harborcoffee.com' },
  ];
  for (const c of clients) {
    await repos.clients.create({ id: c.id, orgId, name: c.name, industry: c.industry, contactName: c.contactName, contactEmail: c.contactEmail });
  }

  /* ------------------------------------------------------------ projects */

  const projects = [
    { id: 'prj_hbc_fall', clientId: 'cli_harbor', name: 'Fall Cold Brew Launch', code: 'HBC-FALL-LAUNCH', due: daysFromNow(21), description: 'Six 15s vertical cuts plus a hero 30s for paid social.' },
    { id: 'prj_lumen_q3', clientId: 'cli_lumen', name: '30s Creator Series — Q3', code: 'LUMEN-30S-Q3', due: daysFromNow(12), description: 'Six creator collab edits, 30s master each.' },
    { id: 'prj_cedar_teaser', clientId: 'cli_cedar', name: 'Serum Refill Teaser', code: 'CEDAR-TEASER', due: daysFromNow(5), description: 'Two teaser cuts, product macro focus.' },
    { id: 'prj_hbc_retouch', clientId: 'cli_harborlabs', name: 'Retail Store Retouch Batch', code: 'HBC-RETOUCH', due: daysFromNow(-2), description: 'Product retouch for the retail site refresh.' },
  ];
  for (const p of projects) {
    await repos.projects.create({
      id: p.id,
      orgId,
      clientId: p.clientId,
      name: p.name,
      code: p.code,
      description: p.description,
      status: 'active',
      dueDate: p.due,
    });
  }

  /* ------------------------------------------------------------ requests */

  const requestSeed: Array<{
    id: string;
    externalId: string;
    from: string;
    subject: string;
    body: string;
    hoursAgo: number;
    status: 'new' | 'analyzed' | 'drafted' | 'approved' | 'rejected';
    clientId?: string;
    projectId?: string;
    analysis?: RequestAnalysis;
  }> = [
    {
      id: 'req_hbc_logo',
      externalId: 'mock-msg-hbc-0001',
      from: 'alice@harborcoffee.com',
      subject: 'Re: cold brew launch — logo pops off on frame 4',
      body: `Hi Marcus,\n\nWatching the newest cut of the Fall Cold Brew hero, the logo pops off screen around 00:04 when the pour settles. Can you get a revision that keeps the steam effect but scales the logo down and holds it for the full end card?\n\nWe need this back before the paid flight starts on Monday.\n\nThanks,\nAlice`,
      hoursAgo: 30,
      status: 'new',
    },
    {
      id: 'req_lumen_hook',
      externalId: 'mock-msg-lumen-0002',
      from: 'dev@lumenfitness.com',
      subject: 'Creator 3 edit — hook feels slow in the first 2 seconds',
      body: `Hey Priya,\n\nCreator 3's edit opens on a wide shot and it takes about two seconds to get to the movement. Could we open on the close-up of the band and cut the intro? Also we'd love an alternate 15s version for the retargeting audience — that one can be more aggressive.\n\nDev from Lumen`,
      hoursAgo: 6,
      status: 'analyzed',
      clientId: 'cli_lumen',
      projectId: 'prj_lumen_q3',
      analysis: analysis({
        clientId: 'cli_lumen',
        clientName: 'Lumen Fitness',
        projectId: 'prj_lumen_q3',
        projectName: '30s Creator Series — Q3',
        title: 'Revise Creator 3 hook + cut 15s retargeting variant',
        description:
          'Open Creator 3 edit on the close-up of the band, trim the intro so movement lands in the first two seconds, and deliver a 15s retargeting cut.',
        priority: 'high',
        dueDate: daysFromNow(4),
        discipline: 'edit',
        assignee: { id: 'usr_theo', reason: 'Theo is the assigned editor on LUMEN-30S-Q3 and has the project open.' },
        confidence: 0.82,
        evidence: [
          { field: 'title', quote: 'hook feels slow in the first 2 seconds', confidence: 0.9 },
          { field: 'dueDate', quote: 'alternate 15s version for the retargeting audience', confidence: 0.4 },
        ],
        needsHumanReview: true,
      }),
    },
    {
      id: 'req_cedar_macro',
      externalId: 'mock-msg-cedar-0003',
      from: 'rosa@cedarsage.co',
      subject: 'Teaser cuts — need both versions by Thursday',
      body: `Hi team,\n\nLoving the direction on the serum refill teaser. We need both the 9:16 and the 1:1 versions delivered by Thursday end of day so our team can schedule the launch post.\n\nRosa`,
      hoursAgo: 50,
      status: 'drafted',
      clientId: 'cli_cedar',
      projectId: 'prj_cedar_teaser',
      analysis: analysis({
        clientId: 'cli_cedar',
        clientName: 'Cedar & Sage Skincare',
        projectId: 'prj_cedar_teaser',
        projectName: 'Serum Refill Teaser',
        title: 'Deliver 9:16 and 1:1 teaser cuts for Cedar & Sage',
        description: 'Cut both aspect ratios of the approved serum refill teaser for the Thursday launch post.',
        priority: 'urgent',
        dueDate: daysFromNow(2),
        discipline: 'edit',
        assignee: { id: 'usr_jordan', reason: 'Jordan cut the teaser master.' },
        confidence: 0.88,
        evidence: [{ field: 'dueDate', quote: 'delivered by Thursday end of day', confidence: 0.7 }],
        needsHumanReview: false,
      }),
    },
    {
      id: 'req_hbc_retouch_batch',
      externalId: 'mock-msg-hbc-0004',
      from: 'alice@harborcoffee.com',
      subject: 'Retail retouch batch — 22 SKUs, is that still on track?',
      body: `Hey Marcus,\n\nOur site team is chasing the retail retouch batch — 22 SKUs. We had this in the deck as delivered last week. Can you confirm where it stands?\n\nAlice`,
      hoursAgo: 96,
      status: 'approved',
      clientId: 'cli_harborlabs',
      projectId: 'prj_hbc_retouch',
      analysis: analysis({
        clientId: 'cli_harborlabs',
        clientName: 'Harbor Coffee Co. — Retail',
        projectId: 'prj_hbc_retouch',
        projectName: 'Retail Store Retouch Batch',
        title: 'Confirm and finish 22-SKU retail retouch batch',
        description: 'Client is chasing a batch they believed was delivered. Confirm status, then complete the outstanding SKUs.',
        priority: 'urgent',
        dueDate: daysFromNow(1),
        discipline: 'design',
        assignee: { id: 'usr_sam', reason: 'Sam owns the retail batch and the client call.' },
        confidence: 0.74,
        evidence: [{ field: 'priority', quote: 'we had this in the deck as delivered last week', confidence: 0.8 }],
        needsHumanReview: true,
      }),
    },
    {
      id: 'req_lumen_extra_cc',
      externalId: 'mock-msg-lumen-0005',
      from: 'dev@lumenfitness.com',
      subject: 'Can we add captions to the masters?',
      body: `Quick one — accessibility check came back and we need burned-in captions on all the Q3 masters. Not urgent, just noting it.\n\nDev`,
      hoursAgo: 120,
      status: 'rejected',
      clientId: 'cli_lumen',
      projectId: 'prj_lumen_q3',
      analysis: analysis({
        clientId: 'cli_lumen',
        clientName: 'Lumen Fitness',
        projectId: 'prj_lumen_q3',
        projectName: '30s Creator Series — Q3',
        title: 'Add burned-in captions to all Q3 masters',
        description: 'Accessibility review requires captions on every delivered master.',
        priority: 'low',
        dueDate: null,
        discipline: 'edit',
        assignee: null,
        confidence: 0.6,
        evidence: [],
        needsHumanReview: true,
      }),
    },
    {
      id: 'req_hbc_social_cutdowns',
      externalId: 'mock-msg-hbc-0006',
      from: 'alice@harborcoffee.com',
      subject: 'One more thing — cutdowns for Stories and Reels',
      body: `Sorry, one more from me. Paid is covered but organic needs three cutdowns per asset for Stories, Reels and TikTok. Let us know what that looks like on timing.\n\nAlice`,
      hoursAgo: 4,
      status: 'new',
    },
  ];

  for (const r of requestSeed) {
    const created = await repos.requests.create({
      id: r.id,
      orgId,
      source: 'email',
      sourceRef: idempotencyKey('mock-email', 'northline'),
      externalId: r.externalId,
      clientId: r.clientId ?? null,
      projectId: r.projectId ?? null,
      rawFrom: r.from,
      rawSubject: r.subject,
      rawBody: r.body,
      rawReceivedAt: hoursAgo(r.hoursAgo),
    });
    if (r.analysis) {
      await repos.requests.setAnalysis(orgId, created.id, r.analysis, r.status === 'rejected' ? 'rejected' : 'analyzed');
    }
  }

  /* --------------------------------------------------------------- tasks */

  const tasks: Array<{
    id: string;
    requestId?: string;
    projectId: string;
    title: string;
    description: string;
    status: TaskStatus;
    priority: Priority;
    assigneeId: string | null;
    dueDate: string | null;
    estimatedHours?: number;
    source: 'human' | 'agent' | 'system';
    createdBy: string;
  }> = [
    { id: 'tsk_hbc_logo', requestId: 'req_hbc_logo', projectId: 'prj_hbc_fall', title: 'Scale down end-card logo on Fall Cold Brew hero', description: 'Keep the steam effect, reduce logo size, hold the logo for the full end card.', status: 'pending_approval', priority: 'high', assigneeId: null, dueDate: daysFromNow(2), source: 'agent', createdBy: 'usr_marcus' },
    { id: 'tsk_lumen_hook', requestId: 'req_lumen_hook', projectId: 'prj_lumen_q3', title: 'Recut Creator 3 hook — open on close-up', description: 'Trim the intro so movement lands in the first two seconds.', status: 'draft', priority: 'high', assigneeId: 'usr_theo', dueDate: daysFromNow(4), estimatedHours: 3, source: 'agent', createdBy: 'usr_marcus' },
    { id: 'tsk_lumen_15s', projectId: 'prj_lumen_q3', title: 'Cut 15s retargeting variant — Creator 3', description: 'Aggressive 15s cut for retargeting audiences.', status: 'draft', priority: 'normal', assigneeId: null, dueDate: daysFromNow(5), estimatedHours: 5, source: 'human', createdBy: 'usr_priya' },
    { id: 'tsk_cedar_916', requestId: 'req_cedar_macro', projectId: 'prj_cedar_teaser', title: 'Deliver 9:16 serum refill teaser cut', description: 'Vertical master for the Thursday launch post.', status: 'ready', priority: 'urgent', assigneeId: 'usr_jordan', dueDate: daysFromNow(2), estimatedHours: 4, source: 'human', createdBy: 'usr_priya' },
    { id: 'tsk_cedar_11', requestId: 'req_cedar_macro', projectId: 'prj_cedar_teaser', title: 'Deliver 1:1 serum refill teaser cut', description: 'Square master for the Thursday launch post.', status: 'ready', priority: 'urgent', assigneeId: 'usr_jordan', dueDate: daysFromNow(2), estimatedHours: 3, source: 'human', createdBy: 'usr_priya' },
    { id: 'tsk_hbc_retouch_22', requestId: 'req_hbc_retouch_batch', projectId: 'prj_hbc_retouch', title: 'Finish outstanding retail retouch SKUs', description: '22-SKU batch, 9 outstanding. Client is chasing.', status: 'in_progress', priority: 'urgent', assigneeId: 'usr_sam', dueDate: daysFromNow(1), estimatedHours: 6, source: 'human', createdBy: 'usr_marcus' },
    { id: 'tsk_hbc_cutdowns', projectId: 'prj_hbc_fall', title: 'Plan organic cutdown package (Stories / Reels / TikTok)', description: 'Client asked for three cutdowns per asset and a timing estimate.', status: 'in_progress', priority: 'normal', assigneeId: 'usr_lena', dueDate: daysFromNow(6), estimatedHours: 4, source: 'human', createdBy: 'usr_priya' },
    { id: 'tsk_cedar_review', projectId: 'prj_cedar_teaser', title: 'Client review pass — teaser color grade', description: 'Grade against the Cedar & Sage reference LUT.', status: 'in_review', priority: 'normal', assigneeId: 'usr_priya', dueDate: daysFromNow(1), estimatedHours: 2, source: 'human', createdBy: 'usr_priya' },
    { id: 'tsk_lumen_captions', requestId: 'req_lumen_extra_cc', projectId: 'prj_lumen_q3', title: 'Burned-in captions for Q3 masters', description: 'Accessibility requirement flagged by the client.', status: 'rejected', priority: 'low', assigneeId: null, dueDate: null, source: 'agent', createdBy: 'usr_marcus' },
    { id: 'tsk_hbc_hero_done', projectId: 'prj_hbc_fall', title: 'Fall Cold Brew hero — first cut delivered', description: 'Shipped to the client for review.', status: 'completed', priority: 'high', assigneeId: 'usr_theo', dueDate: daysFromNow(-3), source: 'human', createdBy: 'usr_priya' },
    { id: 'tsk_lumen_music', projectId: 'prj_lumen_q3', title: 'License music bed for Creator series', description: 'Track cleared for paid and organic.', status: 'completed', priority: 'normal', assigneeId: 'usr_owen', dueDate: daysFromNow(-7), source: 'human', createdBy: 'usr_priya' },
    { id: 'tsk_hbc_retouch_cancelled', projectId: 'prj_hbc_retouch', title: 'Reshoot retail exterior b-roll', description: 'Dropped — client went with existing footage.', status: 'cancelled', priority: 'low', assigneeId: null, dueDate: null, source: 'human', createdBy: 'usr_marcus' },
  ];

  for (const t of tasks) {
    await repos.tasks.create({
      id: t.id,
      orgId,
      projectId: t.projectId,
      requestId: t.requestId ?? null,
      title: t.title,
      description: t.description,
      status: t.status,
      priority: t.priority,
      assigneeId: t.assigneeId,
      dueDate: t.dueDate,
      estimatedHours: t.estimatedHours ?? null,
      source: t.source,
      createdBy: t.createdBy,
    });
  }

  await ensureDemoOperationalRecords(db, orgId);

  /* ----------------------------------------------------------- approvals */

  await repos.approvals.create({
    id: 'apr_seed_1',
    orgId,
    taskId: 'tsk_hbc_retouch_22',
    requestId: 'req_hbc_retouch_batch',
    decision: 'approved',
    note: 'Confirmed with Alice: 9 SKUs outstanding, finishing tomorrow.',
    decidedBy: 'usr_marcus',
    decidedByLabel: 'Marcus Webb',
  });

  await repos.approvals.create({
    id: 'apr_seed_2',
    orgId,
    taskId: 'tsk_lumen_captions',
    requestId: 'req_lumen_extra_cc',
    decision: 'rejected',
    note: 'Not doing this as one task — will scope with Lumen as a batch after Q3 delivery.',
    decidedBy: 'usr_priya',
    decidedByLabel: 'Priya Natarajan',
  });

  /* ------------------------------------------------------- workflow runs */

  const run1Steps: WorkflowStep[] = [
    { key: 'ingest', label: 'Ingest inbound email', status: 'succeeded', startedAt: hoursAgo(50), finishedAt: hoursAgo(50), detail: { provider: 'mock-email', messageId: 'mock-msg-cedar-0003' }, error: null },
    { key: 'analyze', label: 'AI analysis', status: 'succeeded', startedAt: hoursAgo(50), finishedAt: hoursAgo(49.9), detail: { provider: 'deterministic', confidence: 0.88 }, error: null },
    { key: 'draft', label: 'Create task draft', status: 'succeeded', startedAt: hoursAgo(49.9), finishedAt: hoursAgo(49.9), detail: { taskId: 'tsk_cedar_916' }, error: null },
    { key: 'approval', label: 'Human approval', status: 'succeeded', startedAt: hoursAgo(8), finishedAt: hoursAgo(8), detail: { decidedBy: 'Priya Natarajan' }, error: null },
  ];

  const run2Steps: WorkflowStep[] = [
    { key: 'list_requests', label: 'Agent listed pending requests', status: 'succeeded', startedAt: hoursAgo(6), finishedAt: hoursAgo(6), detail: { found: 2 }, error: null },
    { key: 'analyze', label: 'AI analysis', status: 'succeeded', startedAt: hoursAgo(5.9), finishedAt: hoursAgo(5.8), detail: { provider: 'deterministic', confidence: 0.82 }, error: null },
    { key: 'draft', label: 'Create task draft', status: 'succeeded', startedAt: hoursAgo(5.8), finishedAt: hoursAgo(5.8), detail: { taskId: 'tsk_lumen_hook' }, error: null },
    { key: 'approval', label: 'Human approval', status: 'pending', startedAt: hoursAgo(5.8), finishedAt: null, detail: null, error: null },
  ];

  await repos.workflowRuns.start({
    id: 'run_seed_1',
    orgId,
    trigger: 'mock_email',
    requestId: 'req_cedar_macro',
    taskId: 'tsk_cedar_916',
    steps: run1Steps,
  });
  await repos.workflowRuns.saveSteps(orgId, 'run_seed_1', run1Steps, 'succeeded');

  await repos.workflowRuns.start({
    id: 'run_seed_2',
    orgId,
    trigger: 'mcp',
    requestId: 'req_lumen_hook',
    taskId: 'tsk_lumen_hook',
    steps: run2Steps,
  });
  await repos.workflowRuns.saveSteps(orgId, 'run_seed_2', run2Steps, 'waiting_approval');

  /* ------------------------------------------------------ integrations */

  await repos.integrations.upsert({
    id: 'int_mock_email',
    orgId,
    provider: 'mock-email',
    status: 'connected',
    config: { note: 'Simulated inbound email. No external connection in v0.1.', simulateInUi: true },
  });
  await db.query('update integration_connections set last_event_at = $2 where org_id = $1 and provider = $3', [
    orgId,
    hoursAgo(4),
    'mock-email',
  ]);

  /* ------------------------------------------------------------- audit */

  const auditSeed = [
    { action: 'request.ingested', entityType: 'request', entityId: 'req_hbc_logo', actor: 'usr_marcus', label: 'Marcus Webb', kind: 'user' as const, hours: 30, meta: { source: 'mock-email', messageId: 'mock-msg-hbc-0001' } },
    { action: 'request.ingested', entityType: 'request', entityId: 'req_hbc_social_cutdowns', actor: 'usr_marcus', label: 'Marcus Webb', kind: 'user' as const, hours: 4, meta: { source: 'mock-email', messageId: 'mock-msg-hbc-0006' } },
    { action: 'task.transitioned', entityType: 'task', entityId: 'tsk_hbc_retouch_22', actor: 'usr_sam', label: 'Sam Okafor', kind: 'user' as const, hours: 20, meta: { from: 'ready', to: 'in_progress' } },
    { action: 'approval.decided', entityType: 'task', entityId: 'tsk_hbc_retouch_22', actor: 'usr_marcus', label: 'Marcus Webb', kind: 'user' as const, hours: 8, meta: { decision: 'approved' } },
    { action: 'approval.decided', entityType: 'task', entityId: 'tsk_lumen_captions', actor: 'usr_priya', label: 'Priya Natarajan', kind: 'user' as const, hours: 26, meta: { decision: 'rejected' } },
    { action: 'agent.task_draft_created', entityType: 'task', entityId: 'tsk_lumen_hook', actor: 'cred_seed_agent', label: 'Demo agent (agent)', kind: 'agent' as const, hours: 5.8, meta: { via: 'mcp', tool: 'create_task_draft' } },
    { action: 'agent.request_analyzed', entityType: 'request', entityId: 'req_lumen_hook', actor: 'cred_seed_agent', label: 'Demo agent (agent)', kind: 'agent' as const, hours: 5.9, meta: { via: 'mcp', tool: 'analyze_request' } },
    { action: 'task.transitioned', entityType: 'task', entityId: 'tsk_cedar_review', actor: 'usr_priya', label: 'Priya Natarajan', kind: 'user' as const, hours: 12, meta: { from: 'in_progress', to: 'in_review' } },
    { action: 'task.completed', entityType: 'task', entityId: 'tsk_hbc_hero_done', actor: 'usr_theo', label: 'Theo Brandt', kind: 'user' as const, hours: 70, meta: { from: 'in_review', to: 'completed' } },
  ];

  for (const [index, event] of auditSeed.entries()) {
    await repos.audit.record({
      id: `aud_seed_${index + 1}`,
      orgId,
      actorKind: event.kind,
      actorId: event.actor,
      actorLabel: event.label,
      action: event.action,
      entityType: event.entityType,
      entityId: event.entityId,
      metadata: event.meta,
    });
  }
  // Backdate the seeded audit rows so the Activity page has a believable timeline.
  for (const [index, event] of auditSeed.entries()) {
    await db.query('update audit_events set created_at = now() - ($1 || \' hours\')::interval where id = $2', [
      String(event.hours),
      `aud_seed_${index + 1}`,
    ]);
  }

  /* ------------------------------------------------------ demo agent token */

  if (options.demoToken !== false) {
    await repos.credentials.create({
      id: 'cred_seed_agent',
      orgId,
      name: 'Demo agent (seeded, local development only)',
      tokenPrefix: DEMO_AGENT_TOKEN.slice(0, 14),
      tokenHash: hashToken(DEMO_AGENT_TOKEN),
      scopes: [...DEMO_AGENT_SCOPES],
    });
  }

  return {
    created: true,
    orgId,
    demoToken: options.demoToken === false ? null : DEMO_AGENT_TOKEN,
    counts: await countAll(db),
  };
}

async function ensureDemoOperationalRecords(db: SqlClient, orgId: string): Promise<void> {
  const estimates: Array<[string, number]> = [
    ['tsk_lumen_hook', 3], ['tsk_lumen_15s', 5], ['tsk_cedar_916', 4], ['tsk_cedar_11', 3],
    ['tsk_hbc_retouch_22', 6], ['tsk_hbc_cutdowns', 4], ['tsk_cedar_review', 2],
  ];
  for (const [taskId, hours] of estimates) {
    await db.query('update tasks set estimated_hours=$1 where org_id=$2 and id=$3 and estimated_hours is null', [hours, orgId, taskId]);
  }

  await db.query(
    `insert into task_checklist_items (id,org_id,task_id,title,is_complete,sort_order,created_by,completed_at)
     values ('chk_seed_review_safearea',$1,'tsk_cedar_review','Check safe areas and label legibility',true,1,'usr_priya',now()),
            ('chk_seed_review_exports',$1,'tsk_cedar_review','Confirm vertical and square exports',true,2,'usr_priya',now())
     on conflict (id) do nothing`, [orgId]);
  await db.query(
    `insert into task_comments (id,org_id,task_id,author_id,author_label,body)
     values ('cmt_seed_review_note',$1,'tsk_cedar_review','usr_priya','Priya Natarajan','Please check the product label at mobile size against the approved Cedar & Sage reference.')
     on conflict (id) do nothing`, [orgId]);
  await db.query(
    `insert into task_links (id,org_id,task_id,label,url,kind,added_by)
     values ('lnk_seed_review_delivery',$1,'tsk_cedar_review','Demo delivery link','https://example.com/flowpilot-demo/client-delivery','delivery','usr_priya'),
            ('lnk_seed_review_reference',$1,'tsk_cedar_review','Color grade reference','https://example.com/flowpilot-demo/approved-reference','reference','usr_priya')
     on conflict (id) do nothing`, [orgId]);
  await db.query(
    `insert into task_time_entries (id,org_id,task_id,user_id,description,hours,logged_on)
     values ('tim_seed_review',$1,'tsk_cedar_review','usr_priya','Color pass and export QA',1.25,current_date)
     on conflict (id) do nothing`, [orgId]);
  await db.query(
    `insert into task_dependencies (id,org_id,task_id,depends_on_task_id)
     values ('dep_seed_lumen_variant',$1,'tsk_lumen_15s','tsk_lumen_hook')
     on conflict (id) do nothing`, [orgId]);
}

async function countAll(db: SqlClient): Promise<Record<string, number>> {
  const tables = ['users', 'clients', 'projects', 'requests', 'tasks', 'workflow_runs', 'audit_events'];
  const out: Record<string, number> = {};
  for (const table of tables) {
    const row = await db.one<Record<string, unknown>>(`select count(*)::int as n from ${table}`);
    out[table] = Number(row?.['n'] ?? 0);
  }
  return out;
}

interface AnalysisSeedInput {
  clientId: string | null;
  clientName: string | null;
  projectId: string | null;
  projectName: string | null;
  title: string;
  description: string;
  priority: Priority;
  dueDate: string | null;
  discipline: RequestAnalysis['discipline'];
  assignee: { id: string | null; reason: string } | null;
  confidence: number;
  evidence: RequestAnalysis['evidence'];
  needsHumanReview: boolean;
}

/** Builds a `RequestAnalysis` for seeded data using the same provider label the runtime uses. */
function analysis(input: AnalysisSeedInput): RequestAnalysis {
  const users: Record<string, string> = {
    usr_theo: 'Theo Brandt',
    usr_jordan: 'Jordan Ellis',
    usr_sam: 'Sam Okafor',
    usr_lena: 'Lena Fischer',
    usr_priya: 'Priya Natarajan',
  };
  return {
    clientId: input.clientId,
    clientName: input.clientName,
    projectId: input.projectId,
    projectName: input.projectName,
    title: input.title,
    description: input.description,
    priority: input.priority,
    dueDate: input.dueDate,
    discipline: input.discipline,
    suggestedAssignee: input.assignee
      ? {
          userId: input.assignee.id,
          name: input.assignee.id ? (users[input.assignee.id] ?? 'Unknown') : 'Unassigned',
          reason: input.assignee.reason,
          confidence: input.confidence,
        }
      : null,
    confidence: input.confidence,
    evidence: input.evidence,
    needsHumanReview: input.needsHumanReview,
    provider: 'deterministic',
    model: 'rule-based-v1',
    createdAt: nowIso(),
  };
}
