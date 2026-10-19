'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Check, ExternalLink, Loader2, Send, X } from 'lucide-react';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  ErrorNote,
} from '@/components/ui/primitives';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ApiError, apiFetch } from '@/lib/api-client';
import type { OutboundAction, OutboundActionStatus } from '@flowpilot/domain';

interface Activity {
  id: string;
  fromStatus: string | null;
  toStatus: string;
  actorKind: string;
  actorLabel: string;
  note: string | null;
  errorCode: string | null;
  errorTitle: string | null;
  errorBody: string | null;
  createdAt: string;
}

function statusTone(s: OutboundActionStatus): string {
  switch (s) {
    case 'sent':
      return 'bg-emerald-50 text-emerald-700 ring-emerald-200';
    case 'approved':
    case 'sending':
      return 'bg-indigo-50 text-indigo-700 ring-indigo-200';
    case 'pending_approval':
      return 'bg-amber-50 text-amber-700 ring-amber-200';
    case 'rejected':
      return 'bg-slate-50 text-slate-600 ring-slate-200';
    case 'failed':
      return 'bg-rose-50 text-rose-700 ring-rose-200';
    default:
      return 'bg-slate-50 text-slate-600 ring-slate-200';
  }
}

function fmt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

export function OutboxClient({
  pending,
  recent,
  actorLabel,
}: {
  pending: OutboundAction[];
  recent: OutboundAction[];
  actorLabel: string;
}) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [events, setEvents] = useState<Record<string, Activity[]>>({});
  const [error, setError] = useState<string | null>(null);

  async function loadEvents(id: string) {
    if (events[id]) return;
    try {
      const result = await apiFetch<{ events: Activity[] }>(`/api/outbound-actions/${id}/events`);
      setEvents((s) => ({ ...s, [id]: result.events }));
    } catch (error) {
      setError(error instanceof ApiError ? error.explain : 'Could not load events.');
    }
  }

  async function decide(id: string, decision: 'approved' | 'rejected') {
    setBusyId(id);
    setError(null);
    try {
      await apiFetch(`/api/outbound-actions/${id}/decide`, {
        method: 'POST',
        body: JSON.stringify({ decision }),
      });
      router.refresh();
    } catch (error) {
      setError(error instanceof ApiError ? error.explain : 'Decision failed.');
    } finally {
      setBusyId(null);
    }
  }

  async function sendNow(id: string) {
    setBusyId(id);
    setError(null);
    try {
      await apiFetch(`/api/outbound-actions/${id}/send`, { method: 'POST' });
      router.refresh();
    } catch (error) {
      setError(error instanceof ApiError ? error.explain : 'Send failed.');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-ink-900">Outbound queue</h1>
        <p className="mt-1 text-sm text-ink-500">
          Every customer-visible send waits here until a human approves it. Agents and the
          webhook can compose drafts; only you can press <em>send</em>.
        </p>
        <p className="mt-1 text-xs text-ink-500">Signed in as {actorLabel}</p>
      </header>
      {error && <ErrorNote message={error} />}

      <Card>
        <CardHeader>
          <CardTitle>Pending review ({pending.length})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {pending.length === 0 ? (
            <EmptyState title="Nothing waiting on you" description="New drafts will appear here." />
          ) : (
            pending.map((action) => (
              <PendingCard
                key={action.id}
                action={action}
                busy={busyId === action.id}
                decide={decide}
                sendNow={sendNow}
              />
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent activity</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {recent.length === 0 ? (
            <EmptyState title="No recent activity" description="Once you approve and send messages, the timeline shows up here." />
          ) : (
            recent.map((action) => (
              <RecentRow
                key={action.id}
                action={action}
                events={events[action.id]}
                onToggle={() => void loadEvents(action.id)}
              />
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function PendingCard({
  action,
  busy,
  decide,
  sendNow,
}: {
  action: OutboundAction;
  busy: boolean;
  decide: (id: string, decision: 'approved' | 'rejected') => Promise<void>;
  sendNow: (id: string) => Promise<void>;
}) {
  const canApprove = action.status === 'pending_approval' || action.status === 'draft';
  const canSend = action.status === 'approved';
  return (
    <div className="rounded-lg border border-line p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${statusTone(action.status)}`}>
          {action.status}
        </span>
        <span className="text-xs text-ink-500">{action.channel} · {action.provider}</span>
        <span className="text-xs text-ink-500">to {action.to}</span>
        {action.requestId ? (
          <Link
            href={`/inbox?requestId=${encodeURIComponent(action.requestId)}`}
            className="ml-auto inline-flex items-center gap-1 text-[11px] text-accent underline-offset-2 hover:underline"
          >
            Source request <ExternalLink className="h-3 w-3" aria-hidden />
          </Link>
        ) : null}
      </div>
      <pre className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap rounded-md bg-slate-50 px-3 py-2 text-sm text-slate-800">{action.body}</pre>
      <div className="mt-3 flex flex-wrap gap-2">
        {canApprove && action.status === 'draft' && (
          <Button variant="ghost" onClick={() => void decide(action.id, 'approved')} disabled={busy}>
            <Check className="mr-1.5 h-4 w-4" aria-hidden /> Approve &amp; send
          </Button>
        )}
        {canApprove && action.status === 'pending_approval' && (
          <>
            <Button variant="primary" onClick={() => void decide(action.id, 'approved')} disabled={busy}>
              <Check className="mr-1.5 h-4 w-4" aria-hidden /> Approve
            </Button>
            <Button variant="ghost" onClick={() => void decide(action.id, 'rejected')} disabled={busy}>
              <X className="mr-1.5 h-4 w-4" aria-hidden /> Reject
            </Button>
          </>
        )}
        {canSend && (
          <Button onClick={() => void sendNow(action.id)} disabled={busy}>
            {busy ? (
              <>
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden /> Sending…
              </>
            ) : (
              <>
                <Send className="mr-1.5 h-4 w-4" aria-hidden /> Send now
              </>
            )}
          </Button>
        )}
      </div>
      {action.errorMessage && <p className="mt-2 text-xs text-rose-600">{action.errorMessage}</p>}
      {action.approvedAt ? (
        <p className="mt-1 text-[11px] text-ink-500">
          Approved by {action.approvedByLabel ?? action.approvedBy ?? 'a human'} · {fmt(action.approvedAt)}
          {action.approvalNote ? <span> · “{action.approvalNote}”</span> : null}
        </p>
      ) : null}
    </div>
  );
}

function RecentRow({
  action,
  events,
  onToggle,
}: {
  action: OutboundAction;
  events?: Activity[];
  onToggle: () => void;
}) {
  return (
    <div className="rounded-lg border border-line p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={BADGE_TONE[action.status]}>{action.status}</Badge>
        <span className="text-xs text-ink-500">{action.channel} · {action.provider}</span>
        <span className="text-xs text-ink-500">to {action.to}</span>
        <span className="text-xs text-ink-500">{fmt(action.createdAt)}</span>
        {action.requestId ? (
          <Link
            href={`/inbox?requestId=${encodeURIComponent(action.requestId)}`}
            className="ml-auto inline-flex items-center gap-1 text-[11px] text-accent underline-offset-2 hover:underline"
          >
            Source request <ExternalLink className="h-3 w-3" aria-hidden />
          </Link>
        ) : null}
      </div>
      {action.externalMessageId ? (
        <p className="mt-1 font-mono text-[11px] text-ink-500">
          External id: <span className="text-ink-700">{action.externalMessageId}</span>
        </p>
      ) : null}
      {action.errorMessage && (
        <p className="mt-1 text-xs text-rose-600">{action.errorMessage}</p>
      )}
      {action.sentAt ? (
        <p className="mt-1 text-[11px] text-ink-500">Sent at {fmt(action.sentAt)}</p>
      ) : null}
      <details className="mt-2">
        <summary
          onClick={(e) => {
            e.preventDefault();
            onToggle();
          }}
          className="cursor-pointer text-xs font-medium text-accent hover:text-indigo-700"
        >
          Timeline ({events?.length ?? '…'})
        </summary>
        <ol className="mt-2 space-y-1 text-xs text-ink-600">
          {events?.map((evt) => (
            <li key={evt.id}>
              <span className="font-mono text-ink-500">{fmt(evt.createdAt)}</span>{' '}
              {evt.fromStatus ?? '∅'} → {evt.toStatus} · {evt.actorLabel}
              {evt.errorCode && (
                <span className="ml-1 inline-flex items-center rounded bg-rose-50 px-1 py-0.5 text-[11px] text-rose-700">
                  {evt.errorCode} {evt.errorTitle ?? ''}
                </span>
              )}
              {evt.errorBody && <p className="text-[11px] text-rose-700">{evt.errorBody}</p>}
              {evt.note && <p className="text-[11px] text-ink-700">{evt.note}</p>}
            </li>
          ))}
        </ol>
      </details>
    </div>
  );
}

const BADGE_TONE = {
  draft: 'neutral',
  pending_approval: 'warning',
  approved: 'success',
  rejected: 'danger',
  sending: 'accent',
  sent: 'success',
  failed: 'danger',
} as const satisfies Record<OutboundActionStatus, 'neutral' | 'warning' | 'success' | 'danger' | 'accent'>;
