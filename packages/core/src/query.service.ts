import type { FlowPilotDb } from '@flowpilot/database';
import type { Actor, AuditEvent, RequestRecord, Task, WorkflowRun } from '@flowpilot/domain';
import { assertCan } from './permissions.js';
import type { TaskOperationsService } from './task-operations.service.js';

/**
 * Read models for the dashboard.
 *
 * Kept out of the route handlers so the MCP server could reuse the exact same shapes later, and
 * out of the repositories so "what does the Overview page need" is one readable function instead
 * of six SQL fragments spread across UI files.
 */
export class QueryService {
  constructor(private readonly db: FlowPilotDb, private readonly taskOperations: TaskOperationsService) {}

  async overview(actor: Actor) {
    assertCan(actor, 'tasks:read');

    const today = new Date().toISOString().slice(0, 10);
    const weekStartDate = new Date(`${today}T00:00:00.000Z`);
    const mondayOffset = (weekStartDate.getUTCDay() + 6) % 7;
    weekStartDate.setUTCDate(weekStartDate.getUTCDate() - mondayOffset);
    const weekEndDate = new Date(weekStartDate);
    weekEndDate.setUTCDate(weekEndDate.getUTCDate() + 6);
    const weekStart = weekStartDate.toISOString().slice(0, 10);
    const weekEnd = weekEndDate.toISOString().slice(0, 10);

    const [taskCounts, requestCounts, runCounts, overdue, pendingApprovals, recentActivity, runs, projects, workload] =
      await Promise.all([
        this.db.repos.tasks.countsByStatus(actor.orgId),
        this.db.repos.requests.countsByStatus(actor.orgId),
        this.db.repos.workflowRuns.countsByStatus(actor.orgId),
        this.db.repos.tasks.overdueCount(actor.orgId, today),
        this.db.repos.tasks.list(actor.orgId, { status: ['pending_approval'], limit: 10 }),
        this.db.repos.audit.list(actor.orgId, { limit: 12 }),
        this.db.repos.workflowRuns.list(actor.orgId, { limit: 6 }),
        this.db.repos.projects.list(actor.orgId),
        this.db.repos.tasks.workloadByCapacity(actor.orgId, weekStart, weekEnd),
      ]);

    const completed = taskCounts['completed'] ?? 0;
    const open = Object.entries(taskCounts)
      .filter(([status]) => status !== 'completed' && status !== 'cancelled')
      .reduce((sum, [, n]) => sum + n, 0);

    return {
      metrics: {
        openTasks: open,
        completedTasks: completed,
        pendingApprovals: pendingApprovals.length,
        overdueTasks: overdue,
        newRequests: requestCounts['new'] ?? 0,
        analyzedRequests: requestCounts['analyzed'] ?? 0,
        runningWorkflows: runCounts['running'] ?? 0,
        failedWorkflows: runCounts['failed'] ?? 0,
        awaitingApprovalRuns: runCounts['waiting_approval'] ?? 0,
      },
      taskCounts,
      requestCounts,
      runCounts,
      recentActivity,
      recentRuns: runs,
      pendingApprovals,
      workload: workload.map((member) => ({
        ...member,
        utilizationPercent: member.weeklyCapacityHours > 0 ? Math.round((member.plannedHours / member.weeklyCapacityHours) * 100) : 0,
      })),
      workloadWeek: { start: weekStart, end: weekEnd },
      projects: projects.slice(0, 6).map((project) => ({ id: project.id, name: project.name, code: project.code, openTaskCount: project.openTaskCount ?? 0 })),
    };
  }

  async inbox(actor: Actor, filter: { status?: RequestRecord['status'][]; limit: number }): Promise<{
    requests: Array<RequestRecord & {
      draftTaskIds: string[];
      outboundActionIds: string[];
      clientName: string | null;
      projectName: string | null;
      projectCode: string | null;
    }>;
  }> {
    assertCan(actor, 'requests:read');

    const [requests, clients, projects] = await Promise.all([
      this.db.repos.requests.list(actor.orgId, filter),
      this.db.repos.clients.list(actor.orgId),
      this.db.repos.projects.list(actor.orgId),
    ]);
    const clientById = new Map(clients.map((c) => [c.id, c]));
    const projectById = new Map(projects.map((p) => [p.id, p]));

    const [tasks, outboundActions] = await Promise.all([
      this.db.repos.tasks.list(actor.orgId, { limit: 200 }),
      this.db.repos.outboundActions.list(actor.orgId, { limit: 200 }),
    ]);
    const tasksByRequest = new Map<string, string[]>();
    for (const task of tasks) {
      if (!task.requestId) continue;
      const list = tasksByRequest.get(task.requestId) ?? [];
      list.push(task.id);
      tasksByRequest.set(task.requestId, list);
    }
    const outboundActionsByRequest = new Map<string, string[]>();
    for (const action of outboundActions) {
      if (!action.requestId) continue;
      const list = outboundActionsByRequest.get(action.requestId) ?? [];
      list.push(action.id);
      outboundActionsByRequest.set(action.requestId, list);
    }

    return {
      requests: requests.map((request) => {
        const project = request.projectId ? projectById.get(request.projectId) : undefined;
        return {
          ...request,
          draftTaskIds: tasksByRequest.get(request.id) ?? [],
          outboundActionIds: outboundActionsByRequest.get(request.id) ?? [],
          clientName: request.clientId ? (clientById.get(request.clientId)?.name ?? null) : null,
          projectName: project?.name ?? null,
          projectCode: project?.code ?? null,
        };
      }),
    };
  }

  async taskBoard(actor: Actor, filter: { assigneeId?: string; projectId?: string } = {}) {
    assertCan(actor, 'tasks:read');

    const [tasks, projects, members] = await Promise.all([
      this.db.repos.tasks.list(actor.orgId, { limit: 200, ...filter }),
      this.db.repos.projects.list(actor.orgId),
      this.db.repos.users.listByOrg(actor.orgId),
    ]);

    const projectById = new Map(projects.map((p) => [p.id, p]));
    const memberById = new Map(members.map((m) => [m.id, m]));

    return {
      tasks: tasks.map((task) => ({
        ...task,
        projectName: projectById.get(task.projectId)?.name ?? 'Unknown project',
        projectCode: projectById.get(task.projectId)?.code ?? '',
        assigneeName: task.assigneeId ? (memberById.get(task.assigneeId)?.fullName ?? null) : null,
      })),
      projects: projects.map((p) => ({ id: p.id, name: p.name, code: p.code, status: p.status })),
      members: members.map((m) => ({ id: m.id, name: m.fullName, role: m.role, title: m.title })),
    };
  }

  async taskDetail(actor: Actor, taskId: string) {
    assertCan(actor, 'tasks:read');

    const task = await this.db.repos.tasks.require(actor.orgId, taskId);
    const [project, approvals, audit, request, operations] = await Promise.all([
      this.db.repos.projects.findById(actor.orgId, task.projectId),
      this.db.repos.approvals.listByTask(actor.orgId, taskId),
      this.db.repos.audit.list(actor.orgId, { limit: 50, entityType: 'task', entityId: taskId }),
      task.requestId ? this.db.repos.requests.findById(actor.orgId, task.requestId) : Promise.resolve(null),
      this.taskOperations.detail(actor, taskId),
    ]);
    const assignee = task.assigneeId ? await this.db.repos.users.findById(task.assigneeId) : null;

    return { task, project, approvals, audit, request, assignee, operations };
  }

  async activity(actor: Actor, limit: number): Promise<{
    runs: WorkflowRun[];
    audit: AuditEvent[];
    approvals: Awaited<ReturnType<FlowPilotDb['repos']['approvals']['listByOrg']>>;
    agentCalls: AuditEvent[];
    errors: WorkflowRun[];
  }> {
    assertCan(actor, 'tasks:read');

    const [runs, audit] = await Promise.all([
      this.db.repos.workflowRuns.list(actor.orgId, { limit }),
      this.db.repos.audit.list(actor.orgId, { limit }),
    ]);

    return {
      runs,
      audit,
      approvals: await this.db.repos.approvals.listByOrg(actor.orgId, limit),
      agentCalls: audit.filter((event) => event.actorKind === 'agent'),
      errors: runs.filter((run) => run.status === 'failed'),
    };
  }

  async projects(actor: Actor) {
    assertCan(actor, 'projects:read');
    const [projects, clients] = await Promise.all([
      this.db.repos.projects.list(actor.orgId),
      this.db.repos.clients.list(actor.orgId),
    ]);
    const clientById = new Map(clients.map((c) => [c.id, c]));
    return projects.map((project) => ({
      ...project,
      clientName: clientById.get(project.clientId)?.name ?? 'Unknown client',
    }));
  }

  async clients(actor: Actor) {
    assertCan(actor, 'projects:read');
    return this.db.repos.clients.list(actor.orgId);
  }

  async members(actor: Actor) {
    assertCan(actor, 'projects:read');
    return this.db.repos.users.listByOrg(actor.orgId);
  }

  async workflowsFor(actor: Actor, id: string): Promise<WorkflowRun> {
    assertCan(actor, 'requests:read');
    return this.db.repos.workflowRuns.require(actor.orgId, id);
  }

  async tasksFor(actor: Actor, filter: Parameters<typeof this.db.repos.tasks.list>[1]): Promise<Task[]> {
    assertCan(actor, 'tasks:read');
    return this.db.repos.tasks.list(actor.orgId, filter);
  }
}
