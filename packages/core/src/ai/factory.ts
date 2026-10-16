import type { Env } from '@flowpilot/shared';
import { DeterministicAiProvider } from './deterministic.js';
import { OpenAiCompatibleProvider } from './openai-compatible.js';
import type { AiProvider } from './provider.js';

export function createAiProviderFromEnv(env: Env): AiProvider {
  if (env.FLOWPILOT_AI_PROVIDER === 'openai-compatible') {
    return new OpenAiCompatibleProvider({
      baseUrl: env.FLOWPILOT_AI_BASE_URL,
      apiKey: env.FLOWPILOT_AI_API_KEY!,
      model: env.FLOWPILOT_AI_MODEL!,
      timeoutMs: env.FLOWPILOT_AI_TIMEOUT_MS,
    });
  }
  return new DeterministicAiProvider();
}
