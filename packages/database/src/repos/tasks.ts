import type { Queryable } from '../client.js';
import { pgTextArray } from '../sql.js';
import { ConflictError, NotFoundError, OrganizationMismatchError } from '@flowpilot/shared';
import { mapTask } from '../mappers.js';
import type { Priority, Task, TaskSource, TaskStatus } from '@flowpilot/domain';

type Row = Record<string, unknown>;

export interface CreateTaskInput {
  id: string;
  orgId: string;
  projectId: string;
  requestId?: string | null;
  title: string;
  description?: string | null;
  priority: Priority;
  status: TaskStatus;
  assigneeId?: string | null;
  dueDate?: string | null;
  estimatedHours?: number | null;
  source: TaskSource;
  createdBy: string;
}

export interface TaskFilters {
  status?: TaskStatus[];
  assigneeId?: string;
  projectId?: string;
  requestId?: string;
  limit: number;
}

export class TaskRepo {
  constructor(private readonly db: Queryable) {}

  async create(input: CreateTaskInput): Promise<Task> {
    const row = await this.db.one<Row>(
      `insert into tasks (id, org_id, project_id, request_id, title, description, status, priority,
                          assignee_id, due_date, estimated_hours, source, created_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       returning *`,
      [
        input.id,
        input.orgId,
        input.projectId,
        input.requestId ?? null,
        input.title,
        input.description ?? null,
        input.status,
        input.priority,
        input.assigneeId ?? null,
        input.dueDate ?? null,
        input.estimatedHours ?? null,
        input.source,
        input.createdBy,
      ],
    );
    return mapTask(row!);
  }

  async list(orgId: string, filters: TaskFilters): Promise<Task[]> {
    const statuses = pgTextArray(filters.status);
    const rows = await this.db.query<Row>(
      `select * from tasks
        where org_id = $1
          and (cardinality($2::text[]) = 0 or status = any($2::text[]))
          and ($3::text is null or assignee_id = $3)
          and ($4::text is null or project_id = $4)
          and ($5::text is null or request_id = $5)
        order by
          case priority when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end,
          created_at desc
        limit $6`,
      [orgId, statuses, filters.assigneeId ?? null, filters.projectId ?? null, filters.requestId ?? null, filters.limit],
    );
    return rows.map(mapTask);
  }

  async findById(orgId: string, id: string): Promise<Task | null> {
    const row = await this.db.one<Row>('select * from tasks where id = $1 and org_id = $2', [id, orgId]);
    return row ? mapTask(row) : null;
  }

  async require(orgId: string, id: string): Promise<Task> {
    const task = await this.findById(orgId, id);
    if (task) return task;
    const anyRow = await this.db.one<Row>('select org_id from tasks where id = $1', [id]);
    if (anyRow) throw new OrganizationMismatchError('Task', id);
    throw new NotFoundError('Task', id);
  }

  /**
   * Optimistic concurrency: the update only lands if the row is still at `expectedVersion`.
   * Two PMs editing the same draft cannot silently clobber each other.
   */
  async update(
    orgId: string,
    id: string,
    patch: {
      title?: string;
      description?: string | null;
      priority?: Priority;
      assigneeId?: string | null;
      dueDate?: string | null;
      estimatedHours?: number | null;
    },
    expectedVersion?: number,
  ): Promise<Task> {
    const sets: string[] = [];
    const params: unknown[] = [id, orgId];

    const push = (column: string, value: unknown) => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };

    if (patch.title !== undefined) push('title', patch.title);
    if (patch.description !== undefined) push('description', patch.description);
    if (patch.priority !== undefined) push('priority', patch.priority);
    if (patch.assigneeId !== undefined) push('assignee_id', patch.assigneeId);
    if (patch.dueDate !== undefined) push('due_date', patch.dueDate);
    if (patch.estimatedHours !== undefined) push('estimated_hours', patch.estimatedHours);

    if (sets.length === 0) return this.require(orgId, id);

    let versionClause = '';
    if (expectedVersion !== undefined) {
      params.push(expectedVersion);
      versionClause = `and version = $${params.length}`;
    }

    const row = await this.db.one<Row>(
      `update tasks set ${sets.join(', ')}, updated_at = now(), version = version + 1
        where id = $1 and org_id = $2 ${versionClause}
        returning *`,
      params,
    );
    if (row) return mapTask(row);

    // Distinguish "gone / other org" from "someone else edited it first".
    const current = await this.findById(orgId, id);
    if (!current) {
      await this.assertSameOrg(orgId, id);
      throw new NotFoundError('Task', id);
    }
    throw new ConflictError('This task was modified by someone else. Reload and try again.', {
      expectedVersion,
      currentVersion: current.version,
    });
  }

  async setStatus(orgId: string, id: string, status: TaskStatus): Promise<Task> {
    const row = await this.db.one<Row>(
      `update tasks set status = $3, updated_at = now(), version = version + 1
        where id = $1 and org_id = $2 returning *`,
      [id, orgId, status],
    );
    if (row) return mapTask(row);
    // Same distinction as `require`: "exists but belongs to someone else" is a different bug
    // from "does not exist", and reports should be able to tell them apart.
    await this.assertSameOrg(orgId, id);
    throw new NotFoundError('Task', id);
  }

  /**
   * Distinguishes "this row belongs to another organization" from "this row does not exist".
   * The org of the row is deliberately not compared: existence is all the caller needs, and
   * reporting the owner would leak a tenant id.
   */
  private async assertSameOrg(_orgId: string, id: string): Promise<void> {
    const anyRow = await this.db.one<Row>('select id from tasks where id = $1', [id]);
    if (anyRow) throw new OrganizationMismatchError('Task', id);
  }

  async countsByStatus(orgId: string): Promise<Record<string, number>> {
    const rows = await this.db.query<Row>('select status, count(*)::int as n from tasks where org_id = $1 group by status', [
      orgId,
    ]);
    return Object.fromEntries(rows.map((r) => [String(r['status']), Number(r['n'])]));
  }

  async countByAssignee(orgId: string): Promise<Record<string, number>> {
    const rows = await this.db.query<Row>(
      `select assignee_id, count(*)::int as n from tasks
        where org_id = $1 and assignee_id is not null and status not in ('completed','cancelled')
        group by assignee_id`,
      [orgId],
    );
    return Object.fromEntries(rows.map((r) => [String(r['assignee_id']), Number(r['n'])]));
  }

  async workloadByCapacity(orgId: string, weekStart: string, weekEnd: string): Promise<Array<{
    userId: string; name: string; role: string; weeklyCapacityHours: number; openTasks: number;
    plannedHours: number; unscheduledHours: number; estimatedOpenHours: number;
  }>> {
    const rows = await this.db.query<Row>(
      `select m.user_id, u.full_name, m.role, m.weekly_capacity_hours,
              count(t.id) filter (where t.id is not null and t.status not in ('completed','cancelled'))::int as open_tasks,
              coalesce(sum(t.estimated_hours) filter (where t.status not in ('completed','cancelled') and t.due_date between $2 and $3),0) as planned_hours,
              coalesce(sum(t.estimated_hours) filter (where t.status not in ('completed','cancelled') and t.due_date is null),0) as unscheduled_hours,
              coalesce(sum(t.estimated_hours) filter (where t.status not in ('completed','cancelled')),0) as estimated_open_hours
         from memberships m join users u on u.id=m.user_id
         left join tasks t on t.org_id=m.org_id and t.assignee_id=m.user_id
        where m.org_id=$1
        group by m.user_id, u.full_name, m.role, m.weekly_capacity_hours
        order by u.full_name`,
      [orgId, weekStart, weekEnd],
    );
    return rows.map((row) => ({
      userId: String(row['user_id']), name: String(row['full_name']), role: String(row['role']),
      weeklyCapacityHours: Number(row['weekly_capacity_hours']), openTasks: Number(row['open_tasks']),
      plannedHours: Number(row['planned_hours']), unscheduledHours: Number(row['unscheduled_hours']),
      estimatedOpenHours: Number(row['estimated_open_hours']),
    }));
  }

  async overdueCount(orgId: string, referenceDate: string): Promise<number> {
    const row = await this.db.one<Row>(
      `select count(*)::int as n from tasks
        where org_id = $1 and due_date is not null and due_date < $2 and status not in ('completed','cancelled')`,
      [orgId, referenceDate],
    );
    return Number(row?.['n'] ?? 0);
  }

  async findByRequest(orgId: string, requestId: string): Promise<Task[]> {
    const rows = await this.db.query<Row>('select * from tasks where org_id = $1 and request_id = $2 order by created_at', [
      orgId,
      requestId,
    ]);
    return rows.map(mapTask);
  }
}
