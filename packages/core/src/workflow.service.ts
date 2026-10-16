import type { FlowPilotDb } from '@flowpilot/database';
import type { WorkflowRun, WorkflowStep, WorkflowTrigger } from '@flowpilot/domain';
import { newId, nowIso } from '@flowpilot/shared';

/**
 * What a caller supplies to record a step. `finishedAt` is derived from `status` when omitted,
 * so callers cannot accidentally record a "succeeded" step that never finished.
 */
export interface WorkflowStepInput {
  key: string;
  label: string;
  status: WorkflowStep['status'];
  startedAt?: string;
  finishedAt?: string | null;
  detail?: Record<string, unknown> | null;
  error?: string | null;
}

/**
 * Workflow run recorder, scoped to one organization.
 *
 * A "run" is one pass through the pipeline for one request. Steps are flushed as they finish, so
 * a run that dies half-way still shows which step failed instead of an empty spinner.
 */
export class WorkflowService {
  constructor(
    private readonly db: FlowPilotDb,
    private readonly orgId: string,
  ) {}

  async start(input: {
    trigger: WorkflowTrigger;
    requestId?: string | null;
    taskId?: string | null;
    steps?: WorkflowStep[];
  }): Promise<WorkflowRun> {
    return this.db.repos.workflowRuns.start({
      id: newId('workflowRun'),
      orgId: this.orgId,
      trigger: input.trigger,
      requestId: input.requestId ?? null,
      taskId: input.taskId ?? null,
      steps: input.steps ?? [],
    });
  }

  async step(run: WorkflowRun, step: WorkflowStepInput, runStatus?: 'running' | 'succeeded' | 'failed' | 'waiting_approval'): Promise<WorkflowRun> {
    const next: WorkflowStep = {
      key: step.key,
      label: step.label,
      status: step.status,
      startedAt: step.startedAt ?? nowIso(),
      finishedAt: step.finishedAt ?? (step.status === 'pending' || step.status === 'running' ? null : nowIso()),
      detail: step.detail ?? null,
      error: step.error ?? null,
    };
    // Replace-by-key so re-running a step never duplicates it in the timeline.
    const steps = [...run.steps.filter((s) => s.key !== next.key), next];
    return this.db.repos.workflowRuns.saveSteps(this.orgId, run.id, steps, runStatus ?? statusToRunStatus(step.status));
  }

  finish(run: WorkflowRun, status: 'succeeded' | 'failed' | 'waiting_approval', error?: string | null): Promise<WorkflowRun> {
    return this.db.repos.workflowRuns.saveSteps(this.orgId, run.id, run.steps, status, error ?? null);
  }

  list(filter: { status?: string; limit: number }): Promise<WorkflowRun[]> {
    return this.db.repos.workflowRuns.list(this.orgId, filter);
  }

  require(id: string): Promise<WorkflowRun> {
    return this.db.repos.workflowRuns.require(this.orgId, id);
  }
}

function statusToRunStatus(step: WorkflowStep['status']): 'running' | 'succeeded' | 'failed' | 'waiting_approval' {
  switch (step) {
    case 'succeeded':
    case 'skipped':
      return 'succeeded';
    case 'failed':
      return 'failed';
    case 'pending':
      return 'waiting_approval';
    default:
      return 'running';
  }
}
