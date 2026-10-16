import { describe, expect, it } from 'vitest';
import { hasLocalAiCredential } from '../src/lib/local-ai-credentials.js';

describe('local AI credential discovery', () => {
  it('recognizes the dotted top-level paths used by the local secrets file', () => {
    expect(hasLocalAiCredential({ 'providers.deepseek.apiKey': 'synthetic-key' }, 'deepseek')).toBe(true);
    expect(hasLocalAiCredential({ 'providers.openrouter.apiKey': '' }, 'openrouter')).toBe(false);
  });

  it('also recognizes nested provider objects without returning key material', () => {
    expect(hasLocalAiCredential({ providers: { 'minimax-cn': { apiKey: 'synthetic-key' } } }, 'minimax-cn')).toBe(true);
    expect(hasLocalAiCredential({ providers: { 'glm-cn': { apiKey: '   ' } } }, 'glm-cn')).toBe(false);
  });
});
