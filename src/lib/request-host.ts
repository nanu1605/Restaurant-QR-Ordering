/**
 * The host a request was sent to, for decisions that only shape that visitor's own
 * response, such as noindex (docs/DECISIONS.md W-12, VPS-2): the first X-Forwarded-Host,
 * else Host, as Next.js reads them for server actions. Without the port, in lower case.
 *
 * Under `next start` and the standalone server, `request.nextUrl` and `request.url` hold
 * the server's own bind address instead. A visitor can send these headers, so never build
 * a link from them: links use NEXT_PUBLIC_APP_URL.
 */
export function requestHostname(headers: Pick<Headers, 'get'>): string | null {
  const host =
    headers.get('x-forwarded-host')?.split(',')[0]?.trim() || headers.get('host')?.trim();
  if (!host) return null;
  // An IPv6 literal keeps its brackets: its colons aren't a port.
  const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]!;
  return name.toLowerCase() || null;
}
