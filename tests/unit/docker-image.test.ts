import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

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

  it('gives the image the commit and the build ID it was made from', () => {
    expect(instructions).toMatch(/^ARG NEXT_PUBLIC_BUILD_SHA$/m);
    expect(instructions).toMatch(/^ARG DEPLOYMENT_ID$/m);
    expect(instructions).toMatch(
      /org\.opencontainers\.image\.revision=\$\{NEXT_PUBLIC_BUILD_SHA\}/,
    );
    expect(instructions).toMatch(/io\.menumesh\.deployment-id=\$\{DEPLOYMENT_ID\}/);
  });

  it('takes the Sentry token only as a build secret, never as an argument or variable', () => {
    expect(instructions).not.toMatch(/^\s*(ARG|ENV)\s+SENTRY_AUTH_TOKEN/m);
    expect(instructions).toMatch(/--mount=type=secret,id=sentry_auth_token,env=SENTRY_AUTH_TOKEN/);
  });

  it('gives every build its own server action ids (VPS-10)', () => {
    // A key set by hand, or .next/cache kept between builds (its .rscinfo holds the key for 14
    // days), would keep the ids the same, and a page from an older build would run new code.
    expect(instructions).not.toMatch(/NEXT_SERVER_ACTIONS_ENCRYPTION_KEY/);
    expect(instructions).not.toMatch(/type=cache[^\n]*\.next/);
  });

  it('pins its base images by digest, and pnpm to the version packageManager names', () => {
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
    expect(instructions).toMatch(/^CMD \["node", "server\.js"\]$/m);
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
});
