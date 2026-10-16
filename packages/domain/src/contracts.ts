import { z } from 'zod';
import {
  PrioritySchema,
  RequestStatusSchema,
  TaskStatusSchema,
  WorkflowTriggerSchema,
} from './entities.js';

/**
 * Input contracts shared by the HTTP API and the MCP tools.
 *
 * Both surfaces validate with the *same* schema, so an MCP agent cannot smuggle in a field the
 * dashboard would have rejected (or the other way round).
 */

const idField = z.string().min(3).max(64);

export const LoginInputSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});
export type LoginInput = z.infer<typeof LoginInputSchema>;

export const TaskListQuerySchema = z.object({
  status: z.union([TaskStatusSchema, z.array(TaskStatusSchema)]).optional(),
  assigneeId: z.string().optional(),
  projectId: z.string().optional(),
  requestId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type TaskListQuery = z.infer<typeof TaskListQuerySchema>;

export const RequestListQuerySchema = z.object({
  status: z.union([RequestStatusSchema, z.array(RequestStatusSchema)]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type RequestListQuery = z.infer<typeof RequestListQuerySchema>;

export const CreateTaskDraftInputSchema = z.object({
  requestId: idField.optional(),
  projectId: idField,
  title: z.string().min(3).max(200),
  description: z.string().max(4000).optional(),
  priority: PrioritySchema.default('normal'),
  assigneeId: z.string().nullable().optional(),
  dueDate: z.string().nullable().optional(),
  estimatedHours: z.number().min(0).max(10000).nullable().optional(),
  source: z.enum(['human', 'agent', 'system']).default('human'),
});
export type CreateTaskDraftInput = z.infer<typeof CreateTaskDraftInputSchema>;

export const UpdateTaskInputSchema = z.object({
  title: z.string().min(3).max(200).optional(),
  description: z.string().max(4000).nullable().optional(),
  priority: PrioritySchema.optional(),
  assigneeId: z.string().nullable().optional(),
  dueDate: z.string().nullable().optional(),
  estimatedHours: z.number().min(0).max(10000).nullable().optional(),
  /** Optimistic concurrency: the version the client last saw. */
  expectedVersion: z.number().int().optional(),
});
export type UpdateTaskInput = z.infer<typeof UpdateTaskInputSchema>;

export const AddChecklistItemInputSchema = z.object({ title: z.string().trim().min(1).max(240) });
const UpdateChecklistItemFieldsSchema = z.object({
  title: z.string().trim().min(1).max(240).optional(),
  isComplete: z.boolean().optional(),
});
export const UpdateChecklistItemInputSchema = UpdateChecklistItemFieldsSchema.refine(
  (value) => value.title !== undefined || value.isComplete !== undefined,
  'Provide a title or completion state.',
);
export const AddTaskCommentInputSchema = z.object({ body: z.string().trim().min(1).max(4000) });
export const AddTaskLinkInputSchema = z.object({
  label: z.string().trim().min(1).max(160),
  url: z.string().url().max(2000).refine((value) => /^https?:\/\//i.test(value), 'Link must use HTTPS or HTTP.'),
  kind: z.enum(['brief', 'reference', 'delivery', 'other']).default('reference'),
});
export const LogTaskTimeInputSchema = z.object({
  hours: z.number().gt(0).max(24),
  description: z.string().trim().max(500).optional(),
  loggedOn: z.string().date().optional(),
});
export const AddTaskDependencyInputSchema = z.object({ dependsOnTaskId: idField });
export const ClientReviewDecisionInputSchema = z.object({
  decision: z.enum(['approved', 'changes_requested']),
  reviewerName: z.string().trim().min(1).max(120),
  reviewerEmail: z.string().email().max(254).optional(),
  note: z.string().trim().max(2000).optional(),
}).superRefine((value, ctx) => {
  if (value.decision === 'changes_requested' && !value.note) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['note'], message: 'Add a note describing the requested changes.' });
  }
});

export const TaskOperationInputSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('add_checklist'), ...AddChecklistItemInputSchema.shape }),
  z.object({ operation: z.literal('update_checklist'), itemId: idField, ...UpdateChecklistItemFieldsSchema.shape }),
  z.object({ operation: z.literal('add_comment'), ...AddTaskCommentInputSchema.shape }),
  z.object({ operation: z.literal('add_link'), ...AddTaskLinkInputSchema.shape }),
  z.object({ operation: z.literal('log_time'), ...LogTaskTimeInputSchema.shape }),
  z.object({ operation: z.literal('add_dependency'), ...AddTaskDependencyInputSchema.shape }),
  z.object({ operation: z.literal('remove_dependency'), ...AddTaskDependencyInputSchema.shape }),
  z.object({ operation: z.literal('request_client_review') }),
]).superRefine((value, ctx) => {
  if (value.operation === 'update_checklist' && value.title === undefined && value.isComplete === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['isComplete'], message: 'Provide a title or completion state.' });
  }
});

export const TransitionTaskInputSchema = z.object({
  to: TaskStatusSchema,
  note: z.string().max(2000).optional(),
});
export type TransitionTaskInput = z.infer<typeof TransitionTaskInputSchema>;

export const DecideApprovalInputSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  note: z.string().max(2000).optional(),
});
export type DecideApprovalInput = z.infer<typeof DecideApprovalInputSchema>;

export const AnalyzeRequestInputSchema = z.object({
  requestId: idField.optional(),
});
export type AnalyzeRequestInput = z.infer<typeof AnalyzeRequestInputSchema>;

export const IngestEmailInputSchema = z.object({
  /** Idempotency: reusing a messageId returns the existing request. */
  messageId: z.string().min(1),
  from: z.string().min(3),
  fromName: z.string().optional(),
  subject: z.string().min(1).max(300),
  body: z.string().min(1).max(20_000),
  receivedAt: z.string().optional(),
  autoCreateDraft: z.boolean().default(true),
});
export type IngestEmailInput = z.infer<typeof IngestEmailInputSchema>;

export const SimulateEmailInputSchema = z.object({
  templateId: z.string().min(1),
  autoCreateDraft: z.boolean().default(true),
});
export type SimulateEmailInput = z.infer<typeof SimulateEmailInputSchema>;

export const CreateCredentialInputSchema = z.object({
  name: z.string().min(2).max(80),
  scopes: z.array(z.enum(['projects:read', 'requests:read', 'requests:write', 'tasks:read', 'tasks:write'])).min(1),
});
export type CreateCredentialInput = z.infer<typeof CreateCredentialInputSchema>;

export const WorkflowRunListQuerySchema = z.object({
  status: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(25),
});
export type WorkflowRunListQuery = z.infer<typeof WorkflowRunListQuerySchema>;

export const TriggerTypeSchema = WorkflowTriggerSchema;

/** Flatten zod issues into a compact, user-presentable map. */
export function formatIssues(error: z.ZodError): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = issue.path.join('.') || '_root';
    (out[key] ??= []).push(issue.message);
  }
  return out;
}
