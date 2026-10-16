import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Actor, Task, TaskStatus } from '@flowpilot/domain';
import { allowedTransitions, TaskStatusSchema } from '@flowpilot/domain';
import { AppError, isAppError, toMessage, ValidationError } from '@flowpilot/shared';
import type { CoreServices } from '@flowpilot/core';

/**
 * MCP tool surface.
 *
 * Rules that hold for every tool below:
 *  1. The organization comes from the credential, never from the arguments. There is no
 *     `orgId` parameter anywhere in this file, on purpose 鈥?an agent cannot ask for another
 *     tenant's data because it cannot express that request.
 *  2. Tools call core services. No SQL, no repositories, no state-machine shortcuts.
 *  3. Errors are returned as JSON-RPC errors with our stable `code`, never as a stack trace.
 *  4. Nothing here can approve work. `request_task_approval` only asks a human to look.
 */

const limitArg = z.number().int().min(1).max(100).default(20).describe('Maximum number of rows to return.');

export function registerTools(server: McpServer, deps: { core: CoreServices; actor: Actor }): void {
  const { core, actor } = deps;

  /** Wraps a tool body so every failure becomes a typed JSON-RPC error. */
  const guard = async (fn: () => Promise<unknown>): Promise<{ content: Array<{ type: 'text'; text: string }>; structuredContent?: Record<string, unknown> }> => {
    try {
      const data = await fn();
      return {
        content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
        structuredContent: { ok: true, data } as Record<string, unknown>,
      };
    } catch (error) {
      const code = isAppError(error) ? error.jsonRpcCode : -32603;
      const message = toMessage(error);
      const details = error instanceof AppError ? error.details : undefined;
      throw Object.assign(new Error(message), { code, data: details });
    }
  };

  /* ------------------------------------------------------------------ reads */

  server.registerTool(
    'list_projects',
    {
      title: 'List projects',
      description:
        'List the projects in the connected organization with their client and open task count. Use this to ground a request in a real project before creating work.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () =>
      guard(async () => {
        const projects = await core.queries.projects(actor);
        return {
          projects: projects.map((p) => ({
            id: p.id,
            code: p.code,
            name: p.name,
            client: p.clientName,
            status: p.status,
            dueDate: p.dueDate,
            openTaskCount: p.openTaskCount ?? 0,
          })),
        };
      }),
  );

  server.registerTool(
    'list_requests',
    {
      title: 'List inbound requests',
      description:
        'List client requests in the AI Inbox. Filter by status (default: everything). Start here when asked to find pending work 鈥?pass status="new" to get unprocessed requests.',
      inputSchema: {
        status: z
          .array(z.enum(['new', 'analyzed', 'drafted', 'approved', 'rejected', 'failed']))
          .optional()
          .describe('Statuses to include. Omit for all.'),
        limit: limitArg,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ status, limit }: { status?: string[]; limit?: number }) =>
      guard(async () => {
        const { requests } = await core.queries.inbox(actor, { status: status as never, limit: limit ?? 20 });
        return {
          requests: requests.map((r) => ({
            id: r.id,
            status: r.status,
            subject: r.rawSubject,
            from: r.rawFrom,
            client: r.clientName,
            project: r.projectName,
            projectCode: r.projectCode,
            analyzed: r.analysis !== null,
            confidence: r.analysis?.confidence ?? null,
            needsHumanReview: r.analysis?.needsHumanReview ?? null,
            existingDraftIds: r.draftTaskIds,
            receivedAt: r.rawReceivedAt,
          })),
        };
      }),
  );

  server.registerTool(
    'list_tasks',
    {
      title: 'List tasks',
      description: 'List tasks in the organization, optionally filtered by status, project or assignee.',
      inputSchema: {
        status: z.array(TaskStatusSchema).optional().describe('Statuses to include.'),
        projectId: z.string().optional(),
        assigneeId: z.string().optional(),
        limit: limitArg,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ status, projectId, assigneeId, limit }: { status?: TaskStatus[]; projectId?: string; assigneeId?: string; limit?: number }) =>
      guard(async () => {
        const tasks = await core.tasks.list(actor, {
          status,
          projectId,
          assigneeId,
          limit: limit ?? 20,
        });
        return { tasks: tasks.map(projectTask) };
      }),
  );

  server.registerTool(
    'get_task',
    {
      title: 'Get a task',
      description:
        'Fetch one task with its description, assignee, linked request and the transitions it currently allows. Always call this before transitioning a task.',
      inputSchema: { taskId: z.string().min(1) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ taskId }: { taskId: string }) =>
      guard(async () => {
        const detail = await core.queries.taskDetail(actor, taskId);
        const actions = await core.tasks.availableActions(actor, detail.task);
        return {
          ...projectTask(detail.task),
          description: detail.task.description,
          projectName: detail.project?.name ?? null,
          projectCode: detail.project?.code ?? null,
          assigneeName: detail.assignee?.fullName ?? null,
          requestId: detail.task.requestId,
          requestSubject: detail.request?.rawSubject ?? null,
          approvals: detail.approvals.map((a) => ({ decision: a.decision, by: a.decidedByLabel, at: a.createdAt, note: a.note })),
          allowedTransitions: actions,
        };
      }),
  );

  server.registerTool(
    'get_workflow_status',
    {
      title: 'Get workflow status',
      description:
        'Workflow run history for the organization, including per-step detail and errors. Optionally filter to one run.',
      inputSchema: {
        runId: z.string().optional().describe('A single run to inspect.'),
        limit: limitArg,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ runId, limit }: { runId?: string; limit?: number }) =>
      guard(async () => {
        const run = runId ? await core.queries.workflowsFor(actor, runId) : null;
        const runs = run ? [run] : await core.workflowsFor(actor).list({ limit: limit ?? 10 });
        return {
          runs: runs.map((r) => ({
            id: r.id,
            trigger: r.trigger,
            status: r.status,
            requestId: r.requestId,
            taskId: r.taskId,
            error: r.error,
            startedAt: r.startedAt,
            finishedAt: r.finishedAt,
            steps: r.steps.map((s) => ({ key: s.key, label: s.label, status: s.status, detail: s.detail, error: s.error })),
          })),
        };
      }),
  );

  /* ----------------------------------------------------------------- writes */

  server.registerTool(
    'analyze_request',
    {
      title: 'Analyze a request',
      description:
        'Run AI analysis over an inbound request to extract client, project, title, description, priority, due date and a suggested assignee, with per-field confidence. Omit requestId to analyze everything still unprocessed.',
      inputSchema: { requestId: z.string().optional() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ requestId }: { requestId?: string }) =>
      guard(async () => {
        const result = await core.requests.analyze(actor, core.ai, { requestId });
        return {
          analyzed: result.analyzed.length,
          errors: result.errors,
          requests: result.analyzed.map((r) => ({
            id: r.id,
            subject: r.rawSubject,
            analysis: r.analysis,
          })),
        };
      }),
  );

  server.registerTool(
    'create_task_draft',
    {
      title: 'Create a task draft',
      description:
        'Create a task draft. Either pass requestId to build the draft from that request鈥檚 analysis, or pass an explicit projectId/title. Drafts are never approved automatically 鈥?a human still has to release them.',
      inputSchema: {
        requestId: z.string().optional().describe('Build the draft from this request鈥檚 AI analysis.'),
        projectId: z.string().optional().describe('Required when no requestId is given.'),
        title: z.string().min(3).max(200).optional(),
        description: z.string().max(4000).optional(),
        priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
        assigneeId: z.string().nullable().optional(),
        dueDate: z.string().nullable().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args: {
      requestId?: string;
      projectId?: string;
      title?: string;
      description?: string;
      priority?: 'low' | 'normal' | 'high' | 'urgent';
      assigneeId?: string | null;
      dueDate?: string | null;
    }) =>
      guard(async () => {

        const task = args.requestId
          ? await core.tasks.createDraftFromRequest(actor, args.requestId)
          : await core.tasks.createDraft(actor, {
              projectId: requireField(args.projectId, 'projectId'),
              title: requireField(args.title, 'title'),
              description: args.description,
              priority: args.priority ?? 'normal',
              assigneeId: args.assigneeId ?? null,
              dueDate: args.dueDate ?? null,
              source: 'agent',
            });

        return {
          task: projectTask(task),
          requiresHumanConfirmation: true,
          nextStep: 'Ask a project manager to review and approve this draft in the FlowPilot dashboard.',
        };
      }),
  );

  server.registerTool(
    'request_task_approval',
    {
      title: 'Ask for human approval',
      description:
        'Move a draft to "pending approval" so a project manager can review it. This does NOT approve anything 鈥?only a human can do that.',
      inputSchema: { taskId: z.string().min(1), note: z.string().max(2000).optional() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ taskId, note }: { taskId: string; note?: string }) =>
      guard(async () => {
        const result = await core.tasks.submitForApproval(actor, taskId, note);
        return {
          task: projectTask(result.task),
          requiresHumanConfirmation: true,
          message: 'Queued for human approval. A project manager must approve it in the dashboard.',
        };
      }),
  );
}

/* -------------------------------------------------------------------------- */

function requireField<T>(value: T | undefined, name: string): T {
  if (value === undefined || value === '') {
    throw new ValidationError(`"${name}" is required when no requestId is provided.`, { field: name });
  }
  return value;
}

/** The projection of a task that leaves the system 鈥?deliberately smaller than the row. */
function projectTask(task: Task) {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    priority: task.priority,
    projectId: task.projectId,
    assigneeId: task.assigneeId,
    dueDate: task.dueDate,
    source: task.source,
    requestId: task.requestId,
    version: task.version,
    updatedAt: task.updatedAt,
    allowedTransitions: allowedTransitions(task.status).map((t) => t.to),
  };
}
