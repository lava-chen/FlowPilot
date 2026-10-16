import { z } from 'zod';

/**
 * Entity contracts.
 *
 * These types are the shared vocabulary of the whole system: the database repositories return
 * them, the core services mutate them, and both the dashboard and the MCP server serialize them.
 * Every field a client can influence is validated by a zod schema here — not at the edges only.
 */

export const membershipRoles = ['owner', 'admin', 'manager', 'member'] as const;
export type MembershipRole = (typeof membershipRoles)[number];

export const taskStatuses = [
  'draft',
  'pending_approval',
  'ready',
  'in_progress',
  'in_review',
  'completed',
  'rejected',
  'cancelled',
] as const;
export type TaskStatus = (typeof taskStatuses)[number];

export const priorities = ['low', 'normal', 'high', 'urgent'] as const;
export type Priority = (typeof priorities)[number];

export const requestStatuses = ['new', 'analyzed', 'drafted', 'approved', 'rejected', 'failed'] as const;
export type RequestStatus = (typeof requestStatuses)[number];

export const workflowRunStatuses = ['running', 'waiting_approval', 'succeeded', 'failed'] as const;
export type WorkflowRunStatus = (typeof workflowRunStatuses)[number];

export const workflowTriggers = ['mock_email', 'manual', 'mcp', 'system'] as const;
export type WorkflowTrigger = (typeof workflowTriggers)[number];

export const projectStatuses = ['active', 'on_hold', 'completed', 'archived'] as const;
export type ProjectStatus = (typeof projectStatuses)[number];

export const clientStatuses = ['active', 'prospect', 'archived'] as const;
export type ClientStatus = (typeof clientStatuses)[number];

export const taskSources = ['human', 'agent', 'system'] as const;
export type TaskSource = (typeof taskSources)[number];

export const approvalDecisions = ['approved', 'rejected'] as const;
export type ApprovalDecision = (typeof approvalDecisions)[number];

export const actorKinds = ['user', 'agent', 'system'] as const;
export type ActorKind = (typeof actorKinds)[number];

/** MCP scopes. Note: there is deliberately no `approvals:decide` scope. */
export const scopes = ['projects:read', 'requests:read', 'requests:write', 'tasks:read', 'tasks:write'] as const;
export type Scope = (typeof scopes)[number];

export const RoleSchema = z.enum(membershipRoles);
export const TaskStatusSchema = z.enum(taskStatuses);
export const PrioritySchema = z.enum(priorities);
export const RequestStatusSchema = z.enum(requestStatuses);
export const WorkflowRunStatusSchema = z.enum(workflowRunStatuses);
export const WorkflowTriggerSchema = z.enum(workflowTriggers);
export const ProjectStatusSchema = z.enum(projectStatuses);
export const ClientStatusSchema = z.enum(clientStatuses);
export const TaskSourceSchema = z.enum(taskSources);
export const ApprovalDecisionSchema = z.enum(approvalDecisions);
export const ActorKindSchema = z.enum(actorKinds);
export const ScopeSchema = z.enum(scopes);

export interface Organization {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  createdAt: string;
}

export interface User {
  id: string;
  email: string;
  fullName: string;
  title: string | null;
  avatarUrl: string | null;
  createdAt: string;
}

export interface Membership {
  id: string;
  orgId: string;
  userId: string;
  role: MembershipRole;
  title: string | null;
  /** Weekly capacity in hours — feeds the workload view planned for v0.2. */
  weeklyCapacityHours: number;
  createdAt: string;
}

export interface Client {
  id: string;
  orgId: string;
  name: string;
  industry: string | null;
  contactName: string | null;
  contactEmail: string | null;
  status: ClientStatus;
  createdAt: string;
}

export interface Project {
  id: string;
  orgId: string;
  clientId: string;
  name: string;
  code: string;
  description: string | null;
  status: ProjectStatus;
  dueDate: string | null;
  createdAt: string;
  /** Denormalized for list views; always derived from tasks. */
  openTaskCount?: number;
}

export interface RequestRecord {
  id: string;
  orgId: string;
  source: 'email' | 'manual';
  sourceRef: string;
  externalId: string;
  clientId: string | null;
  projectId: string | null;
  rawFrom: string;
  rawSubject: string;
  rawBody: string;
  rawReceivedAt: string;
  status: RequestStatus;
  analysis: RequestAnalysis | null;
  createdAt: string;
}

export interface Task {
  id: string;
  orgId: string;
  projectId: string;
  requestId: string | null;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: Priority;
  assigneeId: string | null;
  dueDate: string | null;
  estimatedHours: number | null;
  source: TaskSource;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface TaskChecklistItem {
  id: string;
  orgId: string;
  taskId: string;
  title: string;
  isComplete: boolean;
  sortOrder: number;
  createdBy: string;
  createdAt: string;
  completedAt: string | null;
}

export interface TaskComment {
  id: string;
  orgId: string;
  taskId: string;
  authorId: string;
  authorLabel: string;
  body: string;
  createdAt: string;
}

export type TaskLinkKind = 'brief' | 'reference' | 'delivery' | 'other';
export interface TaskLink {
  id: string;
  orgId: string;
  taskId: string;
  label: string;
  url: string;
  kind: TaskLinkKind;
  addedBy: string;
  createdAt: string;
}

export interface TaskTimeEntry {
  id: string;
  orgId: string;
  taskId: string;
  userId: string;
  userLabel: string;
  description: string | null;
  hours: number;
  loggedOn: string;
  createdAt: string;
}

export interface TaskDependency {
  id: string;
  orgId: string;
  taskId: string;
  dependsOnTaskId: string;
  dependsOnTitle: string;
  dependsOnStatus: TaskStatus;
  createdAt: string;
}

export type ClientReviewStatus = 'pending' | 'approved' | 'changes_requested' | 'expired';
export interface TaskClientReview {
  id: string;
  orgId: string;
  taskId: string;
  status: ClientReviewStatus;
  requestedBy: string;
  reviewerName: string | null;
  reviewerEmail: string | null;
  note: string | null;
  expiresAt: string;
  createdAt: string;
  respondedAt: string | null;
}

export interface WorkflowStep {
  key: string;
  label: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';
  startedAt: string;
  finishedAt: string | null;
  detail: Record<string, unknown> | null;
  error: string | null;
}

export interface WorkflowRun {
  id: string;
  orgId: string;
  requestId: string | null;
  taskId: string | null;
  trigger: WorkflowTrigger;
  status: WorkflowRunStatus;
  steps: WorkflowStep[];
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface Approval {
  id: string;
  orgId: string;
  taskId: string;
  requestId: string | null;
  decision: ApprovalDecision;
  note: string | null;
  decidedBy: string;
  decidedByLabel: string;
  createdAt: string;
}

export interface IntegrationConnection {
  id: string;
  orgId: string;
  provider: string;
  status: 'connected' | 'disconnected' | 'error';
  config: Record<string, unknown>;
  lastEventAt: string | null;
  createdAt: string;
}

export interface AgentCredential {
  id: string;
  orgId: string;
  name: string;
  tokenPrefix: string;
  scopes: Scope[];
  revokedAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface AuditEvent {
  id: string;
  orgId: string;
  actorKind: ActorKind;
  actorId: string;
  actorLabel: string;
  action: string;
  entityType: string;
  entityId: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

/* -------------------------------------------------------------------------- */
/* AI analysis contract                                                        */
/* -------------------------------------------------------------------------- */

export const AnalysisEvidenceSchema = z.object({
  field: z.string(),
  quote: z.string(),
  confidence: z.number().min(0).max(1),
});

export const AssigneeSuggestionSchema = z.object({
  userId: z.string().nullable(),
  name: z.string(),
  reason: z.string(),
  confidence: z.number().min(0).max(1),
});

/**
 * Structured analysis returned by an `AiProvider`.
 *
 * `confidence` per field plus `evidence` quotes exist so the dashboard can be honest with the
 * user: a low-confidence field is visibly flagged instead of silently trusted.
 */
export const RequestAnalysisSchema = z.object({
  clientId: z.string().nullable(),
  clientName: z.string().nullable(),
  projectId: z.string().nullable(),
  projectName: z.string().nullable(),
  title: z.string().min(3).max(200),
  description: z.string().max(4000),
  priority: PrioritySchema,
  dueDate: z.string().nullable(),
  discipline: z.enum(['edit', 'shoot', 'design', 'copy', 'strategy', 'sound', 'unknown']).default('unknown'),
  suggestedAssignee: AssigneeSuggestionSchema.nullable(),
  confidence: z.number().min(0).max(1),
  evidence: z.array(AnalysisEvidenceSchema),
  needsHumanReview: z.boolean(),
  provider: z.string(),
  model: z.string(),
  createdAt: z.string(),
});

export type RequestAnalysis = z.infer<typeof RequestAnalysisSchema>;

/* -------------------------------------------------------------------------- */
/* Actor contract                                                              */
/* -------------------------------------------------------------------------- */

export interface UserActor {
  kind: 'user';
  userId: string;
  orgId: string;
  role: MembershipRole;
  email: string;
  displayName: string;
}

export interface AgentActor {
  kind: 'agent';
  credentialId: string;
  orgId: string;
  scopes: Scope[];
  label: string;
}

export interface SystemActor {
  kind: 'system';
  orgId: string;
  label: string;
}

export type Actor = UserActor | AgentActor | SystemActor;

export function actorLabel(actor: Actor): string {
  if (actor.kind === 'user') return actor.displayName;
  if (actor.kind === 'agent') return `${actor.label} (agent)`;
  return actor.label;
}

export function actorId(actor: Actor): string {
  return actor.kind === 'user' ? actor.userId : actor.kind === 'agent' ? actor.credentialId : 'system';
}
