import { describe, expect, it, beforeEach } from 'vitest';
import { createTestContext, ADMIN_EMAIL, MANAGER_EMAIL, type TestContext } from './harness.js';
import { OAuthService } from '../src/outlook-oauth.service.js';
import { OutlookSyncService, type OutlookProviderConfig } from '../src/outlook-sync.service.js';
import { encryptSecret } from '../src/ai/settings-crypto.js';
import { nowIso } from '@flowpilot/shared';
import { MockOutlookGraphChannel } from '@flowpilot/integrations';

const ROOT_SECRET = 'outlook-draft-test-session-secret-32chars';

const PROVIDER: OutlookProviderConfig = {
  clientId: 'fp-test-client',
  clientSecret: 'fp-test-secret',
  tenantId: 'common',
  redirectUri: 'http://localhost:3000/api/integrations/outlook-graph/oauth/callback',
  graphBase: 'https://graph.example.com/v1.0',
  authorizeEndpoint: 'https://login.example.com/common/oauth2/v2.0/authorize',
  tokenEndpoint: 'https://login.example.com/common/oauth2/v2.0/token',
};

/**
 * Outlook draft + send chain (Integration Hardening, P0 #2).
 *
 * Two things were broken before this round:
 *   1. `tryCreateDraft` returned `false` unconditionally, so a synced email produced an inbox row
 *      and nothing else — there was no path from "mail arrived" to "human approves a reply".
 *   2. The send route handed every non-WhatsApp provider to `MockWhatsAppChannel`, so an
 *      `outlook-graph` outbound action was dispatched over the *wrong channel entirely*.
 *
 * These tests walk the whole chain against a real database with only the HTTP boundary faked.
 */
describe('Outlook draft and send chain', () => {
  let ctx: TestContext;
  beforeEach(async () => {
    ctx = await createTestContext();
  });

  async function seedTokens(orgId: string): Promise<void> {
    const access = encryptSecret('token', ROOT_SECRET, 'oauthAccess');
    const refresh = encryptSecret('refresh', ROOT_SECRET, 'oauthRefresh');
    await ctx.db.repos.oauthTokens.upsert({
      orgId,
      provider: 'outlook-graph',
      blob: {
        accountLabel: 'agency@northline.test',
        accessCiphertext: access.ciphertext,
        accessIv: access.iv,
        accessAuthTag: access.authTag,
        refreshCiphertext: refresh.ciphertext,
        refreshIv: refresh.iv,
        refreshAuthTag: refresh.authTag,
        accessExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
        scopes: ['Mail.Read', 'Mail.Send'],
        extra: {},
        refreshedAt: nowIso(),
      },
    });
  }

  function buildSync(): OutlookSyncService {
    const oauth = new OAuthService({
      db: ctx.db,
      audit: ctx.core.audit,
      rootSecret: ROOT_SECRET,
      providers: { 'outlook-graph': PROVIDER },
    });
    return new OutlookSyncService({
      db: ctx.db,
      audit: ctx.core.audit,
      oauth,
      // The whole point of this round: the sync now gets a real OutboundActionService.
      outbounds: ctx.core.outbounds,
      graphProvider: PROVIDER,
    });
  }

  function graphStub(messageId: string, subject: string, from: string, fromName?: string): typeof fetch {
    return (async () =>
      new Response(
        JSON.stringify({
          value: [
            {
              id: messageId,
              subject,
              receivedDateTime: '2026-10-18T08:00:00Z',
              from: { emailAddress: { name: fromName ?? null, address: from } },
              toRecipients: [{ emailAddress: { address: 'agency@northline.test' } }],
              body: { contentType: 'Text', content: 'Could you confirm the delivery window?' },
              parentFolderId: 'inbox',
              '@odata.etag': 'etag-1',
            },
          ],
          '@odata.deltaLink': 'https://graph.example.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=t',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as typeof fetch;
  }

  it('drafts a reply for each synced message instead of returning false', async () => {
    await seedTokens(ctx.orgId);
    const admin = await ctx.actorFor(ADMIN_EMAIL);
    const messageId = `AAMk_draft_${Date.now()}`;

    const result = await buildSync().syncOnce(admin, {
      fetchImpl: graphStub(messageId, 'Delivery window', 'casey@example.com', 'Casey Customer'),
      maxPages: 1,
    });

    expect(result.ingested).toBe(1);
    // Previously hardcoded to `false`, so this was always 0.
    expect(result.drafts).toBe(1);

    const actions = await ctx.core.outbounds.list(admin, { limit: 50 });
    const draft = actions.find((a) => a.dedupeKey === `outlook-graph:reply:${messageId}`);
    expect(draft).toBeDefined();
    expect(draft?.channel).toBe('email');
    expect(draft?.provider).toBe('outlook-graph');
    expect(draft?.status).toBe('draft');
    expect(draft?.to).toBe('casey@example.com');
    await ctx.close();
  });

  it('addresses the draft to the sender and replies to the subject', async () => {
    await seedTokens(ctx.orgId);
    const admin = await ctx.actorFor(ADMIN_EMAIL);
    const messageId = `AAMk_subject_${Date.now()}`;

    await buildSync().syncOnce(admin, {
      fetchImpl: graphStub(messageId, 'Re: Q4 launch brief', 'casey@example.com', 'Casey Customer'),
      maxPages: 1,
    });

    const actions = await ctx.core.outbounds.list(admin, { limit: 50 });
    const draft = actions.find((a) => a.dedupeKey === `outlook-graph:reply:${messageId}`);
    expect(draft?.to).toBe('casey@example.com');
    // A single "Re:" prefix, not "Re: Re: ...".
    expect(draft?.subject).toBe('Re: Q4 launch brief');
    expect(draft?.body).toContain('Casey Customer');
    await ctx.close();
  });

  it('never invents commitments in the auto-drafted body', async () => {
    await seedTokens(ctx.orgId);
    const admin = await ctx.actorFor(ADMIN_EMAIL);
    const messageId = `AAMk_ground_${Date.now()}`;

    await buildSync().syncOnce(admin, {
      fetchImpl: graphStub(messageId, 'When will my order ship?', 'casey@example.com'),
      maxPages: 1,
    });

    const actions = await ctx.core.outbounds.list(admin, { limit: 50 });
    const draft = actions.find((a) => a.dedupeKey === `outlook-graph:reply:${messageId}`);
    // The Bakery catalog grounding does not apply to arbitrary inbound mail, so the draft must
    // stay a neutral acknowledgement rather than promising a delivery date.
    expect(draft?.body).not.toMatch(/\b(Tuesday|Wednesday|Friday|next week|24 hours|48 hours)\b/i);
    expect(draft?.body).toMatch(/received it/i);
    await ctx.close();
  });

  it('is idempotent: a second sync of the same message does not duplicate the draft', async () => {
    await seedTokens(ctx.orgId);
    const admin = await ctx.actorFor(ADMIN_EMAIL);
    const messageId = `AAMk_idem_${Date.now()}`;
    const fetchImpl = graphStub(messageId, 'Delivery window', 'casey@example.com');

    await buildSync().syncOnce(admin, { fetchImpl, maxPages: 1 });
    // Clear the cursor so the same delta page is walked again.
    await ctx.db.repos.syncCursors.delete(ctx.orgId, 'outlook-graph', 'mail-delta');
    const second = await buildSync().syncOnce(admin, { fetchImpl, maxPages: 1 });

    expect(second.duplicates).toBe(1);
    expect(second.drafts).toBe(0);

    const actions = await ctx.core.outbounds.list(admin, { limit: 50 });
    const matching = actions.filter((a) => a.dedupeKey === `outlook-graph:reply:${messageId}`);
    expect(matching.length).toBe(1);
    await ctx.close();
  });

  it('walks draft -> approval -> send over the Outlook channel, not a WhatsApp one', async () => {
    await seedTokens(ctx.orgId);
    const manager = await ctx.actorFor(MANAGER_EMAIL);
    const messageId = `AAMk_chain_${Date.now()}`;

    await buildSync().syncOnce(await ctx.actorFor(ADMIN_EMAIL), {
      fetchImpl: graphStub(messageId, 'Delivery window', 'casey@example.com'),
      maxPages: 1,
    });

    const actions = await ctx.core.outbounds.list(manager, { limit: 50 });
    const draft = actions.find((a) => a.dedupeKey === `outlook-graph:reply:${messageId}`)!;
    expect(draft).toBeDefined();

    await ctx.core.outbounds.submitForApproval(manager, draft.id);
    await ctx.core.outbounds.decide(manager, { actionId: draft.id, decision: 'approved' });

    const channel = new MockOutlookGraphChannel();
    const sent = await ctx.core.outbounds.send(manager, draft.id, channel);

    expect(sent.status).toBe('sent');
    expect(channel.calls.length).toBe(1);
    // Proves the driver received the email recipient, not a phone number.
    expect(channel.calls[0].to).toBe('casey@example.com');
    expect(channel.calls[0].subject).toBe('Re: Delivery window');
    await ctx.close();
  });

  it('still syncs successfully when no OutboundActionService is injected', async () => {
    await seedTokens(ctx.orgId);
    const admin = await ctx.actorFor(ADMIN_EMAIL);
    const oauth = new OAuthService({
      db: ctx.db,
      audit: ctx.core.audit,
      rootSecret: ROOT_SECRET,
      providers: { 'outlook-graph': PROVIDER },
    });
    // Sync-only wiring (e.g. the connect-check flow) must not regress.
    const sync = new OutlookSyncService({ db: ctx.db, audit: ctx.core.audit, oauth, graphProvider: PROVIDER });

    const result = await sync.syncOnce(admin, {
      fetchImpl: graphStub(`AAMk_nodraft_${Date.now()}`, 'Hello', 'casey@example.com'),
      maxPages: 1,
    });
    expect(result.ingested).toBe(1);
    expect(result.drafts).toBe(0);
    await ctx.close();
  });

  it('does not draft for a message with no usable sender address', async () => {
    await seedTokens(ctx.orgId);
    const admin = await ctx.actorFor(ADMIN_EMAIL);
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          value: [
            {
              id: `AAMk_nosender_${Date.now()}`,
              subject: 'No sender',
              receivedDateTime: '2026-10-18T08:00:00Z',
              from: null,
              body: { contentType: 'Text', content: 'orphan' },
              parentFolderId: 'inbox',
            },
          ],
          '@odata.deltaLink': 'https://graph.example.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=t',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as typeof fetch;

    const result = await buildSync().syncOnce(admin, { fetchImpl, maxPages: 1 });
    // The normalizer drops sender-less messages entirely, so nothing is ingested or drafted.
    expect(result.ingested).toBe(0);
    expect(result.drafts).toBe(0);
    await ctx.close();
  });
});
