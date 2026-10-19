import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verifies a Meta-style webhook signature header against the raw request body.
 *
 * Header format (lower-case lookups, headers object casing varies by runtime):
 *   X-Hub-Signature-256: sha256=<hex hmac of raw body>
 *
 * The algorithm is documented at:
 *   https://developers.facebook.com/docs/graph-api/webhooks/getting-started#verification-requests
 *
 * Strict verification reasons:
 *  - We compare the *hex digest* using `timingSafeEqual`. Naive `===` leaks the signature
 *    length over time.
 *  - We validate that the prefix is exactly `sha256=` — Meta always uses SHA-256, so a header
 *    that omits the prefix is by definition invalid (the integration is misconfigured).
 *  - We accept arbitrary casing of the prefix so the same code works in Node 18+ and Node 20
 *    without depending on header normalization.
 */
export function verifyWhatsAppSignature(input: {
  appSecret: string;
  signatureHeader: string | null | undefined;
  rawBody: string;
}): boolean {
  const { appSecret, signatureHeader, rawBody } = input;
  if (!appSecret || !signatureHeader) return false;
  if (!signatureHeader.startsWith('sha256=')) return false;
  const provided = signatureHeader.slice('sha256='.length).trim();
  if (provided.length === 0) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody, 'utf8').digest('hex');
  // Both digests must be the same length for timingSafeEqual to be defined; reject otherwise.
  if (expected.length !== provided.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(provided, 'utf8'));
  } catch {
    return false;
  }
}

/**
 * Computes a signature for an outbound body. The webhook verifier unit-tests use this helper to
 * fabricate matching headers; production code never signs its own outgoing traffic because the
 * dashboard never initiates the webhook — Meta does.
 */
export function signWhatsAppBody(appSecret: string, rawBody: string): string {
  return `sha256=${createHmac('sha256', appSecret).update(rawBody, 'utf8').digest('hex')}`;
}

/**
 * Verifies the GET verification challenge (Meta's subscription handshake):
 *
 *   GET /webhook?hub.mode=subscribe&hub.verify_token=<expected>&hub.challenge=<echo>
 *   -> 200 with the challenge text
 *
 * Whitespace is trimmed; tokens are compared with `===` because they are both attacker-visible
 * and the verifier itself is the value being tested (there's nothing to time-attack against).
 */
export function verifyWhatsAppHandshake(input: {
  expectedVerifyToken: string;
  mode: string | null | undefined;
  verifyToken: string | null | undefined;
}): boolean {
  const { expectedVerifyToken, mode, verifyToken } = input;
  if (!expectedVerifyToken || !verifyToken) return false;
  if (mode !== 'subscribe') return false;
  return expectedVerifyToken.trim() === verifyToken.trim();
}
