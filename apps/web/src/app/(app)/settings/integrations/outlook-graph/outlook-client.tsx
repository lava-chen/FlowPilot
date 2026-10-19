'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { CheckCircle2, ExternalLink, KeyRound, Loader2, Plug, RefreshCw, RotateCcw, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, EmptyState, ErrorNote } from '@/components/ui/primitives';
import { ApiError, apiFetch } from '@/lib/api-client';

interface ConnectionView {
  id: string;
  status: 'connected' | 'disconnected' | 'error';
  config: Record<string, unknown>;
  lastEventAt: string | null;
  createdAt: string;
}

interface TokensView {
  accountLabel: string;
  scopes: string[];
  refreshedAt: string;
  accessExpiresAt: string;
}

interface CursorView {
  lastSyncedAt: string;
  totalIngested: number;
  metadata: Record<string, unknown>;
}

export function OutlookIntegrationClient({
  canManage,
  connection,
  tokens,
  cursor,
  flash,
  flashReason,
}: {
  canManage: boolean;
  connection: ConnectionView | null;
  tokens: TokensView | null;
  cursor: CursorView | null;
  flash: string | null;
  flashReason: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [lastSyncSummary, setLastSyncSummary] = useState<{
    ingested: number;
    duplicates: number;
    drafts: number;
    errors: number;
    durationMs: number;
  } | null>(null);

  const isConnected = Boolean(tokens);

  async function connect() {
    if (!canManage) return;
    setBusy('connect');
    setActionError(null);
    setInfo(null);
    try {
      const result = await apiFetch<{ authorizeUrl: string; state: string; expiresIn: number }>(
        '/api/integrations/outlook-graph/oauth/start',
      );
      // The browser carries the verifier cookie automatically because /start set it
      // with SameSite=Lax. Navigating assigns the URL.
      window.location.assign(result.authorizeUrl);
    } catch (error) {
      setBusy(null);
      setActionError(error instanceof ApiError ? error.explain : 'Could not start OAuth.');
    }
  }

  async function disconnect() {
    setBusy('disconnect');
    setActionError(null);
    setInfo(null);
    try {
      await apiFetch('/api/integrations/outlook-graph/disconnect', { method: 'POST' });
      setInfo('Microsoft account disconnected.');
      router.refresh();
    } catch (error) {
      setActionError(error instanceof ApiError ? error.explain : 'Could not disconnect.');
    } finally {
      setBusy(null);
    }
  }

  async function syncNow({ reset }: { reset?: boolean } = {}) {
    setBusy(reset ? 'reset' : 'sync');
    setActionError(null);
    setInfo(null);
    try {
      const result = await apiFetch<{
        result: { ingested: number; duplicates: number; drafts: number; errors: number; durationMs: number };
        cursor: { lastSyncedAt: string; totalIngested: number } | null;
      }>('/api/integrations/outlook-graph/sync', {
        method: 'POST',
        body: JSON.stringify(reset ? { resetCursor: true, folder: 'inbox' } : { folder: 'inbox' }),
      });
      setLastSyncSummary(result.result);
      setInfo(
        result.result.errors > 0
          ? `Sync finished with ${result.result.errors} errors. See the activity page for details.`
          : 'Sync complete.',
      );
      router.refresh();
    } catch (error) {
      setActionError(error instanceof ApiError ? error.explain : 'Sync failed.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-ink-900">Microsoft Outlook</h1>
        <p className="mt-1 text-sm text-ink-500">
          Pull new client email via Microsoft Graph, run it through the same AI inbox the mock emails
          already use, and approve outbound drafts before they leave your tenant.
        </p>
      </header>

      {flash === 'connected' ? (
        <div className="flex items-start gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          Connected. The first delta-query sync can take a few seconds.
        </div>
      ) : null}
      {flash === 'error' ? (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
          Microsoft returned an error:
          <span className="ml-1 font-mono">{flashReason ?? 'unspecified'}</span>
        </div>
      ) : null}
      {actionError ? <ErrorNote message={actionError} /> : null}
      {info ? (
        <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-ink-700">
          {info}
        </div>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Status</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <Row label="Connection">
            <span className="font-mono">{connection?.status ?? 'not configured'}</span>
          </Row>
          <Row label="Account">
            {tokens ? (
              <span className="font-mono">{tokens.accountLabel}</span>
            ) : (
              <span className="text-ink-500">—</span>
            )}
          </Row>
          <Row label="Scopes">
            {tokens ? (
              <code className="block text-xs">{tokens.scopes.join(' ')}</code>
            ) : (
              <span className="text-ink-500">—</span>
            )}
          </Row>
          <Row label="Last token refresh">
            {tokens ? new Date(tokens.refreshedAt).toLocaleString() : '—'}
          </Row>
          <Row label="Access token expires">
            {tokens ? new Date(tokens.accessExpiresAt).toLocaleString() : '—'}
          </Row>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Connect / disconnect</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {isConnected ? (
            <div className="flex flex-wrap gap-2">
              <Button variant="ghost" onClick={() => void disconnect()} disabled={!canManage || busy === 'disconnect'}>
                <Trash2 className="mr-1.5 h-4 w-4" aria-hidden /> Disconnect
              </Button>
            </div>
          ) : (
            <div className="space-y-2">
              <Button variant="primary" onClick={() => void connect()} disabled={!canManage || busy === 'connect'}>
                {busy === 'connect' ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden /> : <Plug className="mr-1.5 h-4 w-4" aria-hidden />}
                Sign in with Microsoft
              </Button>
              <p className="text-xs text-ink-500">
                You'll be redirected to <code>login.microsoftonline.com</code>. After consent, you'll land
                back here with the connection saved.
              </p>
            </div>
          )}
          {!canManage ? (
            <p className="text-xs text-ink-500">Your role is read-only on this integration.</p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Sync now</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-ink-500">
            Fetches a fresh delta cursor from Microsoft Graph and ingests any new inbox messages
            through the AI pipeline.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => void syncNow()}
              disabled={!canManage || !isConnected || busy === 'sync' || busy === 'reset'}
            >
              {busy === 'sync' ? (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <RefreshCw className="mr-1.5 h-4 w-4" aria-hidden />
              )}
              Sync inbox
            </Button>
            <Button
              variant="ghost"
              onClick={() => void syncNow({ reset: true })}
              disabled={!canManage || !isConnected || busy === 'sync' || busy === 'reset'}
            >
              <RotateCcw className="mr-1.5 h-4 w-4" aria-hidden /> Reset cursor &amp; sync
            </Button>
            <Link
              href="/inbox"
              className="inline-flex items-center gap-1 rounded-md border border-line bg-white px-3 py-2 text-sm font-medium text-ink-700 transition-colors hover:bg-slate-50"
            >
              Open inbox <ExternalLink className="h-4 w-4" aria-hidden />
            </Link>
          </div>
          {cursor ? (
            <div className="rounded-md bg-slate-50 px-3 py-2 text-xs text-ink-600">
              <p>
                Last sync {new Date(cursor.lastSyncedAt).toLocaleString()} ·{' '}
                {cursor.totalIngested} message(s) ingested since the first connect.
              </p>
              <p className="mt-1 truncate font-mono">
                cursor: <span className="text-ink-700">{String(cursor.metadata?.['lastFetched'] ?? 'n/a')} msgs</span>
              </p>
            </div>
          ) : (
            <EmptyState
              title="No sync has run yet"
              description="Once you connect, click Sync inbox to pull the latest messages."
            />
          )}
          {lastSyncSummary ? (
            <div className="rounded-md border border-line bg-white px-3 py-2 text-xs text-ink-700">
              Just finished: {lastSyncSummary.ingested} ingested · {lastSyncSummary.duplicates} duplicates ·{' '}
              {lastSyncSummary.drafts} drafts queued · {lastSyncSummary.errors} errors ·{' '}
              {lastSyncSummary.durationMs} ms
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Local mock driver</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-xs text-ink-500">
          <p>
            Until a real Microsoft account is connected, outbound drafts are routed through{' '}
            <code>MockOutlookGraphChannel</code>. The same channel-routing seam used by WhatsApp
            applies here — set <code>FLOWPILOT_OUTLOOK_CLIENT_ID</code> + <code>..._CLIENT_SECRET</code> to
            flip to live mode.
          </p>
          <p>
            Phone-like sender addresses route through the same Outbox approval gate as WhatsApp; the
            unified <code>OutboundAction</code> lifecycle handles all of them identically.
          </p>
          <p className="inline-flex items-center gap-1">
            <KeyRound className="h-3 w-3" aria-hidden /> Tokens are encrypted with{' '}
            <code>SESSION_SECRET</code> via AES-256-GCM.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <span className="w-44 shrink-0 text-xs font-medium uppercase tracking-wide text-ink-500">
        {label}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
