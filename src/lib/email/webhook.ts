import { createHmac, timingSafeEqual } from 'node:crypto';

const TOLERANCE_SECONDS = 5 * 60;

/**
 * Resend signs its webhooks the Svix way (docs/DECISIONS.md SA-88):
 * base64 HMAC-SHA256 of "<svix-id>.<svix-timestamp>.<raw body>", keyed with
 * the base64 part of the whsec_ secret; svix-signature lists "v1,<sig>"
 * entries, space-separated. A timestamp over 5 minutes off is a replay.
 */
export function verifySvix(
  rawBody: string,
  headers: { id: string | null; timestamp: string | null; signature: string | null },
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature || !/^\d{1,12}$/.test(timestamp)) return false;
  if (Math.abs(nowSeconds - Number(timestamp)) > TOLERANCE_SECONDS) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const expected = Buffer.from(
    createHmac('sha256', key).update(`${id}.${timestamp}.${rawBody}`).digest('base64'),
  );
  return signature.split(' ').some((entry) => {
    const [version, value] = entry.split(',');
    const given = Buffer.from(value ?? '');
    return version === 'v1' && given.length === expected.length && timingSafeEqual(given, expected);
  });
}
