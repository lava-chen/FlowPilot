import { describe, expect, it } from 'vitest';
import {
  signWhatsAppBody,
  verifyWhatsAppHandshake,
  verifyWhatsAppSignature,
} from '../src/signature.js';
import { normalizeWhatsAppPayload } from '../src/whatsapp-normalizer.js';
import { extractBodyFromMessage } from '../src/whatsapp-normalizer.js';
import {
  MockWhatsAppChannel,
  WhatsAppCloudChannel,
} from '../src/whatsapp-channel.js';

describe('verifyWhatsAppSignature', () => {
  it('accepts a correctly-signed body', () => {
    const appSecret = 'super-secret-key';
    const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });
    const header = signWhatsAppBody(appSecret, body);
    expect(verifyWhatsAppSignature({ appSecret, signatureHeader: header, rawBody: body })).toBe(true);
  });

  it('rejects when the signature prefix is missing', () => {
    const appSecret = 'super-secret-key';
    const body = '{}';
    // compute a valid signature but strip the `sha256=` prefix
    const sig = signWhatsAppBody(appSecret, body).slice('sha256='.length);
    expect(verifyWhatsAppSignature({ appSecret, signatureHeader: sig, rawBody: body })).toBe(false);
  });

  it('rejects a tampered body even when the rest matches', () => {
    const appSecret = 'super-secret-key';
    const body = JSON.stringify({ hello: 'world' });
    const header = signWhatsAppBody(appSecret, body);
    expect(
      verifyWhatsAppSignature({ appSecret, signatureHeader: header, rawBody: body + ' ' }),
    ).toBe(false);
  });

  it('rejects an empty signature header', () => {
    expect(
      verifyWhatsAppSignature({ appSecret: 'k', signatureHeader: '', rawBody: '{}' }),
    ).toBe(false);
    expect(
      verifyWhatsAppSignature({ appSecret: 'k', signatureHeader: null, rawBody: '{}' }),
    ).toBe(false);
  });

  it('rejects when the body is empty', () => {
    expect(
      verifyWhatsAppSignature({ appSecret: '', signatureHeader: 'sha256=00', rawBody: '{}' }),
    ).toBe(false);
  });
});

describe('verifyWhatsAppHandshake', () => {
  it('accepts a valid mode + matching verify token', () => {
    expect(
      verifyWhatsAppHandshake({
        expectedVerifyToken: 'abc123',
        mode: 'subscribe',
        verifyToken: 'abc123',
      }),
    ).toBe(true);
  });
  it('rejects when the mode is not subscribe', () => {
    expect(
      verifyWhatsAppHandshake({ expectedVerifyToken: 'a', mode: 'unsubscribe', verifyToken: 'a' }),
    ).toBe(false);
  });
  it('rejects when tokens differ', () => {
    expect(
      verifyWhatsAppHandshake({ expectedVerifyToken: 'a', mode: 'subscribe', verifyToken: 'b' }),
    ).toBe(false);
  });
  it('trims whitespace on the expected and provided tokens', () => {
    expect(
      verifyWhatsAppHandshake({
        expectedVerifyToken: 'abc123',
        mode: 'subscribe',
        verifyToken: '  abc123 ',
      }),
    ).toBe(true);
  });
});

describe('extractBodyFromMessage', () => {
  it('returns the text body when present', () => {
    expect(extractBodyFromMessage({ type: 'text', text: { body: 'Hi there' } })).toEqual({
      type: 'text',
      body: 'Hi there',
    });
  });
  it('uses the caption when present for image messages', () => {
    expect(
      extractBodyFromMessage({
        type: 'image',
        image: { caption: 'Birthday cake ', id: 'media-1', mime_type: 'image/jpeg' },
      }),
    ).toEqual({ type: 'image', body: 'Birthday cake' });
  });
  it('falls back to a marker when an image has no caption', () => {
    expect(
      extractBodyFromMessage({ type: 'image', image: { id: 'media-2', mime_type: 'image/png' } }),
    ).toEqual({ type: 'image', body: '[image: no caption]' });
  });
  it('returns a short description for unsupported types', () => {
    expect(extractBodyFromMessage({ type: 'audio' })).toEqual({
      type: 'audio',
      body: '[audio message]',
    });
  });
});

describe('normalizeWhatsAppPayload', () => {
  const buildPayload = (entry: unknown) => ({
    object: 'whatsapp_business_account' as const,
    entry: entry as never,
  });

  it('flattens a single text message', () => {
    const { messages, statuses } = normalizeWhatsAppPayload({
      payload: buildPayload([
        {
          id: 'waba-1',
          changes: [
            {
              field: 'messages',
              value: {
                metadata: {
                  phone_number_id: 'pn-1',
                  display_phone_number: '+15555550100',
                },
                contacts: [{ profile: { name: 'Alice' }, wa_id: '15555550199' }],
                messages: [
                  {
                    id: 'wamid.001',
                    from: '15555550199',
                    timestamp: 1_700_000_000,
                    type: 'text',
                    text: { body: 'order a cake' },
                  },
                ],
              },
            },
          ],
        },
      ]),
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      externalId: 'wamid.001',
      from: '15555550199',
      fromName: 'Alice',
      phoneNumberId: 'pn-1',
      type: 'text',
      body: 'order a cake',
      businessAccountId: 'waba-1',
      displayPhoneNumber: '+15555550100',
    });
    expect(messages[0]?.receivedAt).toBe(new Date(1_700_000_000 * 1000).toISOString());
    expect(statuses).toEqual([]);
  });

  it('collects statuses alongside messages', () => {
    const { messages, statuses } = normalizeWhatsAppPayload({
      payload: buildPayload([
        {
          id: 'waba-1',
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: 'pn-1' },
                statuses: [
                  {
                    id: 'wamid.001',
                    status: 'delivered',
                    timestamp: 1_700_000_100,
                    recipient_id: '15555550199',
                  },
                ],
              },
            },
          ],
        },
      ]),
    });
    expect(messages).toEqual([]);
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toMatchObject({
      externalId: 'wamid.001',
      status: 'delivered',
      recipientId: '15555550199',
    });
  });

  it('records provider errors as part of the status payload', () => {
    const { statuses } = normalizeWhatsAppPayload({
      payload: buildPayload([
        {
          id: 'waba-1',
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: 'pn-1' },
                statuses: [
                  {
                    id: 'wamid.001',
                    status: 'failed',
                    timestamp: '1700000200',
                    recipient_id: '15555550199',
                    errors: [{ code: 131030, title: 'Recipient not in allowed list' }],
                  },
                ],
              },
            },
          ],
        },
      ]),
    });
    expect(statuses[0]).toMatchObject({
      status: 'failed',
      errorCode: '131030',
      errorTitle: 'Recipient not in allowed list',
    });
  });

  it('skips messages and statuses missing an id', () => {
    const { messages, statuses } = normalizeWhatsAppPayload({
      payload: buildPayload([
        {
          id: 'waba-1',
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: 'pn-1' },
                messages: [{ from: '1234' }, { id: 'ok', from: '1234', type: 'text', text: { body: 'hi' } }],
                statuses: [{ status: 'sent' }, { id: 'ok2', status: 'sent', recipient_id: 'r' }],
              },
            },
          ],
        },
      ]),
    });
    expect(messages).toHaveLength(1);
    expect(statuses).toHaveLength(1);
  });
});

describe('MockWhatsAppChannel', () => {
  it('records calls and returns a deterministic mock id', async () => {
    const ch = new MockWhatsAppChannel();
    const result = await ch.send({ to: '+15555550100', body: 'hi' });
    expect(result.ok).toBe(true);
    expect(result.externalMessageId).toBe('mock-msg-000001');
    expect(ch.calls).toHaveLength(1);
    expect(ch.calls[0]).toMatchObject({ to: '+15555550100', body: 'hi' });
  });

  it('returns a scripted outcome when the dedupeKey matches', async () => {
    const ch = new MockWhatsAppChannel();
    ch.scripted.set('dedupe-1', {
      ok: false,
      errorCode: '429',
      errorTitle: 'Rate limited',
      errorBody: 'try later',
      retryable: true,
    });
    const result = await ch.send({ to: '+1', body: 'hi', dedupeKey: 'dedupe-1' });
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('429');
    expect(result.retryable).toBe(true);
  });

  it('can simulate a default failure for all calls', async () => {
    const ch = new MockWhatsAppChannel();
    ch.defaultFailure = { ok: false, errorCode: '500', errorTitle: 'Server error', retryable: true };
    const result = await ch.send({ to: '+1', body: 'hi' });
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('500');
  });
});

describe('WhatsAppCloudChannel', () => {
  it('rejects constructor without required config', () => {
    expect(
      () => new WhatsAppCloudChannel({ apiBase: '', accessToken: 'a', phoneNumberId: 'p' }),
    ).toThrow();
    expect(
      () => new WhatsAppCloudChannel({ apiBase: 'https://example.com', accessToken: '', phoneNumberId: 'p' }),
    ).toThrow();
    expect(
      () => new WhatsAppCloudChannel({ apiBase: 'https://example.com', accessToken: 'a', phoneNumberId: '' }),
    ).toThrow();
  });

  it('sends a message and returns the provider id on success', async () => {
    const ch = new WhatsAppCloudChannel({
      apiBase: 'https://graph.example.com/v20.0',
      accessToken: 'test-token',
      phoneNumberId: 'pn-42',
      fetchImpl: (async (url: string, init?: RequestInit) => {
        expect(url).toBe('https://graph.example.com/v20.0/pn-42/messages');
        expect(init?.method).toBe('POST');
        const body = JSON.parse(String(init?.body));
        expect(body).toMatchObject({
          messaging_product: 'whatsapp',
          to: '+15555550100',
          type: 'text',
        });
        return new Response(JSON.stringify({ messages: [{ id: 'wamid.live-1' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof fetch,
    });
    const result = await ch.send({ to: '+15555550100', body: 'hello' });
    expect(result.ok).toBe(true);
    expect(result.externalMessageId).toBe('wamid.live-1');
  });

  it('returns a retryable error on HTTP 5xx', async () => {
    const ch = new WhatsAppCloudChannel({
      apiBase: 'https://graph.example.com/v20.0',
      accessToken: 't',
      phoneNumberId: 'pn',
      fetchImpl: (async () =>
        new Response(JSON.stringify({ error: { code: 1, title: 'Server', message: 'boom' } }), {
          status: 503,
        })) as typeof fetch,
    });
    const result = await ch.send({ to: '+1', body: 'hi' });
    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(true);
    expect(result.errorCode).toBe('1');
  });

  it('returns a non-retryable error on HTTP 4xx', async () => {
    const ch = new WhatsAppCloudChannel({
      apiBase: 'https://graph.example.com/v20.0',
      accessToken: 't',
      phoneNumberId: 'pn',
      fetchImpl: (async () =>
        new Response(JSON.stringify({ error: { code: 131030, title: 'Recipient not in allowed list' } }), {
          status: 400,
        })) as typeof fetch,
    });
    const result = await ch.send({ to: '+1', body: 'hi' });
    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(false);
    expect(result.errorTitle).toBe('Recipient not in allowed list');
  });
});
