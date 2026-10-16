'use client';

import Link from 'next/link';
import { ArrowRight, AlertTriangle, Clock3, Inbox } from 'lucide-react';
import { TaskStatusBadge, PriorityBadge } from '@/components/ui/badge';
import { Card, EmptyState } from '@/components/ui/primitives';
import type { CoreServices } from '@flowpilot/core';

type OverviewData = Awaited<ReturnType<CoreServices['queries']['overview']>>;

function fmtDate(value: string | null): string {
  if (!value) return 'No due date';
  const date = new Date(value.length <= 10 ? `${value}T00:00:00` : value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function OverviewClient({ data }: { data: OverviewData }) {
  const { metrics, pendingApprovals } = data;
  const needsAttention = pendingApprovals.length + metrics.newRequests + metrics.failedWorkflows;

  return (
    <div className="mx-auto max-w-4xl space-y-7">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-ink-900">What needs your attention?</h1>
        <p className="mt-1 text-sm text-ink-500">Start with a request or a task waiting for your decision.</p>
      </header>

      {needsAttention === 0 ? (
        <Card className="p-6 sm:p-8">
          <EmptyState title="You’re all caught up" description="New requests and approvals will appear here." />
          <div className="mt-5 flex justify-center">
            <Link href="/tasks" className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent/90">
              Go to tasks <ArrowRight className="h-4 w-4" aria-hidden />
            </Link>
          </div>
        </Card>
      ) : (
        <div className="overflow-hidden rounded-xl border border-line bg-white">
          {pendingApprovals.length > 0 ? (
            <section aria-labelledby="approvals-heading">
              <div className="flex items-center justify-between px-4 py-3 sm:px-5">
                <h2 id="approvals-heading" className="text-sm font-semibold text-ink-900">Waiting for your decision</h2>
                <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800">{pendingApprovals.length}</span>
              </div>
              <ul className="divide-y divide-line border-t border-line">
                {pendingApprovals.map((task) => (
                  <li key={task.id}>
                    <Link href={`/tasks?taskId=${encodeURIComponent(task.id)}`} className="group flex items-center gap-3 px-4 py-3.5 transition-colors hover:bg-slate-50 sm:px-5">
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-amber-50 text-amber-700">
                        <Clock3 className="h-4 w-4" aria-hidden />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-ink-900">{task.title}</span>
                        <span className="mt-1 flex flex-wrap items-center gap-1.5">
                          <TaskStatusBadge status={task.status} />
                          <PriorityBadge priority={task.priority} />
                          <span className="text-xs text-ink-500">Due {fmtDate(task.dueDate)}</span>
                        </span>
                      </span>
                      <span className="hidden shrink-0 items-center gap-1 text-sm font-medium text-accent group-hover:flex">
                        Review <ArrowRight className="h-4 w-4" aria-hidden />
                      </span>
                      <ArrowRight className="h-4 w-4 shrink-0 text-ink-400 group-hover:hidden" aria-hidden />
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {metrics.newRequests > 0 ? (
            <Link href="/inbox" className="group flex items-center gap-3 border-t border-line px-4 py-3.5 transition-colors hover:bg-slate-50 sm:px-5">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-indigo-50 text-indigo-700">
                <Inbox className="h-4 w-4" aria-hidden />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-ink-900">Review new requests</span>
                <span className="mt-0.5 block text-xs text-ink-500">{metrics.newRequests} waiting in your inbox</span>
              </span>
              <ArrowRight className="h-4 w-4 shrink-0 text-ink-400 group-hover:text-accent" aria-hidden />
            </Link>
          ) : null}

          {metrics.failedWorkflows > 0 ? (
            <Link href="/activity" className="group flex items-center gap-3 border-t border-line px-4 py-3.5 transition-colors hover:bg-slate-50 sm:px-5">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-red-50 text-red-700">
                <AlertTriangle className="h-4 w-4" aria-hidden />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-ink-900">Check failed workflows</span>
                <span className="mt-0.5 block text-xs text-ink-500">{metrics.failedWorkflows} need attention</span>
              </span>
              <ArrowRight className="h-4 w-4 shrink-0 text-ink-400 group-hover:text-accent" aria-hidden />
            </Link>
          ) : null}
        </div>
      )}

    </div>
  );
}
