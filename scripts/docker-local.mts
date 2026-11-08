/**
 * Builds the web image, runs it against the local Supabase stack and checks it, before any of it
 * is deployed (docs/RUNBOOK.md, The web image; docs/DECISIONS.md VPS-19). Reads .env.local, so it
 * only ever touches the database that file points at. Sentry and PostHog stay out, so a local
 * image reports nowhere, and the secrets reach Docker through its environment, never its command
 * line.
 *
 *   pnpm docker:build [--tag menumesh-web:local] [--deployment-id <id>]
 *   pnpm docker:run [--tag menumesh-web:local] [--internal-url]
 *   pnpm docker:check
 *   pnpm docker:stop
 *
 * The app is on http://localhost:3100 (E2E_PORT, as Playwright has it), bound to this machine
 * only. Run it again with another --tag to swap images the way a deploy does: the static files of
 * the earlier build stay served from the volume (docs/DECISIONS.md VPS-21).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { parseArgs, parseEnv } from 'node:util';

const WEB = 'menumesh-web';
const BRIDGE = 'menumesh-web-bridge';
// What the deploy mounts on the web container: the static files of earlier builds, and the cache
// of resized images.
const STATIC_VOLUME = 'menumesh-web-static';
const CACHE_VOLUME = 'menumesh-web-cache';
const PORT = Number(process.env.E2E_PORT ?? 3100);
const USAGE = `Usage: pnpm docker:build [--tag menumesh-web:local] [--deployment-id <id>]
       pnpm docker:run [--tag menumesh-web:local] [--internal-url]
       pnpm docker:check
       pnpm docker:stop`;

// What the shared server runs the web container under (docs/DECISIONS.md VPS-24): no capabilities,
// no new privileges, 1.5 GB of memory with 256 MB of swap on top, 1.5 CPUs, and a heap of about
// 65% of the memory limit, which the deploy sets as NODE_OPTIONS.
const LIMITS = [
  '--cap-drop',
  'ALL',
  '--security-opt',
  'no-new-privileges:true',
  '--memory',
  '1536m',
  '--memory-swap',
  '1792m',
  '--cpus',
  '1.5',
];
const NODE_OPTIONS = '--max-old-space-size=1000';

// The local container's own cron secret, not the one .env.local holds: it is bound to this machine
// only, and with it the check and a by-hand test can call the minute job (docs/DECISIONS.md
// VPS-29).
const LOCAL_CRON_SECRET = 'local-only-cron-secret';

// With --internal-url the server calls Supabase on the gateway's own address, as on the VPS, and
// the public one is out of its reach (docs/DECISIONS.md VPS-20). Its first label is not the
// public address's, which the auth cookie's name is made from, so the pinned name is tested too.
const GATEWAY = 'api-gw';
const INTERNAL_URL = `http://${GATEWAY}:8000`;

// The app is built to call Supabase on the address the browser uses (127.0.0.1:54321), but in the
// container that is the container itself. A second container shares the first one's network and
// forwards a port to the host's Supabase (published by Docker, and reached as host.docker.internal
// from a container).
const FORWARDER = `
const net = require('node:net');
const [listen, target] = process.argv.slice(1).map(Number);
net.createServer((client) => {
  const upstream = net.connect(target, 'host.docker.internal');
  const close = () => { client.destroy(); upstream.destroy(); };
  client.on('error', close);
  upstream.on('error', close);
  client.pipe(upstream);
  upstream.pipe(client);
}).listen(listen);
`;

const { positionals, values: args } = parseArgs({
  allowPositionals: true,
  options: {
    tag: { type: 'string', default: `${WEB}:local` },
    'deployment-id': { type: 'string' },
    'internal-url': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h' },
  },
  strict: true,
});
const tag = args.tag!;

function fail(message: string): never {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}

function localEnv() {
  try {
    return parseEnv(readFileSync('.env.local', 'utf8'));
  } catch {
    return fail(
      'No .env.local: copy .env.example and fill it from `pnpm exec supabase status -o env`.',
    );
  }
}

/** Runs docker with its output shown; `env` carries values that must stay off the command line. */
function docker(dockerArgs: string[], env: Record<string, string> = {}) {
  const result = spawnSync('docker', dockerArgs, {
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });
  if (result.status !== 0) fail(`docker ${dockerArgs[0]} failed.`);
}

/** Runs docker for its answer; null when it fails. */
function ask(dockerArgs: string[]): string | null {
  const result = spawnSync('docker', dockerArgs, { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

const inspect = (format: string, target: string) => ask(['inspect', '--format', format, target]);

function build() {
  const env = localEnv();
  const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!supabaseUrl || !publishableKey) {
    fail('.env.local needs NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY.');
  }
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  // One ID per build, not per commit: two builds of one commit have different action ids, and a
  // page from the first must find the second newer (docs/DECISIONS.md VPS-7).
  const deploymentId =
    args['deployment-id'] ?? `local-${sha.slice(0, 12)}-${Date.now().toString(36)}`;
  // No Sentry or PostHog values: a local image must not report to the real projects.
  const buildArgs = {
    NEXT_PUBLIC_APP_URL: `http://localhost:${PORT}`,
    NEXT_PUBLIC_SUPABASE_URL: supabaseUrl,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: publishableKey,
    NEXT_PUBLIC_BUILD_SHA: sha,
    DEPLOYMENT_ID: deploymentId,
  };
  docker([
    'build',
    '--tag',
    tag,
    ...Object.entries(buildArgs).flatMap(([name, value]) => ['--build-arg', `${name}=${value}`]),
    '.',
  ]);
  console.log(`\n✔ Built ${tag} from ${sha.slice(0, 12)} with deployment ID ${deploymentId}`);
}

/** Removes the containers; the volumes stay, as they do on a deploy. */
function removeContainers() {
  spawnSync('docker', ['rm', '--force', BRIDGE, WEB], { stdio: 'ignore' });
}

function stop() {
  removeContainers();
  spawnSync('docker', ['volume', 'rm', STATIC_VOLUME, CACHE_VOLUME], { stdio: 'ignore' });
  console.log(`✔ Stopped ${WEB} and removed its volumes`);
}

async function run() {
  const env = localEnv();
  const publicUrl = new URL(
    env.NEXT_PUBLIC_SUPABASE_URL ?? fail('.env.local needs NEXT_PUBLIC_SUPABASE_URL.'),
  );
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(publicUrl.hostname);
  const internal = args['internal-url'];
  if (internal && !local) fail('--internal-url needs the local Supabase in .env.local.');
  // Only what the app needs: never the Resend, Razorpay, import or Sentry keys that .env.local
  // holds. Docker reads each of these from this process's environment, not from the command line.
  const secrets = {
    SUPABASE_SECRET_KEY: env.SUPABASE_SECRET_KEY ?? fail('.env.local needs SUPABASE_SECRET_KEY.'),
    CUSTOMER_COOKIE_SECRET:
      env.CUSTOMER_COOKIE_SECRET ?? fail('.env.local needs CUSTOMER_COOKIE_SECRET.'),
    STAFF_EMAIL_DOMAIN: env.STAFF_EMAIL_DOMAIN || 'tableorder.test',
    CRON_SECRET: LOCAL_CRON_SECRET,
  };
  removeContainers();
  docker(
    [
      'run',
      '--detach',
      '--name',
      WEB,
      // Bound to this machine only: the container holds the local Supabase keys.
      '--publish',
      `127.0.0.1:${PORT}:3000`,
      ...LIMITS,
      '--env',
      `NODE_OPTIONS=${NODE_OPTIONS}`,
      '--volume',
      `${STATIC_VOLUME}:/app/.next/static`,
      '--volume',
      `${CACHE_VOLUME}:/app/.next/cache`,
      // As on the VPS (docs/DECISIONS.md VPS-4); the local Auth ignores what it names.
      '--env',
      'SUPABASE_FORWARD_CLIENT_IP=true',
      ...(internal
        ? ['--add-host', `${GATEWAY}:127.0.0.1`, '--env', `SUPABASE_INTERNAL_URL=${INTERNAL_URL}`]
        : []),
      ...Object.keys(secrets).flatMap((name) => ['--env', name]),
      tag,
    ],
    secrets,
  );
  if (local) {
    // The address the server calls, forwarded to the host's Supabase.
    const listen = internal ? new URL(INTERNAL_URL).port : publicUrl.port || '80';
    docker([
      'run',
      '--detach',
      '--no-healthcheck',
      '--name',
      BRIDGE,
      '--network',
      `container:${WEB}`,
      '--entrypoint',
      'node',
      tag,
      '-e',
      FORWARDER,
      listen,
      publicUrl.port || '80',
    ]);
  }
  for (let attempt = 0; attempt < 45; attempt++) {
    const status = inspect('{{.State.Health.Status}}', WEB) ?? 'gone';
    if (status === 'healthy') {
      console.log(
        `\n✔ ${WEB} is healthy on http://localhost:${PORT}${internal ? ` (Supabase calls go to ${INTERNAL_URL})` : ''}`,
      );
      return;
    }
    if (status === 'gone') fail(`${WEB} stopped: see docker logs ${WEB}`);
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  fail(`${WEB} is not healthy after 90 s: see docker logs ${WEB}`);
}

type Reply = {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
};

// node:http, not fetch: it doesn't follow redirects, and a check may choose the Host header.
function get(path: string, headers: Record<string, string> = {}, method = 'GET'): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port: PORT, path, method, headers, timeout: 15_000 },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    req.on('timeout', () => req.destroy(new Error(`${method} ${path} timed out`)));
    req.on('error', reject);
    req.end();
  });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** Runs a shell command inside the container; its output, or null when it exits non-zero. */
const inContainer = (script: string) => ask(['exec', WEB, 'sh', '-c', script]);

async function check() {
  const revision = inspect('{{index .Config.Labels "org.opencontainers.image.revision"}}', WEB);
  const deployment = inspect('{{index .Config.Labels "io.menumesh.deployment-id"}}', WEB);
  if (!revision) fail(`${WEB} is not running: pnpm docker:run first.`);
  const internal = ask(['exec', WEB, 'printenv', 'SUPABASE_INTERNAL_URL']);
  const publicUrl = localEnv().NEXT_PUBLIC_SUPABASE_URL ?? '';

  const checks: [name: string, run: () => Promise<void> | void][] = [
    [
      'the container reports healthy (the deploy waits for this, and it reaches the database)',
      () =>
        assert(
          inspect('{{.State.Health.Status}}', WEB) === 'healthy',
          'not healthy: see docker logs',
        ),
    ],
    ['/ answers 200', async () => assert((await get('/')).status === 200, 'GET / is not 200')],
    [
      '/api/live names this build, and /api/health reaches the database',
      async () => {
        const live = JSON.parse((await get('/api/live')).body);
        assert(
          live.status === 'ok' && live.version === revision,
          `/api/live says ${live.version}, built from ${revision}`,
        );
        const health = JSON.parse((await get('/api/health')).body);
        assert(
          health.db === 'ok',
          'no database from the container: is Supabase up (pnpm db:start)?',
        );
      },
    ],
    [
      'pages carry this build’s deployment ID',
      async () => {
        const page = (await get('/login')).body;
        assert(
          page.includes(`data-dpl-id="${deployment}"`),
          `no data-dpl-id="${deployment}" on /login`,
        );
      },
    ],
    [
      'only menumesh.in is indexable',
      async () => {
        const indexable = (await get('/', { Host: 'menumesh.in' })).headers['x-robots-tag'];
        assert(indexable === undefined, `menumesh.in answers X-Robots-Tag: ${indexable}`);
        const elsewhere = (await get('/', { Host: `localhost:${PORT}` })).headers['x-robots-tag'];
        assert(
          String(elsewhere).includes('noindex'),
          `another host answers X-Robots-Tag: ${elsewhere}`,
        );
      },
    ],
    [
      'the minute job answers its secret only, at once',
      async () => {
        const path = '/api/cron/jobs?kinds=data_exports';
        assert((await get(path)).status === 401, `${path} answers without the secret`);
        const reply = await get(path, { Authorization: `Bearer ${LOCAL_CRON_SECRET}` });
        assert(
          reply.status === 200 && JSON.parse(reply.body).ok === true,
          `${path} answers ${reply.status} ${reply.body}`,
        );
      },
    ],
    [
      'log out redirects to a relative address',
      async () => {
        const reply = await get('/logout', {}, 'POST');
        assert(
          reply.status === 303 && /^\/[^/]/.test(String(reply.headers.location)),
          `got ${reply.status} ${reply.headers.location}`,
        );
      },
    ],
    [
      'the prerendered files and the service worker are in the image',
      async () => {
        for (const path of [
          '/robots.txt',
          '/sitemap.xml',
          '/icon/192',
          '/icon/512',
          '/apple-icon',
          '/maskable-icon.png',
          '/sw.js',
          '/app.webmanifest',
        ]) {
          assert((await get(path)).status === 200, `${path} is not 200`);
        }
      },
    ],
    [
      'sharp resizes an image, and its disk cache works',
      async () => {
        const found = /\/_next\/image\?url=[^&\s"]*&amp;w=\d+&amp;q=\d+/.exec(
          (await get('/features')).body,
        );
        assert(found, 'no /_next/image URL on /features');
        const source = found[0].replaceAll('&amp;', '&');
        const first = await get(source, { Accept: 'image/webp' });
        assert(
          first.status === 200 && first.headers['content-type'] === 'image/webp',
          `answered ${first.status} ${first.headers['content-type']}`,
        );
        assert(
          (await get(source, { Accept: 'image/webp' })).headers['x-nextjs-cache'] === 'HIT',
          'the second request was not served from the disk cache',
        );
      },
    ],
    [
      'this build’s scripts are served from the static files, for a year',
      async () => {
        const chunk = /\/_next\/static\/chunks\/[^"'\s]+\.js/.exec((await get('/login')).body)?.[0];
        assert(chunk, 'no script on /login');
        const reply = await get(chunk);
        assert(reply.status === 200, `${chunk} is not 200`);
        assert(
          String(reply.headers['cache-control']).includes('immutable'),
          `${chunk} answers Cache-Control: ${reply.headers['cache-control']}`,
        );
      },
    ],
    [
      'the app runs as node, ships no source maps or env files, and only its two folders are writable',
      () => {
        assert(inContainer('id -u') === '1000', 'not the node user');
        assert(inContainer("find /app -name '*.map' | head -3") === '', 'source maps in /app');
        assert(inContainer("find /app -maxdepth 1 -name '.env*'") === '', 'env file in /app');
        assert(
          inContainer('touch /app/server.js 2>/dev/null; echo $?') !== '0',
          '/app/server.js is writable',
        );
        assert(
          inContainer(
            'find /app -writable -type d | grep -v -E "^/app/.next/(cache|static)" | head -3',
          ) === '',
          'a folder outside .next/cache and .next/static is writable',
        );
      },
    ],
  ];
  if (internal) {
    const origin = (url: string) => new URL(url).origin;
    checks.push(
      [
        'the server reaches Supabase on SUPABASE_INTERNAL_URL only',
        () => {
          const probe = 'fetch(process.argv[1]).then(() => process.exit(0), () => process.exit(1))';
          const reached = (url: string) => ask(['exec', WEB, 'node', '-e', probe, url]) !== null;
          assert(reached(internal), `${internal} is out of reach`);
          assert(!reached(publicUrl), `${publicUrl} is in reach: the server could be using it`);
        },
      ],
      [
        'the browser is told the public Supabase address only',
        async () => {
          const policy = String((await get('/login')).headers['content-security-policy']);
          assert(policy.includes(origin(publicUrl)), `the policy lacks ${origin(publicUrl)}`);
          assert(!policy.includes(origin(internal)), `the policy names ${origin(internal)}`);
        },
      ],
    );
  }
  let failed = 0;
  for (const [name, test] of checks) {
    try {
      await test();
      console.log(`✔ ${name}`);
    } catch (error) {
      failed++;
      console.error(`✖ ${name}: ${(error as Error).message}`);
    }
  }
  if (failed) process.exit(1);
}

if (args.help) {
  console.log(USAGE);
  process.exit(0);
}

switch (positionals[0]) {
  case 'build':
    build();
    break;
  case 'run':
    await run();
    break;
  case 'check':
    await check();
    break;
  case 'stop':
    stop();
    break;
  default:
    fail(USAGE);
}
