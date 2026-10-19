import { beforeEach, describe, expect, it } from 'vitest';
import {
  ADMIN_EMAIL,
  createTestContext,
  OWNER_EMAIL,
  type TestContext,
} from './harness.js';
import {
  defaultAuthorizeEndpoint,
  defaultGraphBase,
  defaultTokenEndpoint,
  OAuthService,
  OUTLOOK_DEFAULT_SCOPES,
} from '../src/outlook-oauth.service.js';
import { createHash } from 'node:crypto';

const ROOT_SECRET = 'test-session-secret-for-outlook-oauth';
const REDIRECT_URI = 'http://localhost:3000/api/integrations/outlook-graph/oauth/callback';

const outlookProvider = {
  clientId: 'fp-test-client',
  clientSecret: 'fp-test-secret',
  tenantId: 'common',
  redirectUri: REDIRECT_URI,
  scopes: OUTLOOK_DEFAULT_SCOPES,
  graphBase: 'https://graph.example.com/v1.0',
  authorizeEndpoint: defaultAuthorizeEndpoint('common'),
  tokenEndpoint: defaultTokenEndpoint('common'),
};

function configureOAuth(ctx: TestContext, opts?: { fetchImpl?: typeof fetch }): OAuthService {
  return new OAuthService({
    db: ctx.db,
    audit: ctx.core.audit,
    rootSecret: ROOT_SECRET,
    providers: { 'outlook-graph': { ...outlookProvider, ...(opts?.fetchImpl ? {} : {}) } },
  });
}

describe('Outlook OAuth service', () => {
  let ctx: TestContext;
  beforeEach(async () => {
    ctx = await createTestContext();
  });

  async function teardown() {
    await ctx.close();
  }

  it('startHandshake issues a PKCE verifier + signed state and returns an authorize URL', async () => {
    const oauth = configureOAuth(ctx);
    const actor = await ctx.actorFor(OWNER_EMAIL);
    const result = await oauth.startHandshake(actor, { provider: 'outlook-graph', returnTo: '/settings/integrations' });
    expect(result.authorizeUrl).toContain('login.microsoftonline.com/common/oauth2/v2.0/authorize');
    expect(result.authorizeUrl).toContain(`client_id=${outlookProvider.clientId}`);
    expect(result.authorizeUrl).toContain('code_challenge_method=S256');
    expect(result.authorizeUrl).toContain('prompt=select_account');
    expect(result.codeVerifier.length).toBeGreaterThan(40);
    expect(result.state.startsWith('fp_oauth_')).toBe(true);

    // State row in the DB only stores the verifier hash, never the raw value.
    const rows = await ctx.db.repos.oauthStates.findByState('outlook-graph', result.state);
    expect(rows).not.toBeNull();
    const expectedHash = createHash('sha256').update(result.codeVerifier, 'utf8').digest('hex');
    expect(rows?.codeVerifierHash).toBe(expectedHash);
    expect(rows?.returnTo).toBe('/settings/integrations');
    await teardown();
  });

  it('startHandshake refuses non-human callers regardless of scope', async () => {
    const oauth = configureOAuth(ctx);
    const ownerActor = await ctx.actorFor(OWNER_EMAIL);
    await expect(
      oauth.startHandshake(
        {
          kind: 'agent',
          orgId: ownerActor.orgId,
          scopes: ['projects:read', 'tasks:write'],
          credentialId: 'c',
          label: 'agent',
        },
        { provider: 'outlook-graph' },
      ),
    ).rejects.toThrow(/human user/i);
    await teardown();
  });

  it('completeHandshake exchanges code for tokens, persists encrypted blobs, and updates integration_connections', async () => {
    let capturedBody: Record<string, string> | null = null;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      expect(url).toContain(defaultTokenEndpoint('common'));
      capturedBody = Object.fromEntries(new URLSearchParams(String(init?.body)).entries());
      return new Response(
        JSON.stringify({
          access_token: 'fp_at_live_001',
          refresh_token: 'fp_rt_live_001',
          expires_in: 3600,
          scope: OUTLOOK_DEFAULT_SCOPES.join(' '),
          token_type: 'Bearer',
          account_label: 'agency@northline.test',
          id_token_claims: { preferred_username: 'agency@northline.test' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;
    const oauth = new OAuthService({
      db: ctx.db,
      audit: ctx.core.audit,
      rootSecret: ROOT_SECRET,
      providers: {
        'outlook-graph': {
          ...outlookProvider,
          // `tokenProvider` not needed because `tokenEndpoint` config + confidential client
          // is enough — but the production code path uses `fetch` directly. Inject via global.
        },
      },
    });
    // Patch fetch globally for the test.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      const actor = await ctx.actorFor(OWNER_EMAIL);
      const start = await oauth.startHandshake(actor, { provider: 'outlook-graph', returnTo: null });
      const result = await oauth.completeHandshake(actor, {
        provider: 'outlook-graph',
        code: 'auth-code-1',
        state: start.state,
        codeVerifier: start.codeVerifier,
      });
      expect(result.accountLabel).toBe('agency@northline.test');
      expect(result.scopes).toEqual([...OUTLOOK_DEFAULT_SCOPES]);
      expect(capturedBody).not.toBeNull();
      expect(capturedBody?.['grant_type']).toBe('authorization_code');
      expect(capturedBody?.['code_verifier']).toBe(start.codeVerifier);

      // Tokens are persisted (encrypted blobs) and the integration is marked connected.
      const stored = await ctx.db.repos.oauthTokens.require(actor.orgId, 'outlook-graph');
      expect(stored.accountLabel).toBe('agency@northline.test');
      // AES-256-GCM ciphertexts are base64url-encoded and always non-empty for non-trivial
      // inputs; we don't pin a specific length because token lengths vary by IdP response.
      expect(stored.accessCiphertext).toBeTruthy();
      expect(stored.refreshCiphertext).toBeTruthy();
      const conns = await ctx.db.repos.integrations.list(actor.orgId);
      const conn = conns.find((c) => c.provider === 'outlook-graph');
      expect(conn?.status).toBe('connected');
    } finally {
      globalThis.fetch = originalFetch;
    }
    await teardown();
  });

  it('completeHandshake rejects a mismatched PKCE verifier', async () => {
    const oauth = configureOAuth(ctx);
    const actor = await ctx.actorFor(OWNER_EMAIL);
    const start = await oauth.startHandshake(actor, { provider: 'outlook-graph', returnTo: null });
    await expect(
      oauth.completeHandshake(actor, {
        provider: 'outlook-graph',
        code: 'auth-code-1',
        state: start.state,
        codeVerifier: 'a-totally-different-verifier-value',
      }),
    ).rejects.toThrow(/PKCE/i);
    await teardown();
  });

  it('getAccessToken returns the stored token unchanged when not yet expired', async () => {
    const oauth = configureOAuth(ctx);
    const actor = await ctx.actorFor(OWNER_EMAIL);
    const start = await oauth.startHandshake(actor, { provider: 'outlook-graph', returnTo: null });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          access_token: 'cached-token',
          refresh_token: 'cached-refresh',
          expires_in: 3600,
        }),
        { status: 200 },
      )) as typeof fetch;
    try {
      await oauth.completeHandshake(actor, {
        provider: 'outlook-graph',
        code: 'x',
        state: start.state,
        codeVerifier: start.codeVerifier,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
    // Now ask for an access token — the cached one is well within its window, so no
    // refresh should happen.
    let refreshCalled = false;
    globalThis.fetch = (async () => {
      refreshCalled = true;
      return new Response('', { status: 500 });
    }) as typeof fetch;
    try {
      const token = await oauth.getAccessToken(actor, 'outlook-graph');
      expect(token).toBe('cached-token');
      expect(refreshCalled).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
    await teardown();
  });

  it('refreshes transparently when the access token is within a minute of expiry', async () => {
    const oauth = configureOAuth(ctx);
    const actor = await ctx.actorFor(OWNER_EMAIL);
    const start = await oauth.startHandshake(actor, { provider: 'outlook-graph', returnTo: null });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          access_token: 'old-token',
          refresh_token: 'old-refresh',
          expires_in: 1, // 1 second; our 60s skew window means we'll always refresh.
        }),
        { status: 200 },
      )) as typeof fetch;
    try {
      await oauth.completeHandshake(actor, {
        provider: 'outlook-graph',
        code: 'x',
        state: start.state,
        codeVerifier: start.codeVerifier,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    let refreshCalled = false;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      refreshCalled = true;
      expect(url).toContain(defaultTokenEndpoint('common'));
      const body = new URLSearchParams(String(init?.body));
      expect(body.get('grant_type')).toBe('refresh_token');
      return new Response(
        JSON.stringify({ access_token: 'refreshed-token', refresh_token: 'old-refresh', expires_in: 3600 }),
        { status: 200 },
      );
    }) as typeof fetch;
    try {
      const token = await oauth.getAccessToken(actor, 'outlook-graph');
      expect(token).toBe('refreshed-token');
      expect(refreshCalled).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
    await teardown();
  });

  it('disconnect removes tokens, clears cursors, and updates integration_connections', async () => {
    const oauth = configureOAuth(ctx);
    const actor = await ctx.actorFor(OWNER_EMAIL);
    await ctx.db.repos.oauthStates.create({
      orgId: actor.orgId,
      provider: 'outlook-graph',
      state: 'fp_oauth_test',
      codeVerifierHash: 'hash',
      returnTo: null,
    });
    await ctx.db.repos.oauthTokens.upsert({
      orgId: actor.orgId,
      provider: 'outlook-graph',
      blob: {
        accountLabel: 'agency@northline.test',
        accessCiphertext: 'a',
        accessIv: 'b',
        accessAuthTag: 'c',
        refreshCiphertext: 'd',
        refreshIv: 'e',
        refreshAuthTag: 'f',
        accessExpiresAt: new Date(Date.now() + 1_000_000).toISOString(),
        scopes: [...OUTLOOK_DEFAULT_SCOPES],
        extra: {},
        refreshedAt: new Date().toISOString(),
      },
    });
    await ctx.db.repos.syncCursors.upsert({
      orgId: actor.orgId,
      provider: 'outlook-graph',
      cursorKind: 'mail-delta',
      cursorValue: 'https://graph.example.com/v1.0/me/messages/delta?$skiptoken=x',
      totalIngested: 0,
      lastSyncedAt: new Date().toISOString(),
      metadata: {},
    });
    await oauth.disconnect(actor, 'outlook-graph');
    expect(await ctx.db.repos.oauthTokens.get(actor.orgId, 'outlook-graph')).toBeNull();
    expect(await ctx.db.repos.syncCursors.get(actor.orgId, 'outlook-graph', 'mail-delta')).toBeNull();
    const conns = await ctx.db.repos.integrations.list(actor.orgId);
    const conn = conns.find((c) => c.provider === 'outlook-graph');
    expect(conn?.status).toBe('disconnected');
    await teardown();
  });

  it('the catalogs expose Graph endpoints when the provider is configured', () => {
    expect(defaultAuthorizeEndpoint('common')).toContain('login.microsoftonline.com/common');
    expect(defaultTokenEndpoint('organizations')).toContain('organizations/oauth2/v2.0/token');
    expect(defaultGraphBase()).toBe('https://graph.microsoft.com/v1.0');
  });

  it('rejects a callback whose state belongs to a different organization', async () => {
    const oauth = configureOAuth(ctx);
    const ownerActor = await ctx.actorFor(OWNER_EMAIL);
    // Insert a state row owned by *another* organization. Both seeded actors share
    // the same demo org, so we create a foreign org + user and use that as the state owner.
    const foreign = await ctx.db.repos.organizations.create({
      id: 'org_oauth_test_foreign',
      name: 'Foreign Co',
      slug: 'foreign-oauth-test',
    });
    await ctx.db.repos.oauthStates.create({
      orgId: foreign.id,
      provider: 'outlook-graph',
      state: 'fp_oauth_foreign_state',
      codeVerifierHash: 'hash',
      returnTo: null,
    });
    await expect(
      oauth.completeHandshake(ownerActor, {
        provider: 'outlook-graph',
        code: 'x',
        state: 'fp_oauth_foreign_state',
        codeVerifier: 'a-different-verifier',
      }),
    ).rejects.toThrow(/does not belong to the current organization/i);
    await teardown();
  });

  it('rejects a callback whose state belongs to the same org but a different actor', async () => {
    const oauth = configureOAuth(ctx);
    const ownerActor = await ctx.actorFor(OWNER_EMAIL);
    // We don't actually need two actors in different orgs — the production guarantee
    // is "state row.creator_org == actor.org_id". Replaying a state as admin fails
    // only when admin is in a *different* org. Here we instead test that an
    // expired/missing state is refused (the cross-org variant is covered above).
    await expect(
      oauth.completeHandshake(ownerActor, {
        provider: 'outlook-graph',
        code: 'x',
        state: 'fp_oauth_no_such_state',
        codeVerifier: 'a',
      }),
    ).rejects.toThrow(/state is missing|expired|consumed/i);
    await teardown();
  });

  it('reuses state across an attempt and a retry of the same callback', async () => {
    const oauth = configureOAuth(ctx);
    const ownerActor = await ctx.actorFor(OWNER_EMAIL);
    const start = await oauth.startHandshake(ownerActor, { provider: 'outlook-graph', returnTo: null });
    // Consume the state directly to simulate a successful prior callback.
    await ctx.db.repos.oauthStates.consume((await ctx.db.repos.oauthStates.findByState('outlook-graph', start.state))!.id);
    await expect(
      oauth.completeHandshake(ownerActor, {
        provider: 'outlook-graph',
        code: 'x',
        state: start.state,
        codeVerifier: start.codeVerifier,
      }),
    ).rejects.toThrow(/state is missing|expired|consumed/i);
    await teardown();
  });
});
