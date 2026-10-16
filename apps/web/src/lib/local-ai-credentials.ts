import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { IntegrationError, ValidationError } from '@flowpilot/shared';

export const LOCAL_AI_CREDENTIAL_PROVIDERS = ['deepseek', 'minimax-cn', 'openrouter', 'glm-cn'] as const;
export type LocalAiCredentialProvider = (typeof LOCAL_AI_CREDENTIAL_PROVIDERS)[number];

const SECRET_FILE = join(homedir(), '.duya', 'secrets.json');

/** Returns provider labels only; secret values remain inside the server process. */
export async function listLocalAiCredentials(): Promise<LocalAiCredentialProvider[]> {
  if (process.env.NODE_ENV !== 'development') return [];
  const data = await readSecretFile();
  return LOCAL_AI_CREDENTIAL_PROVIDERS.filter((provider) => hasLocalAiCredential(data, provider));
}

/** Reads one allow-listed key from the local development credential store. */
export async function readLocalAiCredential(provider: LocalAiCredentialProvider): Promise<string> {
  const data = await readSecretFile();
  const apiKey = readApiKey(data, provider);
  if (!apiKey) throw new ValidationError(`No ${provider} API key is available in the local credential store.`);
  return apiKey;
}

/** Boolean-only probe for tests and safe provider discovery; never returns the secret value. */
export function hasLocalAiCredential(data: unknown, provider: LocalAiCredentialProvider): boolean {
  return readApiKey(data, provider) !== null;
}

async function readSecretFile(): Promise<unknown> {
  if (process.env.NODE_ENV !== 'development') return {};
  let contents: string;
  try {
    contents = await readFile(SECRET_FILE, 'utf8');
  } catch {
    return {};
  }
  try {
    return JSON.parse(contents) as unknown;
  } catch {
    throw new IntegrationError('The local credential store could not be parsed.');
  }
}

function readApiKey(data: unknown, provider: LocalAiCredentialProvider): string | null {
  if (!data || typeof data !== 'object') return null;
  const document = data as Record<string, unknown>;

  // Duya's secrets.json stores dotted paths as top-level keys; accept that format as well as
  // a nested JSON object so the local import works with either representation.
  const flatValue = document[`providers.${provider}.apiKey`];
  if (typeof flatValue === 'string' && flatValue.trim()) return flatValue.trim();

  const providers = document.providers;
  if (!providers || typeof providers !== 'object') return null;
  const entry = (providers as Record<string, unknown>)[provider];
  if (!entry || typeof entry !== 'object') return null;
  const nestedValue = (entry as { apiKey?: unknown }).apiKey;
  return typeof nestedValue === 'string' && nestedValue.trim() ? nestedValue.trim() : null;
}
