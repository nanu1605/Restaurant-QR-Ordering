import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterAll, describe, expect, it } from 'vitest';

/**
 * The web image (docs/DECISIONS.md VPS-13 to VPS-19, VPS-21) is built once per environment, and
 * Next.js inlines NEXT_PUBLIC_* values at build, so a variable the Dockerfile doesn't take would
 * ship as undefined. These checks keep the Dockerfile, .dockerignore and next.config.ts in step
 * with the source, so a drift shows in CI without building an image.
 */

const dockerfile = readFileSync('Dockerfile', 'utf8');
// What the Dockerfile does, without its remarks: a rule is about an instruction, not a comment.
const instructions = dockerfile
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('#'))
  .join('\n');
const rules = readFileSync('.dockerignore', 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#'));

/** A file the Dockerfile writes with `COPY <<'EOF' <path>`: that instruction, and the text. */
function heredoc(path: string) {
  const lines = dockerfile.split('\n');
  const start = lines.findIndex(
    (line) => /^COPY .*<<'EOF' /.test(line) && line.endsWith(` ${path}`),
  );
  expect(start, `no COPY heredoc writes ${path}`).toBeGreaterThanOrEqual(0);
  return {
    copy: lines[start],
    body: lines.slice(start + 1, lines.indexOf('EOF', start)).join('\n'),
  };
}

/** Instructions with their backslash continuations joined: a rule is about a whole instruction. */
const joined = (text: string) => text.replace(/\\[ \t]*\r?\n\s*/g, ' ');

/** Whether an ARG or ENV instruction names the Sentry token, as any one of its variables. */
const hasSentryTokenVariable = (text: string) =>
  /^\s*(ARG|ENV)\b[^\n]*\bSENTRY_AUTH_TOKEN\b/im.test(joined(text));

/** Whether a RUN mounts a cache on .next, whatever order the mount lists its attributes in. */
const hasNextCacheMount = (text: string) =>
  (joined(text).match(/--mount=\S+/g) ?? []).some(
    (mount) => /\btype=cache\b/.test(mount) && /\.next\b/.test(mount),
  );

/** The only files and folders the build may see (the allowlist in .dockerignore). */
const ALLOWED = [
  'src',
  'public',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'next.config.ts',
  'tsconfig.json',
  'postcss.config.mjs',
];

describe('the web image build', () => {
  it('takes a build argument for every NEXT_PUBLIC_* variable the source reads', () => {
    const read = new Set<string>();
    for (const file of readdirSync('src', { recursive: true, encoding: 'utf8' })) {
      if (!/\.tsx?$/.test(file)) continue;
      const source = readFileSync(join('src', file), 'utf8');
      for (const [, name] of source.matchAll(/process\.env\.(NEXT_PUBLIC_[A-Z0-9_]+)/g)) {
        read.add(name);
      }
    }
    const taken = new Set(
      [...instructions.matchAll(/^ARG (NEXT_PUBLIC_[A-Z0-9_]+)/gm)].map((match) => match[1]),
    );
    expect([...read].filter((name) => !taken.has(name)).sort()).toEqual([]);
  });

  it('checks every build argument that has no default before it builds', () => {
    const build = instructions.slice(
      instructions.indexOf('AS build'),
      instructions.indexOf('AS runtime'),
    );
    const required = [...build.matchAll(/^ARG ([A-Z0-9_]+)$/gm)].map((match) => match[1]);
    const checked = /for name in ([A-Z0-9_ ]+); do/.exec(build)?.[1]?.split(' ') ?? [];
    expect(required.length).toBeGreaterThan(0);
    expect(required.filter((name) => !checked.includes(name))).toEqual([]);
  });

  it('lets only what next build accepts into the deployment ID', () => {
    // A dot passed the guard once and then failed inside next build, with Next.js's words.
    expect(readFileSync('node_modules/next/dist/build/index.js', 'utf8')).toContain(
      '!/^[a-zA-Z0-9_-]*$/.test(config.deploymentId)',
    );
    expect(instructions).toContain(
      "*[!A-Za-z0-9_-]*) echo 'error: DEPLOYMENT_ID may only hold letters, digits, dashes and underscores' >&2; exit 1 ;;",
    );
  });

  it('gives the image the commit and the build ID it was made from', () => {
    expect(instructions).toMatch(/^ARG NEXT_PUBLIC_BUILD_SHA$/m);
    expect(instructions).toMatch(/^ARG DEPLOYMENT_ID$/m);
    expect(instructions).toMatch(
      /org\.opencontainers\.image\.revision=\$\{NEXT_PUBLIC_BUILD_SHA\}/,
    );
    expect(instructions).toMatch(/io\.menumesh\.deployment-id=\$\{DEPLOYMENT_ID\}/);
  });

  it('takes the Sentry token only as a build secret, never as an argument or variable', () => {
    expect(hasSentryTokenVariable(instructions)).toBe(false);
    expect(instructions).toMatch(/--mount=type=secret,id=sentry_auth_token,env=SENTRY_AUTH_TOKEN/);
  });

  it('gives every build its own server action ids (VPS-10)', () => {
    // A key set by hand, or .next/cache kept between builds (its .rscinfo holds the key for 14
    // days), would keep the ids the same, and a page from an older build would run new code.
    expect(instructions).not.toMatch(/NEXT_SERVER_ACTIONS_ENCRYPTION_KEY/);
    expect(hasNextCacheMount(instructions)).toBe(false);
  });

  it('catches the ways the Sentry token or a .next cache could get into the image', () => {
    // Docker's own check of ARG and ENV names is skipped (the second line of the Dockerfile), so
    // these two rules are the only guard, and each has to see the forms that are easy to write by
    // accident: one name among several, a continuation line, a mount that lists its type last.
    for (const bad of [
      'ARG SENTRY_AUTH_TOKEN',
      'ARG SENTRY_ORG= SENTRY_AUTH_TOKEN',
      'ENV NODE_ENV=production \\\n    SENTRY_AUTH_TOKEN=secret',
    ]) {
      expect(hasSentryTokenVariable(bad), bad).toBe(true);
    }
    expect(
      hasSentryTokenVariable(
        'RUN --mount=type=secret,id=sentry_auth_token,env=SENTRY_AUTH_TOKEN \\\n    next build',
      ),
    ).toBe(false);
    for (const bad of [
      'RUN --mount=type=cache,target=/app/.next/cache next build',
      'RUN --mount=target=/app/.next/cache,type=cache next build',
      'RUN --mount=id=next,sharing=locked,dst=.next,type=cache next build',
    ]) {
      expect(hasNextCacheMount(bad), bad).toBe(true);
    }
    expect(
      hasNextCacheMount('RUN --mount=type=cache,id=menumesh-pnpm,target=/var/cache/pnpm pnpm i'),
    ).toBe(false);
  });

  it('pins its base images by digest, and pnpm to the version packageManager names', () => {
    // The syntax line is a comment, so the raw text is read: BuildKit pulls that frontend to read
    // this file, and only its first line counts. `# check=` and heredocs need 1.8 or later.
    const frontend = /^# syntax=docker\/dockerfile:1\.(\d+)\.\d+@sha256:[0-9a-f]{64}$/.exec(
      dockerfile.split('\n')[0],
    );
    expect(frontend, 'the first line must pin the frontend by version and digest').toBeTruthy();
    expect(Number(frontend?.[1])).toBeGreaterThanOrEqual(8);
    expect(instructions).toMatch(
      /^ARG NODE_IMAGE=node:24\.\d+\.\d+-trixie-slim@sha256:[0-9a-f]{64}$/m,
    );
    const { packageManager } = JSON.parse(readFileSync('package.json', 'utf8')) as {
      packageManager: string;
    };
    const version = /^pnpm@(\d+\.\d+\.\d+)$/.exec(packageManager)?.[1];
    expect(version).toBeTruthy();
    expect(instructions).toContain(`FROM ghcr.io/pnpm/pnpm:${version}@sha256:`);
  });

  it('installs from the lockfile without running scripts, and refuses another pnpm', () => {
    expect(instructions).toMatch(
      /pnpm install --frozen-lockfile --ignore-scripts --pm-on-fail=error\b/,
    );
  });

  it('builds standalone output only when asked, so CI and Vercel are unchanged', () => {
    expect(instructions).toMatch(/\bNEXT_OUTPUT=standalone\b/);
    expect(readFileSync('next.config.ts', 'utf8')).toMatch(
      /process\.env\.NEXT_OUTPUT === 'standalone'/,
    );
  });
});

describe('the build context (.dockerignore)', () => {
  it('lets in only the files the build needs, and everything else stays out', () => {
    expect(rules[0]).toBe('*');
    expect(rules.filter((rule) => rule.startsWith('!'))).toEqual(ALLOWED.map((name) => `!${name}`));
    for (const name of ALLOWED) expect(existsSync(name), `${name} is missing`).toBe(true);
  });

  it('keeps env files out even inside an allowed folder', () => {
    const lastAllowed = Math.max(...ALLOWED.map((name) => rules.indexOf(`!${name}`)));
    for (const pattern of ['**/.env', '**/.env.*']) {
      expect(rules.indexOf(pattern), `${pattern} must follow the allowlist`).toBeGreaterThan(
        lastAllowed,
      );
    }
  });

  it('lets in every file at the root that Next.js reads', () => {
    const roots = readdirSync('.').filter((name) =>
      /^(sentry\..+|instrumentation.*|middleware|proxy|next\.config|postcss\.config|tsconfig)\.(json|[cm]?[jt]s)$/.test(
        name,
      ),
    );
    expect(roots.filter((name) => !ALLOWED.includes(name))).toEqual([]);
  });
});

describe('the web image at run time', () => {
  it('runs the standalone server as the node user, reachable from the proxy', () => {
    expect(instructions).toMatch(/\bHOSTNAME=0\.0\.0\.0\b/);
    expect(instructions).toMatch(/^USER node$/m);
    expect(instructions).toMatch(
      /^CMD \["node", "--require", "\/usr\/local\/lib\/menumesh-drain\.cjs", "server\.js"\]$/m,
    );
  });

  it('keeps connections open longer than the proxy keeps its upstream ones (Caddy: 2 minutes)', () => {
    expect(Number(/\bKEEP_ALIVE_TIMEOUT=(\d+)/.exec(instructions)?.[1])).toBeGreaterThan(120_000);
  });

  it('is healthy only when the database answers, in time for the deploy (VPS-17)', () => {
    // The deploy gives a new container 120 s to turn healthy, judging by Docker's own status.
    const check = /^HEALTHCHECK .*\n\s*CMD .*$/m.exec(instructions)?.[0] ?? '';
    expect(check).toContain('127.0.0.1:${process.env.PORT}/api/health');
    expect(check).not.toContain('/api/live');
    const seconds = (name: string) => Number(new RegExp(`--${name}=(\\d+)s`).exec(check)?.[1]);
    expect(seconds('timeout')).toBeLessThanOrEqual(5);
    expect(seconds('start-period')).toBeLessThan(120);
    expect(seconds('start-interval')).toBeGreaterThan(0);
    expect(seconds('start-interval')).toBeLessThan(seconds('interval'));
  });

  it('keeps the static files of earlier builds in the folder a volume is mounted on (VPS-21)', () => {
    // The files are served from /app/.next/static, which the deploy mounts a volume on, so this
    // build's own copy is kept where no volume hides it and added again at every start.
    expect(instructions).toMatch(
      /^COPY --from=build --chown=node:node \/app\/\.next\/static \.\/\.next\/static$/m,
    );
    expect(instructions).toMatch(
      /^COPY --from=build \/app\/\.next\/static \/opt\/menumesh\/static$/m,
    );
    expect(instructions).toContain('cp -Rf /opt/menumesh/static/. "$archive"/');
    // 14 days, in minutes.
    expect(instructions).toContain(`-mmin +${14 * 24 * 60} -delete`);
    // The server replaces the script, so node is the process Docker sends SIGTERM to.
    expect(instructions).toMatch(/^exec "\$@"$/m);
    expect(instructions).toMatch(/^ENTRYPOINT \["\/usr\/local\/bin\/menumesh-web-start"\]$/m);
  });

  it('exits instead of starting without this build’s static files when it cannot add them (VPS-21)', () => {
    // The volume hides the image's own copy, so a server that starts without them turns healthy
    // and answers 404 for every script and style of the build. A failed copy is fine only when
    // the folder already holds every file as it is here (a read-only volume that has them, or no
    // volume at all), and a full disk leaves files that exist but are cut short, so they are
    // compared, not just looked for.
    const script = heredoc('/usr/local/bin/menumesh-web-start').body;
    const failed = script.slice(script.indexOf('else'));
    expect(failed).toContain('cmp -s "$file" "$archive/$file" || echo "$file"');
    const refused = /if \[ -n "\$missing" \]; then\n([\s\S]*?)\n {2}fi/.exec(failed)?.[1] ?? '';
    expect(refused).toContain('writable by uid 1000');
    expect(refused).toMatch(/^\s*exit 1$/m);
    // After that comes the server, never in its place.
    expect(script.indexOf('exit 1')).toBeLessThan(script.lastIndexOf('exec "$@"'));
  });

  it('loads a root-owned preload on CMD, so a stop does not wait on idle connections (VPS-22)', () => {
    // Root-owned: no --chown, so the app can read it but not change it. On CMD and not in
    // NODE_OPTIONS, because the deploy sets NODE_OPTIONS and an ENV here would be lost.
    const { copy, body } = heredoc('/usr/local/lib/menumesh-drain.cjs');
    expect(copy).toMatch(/^COPY --chmod=644 </);
    expect(copy).not.toContain('--chown');
    expect(body).toContain('http.Server.prototype.close');
    expect(instructions).not.toMatch(/NODE_OPTIONS/);
  });
});

/**
 * Node's server.close() drops the idle keep-alive connections once, and a connection that is busy
 * then idles for KEEP_ALIVE_TIMEOUT after its answer, so a stop that found one busy (Caddy keeps
 * its pooled connections for 2 minutes) always ran out the grace period (VPS-16, VPS-22). The
 * preload is the one script in the image that is logic, so it runs here, in a process of its own
 * because it replaces a method of node:http: once as the Dockerfile has it, once without it.
 */
describe('the drain preload', () => {
  const dir = mkdtempSync(join(tmpdir(), 'menumesh-drain-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  // Two pooled connections are each in the middle of a request when the server is told to stop,
  // and a third request waits for one of them. Only then are the answers sent. One answer was
  // started before the stop, so it says keep-alive and leaves an idle connection behind; the
  // waiting request is sent after it, on the other. The keep-alive timeout stands in for 130 s.
  writeFileSync(
    join(dir, 'harness.cjs'),
    `
const http = require('node:http');
const agent = new http.Agent({ keepAlive: true, maxSockets: 2 });
const waiting = [];
let reached;
const bothReached = new Promise((resolve) => (reached = resolve));
const server = http.createServer((req, res) => {
  if (req.url !== '/slow') return res.end('ok');
  waiting.push(res);
  if (waiting.length === 2) reached();
});
server.keepAliveTimeout = Number(process.env.KEEP_ALIVE);
server.keepAliveTimeoutBuffer = 0;
server.listen(0, '127.0.0.1', async () => {
  const get = (path) =>
    new Promise((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port: server.address().port, path, agent }, (res) => {
          res.resume();
          res.on('end', () => resolve(res.headers.connection));
        })
        .on('error', reject);
    });
  await Promise.all([get('/'), get('/')]);
  const answers = [get('/slow'), get('/slow'), get('/')];
  await bothReached;
  const stopped = Date.now();
  const closed = new Promise((resolve) => server.close(resolve));
  for (const res of waiting) res.end('ok');
  const [, , connection] = await Promise.all(answers);
  await closed;
  console.log(JSON.stringify({ connection, closedAfter: Date.now() - stopped }));
  process.exit(0);
});
`,
  );
  writeFileSync(join(dir, 'menumesh-drain.cjs'), heredoc('/usr/local/lib/menumesh-drain.cjs').body);

  const stop = async (preload: boolean, keepAlive: number) => {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        ...(preload ? ['--require', join(dir, 'menumesh-drain.cjs')] : []),
        join(dir, 'harness.cjs'),
      ],
      { env: { ...process.env, KEEP_ALIVE: String(keepAlive) }, timeout: 20_000 },
    );
    return JSON.parse(stdout) as { connection: string; closedAfter: number };
  };

  // Two processes start here, and the slower one waits 2 s: the 5 s a test gets by default is too
  // little on a loaded runner.
  it('ends a stopping server’s connections with their answers instead of waiting on them', async () => {
    const [without, drained] = await Promise.all([stop(false, 2000), stop(true, 4000)]);
    // Without it the answer after the stop invites another request, and the stop waits out the timeout.
    expect(without.connection).toBe('keep-alive');
    expect(without.closedAfter).toBeGreaterThanOrEqual(1500);
    // With it that answer ends its connection, the idle one is dropped, and the stop is over in a moment.
    expect(drained.connection).toBe('close');
    expect(drained.closedAfter).toBeLessThan(2500);
  }, 15_000);
});
