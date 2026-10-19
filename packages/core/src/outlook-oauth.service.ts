import type { FlowPilotDb } from '@flowpilot/database';
import type { Actor } from '@flowpilot/domain';
import {
  createHash,
  randomBytes,
} from 'node:crypto';
import {
  ForbiddenError,
  IntegrationError,
  NotFoundError,
  ValidationError,
} from '@flowpilot/shared';
import { assertCan } from './permissions.js';
import type { AuditService } from './audit.service.js';
import { encryptSecret, decryptSecret } from './ai/settings-crypto.js';

/**
 * OAuth service for Microsoft Graph (Outlook).
 *
 * Why this lives in core rather than the integrations package: the token blob is
 * encrypted with the same domain-separated key the AI settings use, and that
 * key is derived from a core-only secret (`SESSION_SECRET`). Putting the service
 * in core keeps the encryption boundary inside one process step and makes the
 * `oauth_tokens` table reachable from anywhere that has a `CoreServices`.
 *
 * Scope: Microsoft Graph permission set. We deliberately request only what the demo
 * needs. A real deployment might request e.g. `Mail.ReadWrite.Shared` for shared
 * mailboxes too.
 */
export const OUTLOOK_DEFAULT_SCOPES = [
  'openid',
  'profile',
  'email',
  'offline_access',
  'Mail.Read',
  'Mail.ReadWrite',
  'Mail.Send',
] as const;

export interface OutlookProviderConfig {
  /** Microsoft Entra (Azure AD) client id registered for the FlowPilot deployment. */
  clientId: string;
  /** Client secret for confidential clients. Empty when using PKCE-only public flow. */
  clientSecret?: string;
  /** Tenant id; `common` works for multi-tenant apps. */
  tenantId: string;
  /** Where Microsoft should redirect after the user signs in. */
  redirectUri: string;
  /** Optional override of the Graph base URL (defaults to `https://graph.microsoft.com/v1.0`). */
  graphBase?: string;
  /** Optional override of the Entra authorize endpoint. */
  authorizeEndpoint?: string;
  /** Optional override of the Entra token endpoint. */
  tokenEndpoint?: string;
  /** Scope list — defaults to `OUTLOOK_DEFAULT_SCOPES`. */
  scopes?: readonly string[];
}

export interface OAuthServiceDeps {
  db: FlowPilotDb;
  audit: AuditService;
  /**
   * Encryption root for at-rest token storage. Same value as the AI settings key.
   * Production sets this to `process.env.SESSION_SECRET`; tests pass a 32+ char
   * stub.
   */
  rootSecret: string;
  /** Provider-specific config keyed by `provider` (currently only `'outlook-graph'`). */
  providers: Record<string, OutlookProviderConfig>;
}

export interface OAuthAuthorizeResult {
  authorizeUrl: string;
}

export interface OAuthCompleteInput {
  provider: string;
  code: string;
  state: string;
  /** Verifier kept in the caller's session cookie after the start step. */
  codeVerifier: string;
}

export interface OAuthCompleteResult {
  accountLabel: string;
  expiresAt: string;
  scopes: string[];
}

export class OAuthService {
  constructor(private readonly deps: OAuthServiceDeps) {}

  /** Step 1 — issue the PKCE verifier, store the state, return the IdP authorize URL. */
  async startHandshake(
    actor: Actor,
    input: { provider: string; returnTo?: string | null },
  ): Promise<{ authorizeUrl: string; codeVerifier: string; state: string; expiresInSeconds: number }> {
    // Human check first — the *actual* guarantee we want is that an integration
    // cannot be connected by an agent acting on the user's behalf. The scope check
    // below is a secondary defense, not the primary one.
    if (actor.kind !== 'user') {
      throw new ForbiddenError('Only a human user can connect an integration.', {
        capability: 'integrations:manage',
      });
    }
    assertCan(actor, 'integrations:manage');
    const config = this.deps.providers[input.provider];
    if (!config) {
      throw new NotFoundError(`OAuthProvider(${input.provider})`);
    }

    const codeVerifier = base64UrlRandom(64);
    const codeChallenge = base64UrlSha256(codeVerifier);
    const state = `fp_oauth_${randomBytes(16).toString('hex')}`;

    await this.deps.db.repos.oauthStates.create({
      orgId: actor.orgId,
      provider: input.provider,
      state,
      codeVerifierHash: createHash('sha256').update(codeVerifier, 'utf8').digest('hex'),
      returnTo: input.returnTo ?? null,
    });

    const authorizeUrl = this.buildAuthorizeUrl(config, state, codeChallenge);

    // Audit: connection-intent so the activity feed reflects that a user kicked off OAuth.
    await this.deps.audit.record(actor, 'integration.oauth_started', 'integration_connection', input.provider, {
      provider: input.provider,
      scopes: config.scopes ?? OUTLOOK_DEFAULT_SCOPES,
    });

    return { authorizeUrl, codeVerifier, state, expiresInSeconds: 600 };
  }

  /** Step 2 — IdP redirects back with `code` + `state`. Exchange and persist. */
  async completeHandshake(actor: Actor, input: OAuthCompleteInput): Promise<OAuthCompleteResult> {
    if (actor.kind !== 'user') {
      throw new ForbiddenError('Only a human user can complete an OAuth handshake.', {
        capability: 'integrations:manage',
      });
    }
    assertCan(actor, 'integrations:manage');

    const cfg = this.deps.providers[input.provider];
    if (!cfg) {
      throw new NotFoundError(`OAuthProvider(${input.provider})`);
    }

    const state = await this.deps.db.repos.oauthStates.findByState(input.provider, input.state);
    if (!state) {
      throw new ValidationError('OAuth state is missing, expired, or already consumed.', {
        field: 'state',
      });
    }
    if (state.orgId !== actor.orgId) {
      // Cross-org replay attempt — refuse rather than silently binding the token
      // to the wrong tenant.
      throw new ForbiddenError('OAuth state does not belong to the current organization.', {
        capability: 'integrations:manage',
      });
    }
    const expectedHash = createHash('sha256').update(input.codeVerifier, 'utf8').digest('hex');
    if (expectedHash !== state.codeVerifierHash) {
      throw new ValidationError('PKCE verifier does not match the original challenge.', {
        field: 'codeVerifier',
      });
    }

    const tokenResp = await exchangeCodeForToken(cfg, input.code, input.codeVerifier);

    const expiresAt = new Date(Date.now() + (tokenResp.expires_in ?? 3600) * 1000).toISOString();
    const accessCipher = encryptSecret(tokenResp.access_token, this.deps.rootSecret, 'oauthAccess');
    const refreshCipher = tokenResp.refresh_token
      ? encryptSecret(tokenResp.refresh_token, this.deps.rootSecret, 'oauthRefresh')
      : null;

    if (!refreshCipher) {
      // Microsoft always returns refresh_token with `offline_access`. If it didn't,
      // we cannot silently degrade — we'd lock the user out 60 minutes later.
      throw new IntegrationError(
        'Microsoft did not return a refresh_token. Re-authorize with offline_access scope.',
        { provider: input.provider },
      );
    }

    await this.deps.db.repos.oauthTokens.upsert({
      orgId: actor.orgId,
      provider: input.provider,
      blob: {
        accountLabel: tokenResp.account_label ?? deriveAccountLabel(tokenResp),
        accessCiphertext: accessCipher.ciphertext,
        accessIv: accessCipher.iv,
        accessAuthTag: accessCipher.authTag,
        refreshCiphertext: refreshCipher.ciphertext,
        refreshIv: refreshCipher.iv,
        refreshAuthTag: refreshCipher.authTag,
        accessExpiresAt: expiresAt,
        scopes: tokenResp.scope ? tokenResp.scope.split(/\s+/) : [...(cfg.scopes ?? OUTLOOK_DEFAULT_SCOPES)],
        extra: {
          tokenType: tokenResp.token_type ?? 'Bearer',
          idTokenClaims: tokenResp.id_token_claims ?? null,
        },
        refreshedAt: new Date().toISOString(),
      },
    });

    await this.deps.db.repos.integrations.upsert({
      id: `int_${input.provider}_${actor.orgId}`,
      orgId: actor.orgId,
      provider: input.provider,
      status: 'connected',
      config: {
        accountLabel: tokenResp.account_label ?? deriveAccountLabel(tokenResp),
        tenant: cfg.tenantId,
        scopes: tokenResp.scope ? tokenResp.scope.split(/\s+/) : [...(cfg.scopes ?? OUTLOOK_DEFAULT_SCOPES)],
      },
    });

    await this.deps.audit.record(actor, 'integration.oauth_completed', 'integration_connection', input.provider, {
      provider: input.provider,
      accountLabel: tokenResp.account_label ?? null,
      scopes: tokenResp.scope ? tokenResp.scope.split(/\s+/) : null,
    });

    await this.deps.db.repos.oauthStates.consume(state.id);

    return {
      accountLabel: tokenResp.account_label ?? deriveAccountLabel(tokenResp),
      expiresAt,
      scopes: tokenResp.scope ? tokenResp.scope.split(/\s+/) : [...(cfg.scopes ?? OUTLOOK_DEFAULT_SCOPES)],
    };
  }

  /** Returns a fresh access token, refreshing transparently when expired. */
  async getAccessToken(actor: Actor, provider: string): Promise<string> {
    const token = await this.deps.db.repos.oauthTokens.require(actor.orgId, provider);
    const cfg = this.deps.providers[provider];
    if (!cfg) throw new NotFoundError(`OAuthProvider(${provider})`);

    // 60-second skew tolerance to avoid the "token expires during the call" trap.
    const skew = 60_000;
    const expiresMs = Date.parse(token.accessExpiresAt) - skew;
    if (Date.now() < expiresMs) {
      return decryptBlob(token, this.deps.rootSecret, 'access');
    }

    const refreshToken = decryptBlob(token, this.deps.rootSecret, 'refresh');
    const refreshed = await refreshAccessToken(cfg, refreshToken);
    const newAccessExpiresAt = new Date(Date.now() + (refreshed.expires_in ?? 3600) * 1000).toISOString();
    const accessCipher = encryptSecret(refreshed.access_token, this.deps.rootSecret, 'oauthAccess');
    await this.deps.db.repos.oauthTokens.upsert({
      orgId: actor.orgId,
      provider,
      blob: {
        ...token,
        accessCiphertext: accessCipher.ciphertext,
        accessIv: accessCipher.iv,
        accessAuthTag: accessCipher.authTag,
        accessExpiresAt: newAccessExpiresAt,
      },
    });
    void newAccessExpiresAt;
    return refreshed.access_token;
  }

  async disconnect(actor: Actor, provider: string): Promise<void> {
    assertCan(actor, 'integrations:manage');
    if (actor.kind !== 'user') {
      throw new ForbiddenError('Disconnecting an integration requires a human.', {
        capability: 'integrations:manage',
      });
    }
    await this.deps.db.repos.oauthTokens.delete(actor.orgId, provider);
    await this.deps.db.repos.syncCursors.delete(actor.orgId, provider, 'mail-delta');
    await this.deps.db.repos.integrations.upsert({
      id: `int_${provider}_${actor.orgId}`,
      orgId: actor.orgId,
      provider,
      status: 'disconnected',
      config: {},
    });
    await this.deps.audit.record(actor, 'integration.oauth_disconnected', 'integration_connection', provider, {
      provider,
    });
  }

  async isConnected(orgId: string, provider: string): Promise<boolean> {
    const token = await this.deps.db.repos.oauthTokens.get(orgId, provider);
    return Boolean(token);
  }

  private buildAuthorizeUrl(cfg: OutlookProviderConfig, state: string, codeChallenge: string): string {
    const endpoint = cfg.authorizeEndpoint ?? defaultAuthorizeEndpoint(cfg.tenantId);
    const scopes = (cfg.scopes ?? OUTLOOK_DEFAULT_SCOPES).join(' ');
    const params = new URLSearchParams({
      client_id: cfg.clientId,
      response_type: 'code',
      redirect_uri: cfg.redirectUri,
      response_mode: 'query',
      scope: scopes,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      prompt: 'select_account',
    });
    return `${endpoint}?${params.toString()}`;
  }

  }

/* -------------------------------------------------------------------------- */
/* Pure helpers                                                                */
/* -------------------------------------------------------------------------- */

export function defaultAuthorizeEndpoint(tenantId: string): string {
  // `common` works for multi-tenant; `organizations` for single-tenant.
  return `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize`;
}

export function defaultTokenEndpoint(tenantId: string): string {
  return `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
}

export function defaultGraphBase(): string {
  return 'https://graph.microsoft.com/v1.0';
}

interface MicrosoftTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
  id_token?: string;
  id_token_claims?: Record<string, unknown>;
  account_label?: string;
}

async function exchangeCodeForToken(
  cfg: OutlookProviderConfig,
  code: string,
  codeVerifier: string,
): Promise<MicrosoftTokenResponse> {
  const endpoint = cfg.tokenEndpoint ?? defaultTokenEndpoint(cfg.tenantId);
  const body = new URLSearchParams({
    client_id: cfg.clientId,
    grant_type: 'authorization_code',
    code,
    redirect_uri: cfg.redirectUri,
    code_verifier: codeVerifier,
    scope: (cfg.scopes ?? OUTLOOK_DEFAULT_SCOPES).join(' '),
  });
  if (cfg.clientSecret) body.set('client_secret', cfg.clientSecret);

  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(15_000),
  }).catch((err) => {
    throw new IntegrationError(
      `Microsoft token endpoint unreachable: ${err instanceof Error ? err.message : String(err)}`,
      { endpoint },
    );
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new IntegrationError(`Microsoft token exchange failed: HTTP ${resp.status} ${text.slice(0, 200)}`, {
      status: resp.status,
    });
  }
  const json = (await resp.json()) as MicrosoftTokenResponse;
  return json;
}

async function refreshAccessToken(
  cfg: OutlookProviderConfig,
  refreshToken: string,
): Promise<MicrosoftTokenResponse> {
  const endpoint = cfg.tokenEndpoint ?? defaultTokenEndpoint(cfg.tenantId);
  const body = new URLSearchParams({
    client_id: cfg.clientId,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    scope: (cfg.scopes ?? OUTLOOK_DEFAULT_SCOPES).join(' '),
  });
  if (cfg.clientSecret) body.set('client_secret', cfg.clientSecret);

  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new IntegrationError(`Microsoft refresh failed: HTTP ${resp.status} ${text.slice(0, 200)}`, {
      status: resp.status,
    });
  }
  return (await resp.json()) as MicrosoftTokenResponse;
}

function base64UrlRandom(byteLength: number): string {
  return randomBytes(byteLength).toString('base64url');
}

function base64UrlSha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('base64url');
}

function deriveAccountLabel(resp: MicrosoftTokenResponse): string {
  // Prefer the explicit account_label that some IdPs add; otherwise take the upn/email
  // claim if present; otherwise fall back to a generic 'Microsoft Graph user'.
  const claims = resp.id_token_claims ?? {};
  const candidate = (claims['preferred_username'] ?? claims['email'] ?? claims['upn']) as string | undefined;
  return resp.account_label ?? candidate ?? 'Microsoft Graph user';
}

function decryptBlob(
  blob: {
    accessCiphertext: string; accessIv: string; accessAuthTag: string;
    refreshCiphertext: string; refreshIv: string; refreshAuthTag: string;
  },
  rootSecret: string,
  which: 'access' | 'refresh',
): string {
  const field = which === 'access'
    ? { ciphertext: blob.accessCiphertext, iv: blob.accessIv, authTag: blob.accessAuthTag }
    : { ciphertext: blob.refreshCiphertext, iv: blob.refreshIv, authTag: blob.refreshAuthTag };
  return decryptSecret(field, rootSecret, which === 'access' ? 'oauthAccess' : 'oauthRefresh');
}
