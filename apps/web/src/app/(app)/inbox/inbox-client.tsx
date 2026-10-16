'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, ChevronRight, FileText, Link2, Mail, Sparkles, Wand2 } from 'lucide-react';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  ErrorNote,
  Label,
  Select,
  Skeleton,
} from '@/components/ui/primitives';
import { Button } from '@/components/ui/button';
import { Badge, PriorityBadge, RequestStatusBadge } from '@/components/ui/badge';
import { ApiError, apiFetch } from '@/lib/api-client';
import type { CoreServices } from '@flowpilot/core';

type InboxRequests = Awaited<ReturnType<CoreServices['queries']['inbox']>>['requests'];
type ProjectList = Awaited<ReturnType<CoreServices['queries']['projects']>>;
type InboxRequest = InboxRequests[number];

interface EmailTemplate {
  id: string;
  label: string;
  from: string;
  subject: string;
  preview: string;
}

interface SimulateResponse {
  request: { id: string };
  deduplicated: boolean;
  draft: { id: string } | null;
  draftError: string | null;
  templates: EmailTemplate[];
}

interface Notice {
  tone: 'success' | 'info';
  text: string;
}

function fmt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function fmtDate(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value.length <= 10 ? `${value}T00:00:00` : value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function percent(value: number): string {
  return `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%`;
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.explain : error instanceof Error ? error.message : fallback;
}

export function InboxClient({ requests, projects }: { requests: InboxRequests; projects: ProjectList }) {
  const router = useRouter();

  const [selectedId, setSelectedId] = useState<string | null>(requests[0]?.id ?? null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  const [templates, setTemplates] = useState<EmailTemplate[] | null>(null);
  const [templatesError, setTemplatesError] = useState<string | null>(null);
  const [templateId, setTemplateId] = useState<string>('');
  const [autoCreateDraft, setAutoCreateDraft] = useState(true);

  const [linkChoice, setLinkChoice] = useState<{ requestId: string; projectId: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await apiFetch<{ templates: EmailTemplate[] }>('/api/integrations/mock-email');
        if (!cancelled) setTemplates(data.templates);
      } catch (error) {
        if (!cancelled) setTemplatesError(errorText(error, 'Email templates could not be loaded.'));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const selected = requests.find((request) => request.id === selectedId) ?? null;
  const analysis = selected?.analysis ?? null;
  const activeTemplateId = templateId || templates?.[0]?.id || '';
  const projectChoice = linkChoice && linkChoice.requestId === selected?.id ? linkChoice.projectId : '';

  const afterMutation = (next: Notice) => {
    setActionError(null);
    setNotice(next);
    router.refresh();
  };

  const analyze = async () => {
    if (!selected) return;
    setBusy('analyze');
    setActionError(null);
    setNotice(null);
    try {
      await apiFetch<{ request?: InboxRequest; errors: unknown[] }>(`/api/requests/${selected.id}`, {
        method: 'POST',
        json: {},
      });
      afterMutation({
        tone: 'success',
        text: `Analysis written for "${selected.rawSubject}". Fields the rule engine was unsure about are flagged below.`,
      });
    } catch (error) {
      setActionError(errorText(error, 'The analysis did not run.'));
    } finally {
      setBusy(null);
    }
  };

  const createDraft = async () => {
    if (!selected) return;
    setBusy('draft');
    setActionError(null);
    setNotice(null);
    try {
      const result = await apiFetch<{ task: { id: string; title: string } }>(`/api/requests/${selected.id}/draft`, {
        method: 'POST',
        json: {},
      });
      afterMutation({ tone: 'success', text: `Draft created: "${result.task.title}". Review it on the Tasks board.` });
    } catch (error) {
      setActionError(errorText(error, 'The draft was not created.'));
    } finally {
      setBusy(null);
    }
  };

  const linkProject = async () => {
    if (!selected || !projectChoice) return;
    setBusy('link');
    setActionError(null);
    setNotice(null);
    try {
      await apiFetch<{ request: { id: string } }>(`/api/requests/${selected.id}`, {
        method: 'PATCH',
        json: { projectId: projectChoice },
      });
      const linked = projects.find((project) => project.id === projectChoice);
      afterMutation({ tone: 'success', text: `Linked to ${linked?.name ?? 'the selected project'}.` });
    } catch (error) {
      setActionError(errorText(error, 'The project link was not saved.'));
    } finally {
      setBusy(null);
    }
  };

  const simulate = async () => {
    if (!activeTemplateId) return;
    setBusy('simulate');
    setActionError(null);
    setNotice(null);
    try {
      const result = await apiFetch<SimulateResponse>('/api/integrations/mock-email', {
        method: 'POST',
        json: { templateId: activeTemplateId, autoCreateDraft },
      });
      if (result.templates.length > 0) setTemplates(result.templates);
      setSelectedId(result.request.id);

      const draftNote = result.draft ? ' A task draft was created automatically.' : '';
      const dedupeNote = result.deduplicated ? ' The message id was a duplicate, so the existing request was reused.' : '';
      afterMutation({
        tone: result.draftError ? 'info' : 'success',
        text: `Simulated email ingested.${dedupeNote}${draftNote}${result.draftError ? ` ${result.draftError}` : ''}`,
      });
    } catch (error) {
      setActionError(errorText(error, 'The simulated email did not run.'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-ink-900">AI Inbox</h1>
        <p className="mt-1 text-sm text-ink-500">Review a request, check the extraction, then create a task.</p>
      </header>

      <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
        <div className="w-full shrink-0 space-y-4 lg:w-96">
          <details className="group rounded-xl border border-line bg-white">
            <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-3 text-sm font-semibold text-ink-800 [&::-webkit-details-marker]:hidden">
              <Mail className="h-4 w-4 text-ink-500" aria-hidden />
              <span className="flex-1">Send a sample email</span>
              <ChevronRight className="h-4 w-4 text-ink-400 transition-transform group-open:rotate-90" aria-hidden />
            </summary>
            <div className="space-y-3 border-t border-line p-3">
              {templatesError ? <ErrorNote message={templatesError} /> : null}
              <div className="space-y-1.5">
                <Label>Template</Label>
                {templates === null ? (
                  <Skeleton className="h-9 w-full" />
                ) : (
                  <Select
                    id="template"
                    aria-label="Email template"
                    value={activeTemplateId}
                    onChange={(event) => setTemplateId(event.target.value)}
                  >
                    {templates.map((template) => (
                      <option key={template.id} value={template.id}>
                        {template.label}
                      </option>
                    ))}
                  </Select>
                )}
                {activeTemplateId ? (
                  <p className="text-[11px] text-ink-500">
                    {templates?.find((template) => template.id === activeTemplateId)?.preview ?? ''}
                  </p>
                ) : null}
              </div>
              <label className="flex items-center gap-2 text-xs text-ink-700">
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 rounded border-line"
                  checked={autoCreateDraft}
                  onChange={(event) => setAutoCreateDraft(event.target.checked)}
                />
                Auto-create the task draft
              </label>
              <Button
                className="w-full"
                loading={busy === 'simulate'}
                disabled={!activeTemplateId}
                onClick={simulate}
              >
                <Sparkles className="h-4 w-4" aria-hidden />
                Send sample
              </Button>
              <p className="text-[11px] text-ink-500">Demo input only. No email is sent.</p>
            </div>
          </details>

          <Card>
            <CardHeader>
              <CardTitle>Requests</CardTitle>
              <span className="text-xs text-ink-500 tabular-nums">{requests.length}</span>
            </CardHeader>
            <CardContent className="space-y-1.5">
              {requests.length === 0 ? (
                <EmptyState
                  title="Inbox is empty"
                  description="Send a sample email to create the first request."
                />
              ) : (
                <ul className="max-h-[28rem] space-y-1 overflow-y-auto pr-1">
                  {requests.map((request) => {
                    const isSelected = request.id === selectedId;
                    return (
                      <li key={request.id}>
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedId(request.id);
                            setActionError(null);
                            setNotice(null);
                          }}
                          aria-current={isSelected}
                          className={`w-full rounded-lg border px-2.5 py-2 text-left transition-colors ${
                            isSelected
                              ? 'border-accent bg-accent-soft'
                              : 'border-transparent hover:bg-slate-50'
                          }`}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink-900">
                              {request.rawSubject}
                            </span>
                            <RequestStatusBadge status={request.status} />
                          </div>
                          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-ink-500">
                            <span className="min-w-0 truncate">{request.rawFrom}</span>
                            {request.projectCode ? (
                              <span className="font-mono">{request.projectCode}</span>
                            ) : (
                              <span className="text-amber-700">no project</span>
                            )}
                            {request.draftTaskIds.length > 0 ? (
                              <Badge tone="info">{request.draftTaskIds.length} task(s)</Badge>
                            ) : null}
                            {request.analysis ? null : <Badge tone="warning">not analyzed</Badge>}
                          </div>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="min-w-0 flex-1 space-y-4">
          {actionError ? <ErrorNote message={actionError} /> : null}
          {notice ? (
            <div
              role="status"
              className={`rounded-lg border px-4 py-3 text-sm ${
                notice.tone === 'success'
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                  : 'border-amber-200 bg-amber-50 text-amber-800'
              }`}
            >
              {notice.text}
            </div>
          ) : null}

          {!selected ? (
            <Card>
              <CardContent className="space-y-2 py-8">
                {selectedId ? (
                  <>
                    <p className="text-center text-sm font-medium text-ink-700">Loading the selected request…</p>
                    <Skeleton className="h-24 w-full" />
                    <p className="text-center text-[11px] text-ink-500">
                      The server is re-reading the database so this panel shows stored state, not local guesses.
                    </p>
                  </>
                ) : (
                  <EmptyState
                    title="Select a request"
                      description="Choose a request to review it and create a task."
                    action={
                      <Button variant="secondary" onClick={simulate} loading={busy === 'simulate'} disabled={!activeTemplateId}>
                        Send a simulated email
                      </Button>
                    }
                  />
                )}
              </CardContent>
            </Card>
          ) : (
            <>
              <Card>
                <CardHeader>
                  <div className="min-w-0">
                    <CardTitle className="truncate">{selected.rawSubject}</CardTitle>
                    <p className="mt-0.5 truncate text-[11px] text-ink-500">
                      {selected.rawFrom} · received {fmt(selected.rawReceivedAt)}
                    </p>
                  </div>
                  <RequestStatusBadge status={selected.status} />
                </CardHeader>
                <CardContent className="space-y-3">
                  <div aria-label="Raw email body" className="max-h-60 overflow-y-auto whitespace-pre-wrap rounded-lg border border-line bg-slate-50 px-3 py-2.5 font-mono text-xs leading-relaxed text-ink-700">
                    {selected.rawBody}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button variant={analysis ? 'secondary' : 'primary'} loading={busy === 'analyze'} onClick={analyze}>
                      <Wand2 className="h-4 w-4" aria-hidden />
                      {analysis ? 'Re-analyze' : 'Analyze'}
                    </Button>
                    <Button variant={analysis ? 'primary' : 'secondary'} loading={busy === 'draft'} onClick={createDraft} disabled={!analysis}>
                      <FileText className="h-4 w-4" aria-hidden />
                      Create task draft
                    </Button>
                    <span className="self-center text-[11px] text-ink-500">Demo · rule-based extraction</span>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Extraction</CardTitle>
                  {analysis ? <Badge tone={analysis.needsHumanReview ? 'warning' : 'success'}>{percent(analysis.confidence)} confidence</Badge> : null}
                </CardHeader>
                <CardContent className="space-y-4">
                  {!analysis ? (
                    <EmptyState
                      title="Not analyzed yet"
                      description="Run the analyzer to extract a title, priority, due date and evidence."
                    />
                  ) : (
                    <>
                      {analysis.needsHumanReview ? (
                        <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                          Flagged for human review — check the fields below before creating the draft.
                        </div>
                      ) : null}

                      <div className="grid gap-3 sm:grid-cols-2">
                        <Field label="Suggested title" value={analysis.title} />
                        <div className="grid grid-cols-2 gap-3">
                          <Field label="Priority" value={<PriorityBadge priority={analysis.priority} />} />
                          <Field label="Due date" value={fmtDate(analysis.dueDate)} />
                        </div>
                        <Field label="Discipline" value={analysis.discipline} />
                        <Field
                          label="Client / project"
                          value={analysis.clientName ?? analysis.projectName ?? '—'}
                          hint={analysis.projectName ?? undefined}
                        />
                      </div>

                      <div>
                        <p className="text-xs font-medium text-ink-500">Description</p>
                        <p className="mt-1 rounded-lg bg-slate-50 px-3 py-2 text-[13px] leading-relaxed whitespace-pre-wrap text-ink-700">
                          {analysis.description || 'No description extracted.'}
                        </p>
                      </div>

                      {analysis.suggestedAssignee ? (
                        <Field
                          label="Suggested assignee"
                          value={`${analysis.suggestedAssignee.name} · ${percent(analysis.suggestedAssignee.confidence)}`}
                          hint={analysis.suggestedAssignee.reason}
                        />
                      ) : null}

                      <div>
                        <p className="text-xs font-medium text-ink-500">Evidence</p>
                        {analysis.evidence.length === 0 ? (
                          <p className="mt-1 text-[11px] text-ink-500">The analyzer returned no quoted evidence for this message.</p>
                        ) : (
                          <ul className="mt-1.5 space-y-1.5">
                            {analysis.evidence.map((item, index) => (
                              <li key={`${item.field}-${index}`} className="rounded-lg border border-line px-3 py-2">
                                <div className="flex items-center justify-between gap-2">
                                  <span className="text-[11px] font-medium text-ink-700">{item.field}</span>
                                  <span className="text-[11px] text-ink-500 tabular-nums">{percent(item.confidence)}</span>
                                </div>
                                <p className="mt-1 text-[12px] leading-relaxed text-ink-500 italic">“{item.quote}”</p>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>

                      <p className="text-[11px] text-ink-500">
                        Provider {analysis.provider} · model {analysis.model} · analyzed {fmt(analysis.createdAt)}
                      </p>

                      {analysis.projectId == null ? (
                        <div className="space-y-2 rounded-lg border border-amber-200 bg-amber-50/60 px-3 py-2.5">
                          <p className="text-xs font-medium text-amber-900">No project resolved</p>
                          <p className="text-[11px] text-amber-800">
                            A draft needs a project. Pick one and link it — this corrects the request, not just the view.
                          </p>
                          <div className="flex flex-col gap-2 sm:flex-row">
                            <Select
                              aria-label="Project to link"
                              value={projectChoice}
                              onChange={(event) =>
                                setLinkChoice({ requestId: selected.id, projectId: event.target.value })
                              }
                            >
                              <option value="">Select a project…</option>
                              {projects.map((project) => (
                                <option key={project.id} value={project.id}>
                                  {project.code} — {project.name}
                                </option>
                              ))}
                            </Select>
                            <Button
                              variant="secondary"
                              className="shrink-0"
                              loading={busy === 'link'}
                              disabled={!projectChoice}
                              onClick={linkProject}
                            >
                              <Link2 className="h-4 w-4" aria-hidden />
                              Link project
                            </Button>
                          </div>
                        </div>
                      ) : null}
                    </>
                  )}
                </CardContent>
              </Card>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Field({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div>
      <p className="text-xs font-medium text-ink-500">{label}</p>
      <div className="mt-1 text-[13px] text-ink-900">{value}</div>
      {hint ? <p className="mt-0.5 text-[11px] text-ink-500">{hint}</p> : null}
    </div>
  );
}
