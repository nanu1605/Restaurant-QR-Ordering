import { jwtVerify, SignJWT } from 'jose';

/**
 * The customer device cookie `cid` (spec §9.2): a random device id signed with
 * CUSTOMER_COOKIE_SECRET, so a phone can only cancel its own dishes and rate
 * limits apply per phone. Pure functions, shared by the proxy and the server.
 */

export const DEVICE_COOKIE = 'cid';

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function signingKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export function newDeviceId(): string {
  return crypto.randomUUID();
}

export async function createDeviceToken(deviceId: string, secret: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(deviceId)
    .setIssuedAt()
    .sign(signingKey(secret));
}

/** The device id in a valid cookie value, or null (missing, tampered, or signed with another secret). */
export async function verifyDeviceToken(
  token: string | undefined,
  secret: string,
): Promise<string | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, signingKey(secret), { algorithms: ['HS256'] });
    return typeof payload.sub === 'string' && UUID_PATTERN.test(payload.sub) ? payload.sub : null;
  } catch {
    return null;
  }
}

/**
 * httpOnly, SameSite=Lax, one year, scoped to the customer pages. `Secure` only
 * when the app runs on https, so http://localhost and LAN testing still work.
 */
export function deviceCookieOptions(appUrl: string) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: appUrl.startsWith('https://'),
    path: '/t',
    maxAge: ONE_YEAR_SECONDS,
  };
}
