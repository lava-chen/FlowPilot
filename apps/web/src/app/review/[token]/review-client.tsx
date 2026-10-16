'use client';

import { useState } from 'react';
import { CheckCircle2, ExternalLink, MessageSquareText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea, Input, Label } from '@/components/ui/primitives';
import { ApiError, apiFetch } from '@/lib/api-client';
import type { CoreServices } from '@flowpilot/core';

type Portal = Awaited<ReturnType<CoreServices['taskOperations']['clientReviewPortal']>>;

export function ClientReviewClient({ token, portal }: { token: string; portal: Portal }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<'approved' | 'changes_requested' | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const respond = async (decision: 'approved' | 'changes_requested') => {
    setBusy(decision); setError(null); setMessage(null);
    try {
      await apiFetch(`/api/client-review/${token}`, {
        method: 'POST', json: { decision, reviewerName: name, ...(email ? { reviewerEmail: email } : {}), ...(note ? { note } : {}) },
      });
      setMessage(decision === 'approved' ? 'Thanks — your approval has been recorded.' : 'Thanks — your requested changes have been sent to the project team.');
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.explain : 'Your response could not be recorded. Please contact your project team.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <main className="mx-auto min-h-screen max-w-2xl px-5 py-10 sm:py-16">
      <section className="rounded-2xl border border-line bg-white shadow-sm">
        <header className="border-b border-line px-6 py-5 sm:px-8">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-accent">FlowPilot · Client review</p>
          <h1 className="mt-2 text-xl font-semibold text-ink-900">{portal.taskTitle}</h1>
          <p className="mt-1 text-sm text-ink-500">{portal.clientName} · {portal.projectName}</p>
          <p className="mt-2 text-[11px] text-ink-500">Please review the delivery and approve it or request changes by {new Date(portal.expiresAt).toLocaleDateString()}.</p>
        </header>

        <div className="space-y-6 px-6 py-6 sm:px-8">
          <p className="text-sm leading-6 text-ink-600">Please review the delivery files below. Your response will be recorded for this project task.</p>

          <section className="space-y-2">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-ink-800"><ExternalLink className="h-4 w-4" aria-hidden /> Deliverables</h2>
            {portal.links.length === 0 ? <p className="text-sm text-ink-500">No delivery links were attached.</p> : (
              <ul className="space-y-2">
                {portal.links.map((link) => (
                  <li key={link.id}>
                    <a className="flex items-center justify-between rounded-lg border border-line px-3 py-2.5 text-sm text-accent hover:bg-slate-50" href={link.url} target="_blank" rel="noopener noreferrer">
                      <span>{link.label} <span className="ml-1 text-[10px] uppercase text-ink-500">{link.kind}</span></span>
                      <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {message ? (
            <div role="status" className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800"><CheckCircle2 className="mr-2 inline h-4 w-4" aria-hidden />{message}</div>
          ) : (
            <section className="space-y-3 border-t border-line pt-5">
              <h2 className="flex items-center gap-2 text-sm font-semibold text-ink-800"><MessageSquareText className="h-4 w-4" aria-hidden /> Your decision</h2>
              {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : null}
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label>Your name</Label>
                  <Input value={name} onChange={(event) => setName(event.target.value)} maxLength={120} autoComplete="name" />
                </div>
                <div className="space-y-1.5">
                  <Label>Email (optional)</Label>
                  <Input type="email" value={email} onChange={(event) => setEmail(event.target.value)} maxLength={254} autoComplete="email" />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label>Feedback or requested changes</Label>
                <Textarea value={note} onChange={(event) => setNote(event.target.value)} rows={3} maxLength={2000} placeholder="Add context for your project team" />
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="success" disabled={!name.trim()} loading={busy === 'approved'} onClick={() => void respond('approved')}>Approve delivery</Button>
                <Button variant="secondary" disabled={!name.trim() || !note.trim()} loading={busy === 'changes_requested'} onClick={() => void respond('changes_requested')}>Request changes</Button>
              </div>
            </section>
          )}
        </div>
      </section>
      <p className="mx-auto mt-4 max-w-lg text-center text-[11px] leading-5 text-ink-500">This link is intended for the named project delivery and expires automatically. Your decision will be shared with the project team.</p>
    </main>
  );
}
