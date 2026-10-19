'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Save, Send, TestTube2, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  ErrorNote,
  Label,
} from '@/components/ui/primitives';
import { ApiError, apiFetch } from '@/lib/api-client';

interface ConnectionView {
  id: string;
  status: 'connected' | 'disconnected' | 'error';
  config: Record<string, unknown>;
  lastEventAt: string | null;
  createdAt: string;
}

interface CatalogStatusResponse {
  integrations: Array<{ provider: string; status: string }>;
}

export function WhatsAppIntegrationClient({
  orgSlug,
  connection,
  canManage,
}: {
  orgSlug: string;
  connection: ConnectionView | null;
  canManage: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [phoneNumberId, setPhoneNumberId] = useState(String(connection?.config['phoneNumberId'] ?? ''));
  const [businessAccountId, setBusinessAccountId] = useState(String(connection?.config['businessAccountId'] ?? ''));
  const [verifyToken, setVerifyToken] = useState(String(connection?.config['verifyToken'] ?? ''));
  const [apiBase, setApiBase] = useState(String(connection?.config['apiBase'] ?? 'https://graph.facebook.com/v20.0'));
  const [accessToken, setAccessToken] = useState('');
  const [appSecret, setAppSecret] = useState('');

  const [simBody, setSimBody] = useState(
    "I'd like to order a birthday cake for Saturday. Do you have any chocolate options?",
  );
  const [simFrom, setSimFrom] = useState('+15551234567');
  const [simFromName, setSimFromName] = useState('Casey Customer');
  const [simResult, setSimResult] = useState<{
    externalId: string;
    ingested: Array<{ requestId: string }>;
  } | null>(null);

  const webhookUrl = `${typeof window === 'undefined' ? '' : window.location.origin}/api/webhooks/whatsapp/${orgSlug}`;

  async function saveConfig(target: 'reauth_required' | 'connected' | 'disconnected') {
    if (!canManage) return;
    setBusy('save');
    setActionError(null);
    setNotice(null);
    try {
      await apiFetch(`/api/integrations/whatsapp-cloud`, {
        method: 'PUT',
        body: JSON.stringify({
          status: target,
          config: {
            phoneNumberId,
            businessAccountId,
            verifyToken,
            apiBase,
            ...(connection ? {} : { mode: 'live' }),
          },
          ...(accessToken ? { accessToken } : {}),
          ...(appSecret ? { appSecret } : {}),
        }),
      });
      setAccessToken('');
      setAppSecret('');
      setNotice(target === 'connected' ? 'WhatsApp connection marked live. Send a test to verify.' : 'Saved.');
      router.refresh();
    } catch (error) {
      setActionError(error instanceof ApiError ? error.explain : 'Failed to save configuration.');
    } finally {
      setBusy(null);
    }
  }

  async function disconnect() {
    setBusy('disconnect');
    try {
      await apiFetch(`/api/integrations/whatsapp-cloud`, { method: 'DELETE' });
      setNotice('WhatsApp connection removed. Webhooks will 404 until re-configured.');
      router.refresh();
    } catch (error) {
      setActionError(error instanceof ApiError ? error.explain : 'Failed to disconnect.');
    } finally {
      setBusy(null);
    }
  }

  async function simulateInbound() {
    setBusy('sim');
    setActionError(null);
    try {
      const result = await apiFetch<{ externalId: string; ingested: Array<{ requestId: string }> }>(
        '/api/integrations/whatsapp/simulate',
        {
          method: 'POST',
          body: JSON.stringify({
            from: simFrom,
            fromName: simFromName,
            body: simBody,
          }),
        },
      );
      setSimResult(result);
      const firstRequest = result.ingested[0]?.requestId;
      if (firstRequest) {
        setNotice('Simulated inbound WhatsApp ingested — open the inbox to review or generate a reply.');
      } else {
        setNotice('Simulated inbound WhatsApp ingested (duplicate or no-op).');
      }
    } catch (error) {
      setActionError(error instanceof ApiError ? error.explain : 'Simulation failed.');
    } finally {
      setBusy(null);
    }
  }

  async function loadCatalogStatuses() {
    try {
      const data = await apiFetch<CatalogStatusResponse>('/api/integrations');
      return data.integrations;
    } catch {
      return [];
    }
  }
  void loadCatalogStatuses;

  return (
    <div className="space-y-6">
      {actionError && <ErrorNote message={actionError} />}
      {notice && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          {notice}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Webhook endpoint</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-ink-500">
            Subscribe this URL in the Meta dashboard under <em>WhatsApp → Configuration → Webhooks</em>.
            The verification token below is what Meta will echo back during the
            <code> hub.mode=subscribe</code> handshake.
          </p>
          <code className="block rounded-md bg-slate-50 px-3 py-2 text-sm">{webhookUrl}</code>
          <p className="text-xs text-ink-500">Verification token (echo this in Meta):</p>
          <code className="block rounded-md bg-slate-50 px-3 py-2 text-xs">{verifyToken || '(unset — set before subscription)'}</code>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Credentials</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="phoneNumberId">Phone Number ID</Label>
              <input
                id="phoneNumberId"
                value={phoneNumberId}
                disabled={!canManage}
                onChange={(e) => setPhoneNumberId(e.target.value)}
                className="mt-1 w-full rounded-md border border-line bg-white px-3 py-2 text-sm"
              />
            </div>
            <div>
              <Label htmlFor="businessAccountId">WhatsApp Business Account ID</Label>
              <input
                id="businessAccountId"
                value={businessAccountId}
                disabled={!canManage}
                onChange={(e) => setBusinessAccountId(e.target.value)}
                className="mt-1 w-full rounded-md border border-line bg-white px-3 py-2 text-sm"
              />
            </div>
            <div className="sm:col-span-2">
              <Label htmlFor="verifyToken">Webhook verify token</Label>
              <input
                id="verifyToken"
                value={verifyToken}
                disabled={!canManage}
                onChange={(e) => setVerifyToken(e.target.value)}
                className="mt-1 w-full rounded-md border border-line bg-white px-3 py-2 text-sm font-mono"
              />
            </div>
            <div className="sm:col-span-2">
              <Label htmlFor="apiBase">Graph API base URL</Label>
              <input
                id="apiBase"
                value={apiBase}
                disabled={!canManage}
                onChange={(e) => setApiBase(e.target.value)}
                className="mt-1 w-full rounded-md border border-line bg-white px-3 py-2 text-sm font-mono"
              />
            </div>
            <div>
              <Label htmlFor="accessToken">Access Token (write-only)</Label>
              <input
                id="accessToken"
                type="password"
                value={accessToken}
                disabled={!canManage}
                onChange={(e) => setAccessToken(e.target.value)}
                placeholder={connection ? '(saved — leave empty to keep)' : 'paste to save'}
                className="mt-1 w-full rounded-md border border-line bg-white px-3 py-2 text-sm"
              />
            </div>
            <div>
              <Label htmlFor="appSecret">App Secret (write-only)</Label>
              <input
                id="appSecret"
                type="password"
                value={appSecret}
                disabled={!canManage}
                onChange={(e) => setAppSecret(e.target.value)}
                placeholder={connection ? '(saved — leave empty to keep)' : 'paste to save'}
                className="mt-1 w-full rounded-md border border-line bg-white px-3 py-2 text-sm"
              />
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void saveConfig('reauth_required')} disabled={!canManage || busy === 'save'}>
              <Save className="mr-1.5 h-4 w-4" aria-hidden /> Save
            </Button>
            <Button variant="primary" onClick={() => void saveConfig('connected')} disabled={!canManage || busy === 'save'}>
              Mark connected
            </Button>
            {connection && (
              <Button variant="ghost" onClick={() => void disconnect()} disabled={busy === 'disconnect'}>
                <Trash2 className="mr-1.5 h-4 w-4" aria-hidden /> Disconnect
              </Button>
            )}
          </div>
          <p className="text-xs text-ink-500">
            Connection status: <strong>{connection?.status ?? 'not configured'}</strong>. Marking
            connected enables live sends; <em>Send</em> still goes through the mock driver until a
            real access token is saved.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Demo simulator</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-ink-500">
            Drives the same pipeline a real webhook would: ingest → dedupe → analyze →
            draft → generate reply. Useful when credentials aren&apos;t available.
          </p>
          <div>
            <Label htmlFor="simFrom">Sender phone (E.164)</Label>
            <input
              id="simFrom"
              value={simFrom}
              onChange={(e) => setSimFrom(e.target.value)}
              className="mt-1 w-full rounded-md border border-line bg-white px-3 py-2 text-sm"
            />
          </div>
          <div>
            <Label htmlFor="simFromName">Sender name</Label>
            <input
              id="simFromName"
              value={simFromName}
              onChange={(e) => setSimFromName(e.target.value)}
              className="mt-1 w-full rounded-md border border-line bg-white px-3 py-2 text-sm"
            />
          </div>
          <div>
            <Label htmlFor="simBody">Message body</Label>
            <textarea
              id="simBody"
              value={simBody}
              onChange={(e) => setSimBody(e.target.value)}
              rows={4}
              className="mt-1 w-full rounded-md border border-line bg-white px-3 py-2 text-sm"
            />
          </div>
          <Button onClick={() => void simulateInbound()} disabled={busy === 'sim'}>
            <TestTube2 className="mr-1.5 h-4 w-4" aria-hidden /> Simulate inbound WhatsApp
          </Button>
          {simResult !== null && (
            <div className="space-y-2">
              <div className="flex flex-wrap gap-2 text-[12px]">
                {simResult.ingested[0] ? (
                  <Link
                    href={`/inbox?requestId=${encodeURIComponent(simResult.ingested[0].requestId)}`}
                    className="inline-flex items-center gap-1 rounded-md border border-line bg-white px-2 py-1 text-ink-700 transition-colors hover:bg-slate-50"
                  >
                    Open in inbox →
                  </Link>
                ) : null}
                <Link
                  href="/outbox"
                  className="inline-flex items-center gap-1 rounded-md border border-line bg-white px-2 py-1 text-ink-700 transition-colors hover:bg-slate-50"
                >
                  Open outbox →
                </Link>
              </div>
              <pre className="overflow-x-auto rounded-md bg-slate-50 px-3 py-2 text-xs">
                {JSON.stringify(simResult, null, 2)}
              </pre>
            </div>
          )}
          <EmptyState title="(reserved)" description="(reserved)" />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Approval &amp; send API</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-ink-500">
          <p>Outbound actions live at:</p>
          <ul className="list-disc pl-5">
            <li><code>GET /api/outbound-actions?status=pending_approval</code> — drafts waiting on a human.</li>
            <li><code>POST /api/outbound-actions</code> — compose a draft.</li>
            <li><code>POST /api/outbound-actions/&lt;id&gt;/decide</code> — human approval or rejection.</li>
            <li><code>POST /api/outbound-actions/&lt;id&gt;/send</code> — drives the channel.</li>
            <li><code>POST /api/whatsapp/generate-reply</code> — auto-draft a WhatsApp reply.</li>
          </ul>
          <p className="mt-2 inline-flex items-center gap-1">
            <Send className="h-4 w-4" aria-hidden /> All sends go through the in-process mock
            driver by default.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
