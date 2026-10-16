'use client';

import { useState } from 'react';
import { AlertTriangle, Bot, CheckCircle2, ChevronRight, Cpu, Terminal, User } from 'lucide-react';
import { Card, CardContent, EmptyState } from '@/components/ui/primitives';
import { Badge, RunStatusBadge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { ActorKind, WorkflowStep } from '@flowpilot/domain';
import type { CoreServices } from '@flowpilot/core';

type ActivityData = Awaited<ReturnType<CoreServices['queries']['activity']>>;
type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info' | 'dark';
type KindFilter = 'all' | ActorKind;
type View = 'events' | 'workflows' | 'approvals' | 'failures';

const STEP_TONE: Record<WorkflowStep['status'], Tone> = {
  pending: 'neutral',
  running: 'accent',
  succeeded: 'success',
  failed: 'danger',
  skipped: 'dark',
};

const KIND_META: Record<ActorKind, { tone: Tone; label: string }> = {
  user: { tone: 'accent', label: 'human' },
  agent: { tone: 'dark', label: 'agent' },
  system: { tone: 'neutral', label: 'system' },
};

const KIND_FILTERS: Array<{ key: KindFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'user', label: 'Human' },
  { key: 'agent', label: 'Agent' },
  { key: 'system', label: 'System' },
];

function fmt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function detailText(detail: Record<string, unknown> | null): string {
  if (!detail) return '';
  return Object.entries(detail)
    .slice(0, 3)
    .map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(' · ');
}

function KindBadge({ kind }: { kind: ActorKind }) {
  const meta = KIND_META[kind];
  return <Badge tone={meta.tone} className="shrink-0">{meta.label}</Badge>;
}

const TAB_STYLE = 'border-b-2 px-3 py-2.5 text-sm font-medium transition-colors';

export function ActivityClient({ data }: { data: ActivityData }) {
  const { runs, audit, approvals, agentCalls, errors } = data;
  const [view, setView] = useState<View>('events');
  const [kindFilter, setKindFilter] = useState<KindFilter>('all');
  const [eventMode, setEventMode] = useState<'all' | 'mcp'>('all');

  const eventSource = eventMode === 'mcp' ? agentCalls : audit;
  const filteredEvents = eventSource.filter((event) => kindFilter === 'all' || event.actorKind === kindFilter);
  const tabs: Array<{ key: View; label: string; count: number }> = [
    { key: 'events', label: 'Events', count: audit.length },
    { key: 'workflows', label: 'Workflows', count: runs.length },
    { key: 'approvals', label: 'Approvals', count: approvals.length },
    ...(errors.length > 0 ? [{ key: 'failures' as const, label: 'Failed', count: errors.length }] : []),
  ];

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-ink-900">Activity</h1>
        <p className="mt-1 text-sm text-ink-500">Choose what you want to review.</p>
      </header>

      {errors.length > 0 ? (
        <button
          type="button"
          onClick={() => setView('failures')}
          className="flex w-full items-center gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-left transition-colors hover:bg-red-100/70"
        >
          <AlertTriangle className="h-4 w-4 shrink-0 text-red-700" aria-hidden />
          <span className="flex-1 text-sm font-medium text-red-800">{errors.length} workflow{errors.length === 1 ? '' : 's'} failed</span>
          <span className="text-sm font-medium text-red-800">Review <ChevronRight className="inline h-4 w-4" aria-hidden /></span>
        </button>
      ) : null}

      <Card className="overflow-hidden">
        <div role="tablist" aria-label="Activity views" className="flex gap-1 overflow-x-auto border-b border-line px-3">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={view === tab.key}
              onClick={() => setView(tab.key)}
              className={cn(
                TAB_STYLE,
                view === tab.key ? 'border-accent text-accent' : 'border-transparent text-ink-500 hover:text-ink-800',
              )}
            >
              {tab.label}<span className="ml-1.5 text-xs text-ink-400">{tab.count}</span>
            </button>
          ))}
        </div>

        <CardContent className="space-y-4 p-4 sm:p-5" role="tabpanel">
          {view === 'events' ? (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex gap-1 rounded-lg bg-slate-100 p-1">
                  <button
                    type="button"
                    onClick={() => { setEventMode('all'); setKindFilter('all'); }}
                    aria-pressed={eventMode === 'all'}
                    className={cn('rounded-md px-2.5 py-1 text-xs font-medium transition-colors', eventMode === 'all' ? 'bg-white text-ink-900 shadow-sm' : 'text-ink-500 hover:text-ink-800')}
                  >
                    All events
                  </button>
                  <button
                    type="button"
                    onClick={() => { setEventMode('mcp'); setKindFilter('all'); }}
                    aria-pressed={eventMode === 'mcp'}
                    className={cn('inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors', eventMode === 'mcp' ? 'bg-white text-ink-900 shadow-sm' : 'text-ink-500 hover:text-ink-800')}
                  >
                    <Bot className="h-3.5 w-3.5" aria-hidden /> MCP calls
                  </button>
                </div>
                {eventMode === 'all' ? (
                  <div className="flex flex-wrap gap-1">
                    {KIND_FILTERS.map((filter) => (
                      <button
                        key={filter.key}
                        type="button"
                        onClick={() => setKindFilter(filter.key)}
                        aria-pressed={kindFilter === filter.key}
                        className={cn(
                          'rounded-full px-2.5 py-1 text-xs font-medium transition-colors',
                          kindFilter === filter.key ? 'bg-accent-soft text-accent' : 'text-ink-500 hover:bg-slate-100 hover:text-ink-800',
                        )}
                      >
                        {filter.label}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>

              {filteredEvents.length === 0 ? (
                <EmptyState title={eventMode === 'mcp' ? 'No MCP calls yet' : 'No matching events'} />
              ) : (
                <ul className="divide-y divide-line">
                  {filteredEvents.map((event) => (
                    <li key={event.id}>
                      <details className="group py-3 first:pt-1 last:pb-1">
                        <summary className="flex cursor-pointer list-none items-center gap-2 [&::-webkit-details-marker]:hidden">
                          {event.actorKind === 'agent' ? <Cpu className="h-4 w-4 shrink-0 text-ink-400" aria-hidden /> : <User className="h-4 w-4 shrink-0 text-ink-400" aria-hidden />}
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium text-ink-900">{event.action}</span>
                            <span className="mt-0.5 block truncate text-xs text-ink-500">{event.actorLabel} · {fmt(event.createdAt)}</span>
                          </span>
                          <KindBadge kind={event.actorKind} />
                          <ChevronRight className="h-4 w-4 shrink-0 text-ink-400 transition-transform group-open:rotate-90" aria-hidden />
                        </summary>
                        <div className="ml-6 mt-2 space-y-1 text-xs text-ink-500">
                          <p>Type: {event.entityType}</p>
                          {Object.keys(event.metadata).length > 0 ? <p className="break-words font-mono">{detailText(event.metadata)}</p> : null}
                        </div>
                      </details>
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : null}

          {view === 'workflows' ? (
            runs.length === 0 ? <EmptyState title="No workflow runs yet" description="Start with a sample request in AI Inbox." /> : (
              <ul className="divide-y divide-line">
                {runs.map((run) => (
                  <li key={run.id}>
                    <details className="group py-3 first:pt-1 last:pb-1">
                      <summary className="flex cursor-pointer list-none items-center gap-2 [&::-webkit-details-marker]:hidden">
                        <Terminal className="h-4 w-4 shrink-0 text-ink-400" aria-hidden />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-ink-900">{run.trigger}</span>
                          <span className="mt-0.5 block truncate text-xs text-ink-500">{run.id.slice(0, 8)} · {fmt(run.startedAt)}</span>
                        </span>
                        <RunStatusBadge status={run.status} />
                        <ChevronRight className="h-4 w-4 shrink-0 text-ink-400 transition-transform group-open:rotate-90" aria-hidden />
                      </summary>
                      <ol className="ml-6 mt-2 space-y-1.5">
                        {run.steps.map((step) => (
                          <li key={step.key} className="flex items-start gap-2 text-xs">
                            <Badge tone={STEP_TONE[step.status]} className="shrink-0">{step.key}</Badge>
                            <span className="min-w-0 break-words text-ink-500">
                              {step.error ? <span className="text-red-600">{step.error}</span> : detailText(step.detail)}
                            </span>
                          </li>
                        ))}
                      </ol>
                      {run.error ? <p className="ml-6 mt-2 text-xs text-red-600">{run.error}</p> : null}
                    </details>
                  </li>
                ))}
              </ul>
            )
          ) : null}

          {view === 'approvals' ? (
            approvals.length === 0 ? <EmptyState title="No decisions yet" /> : (
              <ul className="divide-y divide-line">
                {approvals.map((approval) => (
                  <li key={approval.id} className="flex items-start gap-3 py-3 first:pt-1 last:pb-1">
                    <CheckCircle2 className={cn('mt-0.5 h-4 w-4 shrink-0', approval.decision === 'approved' ? 'text-emerald-600' : 'text-red-500')} aria-hidden />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge tone={approval.decision === 'approved' ? 'success' : 'danger'}>{approval.decision}</Badge>
                        <span className="text-xs text-ink-500">{approval.decidedByLabel} · {fmt(approval.createdAt)}</span>
                      </div>
                      {approval.note ? <p className="mt-1 text-sm text-ink-700">{approval.note}</p> : null}
                      <p className="mt-1 font-mono text-[11px] text-ink-400">Task {approval.taskId.slice(0, 8)}</p>
                    </div>
                  </li>
                ))}
              </ul>
            )
          ) : null}

          {view === 'failures' ? (
            errors.map((run) => (
              <div key={run.id} className="rounded-lg border border-red-200 bg-red-50/60 px-3 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-mono text-xs text-red-700">{run.id.slice(0, 8)}</span>
                  <span className="text-xs text-ink-500">{fmt(run.startedAt)}</span>
                </div>
                <p className="mt-2 text-sm leading-relaxed text-red-700">{run.error ?? 'No error message recorded.'}</p>
                {run.requestId ? <p className="mt-1 font-mono text-[11px] text-ink-500">Request {run.requestId.slice(0, 8)}</p> : null}
              </div>
            ))
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
