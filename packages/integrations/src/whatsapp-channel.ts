/**
 * Channel driver contract.
 *
 * The WhatsApp adapter doesn't bake the Meta Graph API into itself: a "Channel" abstracts the
 * actual sending surface. In production we drive Meta's Cloud API; in tests and offline
 * demos we drive an in-memory mock that records every send and lets us script 4xx / 5xx
 * outcomes.
 *
 * Each driver answers *one* question: "deliver this body to this recipient, return whatever
 * the provider answered". It does **not** decide approvals; the `OutboundActionService` does
 * that. State-machine mismatches are caught upstream.
 */

export interface ChannelDriver {
  readonly providerId: string;
  /** True when the driver holds real credentials — false for tests / offline / demo mode. */
  readonly live: boolean;
  /** Sends a payload to the channel. Errors are returned, not raised, so the caller logs once. */
  send(input: SendInput): Promise<SendResult>;
}

export interface SendInput {
  to: string;
  subject?: string | null;
  body: string;
  /** Optional idempotency hint. Drivers must echo this back in the result when they have it. */
  dedupeKey?: string;
  /** Channel-specific metadata that the driver may surface in logs (template name, etc.). */
  metadata?: Record<string, unknown>;
}

export interface SendResult {
  ok: boolean;
  /** Provider message id when ok=true. Used by the webhook to update the row to `sent`. */
  externalMessageId?: string;
  /** Provider error code as a string when ok=false (e.g. "429", "131030"). */
  errorCode?: string;
  errorTitle?: string;
  errorBody?: string;
  /** A normalized retry hint — true when transient (5xx/429), false when permanent. */
  retryable?: boolean;
  /** Raw provider response for audit. Driver may subset it. */
  providerResponse?: Record<string, unknown>;
}

/**
 * Mock channel driver.
 *
 * Why a Mock Channel even though MockEmailAdapter already exists: an Email adapter normalizes
 * *inbound* messages and triggers downstream pipeline, while the Outbound Channel is the only
 * path that *sends*. Failing to keep these two clearly separated would mean "Mock" secretly
 * performs real network calls — exactly the thing a future Gmail connector must never do in
 * test runs.
 */
export class MockWhatsAppChannel implements ChannelDriver {
  readonly providerId = 'mock-whatsapp';
  readonly live = false;

  /** Scripted outcomes: when matched by `dedupeKey`, return the preset result. */
  public scripted: Map<string, SendResult> = new Map();
  /** Bookkeeping for the dashboard / test assertions. */
  public calls: Array<{ at: string; to: string; body: string; dedupeKey?: string }> = [];
  /** If set, every send returns this error unless the dedupeKey was scripted. */
  public defaultFailure: SendResult | null = null;

  async send(input: SendInput): Promise<SendResult> {
    this.calls.push({
      at: new Date().toISOString(),
      to: input.to,
      body: input.body,
      dedupeKey: input.dedupeKey,
    });
    if (input.dedupeKey && this.scripted.has(input.dedupeKey)) {
      return this.scripted.get(input.dedupeKey)!;
    }
    if (this.defaultFailure) return this.defaultFailure;
    return {
      ok: true,
      externalMessageId: `mock-msg-${(this.calls.length).toString().padStart(6, '0')}`,
      providerResponse: { mocked: true, providerId: this.providerId },
    };
  }
}

/**
 * Real Meta Cloud API channel driver.
 *
 * We never construct one of these at import time — the webhook controller reads
 * `IntegrationConnection.config` and instantiates the real driver only when the connection is
 * `live=true`, so the test suite can run without a real token. Failure modes are documented
 * at https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes.
 */
export interface WhatsAppCloudConfig {
  apiBase: string;          // e.g. 'https://graph.facebook.com/v20.0'
  accessToken: string;
  phoneNumberId: string;
  businessAccountId?: string;
  /** Optional override for testing; defaults to 8000. */
  timeoutMs?: number;
  /** Pluggable fetch for tests; defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
}

export class WhatsAppCloudChannel implements ChannelDriver {
  readonly providerId = 'whatsapp-cloud';
  readonly live = true;

  constructor(private readonly config: WhatsAppCloudConfig) {
    if (!config.apiBase) throw new Error('WhatsAppCloudChannel: apiBase is required');
    if (!config.accessToken) throw new Error('WhatsAppCloudChannel: accessToken is required');
    if (!config.phoneNumberId) throw new Error('WhatsAppCloudChannel: phoneNumberId is required');
  }

  async send(input: SendInput): Promise<SendResult> {
    const url = `${this.config.apiBase.replace(/\/$/, '')}/${this.config.phoneNumberId}/messages`;
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: input.to,
      type: 'text',
      text: { preview_url: false, body: input.body.slice(0, 4096) },
      // ... `biz_opaque_callback_data` could be used to thread dedupeKey back to status
      // webhooks; we omit it here so the demo path stays simple.
    } as Record<string, unknown>;

    try {
      const fetchImpl = this.config.fetchImpl ?? fetch;
      const resp = await fetchImpl(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.config.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.config.timeoutMs ?? 8000),
      });
      const json = (await resp.json().catch(() => ({}))) as {
        messages?: Array<{ id?: string }>;
        error?: { code?: number; title?: string; message?: string };
      };
      if (resp.ok && json.messages?.[0]?.id) {
        return {
          ok: true,
          externalMessageId: json.messages[0].id,
          retryable: false,
          providerResponse: json as Record<string, unknown>,
        };
      }
      const retryable = resp.status === 429 || resp.status >= 500;
      return {
        ok: false,
        errorCode: json.error?.code != null ? String(json.error.code) : String(resp.status),
        errorTitle: json.error?.title ?? `HTTP ${resp.status}`,
        errorBody: json.error?.message ?? '',
        retryable,
        providerResponse: json as Record<string, unknown>,
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
