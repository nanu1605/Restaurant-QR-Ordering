import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { INVITE_DAYS, inviteSchema } from '@/features/platform/team';
import { hashCode } from '@/lib/one-time-code';
import { hasNoHiddenCharacters } from '@/lib/person-name';

import {
  checkEmail,
  checkName,
  Refused,
  valuesFile,
} from '../../deploy/vps/tools/first-admin-values.mjs';

/**
 * The first platform admin's tool (deploy/vps/tools/first-admin.mjs; docs/DECISIONS.md, Stop D),
 * run as the owner runs it on the server: its source on node's stdin, after the values file that
 * deploy/vps/tools/first-admin-values.mjs makes on the owner's machine (VPS-134), the web
 * container's settings in its environment. A stub here plays the app (its robots.txt) and the
 * gateway (GoTrue's Admin API and PostgREST's platform_admins) and keeps every request. Most cases
 * put the values straight into its environment instead, where the values file's lines put them.
 * pnpm vps:rehearse runs the same two files in the rehearsal's web container, against the real
 * stack, and completes the join.
 */

const TOOL = readFileSync(join('deploy', 'vps', 'tools', 'first-admin.mjs'), 'utf8');
const MAKER = join('deploy', 'vps', 'tools', 'first-admin-values.mjs');
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

type Ran = { status: number | null; stdout: string; stderr: string };

/**
 * node with `args` and `input` on its stdin, in this machine's environment without anything the
 * tools read, then `env`; its stdout and stderr are pipes, as in the RUNBOOK's commands. Without
 * `end`, stdin stays open after the input, as a terminal does.
 */
function node(args: string[], env: Record<string, string | undefined>, input: string, end = true) {
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
  return new Promise<Ran>((resolve, reject) => {
    const child = spawn(process.execPath, args, { env: environment });
    // A child that waits on the open stdin is stopped, and its status is null.
    const timer = end ? undefined : setTimeout(() => child.kill(), 20_000);
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    // A child may end before it reads all its input: what it said is the result.
    child.stdin.on('error', () => {});
    child.on('error', reject);
    child.on('close', (status) => {
      clearTimeout(timer);
      child.stdin.destroy();
      resolve({ status, stdout, stderr });
    });
    child.stdin.write(input);
    if (end) child.stdin.end();
  });
}

/**
 * `node --input-type=module -` with `source` on stdin, as docker exec runs it: the tool alone, or
 * after the values file, as the owner runs it. Neither key ever shows in its output.
 */
async function run(env: Record<string, string | undefined>, source = TOOL) {
  const result = await node(['--input-type=module', '-'], env, source);
  expect(`${result.stdout}${result.stderr}`).not.toContain(SECRET_KEY);
  expect(`${result.stdout}${result.stderr}`).not.toContain(COOKIE_SECRET);
  return result;
}

/** `node first-admin-values.mjs` as the owner runs it, `input` typed at its two questions. */
const make = (input: string, args: string[] = []) => node([...args, MAKER], {}, input);

/** What the values maker says when it refuses, or '' when it makes the file. */
function makerRefusal(email: string, name: string): string {
  try {
    valuesFile(email, name);
    return '';
  } catch (error) {
    expect(error).toBeInstanceOf(Refused);
    return (error as Error).message;
  }
}

/** The values file's two lines run as JavaScript, against an environment of their own. */
function evaluated(file: string): Record<string, string> {
  const env: Record<string, string> = {};
  new Function('process', file)({ env });
  return env;
}

/** The one import the tool may have: node:crypto, which reads no FIRST_ADMIN_* at its import. */
const ONE_IMPORT = "import { createHmac, randomBytes } from 'node:crypto';";

/**
 * What the values file needs of the tool it goes in front of (VPS-134). The two run as one module,
 * the values file's lines first: a shebang line, allowed only at the very start of a source, would
 * stop the run with a SyntaxError, and an import is evaluated before any line runs, the values
 * file's included, so the tool reads the values in main() alone and imports only node:crypto.
 */
function valuesFirst(tool: string): string[] {
  const main = tool.indexOf('async function main(');
  if (main < 0) return ['the tool has no async function main('];
  const imports = [...tool.matchAll(/^import\b.*$/gm)].map((match) => match[0]);
  return [
    ...(tool.startsWith('#!') ? ['the tool starts with a shebang line'] : []),
    ...(tool.slice(0, main).includes('FIRST_ADMIN_')
      ? ['the tool names FIRST_ADMIN_ before async function main(']
      : []),
    ...(imports.length === 1 && imports[0] === ONE_IMPORT
      ? []
      : [`the tool imports more than node:crypto: ${imports.join(' | ')}`]),
  ];
}

/**
 * The RUNBOOK's commands for the values file (VPS-134), each exactly. The maker and ssh share the
 * terminal, so ssh asks nothing: its key in the agent, a login that asks nothing first, and
 * BatchMode on both (VPS-145).
 */
const NO_PROMPT = "ssh -o BatchMode=yes ops@<the tunnel's SSH host> true";
const MAKE_VALUES =
  "node deploy/vps/tools/first-admin-values.mjs | ssh -o BatchMode=yes ops@<the tunnel's SSH host> 'umask 077 && cat > ~/incoming/first-admin.values.mjs'";
/** The pipe as VPS-134 had it: an ssh that could ask for its passphrase in the maker's terminal. */
const OLD_MAKE_VALUES =
  "node deploy/vps/tools/first-admin-values.mjs | ssh ops@<the tunnel's SSH host> 'umask 077 && cat > ~/incoming/first-admin.values.mjs'";
const RUN_TOOL =
  'cat ~/incoming/first-admin.values.mjs ~/incoming/first-admin.mjs | sudo app-compose menumesh exec -T web node --input-type=module -';
const SHRED_VALUES = 'shred -u ~/incoming/first-admin.values.mjs';
/** The old command's way of passing the values, on sudo's command line. */
const OLD_VALUES = /-e FIRST_ADMIN_(EMAIL|NAME)\b/;

/**
 * The first platform admin's step 2 (The first platform admin (production)), as the server team's
 * review asked (Q9, VPS-134): the values file made on the owner's machine with the maker alone and
 * sent through ssh, then put before the tool on its stdin and shredded whether it ran or not, and
 * nothing on sudo's command line; and the lost answer's removal, whose command line keeps the
 * email, said to stay in sudo's journal.
 */
function valuesPath(runbook: string): string[] {
  const start = runbook.indexOf('## The first platform admin (production)');
  const end = runbook.indexOf('**On hosted Supabase**', start);
  if (start < 0 || end < 0) {
    return [
      'the RUNBOOK has no "The first platform admin (production)" before "On hosted Supabase"',
    ];
  }
  const text = runbook.slice(start, end);
  const flat = text.replace(/\s+/g, ' ');
  const at = (command: string) => text.indexOf(`\n   ${command}\n`);
  return [
    ...(at(MAKE_VALUES) >= 0
      ? []
      : ['step 2 doesn’t make the values file with the maker over ssh']),
    ...(flat.includes('The file is made only with this tool')
      ? []
      : ['step 2 doesn’t make the values file with this tool alone']),
    ...(at(NO_PROMPT) >= 0 &&
    (at(MAKE_VALUES) < 0 || at(NO_PROMPT) < at(MAKE_VALUES)) &&
    !text.includes(OLD_MAKE_VALUES) &&
    flat.includes("So the owner's key goes into ssh's agent first") &&
    !flat.includes('answer it after the two values')
      ? []
      : ['step 2 lets the ssh of the pipe ask for anything in the maker’s terminal']),
    ...(at(RUN_TOOL) >= 0 && at(SHRED_VALUES) > at(RUN_TOOL)
      ? []
      : ['step 2 doesn’t run the tool after the values file on stdin, then shred the values file']),
    ...(flat.includes('whether the tool succeeded or not')
      ? []
      : ['step 2 doesn’t shred the values file whether the tool succeeded or not']),
    ...(OLD_VALUES.test(text)
      ? ['step 2 still passes the values with -e, on sudo’s command line']
      : []),
    ...(flat.includes(
      'Neither the journal (sudo logs the command line, `app-compose` only `menumesh: exec`) nor any shell history holds the email or the name',
    )
      ? []
      : ['step 2 doesn’t say that neither the journal nor any shell history holds the values']),
    ...(flat.includes('then close that terminal or clear its scrollback')
      ? []
      : ['step 2 doesn’t close the terminal that shows the link']),
    ...(flat.includes(
      "its command line, with the email in it, stays in sudo's journal for up to 187 days",
    )
      ? []
      : ['the lost answer’s removal doesn’t say its command line stays in sudo’s journal']),
  ];
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

  it('takes the values from the values file before it on stdin, with none in its environment (VPS-134)', async () => {
    // Values the old -e quoting broke or the shell changed: an apostrophe, a backslash, a double
    // quote and letters outside ASCII.
    const name = `O'Brien \\ "Zoë" Nāme`;
    const file = valuesFile(" O'Brien+MenuMesh@Mail.Example.IN ", `  ${name}  `);
    const result = await run(container(), `${file}${TOOL}`);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(routes()).toEqual([
      'GET /robots.txt',
      'GET /rest/v1/platform_admins?select=joined_at',
      'POST /auth/v1/admin/users',
      'POST /rest/v1/platform_admins',
    ]);
    expect(json(seen[2])).toEqual({
      email: "o'brien+menumesh@mail.example.in",
      email_confirm: true,
    });
    expect(json(seen[3]).display_name).toBe(name);
    expect(result.stdout).toContain(`o'brien+menumesh@mail.example.in (${name}) is invited`);

    // The same file as Windows PowerShell 5.1 pipes it to ssh: a byte order mark first, and CRLF
    // line ends.
    seen = [];
    const piped = await run(container(), `﻿${file.replaceAll('\n', '\r\n')}${TOOL}`);
    expect(piped.stderr).toBe('');
    expect(piped.status).toBe(0);
    expect(json(seen[3]).display_name).toBe(name);

    // The order the two files need: no shebang line, no import but node:crypto, and nothing
    // before main() that names the values.
    expect(TOOL.startsWith('#!')).toBe(false);
    expect(TOOL.slice(0, TOOL.indexOf('async function main('))).not.toContain('FIRST_ADMIN_');
    expect(valuesFirst(TOOL)).toEqual([]);
    expect(valuesFirst(`#!/usr/bin/env node\n${TOOL}`)).toEqual([
      'the tool starts with a shebang line',
    ]);
    expect(
      valuesFirst(
        TOOL.replace(
          'async function main(',
          'const preset = process.env.FIRST_ADMIN_EMAIL;\n\nasync function main(',
        ),
      ),
    ).toEqual(['the tool names FIRST_ADMIN_ before async function main(']);
    expect(
      valuesFirst(TOOL.replace(ONE_IMPORT, `${ONE_IMPORT}\nimport './settings.mjs';`)),
    ).toEqual([`the tool imports more than node:crypto: ${ONE_IMPORT} | import './settings.mjs';`]);
    // A shebang line behind the values file stops the run before anything is asked.
    seen = [];
    const shebang = await run(container(), `${file}#!/usr/bin/env node\n${TOOL}`);
    expect(shebang.status).toBe(1);
    expect(shebang.stderr).toContain('SyntaxError');
    expect(seen).toEqual([]);
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

  it('refuses a bad email or name before any request, as the Team page and the values maker would', async () => {
    const team = (email: string, displayName: string) =>
      inviteSchema.safeParse({ email, displayName, role: 'admin' }).success;
    const notSet =
      'put the values file, made with first-admin-values.mjs, before this file on stdin (docs/RUNBOOK.md, The first platform admin (production))';
    const bad: [Record<string, string | undefined>, string][] = [
      [{ FIRST_ADMIN_EMAIL: undefined }, `no FIRST_ADMIN_EMAIL: ${notSet}`],
      [{ FIRST_ADMIN_EMAIL: '' }, 'FIRST_ADMIN_EMAIL "" is not an email address'],
      [{ FIRST_ADMIN_EMAIL: 'owner' }, 'FIRST_ADMIN_EMAIL "owner" is not an email address'],
      [{ FIRST_ADMIN_EMAIL: 'owner@example' }, 'is not an email address'],
      [{ FIRST_ADMIN_EMAIL: 'owner@@example.com' }, 'is not an email address'],
      [{ FIRST_ADMIN_EMAIL: 'owner name@example.com' }, 'is not an email address'],
      [{ FIRST_ADMIN_EMAIL: 'owner@example.com\u001b[2J' }, '"owner@example.com\\u001b[2J"'],
      [{ FIRST_ADMIN_EMAIL: 'owner‮@example.com' }, '"owner\\u202e@example.com" is not'],
      [{ FIRST_ADMIN_NAME: undefined }, `no FIRST_ADMIN_NAME: ${notSet}`],
      [{ FIRST_ADMIN_NAME: '' }, 'must be 1 to 80 characters'],
      [{ FIRST_ADMIN_NAME: '   ' }, 'must be 1 to 80 characters'],
      [{ FIRST_ADMIN_NAME: 'x'.repeat(81) }, 'must be 1 to 80 characters'],
      [
        { FIRST_ADMIN_NAME: 'Owner\u001b[31m Name' },
        'FIRST_ADMIN_NAME "Owner\\u001b[31m Name" must be 1 to 80 characters, without control or format characters',
      ],
      // Format characters and the separators (VPS-134): a bidi override, which would reorder the
      // link's line, a zero-width space, U+2028 and U+2029; and NEL, a control character that JSON
      // leaves as it is.
      [{ FIRST_ADMIN_NAME: 'Owner‮emaN' }, '"Owner\\u202eemaN" must be 1 to 80'],
      [{ FIRST_ADMIN_NAME: 'Owner​Name' }, '"Owner\\u200bName" must be 1 to 80'],
      [{ FIRST_ADMIN_NAME: 'Owner Name' }, '"Owner\\u2028Name" must be 1 to 80'],
      [{ FIRST_ADMIN_NAME: 'Owner Name' }, '"Owner\\u2029Name" must be 1 to 80'],
      [{ FIRST_ADMIN_NAME: 'Owner\u0085Name' }, '"Owner\\u0085Name" must be 1 to 80'],
      // And a tag character past the BMP, a format character too, written out as its two UTF-16
      // units.
      [{ FIRST_ADMIN_NAME: 'Owner\u{E0041} Name' }, '"Owner\\udb40\\udc41 Name" must be 1 to 80'],
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
      // The values maker refuses the same, in the same words, so it makes no file the tool would
      // refuse.
      if (input.FIRST_ADMIN_EMAIL !== undefined && input.FIRST_ADMIN_NAME !== undefined) {
        expect(makerRefusal(input.FIRST_ADMIN_EMAIL, input.FIRST_ADMIN_NAME), problem).toBe(
          result.stderr.replace(/^first-admin: refused: /, '').trimEnd(),
        );
      }
      // The Team page refuses the same.
      expect(team(input.FIRST_ADMIN_EMAIL ?? '', input.FIRST_ADMIN_NAME ?? ''), problem).toBe(
        false,
      );
    }

    // What the Team page takes, the values maker and the tool take too, through the values file.
    for (const input of [
      { FIRST_ADMIN_EMAIL: "o'brien+menumesh@mail.example.in", FIRST_ADMIN_NAME: 'x'.repeat(80) },
      { FIRST_ADMIN_EMAIL: 'OWNER@EXAMPLE.COM', FIRST_ADMIN_NAME: 'Ōwner Nāme' },
      { FIRST_ADMIN_EMAIL: 'zoe@example.com', FIRST_ADMIN_NAME: `Zoë "O'Brien" \\ 😀` },
      { FIRST_ADMIN_EMAIL: 'asha@example.in', FIRST_ADMIN_NAME: 'आशा वर्मा' },
    ]) {
      seen = [];
      expect(team(input.FIRST_ADMIN_EMAIL, input.FIRST_ADMIN_NAME)).toBe(true);
      expect(makerRefusal(input.FIRST_ADMIN_EMAIL, input.FIRST_ADMIN_NAME)).toBe('');
      const file = valuesFile(input.FIRST_ADMIN_EMAIL, input.FIRST_ADMIN_NAME);
      const result = await run(container(), `${file}${TOOL}`);
      expect(result.status).toBe(0);
      expect(json(seen[2]).email).toBe(input.FIRST_ADMIN_EMAIL.toLowerCase());
      expect(json(seen[3]).display_name).toBe(input.FIRST_ADMIN_NAME);
    }
  });

  it('says in the RUNBOOK how the values reach the tool, and no live text passes them with -e (VPS-134)', () => {
    expect(valuesPath(RUNBOOK)).toEqual([]);
    // As before the change: the values with -e on sudo's command line, and no values file.
    const old =
      "sudo app-compose menumesh exec -T -e FIRST_ADMIN_EMAIL='owner@example.com' -e FIRST_ADMIN_NAME='Owner name' web node --input-type=module - < ~/incoming/first-admin.mjs";
    expect(valuesPath(RUNBOOK.replace(RUN_TOOL, old))).toEqual([
      'step 2 doesn’t run the tool after the values file on stdin, then shred the values file',
      'step 2 still passes the values with -e, on sudo’s command line',
    ]);
    expect(valuesPath(RUNBOOK.replace(MAKE_VALUES, 'node first-admin-values.mjs'))).toEqual([
      'step 2 doesn’t make the values file with the maker over ssh',
    ]);
    // As VPS-134 had it: an ssh that could ask for its passphrase in the maker's terminal, told
    // to be answered after the two values; and the login that asks nothing left out, or after.
    const asking = 'step 2 lets the ssh of the pipe ask for anything in the maker’s terminal';
    expect(
      valuesPath(
        RUNBOOK.replace(`   ${NO_PROMPT}\n`, '')
          .replace(MAKE_VALUES, OLD_MAKE_VALUES)
          .replace(
            /So the owner's key goes into ssh's agent first[\s\S]*?must exit 0\s+before the second:/,
            'If ssh asks for a passphrase, answer it after the two values:',
          ),
      ),
    ).toEqual(['step 2 doesn’t make the values file with the maker over ssh', asking]);
    expect(valuesPath(RUNBOOK.replace(`   ${NO_PROMPT}\n`, ''))).toEqual([asking]);
    expect(
      valuesPath(
        RUNBOOK.replace(
          `   ${NO_PROMPT}\n   ${MAKE_VALUES}\n`,
          `   ${MAKE_VALUES}\n   ${NO_PROMPT}\n`,
        ),
      ),
    ).toEqual([asking]);
    expect(
      valuesPath(RUNBOOK.replace("So the owner's key goes into ssh's agent first", 'So')),
    ).toEqual([asking]);
    expect(
      valuesPath(
        RUNBOOK.replace(
          'The first login through Access opens the browser',
          'If ssh asks for a passphrase, answer it after the two values. The first login through Access opens the browser',
        ),
      ),
    ).toEqual([asking]);
    // The values file shredded before the tool could read it, or only when the tool succeeded.
    expect(
      valuesPath(
        RUNBOOK.replace(`${RUN_TOOL}\n   ${SHRED_VALUES}`, `${SHRED_VALUES}\n   ${RUN_TOOL}`),
      ),
    ).toEqual([
      'step 2 doesn’t run the tool after the values file on stdin, then shred the values file',
    ]);
    expect(
      valuesPath(RUNBOOK.replace('whether the tool succeeded or not', 'once the tool succeeded')),
    ).toEqual(['step 2 doesn’t shred the values file whether the tool succeeded or not']);
    expect(
      valuesPath(RUNBOOK.replace(/stays in\s+sudo's journal for up to 187 days/, 'is kept')),
    ).toEqual(['the lost answer’s removal doesn’t say its command line stays in sudo’s journal']);
    // The removal itself stays exactly as it was (lostLogin, above).
    expect(lostLogin(RUNBOOK)).toEqual([]);

    // No live text passes the values with -e any more; docs/DECISIONS.md keeps VPS-111's command
    // as history.
    for (const path of [
      join('docs', 'RUNBOOK.md'),
      join('deploy', 'vps', 'README.md'),
      join('deploy', 'vps', 'tools', 'first-admin.mjs'),
      MAKER,
      join('scripts', 'vps-kit.mts'),
    ]) {
      expect(OLD_VALUES.test(readFileSync(path, 'utf8')), path).toBe(false);
    }
  });

  it('refuses in a name every character the Team page refuses, and only those', () => {
    // The tool runs without the app, so it keeps its own copy of src/lib/person-name.ts's rule; so
    // does the values maker, on the owner's machine, in checkName (VPS-134).
    const rule = /^const HIDDEN = \/(.+)\/u;$/m.exec(TOOL)?.[1];
    expect(rule, 'the tool has no HIDDEN rule').toBeDefined();
    const hidden = new RegExp(rule!, 'u');
    const makerTakes = (name: string) => {
      try {
        return checkName(name) === name;
      } catch (error) {
        expect(error).toBeInstanceOf(Refused);
        return false;
      }
    };
    const differ: string[] = [];
    const makerDiffers: string[] = [];
    for (let code = 0; code <= 0x10ffff; code++) {
      const char = String.fromCodePoint(code);
      if (hidden.test(char) === hasNoHiddenCharacters(char)) differ.push(`U+${code.toString(16)}`);
      // Inside a name, where trimming leaves it.
      if (makerTakes(`a${char}b`) !== hasNoHiddenCharacters(char)) {
        makerDiffers.push(`U+${code.toString(16)}`);
      }
    }
    expect(differ).toEqual([]);
    expect(makerDiffers).toEqual([]);
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

/** The maker's two questions, as they show on stderr when the answers come through a pipe. */
const ASKED = "The first platform admin's email: Their name, 1 to 80 characters: ";

describe('the values maker (deploy/vps/tools/first-admin-values.mjs)', { timeout: 60_000 }, () => {
  it('writes the two assignments in plain ASCII, which give back the values as the tool takes them', () => {
    for (const [email, name] of [
      ["o'brien+menumesh@mail.example.in", "O'Brien"],
      ['owner@example.com', 'Back\\slash "Quoted" Zoë Nāme'],
      [' OWNER@EXAMPLE.COM ', '  Ōwner 😀 Nāme  '],
    ]) {
      const file = valuesFile(email, name);
      // Two lines, each one assignment of a JSON string, then the newline: no comment, nothing else.
      const lines =
        /^process\.env\.FIRST_ADMIN_EMAIL = ("[ -~]*");\nprocess\.env\.FIRST_ADMIN_NAME = ("[ -~]*");\n$/.exec(
          file,
        );
      expect(lines, file).not.toBeNull();
      expect(file.split('\n')).toHaveLength(3);
      // Plain ASCII, printable but for the two line ends, so no pipe re-encodes it.
      expect(/^[ -~\n]*$/.test(file), file).toBe(true);
      // Run, and read as JSON, they give back what the tool takes.
      const values = { FIRST_ADMIN_EMAIL: checkEmail(email), FIRST_ADMIN_NAME: checkName(name) };
      expect(evaluated(file)).toEqual(values);
      expect([JSON.parse(lines![1]), JSON.parse(lines![2])]).toEqual(Object.values(values));
    }
    // The same strings back for an apostrophe, a backslash, a double quote and letters outside
    // ASCII, each of those written as an escape.
    const name = `O'Brien \\ "Zoë" Nāme`;
    expect(evaluated(valuesFile("o'brien@example.com", name))).toEqual({
      FIRST_ADMIN_EMAIL: "o'brien@example.com",
      FIRST_ADMIN_NAME: name,
    });
    expect(valuesFile('zoe@example.com', 'Zoë Nāme')).toBe(
      'process.env.FIRST_ADMIN_EMAIL = "zoe@example.com";\nprocess.env.FIRST_ADMIN_NAME = "Zo\\u00eb N\\u0101me";\n',
    );
    // As the tool takes them: the email trimmed and lowercased, the name trimmed; and refused as
    // the tool refuses them, U+2028 and U+202E among them (the tool's own case compares every
    // refusal of its with the maker's).
    expect(checkEmail(' Owner@Example.COM ')).toBe('owner@example.com');
    expect(checkName('  Owner Name  ')).toBe('Owner Name');
    expect(makerRefusal('owner@example.com', 'Owner Name')).toBe(
      'FIRST_ADMIN_NAME "Owner\\u2028Name" must be 1 to 80 characters, without control or format characters',
    );
    expect(makerRefusal('owner@example.com', 'Owner‮emaN')).toBe(
      'FIRST_ADMIN_NAME "Owner\\u202eemaN" must be 1 to 80 characters, without control or format characters',
    );
    // Its rules are the tool's, to the character: the email pattern and the quoting of a value.
    const maker = readFileSync(MAKER, 'utf8');
    for (const rule of [
      /^const EMAIL =\n.*$/m,
      /^const escaped = [\s\S]*?\.join\(''\);$/m,
      /^const shown = [\s\S]*?;$/m,
    ]) {
      expect(rule.exec(TOOL), String(rule)).not.toBeNull();
      expect(rule.exec(maker)?.[0], String(rule)).toBe(rule.exec(TOOL)?.[0]);
    }
  });

  it('asks on stderr, reads the answers, and writes the file alone to stdout', async () => {
    // As typed, with Windows' line ends.
    let result = await make(' Owner@Example.COM \r\n  Zoë Nāme  \r\n');
    expect(result).toEqual({
      status: 0,
      stdout: valuesFile('owner@example.com', 'Zoë Nāme'),
      stderr: ASKED,
    });
    // A U+2028 in what is typed ends no line, so the name is refused whole, not cut short.
    result = await make('owner@example.com\nOwner Name\n');
    expect(result).toEqual({
      status: 2,
      stdout: '',
      stderr: `${ASKED}first-admin-values: refused: FIRST_ADMIN_NAME "Owner\\u2028Name" must be 1 to 80 characters, without control or format characters\n`,
    });
    // A refused email ends it before the name is asked; so does input that ends first.
    result = await make('owner@example\nOwner Name\n');
    expect(result).toEqual({
      status: 2,
      stdout: '',
      stderr:
        'The first platform admin\'s email: first-admin-values: refused: FIRST_ADMIN_EMAIL "owner@example" is not an email address\n',
    });
    result = await make('owner@example.com\n');
    expect(result).toEqual({
      status: 2,
      stdout: '',
      stderr: `${ASKED}first-admin-values: refused: no FIRST_ADMIN_NAME: the input ended before it\n`,
    });
    result = await make('');
    expect(result).toEqual({
      status: 2,
      stdout: '',
      stderr:
        "The first platform admin's email: first-admin-values: refused: no FIRST_ADMIN_EMAIL: the input ended before it\n",
    });
    // Its output is for the pipe: a terminal there is refused before anything is asked.
    result = await make('owner@example.com\nOwner Name\n', [
      '--import',
      'data:text/javascript,process.stdout.isTTY=true',
    ]);
    expect(result).toEqual({
      status: 2,
      stdout: '',
      stderr:
        'first-admin-values: refused: stdout is a terminal: pipe it to the server as docs/RUNBOOK.md says (The first platform admin (production))\n',
    });
  });

  it('asks nothing when it is imported, and ends once the file is out, the terminal still open', async () => {
    // stdin stays open, as a terminal does: a module that asked would wait there until the kill.
    const url = JSON.stringify(pathToFileURL(MAKER).href);
    const imported = await node(
      [
        '--input-type=module',
        '-e',
        `const maker = await import(${url}); console.log(Object.keys(maker).sort().join(' '));`,
      ],
      {},
      '',
      false,
    );
    expect(imported).toEqual({
      status: 0,
      stdout: 'Refused checkEmail checkName valuesFile\n',
      stderr: '',
    });
    // Run, after the two answers it reads no more and ends, though more could come.
    const ran = await node([MAKER], {}, 'owner@example.com\nOwner Name\n', false);
    expect(ran).toEqual({
      status: 0,
      stdout: valuesFile('owner@example.com', 'Owner Name'),
      stderr: ASKED,
    });
  });
});
