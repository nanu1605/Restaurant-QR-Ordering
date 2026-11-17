/**
 * The edge probe for the cut-over (docs/RUNBOOK.md, the cut-over; docs/DECISIONS.md, The cut-over
 * (VPS Stop D)): read-only checks of staging or production through Cloudflare, run on the owner's
 * machine once the environment's DNS records point at the server. It checks what the edge
 * promises: the site file (deploy/vps/edge/menumesh.caddy, VPS-37), the gateway's routes
 * (deploy/vps/config/envoy/, VPS-35), the app's own headers (next.config.ts, src/proxy.ts),
 * Next.js's answer to a page from an older build (VPS-7) and the zone's settings. pnpm smoke
 * checks the app; this checks the edge in front of it.
 *
 *   pnpm vps:probe staging [--version <commit>]
 *   pnpm vps:probe production [--version <commit>] [--origin <server IPv4>] [--object <bucket/path>]
 *
 * --version is the full commit the build came from, which /api/health must report. --origin is the
 * server's IPv4 address: no name may resolve to it, and from here it must take no connection at
 * all (the server team's leak test, step 3, from outside). --object is a public storage object,
 * <bucket>/<path> as in its URL (menu-images/...), which Cloudflare's cache rule must keep.
 * Staging's basic-auth pair comes from SMOKE_BASIC_AUTH (user:password, the name pnpm smoke reads),
 * never from an argument: it goes over https to staging.menumesh.in only, and is never printed. An
 * optional PROBE_PUBLISHABLE_KEY (production's publishable key, sb_publishable_...) lets it open
 * the Realtime socket. Staging's database and storage stay on its hosted project, so the gateway's
 * checks are production's.
 *
 * Nothing it sends can change anything: GET and HEAD, a server action id no build has, a WebSocket
 * upgrade the edge refuses, and webhook bodies with no valid signature. No sign-in, no form. Names
 * resolve as this machine resolves them (its caches too), against Cloudflare's published ranges,
 * fetched each run. It prints a line per check (ok, bad with why, or skip with why) and a summary,
 * and exits 1 when any check failed. Every request has a deadline, so a check that gets no answer
 * fails instead of hanging. The network is reached only through the functions of Net, which the
 * tests replace.
 */
import { lookup } from 'node:dns/promises';
import type { IncomingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, createConnection, isIPv4, isIPv6 } from 'node:net';
import { parseArgs } from 'node:util';

export const USAGE = `Usage: pnpm vps:probe staging [--version <commit>]
       pnpm vps:probe production [--version <commit>] [--origin <server IPv4>] [--object <bucket/path>]`;

export type Environment = 'staging' | 'production';
type Hosts = { web: string; www?: string; api?: string; others: readonly string[] };

/**
 * Each environment's hosts: the site file's four blocks, and the domains that redirect at
 * Cloudflare (docs/DECISIONS.md, "Other domains", before Tests (VPS Stop A)).
 */
export const HOSTS: Record<Environment, Hosts> = {
  production: {
    web: 'menumesh.in',
    www: 'www.menumesh.in',
    api: 'api.menumesh.in',
    others: ['menumesh.app', 'www.menumesh.app', 'menumesh.co', 'www.menumesh.co'],
  },
  staging: { web: 'staging.menumesh.in', others: [] },
};

/** Cloudflare's published ranges: the lists the server's cf-ranges checks its own against. */
export const CLOUDFLARE_LISTS = {
  v4: 'https://www.cloudflare.com/ips-v4',
  v6: 'https://www.cloudflare.com/ips-v6',
};

/** How long each kind of step may take, in ms. The origin's is the leak test's 5 s. */
export type Timeouts = { request: number; dns: number; socket: number; origin: number };
export const TIMEOUTS: Timeouts = { request: 10_000, dns: 5_000, socket: 10_000, origin: 5_000 };

const YEAR = 31_536_000;
/** A path and a query that no redirect may drop. */
const PROBE_PATH = '/vps-probe?q=1';
/** As long as a real server action id (42), so Next.js answers 409 rather than 400; no build has it. */
const UNKNOWN_ACTION = '0'.repeat(42);
const USER_AGENT = 'menumesh-vps-probe';
/** What staging lets in without the password (GET and HEAD), as menumesh.caddy lists it. */
const OPEN_PATHS = [
  '/api/health',
  '/app.webmanifest',
  '/sw.js',
  '/icon/192',
  '/apple-icon',
  '/maskable-icon.png',
  '/favicon.ico',
];
/** The two webhooks staging lets in without the password (POST), each with a signature that fails. */
const WEBHOOKS: Record<string, Record<string, string>> = {
  '/api/webhooks/razorpay': { 'x-razorpay-signature': 'wrong' },
  '/api/webhooks/resend': {},
};
const WEBSOCKET = {
  connection: 'Upgrade',
  upgrade: 'websocket',
  'sec-websocket-version': '13',
  'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
};
/** What Cloudflare's own error answers mean, for the owner reading a bad line. */
const CLOUDFLARE_ERRORS: Record<number, string> = {
  520: "Cloudflare could not read the origin's answer",
  521: "the origin refused Cloudflare's connection",
  522: "Cloudflare's connection to the origin timed out",
  523: 'Cloudflare could not reach the origin',
  524: 'the origin did not answer Cloudflare in time',
  525: 'the TLS handshake between Cloudflare and the origin failed',
  526: "Cloudflare does not accept the origin's certificate",
  530: 'Cloudflare could not resolve the origin',
};

export type Answer = { status: number; headers: Headers };

/** Every way the probe reaches the network; the tests pass their own. */
export type Net = {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  resolve4: (host: string) => Promise<string[]>;
  resolve6: (host: string) => Promise<string[]>;
  /** Resolves once a TCP connection is made, rejects when one is refused or fails. */
  connect: (host: string, port: number, signal: AbortSignal) => Promise<void>;
  /** A GET with headers Node's fetch refuses (Upgrade): the answer's status and headers. */
  upgrade: (url: string, headers: Record<string, string>, signal: AbortSignal) => Promise<Answer>;
  /** Resolves once the WebSocket is open (and closes it), rejects when it cannot open. */
  websocket: (url: string, signal: AbortSignal) => Promise<void>;
  /** Cloudflare's published IPv4 and IPv6 lists, as text. */
  cloudflare: (signal: AbortSignal) => Promise<{ v4: string; v6: string }>;
};

export type Options = {
  environment: Environment;
  version?: string;
  origin?: string;
  object?: string;
  /** Staging's basic-auth pair, user:password, from SMOKE_BASIC_AUTH. */
  basicAuth?: string;
  /** Production's publishable key, from PROBE_PUBLISHABLE_KEY. */
  publishableKey?: string;
};

const said = (line: string) => `vps:probe: ${line}`;

/** The command line and the environment, checked before anything goes over the network. */
export function parse(
  args: string[],
  env: Record<string, string | undefined>,
): { help: true } | { options: Options } | { refusal: string } {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      options: {
        version: { type: 'string' },
        origin: { type: 'string' },
        object: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch {
    return { refusal: USAGE };
  }
  const { values, positionals } = parsed;
  if (values.help) return { help: true };
  const [environment] = positionals;
  if (positionals.length !== 1 || (environment !== 'staging' && environment !== 'production')) {
    return { refusal: USAGE };
  }
  const { version, origin, object } = values;
  if (version !== undefined && !/^[0-9a-f]{40}$/.test(version)) {
    return {
      refusal: said(
        '--version takes the full commit the build came from: 40 hex characters, as git rev-parse prints it',
      ),
    };
  }
  if (environment === 'staging' && (origin !== undefined || object !== undefined)) {
    return { refusal: said('--origin and --object are for production only') };
  }
  if (origin !== undefined && !isIPv4(origin)) {
    return { refusal: said("--origin takes the server's IPv4 address") };
  }
  if (
    object !== undefined &&
    !/^[a-z0-9][a-z0-9_-]*(\/[A-Za-z0-9._~!$&'()*+,;=:@%-]+)+$/.test(object)
  ) {
    return {
      refusal: said(
        '--object takes a public storage object as <bucket>/<path>, as in its URL after /storage/v1/object/public/ (menu-images/...), with no query',
      ),
    };
  }
  if (object?.split('/').some((segment) => segment === '.' || segment === '..')) {
    return { refusal: said('--object may not hold a . or .. segment') };
  }
  const options: Options = { environment, version, origin, object };
  if (environment === 'staging') {
    // As playwright.smoke.config.ts reads it: split at the first colon, the password may hold more.
    const pair = env.SMOKE_BASIC_AUTH;
    if (!pair) {
      return {
        refusal: said(
          "staging needs SMOKE_BASIC_AUTH: staging's basic-auth pair as user:password (the name pnpm smoke reads), from the environment only",
        ),
      };
    }
    if (pair.indexOf(':') < 1) {
      return {
        refusal: said('SMOKE_BASIC_AUTH must be user:password (the user name cannot be empty)'),
      };
    }
    options.basicAuth = pair;
  } else if (env.PROBE_PUBLISHABLE_KEY) {
    // A key ends up in the socket's URL, which Cloudflare sees: never a secret one.
    if (!/^sb_publishable_[A-Za-z0-9_-]+$/.test(env.PROBE_PUBLISHABLE_KEY)) {
      return {
        refusal: said(
          "PROBE_PUBLISHABLE_KEY must be production's publishable key (sb_publishable_...), never a secret key",
        ),
      };
    }
    options.publishableKey = env.PROBE_PUBLISHABLE_KEY;
  }
  return { options };
}

/** One of Cloudflare's lists: its ranges, refused when a line is not one (as cf-ranges reads it). */
export function parseRanges(text: string, family: 'ipv4' | 'ipv6'): string[] {
  const ranges = text
    .split('\n')
    .map((line) => line.replace(/\s/g, ''))
    .filter((line) => line && !line.startsWith('#'));
  // Cloudflare's widest ranges are a /13 and a /29: nothing wider is one of theirs (cf-ranges).
  const widest = family === 'ipv4' ? 11 : 20;
  const check = new BlockList();
  for (const range of ranges) {
    const [address, prefix, ...rest] = range.split('/');
    const bits = Number(prefix);
    if (rest.length || !/^\d+$/.test(prefix ?? '') || bits < widest) {
      throw new Error(`not a range: ${range}`);
    }
    check.addSubnet(address, bits, family);
  }
  if (!ranges.length) throw new Error('no ranges');
  return ranges;
}

/**
 * What a cf-cache-status says about an answer that must never be cached (HTML, RSC), or nothing
 * when it is fine. Stricter than "no HIT" (VPS-7): MISS and EXPIRED mean a cache rule makes the
 * answer cacheable, and STALE, UPDATING and REVALIDATED that it came from the cache.
 */
export function cacheVerdict(status: string | null): string | undefined {
  if (status === null) return undefined;
  const value = status.trim().toUpperCase();
  if (['DYNAMIC', 'BYPASS', 'NONE', 'UNKNOWN'].includes(value)) return undefined;
  if (['HIT', 'STALE', 'UPDATING', 'REVALIDATED'].includes(value)) {
    return `cf-cache-status ${value}: Cloudflare served it from its cache`;
  }
  if (value === 'MISS' || value === 'EXPIRED') {
    return `cf-cache-status ${value}: Cloudflare may cache it, so a cache rule covers it`;
  }
  return 'cf-cache-status is not a value Cloudflare documents';
}

/** An HSTS header's max-age in seconds, if it has one. */
export function maxAge(header: string): number | undefined {
  const match = /(?:^|;)\s*max-age\s*=\s*"?(\d+)"?\s*(?:;|$)/i.exec(header);
  return match ? Number(match[1]) : undefined;
}

type Outcome = { verdict: 'ok' } | { verdict: 'bad' | 'skip'; why: string };
const ok = (): Outcome => ({ verdict: 'ok' });
const bad = (why: string): Outcome => ({ verdict: 'bad', why });
const skip = (why: string): Outcome => ({ verdict: 'skip', why });

/** A step that failed, in words that hold none of what was sent. */
class Failed extends Error {}

const seconds = (ms: number) => `${ms / 1000} s`;

/**
 * Work given ms: past it the work is aborted and the step fails. The deadline rejects before the
 * abort, so its words win over the work's own AbortError.
 */
function within<T>(ms: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Failed(`no answer in ${seconds(ms)}`));
      controller.abort();
    }, ms);
  });
  // A step that throws before it returns its promise fails like one that rejects.
  const running = (async () => work(controller.signal))();
  return Promise.race([running, expiry]).finally(() => clearTimeout(timer));
}

/** The system's code for a failure (ENOTFOUND, CERT_HAS_EXPIRED, ...), from it or its causes. */
function codeOf(error: unknown): string | undefined {
  let current = error;
  for (let depth = 0; current && depth < 4; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && /^[A-Z][A-Z0-9_]*$/.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

const reason = (error: unknown) => {
  if (error instanceof Failed) return error.message;
  const code = codeOf(error);
  return code ? `the request failed (${code})` : 'the request failed';
};

/** An answer's body as text, refused past max bytes. */
async function readText(response: Response, max: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks).toString('utf8');
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      throw new Failed(`its answer is longer than ${max} bytes`);
    }
    chunks.push(value);
  }
}

/** Reads an answer to its end and keeps none of it, so Cloudflare sees it fetched whole. */
async function drain(response: Response, max: number): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) return;
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return;
    }
  }
}

const mediaType = (answer: Answer) =>
  (answer.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();

/** A status, with what it means when it is one of Cloudflare's own answers. */
function answered(answer: Answer): string {
  const meaning =
    CLOUDFLARE_ERRORS[answer.status] ??
    (answer.headers.get('cf-mitigated') ? 'Cloudflare challenged the request' : undefined);
  return meaning ? `${answer.status} (${meaning})` : String(answer.status);
}

const once = <T,>(make: () => Promise<T>) => {
  let made: Promise<T> | undefined;
  return () => (made ??= make());
};

type Ask = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** Send staging's pair (only ever over https to staging's own host). */
  auth?: boolean;
  /** Read the body as text, up to this many bytes. */
  read?: number;
  /** Read the body to its end, up to this many bytes, and keep none of it. */
  drain?: number;
};

/** Runs the checks of one environment, printing a line for each in order, then the summary. */
export async function probe(
  options: Options,
  net: Net,
  print: (line: string) => void,
  timeouts: Timeouts = TIMEOUTS,
): Promise<{ checks: number; failed: number; skipped: number }> {
  const production = options.environment === 'production';
  const hosts = HOSTS[options.environment];
  const { web } = hosts;
  const pair = production ? undefined : options.basicAuth;
  const token = pair === undefined ? undefined : Buffer.from(pair, 'utf8').toString('base64');
  const authorization = token === undefined ? undefined : `Basic ${token}`;

  // Nothing secret is ever put into a line, and this takes out whatever an answer echoes back:
  // the pair, its password, its header, and the publishable key that rides in the socket's URL.
  // In any case of letters, as an answer may change it.
  const secrets = [pair, pair?.slice(pair.indexOf(':') + 1), token, options.publishableKey]
    .filter((secret): secret is string => Boolean(secret))
    .sort((a, b) => b.length - a.length)
    .map((secret) => secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const hidden = secrets.length ? new RegExp(secrets.join('|'), 'gi') : undefined;
  const scrub = (text: string) => (hidden ? text.replace(hidden, '[hidden]') : text);
  /** A value from an answer, safe to print: no secret, printable ASCII, short, quoted. */
  const shown = (value: unknown) => {
    if (value === null || value === undefined) return 'none';
    const text = scrub(String(value)).replace(/[^\x20-\x7e]/g, '?');
    return JSON.stringify(text.length > 100 ? `${text.slice(0, 100)}...` : text);
  };

  const ask = (
    url: string,
    { method = 'GET', headers = {}, body, auth = false, read, drain: drained }: Ask = {},
  ): Promise<Answer & { text: string }> => {
    const target = new URL(url);
    const credentials: Record<string, string> =
      auth && authorization && target.protocol === 'https:' && target.hostname === web
        ? { authorization }
        : {};
    return within(timeouts.request, async (signal) => {
      // Never followed: a redirect is an answer to check, and the pair stays with its host.
      const response = await net.fetch(url, {
        method,
        headers: { 'user-agent': USER_AGENT, ...headers, ...credentials },
        body,
        redirect: 'manual',
        signal,
      });
      let text = '';
      if (read !== undefined) text = await readText(response, read);
      else if (drained !== undefined) await drain(response, drained);
      else await response.body?.cancel().catch(() => undefined);
      return { status: response.status, headers: response.headers, text };
    }).catch((error: unknown) => {
      throw new Failed(reason(error));
    });
  };

  const checks: { name: string; run: () => Promise<Outcome> }[] = [];
  const check = (name: string, run: () => Promise<Outcome>) => checks.push({ name, run });

  const names = [web, hosts.www, hosts.api].filter((host): host is string => Boolean(host));
  const ranges = once(async () => {
    const lists = await within(timeouts.request, (signal) => net.cloudflare(signal)).catch(
      (error: unknown) => {
        throw new Failed(`Cloudflare's published ranges could not be fetched (${reason(error)})`);
      },
    );
    const block = new BlockList();
    for (const [family, text] of [
      ['ipv4', lists.v4],
      ['ipv6', lists.v6],
    ] as const) {
      let listed: string[];
      try {
        listed = parseRanges(text, family);
      } catch {
        throw new Failed(
          `Cloudflare's published ${family === 'ipv4' ? 'IPv4' : 'IPv6'} list holds something that is not one of its ranges`,
        );
      }
      for (const range of listed) {
        const [address, prefix] = range.split('/');
        block.addSubnet(address, Number(prefix), family);
      }
    }
    return block;
  });
  const records = async (host: string, type: 'A' | 'AAAA'): Promise<string[]> => {
    const resolve = type === 'A' ? net.resolve4 : net.resolve6;
    try {
      return await within(timeouts.dns, () => resolve(host));
    } catch (error) {
      const code = codeOf(error);
      // A proxied name has Cloudflare's own AAAA answers; a name with none is fine.
      if (code === 'ENODATA' || code === 'ENOTFOUND') {
        if (type === 'AAAA') return [];
        throw new Failed(`it has no A record (${code})`);
      }
      throw new Failed(
        error instanceof Failed
          ? `the lookup of its ${type} records got ${error.message}`
          : `the lookup of its ${type} records failed (${code ?? 'an error'})`,
      );
    }
  };
  // The plan's check reads A records; AAAA answers are held to Cloudflare's IPv6 ranges too, as
  // nothing DNS-only may point at the server (the server team's cloudflare.md).
  for (const host of names) {
    check(`${host} resolves only to Cloudflare's addresses`, async () => {
      const [block, v4, v6] = await Promise.all([
        ranges(),
        records(host, 'A'),
        records(host, 'AAAA'),
      ]);
      if (!v4.length) return bad('it has no A record');
      if (options.origin && v4.includes(options.origin)) {
        return bad(
          `it resolves to the origin itself (${options.origin}): its record must be proxied`,
        );
      }
      const outside = [
        ...v4.filter((address) => !isIPv4(address) || !block.check(address, 'ipv4')),
        ...v6.filter((address) => !isIPv6(address) || !block.check(address, 'ipv6')),
      ];
      if (outside.length) {
        return bad(
          `${outside.map(shown).join(', ')} ${outside.length === 1 ? 'is' : 'are'} outside Cloudflare's published ranges: a DNS-only record, or a resolver that holds the old one until its TTL runs out`,
        );
      }
      return ok();
    });
  }

  // Any answer over https will do: Node checks the certificate against the name and its own CAs,
  // and takes TLS 1.2 or later. The zone's minimum TLS version is not checked from here.
  for (const host of names) {
    check(`${host} answers over https with a certificate Node trusts`, async () => {
      await ask(`https://${host}/`, { method: 'HEAD' });
      return ok();
    });
  }

  /** A redirect: one of the statuses, to exactly this Location. */
  const redirected = (answer: Answer, statuses: number[], location: string): Outcome => {
    if (!statuses.includes(answer.status)) {
      return bad(`answered ${answered(answer)}, not ${statuses.join(' or ')}`);
    }
    const got = answer.headers.get('location');
    return got === location ? ok() : bad(`Location is ${shown(got)}, not "${location}"`);
  };
  // Cloudflare's Always Use HTTPS answers 301; Caddy's own redirect, were port 80 to reach it, 308.
  for (const host of names) {
    check(`${host} redirects http to https`, async () =>
      redirected(
        await ask(`http://${host}${PROBE_PATH}`),
        [301, 308],
        `https://${host}${PROBE_PATH}`,
      ),
    );
  }

  // The page, as a browser asks for it; with the pair on staging, where nothing else answers.
  const page = once(() => ask(`https://${web}/`, { auth: true, headers: { accept: 'text/html' } }));

  if (!production) {
    check(`${web} answers 401 with WWW-Authenticate Basic without the pair`, async () => {
      const answer = await ask(`https://${web}/`, { headers: { accept: 'text/html' } });
      if (answer.status !== 401) return bad(`answered ${answered(answer)}, not 401`);
      const scheme = answer.headers.get('www-authenticate');
      return /^basic\b/i.test(scheme ?? '')
        ? ok()
        : bad(`WWW-Authenticate is ${shown(scheme)}, not Basic`);
    });
    check(`${web} answers 200 with the pair`, async () => {
      const answer = await page();
      return answer.status === 200
        ? ok()
        : bad(
            `answered ${answered(answer)}, not 200${answer.status === 401 ? ': the pair in SMOKE_BASIC_AUTH is not the one the edge takes' : ''}`,
          );
    });
  }

  check(`${web} sends HSTS with a max-age of a year or more`, async () => {
    const answer = await page();
    const header = answer.headers.get('strict-transport-security');
    if (header === null) {
      return bad(`its answer (${answered(answer)}) has no Strict-Transport-Security header`);
    }
    const age = maxAge(header);
    if (age === undefined) return bad(`Strict-Transport-Security has no max-age: ${shown(header)}`);
    return age >= YEAR ? ok() : bad(`its max-age is ${age} s, under a year (${YEAR} s)`);
  });

  if (hosts.www) {
    const { www } = hosts;
    check(`${www} redirects to ${web} with 308, path and query kept`, async () =>
      redirected(await ask(`https://${www}${PROBE_PATH}`), [308], `https://${web}${PROBE_PATH}`),
    );
  }

  check(
    `${web}/api/health answers 200${options.version ? ` on ${options.version}` : ''}`,
    async () => {
      // With the pair on staging too, so a fault in its exemption shows in the open path's check
      // alone.
      const answer = await ask(`https://${web}/api/health`, {
        auth: true,
        read: 65_536,
        headers: { accept: 'application/json' },
      });
      if (answer.status !== 200) return bad(`answered ${answered(answer)}, not 200`);
      let health: unknown;
      try {
        health = JSON.parse(answer.text);
      } catch {
        return bad('its answer is not JSON');
      }
      const { status, version } = (health ?? {}) as { status?: unknown; version?: unknown };
      if (status !== 'ok') return bad(`its status is ${shown(status)}, not "ok"`);
      if (options.version && version !== options.version) {
        return bad(`it runs ${shown(version)}, not ${options.version}`);
      }
      return ok();
    },
  );

  /** Why an answer is not a 200 of this media type, or nothing; its header shown as it came. */
  const notA = (answer: Answer, type: string, what: string) =>
    answer.status !== 200
      ? `answered ${answered(answer)}, not 200`
      : mediaType(answer) !== type
        ? `answered 200 with Content-Type ${shown(answer.headers.get('content-type'))}, not ${what}`
        : undefined;

  /** An answer that must never come from Cloudflare's cache, asked twice: a cached one shows as HIT. */
  const neverCached = async (
    first: () => Promise<Answer>,
    again: () => Promise<Answer>,
    type: string,
    what: string,
  ): Promise<Outcome> => {
    for (const [index, next] of [first, again].entries()) {
      const answer = await next();
      const wrong = notA(answer, type, what);
      if (wrong) return bad(`try ${index + 1} ${wrong}`);
      const cached = cacheVerdict(answer.headers.get('cf-cache-status'));
      if (cached) return bad(`try ${index + 1}: ${cached}`);
    }
    return ok();
  };
  check(`HTML from ${web} never comes from Cloudflare's cache`, () =>
    neverCached(
      page,
      () => ask(`https://${web}/`, { auth: true, headers: { accept: 'text/html' } }),
      'text/html',
      'HTML',
    ),
  );
  // Next.js answers an RSC request whose _rsc search param does not match its router headers with
  // a 307 to one that does; with no router headers the param is empty, so the probe asks /?_rsc.
  const rscAsk: Ask = { auth: true, headers: { rsc: '1' } };
  const rsc = once(() => ask(`https://${web}/?_rsc`, rscAsk));
  check(`RSC answers from ${web} never come from Cloudflare's cache`, () =>
    neverCached(
      rsc,
      () => ask(`https://${web}/?_rsc`, rscAsk),
      'text/x-component',
      'an RSC payload',
    ),
  );
  // Not on the plan's list, but VPS-7 promises it: Caddy and Cloudflare pass the header that
  // makes a page from an older build reload on its next navigation.
  check(`RSC answers from ${web} carry x-nextjs-deployment-id`, async () => {
    const answer = await rsc();
    const wrong = notA(answer, 'text/x-component', 'an RSC payload');
    if (wrong) return bad(wrong);
    return answer.headers.get('x-nextjs-deployment-id')
      ? ok()
      : bad('the header is missing, so a page from an older build would not reload by itself');
  });

  check(
    `${web} answers an unknown server action with 409 and x-nextjs-action-not-found`,
    async () => {
      // As the browser sends an action (VPS-7): Next.js refuses an id it does not know before it
      // reads the body.
      const answer = await ask(`https://${web}/`, {
        method: 'POST',
        auth: true,
        headers: {
          'next-action': UNKNOWN_ACTION,
          'content-type': 'text/plain;charset=UTF-8',
          accept: 'text/x-component',
          origin: `https://${web}`,
        },
        body: '[]',
      });
      const marked = answer.headers.get('x-nextjs-action-not-found') === '1';
      return answer.status === 409 && marked
        ? ok()
        : bad(
            `answered ${answered(answer)} ${marked ? 'with' : 'without'} x-nextjs-action-not-found: 1, not 409 with it`,
          );
    },
  );

  check(`${web} refuses a WebSocket upgrade with 400`, async () => {
    // Node's fetch refuses an Upgrade header, so this one goes through node:https. On staging the
    // password is asked before the upgrade matcher answers, so the pair goes with it.
    const answer = await within(timeouts.request, (signal) =>
      net.upgrade(
        `https://${web}/`,
        { 'user-agent': USER_AGENT, ...WEBSOCKET, ...(authorization ? { authorization } : {}) },
        signal,
      ),
    ).catch((error: unknown) => {
      throw new Failed(reason(error));
    });
    if (answer.status === 101) {
      return bad('it switched protocols (101): the edge lets upgrades through to the app');
    }
    return answer.status === 400 ? ok() : bad(`answered ${answered(answer)}, not 400`);
  });

  if (!production) {
    for (const path of OPEN_PATHS) {
      check(`${web}${path} answers 200 without the pair`, async () => {
        const answer = await ask(`https://${web}${path}`);
        return answer.status === 200 ? ok() : bad(`answered ${answered(answer)}, not 200`);
      });
    }
    for (const [path, signature] of Object.entries(WEBHOOKS)) {
      // A body with no valid signature: the app refuses it (400, or 503 where the webhook is not
      // set up), and nothing is stored.
      check(`${web}${path} reaches the app without the pair`, async () => {
        const answer = await ask(`https://${web}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...signature },
          body: '{}',
        });
        if (answer.status === 401) return bad('answered 401: the edge asks for the password');
        return answer.status === 400 || answer.status === 503
          ? ok()
          : bad(
              `answered ${answered(answer)}, not the app's refusal (400, or 503 where it is not set up)`,
            );
      });
    }
    check(`${web} sends x-robots-tag noindex`, async () => {
      const answer = await page();
      const tag = answer.headers.get('x-robots-tag');
      return /\bnoindex\b/i.test(tag ?? '') ? ok() : bad(`x-robots-tag is ${shown(tag)}`);
    });
  }

  // Production's only: staging's database and storage are its hosted project's.
  if (hosts.api) {
    const { api } = hosts;
    for (const path of ['/', '/pg/', '/graphql/v1', '/functions/v1/']) {
      check(`${api}${path} answers 404`, async () => {
        const answer = await ask(`https://${api}${path}`);
        return answer.status === 404 ? ok() : bad(`answered ${answered(answer)}, not 404`);
      });
    }
    for (const path of ['/auth/v1/admin/users', '/rest/v1/']) {
      check(`${api}${path} answers 401 without a key`, async () => {
        const answer = await ask(`https://${api}${path}`);
        return answer.status === 401 ? ok() : bad(`answered ${answered(answer)}, not 401`);
      });
    }

    check(
      `a public storage object on ${api} comes from Cloudflare's cache on the second try`,
      async () => {
        if (!options.object) return skip('give --object <bucket/path> to check it');
        const url = `https://${api}/storage/v1/object/public/${options.object}`;
        for (const attempt of [1, 2]) {
          const answer = await ask(url, { drain: 64 * 1024 * 1024 });
          if (answer.status !== 200) {
            return bad(`try ${attempt} answered ${answered(answer)}, not 200`);
          }
          const cached = answer.headers.get('cf-cache-status');
          if (attempt === 2 && cached?.trim().toUpperCase() !== 'HIT') {
            return bad(
              `try 2's cf-cache-status is ${shown(cached)}, not "HIT": the cache rule for /storage/v1/object/public/* is not on, or the object's answer is not cacheable`,
            );
          }
        }
        return ok();
      },
    );

    check(`the Realtime WebSocket on ${api} opens`, async () => {
      if (!options.publishableKey) return skip('set PROBE_PUBLISHABLE_KEY to check it');
      const url = `wss://${api}/realtime/v1/websocket?apikey=${encodeURIComponent(options.publishableKey)}&vsn=1.0.0`;
      await within(timeouts.socket, (signal) => net.websocket(url, signal)).catch(
        (error: unknown) => {
          throw new Failed(
            error instanceof Failed
              ? error.message
              : `it did not open (${shown((error as Error)?.message ?? null)})`,
          );
        },
      );
      return ok();
    });
  }

  for (const host of hosts.others) {
    check(`${host} redirects to ${web} with 308, path and query kept`, async () =>
      redirected(await ask(`https://${host}${PROBE_PATH}`), [308], `https://${web}${PROBE_PATH}`),
    );
  }

  if (production) {
    for (const port of [443, 80]) {
      check(
        `the origin takes no connection on port ${port} in ${seconds(TIMEOUTS.origin)}`,
        async () => {
          const { origin } = options;
          if (!origin) return skip('give --origin <server IPv4> to check it');
          // The leak test expects a timeout: a refusal shows the address answers, a firewall that
          // rejects instead of dropping.
          const dial = await within(timeouts.origin, (signal) =>
            net.connect(origin, port, signal),
          ).then(
            () => 'connected',
            (error: unknown) =>
              error instanceof Failed ? 'timeout' : (codeOf(error) ?? 'an error'),
          );
          if (dial === 'timeout') return ok();
          if (dial === 'connected') {
            return bad(
              `${origin}:${port} took the connection, so the server can be reached around Cloudflare${port === 80 ? ' (or this network intercepts port 80: run it from another)' : ''}`,
            );
          }
          return bad(
            dial === 'ECONNREFUSED'
              ? `${origin}:${port} refused the connection, so the address answers, where the leak test expects no answer at all`
              : `the connection to ${origin}:${port} failed (${dial}) instead of timing out, as the leak test expects`,
          );
        },
      );
    }
  }

  const outcomes = checks.map(({ run }) =>
    run().catch((error: unknown) =>
      bad(
        error instanceof Failed
          ? error.message
          : `the check stopped (${(error as Error)?.name ?? 'an error'})`,
      ),
    ),
  );
  let failed = 0;
  let skipped = 0;
  for (const [index, { name }] of checks.entries()) {
    const outcome = await outcomes[index];
    if (outcome.verdict === 'bad') failed++;
    if (outcome.verdict === 'skip') skipped++;
    print(
      scrub(outcome.verdict === 'ok' ? `ok ${name}` : `${outcome.verdict} ${name}: ${outcome.why}`),
    );
  }
  print(
    `vps:probe ${options.environment}: ${checks.length} checks, ${failed} failed, ${skipped} skipped`,
  );
  return { checks: checks.length, failed, skipped };
}

/** Runs pnpm vps:probe: the exit code, 1 when the command is refused or any check failed. */
export async function main(
  args: string[],
  env: Record<string, string | undefined>,
  net: Net,
  out: (line: string) => void,
  err: (line: string) => void,
  timeouts: Timeouts = TIMEOUTS,
): Promise<number> {
  const parsed = parse(args, env);
  if ('help' in parsed) {
    out(USAGE);
    return 0;
  }
  if ('refusal' in parsed) {
    err(parsed.refusal);
    return 1;
  }
  const { failed } = await probe(parsed.options, net, out, timeouts);
  return failed ? 1 : 0;
}

// --- the network, as the owner's machine reaches it ---

const headersOf = (incoming: IncomingHttpHeaders) => {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming)) {
    for (const one of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
      headers.append(name, one);
    }
  }
  return headers;
};

function connect(host: string, port: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port });
    signal.addEventListener('abort', () => {
      socket.destroy();
      reject(signal.reason);
    });
    socket.once('connect', () => {
      socket.destroy();
      resolve();
    });
    socket.on('error', (error) => {
      socket.destroy();
      reject(error);
    });
  });
}

function upgrade(
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(url, { method: 'GET', headers, agent: false, signal });
    request.on('response', (response) => {
      resolve({ status: response.statusCode ?? 0, headers: headersOf(response.headers) });
      response.resume();
      request.destroy();
    });
    request.on('upgrade', (response, socket) => {
      socket.on('error', () => undefined);
      socket.destroy();
      resolve({ status: 101, headers: headersOf(response.headers) });
    });
    request.on('error', reject);
    request.end();
  });
}

function websocket(url: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    signal.addEventListener('abort', () => socket.close());
    socket.addEventListener('open', () => {
      socket.close(1000);
      resolve();
    });
    socket.addEventListener('error', (event) => {
      const message = (event as { message?: unknown }).message;
      reject(
        new Error(
          `the handshake failed${typeof message === 'string' && message ? `: ${message}` : ''}`,
        ),
      );
    });
    socket.addEventListener('close', (event) => reject(new Error(`it closed (${event.code})`)));
  });
}

async function cloudflare(signal: AbortSignal): Promise<{ v4: string; v6: string }> {
  const list = async (url: string) => {
    const response = await fetch(url, { signal, headers: { 'user-agent': USER_AGENT } });
    if (!response.ok) throw new Failed(`${url} answered ${response.status}`);
    return readText(response, 65_536);
  };
  const [v4, v6] = await Promise.all([list(CLOUDFLARE_LISTS.v4), list(CLOUDFLARE_LISTS.v6)]);
  return { v4, v6 };
}

/**
 * The real network: Node's fetch and sockets, and names resolved by the operating system, as the
 * probe's own requests and the owner's browser resolve them. Node's Resolver reads the DNS servers
 * itself, and on Windows it can take one that refuses (127.0.0.1 on the owner's machine).
 */
export function systemNet(): Net {
  const addresses = async (host: string, family: 4 | 6) =>
    (await lookup(host, { family, all: true })).map(({ address }) => address);
  return {
    fetch: (url, init) => fetch(url, init),
    resolve4: (host) => addresses(host, 4),
    resolve6: (host) => addresses(host, 6),
    connect,
    upgrade,
    websocket,
    cloudflare,
  };
}

if (import.meta.main) {
  process.exitCode = await main(
    process.argv.slice(2),
    process.env,
    systemNet(),
    (line) => console.log(line),
    (line) => console.error(line),
  );
}
