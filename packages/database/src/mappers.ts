import type {
  Approval,
  AuditEvent,
  Client,
  IntegrationConnection,
  Membership,
  MembershipRole,
  Organization,
  Project,
  RequestRecord,
  Scope,
  Task,
  User,
  WorkflowRun,
  WorkflowRunStatus,
  WorkflowStep,
  WorkflowTrigger,
  TaskStatus,
  Priority,
  RequestStatus,
  TaskSource,
  ProjectStatus,
  ClientStatus,
  ApprovalDecision,
  ActorKind,
  TaskChecklistItem,
  TaskComment,
  TaskLink,
  TaskTimeEntry,
  TaskDependency,
  TaskClientReview,
  ClientReviewStatus,
} from '@flowpilot/domain';

/** snake_case row -> camelCase entity. Kept explicit so a schema change breaks loudly here. */

type Row = Record<string, unknown>;

const str = (v: unknown): string => String(v);
const nullableStr = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const nullableIso = (v: unknown): string | null => (v === null || v === undefined ? null : iso(v));
const isoDate = (v: unknown): string | null => (v === null || v === undefined ? null : String(v).slice(0, 10));
const num = (v: unknown): number => Number(v);

export const mapOrganization = (r: Row): Organization => ({
  id: str(r['id']),
  name: str(r['name']),
  slug: str(r['slug']),
  timezone: str(r['timezone']),
  createdAt: iso(r['created_at']),
});

export const mapUser = (r: Row): User => ({
  id: str(r['id']),
  email: str(r['email']),
  fullName: str(r['full_name']),
  title: nullableStr(r['title']),
  avatarUrl: nullableStr(r['avatar_url']),
  createdAt: iso(r['created_at']),
});

export const mapMembership = (r: Row): Membership => ({
  id: str(r['id']),
  orgId: str(r['org_id']),
  userId: str(r['user_id']),
  role: str(r['role']) as MembershipRole,
  title: nullableStr(r['title']),
  weeklyCapacityHours: num(r['weekly_capacity_hours']),
  createdAt: iso(r['created_at']),
});

export const mapClient = (r: Row): Client => ({
  id: str(r['id']),
  orgId: str(r['org_id']),
  name: str(r['name']),
  industry: nullableStr(r['industry']),
  contactName: nullableStr(r['contact_name']),
  contactEmail: nullableStr(r['contact_email']),
  status: str(r['status']) as ClientStatus,
  createdAt: iso(r['created_at']),
});

export const mapProject = (r: Row): Project => {
  const openTaskCount = r['open_task_count'];
  return {
    id: str(r['id']),
    orgId: str(r['org_id']),
    clientId: str(r['client_id']),
    name: str(r['name']),
    code: str(r['code']),
    description: nullableStr(r['description']),
    status: str(r['status']) as ProjectStatus,
    dueDate: nullableStr(r['due_date']),
    createdAt: iso(r['created_at']),
    ...(openTaskCount === undefined || openTaskCount === null ? {} : { openTaskCount: num(openTaskCount) }),
  };
};

export const mapRequest = (r: Row): RequestRecord => ({
  id: str(r['id']),
  orgId: str(r['org_id']),
  source: str(r['source']) as RequestRecord['source'],
  sourceRef: str(r['source_ref']),
  externalId: str(r['external_id']),
  clientId: nullableStr(r['client_id']),
  projectId: nullableStr(r['project_id']),
  rawFrom: str(r['raw_from']),
  rawSubject: str(r['raw_subject']),
  rawBody: str(r['raw_body']),
  rawReceivedAt: iso(r['raw_received_at']),
  status: str(r['status']) as RequestStatus,
  analysis: (r['analysis'] ?? null) as RequestRecord['analysis'],
  createdAt: iso(r['created_at']),
});

export const mapTask = (r: Row): Task => ({
  id: str(r['id']),
  orgId: str(r['org_id']),
  projectId: str(r['project_id']),
  requestId: nullableStr(r['request_id']),
  title: str(r['title']),
  description: nullableStr(r['description']),
  status: str(r['status']) as TaskStatus,
  priority: str(r['priority']) as Priority,
  assigneeId: nullableStr(r['assignee_id']),
  dueDate: isoDate(r['due_date']),
  estimatedHours: r['estimated_hours'] === null || r['estimated_hours'] === undefined ? null : num(r['estimated_hours']),
  source: str(r['source']) as TaskSource,
  createdBy: str(r['created_by']),
  createdAt: iso(r['created_at']),
  updatedAt: iso(r['updated_at']),
  version: num(r['version']),
});

export const mapChecklistItem = (r: Row): TaskChecklistItem => ({
  id: str(r['id']), orgId: str(r['org_id']), taskId: str(r['task_id']), title: str(r['title']),
  isComplete: Boolean(r['is_complete']), sortOrder: num(r['sort_order']), createdBy: str(r['created_by']),
  createdAt: iso(r['created_at']), completedAt: nullableIso(r['completed_at']),
});

export const mapTaskComment = (r: Row): TaskComment => ({
  id: str(r['id']), orgId: str(r['org_id']), taskId: str(r['task_id']), authorId: str(r['author_id']),
  authorLabel: str(r['author_label']), body: str(r['body']), createdAt: iso(r['created_at']),
});

export const mapTaskLink = (r: Row): TaskLink => ({
  id: str(r['id']), orgId: str(r['org_id']), taskId: str(r['task_id']), label: str(r['label']), url: str(r['url']),
  kind: str(r['kind']) as TaskLink['kind'], addedBy: str(r['added_by']), createdAt: iso(r['created_at']),
});

export const mapTaskTimeEntry = (r: Row): TaskTimeEntry => ({
  id: str(r['id']), orgId: str(r['org_id']), taskId: str(r['task_id']), userId: str(r['user_id']),
  userLabel: str(r['user_label']), description: nullableStr(r['description']), hours: num(r['hours']),
  loggedOn: isoDate(r['logged_on']) ?? '', createdAt: iso(r['created_at']),
});

export const mapTaskDependency = (r: Row): TaskDependency => ({
  id: str(r['id']), orgId: str(r['org_id']), taskId: str(r['task_id']), dependsOnTaskId: str(r['depends_on_task_id']),
  dependsOnTitle: str(r['depends_on_title']), dependsOnStatus: str(r['depends_on_status']) as TaskStatus,
  createdAt: iso(r['created_at']),
});

export const mapTaskClientReview = (r: Row): TaskClientReview => ({
  id: str(r['id']), orgId: str(r['org_id']), taskId: str(r['task_id']), status: str(r['status']) as ClientReviewStatus,
  requestedBy: str(r['requested_by']), reviewerName: nullableStr(r['reviewer_name']),
  reviewerEmail: nullableStr(r['reviewer_email']), note: nullableStr(r['note']), expiresAt: iso(r['expires_at']),
  createdAt: iso(r['created_at']), respondedAt: nullableIso(r['responded_at']),
});

export const mapWorkflowRun = (r: Row): WorkflowRun => ({
  id: str(r['id']),
  orgId: str(r['org_id']),
  requestId: nullableStr(r['request_id']),
  taskId: nullableStr(r['task_id']),
  trigger: str(r['trigger']) as WorkflowTrigger,
  status: str(r['status']) as WorkflowRunStatus,
  steps: (r['steps'] ?? []) as WorkflowStep[],
  error: nullableStr(r['error']),
  startedAt: iso(r['started_at']),
  finishedAt: nullableIso(r['finished_at']),
});

export const mapApproval = (r: Row): Approval => ({
  id: str(r['id']),
  orgId: str(r['org_id']),
  taskId: str(r['task_id']),
  requestId: nullableStr(r['request_id']),
  decision: str(r['decision']) as ApprovalDecision,
  note: nullableStr(r['note']),
  decidedBy: str(r['decided_by']),
  decidedByLabel: str(r['decided_by_label']),
  createdAt: iso(r['created_at']),
});

export const mapIntegration = (r: Row): IntegrationConnection => ({
  id: str(r['id']),
  orgId: str(r['org_id']),
  provider: str(r['provider']),
  status: str(r['status']) as IntegrationConnection['status'],
  config: (r['config'] ?? {}) as Record<string, unknown>,
  lastEventAt: nullableIso(r['last_event_at']),
  createdAt: iso(r['created_at']),
});

export const mapCredential = (r: Row): {
  id: string;
  orgId: string;
  name: string;
  tokenPrefix: string;
  scopes: Scope[];
  revokedAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
} => ({
  id: str(r['id']),
  orgId: str(r['org_id']),
  name: str(r['name']),
  tokenPrefix: str(r['token_prefix']),
  scopes: (r['scopes'] ?? []) as Scope[],
  revokedAt: nullableIso(r['revoked_at']),
  lastUsedAt: nullableIso(r['last_used_at']),
  createdAt: iso(r['created_at']),
});

export const mapAuditEvent = (r: Row): AuditEvent => ({
  id: str(r['id']),
  orgId: str(r['org_id']),
  actorKind: str(r['actor_kind']) as ActorKind,
  actorId: str(r['actor_id']),
  actorLabel: str(r['actor_label']),
  action: str(r['action']),
  entityType: str(r['entity_type']),
  entityId: str(r['entity_id']),
  metadata: (r['metadata'] ?? {}) as Record<string, unknown>,
  createdAt: iso(r['created_at']),
});
