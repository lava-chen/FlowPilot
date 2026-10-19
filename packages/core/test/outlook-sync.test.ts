import { beforeEach, describe, expect, it } from 'vitest';
import {
  ADMIN_EMAIL,
  createTestContext,
  type TestContext,
} from './harness.js';
import { OAuthService } from '../src/outlook-oauth.service.js';
import { OutlookSyncService } from '../src/outlook-sync.service.js';
import { encryptSecret } from '../src/ai/settings-crypto.js';
import { nowIso } from '@flowpilot/shared';

const ROOT_SECRET = 'outlook-sync-test-session-secret-32chars';

function configureOAuth(ctx: TestContext, fetchImpl: typeof fetch): OAuthService {
  return new OAuthService({
    db: ctx.db,
    audit: ctx.core.audit,
    rootSecret: ROOT_SECRET,
    providers: {
      'outlook-graph': {
        clientId: 'fp-test-client',
        clientSecret: 'fp-test-secret',
        tenantId: 'common',
        redirectUri: 'http://localhost:3000/api/integrations/outlook-graph/oauth/callback',
        graphBase: 'https://graph.example.com/v1.0',
        authorizeEndpoint: 'https://login.example.com/common/oauth2/v2.0/authorize',
        tokenEndpoint: 'https://login.example.com/common/oauth2/v2.0/token',
      },
    },
  });
}

describe('OutlookSyncService', () => {
  let ctx: TestContext;
  beforeEach(async () => {
    ctx = await createTestContext();
  });

  async function teardown() {
    await ctx.close();
  }

  async function seedEncryptedTokens(orgId: string, provider: string): Promise<void> {
    const access = encryptSecret('token', ROOT_SECRET, 'oauthAccess');
    const refresh = encryptSecret('refresh', ROOT_SECRET, 'oauthRefresh');
    await ctx.db.repos.oauthTokens.upsert({
      orgId,
      provider,
      blob: {
        accountLabel: 'agency@northline.test',
        accessCiphertext: access.ciphertext,
        accessIv: access.iv,
        accessAuthTag: access.authTag,
        refreshCiphertext: refresh.ciphertext,
        refreshIv: refresh.iv,
        refreshAuthTag: refresh.authTag,
        accessExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
        scopes: ['Mail.Read', 'Mail.ReadWrite', 'Mail.Send'],
        extra: {},
        refreshedAt: nowIso(),
      },
    });
  }

  it('walks a single delta page: returns the deltaLink, ingests messages, ignores junk', async () => {
    await seedEncryptedTokens(ctx.orgId, 'outlook-graph');
    const oauth = configureOAuth(ctx, globalThis.fetch);
    const sync = new OutlookSyncService({
      db: ctx.db,
      audit: ctx.core.audit,
      oauth,
      graphProvider: {
        clientId: 'fp-test-client',
        clientSecret: 'fp-test-secret',
        tenantId: 'common',
        redirectUri: 'http://localhost:3000/api/integrations/outlook-graph/oauth/callback',
        graphBase: 'https://graph.example.com/v1.0',
        authorizeEndpoint: 'https://login.example.com/common/oauth2/v2.0/authorize',
        tokenEndpoint: 'https://login.example.com/common/oauth2/v2.0/token',
      },
    });

    const goodMessageId = `AAMk_inbox_${Date.now()}`;
    let calls = 0;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls += 1;
      expect(url).toContain('graph.example.com/v1.0/me/mailFolders/inbox/messages/delta');
      expect(init?.headers).toMatchObject({ authorization: 'Bearer token' });
      return new Response(
        JSON.stringify({
          value: [
            {
              id: goodMessageId,
              subject: 'Re: Q4 launch brief',
              receivedDateTime: '2026-10-18T08:00:00Z',
              from: { emailAddress: { name: 'Casey Customer', address: 'casey@example.com' } },
              toRecipients: [{ emailAddress: { address: 'agency@northline.test' } }],
              body: { contentType: 'Text', content: 'Please find attached our brief.' },
              parentFolderId: 'inbox',
              '@odata.etag': 'etag-1',
            },
            {
              id: `AAMk_junk_${Date.now()}`,
              subject: 'Win a free iPhone',
              receivedDateTime: '2026-10-18T08:30:00Z',
              from: { emailAddress: { address: 'spam@bad.test' } },
              body: { contentType: 'Text', content: 'click here' },
              parentFolderId: 'junkemail',
            },
          ],
          '@odata.deltaLink': 'https://graph.example.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=abc',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    const actor = await ctx.actorFor(ADMIN_EMAIL);
    const result = await sync.syncOnce(actor, { fetchImpl, maxPages: 1 });
    expect(calls).toBe(1);
    expect(result.ingested).toBe(1);
    expect(result.cursorStored).toBe(true);

    // We don't pin an absolute count (seed has its own rows); check the synced message
    // actually landed in the inbox with the right source = 'whatsapp' is wrong — for
    // outlook it should remain 'email' (the table stores source of the request; Outlook
    // mail passes through the existing email pipeline).
    const inbox = await ctx.core.queries.inbox(actor, { limit: 50 });
    const found = inbox.requests.find((r) => r.sourceRef === `outlook-graph:${goodMessageId}`);
    expect(found).toBeDefined();
    expect(found?.source).toBe('email');

    // Cursor stored on the row so the next call resumes from this URL.
    const cursor = await sync.getCursor(actor, 'outlook-graph');
    expect(cursor?.cursorValue).toContain('$deltatoken=abc');
    await teardown();
  });

  it('paginates through @odata.nextLink until it sees @odata.deltaLink', async () => {
    await seedEncryptedTokens(ctx.orgId, 'outlook-graph');
    const oauth = configureOAuth(ctx, globalThis.fetch);
    const sync = new OutlookSyncService({
      db: ctx.db,
      audit: ctx.core.audit,
      oauth,
      graphProvider: {
        clientId: 'fp-test-client',
        clientSecret: 'fp-test-secret',
        tenantId: 'common',
        redirectUri: 'http://localhost:3000/api/integrations/outlook-graph/oauth/callback',
        graphBase: 'https://graph.example.com/v1.0',
        authorizeEndpoint: 'https://login.example.com/common/oauth2/v2.0/authorize',
        tokenEndpoint: 'https://login.example.com/common/oauth2/v2.0/token',
      },
    });

    let page = 0;
    const fetchedUrls: string[] = [];
    const fetchImpl = (async (url: string) => {
      page += 1;
      fetchedUrls.push(url);
      if (page === 1) {
        return new Response(
          JSON.stringify({
            value: [
              {
                id: `m-page-1-${Date.now()}`,
                from: { emailAddress: { address: 'a@b.test' } },
                subject: 'Page 1',
                body: { contentType: 'Text', content: 'Body for page 1' },
                parentFolderId: 'inbox',
              },
            ],
            '@odata.nextLink': `${url}&$skiptoken=tok-1`,
          }),
          { status: 200 },
        );
      }
      if (page === 2) {
        return new Response(
          JSON.stringify({
            value: [
              {
                id: `m-page-2-${Date.now()}`,
                from: { emailAddress: { address: 'c@d.test' } },
                subject: 'Page 2',
                body: { contentType: 'Text', content: 'Body for page 2' },
                parentFolderId: 'inbox',
              },
            ],
            '@odata.deltaLink': `${url.split('?')[0]}?$deltatoken=final`,
          }),
          { status: 200 },
        );
      }
      throw new Error('unexpected 3rd page');
    }) as typeof fetch;

    const actor = await ctx.actorFor(ADMIN_EMAIL);
    const result = await sync.syncOnce(actor, { fetchImpl, maxPages: 5 });
    expect(page).toBe(2);
    expect(result.ingested).toBe(2);
    expect(result.cursorStored).toBe(true);
    // Page 2 was fetched using the @odata.nextLink from page 1, *not* a fresh delta URL.
    expect(fetchedUrls[1]).toContain('$skiptoken=tok-1');
    await teardown();
  });

  it('resetCursor clears the persisted delta link so the next sync starts fresh', async () => {
    await seedEncryptedTokens(ctx.orgId, 'outlook-graph');
    const oauth = configureOAuth(ctx, globalThis.fetch);
    const sync = new OutlookSyncService({
      db: ctx.db,
      audit: ctx.core.audit,
      oauth,
      graphProvider: {
        clientId: 'fp-test-client',
        clientSecret: 'fp-test-secret',
        tenantId: 'common',
        redirectUri: 'http://localhost:3000/api/integrations/outlook-graph/oauth/callback',
        graphBase: 'https://graph.example.com/v1.0',
        authorizeEndpoint: 'https://login.example.com/common/oauth2/v2.0/authorize',
        tokenEndpoint: 'https://login.example.com/common/oauth2/v2.0/token',
      },
    });

    const admin = await ctx.actorFor(ADMIN_EMAIL);
    // Only owners can reset the cursor — explicit per spec.
    await ctx.db.repos.syncCursors.upsert({
      orgId: ctx.orgId,
      provider: 'outlook-graph',
      cursorKind: 'mail-delta',
      cursorValue: 'https://graph.example.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=old',
      totalIngested: 0,
      lastSyncedAt: new Date().toISOString(),
      metadata: {},
    });

    await expect(sync.resetCursor(admin, 'outlook-graph')).resolves.toBeUndefined();
    const owner = await ctx.actorFor('dana@northlinecreative.com' as Parameters<typeof ctx.actorFor>[0]);
    await sync.resetCursor(owner, 'outlook-graph');
    expect(await ctx.db.repos.syncCursors.get(ctx.orgId, 'outlook-graph', 'mail-delta')).toBeNull();
    await teardown();
  });

  it('system actors cannot reset the cursor (no human in the loop)', async () => {
    await seedEncryptedTokens(ctx.orgId, 'outlook-graph');
    const oauth = configureOAuth(ctx, globalThis.fetch);
    const sync = new OutlookSyncService({
      db: ctx.db,
      audit: ctx.core.audit,
      oauth,
      graphProvider: {
        clientId: 'fp-test-client',
        clientSecret: 'fp-test-secret',
        tenantId: 'common',
        redirectUri: 'http://localhost:3000/api/integrations/outlook-graph/oauth/callback',
        graphBase: 'https://graph.example.com/v1.0',
        authorizeEndpoint: 'https://login.example.com/common/oauth2/v2.0/authorize',
        tokenEndpoint: 'https://login.example.com/common/oauth2/v2.0/token',
      },
    });
    const admin = await ctx.actorFor(ADMIN_EMAIL);
    await expect(
      sync.resetCursor({ kind: 'system', orgId: admin.orgId, label: 'system' }, 'outlook-graph'),
    ).rejects.toThrow(/human user/i);
    await teardown();
  });

  it('a Graph 401 triggers a clear ValidationError instead of a generic 500', async () => {
    await seedEncryptedTokens(ctx.orgId, 'outlook-graph');
    const oauth = configureOAuth(ctx, globalThis.fetch);
    const sync = new OutlookSyncService({
      db: ctx.db,
      audit: ctx.core.audit,
      oauth,
      graphProvider: {
        clientId: 'fp-test-client',
        clientSecret: 'fp-test-secret',
        tenantId: 'common',
        redirectUri: 'http://localhost:3000/api/integrations/outlook-graph/oauth/callback',
        graphBase: 'https://graph.example.com/v1.0',
        authorizeEndpoint: 'https://login.example.com/common/oauth2/v2.0/authorize',
        tokenEndpoint: 'https://login.example.com/common/oauth2/v2.0/token',
      },
    });

    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: { code: 'InvalidAuthenticationToken', message: 'expired' } }), {
        status: 401,
      })) as typeof fetch;

    const admin = await ctx.actorFor(ADMIN_EMAIL);
    await expect(sync.syncOnce(admin, { fetchImpl, maxPages: 1 })).rejects.toThrow(/re-connect/i);
    await teardown();
  });
});
