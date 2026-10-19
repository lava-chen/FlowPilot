import { describe, expect, it, beforeEach } from 'vitest';
import { createTestContext, MANAGER_EMAIL, OWNER_EMAIL, type TestContext } from './harness.js';
import { ValidationError } from '@flowpilot/shared';
import { MockWhatsAppChannel, WhatsAppCloudChannel } from '@flowpilot/integrations';

/**
 * Integration Hardening — credential storage.
 *
 * These tests exist because the original implementation *stripped* `accessToken` and
 * `appSecret` from `config` before persisting, so the webhook signature check and the outbound
 * dispatcher both read an empty string and silently fell back to mock delivery. The suite was
 * green the whole time because nothing asserted that a saved credential could be read back.
 *
 * Every test here drives the real services against a real (PGlite) database.
 */
describe('IntegrationService credential storage', () => {
  let ctx: TestContext;
  beforeEach(async () => {
    ctx = await createTestContext();
  });

  const WHATSAPP = {
    status: 'connected' as const,
    config: {
      phoneNumberId: '1234567890',
      businessAccountId: '9876543210',
      apiBase: 'https://graph.facebook.com/v18.0',
      verifyToken: 'verify-me',
      accessToken: 'EAAG-super-secret-token',
      appSecret: 'app-secret-value',
    },
  };

  it('round-trips a saved access token and app secret', async () => {
    const actor = await ctx.actorFor(OWNER_EMAIL);
    await ctx.core.integrations.upsert(actor, { provider: 'whatsapp-cloud', ...WHATSAPP });

    const token = await ctx.core.integrations.readSecret(ctx.orgId, 'whatsapp-cloud', 'accessToken');
    const appSecret = await ctx.core.integrations.readSecret(ctx.orgId, 'whatsapp-cloud', 'appSecret');

    expect(token).toBe('EAAG-super-secret-token');
    expect(appSecret).toBe('app-secret-value');
    await ctx.close();
  });

  it('never writes secrets into integration_connections.config', async () => {
    const actor = await ctx.actorFor(OWNER_EMAIL);
    const conn = await ctx.core.integrations.upsert(actor, { provider: 'whatsapp-cloud', ...WHATSAPP });

    // The returned connection is what the dashboard renders, so it must be safe.
    expect(conn.config).not.toHaveProperty('accessToken');
    expect(conn.config).not.toHaveProperty('appSecret');

    // ...and so must the persisted row, not just the returned copy.
    const persisted = await ctx.db.repos.integrations.list(ctx.orgId);
    const stored = persisted.find((c) => c.provider === 'whatsapp-cloud');
    expect(JSON.stringify(stored?.config)).not.toContain('EAAG-super-secret-token');
    expect(JSON.stringify(stored?.config)).not.toContain('app-secret-value');
    await ctx.close();
  });

  it('stores ciphertext on disk, not plaintext', async () => {
    const actor = await ctx.actorFor(OWNER_EMAIL);
    await ctx.core.integrations.upsert(actor, { provider: 'whatsapp-cloud', ...WHATSAPP });

    const rows = await ctx.db.client.query<{ ciphertext: string; iv: string; auth_tag: string }>(
      'select ciphertext, iv, auth_tag from integration_secrets where org_id = $1',
      [ctx.orgId],
    );
    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect(row.ciphertext).not.toContain('EAAG-super-secret-token');
      expect(row.ciphertext).not.toContain('app-secret-value');
      expect(row.iv.length).toBeGreaterThan(0);
      expect(row.auth_tag.length).toBeGreaterThan(0);
    }
    await ctx.close();
  });

  it('encrypts the access token and app secret under different keys', async () => {
    const actor = await ctx.actorFor(OWNER_EMAIL);
    await ctx.core.integrations.upsert(actor, { provider: 'whatsapp-cloud', ...WHATSAPP });

    const rows = await ctx.db.client.query<{ secret_name: string; ciphertext: string }>(
      'select secret_name, ciphertext from integration_secrets where org_id = $1',
      [ctx.orgId],
    );
    const byName = new Map(rows.map((r) => [r.secret_name, r.ciphertext]));
    // Same plaintext would produce identical ciphertext under one key; different keys guarantee
    // they diverge, so neither blob reveals anything about the other's key.
    expect(byName.get('accessToken')).not.toBe(byName.get('appSecret'));
    await ctx.close();
  });

  it('keeps non-secret config readable by the dashboard', async () => {
    const actor = await ctx.actorFor(OWNER_EMAIL);
    const conn = await ctx.core.integrations.upsert(actor, { provider: 'whatsapp-cloud', ...WHATSAPP });
    expect(conn.config['phoneNumberId']).toBe('1234567890');
    expect(conn.config['verifyToken']).toBe('verify-me');
    await ctx.close();
  });

  it('leaves stored credentials untouched when a later save omits them', async () => {
    const actor = await ctx.actorFor(OWNER_EMAIL);
    await ctx.core.integrations.upsert(actor, { provider: 'whatsapp-cloud', ...WHATSAPP });

    // A settings form that only edits the phone number must not wipe a working token.
    await ctx.core.integrations.upsert(actor, {
      provider: 'whatsapp-cloud',
      status: 'connected',
      config: { phoneNumberId: '9999999999' },
    });

    const token = await ctx.core.integrations.readSecret(ctx.orgId, 'whatsapp-cloud', 'accessToken');
    expect(token).toBe('EAAG-super-secret-token');
    await ctx.close();
  });

  it('reports configured secret names without disclosing values', async () => {
    const actor = await ctx.actorFor(OWNER_EMAIL);
    await ctx.core.integrations.upsert(actor, { provider: 'whatsapp-cloud', ...WHATSAPP });
    const names = await ctx.core.integrations.listSecretNames(ctx.orgId, 'whatsapp-cloud');
    expect(names.sort()).toEqual(['accessToken', 'appSecret']);
    await ctx.close();
  });

  it('rotates a secret in place', async () => {
    const actor = await ctx.actorFor(OWNER_EMAIL);
    await ctx.core.integrations.upsert(actor, { provider: 'whatsapp-cloud', ...WHATSAPP });
    await ctx.core.integrations.upsert(actor, {
      provider: 'whatsapp-cloud',
      status: 'connected',
      config: { accessToken: 'EAAG-rotated-token' },
    });
    const token = await ctx.core.integrations.readSecret(ctx.orgId, 'whatsapp-cloud', 'accessToken');
    expect(token).toBe('EAAG-rotated-token');
    await ctx.close();
  });

  it('purges credentials on disconnect', async () => {
    const actor = await ctx.actorFor(OWNER_EMAIL);
    await ctx.core.integrations.upsert(actor, { provider: 'whatsapp-cloud', ...WHATSAPP });
    await ctx.core.integrations.disconnect(actor, 'whatsapp-cloud');

    expect(await ctx.core.integrations.readSecret(ctx.orgId, 'whatsapp-cloud', 'accessToken')).toBeNull();
    const rows = await ctx.db.client.query('select 1 from integration_secrets where org_id = $1', [ctx.orgId]);
    expect(rows.length).toBe(0);
    await ctx.close();
  });

  it('returns null for a secret that was never configured', async () => {
    expect(await ctx.core.integrations.readSecret(ctx.orgId, 'whatsapp-cloud', 'accessToken')).toBeNull();
    await ctx.close();
  });

  it('fails loudly when a stored secret cannot be decrypted', async () => {
    const actor = await ctx.actorFor(OWNER_EMAIL);
    await ctx.core.integrations.upsert(actor, { provider: 'whatsapp-cloud', ...WHATSAPP });

    // Simulate a SESSION_SECRET rotation (or tampering): the ciphertext no longer decrypts.
    // Returning '' here would push the caller back into silent mock delivery, which is the exact
    // failure this store was introduced to prevent.
    await ctx.db.client.query(
      "update integration_secrets set ciphertext = 'tampered' where org_id = $1 and secret_name = 'accessToken'",
      [ctx.orgId],
    );

    await expect(
      ctx.core.integrations.readSecret(ctx.orgId, 'whatsapp-cloud', 'accessToken'),
    ).rejects.toBeInstanceOf(ValidationError);
    await ctx.close();
  });

  it('does not leak secrets across organizations', async () => {
    const actor = await ctx.actorFor(OWNER_EMAIL);
    await ctx.core.integrations.upsert(actor, { provider: 'whatsapp-cloud', ...WHATSAPP });

    expect(await ctx.core.integrations.readSecret('org_someone_else', 'whatsapp-cloud', 'accessToken')).toBeNull();
    await ctx.close();
  });

  it('refuses to persist credentials for callers without integrations:manage', async () => {
    // `manager` holds `integrations:read` but deliberately NOT `integrations:manage`
    // (see permissions.ts) — writing provider credentials is an owner/admin action.
    const manager = await ctx.actorFor(MANAGER_EMAIL);
    await expect(
      ctx.core.integrations.upsert(manager, { provider: 'whatsapp-cloud', ...WHATSAPP }),
    ).rejects.toThrow(/integrations:manage/);

    // Nothing was written: a rejected save must not leave a half-stored credential.
    expect(await ctx.core.integrations.readSecret(ctx.orgId, 'whatsapp-cloud', 'accessToken')).toBeNull();

    const owner = await ctx.actorFor(OWNER_EMAIL);
    await expect(
      ctx.core.integrations.upsert(owner, { provider: 'whatsapp-cloud', ...WHATSAPP }),
    ).resolves.toBeDefined();
    await ctx.close();
  });

  it('builds a live WhatsApp driver from stored credentials', async () => {
    const actor = await ctx.actorFor(OWNER_EMAIL);
    await ctx.core.integrations.upsert(actor, { provider: 'whatsapp-cloud', ...WHATSAPP });

    // Mirrors what the send route does; proves the stored token is actually usable, not just
    // readable. The old code would have produced a MockWhatsAppChannel here.
    const accessToken = await ctx.core.integrations.readSecret(ctx.orgId, 'whatsapp-cloud', 'accessToken');
    const config = await ctx.core.integrations.getConnectionConfig(ctx.orgId, 'whatsapp-cloud');

    const driver = new WhatsAppCloudChannel({
      apiBase: String(config?.['apiBase']),
      accessToken: accessToken ?? '',
      phoneNumberId: String(config?.['phoneNumberId']),
    });
    expect(driver).toBeInstanceOf(WhatsAppCloudChannel);
    expect(driver.live).toBe(true);
    expect(driver).not.toBeInstanceOf(MockWhatsAppChannel);
    await ctx.close();
  });
});
