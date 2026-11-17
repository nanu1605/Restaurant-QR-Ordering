import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { INVITE_DAYS, inviteSchema } from '@/features/platform/team';
import { hashCode } from '@/lib/one-time-code';

/**
 * The first platform admin's tool (deploy/vps/tools/first-admin.mjs; docs/DECISIONS.md, Stop D),
 * run as the owner runs it on the server: its source on node's stdin, the web container's settings
 * in its environment. A stub here plays the app (its robots.txt) and the gateway (GoTrue's Admin
 * API and PostgREST's platform_admins) and keeps every request. pnpm vps:rehearse runs the same
 * file in the rehearsal's web container, against the real stack, and completes the join.
 */

const TOOL = readFileSync(join('deploy', 'vps', 'tools', 'first-admin.mjs'), 'utf8');
const SECRET_KEY = 'sb_secret_first-admin-test-0123456789abcdef';
const COOKIE_SECRET = 'cookie-secret-of-the-first-admin-test-0123456789';
const USER_ID = '0f8c2a52-3b7e-4f8e-9a51-6b0d2c9e1a77';
const APP_URL = 'https://menumesh.test';
const ROBOTS = `User-Agent: *\nAllow: /\nDisallow: /super\n\nSitemap: ${APP_URL}/sitemap.xml\n`;

// The app's hashCode with the same key, to hold the tool's hash to it.
vi.mock('@/lib/env.server', () => ({
  getServerEnv: () => ({ CUSTOMER_COOKIE_SECRET: COOKIE_SECRET }),
}));

/** platform_invite_member, as the migration defines it. */
const TEAM_MIGRATION = '20261025100000_team.sql';
const migration = readFileSync(join('supabase', 'migrations', TEAM_MIGRATION), 'utf8');
const inviteMember = migration.slice(
  migration.indexOf('create function public.platform_invite_member('),
  migration.indexOf('create function public.platform_renew_invite('),
);

const RUNBOOK = readFileSync(join('docs', 'RUNBOOK.md'), 'utf8');
/** What the tool says when the answer to making the login was lost. */
const LOST_WORDS = 'has a login now, remove it before running this again';
/**
 * The RUNBOOK's removal of the login such a run may have left: by its email, only one with no
 * platform_admins row, and nothing once anyone has joined.
 */
const LOST_REMOVAL =
  'sudo app-compose menumesh exec -T db psql -U supabase_admin -d postgres -c "delete from auth.users where email = \'<email>\' and id not in (select user_id from public.platform_admins) and not exists (select 1 from public.platform_admins where joined_at is not null)"';

/**
 * The RUNBOOK's "A new link" (The first platform admin (production)): after the tool's words for a
 * lost answer, the removal by email (Stop D's review, T1). Before it, the paragraph removed only a
 * login with a waiting invite, or one a failed run named by its id, which a lost answer never gives.
 */
function lostLogin(runbook: string): string[] {
  const start = runbook.indexOf('**A new link**');
  const end = runbook.indexOf('**On hosted Supabase**', start);
  if (start < 0 || end < 0) return ['the RUNBOOK has no "A new link" before "On hosted Supabase"'];
  const text = runbook.slice(start, end).replace(/\s+/g, ' ');
  return [
    ...(text.includes(LOST_REMOVAL)
      ? []
      : [
          'A new link removes no login a lost answer may have left: by its email, with no platform_admins row, while no one has joined',
        ]),
    ...(text.includes(`if <email> ${LOST_WORDS}`)
      ? []
      : ['A new link doesn’t quote the tool’s words for a lost answer']),
  ];
}

type Seen = { method: string; url: string; headers: IncomingHttpHeaders; body: string };
/** An answer; status 0 drops the connection without one. */
type Answer = { status: number; body?: unknown };

/** What the stub answers; each case changes what it needs. */
let answers: {
  robots: Answer;
  team: Answer;
  created: Answer;
  inserted: Answer;
  removed: Answer;
};
let seen: Seen[] = [];

const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', () => {
    const request = {
      method: req.method ?? '',
      url: req.url ?? '',
      headers: req.headers,
      body: Buffer.concat(chunks).toString(),
    };
    seen.push(request);
    const route = `${request.method} ${request.url}`;
    const answer =
      route === 'GET /robots.txt'
        ? answers.robots
        : route === 'GET /rest/v1/platform_admins?select=joined_at'
          ? answers.team
          : route === 'POST /auth/v1/admin/users'
            ? answers.created
            : route === 'POST /rest/v1/platform_admins'
              ? answers.inserted
              : route === `DELETE /auth/v1/admin/users/${USER_ID}`
                ? answers.removed
                : { status: 404, body: { message: 'no such route' } };
    if (answer.status === 0) {
      req.socket.destroy();
    } else if (typeof answer.body === 'string') {
      res.writeHead(answer.status, { 'Content-Type': 'text/plain' }).end(answer.body);
    } else if (answer.body === undefined) {
      res.writeHead(answer.status).end();
    } else {
      res
        .writeHead(answer.status, { 'Content-Type': 'application/json' })
        .end(JSON.stringify(answer.body));
    }
  });
});
let port = 0;

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => {
  seen = [];
  answers = {
    robots: { status: 200, body: ROBOTS },
    team: { status: 200, body: [] },
    created: { status: 200, body: { id: USER_ID, email: 'owner@example.com' } },
    inserted: { status: 201 },
    removed: { status: 200, body: {} },
  };
});

/** The web container's settings: the app and the gateway are both the stub. */
const container = () => ({
  SUPABASE_SECRET_KEY: SECRET_KEY,
  CUSTOMER_COOKIE_SECRET: COOKIE_SECRET,
  SUPABASE_INTERNAL_URL: `http://127.0.0.1:${port}`,
  PORT: String(port),
});

/**
 * `node --input-type=module -` with the tool on stdin, as docker exec runs it: this machine's
 * environment without anything the tool reads, then `env`. Neither key ever shows in its output.
 */
async function run(env: Record<string, string | undefined>) {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (/^(FIRST_ADMIN_|SUPABASE_|CUSTOMER_COOKIE_SECRET$|PORT$|NODE_OPTIONS$)/i.test(name)) {
      delete environment[name];
    }
  }
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) delete environment[name];
    else environment[name] = value;
  }
  const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-'], { env: environment });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
      child.on('error', reject);
      child.on('close', (status) => resolve({ status, stdout, stderr }));
      child.stdin.end(TOOL);
    },
  );
  expect(`${result.stdout}${result.stderr}`).not.toContain(SECRET_KEY);
  expect(`${result.stdout}${result.stderr}`).not.toContain(COOKIE_SECRET);
  return result;
}

const owner = { FIRST_ADMIN_EMAIL: 'owner@example.com', FIRST_ADMIN_NAME: 'Owner Name' };
const routes = () => seen.map((request) => `${request.method} ${request.url}`);
const json = (request: Seen) => JSON.parse(request.body) as Record<string, unknown>;

// Most cases start node a few times: room for a busy machine.
describe('the first-admin tool (deploy/vps/tools/first-admin.mjs)', { timeout: 60_000 }, () => {
  it('makes the login and the invite as the Team page does, and prints the link once', async () => {
    const before = Date.now();
    const result = await run({
      ...container(),
      FIRST_ADMIN_EMAIL: ' Owner@Example.COM ',
      FIRST_ADMIN_NAME: '  Owner Name  ',
    });
    const after = Date.now();
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);

    // The app's address first, then the team, the login and the row.
    expect(routes()).toEqual([
      'GET /robots.txt',
      'GET /rest/v1/platform_admins?select=joined_at',
      'POST /auth/v1/admin/users',
      'POST /rest/v1/platform_admins',
    ]);
    const [robots, team, login, row] = seen;
    // The key goes to the gateway only, in the apikey header the kit's rehearsal uses.
    expect(robots.headers.apikey).toBeUndefined();
    for (const request of [team, login, row]) {
      expect(request.headers.apikey).toBe(SECRET_KEY);
      expect(request.headers.authorization).toBeUndefined();
    }
    expect(team.headers['content-type']).toBeUndefined();
    expect(login.headers['content-type']).toBe('application/json');
    expect(row.headers['content-type']).toBe('application/json');

    // No password: the join page sets it.
    expect(json(login)).toEqual({ email: 'owner@example.com', email_confirm: true });

    // The row has the columns platform_invite_member inserts, with its values for an Admin
    // invited by nobody.
    const inserted = json(row);
    const columns = /insert into public\.platform_admins \(([^)]+)\)/
      .exec(inviteMember)?.[1]
      .split(',')
      .map((column) => column.trim());
    expect(Object.keys(inserted).sort()).toEqual([...(columns ?? [])].sort());
    expect(inserted).toMatchObject({
      user_id: USER_ID,
      role: 'admin',
      display_name: 'Owner Name',
      invited_by: null,
      joined_at: null,
      digest: true,
    });
    const invitedAt = Date.parse(String(inserted.invited_at));
    const expiresAt = Date.parse(String(inserted.invite_expires_at));
    expect(invitedAt).toBeGreaterThanOrEqual(before);
    expect(invitedAt).toBeLessThanOrEqual(after);
    expect(inviteMember).toContain(`interval '${INVITE_DAYS} days'`);
    expect(expiresAt - invitedAt).toBe(INVITE_DAYS * 86_400_000);

    // The link, once, on a line of its own, under the app's address from robots.txt.
    const links = [...result.stdout.matchAll(/^ {2}(\S+)$/gm)].map((match) => match[1]);
    expect(links).toHaveLength(1);
    const link = /^https:\/\/menumesh\.test\/login\/join\?token=([A-Za-z0-9_-]{43})$/.exec(
      links[0],
    );
    expect(link).not.toBeNull();
    const token = link![1];
    expect(result.stdout.split(token)).toHaveLength(2);

    // The hash the join page looks the token up by: HMAC-SHA256 under CUSTOMER_COOKIE_SECRET of
    // team-invite-code:<token>, which is the app's own hashCode('team-invite', token).
    const hash = createHmac('sha256', COOKIE_SECRET)
      .update(`team-invite-code:${token}`)
      .digest('hex');
    expect(inserted.invite_token_hash).toBe(hash);
    expect(hashCode('team-invite', token)).toBe(hash);
    expect(result.stdout).not.toContain(hash);

    // The expiry in UTC and IST, and the warning.
    const minute = (time: number) => new Date(time).toISOString().slice(0, 16).replace('T', ' ');
    expect(result.stdout).toContain(
      `until ${minute(expiresAt)} UTC (${minute(expiresAt + 330 * 60_000)} IST)`,
    );
    expect(result.stdout).toContain('whoever opens it becomes\nthe platform admin');
    expect(result.stdout).toContain('owner@example.com (Owner Name)');
  });

  it('refuses once the platform has any team member, before making anything', async () => {
    answers.team = {
      status: 200,
      body: [{ joined_at: '2026-11-17T10:00:00Z' }, { joined_at: null }],
    };
    let result = await run({ ...container(), ...owner });
    expect(result.status).toBe(2);
    expect(result.stderr).toBe(
      'first-admin: refused: the platform already has 2 team member(s), 1 joined: invite others from /super, Settings → Team\n',
    );
    expect(routes()).toEqual(['GET /robots.txt', 'GET /rest/v1/platform_admins?select=joined_at']);

    // An invite nobody used yet is a member too: its link, or the RUNBOOK's way to start again.
    seen = [];
    answers.team = { status: 200, body: [{ joined_at: null }] };
    result = await run({ ...container(), ...owner });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/^first-admin: refused: an earlier invite is still waiting/);
    expect(result.stderr).toContain('docs/RUNBOOK.md');
    expect(routes()).toEqual(['GET /robots.txt', 'GET /rest/v1/platform_admins?select=joined_at']);
    expect(result.stdout).toBe('');
  });

  it('removes the login again when the invite cannot be added, and says so', async () => {
    // PostgREST's details quote the row: never printed.
    answers.inserted = {
      status: 409,
      body: {
        code: '23505',
        message: 'duplicate key value violates unique constraint',
        details: 'Key (invite_token_hash)=(0123abcd) already exists.',
      },
    };
    let result = await run({ ...container(), ...owner });
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(
      'first-admin: failed: could not add the invite (409 23505: duplicate key value violates unique constraint); the login it made was removed again, so nothing is left\n',
    );
    expect(routes()).toEqual([
      'GET /robots.txt',
      'GET /rest/v1/platform_admins?select=joined_at',
      'POST /auth/v1/admin/users',
      'POST /rest/v1/platform_admins',
      `DELETE /auth/v1/admin/users/${USER_ID}`,
    ]);
    expect(seen[4].headers.apikey).toBe(SECRET_KEY);
    expect(result.stdout).toBe('');

    // When the login can't be removed either, the owner learns which one is left.
    seen = [];
    answers.removed = { status: 500, body: { code: 500, msg: 'database error' } };
    result = await run({ ...container(), ...owner });
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(
      `first-admin: failed: could not add the invite (409 23505: duplicate key value violates unique constraint), nor remove the login it made for owner@example.com, user ${USER_ID} (500 500: database error): remove that login before running this again\n`,
    );
    expect(result.stdout).toBe('');
  });

  it('refuses an email that already has a login, and removes nothing', async () => {
    answers.created = {
      status: 422,
      body: {
        code: 422,
        error_code: 'email_exists',
        msg: 'A user with this email address has already been registered',
      },
    };
    let result = await run({ ...container(), ...owner });
    expect(result.status).toBe(2);
    expect(result.stderr).toBe(
      'first-admin: refused: owner@example.com already has a login; nothing was changed\n',
    );
    expect(routes()).toEqual([
      'GET /robots.txt',
      'GET /rest/v1/platform_admins?select=joined_at',
      'POST /auth/v1/admin/users',
    ]);

    // GoTrue failing makes no login: nothing to remove. Its own error is JSON with an error_code
    // (GoTrue v2.197.0's NewInternalServerError: unexpected_failure).
    seen = [];
    answers.created = {
      status: 500,
      body: {
        code: 500,
        error_code: 'unexpected_failure',
        msg: 'Database error creating new user',
      },
    };
    result = await run({ ...container(), ...owner });
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(
      'first-admin: failed: could not make the login (500 unexpected_failure: Database error creating new user); nothing was made\n',
    );
    expect(routes()).toEqual([
      'GET /robots.txt',
      'GET /rest/v1/platform_admins?select=joined_at',
      'POST /auth/v1/admin/users',
    ]);
  });

  it('says the login may exist when the answer to making it was lost, and how the RUNBOOK removes it (Stop D review, T1)', async () => {
    // The gateway's own answers in plain text when GoTrue's connection breaks or its 30 s run out
    // (GoTrue may have made the login by then), and no answer at all.
    const lost: [Answer, string][] = [
      [
        {
          status: 503,
          body: 'upstream connect error or disconnect/reset before headers. reset reason: connection termination',
        },
        'no answer from GoTrue to making the login (503 from the gateway)',
      ],
      [
        { status: 504, body: 'upstream request timeout' },
        'no answer from GoTrue to making the login (504 from the gateway)',
      ],
      [{ status: 0 }, 'no answer to making the login (fetch failed'],
    ];
    for (const [answer, why] of lost) {
      seen = [];
      answers.created = answer;
      const result = await run({ ...container(), ...owner });
      expect(result.status, why).toBe(1);
      expect(result.stderr).toMatch(/^first-admin: failed: /);
      expect(result.stderr).toContain(why);
      expect(result.stderr).toMatch(
        /: if owner@example\.com has a login now, remove it before running this again\n$/,
      );
      expect(result.stderr).not.toContain('nothing was made');
      expect(result.stdout).toBe('');
      // No invite and no removal: nothing knows whether the login is there.
      expect(routes()).toEqual([
        'GET /robots.txt',
        'GET /rest/v1/platform_admins?select=joined_at',
        'POST /auth/v1/admin/users',
      ]);
    }
    // The RUNBOOK's step for those words, and none on its text before the fix.
    expect(TOOL).toContain(LOST_WORDS);
    expect(lostLogin(RUNBOOK)).toEqual([]);
    expect(lostLogin(RUNBOOK.replace(LOST_REMOVAL, '')).join('\n')).toContain(
      'removes no login a lost answer may have left',
    );
  });

  it('refuses a bad email or name before any request, as the Team page would', async () => {
    const team = (email: string, displayName: string) =>
      inviteSchema.safeParse({ email, displayName, role: 'admin' }).success;
    const bad: [Record<string, string | undefined>, string][] = [
      [{ FIRST_ADMIN_EMAIL: undefined }, 'no FIRST_ADMIN_EMAIL'],
      [{ FIRST_ADMIN_EMAIL: '' }, 'FIRST_ADMIN_EMAIL "" is not an email address'],
      [{ FIRST_ADMIN_EMAIL: 'owner' }, 'FIRST_ADMIN_EMAIL "owner" is not an email address'],
      [{ FIRST_ADMIN_EMAIL: 'owner@example' }, 'is not an email address'],
      [{ FIRST_ADMIN_EMAIL: 'owner@@example.com' }, 'is not an email address'],
      [{ FIRST_ADMIN_EMAIL: 'owner name@example.com' }, 'is not an email address'],
      [{ FIRST_ADMIN_EMAIL: 'owner@example.com\u001b[2J' }, '"owner@example.com\\u001b[2J"'],
      [{ FIRST_ADMIN_NAME: undefined }, 'no FIRST_ADMIN_NAME'],
      [{ FIRST_ADMIN_NAME: '' }, 'must be 1 to 80 characters'],
      [{ FIRST_ADMIN_NAME: '   ' }, 'must be 1 to 80 characters'],
      [{ FIRST_ADMIN_NAME: 'x'.repeat(81) }, 'must be 1 to 80 characters'],
      [{ FIRST_ADMIN_NAME: 'Owner\u001b[31m Name' }, '"Owner\\u001b[31m Name" must be 1 to 80'],
    ];
    for (const [change, problem] of bad) {
      seen = [];
      const input = { ...owner, ...change };
      const result = await run({ ...container(), ...input });
      expect(result.status, problem).toBe(2);
      expect(result.stderr).toMatch(/^first-admin: refused: /);
      expect(result.stderr).toContain(problem);
      expect(result.stderr.trimEnd().split('\n')).toHaveLength(1);
      expect(result.stdout).toBe('');
      expect(seen).toEqual([]);
      // The Team page refuses the same, but for the control character it doesn't check.
      if (!/\u001b/.test(`${input.FIRST_ADMIN_EMAIL}${input.FIRST_ADMIN_NAME}`)) {
        expect(team(input.FIRST_ADMIN_EMAIL ?? '', input.FIRST_ADMIN_NAME ?? '')).toBe(false);
      }
    }

    // What the Team page takes, the tool takes too.
    for (const input of [
      { FIRST_ADMIN_EMAIL: "o'brien+menumesh@mail.example.in", FIRST_ADMIN_NAME: 'x'.repeat(80) },
      { FIRST_ADMIN_EMAIL: 'OWNER@EXAMPLE.COM', FIRST_ADMIN_NAME: 'Ōwner Nāme' },
    ]) {
      seen = [];
      expect(team(input.FIRST_ADMIN_EMAIL, input.FIRST_ADMIN_NAME)).toBe(true);
      const result = await run({ ...container(), ...input });
      expect(result.status).toBe(0);
      expect(json(seen[2]).email).toBe(input.FIRST_ADMIN_EMAIL.toLowerCase());
      expect(json(seen[3]).display_name).toBe(input.FIRST_ADMIN_NAME);
    }
  });

  it("needs the web container's settings and the app's address, before any change", async () => {
    let result = await run({ ...container(), SUPABASE_SECRET_KEY: undefined, ...owner });
    expect(result.status).toBe(2);
    expect(result.stderr).toBe(
      'first-admin: refused: SUPABASE_SECRET_KEY not set here: run it in the web container\n',
    );
    result = await run({
      ...container(),
      CUSTOMER_COOKIE_SECRET: 'too-short',
      SUPABASE_INTERNAL_URL: undefined,
      ...owner,
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toBe(
      'first-admin: refused: CUSTOMER_COOKIE_SECRET, SUPABASE_INTERNAL_URL not set here: run it in the web container\n',
    );
    expect(seen).toEqual([]);

    // robots.txt without its sitemap line, or no app on the port: the address is unknown.
    answers.robots = { status: 200, body: 'User-Agent: *\nAllow: /\n' };
    result = await run({ ...container(), ...owner });
    expect(result.status).toBe(2);
    expect(result.stderr).toBe(
      `first-admin: refused: http://127.0.0.1:${port}/robots.txt names no sitemap, so the app's address is unknown\n`,
    );
    expect(routes()).toEqual(['GET /robots.txt']);
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const nobody = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    result = await run({ ...container(), PORT: String(nobody), ...owner });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(
      new RegExp(
        `^first-admin: refused: the app does not answer on http://127\\.0\\.0\\.1:${nobody}: `,
      ),
    );
    expect(routes()).toEqual(['GET /robots.txt']);

    // No gateway: a failure, before anything was made.
    seen = [];
    answers.robots = { status: 200, body: ROBOTS };
    result = await run({
      ...container(),
      SUPABASE_INTERNAL_URL: `http://127.0.0.1:${nobody}`,
      ...owner,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(
      /^first-admin: failed: could not read the team \(0 fetch failed \(ECONNREFUSED\)\); nothing was made\n$/,
    );
    expect(routes()).toEqual(['GET /robots.txt']);
  });

  it("takes the app's address from where the build puts it, and copies the invite the team migration defines", () => {
    // robots.txt names the sitemap under NEXT_PUBLIC_APP_URL, which only the build holds.
    expect(readFileSync(join('src', 'app', 'robots.ts'), 'utf8')).toContain(
      "sitemap: new URL('/sitemap.xml', getPublicEnv().NEXT_PUBLIC_APP_URL).href,",
    );
    // The invite links the Team page makes, which the tool's must equal.
    expect(readFileSync(join('src', 'features', 'platform', 'team-actions.ts'), 'utf8')).toContain(
      'link: `${getPublicEnv().NEXT_PUBLIC_APP_URL}/login/join?token=${token}`,',
    );
    // No later migration redefines the invite, nor the join page's lookup of it.
    const later = readdirSync(join('supabase', 'migrations'))
      .filter((name) => name > TEAM_MIGRATION && name.endsWith('.sql'))
      .filter((name) =>
        /platform_invite_(member|lookup|accept)/.test(
          readFileSync(join('supabase', 'migrations', name), 'utf8'),
        ),
      );
    expect(later).toEqual([]);
  });
});
