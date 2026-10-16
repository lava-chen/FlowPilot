import { IntegrationError } from '@flowpilot/shared';
import type { NormalizedInboundMessage } from '@flowpilot/core';
import type { IntegrationAdapter, IngestionOutcome } from './adapter.js';

/**
 * The v0.1 integration: a simulated inbound mailbox.
 *
 * It implements the same `IntegrationAdapter` interface a Gmail connector will implement, so it
 * is a working demonstration of the seam rather than a special case in the pipeline. The canned
 * messages are Northline's (fictional) clients asking for revisions — the same shape of ask the
 * real connector will deliver.
 */
export class MockEmailAdapter implements IntegrationAdapter {
  readonly provider = 'mock-email';
  readonly displayName = 'Mock inbound email';
  readonly simulateInUi = true;

  /** Canned inbound messages, addressed to Marcus at Northline. */
  static readonly templates: EmailTemplate[] = [
    {
      id: 'harbor-logo',
      label: 'Harbor Coffee — logo pops off the end card',
      fromName: 'Alice Nguyen',
      from: 'alice@harborcoffee.com',
      subject: 'Re: Fall Cold Brew hero — logo pops off on frame 4',
      body: `Hi Marcus,

Watched the newest Harbor Coffee hero cut again with our media team. The logo jumps off screen around 00:04 when the pour settles, and the end card only holds it for about a second.

Can you get a revision that scales the logo down and holds it for the full end card? Keep the steam effect, the client loves it.

We need this back before the paid flight starts.

Thanks,
Alice`,
    },
    {
      id: 'lumen-cutdown',
      label: 'Lumen Fitness — Creator 3 hook + 15s retargeting cut',
      fromName: 'Dev Patel',
      from: 'dev@lumenfitness.com',
      subject: 'Creator 3 edit — hook feels slow in the first 2 seconds',
      body: `Hey Priya,

Creator 3's edit opens on a wide shot and it takes about two seconds to reach the movement. Could we open on the close-up of the band and cut the intro?

Also, if there is room, we would love an alternate 15s version cut specifically for the retargeting audience — that one can be more aggressive.

Dev from Lumen`,
    },
    {
      id: 'cedar-captions',
      label: 'Cedar & Sage — captions + Thursday delivery',
      fromName: 'Rosa Iversen',
      from: 'rosa@cedarsage.co',
      subject: 'Teaser cuts — captions needed, deliver by Thursday',
      body: `Hi team,

Loving the direction on the serum refill teaser. Two things from our accessibility check: we need burned-in captions on both cuts, and our social lead wants them by Thursday end of day so she can schedule the launch post.

Rosa`,
    },
    {
      id: 'lumen-music-license',
      label: 'Lumen Fitness — license extension for the music bed',
      fromName: 'Dev Patel',
      from: 'dev@lumenfitness.com',
      subject: 'Music bed license — need an extension for Q4',
      body: `Quick one. The track you cleared for the creator series expires at the end of the quarter and we want to keep using it through Q4.

Can you handle the extension and let me know the cost?

Dev`,
    },
    {
      id: 'harbor-store-retouch',
      label: 'Harbor Coffee retail — 22 SKU retouch batch',
      fromName: 'Alice Nguyen',
      from: 'alice@harborcoffee.com',
      subject: 'Retail retouch batch — 22 SKUs, where does it stand?',
      body: `Hey Marcus,

Our site team is chasing the Harbor Coffee retail retouch batch — 22 SKUs. We had this in the deck as delivered last week and it never showed up in the shared drive.

Can you confirm where it stands today? This is blocking the site refresh.

Alice`,
    },
  ];

  static template(id: string): EmailTemplate {
    const found = MockEmailAdapter.templates.find((t) => t.id === id);
    if (!found) {
      throw new IntegrationError(`Unknown mock email template "${id}".`, {
        available: MockEmailAdapter.templates.map((t) => t.id),
      });
    }
    return found;
  }

  static message(templateId: string, sequence: number): NormalizedInboundMessage {
    const template = MockEmailAdapter.template(templateId);
    return {
      provider: 'mock-email',
      externalId: `mock-msg-${template.id}-${sequence}`,
      from: template.from,
      fromName: template.fromName,
      subject: template.subject,
      body: template.body,
      receivedAt: new Date().toISOString(),
    };
  }

  async poll(): Promise<IngestionOutcome> {
    // Nothing to fetch: this adapter is triggered manually from the dashboard.
    return { accepted: [], duplicates: [], drafts: [], runIds: [] };
  }

  normalize(payload: NormalizedInboundMessage): NormalizedInboundMessage {
    return {
      provider: this.provider,
      externalId: payload.externalId,
      from: payload.from,
      fromName: payload.fromName,
      subject: payload.subject.replace(/\s+/g, ' ').trim(),
      body: payload.body.replace(/\r\n/g, '\n').trim(),
      receivedAt: payload.receivedAt ?? new Date().toISOString(),
    };
  }

  listTemplates(): Array<{ id: string; label: string; from: string; subject: string; preview: string }> {
    return MockEmailAdapter.templates.map((t) => ({
      id: t.id,
      label: t.label,
      from: `${t.fromName} <${t.from}>`,
      subject: t.subject,
      preview: t.body.split('\n').filter(Boolean)[0]?.slice(0, 120) ?? '',
    }));
  }

  /** Not used by the mock adapter; present to satisfy the adapter contract. */
  verifyWebhook(_headers: Record<string, string | undefined>, _rawBody: string): boolean {
    return true;
  }
}

export interface EmailTemplate {
  id: string;
  label: string;
  fromName: string;
  from: string;
  subject: string;
  body: string;
}
