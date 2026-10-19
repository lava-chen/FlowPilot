import { describe, expect, it } from 'vitest';
import {
  MockOutlookGraphChannel,
  OutlookGraphChannel,
} from '../src/outlook-channel.js';
import {
  normalizeOutlookMessage,
  normalizeOutlookMessages,
  outlookEventToNormalized,
} from '../src/outlook-normalizer.js';
import { OutlookAdapter } from '../src/outlook-adapter.js';

describe('normalizeOutlookMessage', () => {
  it('reads the from email + body for a plain text message', () => {
    const out = normalizeOutlookMessage({
      id: 'AAMkAD...',
      subject: 'Re: Q4 launch',
      receivedDateTime: '2026-10-18T08:00:00Z',
      bodyPreview: 'Hi — sending the proposal...',
      from: { emailAddress: { name: 'Casey Customer', address: 'casey@example.com' } },
      toRecipients: [{ emailAddress: { address: 'agency@northline.test' } }],
      body: { contentType: 'Text', content: 'Hi team,\n\nPlease find attached our brief.\nThanks.' },
      parentFolderId: 'AAMkAD_folder_inbox',
      '@odata.etag': 'etag-1',
    });
    expect(out).toMatchObject({
      externalId: 'AAMkAD...',
      from: 'casey@example.com',
      fromName: 'Casey Customer',
      subject: 'Re: Q4 launch',
      folder: 'inbox',
      directlyAddressed: true,
    });
    expect(out?.body).toContain('Please find attached our brief.');
    expect(out?.to).toEqual(['agency@northline.test']);
  });

  it('falls back to bodyPreview when the body is missing', () => {
    const out = normalizeOutlookMessage({
      id: 'm1',
      receivedDateTime: '2026-10-18T09:00:00Z',
      from: { emailAddress: { address: 'a@b.test' } },
      bodyPreview: 'preview-only',
    });
    expect(out?.body).toBe('preview-only');
  });

  it('strips HTML but preserves paragraph breaks', () => {
    const out = normalizeOutlookMessage({
      id: 'm2',
      receivedDateTime: '2026-10-18T09:00:00Z',
      from: { emailAddress: { address: 'a@b.test' } },
      body: {
        contentType: 'HTML',
        content: '<p>Hello&nbsp;team</p><br><p>Here is the <a href="x">brief</a></p>',
      },
    });
    expect(out?.body).toContain('Hello team');
    expect(out?.body).toContain('brief');
  });

  it('marks junk-email folder so the sync service can drop it', () => {
    const out = normalizeOutlookMessage({
      id: 'm3',
      receivedDateTime: '2026-10-18T09:00:00Z',
      from: { emailAddress: { address: 'spam@bad.test' } },
      parentFolderId: 'junk',
    });
    expect(out?.folder).toBe('junkemail');
  });

  it('returns null when id or sender is missing', () => {
    expect(normalizeOutlookMessage({ id: '', from: { emailAddress: { address: 'a@b' } } })).toBeNull();
    expect(normalizeOutlookMessage({ id: 'm', from: { emailAddress: { address: '   ' } } })).toBeNull();
  });
});

describe('normalizeOutlookMessages', () => {
  it('drops messages that fail validation', () => {
    const { messages } = normalizeOutlookMessages([
      { id: 'good', receivedDateTime: '2026-10-18T09:00:00Z', from: { emailAddress: { address: 'ok@b.test' } } },
      { id: '', from: { emailAddress: { address: 'ok@b.test' } } },
      { id: 'no-from', from: {} },
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.externalId).toBe('good');
  });
});

describe('outlookEventToNormalized', () => {
  it('formats the sender and drops optional fields zod would not validate', () => {
    const normalized = outlookEventToNormalized('outlook-graph', {
      externalId: 'm1',
      from: 'casey@example.com',
      fromName: 'Casey Customer',
      subject: 'Subject',
      body: 'body',
      receivedAt: '2026-10-18T10:00:00Z',
      to: ['agency@northline.test'],
      folder: 'inbox',
      directlyAddressed: true,
      changeKey: 'etag-1',
    });
    expect(normalized.from).toBe('Casey Customer <casey@example.com>');
    expect(normalized.subject).toBe('Subject');
    expect(normalized.body).toBe('body');
    expect(normalized.provider).toBe('outlook-graph');
  });
});

describe('OutlookAdapter', () => {
  it('exposes the right provider id and rejects webhooks', () => {
    const a = new OutlookAdapter();
    expect(a.provider).toBe('outlook-graph');
    expect(a.verifyWebhook?.({} as Record<string, string | undefined>, '')).toBe(false);
    expect(a.simulateInUi).toBe(false);
  });

  it('normalizes a payload', () => {
    const a = new OutlookAdapter();
    const out = a.normalize({
      provider: 'outlook-graph',
      externalId: 'x',
      from: 'a@b.test',
      fromName: 'A',
      subject: 'Hello',
      body: 'body line',
      receivedAt: '2026-10-18T10:00:00Z',
    });
    expect(out.provider).toBe('outlook-graph');
    expect(out.subject).toBe('Hello');
  });
});

describe('MockOutlookGraphChannel', () => {
  it('records calls and returns a mock id', async () => {
    const ch = new MockOutlookGraphChannel();
    const result = await ch.send({ to: 'a@b.test', body: 'hello', subject: 'hi' });
    expect(result.ok).toBe(true);
    expect(result.externalMessageId).toMatch(/^mock-out-/);
    expect(ch.calls[0]).toMatchObject({ to: 'a@b.test', subject: 'hi' });
  });

  it('returns a scripted failure when dedupeKey matches', async () => {
    const ch = new MockOutlookGraphChannel();
    ch.scripted.set('dedupe-7', {
      ok: false,
      errorCode: 'ErrorItemNotFound',
      errorTitle: 'mailbox not found',
      retryable: false,
    });
    const result = await ch.send({ to: 'a@b.test', body: 'hi', dedupeKey: 'dedupe-7' });
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('ErrorItemNotFound');
  });
});

describe('OutlookGraphChannel', () => {
  it('rejects construction without an access source', () => {
    expect(() => new OutlookGraphChannel({})).toThrow();
  });

  it('returns ok=true with a generated id when Graph returns 202', async () => {
    const ch = new OutlookGraphChannel({
      staticAccessToken: 'TEST_TOKEN',
      fetchImpl: (async (url: string, init?: RequestInit) => {
        expect(url).toBe('https://graph.microsoft.com/v1.0/me/sendMail');
        expect(init?.method).toBe('POST');
        const body = JSON.parse(String(init?.body));
        expect(body.message.toRecipients[0].emailAddress.address).toBe('a@b.test');
        return new Response(null, { status: 202 });
      }) as typeof fetch,
    });
    const result = await ch.send({ to: 'a@b.test', body: 'hi', dedupeKey: 'k1' });
    expect(result.ok).toBe(true);
    expect(result.externalMessageId).toMatch(/^graph-k1$/);
  });

  it('returns a non-retryable failure on Graph 4xx', async () => {
    const ch = new OutlookGraphChannel({
      staticAccessToken: 'TEST_TOKEN',
      fetchImpl: (async () =>
        new Response(JSON.stringify({ error: { code: 'ErrorInvalidRecipients', message: 'No such recipient' } }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        })) as typeof fetch,
    });
    const result = await ch.send({ to: 'a@b.test', body: 'hi' });
    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(false);
    expect(result.errorTitle).toBe('No such recipient');
  });

  it('returns a retryable failure on Graph 5xx', async () => {
    const ch = new OutlookGraphChannel({
      staticAccessToken: 'TEST_TOKEN',
      fetchImpl: (async () =>
        new Response(JSON.stringify({ error: { code: 'ErrorServerBusy', message: 'throttled' } }), {
          status: 503,
        })) as typeof fetch,
    });
    const result = await ch.send({ to: 'a@b.test', body: 'hi' });
    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(true);
  });
});
