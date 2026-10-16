'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  CheckCircle2,
  ChevronRight,
  Copy,
  ExternalLink,
  History,
  Inbox as InboxIcon,
  Link2,
  Save,
  Plus,
  Timer,
  Trash2,
  User,
  X,
  XCircle,
} from 'lucide-react';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  ErrorNote,
  Input,
  Label,
  Select,
  Skeleton,
  Textarea,
} from '@/components/ui/primitives';
import { Button } from '@/components/ui/button';
import { Badge, PriorityBadge, TaskStatusBadge, statusLabel } from '@/components/ui/badge';
import { ApiError, apiFetch } from '@/lib/api-client';
import { boardColumns, type Priority, type TaskStatus } from '@flowpilot/domain';
import type { CoreServices } from '@flowpilot/core';

type BoardData = Awaited<ReturnType<CoreServices['queries']['taskBoard']>>;
type TaskDetailData = Awaited<ReturnType<CoreServices['queries']['taskDetail']>>;

interface TaskDetail extends TaskDetailData {
  availableActions: Array<{ to: TaskStatus; effect: string; action: string }>;
  canApprove: boolean;
  canContribute: boolean;
  canManage: boolean;
  blockedActions: Array<{ to: TaskStatus; reason: string }>;
}

type TaskOperations = TaskDetailData['operations'];

interface FormState {
  title: string;
  description: string;
  priority: Priority;
  assigneeId: string;
  dueDate: string;
  estimatedHours: string;
}

const EMPTY_FORM: FormState = { title: '', description: '', priority: 'normal', assigneeId: '', dueDate: '', estimatedHours: '' };

const PRIORITY_OPTIONS: Priority[] = ['low', 'normal', 'high', 'urgent'];

function fmt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function fmtDate(value: string | null): string {
  if (!value) return 'No due date';
  const date = new Date(value.length <= 10 ? `${value}T00:00:00` : value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.explain : error instanceof Error ? error.message : fallback;
}

function toForm(task: TaskDetailData['task']): FormState {
  return {
    title: task.title,
    description: task.description ?? '',
    priority: task.priority,
    assigneeId: task.assigneeId ?? '',
    dueDate: task.dueDate ?? '',
    estimatedHours: task.estimatedHours === null ? '' : String(task.estimatedHours),
  };
}

function isDirty(form: FormState, task: TaskDetailData['task']): boolean {
  return (
    form.title !== task.title ||
    (form.description === '' ? null : form.description) !== task.description ||
    form.priority !== task.priority ||
    (form.assigneeId === '' ? null : form.assigneeId) !== task.assigneeId ||
    (form.dueDate === '' ? null : form.dueDate) !== task.dueDate
    || (form.estimatedHours === '' ? null : Number(form.estimatedHours)) !== task.estimatedHours
  );
}

export function TasksClient({
  tasks,
  projects,
  members,
  initialTaskId,
}: {
  tasks: BoardData['tasks'];
  projects: BoardData['projects'];
  members: BoardData['members'];
  initialTaskId?: string;
}) {
  const router = useRouter();

  const [projectFilter, setProjectFilter] = useState('');
  const [assigneeFilter, setAssigneeFilter] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(initialTaskId ?? null);

  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);

  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    setSelectedId(initialTaskId ?? null);
  }, [initialTaskId]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      setForm(EMPTY_FORM);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    setDetailError(null);
    void (async () => {
      try {
        const data = await apiFetch<TaskDetail>(`/api/tasks/${selectedId}`);
        if (cancelled) return;
        setDetail(data);
        setForm(toForm(data.task));
      } catch (error) {
        if (cancelled) return;
        setDetailError(errorText(error, 'The task could not be loaded.'));
      } finally {
        if (!cancelled) setDetailLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedId, reloadKey]);

  const visible = tasks.filter((task) => {
    if (projectFilter && task.projectId !== projectFilter) return false;
    if (assigneeFilter === '__unassigned' && task.assigneeId !== null) return false;
    if (assigneeFilter && assigneeFilter !== '__unassigned' && task.assigneeId !== assigneeFilter) return false;
    return true;
  });

  const hiddenCount = tasks.length - visible.length;
  const offBoardCount = tasks.filter(
    (task) => task.status === 'rejected' || task.status === 'cancelled',
  ).length;

  const runMutation = async (key: string, work: () => Promise<string>) => {
    setBusy(key);
    setActionError(null);
    setNotice(null);
    try {
      const message = await work();
      setNotice(message);
      setReloadKey((value) => value + 1);
      router.refresh();
    } catch (error) {
      setActionError(errorText(error, 'That change was not saved.'));
      setReloadKey((value) => value + 1);
    } finally {
      setBusy(null);
    }
  };

  const save = () => {
    if (!detail) return;
    const taskId = detail.task.id;
    const version = detail.task.version;
    void runMutation('save', async () => {
      await apiFetch<{ task: TaskDetailData['task'] }>(`/api/tasks/${taskId}`, {
        method: 'PATCH',
        json: {
          title: form.title.trim(),
          description: form.description === '' ? null : form.description,
          priority: form.priority,
          assigneeId: form.assigneeId === '' ? null : form.assigneeId,
          dueDate: form.dueDate === '' ? null : form.dueDate,
          estimatedHours: form.estimatedHours === '' ? null : Number(form.estimatedHours),
          expectedVersion: version,
        },
      });
      return `Saved "${form.title.trim()}".`;
    });
  };

  const transition = (to: TaskStatus, effect: string) => {
    if (!detail) return;
    const taskId = detail.task.id;
    void runMutation(`to:${to}`, async () => {
      await apiFetch<{ task: TaskDetailData['task'] }>(`/api/tasks/${taskId}/transition`, {
        method: 'POST',
        json: { to },
      });
      return `${effect} — the task is now ${statusLabel(to)}.`;
    });
  };

  const decide = (decision: 'approved' | 'rejected') => {
    if (!detail) return;
    const taskId = detail.task.id;
    void runMutation(`decide:${decision}`, async () => {
      await apiFetch<{ task: TaskDetailData['task'] }>(`/api/tasks/${taskId}/approve`, {
        method: 'POST',
        json: { decision },
      });
      return decision === 'approved' ? 'Approved and released to the team.' : 'Rejected.';
    });
  };

  const dirty = detail ? isDirty(form, detail.task) : false;
  const titleValid = form.title.trim().length >= 3;
  const estimateValid = form.estimatedHours === '' || (Number.isFinite(Number(form.estimatedHours)) && Number(form.estimatedHours) >= 0 && Number(form.estimatedHours) <= 10000);
  const approvalPending = Boolean(detail?.canApprove && detail.task.status === 'pending_approval');
  const renderedActions = detail?.availableActions
    .filter((option) => !detail.blockedActions.some((blocked) => blocked.to === option.to))
    .filter((option) => !approvalPending || !['ready', 'rejected'].includes(option.to)) ?? [];

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-lg font-semibold tracking-tight text-ink-900">Tasks</h1>
        <p className="mt-0.5 text-xs text-ink-500">
          One board per organization. Only the transitions the state machine allows for this actor are rendered.
        </p>
      </header>

      <Card>
        <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="min-w-0 flex-1 space-y-1.5">
            <Label>Project</Label>
            <Select
              id="filter-project"
              aria-label="Filter by project"
              value={projectFilter}
              onChange={(event) => setProjectFilter(event.target.value)}
            >
              <option value="">All projects</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.code} — {project.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="min-w-0 flex-1 space-y-1.5">
            <Label>Assignee</Label>
            <Select
              id="filter-assignee"
              aria-label="Filter by assignee"
              value={assigneeFilter}
              onChange={(event) => setAssigneeFilter(event.target.value)}
            >
              <option value="">Everyone</option>
              <option value="__unassigned">Unassigned</option>
              {members.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.name}
                </option>
              ))}
            </Select>
          </div>
          <p className="text-[11px] text-ink-500 sm:pb-2">
            {visible.length} of {tasks.length} tasks
            {hiddenCount > 0 ? ` · ${hiddenCount} filtered out` : ''}
          </p>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_400px] lg:items-start">
        <div className="min-w-0">
          <div className="flex flex-col gap-3 md:flex-row md:overflow-x-auto md:pb-2">
            {boardColumns.map((status) => {
              const columnTasks = visible.filter((task) => task.status === status);
              return (
                <section key={status} className="w-full shrink-0 md:w-72">
                  <div className="flex items-center justify-between gap-2 border-b border-line px-1 pb-1.5">
                    <h2 className="text-xs font-semibold text-ink-700">{statusLabel(status)}</h2>
                    <span className="text-[11px] text-ink-500 tabular-nums">{columnTasks.length}</span>
                  </div>
                  <div className="mt-2 space-y-2">
                    {columnTasks.length === 0 ? (
                      <div className="rounded-lg border border-dashed border-line px-2 py-4 text-center text-[11px] text-ink-500">
                        No tasks
                      </div>
                    ) : (
                      columnTasks.map((task) => (
                        <button
                          key={task.id}
                          type="button"
                          onClick={() => {
                            setSelectedId(task.id);
                            setActionError(null);
                            setNotice(null);
                          }}
                          aria-current={task.id === selectedId}
                          className={`w-full rounded-lg border px-2.5 py-2 text-left transition-colors ${
                            task.id === selectedId
                              ? 'border-accent bg-accent-soft'
                              : 'border-line bg-white hover:border-slate-300'
                          }`}
                        >
                          <span className="line-clamp-2 text-[13px] font-medium text-ink-900">{task.title}</span>
                          <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
                            <PriorityBadge priority={task.priority} />
                            {task.projectCode ? <span className="font-mono text-[10px] text-ink-500">{task.projectCode}</span> : null}
                          </span>
                          <span className="mt-1 flex items-center gap-1 text-[11px] text-ink-500">
                            <User className="h-3 w-3 shrink-0" aria-hidden />
                            <span className="truncate">{task.assigneeName ?? 'Unassigned'}</span>
                          </span>
                          <span className="mt-0.5 block text-[11px] text-ink-500">Due {fmtDate(task.dueDate)}</span>
                        </button>
                      ))
                    )}
                  </div>
                </section>
              );
            })}
          </div>
          {offBoardCount > 0 ? (
            <p className="mt-2 text-[11px] text-ink-500">
              {offBoardCount} rejected or cancelled task(s) are off-board and not shown here.
            </p>
          ) : null}
        </div>

        <aside className="min-w-0 space-y-4 lg:sticky lg:top-4 lg:max-h-[calc(100dvh-5rem)] lg:overflow-y-auto">
          {actionError ? <ErrorNote message={actionError} /> : null}
          {notice ? (
            <div role="status" className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
              {notice}
            </div>
          ) : null}

          {!selectedId ? (
            <Card>
              <CardContent className="py-8">
                <EmptyState
                  title="No task selected"
                  description="Pick a card to edit its fields, read its audit trail, and move it forward."
                />
              </CardContent>
            </Card>
          ) : detailLoading && !detail ? (
            <Card>
              <CardContent className="space-y-2 py-4">
                <Skeleton className="h-9 w-full" />
                <Skeleton className="h-20 w-full" />
                <Skeleton className="h-9 w-full" />
              </CardContent>
            </Card>
          ) : detailError ? (
            <ErrorNote message={detailError} />
          ) : detail ? (
            <Card>
              <CardHeader>
                <div className="min-w-0">
                  <CardTitle className="truncate">{detail.task.title}</CardTitle>
                  <p className="mt-0.5 font-mono text-[11px] text-ink-500">
                    {detail.project?.code ?? '—'} · v{detail.task.version} · {detail.task.source}
                  </p>
                </div>
                <button
                  type="button"
                  aria-label="Close task"
                  onClick={() => setSelectedId(null)}
                  className="shrink-0 rounded-md p-1 text-ink-500 hover:bg-slate-100"
                >
                  <X className="h-4 w-4" aria-hidden />
                </button>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex flex-wrap items-center gap-1.5">
                  <TaskStatusBadge status={detail.task.status} />
                  <PriorityBadge priority={detail.task.priority} />
                  {detail.request ? <Badge tone="info">from request</Badge> : null}
                </div>

                {detail.task.description ? (
                  <p className="line-clamp-3 text-sm leading-relaxed text-ink-600">{detail.task.description}</p>
                ) : null}

                <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-2">
                  <div className="min-w-0 space-y-1.5">
                    <Label>Assignee</Label>
                    <Select
                      id="edit-assignee"
                      aria-label="Task assignee"
                      value={form.assigneeId}
                      onChange={(event) => setForm((current) => ({ ...current, assigneeId: event.target.value }))}
                    >
                      <option value="">Unassigned</option>
                      {members.map((member) => (
                        <option key={member.id} value={member.id}>
                          {member.name} — {member.role}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <Button
                    size="sm"
                    disabled={!dirty || !titleValid || !estimateValid}
                    loading={busy === 'save'}
                    onClick={save}
                  >
                    <Save className="h-4 w-4" aria-hidden />
                    Save
                  </Button>
                </div>

                <section className="space-y-2 rounded-lg bg-slate-50 p-3" aria-labelledby="next-step-heading">
                  <h3 id="next-step-heading" className="text-xs font-semibold text-ink-700">{approvalPending ? 'Review task' : 'Next step'}</h3>
                  {!approvalPending && renderedActions.length === 0 ? (
                    <p className="text-[11px] text-ink-500">
                      No transition is available to you from {statusLabel(detail.task.status)}.
                    </p>
                  ) : !approvalPending ? (
                    <div className="flex flex-wrap gap-2">
                      {renderedActions.map((option) => (
                        <Button
                          key={`${option.action}-${option.to}`}
                          size="sm"
                          variant={option.to === 'cancelled' ? 'danger' : 'secondary'}
                          loading={busy === `to:${option.to}`}
                          onClick={() => transition(option.to, option.effect)}
                        >
                          {option.effect}
                        </Button>
                      ))}
                    </div>
                  ) : null}
                  {detail.blockedActions.map((blocked) => (
                    <p key={blocked.to} className="mt-1 text-[11px] text-amber-800">{statusLabel(blocked.to)} is blocked: {blocked.reason}</p>
                  ))}

                  {approvalPending && renderedActions.length > 0 ? (
                    <details className="border-t border-line pt-2">
                      <summary className="cursor-pointer text-xs font-medium text-ink-600">Other actions</summary>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {renderedActions.map((option) => (
                          <Button
                            key={`${option.action}-${option.to}`}
                            size="sm"
                            variant={option.to === 'cancelled' ? 'danger' : 'secondary'}
                            loading={busy === `to:${option.to}`}
                            onClick={() => transition(option.to, option.effect)}
                          >
                            {option.effect}
                          </Button>
                        ))}
                      </div>
                    </details>
                  ) : null}

                  {detail.canApprove ? (
                    <div className={`${approvalPending ? '' : 'border-t border-line pt-2 '}space-y-2`}>
                      {!detail.task.assigneeId ? <p className="text-[11px] text-ink-500">Assign and save this task before approval.</p> : null}
                      <div className="flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          variant="success"
                          disabled={!detail.task.assigneeId}
                          loading={busy === 'decide:approved'}
                          onClick={() => decide('approved')}
                        >
                          <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
                          Approve
                        </Button>
                        <Button
                          size="sm"
                          variant="danger"
                          loading={busy === 'decide:rejected'}
                          onClick={() => decide('rejected')}
                        >
                          <XCircle className="h-3.5 w-3.5" aria-hidden />
                          Reject
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </section>

                <details className="rounded-lg border border-line px-3 py-2.5">
                  <summary className="cursor-pointer text-sm font-medium text-ink-700">Edit task details</summary>
                  <div className="mt-3 space-y-2.5">
                    <div className="space-y-1.5">
                      <Label>Title</Label>
                      <Input
                        id="edit-title"
                        aria-label="Task title"
                        value={form.title}
                        onChange={(event) => setForm((current) => ({ ...current, title: event.target.value }))}
                      />
                      {!titleValid ? <p className="text-[11px] text-red-600">A title needs at least 3 characters.</p> : null}
                    </div>
                    <div className="space-y-1.5">
                      <Label>Description</Label>
                      <Textarea
                        id="edit-description"
                        aria-label="Task description"
                        rows={3}
                        value={form.description}
                        onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))}
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div className="space-y-1.5">
                        <Label>Priority</Label>
                        <Select
                          id="edit-priority"
                          aria-label="Task priority"
                          value={form.priority}
                          onChange={(event) => setForm((current) => ({ ...current, priority: event.target.value as Priority }))}
                        >
                          {PRIORITY_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
                        </Select>
                      </div>
                      <div className="space-y-1.5">
                        <Label>Due date</Label>
                        <Input
                          id="edit-due"
                          aria-label="Due date"
                          type="date"
                          value={form.dueDate}
                          onChange={(event) => setForm((current) => ({ ...current, dueDate: event.target.value }))}
                        />
                      </div>
                    </div>
                    <div className="space-y-1.5">
                      <Label>Estimate (hours)</Label>
                      <Input
                        id="edit-estimate"
                        aria-label="Estimated hours"
                        type="number"
                        min="0"
                        max="10000"
                        step="0.25"
                        placeholder="Not estimated"
                        value={form.estimatedHours}
                        onChange={(event) => setForm((current) => ({ ...current, estimatedHours: event.target.value }))}
                      />
                    </div>
                  </div>
                </details>

                {detail.request ? (
                  <details className="rounded-lg border border-line px-3 py-2.5">
                    <summary className="cursor-pointer text-sm font-medium text-ink-700">Original request</summary>
                    <div className="mt-2 flex items-start gap-1.5 rounded-lg bg-slate-50 px-2.5 py-2 text-[12px] text-ink-700">
                      <InboxIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-500" aria-hidden />
                      <span className="min-w-0">{detail.request.rawSubject}</span>
                    </div>
                    <p className="mt-1.5 text-[11px] text-ink-500">{detail.request.rawFrom} · {fmt(detail.request.rawReceivedAt)}</p>
                  </details>
                ) : null}

                <details className="rounded-lg border border-line px-3 py-2.5">
                  <summary className="cursor-pointer text-sm font-medium text-ink-700">More task tools</summary>
                  <div className="mt-3">
                    <TaskOperationsPanel
                      taskId={detail.task.id}
                      taskStatus={detail.task.status}
                      operations={detail.operations}
                      tasks={tasks}
                      canContribute={detail.canContribute}
                      canManage={detail.canManage}
                      onMutated={() => setReloadKey((value) => value + 1)}
                    />
                  </div>
                </details>

                <details className="rounded-lg border border-line px-3 py-2.5">
                  <summary className="cursor-pointer text-sm font-medium text-ink-700">History</summary>
                  <div className="mt-3 space-y-4">
                    <div className="space-y-1.5">
                      <p className="flex items-center gap-1.5 text-xs font-medium text-ink-500">
                        <History className="h-3.5 w-3.5" aria-hidden /> Approvals
                      </p>
                      {detail.approvals.length === 0 ? (
                        <p className="text-[11px] text-ink-500">No decisions recorded yet.</p>
                      ) : (
                        <ul className="space-y-1">
                          {detail.approvals.map((approval) => (
                            <li key={approval.id} className="flex items-start gap-1.5 text-[11px]">
                              <ChevronRight className="mt-0.5 h-3 w-3 shrink-0 text-ink-500" aria-hidden />
                              <span className="min-w-0 text-ink-700">
                                <span className="font-medium">{approval.decision}</span> by {approval.decidedByLabel}
                                {approval.note ? ` — “${approval.note}”` : ''} · {fmt(approval.createdAt)}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                    <div className="space-y-1.5 border-t border-line pt-3">
                      <p className="flex items-center gap-1.5 text-xs font-medium text-ink-500">
                        <Link2 className="h-3.5 w-3.5" aria-hidden /> Audit trail
                      </p>
                      {detail.audit.length === 0 ? (
                        <p className="text-[11px] text-ink-500">Nothing logged for this task yet.</p>
                      ) : (
                        <ul className="max-h-52 space-y-1 overflow-y-auto pr-1">
                          {detail.audit.map((event) => (
                            <li key={event.id} className="flex items-start gap-1.5 text-[11px]">
                              <ChevronRight className="mt-0.5 h-3 w-3 shrink-0 text-ink-500" aria-hidden />
                              <span className="min-w-0 text-ink-700">
                                <span className="font-medium">{event.action}</span> · {event.actorLabel} ({event.actorKind}) · {fmt(event.createdAt)}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>
                </details>
              </CardContent>
            </Card>
          ) : null}
        </aside>
      </div>
    </div>
  );
}

function TaskOperationsPanel({
  taskId,
  taskStatus,
  operations,
  tasks,
  canContribute,
  canManage,
  onMutated,
}: {
  taskId: string;
  taskStatus: TaskStatus;
  operations: TaskOperations;
  tasks: Array<Pick<BoardData['tasks'][number], 'id' | 'title' | 'status'>>;
  canContribute: boolean;
  canManage: boolean;
  onMutated: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [checklistTitle, setChecklistTitle] = useState('');
  const [comment, setComment] = useState('');
  const [linkLabel, setLinkLabel] = useState('');
  const [linkUrl, setLinkUrl] = useState('');
  const [linkKind, setLinkKind] = useState<'brief' | 'reference' | 'delivery' | 'other'>('delivery');
  const [hours, setHours] = useState('0.5');
  const [timeDescription, setTimeDescription] = useState('');
  const [dependencyId, setDependencyId] = useState('');
  const [reviewUrl, setReviewUrl] = useState('');

  const run = async (payload: Record<string, unknown>, key: string, successMessage: string) => {
    setBusy(key); setError(null); setNotice(null);
    try {
      await apiFetch(`/api/tasks/${taskId}/operations`, { method: 'POST', json: payload });
      setNotice(successMessage);
      onMutated();
    } catch (cause) {
      setError(errorText(cause, 'That update could not be saved.'));
    } finally {
      setBusy(null);
    }
  };

  const addChecklist = async () => {
    if (!checklistTitle.trim()) return;
    await run({ operation: 'add_checklist', title: checklistTitle.trim() }, 'checklist', 'Checklist item added.');
    setChecklistTitle('');
  };

  const addComment = async () => {
    if (!comment.trim()) return;
    await run({ operation: 'add_comment', body: comment.trim() }, 'comment', 'Comment added.');
    setComment('');
  };

  const addLink = async () => {
    if (!linkLabel.trim() || !linkUrl.trim()) return;
    await run({ operation: 'add_link', label: linkLabel.trim(), url: linkUrl.trim(), kind: linkKind }, 'link', 'Link added.');
    setLinkLabel(''); setLinkUrl('');
  };

  const logTime = async () => {
    const parsedHours = Number(hours);
    if (!Number.isFinite(parsedHours) || parsedHours <= 0 || parsedHours > 24) return;
    await run({ operation: 'log_time', hours: parsedHours, ...(timeDescription.trim() ? { description: timeDescription.trim() } : {}) }, 'time', 'Time entry saved.');
    setTimeDescription('');
  };

  const addDependency = async () => {
    if (!dependencyId) return;
    await run({ operation: 'add_dependency', dependsOnTaskId: dependencyId }, 'dependency', 'Prerequisite added.');
    setDependencyId('');
  };

  const requestReview = async () => {
    setBusy('review'); setError(null); setNotice(null);
    try {
      const result = await apiFetch<{ url: string }>(`/api/tasks/${taskId}/operations`, {
        method: 'POST', json: { operation: 'request_client_review' },
      });
      setReviewUrl(result.url);
      setNotice('Client review link created. Copy it and send it to the client.');
      onMutated();
    } catch (cause) {
      setError(errorText(cause, 'The review link could not be created.'));
    } finally {
      setBusy(null);
    }
  };

  const copyReviewLink = async () => {
    try { await navigator.clipboard.writeText(reviewUrl); setNotice('Review link copied.'); }
    catch { setNotice('Select and copy the review link from the field.'); }
  };

  const candidates = tasks.filter((task) => task.id !== taskId && !operations.dependencies.some((dep) => dep.dependsOnTaskId === task.id));
  const checklistDone = operations.checklist.filter((item) => item.isComplete).length;

  return (
    <section className="space-y-4 rounded-xl border border-line bg-slate-50/70 p-3">
      <div>
        <h3 className="text-xs font-semibold text-ink-800">Delivery coordination</h3>
        <p className="mt-0.5 text-[10px] text-ink-500">Checklist, feedback, handoff links and logged time stay with this task.</p>
      </div>
      {error ? <ErrorNote message={error} /> : null}
      {notice ? <p role="status" className="rounded-md bg-white px-2 py-1.5 text-[11px] text-emerald-800">{notice}</p> : null}

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[11px] font-medium text-ink-700">Checklist <span className="text-ink-500">{checklistDone}/{operations.checklist.length}</span></p>
        </div>
        {operations.checklist.map((item) => (
          <label key={item.id} className="flex items-start gap-2 text-[11px] text-ink-700">
            <input
              type="checkbox"
              className="mt-0.5 accent-blue-600"
              checked={item.isComplete}
              disabled={!canContribute || busy !== null}
              onChange={(event) => void run({ operation: 'update_checklist', itemId: item.id, isComplete: event.target.checked }, `item:${item.id}`, 'Checklist updated.')}
            />
            <span className={item.isComplete ? 'text-ink-500 line-through' : ''}>{item.title}</span>
          </label>
        ))}
        {canContribute ? (
          <div className="flex gap-1.5">
            <Input aria-label="New checklist item" value={checklistTitle} onChange={(event) => setChecklistTitle(event.target.value)} placeholder="Add a QA or handoff step" />
            <Button size="sm" variant="secondary" disabled={!checklistTitle.trim() || busy !== null} loading={busy === 'checklist'} onClick={() => void addChecklist()} aria-label="Add checklist item"><Plus className="h-4 w-4" aria-hidden /></Button>
          </div>
        ) : null}
      </div>

      <div className="space-y-2 border-t border-line pt-3">
        <p className="text-[11px] font-medium text-ink-700">Prerequisites</p>
        {operations.dependencies.length === 0 ? <p className="text-[10px] text-ink-500">No blocking dependencies.</p> : (
          <ul className="space-y-1.5">
            {operations.dependencies.map((dependency) => (
              <li key={dependency.id} className="flex items-start justify-between gap-2 text-[10px]">
                <span className="text-ink-700">{dependency.dependsOnTitle} · {statusLabel(dependency.dependsOnStatus)}
                  {dependency.dependsOnStatus !== 'completed' ? <span className="ml-1 font-medium text-amber-700">blocks start</span> : null}
                </span>
                {canManage ? <button type="button" className="text-ink-500 hover:text-red-600" aria-label={`Remove prerequisite ${dependency.dependsOnTitle}`} onClick={() => void run({ operation: 'remove_dependency', dependsOnTaskId: dependency.dependsOnTaskId }, `remove:${dependency.id}`, 'Prerequisite removed.')}><Trash2 className="h-3 w-3" aria-hidden /></button> : null}
              </li>
            ))}
          </ul>
        )}
        {canManage ? (
          <div className="flex gap-1.5">
            <Select aria-label="Choose prerequisite task" value={dependencyId} onChange={(event) => setDependencyId(event.target.value)}>
              <option value="">Select prerequisite…</option>
              {candidates.map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}
            </Select>
            <Button size="sm" variant="secondary" disabled={!dependencyId || busy !== null} loading={busy === 'dependency'} onClick={() => void addDependency()}>Add</Button>
          </div>
        ) : null}
        {operations.blockedBy.length > 0 ? <p className="text-[10px] font-medium text-amber-800">Start is blocked until all prerequisites are completed.</p> : null}
      </div>

      <div className="space-y-2 border-t border-line pt-3">
        <p className="text-[11px] font-medium text-ink-700">Delivery links</p>
        {operations.links.length === 0 ? <p className="text-[10px] text-ink-500">Add the brief, references or final delivery URL.</p> : (
          <ul className="space-y-1.5">
            {operations.links.map((link) => (
              <li key={link.id} className="flex min-w-0 items-center justify-between gap-2 text-[10px]">
                <a href={link.url} target="_blank" rel="noopener noreferrer" className="flex min-w-0 items-center gap-1 truncate text-accent hover:underline">
                  <ExternalLink className="h-3 w-3 shrink-0" aria-hidden />{link.label}
                </a>
                <span className="shrink-0 uppercase text-ink-500">{link.kind}</span>
              </li>
            ))}
          </ul>
        )}
        {canContribute ? (
          <div className="space-y-1.5">
            <Input aria-label="Link label" value={linkLabel} onChange={(event) => setLinkLabel(event.target.value)} placeholder="Label, e.g. Final cut v3" />
            <Input aria-label="Link URL" type="url" value={linkUrl} onChange={(event) => setLinkUrl(event.target.value)} placeholder="https://…" />
            <div className="flex gap-1.5">
              <Select aria-label="Link type" value={linkKind} onChange={(event) => setLinkKind(event.target.value as typeof linkKind)}>
                <option value="delivery">Delivery</option><option value="brief">Brief</option><option value="reference">Reference</option><option value="other">Other</option>
              </Select>
              <Button size="sm" variant="secondary" disabled={!linkLabel.trim() || !linkUrl.trim() || busy !== null} loading={busy === 'link'} onClick={() => void addLink()}>Add link</Button>
            </div>
          </div>
        ) : null}
      </div>

      <div className="space-y-2 border-t border-line pt-3">
        <p className="flex items-center gap-1.5 text-[11px] font-medium text-ink-700"><Timer className="h-3.5 w-3.5" aria-hidden /> Time log · {operations.loggedHours.toFixed(2)}h</p>
        {operations.timeEntries.slice(0, 5).map((entry) => (
          <p key={entry.id} className="text-[10px] text-ink-600">{entry.userLabel} · {entry.hours.toFixed(2)}h · {entry.loggedOn}{entry.description ? ` · ${entry.description}` : ''}</p>
        ))}
        {canContribute ? (
          <div className="space-y-1.5">
            <div className="flex gap-1.5">
              <Input aria-label="Hours worked" type="number" min="0.01" max="24" step="0.25" value={hours} onChange={(event) => setHours(event.target.value)} />
              <Input aria-label="Work note" value={timeDescription} onChange={(event) => setTimeDescription(event.target.value)} placeholder="What did you work on?" />
              <Button size="sm" variant="secondary" disabled={Number(hours) <= 0 || busy !== null} loading={busy === 'time'} onClick={() => void logTime()}>Log</Button>
            </div>
          </div>
        ) : null}
      </div>

      <div className="space-y-2 border-t border-line pt-3">
        <p className="text-[11px] font-medium text-ink-700">Client sign-off</p>
        {operations.clientReview ? (
          <div className="rounded-md bg-white px-2 py-1.5 text-[10px] text-ink-700">
            <p className="font-medium">{operations.clientReview.status.replace('_', ' ')}</p>
            {operations.clientReview.reviewerName ? <p>{operations.clientReview.reviewerName}{operations.clientReview.reviewerEmail ? ` · ${operations.clientReview.reviewerEmail}` : ''}</p> : null}
            {operations.clientReview.note ? <p className="mt-1 whitespace-pre-wrap">{operations.clientReview.note}</p> : null}
            <p className="mt-1 text-ink-500">{operations.clientReview.respondedAt ? `Responded ${fmt(operations.clientReview.respondedAt)}` : `Expires ${fmt(operations.clientReview.expiresAt)}`}</p>
          </div>
        ) : <p className="text-[10px] text-ink-500">Internal task approval and client acceptance are tracked separately.</p>}
        {canManage && taskStatus === 'in_review' && (!operations.clientReview || ['changes_requested', 'expired'].includes(operations.clientReview.status)) ? (
          <Button size="sm" variant="secondary" disabled={busy !== null} loading={busy === 'review'} onClick={() => void requestReview()}>Create client review link</Button>
        ) : null}
        {reviewUrl ? <div className="flex gap-1.5"><Input aria-label="Client review link" readOnly value={reviewUrl} /><Button size="sm" variant="secondary" onClick={() => void copyReviewLink()} aria-label="Copy client review link"><Copy className="h-4 w-4" aria-hidden /></Button></div> : null}
        {canManage && taskStatus === 'in_review' && !operations.links.some((link) => link.kind === 'delivery') ? <p className="text-[10px] text-amber-800">Add a Delivery link before creating a client review.</p> : null}
      </div>

      <div className="space-y-2 border-t border-line pt-3">
        <p className="text-[11px] font-medium text-ink-700">Team comments</p>
        {canContribute ? (
          <div className="space-y-1.5">
            <Textarea aria-label="Task comment" rows={2} value={comment} onChange={(event) => setComment(event.target.value)} placeholder="Leave a production note or feedback" />
            <Button size="sm" variant="secondary" disabled={!comment.trim() || busy !== null} loading={busy === 'comment'} onClick={() => void addComment()}>Add comment</Button>
          </div>
        ) : null}
        {operations.comments.length === 0 ? <p className="text-[10px] text-ink-500">No comments yet.</p> : (
          <ul className="max-h-40 space-y-2 overflow-y-auto">
            {operations.comments.slice(0, 10).map((entry) => (
              <li key={entry.id} className="rounded-md bg-white px-2 py-1.5 text-[10px]">
                <p className="font-medium text-ink-700">{entry.authorLabel} <span className="font-normal text-ink-500">· {fmt(entry.createdAt)}</span></p>
                <p className="mt-0.5 whitespace-pre-wrap text-ink-700">{entry.body}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
