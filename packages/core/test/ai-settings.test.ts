import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ForbiddenError, ValidationError } from '@flowpilot/shared';
import { OpenAiCompatibleProvider } from '../src/ai/openai-compatible.js';
import { createTestContext, type TestContext, ADMIN_EMAIL, MEMBER_EMAIL } from './harness.js';

describe('organization AI provider settings', () => {
  let ctx: TestContext;
  beforeAll(async () => { ctx = await createTestContext(); });
  afterAll(async () => { await ctx.close(); });

  it('encrypts API keys, never returns them, and resolves the saved provider for this organization', async () => {
    const admin = await ctx.actorFor(ADMIN_EMAIL);
    const result = await ctx.core.aiSettings.save(admin, {
      provider: 'openai-compatible',
      baseUrl: 'https://api.example.test/v1',
      model: 'fixture-model',
      apiKey: 'secret-test-key',
    });
    expect(result).toMatchObject({ provider: 'openai-compatible', model: 'fixture-model', keyConfigured: true, source: 'organization' });
    expect(JSON.stringify(result)).not.toContain('secret-test-key');

    const stored = await ctx.db.repos.aiProviderSettings.find(ctx.orgId);
    expect(stored?.apiKeyCiphertext).toBeTruthy();
    expect(stored?.apiKeyCiphertext).not.toContain('secret-test-key');
    expect(JSON.stringify(stored)).not.toContain('secret-test-key');
    expect(await ctx.core.aiFor(admin)).toBeInstanceOf(OpenAiCompatibleProvider);

    const updated = await ctx.core.aiSettings.save(admin, {
      provider: 'openai-compatible',
      baseUrl: 'https://api.example.test/v1',
      model: 'fixture-model-2',
    });
    expect(updated).toMatchObject({ model: 'fixture-model-2', keyConfigured: true });
    expect((await ctx.db.repos.aiProviderSettings.find(ctx.orgId))?.apiKeyCiphertext).toBe(stored?.apiKeyCiphertext);
  });

  it('limits settings to org admins and validates endpoint safety', async () => {
    const admin = await ctx.actorFor(ADMIN_EMAIL);
    const member = await ctx.actorFor(MEMBER_EMAIL);
    await expect(ctx.core.aiSettings.get(member)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(ctx.core.aiSettings.save(member, { provider: 'deterministic' })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(ctx.core.aiSettings.save(admin, {
      provider: 'openai-compatible', baseUrl: 'http://169.254.169.254/latest', model: 'x', apiKey: 'test',
    })).rejects.toBeInstanceOf(ValidationError);
    await expect(ctx.core.aiSettings.save(admin, {
      provider: 'openai-compatible', baseUrl: 'https://user:password@example.test/v1', model: 'x', apiKey: 'test',
    })).rejects.toBeInstanceOf(ValidationError);
  });

  it('can return to deterministic analysis and clears the saved encrypted credential', async () => {
    const admin = await ctx.actorFor(ADMIN_EMAIL);
    const result = await ctx.core.aiSettings.save(admin, { provider: 'deterministic' });
    expect(result).toMatchObject({ provider: 'deterministic', keyConfigured: false, source: 'organization' });
    expect(await ctx.core.aiFor(admin)).toMatchObject({ name: 'deterministic', model: 'rule-based-v1' });
    expect(await ctx.db.repos.aiProviderSettings.find(ctx.orgId)).toMatchObject({
      provider: 'deterministic', apiKeyCiphertext: null, apiKeyIv: null, apiKeyAuthTag: null,
    });
  });
});
