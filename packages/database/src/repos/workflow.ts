import type { Queryable } from '../client.js';
import { NotFoundError, OrganizationMismatchError } from '@flowpilot/shared';
import { mapApproval, mapWorkflowRun } from '../mappers.js';
import type { Approval, ApprovalDecision, WorkflowRun, WorkflowRunStatus, WorkflowStep, WorkflowTrigger } from '@flowpilot/domain';

type Row = Record<string, unknown>;

export class WorkflowRunRepo {
  constructor(private readonly db: Queryable) {}

  async start(input: {
    id: string;
    orgId: string;
    trigger: WorkflowTrigger;
    requestId?: string | null;
    taskId?: string | null;
    steps: WorkflowStep[];
  }): Promise<WorkflowRun> {
    const row = await this.db.one<Row>(
      `insert into workflow_runs (id, org_id, request_id, task_id, trigger, status, steps)
       values ($1,$2,$3,$4,$5,'running',$6::jsonb) returning *`,
      [input.id, input.orgId, input.requestId ?? null, input.taskId ?? null, input.trigger, JSON.stringify(input.steps)],
    );
    return mapWorkflowRun(row!);
  }

  async saveSteps(orgId: string, id: string, steps: WorkflowStep[], status?: WorkflowRunStatus, error?: string | null): Promise<WorkflowRun> {
    const finished = status === 'succeeded' || status === 'failed';
    const row = await this.db.one<Row>(
      `update workflow_runs
          set steps = $3::jsonb,
              status = coalesce($4, status),
              error = coalesce($5, error),
              finished_at = case when $6 then now() else finished_at end
        where id = $1 and org_id = $2 returning *`,
      [id, orgId, JSON.stringify(steps), status ?? null, error ?? null, finished],
    );
    if (!row) throw new NotFoundError('Workflow run', id);
    return mapWorkflowRun(row);
  }

  async list(orgId: string, filter: { status?: string; limit: number }): Promise<WorkflowRun[]> {
    const rows = await this.db.query<Row>(
      `select * from workflow_runs
        where org_id = $1 and ($2::text is null or status = $2)
        order by started_at desc
        limit $3`,
      [orgId, filter.status ?? null, filter.limit],
    );
    return rows.map(mapWorkflowRun);
  }

  async findById(orgId: string, id: string): Promise<WorkflowRun | null> {
    const row = await this.db.one<Row>('select * from workflow_runs where id = $1 and org_id = $2', [id, orgId]);
    return row ? mapWorkflowRun(row) : null;
  }

  async require(orgId: string, id: string): Promise<WorkflowRun> {
    const run = await this.findById(orgId, id);
    if (run) return run;
    const anyRow = await this.db.one<Row>('select org_id from workflow_runs where id = $1', [id]);
    if (anyRow) throw new OrganizationMismatchError('Workflow run', id);
    throw new NotFoundError('Workflow run', id);
  }

  async countsByStatus(orgId: string): Promise<Record<string, number>> {
    const rows = await this.db.query<Row>(
      'select status, count(*)::int as n from workflow_runs where org_id = $1 group by status',
      [orgId],
    );
    return Object.fromEntries(rows.map((r) => [String(r['status']), Number(r['n'])]));
  }
}

export class ApprovalRepo {
  constructor(private readonly db: Queryable) {}

  async create(input: {
    id: string;
    orgId: string;
    taskId: string;
    requestId?: string | null;
    decision: ApprovalDecision;
    note?: string | null;
    decidedBy: string;
    decidedByLabel: string;
  }): Promise<Approval> {
    const row = await this.db.one<Row>(
      `insert into approvals (id, org_id, task_id, request_id, decision, note, decided_by, decided_by_label)
       values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
      [input.id, input.orgId, input.taskId, input.requestId ?? null, input.decision, input.note ?? null, input.decidedBy, input.decidedByLabel],
    );
    return mapApproval(row!);
  }

  async listByOrg(orgId: string, limit: number): Promise<Approval[]> {
    const rows = await this.db.query<Row>(
      'select * from approvals where org_id = $1 order by created_at desc limit $2',
      [orgId, limit],
    );
    return rows.map(mapApproval);
  }

  async listByTask(orgId: string, taskId: string): Promise<Approval[]> {
    const rows = await this.db.query<Row>(
      'select * from approvals where org_id = $1 and task_id = $2 order by created_at',
      [orgId, taskId],
    );
    return rows.map(mapApproval);
  }
}
