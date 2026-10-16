'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { CheckCircle2, CircleAlert, LockKeyhole, PlugZap } from 'lucide-react';
import type { PublicAiProviderSettings } from '@flowpilot/core';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label, Select } from '@/components/ui/primitives';
import { ApiError, apiFetch } from '@/lib/api-client';

type Notice = { kind: 'success' | 'error'; message: string } | null;

export function AiSettingsClient({ initialSettings }: { initialSettings: PublicAiProviderSettings }) {
  const [settings, setSettings] = useState(initialSettings);
  const [provider, setProvider] = useState(initialSettings.provider);
  const [baseUrl, setBaseUrl] = useState(initialSettings.baseUrl || 'https://api.openai.com/v1');
  const [model, setModel] = useState(initialSettings.model === 'rule-based-v1' ? '' : initialSettings.model);
  const [apiKey, setApiKey] = useState('');
  const [localCredentialProviders, setLocalCredentialProviders] = useState<string[]>([]);
  const [localCredentialProvider, setLocalCredentialProvider] = useState('');
  const [busy, setBusy] = useState<'save' | 'test' | 'import' | null>(null);
  const [notice, setNotice] = useState<Notice>(null);

  useEffect(() => {
    let cancelled = false;
    void apiFetch<{ providers: string[] }>('/api/settings/ai/local-credentials')
      .then((result) => {
        if (!cancelled) {
          setLocalCredentialProviders(result.providers);
          setLocalCredentialProvider('');
        }
      })
      .catch(() => {
        if (!cancelled) setLocalCredentialProviders([]);
      });
    return () => { cancelled = true; };
  }, []);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy('save');
    setNotice(null);
    try {
      const result = await apiFetch<{ settings: PublicAiProviderSettings }>('/api/settings/ai', {
        method: 'PUT',
        json: {
          provider,
          ...(provider === 'openai-compatible' ? { baseUrl, model, ...(apiKey ? { apiKey } : {}) } : {}),
        },
      });
      setSettings(result.settings);
      setApiKey('');
      setNotice({ kind: 'success', message: 'AI settings saved. The API key is encrypted on the server and cannot be read back.' });
    } catch (error) {
      setNotice({ kind: 'error', message: error instanceof ApiError ? error.explain : error instanceof Error ? error.message : 'Settings could not be saved.' });
    } finally {
      setBusy(null);
    }
  }

  async function testConnection() {
    setBusy('test');
    setNotice(null);
    try {
      const result = await apiFetch<{ ok: true; provider: string; model: string; externalRequest: boolean }>('/api/settings/ai', { method: 'POST' });
      setNotice({
        kind: 'success',
        message: result.externalRequest
          ? `Connected to ${result.provider} · ${result.model}. A small test request was sent; no customer data was included.`
          : 'The deterministic offline analyzer is active. No external connection was made.',
      });
    } catch (error) {
      setNotice({ kind: 'error', message: error instanceof ApiError ? error.explain : error instanceof Error ? error.message : 'Connection test failed.' });
    } finally {
      setBusy(null);
    }
  }

  async function importLocalKey() {
    setBusy('import');
    setNotice(null);
    try {
      const result = await apiFetch<{ settings: PublicAiProviderSettings; importedFrom: string }>('/api/settings/ai/import-local-key', {
        method: 'POST',
        json: { localProvider: localCredentialProvider, baseUrl, model },
      });
      setSettings(result.settings);
      setProvider('openai-compatible');
      setApiKey('');
      setNotice({ kind: 'success', message: `Imported the ${result.importedFrom} key on the server and saved it encrypted. The key was never sent to the browser.` });
    } catch (error) {
      setNotice({ kind: 'error', message: error instanceof ApiError ? error.explain : error instanceof Error ? error.message : 'The local key could not be imported.' });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-accent">Workspace settings</p>
        <h1 className="mt-1 text-xl font-semibold tracking-tight text-ink-900">AI provider</h1>
        <p className="mt-1 max-w-2xl text-sm text-ink-500">
          Configure the analyzer for this organization. The setting applies to Dashboard and MCP request analysis.
        </p>
      </div>

      {notice ? (
        <div role={notice.kind === 'error' ? 'alert' : 'status'} className={`flex items-start gap-2 rounded-lg border px-3 py-2.5 text-sm ${notice.kind === 'error' ? 'border-red-200 bg-red-50 text-red-800' : 'border-emerald-200 bg-emerald-50 text-emerald-800'}`}>
          {notice.kind === 'error' ? <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> : <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />}
          <span>{notice.message}</span>
        </div>
      ) : null}

      <Card>
        <CardHeader className="items-start">
          <div>
            <CardTitle>Request analysis</CardTitle>
            <CardDescription className="mt-1">Choose an offline rules engine or an OpenAI-compatible API.</CardDescription>
          </div>
          <span className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${settings.keyConfigured && settings.provider === 'openai-compatible' ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-600'}`}>
            {settings.keyConfigured && settings.provider === 'openai-compatible' ? 'Key saved' : settings.provider === 'deterministic' ? 'Offline' : 'Key required'}
          </span>
        </CardHeader>
        <CardContent>
          <form className="space-y-5" onSubmit={(event) => void save(event)}>
            <div className="space-y-1.5">
              <Label htmlFor="ai-provider">Provider mode</Label>
              <Select id="ai-provider" value={provider} onChange={(event) => {
                const nextProvider = event.target.value as typeof provider;
                setProvider(nextProvider);
                if (nextProvider === 'deterministic') setApiKey('');
              }}>
                <option value="deterministic">Offline rules (no external API)</option>
                <option value="openai-compatible">OpenAI-compatible API</option>
              </Select>
            </div>

            {provider === 'openai-compatible' ? (
              <div className="space-y-4 rounded-lg border border-line bg-slate-50/70 p-4">
                <div className="space-y-1.5">
                  <Label htmlFor="ai-base-url">API base URL</Label>
                  <Input id="ai-base-url" type="url" required value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://api.example.com/v1" autoComplete="url" />
                  <p className="text-[11px] text-ink-500">Use the provider's OpenAI-compatible base URL. FlowPilot appends <code>/chat/completions</code>.</p>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="ai-model">Model name</Label>
                  <Input id="ai-model" required value={model} onChange={(event) => setModel(event.target.value)} placeholder="Enter the model ID from your provider" autoComplete="off" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="ai-api-key">API key</Label>
                  <Input id="ai-api-key" type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={settings.source === 'organization' && settings.keyConfigured ? 'Saved securely · leave blank to keep current key' : 'Enter a key to save organization settings'} autoComplete="new-password" spellCheck={false} />
                  <p className="flex items-center gap-1.5 text-[11px] text-ink-500"><LockKeyhole className="h-3.5 w-3.5" aria-hidden />The saved key is encrypted at rest and never returned to this page.</p>
                </div>
                {localCredentialProviders.length > 0 ? (
                  <div className="flex flex-wrap items-end gap-2 rounded-lg border border-indigo-100 bg-white p-3">
                    <div className="min-w-48 flex-1 space-y-1.5">
                      <Label htmlFor="local-ai-key">Use a key from this machine</Label>
                      <Select id="local-ai-key" value={localCredentialProvider} onChange={(event) => setLocalCredentialProvider(event.target.value)}>
                        <option value="">Choose a saved credential</option>
                        {localCredentialProviders.map((name) => <option key={name} value={name}>{name}</option>)}
                      </Select>
                      <p className="text-[11px] text-ink-500">The server imports the key from the local credential store; the browser only receives its provider name.</p>
                    </div>
                    <Button type="button" variant="secondary" loading={busy === 'import'} disabled={busy !== null || !localCredentialProvider || !model.trim() || !baseUrl.trim()} onClick={() => void importLocalKey()}>
                      Import key and save
                    </Button>
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="rounded-lg border border-line bg-slate-50 px-3 py-3 text-xs text-ink-600">
                Offline rules run locally and need no API key. Save this choice to disable any organization-level external provider.
              </div>
            )}

            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-3 text-xs leading-relaxed text-amber-900">
              When someone analyzes an inbox request, its message text and this organization's candidate client, project, and team names are sent to the selected provider. The connection test sends only a small synthetic check and no customer data.
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit" loading={busy === 'save'} disabled={busy !== null}>Save settings</Button>
              <Button type="button" variant="secondary" loading={busy === 'test'} disabled={busy !== null || (provider === 'openai-compatible' && !settings.keyConfigured)} onClick={() => void testConnection()}>
                <PlugZap className="h-4 w-4" aria-hidden /> Test saved connection
              </Button>
              {settings.updatedAt ? <span className="text-[11px] text-ink-500">Updated {new Date(settings.updatedAt).toLocaleString()}</span> : null}
            </div>
          </form>
        </CardContent>
      </Card>

      <p className="text-[11px] text-ink-500">
        {settings.source === 'environment' ? 'Current settings are inherited from the server environment until an organization setting is saved.' : 'Only organization owners and admins can change this provider.'}
      </p>
    </div>
  );
}
