import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export interface EncryptedSecret {
  ciphertext: string;
  iv: string;
  authTag: string;
}

const KEY_CONTEXT = 'flowpilot:organization-ai-provider-key:v1\0';

export function encryptSecret(plaintext: string, rootSecret: string): EncryptedSecret {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(rootSecret), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    ciphertext: ciphertext.toString('base64url'),
    iv: iv.toString('base64url'),
    authTag: cipher.getAuthTag().toString('base64url'),
  };
}

export function decryptSecret(value: EncryptedSecret, rootSecret: string): string {
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(rootSecret), Buffer.from(value.iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(value.authTag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(value.ciphertext, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

function deriveKey(rootSecret: string): Buffer {
  if (rootSecret.length < 16) throw new Error('SESSION_SECRET must contain at least 16 characters to encrypt AI provider keys.');
  return createHash('sha256').update(KEY_CONTEXT).update(rootSecret, 'utf8').digest();
}
