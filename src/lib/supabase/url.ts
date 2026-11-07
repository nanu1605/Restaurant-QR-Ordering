import 'server-only';

import { getPublicEnv } from '@/lib/env';
import { getServerEnv } from '@/lib/env.server';

/** An address as clients write it in front of a path: origin and path, no final slash. */
const base = (url: string) => {
  const { origin, pathname } = new URL(url);
  return origin + pathname.replace(/\/+$/, '');
};

/**
 * The address the server's Supabase clients call: SUPABASE_INTERNAL_URL when it is set (on
 * the VPS the gateway is reached inside its own network), else the public address, so
 * Vercel and hosted staging are as they were (docs/DECISIONS.md VPS-20). The browser, next/image
 * and the security policy always keep the public address.
 */
export function supabaseServerUrl(): string {
  return getServerEnv().SUPABASE_INTERNAL_URL ?? getPublicEnv().NEXT_PUBLIC_SUPABASE_URL;
}

/**
 * A signed link the server got from storage, on an address a browser can open. storage-js
 * puts the address of the client that signed it in front, which is the internal one when
 * SUPABASE_INTERNAL_URL is set: out of reach of a browser, and blocked by the security policy.
 * A link on any other address is returned as it is.
 */
export function toPublicSupabaseUrl(link: string): string {
  const internal = getServerEnv().SUPABASE_INTERNAL_URL;
  if (!internal) return link;
  const from = base(internal);
  if (!link.startsWith(`${from}/`)) return link;
  return base(getPublicEnv().NEXT_PUBLIC_SUPABASE_URL) + link.slice(from.length);
}
