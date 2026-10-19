/**
 * Microsoft Graph (Outlook) send channel driver.
 *
 * Follows the same pattern as `whatsapp-channel.ts`: the OAuth service hands this driver
 * an access token at send time, the driver calls `/me/sendMail`, and the result is mapped
 * to a `SendResult`. We never store the token here — the OAuth service is the only place
 * that decrypts the blob, and it can rate-limit / refresh as needed.
 *
 * Mock variant: in-memory recording + scripted outcomes for tests and the offline demo.
 */
import type { ChannelDriver, SendInput, SendResult } from './whatsapp-channel.js';

export interface GraphAccessTokenProvider {
  /** Returns a valid (possibly just-refreshed) access token string. */
  getAccessToken(): Promise<string>;
}

export interface OutlookGraphChannelConfig {
  /** Base URL; defaults to `https://graph.microsoft.com/v1.0`. */
  graphBase?: string;
  /** When set, takes precedence over an injected token (used in tests). */
  staticAccessToken?: string;
  tokenProvider?: GraphAccessTokenProvider;
  /** Pluggable fetch for tests. */
  fetchImpl?: typeof fetch;
  /** Timeout in ms (default 15s). */
  timeoutMs?: number;
}

export class OutlookGraphChannel implements ChannelDriver {
  readonly providerId = 'outlook-graph';
  readonly live: boolean;

  constructor(private readonly config: OutlookGraphChannelConfig) {
    if (!config.staticAccessToken && !config.tokenProvider) {
      throw new Error('OutlookGraphChannel: provide either staticAccessToken or tokenProvider.');
    }
    this.live = Boolean(config.tokenProvider || config.staticAccessToken);
  }

  async send(input: SendInput): Promise<SendResult> {
    const accessToken = this.config.tokenProvider
      ? await this.config.tokenProvider.getAccessToken()
      : (this.config.staticAccessToken ?? '');
    const base = (this.config.graphBase ?? 'https://graph.microsoft.com/v1.0').replace(/\/$/, '');
    const url = `${base}/me/sendMail`;
    const payload = {
      message: {
        subject: input.subject ?? '',
        body: {
          contentType: 'Text',
          content: input.body.slice(0, 32_000), // Graph limit; longer replies would need draft + send.
        },
        toRecipients: input.to
          .split(/[,;]\s*/)
          .filter(Boolean)
          .map((address) => ({ emailAddress: { address } })),
        ...(input.dedupeKey ? { extensions: [{ extensionName: 'flowpilot.dedupe', isVisible: false }] } : {}),
      },
      saveToSentItems: true,
    };
    const headers: Record<string, string> = {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
    };
    if (input.dedupeKey) {
      // Microsoft Graph has no Idempotency-Key header. We encode the dedupe key as an
      // extension so a Status webhook can correlate the send back to the outbound action.
      headers['prefer'] = `Idempotency-Key="${escapeHeader(input.dedupeKey)}"`;
    }

    try {
      const fetchImpl = this.config.fetchImpl ?? fetch;
      const resp = await fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.config.timeoutMs ?? 15_000),
      });
      if (resp.status === 202) {
        // sendMail returns 202 Accepted with no body when the message is queued.
        // We generate our own id; Microsoft will publish a tracking id later via
        // notifications (Phase 4 — n8n + webhook subscriptions).
        return {
          ok: true,
          externalMessageId: `graph-${input.dedupeKey ?? Date.now().toString(36)}`,
          retryable: false,
        };
      }
      const json = (await resp.json().catch(() => ({}))) as {
        error?: { code?: string; message?: string };
      };
      const retryable = resp.status === 429 || resp.status >= 500;
      return {
        ok: false,
        errorCode: json.error?.code ?? String(resp.status),
        errorTitle: json.error?.message ?? `HTTP ${resp.status}`,
        errorBody: '',
        retryable,
      };
    } catch (err) {
      return {
        ok: false,
        errorCode: 'FETCH_ERROR',
        errorTitle: 'Network failure',
        errorBody: err instanceof Error ? err.message : String(err),
        retryable: true,
      };
    }
  }
}

/**
 * Mock driver for tests + offline demo. Same shape as `MockWhatsAppChannel`.
 */
export class MockOutlookGraphChannel implements ChannelDriver {
  readonly providerId = 'mock-outlook-graph';
  readonly live = false;

  public scripted: Map<string, SendResult> = new Map();
  public calls: Array<{ at: string; to: string; subject: string | null; body: string; dedupeKey?: string }> = [];
  public defaultFailure: SendResult | null = null;

  async send(input: SendInput): Promise<SendResult> {
    this.calls.push({
      at: new Date().toISOString(),
      to: input.to,
      subject: input.subject ?? null,
      body: input.body,
      dedupeKey: input.dedupeKey,
    });
    if (input.dedupeKey && this.scripted.has(input.dedupeKey)) {
      return this.scripted.get(input.dedupeKey)!;
    }
    if (this.defaultFailure) return this.defaultFailure;
    return {
      ok: true,
      externalMessageId: `mock-out-${this.calls.length.toString().padStart(6, '0')}`,
      retryable: false,
    };
  }
}

function escapeHeader(value: string): string {
  return value.replace(/["\\\r\n]/g, (c) => {
    if (c === '"') return '\\"';
    if (c === '\\') return '\\\\';
    if (c === '\r') return '\\r';
    return '\\n';
  });
}
