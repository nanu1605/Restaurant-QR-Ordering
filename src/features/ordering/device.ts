import 'server-only';

import { cookies } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';

import { getPublicEnv } from '@/lib/env';
import { getServerEnv } from '@/lib/env.server';

import {
  createDeviceToken,
  DEVICE_COOKIE,
  deviceCookieOptions,
  newDeviceId,
  verifyDeviceToken,
} from './device-token';

function secret(): string {
  return getServerEnv().CUSTOMER_COOKIE_SECRET;
}

/**
 * Proxy step for /t/*: gives a phone its device cookie on its first visit
 * (spec §9.2). The cookie is also set on the forwarded request, so the page
 * rendered for this very request already sees it.
 */
export async function withDeviceCookie(request: NextRequest): Promise<NextResponse> {
  if (await verifyDeviceToken(request.cookies.get(DEVICE_COOKIE)?.value, secret())) {
    return NextResponse.next();
  }

  const token = await createDeviceToken(newDeviceId(), secret());
  request.cookies.set(DEVICE_COOKIE, token);
  const response = NextResponse.next({ request });
  response.cookies.set(
    DEVICE_COOKIE,
    token,
    deviceCookieOptions(getPublicEnv().NEXT_PUBLIC_APP_URL),
  );
  return response;
}

/** This phone's device id, or null when it has no valid cookie. */
export async function readDeviceId(): Promise<string | null> {
  return verifyDeviceToken((await cookies()).get(DEVICE_COOKIE)?.value, secret());
}

/**
 * For server actions: the device id, issuing a cookie if the proxy's is missing
 * (e.g. cookies cleared while the page was open).
 */
export async function ensureDeviceId(): Promise<string> {
  const existing = await readDeviceId();
  if (existing) return existing;

  const deviceId = newDeviceId();
  (await cookies()).set(
    DEVICE_COOKIE,
    await createDeviceToken(deviceId, secret()),
    deviceCookieOptions(getPublicEnv().NEXT_PUBLIC_APP_URL),
  );
  return deviceId;
}
