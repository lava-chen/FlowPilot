import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export interface EncryptedSecret {
  ciphertext: string;
  iv: string;
  authTag: string;
}

/**
 * Domain-separated AES-256-GCM helpers.
 *
 * Why contexts: AES-GCM with a single key would let an attacker who could read the
 * AI provider ciphertext also read OAuth tokens. We split the keys by namespace so
 * compromising one ciphertext type reveals nothing about the other. New contexts can
 * be added without breaking existing data because each context has its own IV/key
 * prefix in the digest.
 */
const CONTEXTS = {
  aiProvider: 'flowpilot:organization-ai-provider-key:v1\0',
  oauthAccess: 'flowpilot:organization-oauth-access-token:v1\0',
  oauthRefresh: 'flowpilot:organization-oauth-refresh-token:v1\0',
} as const;

export type SecretContext = keyof typeof CONTEXTS;

export function encryptSecret(plaintext: string, rootSecret: string, context: SecretContext = 'aiProvider'): EncryptedSecret {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(rootSecret, context), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    ciphertext: ciphertext.toString('base64url'),
    iv: iv.toString('base64url'),
    authTag: cipher.getAuthTag().toString('base64url'),
  };
}

export function decryptSecret(value: EncryptedSecret, rootSecret: string, context: SecretContext = 'aiProvider'): string {
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(rootSecret, context), Buffer.from(value.iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(value.authTag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(value.ciphertext, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

function deriveKey(rootSecret: string, context: SecretContext): Buffer {
  if (rootSecret.length < 16) {
    throw new Error(`SESSION_SECRET must contain at least 16 characters to encrypt ${context} secrets.`);
  }
  return createHash('sha256').update(CONTEXTS[context]).update(rootSecret, 'utf8').digest();
}
