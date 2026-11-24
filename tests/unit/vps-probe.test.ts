import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import {
  cacheVerdict,
  main,
  maxAge,
  type Net,
  type Options,
  parse,
  parseRanges,
  probe,
  type Timeouts,
  USAGE,
} from '../../scripts/vps-probe.mts';

/**
 * pnpm vps:probe (scripts/vps-probe.mts; the cut-over, VPS Stop D): the owner's read-only checks of
 * staging or production through Cloudflare once its DNS records point at the server. Every check
 * runs here against a fake edge that answers as the kit promises (menumesh.caddy, Envoy's routes,
 * the app's headers, Next.js's answer to an unknown server action), then against the one wrong
 * answer it exists to catch. Nothing here reaches the network: the probe's fetch, DNS, sockets and
 * Cloudflare's range lists are all the test's own, and the script itself is only run with
 * arguments it refuses before any request.
 */

const SHA = '4c2f0e5b9a7d1c3e8f6a2b4d0c9e7f1a3b5d7c9e';
const PASSWORD = 'Hx7-staging-only-4f0c2a9e';
const PAIR = `menumesh:${PASSWORD}`;
const TOKEN = Buffer.from(PAIR).toString('base64');
const BASIC = `Basic ${TOKEN}`;
const ORIGIN = '203.0.113.10';
const OBJECT = 'menu-images/0b7c4e2a/dish-1.webp';
const KEY = 'sb_publishable_AbCdEfGhIjKlMnOpQrStUv_x1Y2z3W4';
const PROBE = '/vps-probe?q=1';
// Cloudflare's lists as www.cloudflare.com/ips-v4 and ips-v6 gave them on 2026-11-17.
const V4 = [
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
].join('\n');
const V6 = [
  '2400:cb00::/32',
  '2606:4700::/32',
  '2803:f800::/32',
  '2405:b500::/32',
  '2405:8100::/32',
  '2a06:98c0::/29',
  '2c0f:f248::/32',
].join('\n');
const FAST: Timeouts = { request: 2_000, dns: 2_000, socket: 2_000, origin: 20 };
const STAGING_HOST = 'staging.menumesh.in';

const PRODUCTION: Options = {
  environment: 'production',
  version: SHA,
  origin: ORIGIN,
  object: OBJECT,
  publishableKey: KEY,
};
const STAGING: Options = { environment: 'staging', version: SHA, basicAuth: PAIR };

/** Every check of a production run with all its options, in the order it prints them. */
const PRODUCTION_CHECKS = [
  "menumesh.in resolves only to Cloudflare's addresses",
  "www.menumesh.in resolves only to Cloudflare's addresses",
  "api.menumesh.in resolves only to Cloudflare's addresses",
  'menumesh.in answers over https with a certificate Node trusts',
  'www.menumesh.in answers over https with a certificate Node trusts',
  'api.menumesh.in answers over https with a certificate Node trusts',
  'menumesh.in redirects http to https',
  'www.menumesh.in redirects http to https',
  'api.menumesh.in redirects http to https',
  'menumesh.in sends HSTS with a max-age of a year or more',
  'www.menumesh.in redirects to menumesh.in with 308, path and query kept',
  `menumesh.in/api/health answers 200 on ${SHA}`,
  "HTML from menumesh.in never comes from Cloudflare's cache",
  "RSC answers from menumesh.in never come from Cloudflare's cache",
  'RSC answers from menumesh.in carry x-nextjs-deployment-id',
  'menumesh.in answers an unknown server action with 409 and x-nextjs-action-not-found',
  'menumesh.in refuses a WebSocket upgrade with 400',
  'api.menumesh.in/ answers 404',
  'api.menumesh.in/pg/ answers 404',
  'api.menumesh.in/graphql/v1 answers 404',
  'api.menumesh.in/functions/v1/ answers 404',
  'api.menumesh.in/auth/v1/admin/users answers 401 without a key',
  'api.menumesh.in/rest/v1/ answers 401 without a key',
  "a public storage object on api.menumesh.in comes from Cloudflare's cache on the second try",
  'the Realtime WebSocket on api.menumesh.in opens',
  'menumesh.app redirects to menumesh.in with 308, path and query kept',
  'www.menumesh.app redirects to menumesh.in with 308, path and query kept',
  'menumesh.co redirects to menumesh.in with 308, path and query kept',
  'www.menumesh.co redirects to menumesh.in with 308, path and query kept',
  'the origin takes no connection on port 443 in 5 s',
  'the origin takes no connection on port 80 in 5 s',
];

/** Every check of a staging run, in the order it prints them. */
const STAGING_CHECKS = [
  "staging.menumesh.in resolves only to Cloudflare's addresses",
  'staging.menumesh.in answers over https with a certificate Node trusts',
  'staging.menumesh.in redirects http to https',
  'staging.menumesh.in answers 401 with WWW-Authenticate Basic without the pair',
  'staging.menumesh.in answers 200 with the pair',
  'staging.menumesh.in sends HSTS with a max-age of a year or more',
  `staging.menumesh.in/api/health answers 200 on ${SHA}`,
  "HTML from staging.menumesh.in never comes from Cloudflare's cache",
  "RSC answers from staging.menumesh.in never come from Cloudflare's cache",
  'RSC answers from staging.menumesh.in carry x-nextjs-deployment-id',
  'staging.menumesh.in answers an unknown server action with 409 and x-nextjs-action-not-found',
  'staging.menumesh.in refuses a WebSocket upgrade with 400',
  'staging.menumesh.in/api/health answers 200 without the pair',
  'staging.menumesh.in/app.webmanifest answers 200 without the pair',
  'staging.menumesh.in/sw.js answers 200 without the pair',
  'staging.menumesh.in/icon/192 answers 200 without the pair',
  'staging.menumesh.in/apple-icon answers 200 without the pair',
  'staging.menumesh.in/maskable-icon.png answers 200 without the pair',
  'staging.menumesh.in/favicon.ico answers 200 without the pair',
  'staging.menumesh.in/api/webhooks/razorpay reaches the app without the pair',
  'staging.menumesh.in/api/webhooks/resend reaches the app without the pair',
  'staging.menumesh.in sends x-robots-tag noindex',
];

// --- the fake edge ---

type Seen = {
  method: string;
  url: URL;
  headers: Headers;
  body: string | undefined;
  redirect: RequestRedirect | undefined;
  signal: AbortSignal | null | undefined;
};
type Hook<A extends unknown[], T> = (...args: A) => T | Error | 'hang' | undefined;
type World = {
  /** The edge's answer to a request, in place of the right one. */
  answer?: Hook<[Seen], Response>;
  a?: Hook<[string], string[]>;
  aaaa?: Hook<[string], string[]>;
  /** A TCP connection to the origin: by default nothing answers (a timeout). */
  connect?: Hook<[string, number], 'connected'>;
  upgrade?: Hook<[URL, Record<string, string>], number>;
  websocket?: Hook<[URL], 'open'>;
  cloudflare?: { v4: string; v6: string } | Error | 'hang';
};

const settle = <T>(value: T | Error | 'hang'): Promise<T> =>
  value === 'hang'
    ? new Promise<T>(() => undefined)
    : value instanceof Error
      ? Promise.reject(value)
      : Promise.resolve(value);

const reply = (status: number, headers: Record<string, string> = {}, body: string | null = null) =>
  new Response(body, { status, headers });

/** A failure as Node's fetch reports one: a TypeError whose cause holds the system's code. */
const fetchFailed = (code: string, message = 'socket problem') =>
  new TypeError('fetch failed', { cause: Object.assign(new Error(message), { code }) });

const OPEN = [
  '/api/health',
  '/app.webmanifest',
  '/sw.js',
  '/icon/192',
  '/apple-icon',
  '/maskable-icon.png',
  '/favicon.ico',
];
const OTHERS = ['menumesh.app', 'www.menumesh.app', 'menumesh.co', 'www.menumesh.co'];

/** The edge as the kit promises it, and what the probe asked of it. */
function fake(world: World = {}, pair = BASIC) {
  const seen: Seen[] = [];
  const upgrades: { url: string; headers: Record<string, string> }[] = [];
  const sockets: string[] = [];
  let objectTries = 0;

  // The app behind Caddy: staging's basic auth as menumesh.caddy has it, the app's own headers.
  const app = ({ url, method, headers }: Seen): Response => {
    const staging = url.hostname === STAGING_HOST;
    const exempt =
      ((method === 'GET' || method === 'HEAD') && OPEN.includes(url.pathname)) ||
      (method === 'POST' && url.pathname.startsWith('/api/webhooks/'));
    if (staging && !exempt && headers.get('authorization') !== pair) {
      return reply(401, { 'www-authenticate': 'Basic realm="restricted"' });
    }
    const common: Record<string, string> = {
      'strict-transport-security': 'max-age=63072000',
      'cf-cache-status': 'DYNAMIC',
      ...(staging ? { 'x-robots-tag': 'noindex' } : {}),
    };
    if (url.pathname === '/api/health') {
      return reply(
        200,
        { ...common, 'content-type': 'application/json' },
        JSON.stringify({ status: 'ok', db: 'ok', version: SHA, time: '2026-11-17T22:05:00.000Z' }),
      );
    }
    if (url.pathname === '/' && method === 'POST' && headers.get('next-action')) {
      return reply(
        409,
        { ...common, 'content-type': 'text/plain', 'x-nextjs-action-not-found': '1' },
        'Server Action unavailable.',
      );
    }
    if (url.pathname === '/' && headers.get('rsc') === '1') {
      return url.search === '?_rsc'
        ? reply(
            200,
            {
              ...common,
              'content-type': 'text/x-component',
              'x-nextjs-deployment-id': 'dpl-4c2f0e5b',
            },
            '0:{}',
          )
        : reply(307, { location: '/?_rsc' });
    }
    if (url.pathname === '/') {
      return reply(
        200,
        { ...common, 'content-type': 'text/html; charset=utf-8' },
        method === 'HEAD' ? null : '<!DOCTYPE html><html lang="en"></html>',
      );
    }
    if (OPEN.includes(url.pathname)) return reply(200, common, 'x');
    if (url.pathname.startsWith('/api/webhooks/') && method === 'POST') {
      return reply(
        400,
        { ...common, 'content-type': 'application/json' },
        '{"error":"Invalid signature"}',
      );
    }
    return reply(404, common, 'Not found');
  };

  // The gateway behind Caddy: only the four prefixes, Envoy's 401 without a key.
  const gateway = ({ url, headers }: Seen): Response => {
    if (!/^\/(auth|rest|realtime|storage)\/v1\//.test(url.pathname)) return reply(404);
    if (url.pathname === `/storage/v1/object/public/${OBJECT}`) {
      objectTries++;
      return reply(
        200,
        { 'content-type': 'image/webp', 'cf-cache-status': objectTries === 1 ? 'MISS' : 'HIT' },
        'RIFF....WEBP',
      );
    }
    return headers.get('apikey') ? reply(200, {}, '{}') : reply(401, {}, 'Unauthorized');
  };

  const edge = (request: Seen): Response => {
    const { url } = request;
    const there = `${url.pathname}${url.search}`;
    if (url.protocol === 'http:')
      return reply(301, { location: `https://${url.hostname}${there}` });
    if (url.hostname === 'www.menumesh.in' || OTHERS.includes(url.hostname)) {
      return reply(308, { location: `https://menumesh.in${there}` });
    }
    if (url.hostname === 'api.menumesh.in') return gateway(request);
    if (url.hostname === 'menumesh.in' || url.hostname === STAGING_HOST) return app(request);
    throw fetchFailed('ENOTFOUND');
  };

  const net: Net = {
    fetch: async (url, init) => {
      const request: Seen = {
        method: init.method ?? 'GET',
        url: new URL(url),
        headers: new Headers(init.headers),
        body: typeof init.body === 'string' ? init.body : undefined,
        redirect: init.redirect,
        signal: init.signal,
      };
      seen.push(request);
      return settle(world.answer?.(request) ?? edge(request));
    },
    resolve4: async (host) => settle(world.a?.(host) ?? ['104.21.48.1', '172.67.140.2']),
    resolve6: async (host) =>
      settle(world.aaaa?.(host) ?? ['2606:4700:3036::6815:3001', '2606:4700:3033::ac43:8c02']),
    connect: async (host, port) => {
      const dial = world.connect?.(host, port) ?? 'hang';
      return settle(dial).then(() => undefined);
    },
    upgrade: async (url, headers) => {
      upgrades.push({ url, headers });
      const target = new URL(url);
      const status =
        world.upgrade?.(target, headers) ??
        (target.hostname === STAGING_HOST && headers.authorization !== pair ? 401 : 400);
      return settle(status).then((code) => ({ status: code, headers: new Headers() }));
    },
    websocket: async (url) => {
      sockets.push(url);
      return settle(world.websocket?.(new URL(url)) ?? 'open').then(() => undefined);
    },
    cloudflare: async () => settle(world.cloudflare ?? { v4: V4, v6: V6 }),
  };
  return { net, seen, upgrades, sockets };
}

async function run(options: Options, world: World = {}, timeouts = FAST, pair = BASIC) {
  const lines: string[] = [];
  const edge = fake(world, pair);
  const result = await probe(options, edge.net, (line) => lines.push(line), timeouts);
  return { lines, result, ...edge };
}

const summary = (environment: string, checks: number, failed: number, skipped = 0) =>
  `vps:probe ${environment}: ${checks} checks, ${failed} failed, ${skipped} skipped`;

/** The lines of a run where every check passes but those named, which fail for the reason given. */
function expected(environment: 'production' | 'staging', bad: Record<string, string>) {
  const names = environment === 'production' ? PRODUCTION_CHECKS : STAGING_CHECKS;
  for (const name of Object.keys(bad)) expect(names, name).toContain(name);
  return [
    ...names.map((name) => (name in bad ? `bad ${name}: ${bad[name]}` : `ok ${name}`)),
    summary(environment, names.length, Object.keys(bad).length),
  ];
}

const isGet = (request: Seen, host: string, path: string) =>
  request.method === 'GET' && request.url.hostname === host && request.url.pathname === path;
const isPage = (request: Seen, host = 'menumesh.in') =>
  isGet(request, host, '/') && !request.headers.get('rsc') && request.url.protocol === 'https:';
const isRsc = (request: Seen, host = 'menumesh.in') =>
  isGet(request, host, '/') && request.headers.get('rsc') === '1';
const html = (headers: Record<string, string>) =>
  reply(200, { 'content-type': 'text/html; charset=utf-8', ...headers }, '<!DOCTYPE html>');

/** Answers the nth request a test picks (1 first), the right answer for the others. */
const nth = (pick: (request: Seen) => boolean, n: number, answer: () => Response) => {
  let count = 0;
  return (request: Seen) => (pick(request) && ++count === n ? answer() : undefined);
};

describe('pnpm vps:probe (the cut-over, VPS Stop D)', () => {
  it('passes every check against an edge that answers as the kit promises', async () => {
    const production = await run(PRODUCTION);
    expect(production.lines).toEqual(expected('production', {}));
    expect(production.result).toEqual({ checks: 31, failed: 0, skipped: 0 });
    const staging = await run(STAGING);
    expect(staging.lines).toEqual(expected('staging', {}));
    expect(staging.result).toEqual({ checks: 22, failed: 0, skipped: 0 });
  });

  it('skips what it was given nothing for, saying what to give, and names no version', async () => {
    const { lines, result } = await run({ environment: 'production' });
    const skips: Record<string, string> = {
      "a public storage object on api.menumesh.in comes from Cloudflare's cache on the second try":
        'give --object <bucket/path> to check it',
      'the Realtime WebSocket on api.menumesh.in opens': 'set PROBE_PUBLISHABLE_KEY to check it',
      'the origin takes no connection on port 443 in 5 s':
        'give --origin <server IPv4> to check it',
      'the origin takes no connection on port 80 in 5 s': 'give --origin <server IPv4> to check it',
    };
    expect(lines).toEqual([
      ...PRODUCTION_CHECKS.map((name) =>
        name === `menumesh.in/api/health answers 200 on ${SHA}`
          ? 'ok menumesh.in/api/health answers 200'
          : name in skips
            ? `skip ${name}: ${skips[name]}`
            : `ok ${name}`,
      ),
      summary('production', 31, 0, 4),
    ]);
    expect(result).toEqual({ checks: 31, failed: 0, skipped: 4 });
  });

  describe('fails each check on the answer it exists to catch', () => {
    const cases: [string, Options, World, Record<string, string>][] = [
      [
        'a name still at Vercel (DNS only)',
        PRODUCTION,
        { a: (host) => (host === 'menumesh.in' ? ['76.76.21.21'] : undefined) },
        {
          "menumesh.in resolves only to Cloudflare's addresses":
            '"76.76.21.21" is outside Cloudflare\'s published ranges: a DNS-only record, or a resolver that holds the old one until its TTL runs out',
        },
      ],
      [
        'a name that resolves to the origin',
        PRODUCTION,
        { a: (host) => (host === 'api.menumesh.in' ? [ORIGIN] : undefined) },
        {
          "api.menumesh.in resolves only to Cloudflare's addresses":
            'it resolves to the origin itself (203.0.113.10): its record must be proxied',
        },
      ],
      [
        'an AAAA answer outside Cloudflare (a DNS-only AAAA record)',
        PRODUCTION,
        {
          aaaa: (host) =>
            host === 'www.menumesh.in'
              ? ['2606:4700:3036::6815:3001', '2a02:4780:12::1']
              : undefined,
        },
        {
          "www.menumesh.in resolves only to Cloudflare's addresses":
            '"2a02:4780:12::1" is outside Cloudflare\'s published ranges: a DNS-only record, or a resolver that holds the old one until its TTL runs out',
        },
      ],
      [
        'a name with no A record',
        STAGING,
        {
          a: (host) =>
            host === STAGING_HOST
              ? Object.assign(new Error('queryA ENOTFOUND'), { code: 'ENOTFOUND' })
              : undefined,
        },
        {
          "staging.menumesh.in resolves only to Cloudflare's addresses":
            'it has no A record (ENOTFOUND)',
        },
      ],
      [
        "a range list that would take any address as Cloudflare's",
        PRODUCTION,
        { cloudflare: { v4: '0.0.0.0/0', v6: V6 } },
        Object.fromEntries(
          PRODUCTION_CHECKS.slice(0, 3).map((name) => [
            name,
            "Cloudflare's published IPv4 list holds something that is not one of its ranges",
          ]),
        ),
      ],
      [
        'a range list that cannot be fetched',
        STAGING,
        { cloudflare: fetchFailed('ECONNRESET') },
        {
          "staging.menumesh.in resolves only to Cloudflare's addresses":
            "Cloudflare's published ranges could not be fetched (the request failed (ECONNRESET))",
        },
      ],
      [
        'a certificate Node does not trust',
        PRODUCTION,
        {
          answer: (request) =>
            request.method === 'HEAD' && request.url.hostname === 'api.menumesh.in'
              ? fetchFailed('CERT_HAS_EXPIRED', 'certificate has expired')
              : undefined,
        },
        {
          'api.menumesh.in answers over https with a certificate Node trusts':
            'the request failed (CERT_HAS_EXPIRED)',
        },
      ],
      [
        'http answered with a 302',
        PRODUCTION,
        {
          answer: (request) =>
            request.url.protocol === 'http:' && request.url.hostname === 'www.menumesh.in'
              ? reply(302, { location: `https://www.menumesh.in${PROBE}` })
              : undefined,
        },
        { 'www.menumesh.in redirects http to https': 'answered 302, not 301 or 308' },
      ],
      [
        'http to https that drops the path',
        STAGING,
        {
          answer: (request) =>
            request.url.protocol === 'http:'
              ? reply(301, { location: `https://${STAGING_HOST}/` })
              : undefined,
        },
        {
          'staging.menumesh.in redirects http to https': `Location is "https://${STAGING_HOST}/", not "https://${STAGING_HOST}${PROBE}"`,
        },
      ],
      [
        'HSTS for a day',
        PRODUCTION,
        {
          answer: (request) =>
            isPage(request)
              ? html({ 'strict-transport-security': 'max-age=86400', 'cf-cache-status': 'DYNAMIC' })
              : undefined,
        },
        {
          'menumesh.in sends HSTS with a max-age of a year or more':
            'its max-age is 86400 s, under a year (31536000 s)',
        },
      ],
      [
        'no HSTS',
        PRODUCTION,
        {
          answer: (request) =>
            isPage(request) ? html({ 'cf-cache-status': 'DYNAMIC' }) : undefined,
        },
        {
          'menumesh.in sends HSTS with a max-age of a year or more':
            'its answer (200) has no Strict-Transport-Security header',
        },
      ],
      [
        'www redirected with a 301',
        PRODUCTION,
        {
          answer: (request) =>
            request.url.protocol === 'https:' && request.url.hostname === 'www.menumesh.in'
              ? reply(301, { location: `https://menumesh.in${PROBE}` })
              : undefined,
        },
        {
          'www.menumesh.in redirects to menumesh.in with 308, path and query kept':
            'answered 301, not 308',
        },
      ],
      [
        'www redirected without the query',
        PRODUCTION,
        {
          answer: (request) =>
            request.url.protocol === 'https:' && request.url.hostname === 'www.menumesh.in'
              ? reply(308, { location: 'https://menumesh.in/vps-probe' })
              : undefined,
        },
        {
          'www.menumesh.in redirects to menumesh.in with 308, path and query kept':
            'Location is "https://menumesh.in/vps-probe", not "https://menumesh.in/vps-probe?q=1"',
        },
      ],
      [
        'the health check on another build',
        PRODUCTION,
        {
          answer: (request) =>
            isGet(request, 'menumesh.in', '/api/health')
              ? reply(200, {}, JSON.stringify({ status: 'ok', db: 'ok', version: 'f'.repeat(40) }))
              : undefined,
        },
        {
          [`menumesh.in/api/health answers 200 on ${SHA}`]: `it runs "${'f'.repeat(40)}", not ${SHA}`,
        },
      ],
      [
        'the health check while the origin is down',
        STAGING,
        {
          // The health check's own request, with the pair; the open path's goes without it.
          answer: (request) =>
            isGet(request, STAGING_HOST, '/api/health') && request.headers.has('authorization')
              ? reply(522, {}, 'error code: 522')
              : undefined,
        },
        {
          [`staging.menumesh.in/api/health answers 200 on ${SHA}`]:
            "answered 522 (Cloudflare's connection to the origin timed out), not 200",
        },
      ],
      [
        'HTML from the cache on the second try',
        PRODUCTION,
        {
          answer: nth(isPage, 2, () =>
            html({ 'strict-transport-security': 'max-age=63072000', 'cf-cache-status': 'HIT' }),
          ),
        },
        {
          "HTML from menumesh.in never comes from Cloudflare's cache":
            'try 2: cf-cache-status HIT: Cloudflare served it from its cache',
        },
      ],
      [
        'HTML a cache rule covers',
        PRODUCTION,
        {
          answer: nth(isPage, 1, () =>
            html({ 'strict-transport-security': 'max-age=63072000', 'cf-cache-status': 'MISS' }),
          ),
        },
        {
          "HTML from menumesh.in never comes from Cloudflare's cache":
            'try 1: cf-cache-status MISS: Cloudflare may cache it, so a cache rule covers it',
        },
      ],
      [
        'an RSC answer from the cache on the second try',
        PRODUCTION,
        {
          answer: nth(isRsc, 2, () =>
            reply(
              200,
              {
                'content-type': 'text/x-component',
                'x-nextjs-deployment-id': 'dpl',
                'cf-cache-status': 'HIT',
              },
              '0:{}',
            ),
          ),
        },
        {
          "RSC answers from menumesh.in never come from Cloudflare's cache":
            'try 2: cf-cache-status HIT: Cloudflare served it from its cache',
        },
      ],
      [
        'an RSC answer without x-nextjs-deployment-id',
        PRODUCTION,
        {
          answer: (request) =>
            isRsc(request) ? reply(200, { 'content-type': 'text/x-component' }, '0:{}') : undefined,
        },
        {
          'RSC answers from menumesh.in carry x-nextjs-deployment-id':
            'the header is missing, so a page from an older build would not reload by itself',
        },
      ],
      [
        'RSC requests sent on to the right _rsc (the request would be wrong)',
        PRODUCTION,
        {
          answer: (request) =>
            isRsc(request) ? reply(307, { location: '/?_rsc=abc' }) : undefined,
        },
        {
          "RSC answers from menumesh.in never come from Cloudflare's cache":
            'try 1 answered 307, not 200',
          'RSC answers from menumesh.in carry x-nextjs-deployment-id': 'answered 307, not 200',
        },
      ],
      [
        'an RSC request answered with HTML (a cache that ignores the RSC header)',
        STAGING,
        {
          answer: (request) =>
            isRsc(request, STAGING_HOST) ? html({ 'cf-cache-status': 'DYNAMIC' }) : undefined,
        },
        {
          "RSC answers from staging.menumesh.in never come from Cloudflare's cache":
            'try 1 answered 200 with Content-Type "text/html; charset=utf-8", not an RSC payload',
          'RSC answers from staging.menumesh.in carry x-nextjs-deployment-id':
            'answered 200 with Content-Type "text/html; charset=utf-8", not an RSC payload',
        },
      ],
      [
        'an unknown server action answered 404 without the header',
        PRODUCTION,
        {
          answer: (request) =>
            request.method === 'POST'
              ? reply(404, { 'content-type': 'text/html' }, 'Not found')
              : undefined,
        },
        {
          'menumesh.in answers an unknown server action with 409 and x-nextjs-action-not-found':
            'answered 404 without x-nextjs-action-not-found: 1, not 409 with it',
        },
      ],
      [
        'an unknown server action answered 409 with the header stripped',
        STAGING,
        {
          answer: (request) =>
            request.method === 'POST' && request.url.pathname === '/'
              ? reply(409, { 'content-type': 'text/plain' }, 'Server Action unavailable.')
              : undefined,
        },
        {
          'staging.menumesh.in answers an unknown server action with 409 and x-nextjs-action-not-found':
            'answered 409 without x-nextjs-action-not-found: 1, not 409 with it',
        },
      ],
      [
        'an upgrade let through',
        PRODUCTION,
        { upgrade: () => 101 },
        {
          'menumesh.in refuses a WebSocket upgrade with 400':
            'it switched protocols (101): the edge lets upgrades through to the app',
        },
      ],
      [
        'an upgrade answered as a page',
        STAGING,
        { upgrade: () => 200 },
        { 'staging.menumesh.in refuses a WebSocket upgrade with 400': 'answered 200, not 400' },
      ],
      ...(['/', '/pg/', '/graphql/v1', '/functions/v1/'] as const).map(
        (path): [string, Options, World, Record<string, string>] => [
          `the gateway serving ${path}`,
          PRODUCTION,
          {
            answer: (request) =>
              isGet(request, 'api.menumesh.in', path) ? reply(200, {}, '{}') : undefined,
          },
          { [`api.menumesh.in${path} answers 404`]: 'answered 200, not 404' },
        ],
      ),
      ...(['/auth/v1/admin/users', '/rest/v1/'] as const).map(
        (path): [string, Options, World, Record<string, string>] => [
          `the gateway answering ${path} without a key`,
          PRODUCTION,
          {
            answer: (request) =>
              isGet(request, 'api.menumesh.in', path) ? reply(200, {}, '[]') : undefined,
          },
          { [`api.menumesh.in${path} answers 401 without a key`]: 'answered 200, not 401' },
        ],
      ),
      [
        'a public object that stays out of the cache',
        PRODUCTION,
        {
          answer: (request) =>
            request.url.pathname.startsWith('/storage/v1/object/public/')
              ? reply(200, { 'content-type': 'image/webp', 'cf-cache-status': 'MISS' }, 'RIFF')
              : undefined,
        },
        {
          "a public storage object on api.menumesh.in comes from Cloudflare's cache on the second try":
            'try 2\'s cf-cache-status is "MISS", not "HIT": the cache rule for /storage/v1/object/public/* is not on, or the object\'s answer is not cacheable',
        },
      ],
      [
        'a public object that is not there',
        PRODUCTION,
        {
          answer: (request) =>
            request.url.pathname.startsWith('/storage/v1/object/public/')
              ? reply(404, { 'content-type': 'application/json' }, '{"error":"not_found"}')
              : undefined,
        },
        {
          "a public storage object on api.menumesh.in comes from Cloudflare's cache on the second try":
            'try 1 answered 404, not 200',
        },
      ],
      [
        'a Realtime socket that does not open',
        PRODUCTION,
        { websocket: () => new Error('Received network error or non-101 status code.') },
        {
          'the Realtime WebSocket on api.menumesh.in opens':
            'it did not open ("Received network error or non-101 status code.")',
        },
      ],
      [
        'another domain redirected with a 301',
        PRODUCTION,
        {
          answer: (request) =>
            request.url.hostname === 'menumesh.co'
              ? reply(301, { location: `https://menumesh.in${PROBE}` })
              : undefined,
        },
        {
          'menumesh.co redirects to menumesh.in with 308, path and query kept':
            'answered 301, not 308',
        },
      ],
      [
        'another domain redirected to the home page',
        PRODUCTION,
        {
          answer: (request) =>
            request.url.hostname === 'www.menumesh.app'
              ? reply(308, { location: 'https://menumesh.in/' })
              : undefined,
        },
        {
          'www.menumesh.app redirects to menumesh.in with 308, path and query kept':
            'Location is "https://menumesh.in/", not "https://menumesh.in/vps-probe?q=1"',
        },
      ],
      [
        'an origin that takes connections',
        PRODUCTION,
        { connect: () => 'connected' },
        {
          'the origin takes no connection on port 443 in 5 s':
            '203.0.113.10:443 took the connection, so the server can be reached around Cloudflare',
          'the origin takes no connection on port 80 in 5 s':
            '203.0.113.10:80 took the connection, so the server can be reached around Cloudflare (or this network intercepts port 80: run it from another)',
        },
      ],
      [
        'an origin that refuses (a firewall that rejects instead of dropping)',
        PRODUCTION,
        {
          connect: (host, port) =>
            port === 443
              ? Object.assign(new Error(`connect ECONNREFUSED ${host}:${port}`), {
                  code: 'ECONNREFUSED',
                })
              : undefined,
        },
        {
          'the origin takes no connection on port 443 in 5 s':
            '203.0.113.10:443 refused the connection, so the address answers, where the leak test expects no answer at all',
        },
      ],
      [
        'an origin this machine has no route to',
        PRODUCTION,
        {
          connect: (host, port) =>
            port === 80
              ? Object.assign(new Error(`connect EHOSTUNREACH ${host}:${port}`), {
                  code: 'EHOSTUNREACH',
                })
              : undefined,
        },
        {
          'the origin takes no connection on port 80 in 5 s':
            'the connection to 203.0.113.10:80 failed (EHOSTUNREACH) instead of timing out, as the leak test expects',
        },
      ],
      [
        'staging open without the password',
        STAGING,
        {
          answer: (request) =>
            isPage(request, STAGING_HOST) && !request.headers.get('authorization')
              ? html({ 'strict-transport-security': 'max-age=63072000' })
              : undefined,
        },
        {
          'staging.menumesh.in answers 401 with WWW-Authenticate Basic without the pair':
            'answered 200, not 401',
        },
      ],
      [
        'staging refusing without asking for basic auth',
        STAGING,
        {
          answer: (request) =>
            isPage(request, STAGING_HOST) && !request.headers.get('authorization')
              ? reply(401)
              : undefined,
        },
        {
          'staging.menumesh.in answers 401 with WWW-Authenticate Basic without the pair':
            'WWW-Authenticate is none, not Basic',
        },
      ],
      [
        'an install file behind the password',
        STAGING,
        {
          answer: (request) =>
            isGet(request, STAGING_HOST, '/sw.js')
              ? reply(401, { 'www-authenticate': 'Basic realm="restricted"' })
              : undefined,
        },
        { 'staging.menumesh.in/sw.js answers 200 without the pair': 'answered 401, not 200' },
      ],
      [
        'a webhook behind the password',
        STAGING,
        {
          answer: (request) =>
            request.method === 'POST' && request.url.pathname === '/api/webhooks/resend'
              ? reply(401, { 'www-authenticate': 'Basic realm="restricted"' })
              : undefined,
        },
        {
          'staging.menumesh.in/api/webhooks/resend reaches the app without the pair':
            'answered 401: the edge asks for the password',
        },
      ],
      [
        'a webhook that takes an unsigned body',
        STAGING,
        {
          answer: (request) =>
            request.method === 'POST' && request.url.pathname === '/api/webhooks/razorpay'
              ? reply(200, {}, '{"ok":true}')
              : undefined,
        },
        {
          'staging.menumesh.in/api/webhooks/razorpay reaches the app without the pair':
            "answered 200, not the app's refusal (400, or 503 where it is not set up)",
        },
      ],
      [
        'staging without noindex',
        STAGING,
        {
          answer: (request) =>
            isPage(request, STAGING_HOST) && request.headers.get('authorization') === BASIC
              ? html({
                  'strict-transport-security': 'max-age=63072000',
                  'cf-cache-status': 'DYNAMIC',
                })
              : undefined,
        },
        { 'staging.menumesh.in sends x-robots-tag noindex': 'x-robots-tag is none' },
      ],
    ];
    it.each(cases)('%s', async (_label, options, world, bad) => {
      const { lines, result } = await run(options, world);
      expect(lines).toEqual(expected(options.environment, bad));
      expect(result.failed).toBe(Object.keys(bad).length);
    });
  });

  it('passes a webhook that is not set up (503), as the app answers before its secret exists', async () => {
    const { lines } = await run(STAGING, {
      answer: (request) =>
        request.method === 'POST' && request.url.pathname.startsWith('/api/webhooks/')
          ? reply(503, {}, '{"error":"Webhooks are not set up"}')
          : undefined,
    });
    expect(lines).toEqual(expected('staging', {}));
  });

  it("names every check a wrong pair breaks, and the open paths it doesn't", async () => {
    const { lines } = await run(
      { ...STAGING, basicAuth: 'menumesh:not-the-password' },
      {},
      FAST,
      BASIC,
    );
    expect(lines).toEqual(
      expected('staging', {
        'staging.menumesh.in answers 200 with the pair':
          'answered 401, not 200: the pair in SMOKE_BASIC_AUTH is not the one the edge takes',
        'staging.menumesh.in sends HSTS with a max-age of a year or more':
          'its answer (401) has no Strict-Transport-Security header',
        "HTML from staging.menumesh.in never comes from Cloudflare's cache":
          'try 1 answered 401, not 200',
        "RSC answers from staging.menumesh.in never come from Cloudflare's cache":
          'try 1 answered 401, not 200',
        'RSC answers from staging.menumesh.in carry x-nextjs-deployment-id':
          'answered 401, not 200',
        'staging.menumesh.in answers an unknown server action with 409 and x-nextjs-action-not-found':
          'answered 401 without x-nextjs-action-not-found: 1, not 409 with it',
        'staging.menumesh.in refuses a WebSocket upgrade with 400': 'answered 401, not 400',
        'staging.menumesh.in sends x-robots-tag noindex': 'x-robots-tag is none',
      }),
    );
  });

  it('fails a check that gets no answer instead of hanging: requests, DNS, the upgrade, the socket', async () => {
    const quick: Timeouts = { request: 200, dns: 200, socket: 200, origin: 20 };
    const started = Date.now();
    const { lines, result } = await run(
      PRODUCTION,
      {
        answer: (request) => (isGet(request, 'api.menumesh.in', '/pg/') ? 'hang' : undefined),
        a: (host) => (host === 'www.menumesh.in' ? 'hang' : undefined),
        upgrade: () => 'hang',
        websocket: () => 'hang',
      },
      quick,
    );
    expect(lines).toEqual(
      expected('production', {
        "www.menumesh.in resolves only to Cloudflare's addresses":
          'the lookup of its A records got no answer in 0.2 s',
        'menumesh.in refuses a WebSocket upgrade with 400': 'no answer in 0.2 s',
        'api.menumesh.in/pg/ answers 404': 'no answer in 0.2 s',
        'the Realtime WebSocket on api.menumesh.in opens': 'no answer in 0.2 s',
      }),
    );
    expect(result.failed).toBe(4);
    expect(Date.now() - started).toBeLessThan(5_000);
    // Cloudflare's lists unanswered: every name's check says so.
    const lists = await run(STAGING, { cloudflare: 'hang' }, quick);
    expect(lists.lines[0]).toBe(
      "bad staging.menumesh.in resolves only to Cloudflare's addresses: Cloudflare's published ranges could not be fetched (no answer in 0.2 s)",
    );
  });

  it('gives each request a deadline, follows no redirect and names itself', async () => {
    for (const options of [PRODUCTION, STAGING]) {
      const { seen, upgrades } = await run(options);
      expect(seen.length).toBe(options.environment === 'production' ? 25 : 18);
      for (const request of seen) {
        expect(request.redirect, request.url.href).toBe('manual');
        expect(request.signal, request.url.href).toBeInstanceOf(AbortSignal);
        expect(request.headers.get('user-agent')).toBe('menumesh-vps-probe');
      }
      expect(upgrades).toHaveLength(1);
      expect(upgrades[0].headers['user-agent']).toBe('menumesh-vps-probe');
    }
  });

  it('only reads: GET and HEAD, an action id no build has, and webhook bodies with no valid signature', async () => {
    const production = await run(PRODUCTION);
    const staging = await run(STAGING);
    const seen = [...production.seen, ...staging.seen];
    expect([...new Set(seen.map((request) => request.method))].sort()).toEqual([
      'GET',
      'HEAD',
      'POST',
    ]);
    const posts = seen.filter((request) => request.method === 'POST');
    expect(
      posts.map((request) => `${request.url.host}${request.url.pathname} ${request.body}`),
    ).toEqual([
      'menumesh.in/ []',
      'staging.menumesh.in/ []',
      'staging.menumesh.in/api/webhooks/razorpay {}',
      'staging.menumesh.in/api/webhooks/resend {}',
    ]);
    // The action as Next.js's router sends one, with an id of a real id's length (409, not 400).
    for (const action of posts.filter((request) => request.url.pathname === '/')) {
      expect(action.headers.get('next-action')).toMatch(/^0{42}$/);
      expect(action.headers.get('content-type')).toBe('text/plain;charset=UTF-8');
      expect(action.headers.get('origin')).toBe(`https://${action.url.host}`);
    }
    expect(posts[2].headers.get('x-razorpay-signature')).toBe('wrong');
    expect(posts[3].headers.has('svix-signature')).toBe(false);
    // The RSC request Next.js takes as it is, and the upgrade as a browser asks for one.
    const rsc = production.seen.filter((request) => request.headers.get('rsc') === '1');
    expect(rsc.map((request) => request.url.href)).toEqual([
      'https://menumesh.in/?_rsc',
      'https://menumesh.in/?_rsc',
    ]);
    expect(production.upgrades).toEqual([
      {
        url: 'https://menumesh.in/',
        headers: {
          'user-agent': 'menumesh-vps-probe',
          connection: 'Upgrade',
          upgrade: 'websocket',
          'sec-websocket-version': '13',
          'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
        },
      },
    ]);
    expect(production.sockets).toEqual([
      `wss://api.menumesh.in/realtime/v1/websocket?apikey=${KEY}&vsn=1.0.0`,
    ]);
    // Only the environment's hosts and the domains that redirect to it.
    expect([...new Set(production.seen.map((request) => request.url.host))].sort()).toEqual([
      'api.menumesh.in',
      'menumesh.app',
      'menumesh.co',
      'menumesh.in',
      'www.menumesh.app',
      'www.menumesh.co',
      'www.menumesh.in',
    ]);
    expect([...new Set(staging.seen.map((request) => request.url.host))]).toEqual([STAGING_HOST]);
  });

  it('sends the pair over https to staging only, and never prints it, even when an answer echoes it', async () => {
    const { seen, upgrades } = await run(STAGING);
    const sent = seen.filter((request) => request.headers.has('authorization'));
    expect(sent.length).toBeGreaterThan(5);
    for (const request of sent) {
      expect(request.url.origin).toBe(`https://${STAGING_HOST}`);
      expect(request.headers.get('authorization')).toBe(BASIC);
    }
    // Not where it is to be left out: plain http, the webhooks, and each open path's own check.
    expect(seen.filter((request) => request.url.protocol === 'http:')).toHaveLength(1);
    for (const request of seen) {
      const webhook = request.method === 'POST' && request.url.pathname !== '/';
      if (request.url.protocol === 'http:' || webhook) {
        expect(request.headers.has('authorization'), request.url.href).toBe(false);
      }
    }
    for (const path of OPEN) {
      const bare = seen.filter(
        (r) => isGet(r, STAGING_HOST, path) && !r.headers.has('authorization'),
      );
      expect(bare, path).toHaveLength(1);
    }
    expect(upgrades[0].headers.authorization).toBe(BASIC);

    // An edge that echoes the pair, its password and its header in everything the probe prints
    // from an answer, in other cases of letters too, and fails every check, some with errors that
    // carry the password.
    const echo = {
      location: `https://${PAIR}@staging.menumesh.in/${PASSWORD}`,
      'www-authenticate': `Bearer ${BASIC}`,
      'x-robots-tag': PASSWORD.toUpperCase(),
      'content-type': `text/${PASSWORD.toLowerCase()}`,
      'cf-cache-status': PASSWORD,
      'strict-transport-security': `max-age=1; ${TOKEN}`,
    };
    const leaky = await run(STAGING, {
      answer: (request) =>
        request.method === 'HEAD'
          ? fetchFailed('ECONNRESET', `reset while sending ${BASIC}`)
          : isGet(request, STAGING_HOST, '/api/health') && request.headers.has('authorization')
            ? reply(200, echo, JSON.stringify({ status: PAIR, version: PASSWORD }))
            : isRsc(request, STAGING_HOST)
              ? reply(200, echo, PASSWORD)
              : reply(request.url.protocol === 'http:' ? 301 : 418, echo, PASSWORD),
      a: () => [PASSWORD],
      upgrade: () => new Error(`refused ${PAIR}`),
    });
    const printed = leaky.lines.join('\n');
    expect(leaky.result.failed).toBe(STAGING_CHECKS.length);
    for (const secret of [PASSWORD, PAIR, TOKEN, BASIC]) {
      expect(printed.toLowerCase()).not.toContain(secret.toLowerCase());
    }
    expect(printed).toContain(
      'bad staging.menumesh.in sends x-robots-tag noindex: x-robots-tag is "[hidden]"',
    );
    expect(printed).toContain('answered 200 with Content-Type "text/[hidden]", not an RSC payload');

    // Production never sends it, set or not.
    const lines: string[] = [];
    const production = fake();
    await main(
      ['production'],
      { SMOKE_BASIC_AUTH: PAIR },
      production.net,
      (line) => lines.push(line),
      () => undefined,
      FAST,
    );
    expect(production.seen.filter((request) => request.headers.has('authorization'))).toEqual([]);
    expect(production.upgrades[0].headers).not.toHaveProperty('authorization');
    expect(lines.join('\n')).not.toContain(PASSWORD);
  });

  it("never prints the publishable key, though the socket's URL carries it", async () => {
    const { lines } = await run(PRODUCTION, {
      websocket: (url) => new Error(`could not open ${url.href}`),
    });
    const printed = lines.join('\n');
    expect(printed).not.toContain(KEY);
    expect(printed).toContain(
      'bad the Realtime WebSocket on api.menumesh.in opens: it did not open ("could not open wss://api.menumesh.in/realtime/v1/websocket?apikey=[hidden]&vsn=1.0.0")',
    );
  });

  it('exits 0 when every check passes or is skipped, 1 when one fails or the command is refused', async () => {
    const quiet = () => undefined;
    expect(await main(['production'], {}, fake().net, quiet, quiet, FAST)).toBe(0);
    expect(
      await main(['staging'], { SMOKE_BASIC_AUTH: PAIR }, fake().net, quiet, quiet, FAST),
    ).toBe(0);
    expect(
      await main(['production', '--version', 'f'.repeat(40)], {}, fake().net, quiet, quiet, FAST),
    ).toBe(1);
    const out: string[] = [];
    const err: string[] = [];
    const before = fake();
    expect(
      await main(
        ['staging'],
        {},
        before.net,
        (l) => out.push(l),
        (l) => err.push(l),
        FAST,
      ),
    ).toBe(1);
    expect(before.seen).toEqual([]);
    expect(out).toEqual([]);
    expect(err).toEqual([
      "vps:probe: staging needs SMOKE_BASIC_AUTH: staging's basic-auth pair as user:password (the name pnpm smoke reads), from the environment only",
    ]);
    expect(await main(['--help'], {}, before.net, (l) => out.push(l), quiet, FAST)).toBe(0);
    expect(out).toEqual([USAGE]);
  });

  it('reads its command line and environment, refusing anything else before any request', () => {
    const env = { SMOKE_BASIC_AUTH: PAIR };
    expect(parse(['production'], env)).toEqual({ options: { environment: 'production' } });
    expect(
      parse(['production', '--version', SHA, '--origin', ORIGIN, '--object', OBJECT], {
        PROBE_PUBLISHABLE_KEY: KEY,
      }),
    ).toEqual({ options: { ...PRODUCTION } });
    expect(parse(['--version', SHA, 'staging'], env)).toEqual({
      options: { environment: 'staging', version: SHA, basicAuth: PAIR },
    });
    // The password may hold colons, split at the first as pnpm smoke does; staging ignores the key.
    expect(
      parse(['staging'], { SMOKE_BASIC_AUTH: 'menumesh:a:b', PROBE_PUBLISHABLE_KEY: KEY }),
    ).toEqual({
      options: { environment: 'staging', basicAuth: 'menumesh:a:b' },
    });
    expect(parse(['staging', '--help'], {})).toEqual({ help: true });
    expect(parse(['-h'], {})).toEqual({ help: true });

    const refused = (line: string) => ({ refusal: `vps:probe: ${line}` });
    for (const args of [
      [],
      ['prod'],
      ['Production'],
      ['staging', 'production'],
      ['production', '--verbose'],
      ['production', '--version'],
      ['production', '-v', SHA],
    ]) {
      expect(parse(args, env), args.join(' ')).toEqual({ refusal: USAGE });
    }
    for (const version of ['4c2f0e5', SHA.toUpperCase(), `${SHA}0`, 'v1.0.0']) {
      expect(parse(['production', '--version', version], env)).toEqual(
        refused(
          '--version takes the full commit the build came from: 40 hex characters, as git rev-parse prints it',
        ),
      );
    }
    for (const origin of ['menumesh.in', '300.1.2.3', '2a02:4780::1', '203.0.113.10:443']) {
      expect(parse(['production', '--origin', origin], env)).toEqual(
        refused("--origin takes the server's IPv4 address"),
      );
    }
    for (const object of [
      '/menu-images/x.webp',
      'menu-images',
      'menu-images/',
      'menu-images/x.webp?v=1',
      'Menu-images/x',
      'menu-images/a b',
    ]) {
      expect(parse(['production', '--object', object], env)).toEqual(
        refused(
          '--object takes a public storage object as <bucket>/<path>, as in its URL after /storage/v1/object/public/ (menu-images/...), with no query',
        ),
      );
    }
    expect(parse(['production', '--object', 'menu-images/../logos/x'], env)).toEqual(
      refused('--object may not hold a . or .. segment'),
    );
    for (const option of ['--origin', '--object']) {
      expect(parse(['staging', option, option === '--origin' ? ORIGIN : OBJECT], env)).toEqual(
        refused('--origin and --object are for production only'),
      );
    }
    for (const pair of ['no-colon-at-all', ':password-without-user']) {
      const parsed = parse(['staging'], { SMOKE_BASIC_AUTH: pair });
      expect(parsed).toEqual(
        refused('SMOKE_BASIC_AUTH must be user:password (the user name cannot be empty)'),
      );
      expect(JSON.stringify(parsed)).not.toContain(pair);
    }
    for (const key of ['sb_secret_AbCdEfGhIjKlMnOpQrStUv_x1Y2z3W4', 'eyJhbGciOiJIUzI1NiJ9.e30.x']) {
      const parsed = parse(['production'], { PROBE_PUBLISHABLE_KEY: key });
      expect(parsed).toEqual(
        refused(
          "PROBE_PUBLISHABLE_KEY must be production's publishable key (sb_publishable_...), never a secret key",
        ),
      );
      expect(JSON.stringify(parsed)).not.toContain(key);
    }
  });

  it("reads Cloudflare's lists as the server's cf-ranges does, and nothing wider", () => {
    expect(parseRanges(V4, 'ipv4')).toHaveLength(15);
    expect(parseRanges(`${V6}\n`, 'ipv6')).toHaveLength(7);
    expect(
      parseRanges('# Cloudflare\r\n173.245.48.0/20\r\n\r\n 104.16.0.0/13 \r\n', 'ipv4'),
    ).toEqual(['173.245.48.0/20', '104.16.0.0/13']);
    for (const [text, family] of [
      ['', 'ipv4'],
      ['0.0.0.0/0', 'ipv4'],
      ['10.0.0.0/8', 'ipv4'],
      ['173.245.48.0', 'ipv4'],
      ['173.245.48.0/20/1', 'ipv4'],
      ['173.245.48.0/33', 'ipv4'],
      ['300.245.48.0/20', 'ipv4'],
      ['<html>', 'ipv4'],
      ['::/0', 'ipv6'],
      ['2400:cb00::/32', 'ipv4'],
    ] as const) {
      expect(() => parseRanges(text, family), text).toThrow();
    }
  });

  it('takes no cf-cache-status that shows an answer cacheable or cached, and an HSTS max-age as written', () => {
    for (const fine of [null, 'DYNAMIC', 'BYPASS', 'NONE', 'UNKNOWN', 'dynamic']) {
      expect(cacheVerdict(fine), String(fine)).toBeUndefined();
    }
    for (const cached of ['HIT', 'STALE', 'UPDATING', 'REVALIDATED']) {
      expect(cacheVerdict(cached)).toBe(
        `cf-cache-status ${cached}: Cloudflare served it from its cache`,
      );
    }
    for (const cacheable of ['MISS', 'EXPIRED']) {
      expect(cacheVerdict(cacheable)).toBe(
        `cf-cache-status ${cacheable}: Cloudflare may cache it, so a cache rule covers it`,
      );
    }
    expect(cacheVerdict('SOMETHING')).toBe('cf-cache-status is not a value Cloudflare documents');
    expect(maxAge('max-age=63072000')).toBe(63_072_000);
    expect(maxAge('max-age="31536000"; includeSubDomains')).toBe(31_536_000);
    expect(maxAge('includeSubDomains; MAX-AGE = 5')).toBe(5);
    expect(maxAge('includeSubDomains')).toBeUndefined();
    expect(maxAge('max-age=')).toBeUndefined();
  });

  it('runs as pnpm vps:probe does: its usage and exit codes, refusing before any request', async () => {
    const execute = promisify(execFile);
    const environment = { ...process.env };
    delete environment.SMOKE_BASIC_AUTH;
    delete environment.PROBE_PUBLISHABLE_KEY;
    const cli = async (args: string[], extra: Record<string, string> = {}) => {
      try {
        const { stdout, stderr } = await execute(
          process.execPath,
          ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', 'scripts/vps-probe.mts', ...args],
          { encoding: 'utf8', env: { ...environment, ...extra } },
        );
        return { code: 0, stdout, stderr };
      } catch (error) {
        const failed = error as { code: number; stdout: string; stderr: string };
        return { code: failed.code, stdout: failed.stdout, stderr: failed.stderr };
      }
    };
    const usage = { code: 1, stdout: '', stderr: `${USAGE}\n` };
    const refused = (line: string) => ({ code: 1, stdout: '', stderr: `vps:probe: ${line}\n` });
    const runs = await Promise.all([
      cli(['--help']),
      cli([]),
      cli(['prod']),
      cli(['production', '--verbose']),
      cli(['production', '--version', 'abc1234']),
      cli(['staging']),
      cli(['staging'], { SMOKE_BASIC_AUTH: `no-colon-${PASSWORD}` }),
      cli(['staging', '--origin', ORIGIN], { SMOKE_BASIC_AUTH: PAIR }),
      cli(['production'], { PROBE_PUBLISHABLE_KEY: `sb_secret_${PASSWORD}` }),
    ]);
    expect(runs).toEqual([
      { code: 0, stdout: `${USAGE}\n`, stderr: '' },
      usage,
      usage,
      usage,
      refused(
        '--version takes the full commit the build came from: 40 hex characters, as git rev-parse prints it',
      ),
      refused(
        "staging needs SMOKE_BASIC_AUTH: staging's basic-auth pair as user:password (the name pnpm smoke reads), from the environment only",
      ),
      refused('SMOKE_BASIC_AUTH must be user:password (the user name cannot be empty)'),
      refused('--origin and --object are for production only'),
      refused(
        "PROBE_PUBLISHABLE_KEY must be production's publishable key (sb_publishable_...), never a secret key",
      ),
    ]);
    expect(JSON.stringify(runs)).not.toContain(PASSWORD);
    // As package.json runs it.
    const { scripts } = JSON.parse(readFileSync('package.json', 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(scripts['vps:probe']).toBe(
      'node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/vps-probe.mts',
    );
  }, 30_000);

  it("uses Node alone, and reaches the network only through Net's functions", () => {
    const source = readFileSync('scripts/vps-probe.mts', 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    const imported = [...code.matchAll(/\bfrom '([^']+)'/g)].map((match) => match[1]).sort();
    expect(imported).toEqual([
      'node:dns/promises',
      'node:http',
      'node:https',
      'node:net',
      'node:util',
    ]);
    // fetch, sockets and lookups appear only in the system's own Net, after the probe's code.
    const network = source.indexOf('// --- the network');
    expect(network).toBeGreaterThan(0);
    expect(source.slice(0, network).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')).not.toMatch(
      /[^.]\bfetch\(|new WebSocket|createConnection\(|httpsRequest\(|\blookup\(/,
    );
    for (const call of [/[^.]\bfetch\(/, /new WebSocket\(/, /createConnection\(/, /\blookup\(/]) {
      expect(source.slice(network)).toMatch(call);
    }
  });
});
