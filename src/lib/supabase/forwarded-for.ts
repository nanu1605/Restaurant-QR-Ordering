import 'server-only';

import { isIP } from 'node:net';

import { ipFromHeaders } from '@/lib/client-ip';
import { getServerEnv } from '@/lib/env.server';

/**
 * Supabase Auth limits sign-ins, token refreshes and second-factor codes per IP address. On the
 * VPS every such call comes from the web server, so the server clients that act for a visitor
 * name them (docs/DECISIONS.md VPS-4): Sb-Forwarded-For, which self-hosted Auth reads when
 * GOTRUE_SECURITY_SB_FORWARDED_FOR_ENABLED is on, and X-Real-IP, which it falls back to when
 * GOTRUE_RATE_LIMIT_HEADER names it. Hosted Supabase takes the header only with a secret key,
 * so SUPABASE_FORWARD_CLIENT_IP is off there.
 */

const HEADERS = ['sb-forwarded-for', 'x-real-ip'];

let warned = false;

/**
 * The visitor's address to name to Supabase Auth, or null: when the setting is off, and when the
 * request has no address (Auth ignores a value that isn't one, and logs it).
 */
export async function forwardedVisitorIp(
  getHeaders: () => Pick<Headers, 'get'> | Promise<Pick<Headers, 'get'>>,
): Promise<string | null> {
  if (!getServerEnv().SUPABASE_FORWARD_CLIENT_IP) return null;
  const ip = ipFromHeaders(await getHeaders());
  if (ip && isIP(ip)) return ip;
  // Said once, and never with the value: the visitor sent it.
  if (!warned) {
    warned = true;
    console.error(
      '[auth] no visitor IP to forward to Supabase Auth: does the proxy set X-Real-IP?',
    );
  }
  return null;
}

/**
 * A fetch that adds the visitor's address to Supabase Auth's calls and to no other. Not
 * global.headers: supabase-js copies those into the database, storage, functions and realtime
 * clients too.
 */
export function forwardingFetch(
  supabaseUrl: string,
  ip: string,
  fetchImpl: typeof fetch = (...args) => fetch(...args),
): typeof fetch {
  // The address supabase-js gives its Auth client (SupabaseClient: new URL('auth/v1', base)).
  const auth = new URL('auth/v1/', `${supabaseUrl.replace(/\/+$/, '')}/`).href;
  return (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith(auth)) return fetchImpl(input, init);
    // As fetch does: headers in init replace those a Request carries.
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    for (const name of HEADERS) headers.set(name, ip);
    return fetchImpl(input, { ...init, headers });
  };
}
