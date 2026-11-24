import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import {
  DEADLINE_MINUTES,
  deploymentOf,
  type Io,
  judge,
  main,
  parse,
  type Timings,
  TIMINGS,
  USAGE,
} from '../../scripts/vercel-wait.mts';

/**
 * pnpm vercel:wait (scripts/vercel-wait.mts; docs/DECISIONS.md P10-18): the deploy workflow's wait
 * for the deployment `vercel deploy --no-wait` made, in place of the CLI's own, which waited out a
 * deployment Vercel blocked until the job's timeout. Every run here is against a fake Vercel API and
 * a fake clock (the script's fetch, clock and sleep are the test's own), and the script itself is
 * only run with arguments it refuses before any request.
 */

// Made up: no real token, team or deployment.
const TOKEN = 'fake-vercel-token-Q7m2x9Kp4Lr8Tz1W';
const TEAM = 'team_4fJ8kL2mN6pQ9rS1tU3vW5x';
const HOST = 'menumesh-7c2f0e5b9-menumesh.vercel.app';
const DEPLOYMENT = `https://${HOST}`;
const INSPECT = 'https://vercel.com/menumesh/menumesh/9xY2bQ7cR4tU1vW3';
const ENV = { VERCEL_TOKEN: TOKEN, VERCEL_ORG_ID: TEAM };
const START = Date.parse('2026-11-24T10:00:00Z');
const WAITING = `vercel:wait: waiting for ${DEPLOYMENT} to go live, for up to 10 minutes`;

/** A deployment in a state, as GET /v13/deployments/:idOrUrl answers. */
const at = (readyState: string, more: Record<string, unknown> = {}) => ({
  id: 'dpl_9xY2bQ7cR4tU1vW3',
  url: HOST,
  target: 'production',
  readyState,
  aliasAssigned: false,
  aliasError: null,
  alias: ['menumesh.in', 'www.menumesh.in'],
  inspectorUrl: INSPECT,
  ...more,
});
const LIVE = at('READY', { readySubstate: 'PROMOTED', aliasAssigned: true });
const LIVE_LINE = (seconds: number) =>
  `vercel:wait: live after ${seconds} s: READY (PROMOTED), aliases menumesh.in, www.menumesh.in. Inspect: ${INSPECT}`;

/** One answer from the fake API, made when it is asked (a Response is read once). */
type Reply = (signal: AbortSignal) => Promise<Response>;
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
const found =
  (deployment: Record<string, unknown>): Reply =>
  async () =>
    json(200, deployment);
const answered =
  (status: number, body?: unknown, headers: Record<string, string> = {}): Reply =>
  async () =>
    body === undefined ? new Response(null, { status, headers }) : json(status, body, headers);
/** A request that fails as Node's fetch does when the connection does. */
const refused =
  (code: string): Reply =>
  async () => {
    throw new TypeError('fetch failed', { cause: Object.assign(new Error('socket'), { code }) });
  };
/** A request nothing answers, until its signal gives up. */
const hangs: Reply = (signal) =>
  new Promise((_, reject) =>
    signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
  );

/** Runs main against the replies, in order (the last one repeats), on a clock only sleep moves. */
async function run(
  replies: Reply[],
  args: string[] = [DEPLOYMENT],
  env: Record<string, string | undefined> = ENV,
  timings: Timings = TIMINGS,
) {
  let clock = START;
  let next = 0;
  const calls: { url: string; init: RequestInit }[] = [];
  const slept: number[] = [];
  const io: Io = {
    fetch: (url, init) => {
      calls.push({ url, init });
      return replies[Math.min(next++, replies.length - 1)](init.signal as AbortSignal);
    },
    now: () => clock,
    sleep: async (ms) => {
      // A wait that never ends would spin here on the fake clock: it stops it instead.
      if (ms <= 0 || slept.length >= 1_000) throw new Error('the wait never ends');
      slept.push(ms);
      clock += ms;
    },
  };
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(
    args,
    env,
    io,
    (line) => out.push(line),
    (line) => err.push(line),
    timings,
  );
  return { code, out, err, calls, requests: calls.length, slept, elapsed: clock - START };
}

describe('pnpm vercel:wait', () => {
  it('goes live on READY with its aliases assigned, printing them and the inspector link', async () => {
    const result = await run([found(LIVE)]);
    expect(result).toMatchObject({ code: 0, requests: 1, slept: [], err: [] });
    expect(result.out).toEqual([WAITING, LIVE_LINE(0)]);
  });

  it("asks Vercel's API alone, with the token, and the team only when VERCEL_ORG_ID is one", async () => {
    const team = await run([found(LIVE)]);
    const [{ url, init }] = team.calls;
    expect(url).toBe(`https://api.vercel.com/v13/deployments/${HOST}?teamId=${TEAM}`);
    expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
    // A redirect is never followed with the token, and every request has its own deadline.
    expect(init.redirect).toBe('manual');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    // A personal account's id is no team, as the CLI reads it; without one nothing is scoped.
    const personal = await run([found(LIVE)], [DEPLOYMENT], {
      VERCEL_TOKEN: TOKEN,
      VERCEL_ORG_ID: 'Hk3mP9qR2sT5vW8xZ1bC4dF6',
    });
    const unscoped = await run([found(LIVE)], [DEPLOYMENT], { VERCEL_TOKEN: TOKEN });
    for (const result of [personal, unscoped]) {
      expect(result.calls.map((call) => call.url)).toEqual([
        `https://api.vercel.com/v13/deployments/${HOST}`,
      ]);
    }
    // By id, as the API also takes it.
    const byId = await run([found(LIVE)], ['dpl_9xY2bQ7cR4tU1vW3']);
    expect(byId.calls[0].url).toBe(
      `https://api.vercel.com/v13/deployments/dpl_9xY2bQ7cR4tU1vW3?teamId=${TEAM}`,
    );
    expect(byId.code).toBe(0);
  });

  it('fails after one request when Vercel blocks the deployment, with its reason and link', async () => {
    const result = await run([
      found(at('BLOCKED', { readyStateReason: 'The commit author is not a member of the team' })),
    ]);
    expect(result).toMatchObject({ code: 1, requests: 1, slept: [], err: [] });
    expect(result.out).toEqual([
      WAITING,
      `::error::vercel:wait: ${DEPLOYMENT} is BLOCKED on Vercel: The commit author is not a member of the team. Inspect: ${INSPECT}`,
    ]);
  });

  it.each([
    [
      at('ERROR', { errorCode: 'BUILD_FAILED', errorMessage: 'The build failed' }),
      'is ERROR on Vercel: BUILD_FAILED: The build failed',
    ],
    [
      at('CANCELED', { readyStateReason: 'A newer deployment replaced it' }),
      'is CANCELED on Vercel: A newer deployment replaced it',
    ],
    [at('CANCELED'), 'is CANCELED on Vercel: Vercel gave no reason'],
    // An older answer's error state, and its state field (the link kept from the first answer).
    [
      at('DEPLOYMENT_ERROR', { errorMessage: 'Outputs failed' }),
      'is DEPLOYMENT_ERROR on Vercel: Outputs failed',
    ],
    [{ url: HOST, state: 'BLOCKED' }, 'is BLOCKED on Vercel: Vercel gave no reason'],
  ])('fails at once when it stops: %#', async (deployment, why) => {
    const result = await run([found(at('BUILDING')), found(deployment)]);
    expect(result).toMatchObject({ code: 1, requests: 2, slept: [5_000] });
    expect(result.out.at(-1)).toBe(
      `::error::vercel:wait: ${DEPLOYMENT} ${why}. Inspect: ${INSPECT}`,
    );
  });

  it('fails at once on an alias error, a failed deployment-alias check or failed checks, as the CLI does', async () => {
    const aliasError = await run([
      found(
        at('READY', {
          aliasError: { code: 'invalid_domain', message: 'menumesh.in is not set up' },
        }),
      ),
    ]);
    expect(aliasError).toMatchObject({ code: 1, requests: 1 });
    expect(aliasError.out.at(-1)).toBe(
      `::error::vercel:wait: ${DEPLOYMENT} is READY on Vercel, but Vercel could not assign its aliases: invalid_domain: menumesh.in is not set up. Inspect: ${INSPECT}`,
    );
    const check = await run([
      found(at('READY', { checks: { 'deployment-alias': { state: 'failed' } } })),
    ]);
    expect(check).toMatchObject({ code: 1, requests: 1 });
    expect(check.out.at(-1)).toBe(
      `::error::vercel:wait: ${DEPLOYMENT} is READY on Vercel, but its deployment-alias check failed. Inspect: ${INSPECT}`,
    );
    const checks = await run([
      found(at('READY', { checksState: 'completed', checksConclusion: 'failed' })),
    ]);
    expect(checks).toMatchObject({ code: 1, requests: 1 });
    expect(checks.out.at(-1)).toBe(
      `::error::vercel:wait: ${DEPLOYMENT} is READY on Vercel, but its checks failed. Inspect: ${INSPECT}`,
    );
    // Assigned with an error beside it is the CLI's success, with a warning.
    const both = await run([found({ ...LIVE, aliasError: { message: 'www.menumesh.in failed' } })]);
    expect(both).toMatchObject({ code: 0, requests: 1 });
    expect(both.out).toEqual([
      WAITING,
      '::warning::vercel:wait: some aliases failed: www.menumesh.in failed',
      LIVE_LINE(0),
    ]);
  });

  it('waits for the aliases after READY, and goes live on the next answer', async () => {
    const result = await run([found(at('READY', { readySubstate: 'STAGED' })), found(LIVE)]);
    expect(result).toMatchObject({ code: 0, requests: 2, slept: [5_000] });
    expect(result.out).toEqual([
      WAITING,
      'vercel:wait: 0 s: READY (STAGED), aliases not assigned yet',
      LIVE_LINE(5),
    ]);
  });

  it('follows QUEUED, INITIALIZING and BUILDING to READY, printing each state once', async () => {
    const result = await run([
      found(at('QUEUED')),
      found(at('QUEUED')),
      found(at('INITIALIZING')),
      found(at('BUILDING')),
      found(at('BUILDING')),
      found(at('BUILDING')),
      found(at('READY')),
      found(LIVE),
    ]);
    expect(result).toMatchObject({ code: 0, requests: 8, elapsed: 35_000 });
    expect(result.slept).toEqual(Array(7).fill(5_000));
    expect(result.out).toEqual([
      WAITING,
      'vercel:wait: 0 s: QUEUED',
      'vercel:wait: 10 s: INITIALIZING',
      'vercel:wait: 15 s: BUILDING',
      'vercel:wait: 30 s: READY, aliases not assigned yet',
      LIVE_LINE(35),
    ]);
  });

  it('keeps waiting on a state it does not know', async () => {
    const result = await run([found(at('DEPLOYING')), found(at('DEPLOYING')), found(LIVE)]);
    expect(result).toMatchObject({ code: 0, requests: 3 });
    expect(result.out).toEqual([WAITING, 'vercel:wait: 0 s: DEPLOYING', LIVE_LINE(10)]);
  });

  it('asks again after 5xx and 429, as long as Retry-After says (5 s to a minute)', async () => {
    const result = await run([
      answered(503),
      answered(502, { error: { code: 'bad_gateway', message: 'Upstream failed' } }),
      answered(
        429,
        { error: { code: 'rate_limited', message: 'Rate limit exceeded' } },
        { 'retry-after': '12' },
      ),
      found(LIVE),
    ]);
    expect(result).toMatchObject({ code: 0, requests: 4, slept: [5_000, 5_000, 12_000] });
    expect(result.out).toEqual([
      WAITING,
      'vercel:wait: 0 s: Vercel answered 503, asking again',
      'vercel:wait: 5 s: Vercel answered 502 (bad_gateway: Upstream failed), asking again',
      'vercel:wait: 10 s: Vercel answered 429 (rate_limited: Rate limit exceeded), asking again',
      LIVE_LINE(22),
    ]);
    const after = async (status: number, header: string) =>
      (await run([answered(status, undefined, { 'retry-after': header }), found(LIVE)])).slept;
    expect(await after(429, '1')).toEqual([5_000]);
    expect(await after(429, '600')).toEqual([60_000]);
    expect(await after(503, new Date(START + 30_000).toUTCString())).toEqual([30_000]);
    expect(await after(429, 'soon')).toEqual([5_000]);
    // Only a 429 or 503 says how long.
    expect(await after(500, '30')).toEqual([5_000]);
  });

  it('asks again when no answer comes: a failed connection, or none in time', async () => {
    const result = await run([refused('ECONNRESET'), hangs, found(LIVE)], [DEPLOYMENT], ENV, {
      poll: 5_000,
      request: 20,
    });
    expect(result).toMatchObject({ code: 0, requests: 3, slept: [5_000, 5_000] });
    expect(result.out).toEqual([
      WAITING,
      'vercel:wait: 0 s: no answer from Vercel (ECONNRESET), asking again',
      'vercel:wait: 5 s: no answer from Vercel within 0.02 s, asking again',
      LIVE_LINE(10),
    ]);
  });

  it.each([401, 403])('fails at once on %i: the token or the team', async (status) => {
    const result = await run([
      answered(status, { error: { code: 'forbidden', message: 'Not authorized' } }),
      found(LIVE),
    ]);
    expect(result).toMatchObject({ code: 1, requests: 1, slept: [] });
    expect(result.out).toEqual([
      WAITING,
      `::error::vercel:wait: ${DEPLOYMENT}: Vercel answered ${status} (forbidden: Not authorized): check VERCEL_TOKEN, and that VERCEL_ORG_ID is the team that owns the project`,
    ]);
  });

  it('takes a 404 for a deployment Vercel does not show yet, for a minute', async () => {
    const notFound = answered(404, {
      error: { code: 'not_found', message: 'Deployment not found' },
    });
    const late = await run([notFound, notFound, found(LIVE)]);
    expect(late).toMatchObject({ code: 0, requests: 3 });
    expect(late.out).toEqual([
      WAITING,
      'vercel:wait: 0 s: Vercel answered 404 (not_found: Deployment not found), asking again',
      LIVE_LINE(10),
    ]);
    // Asked at 0, 5, ... 55 s, then a 404 at 60 s is the URL or the team.
    const never = await run([notFound]);
    expect(never).toMatchObject({ code: 1, requests: 13, elapsed: 60_000 });
    expect(never.out.at(-1)).toBe(
      `::error::vercel:wait: ${DEPLOYMENT}: Vercel answered 404 (not_found: Deployment not found) for over a minute: check the URL, and that VERCEL_ORG_ID is the team that owns the project`,
    );
  });

  it('fails at once on any other answer: a bad request, a redirect, or an error in place of the deployment', async () => {
    const bad = await run([
      answered(400, { error: { code: 'bad_request', message: 'Invalid id' } }),
    ]);
    expect(bad).toMatchObject({ code: 1, requests: 1 });
    expect(bad.out.at(-1)).toBe(
      `::error::vercel:wait: ${DEPLOYMENT}: Vercel answered 400 (bad_request: Invalid id)`,
    );
    const moved = await run([answered(301, undefined, { location: 'https://example.com/' })]);
    expect(moved).toMatchObject({ code: 1, requests: 1 });
    expect(moved.out.at(-1)).toBe(`::error::vercel:wait: ${DEPLOYMENT}: Vercel answered 301`);
    const error = await run([found({ error: { code: 'internal', message: 'Something broke' } })]);
    expect(error).toMatchObject({ code: 1, requests: 1 });
    expect(error.out.at(-1)).toBe(
      `::error::vercel:wait: ${DEPLOYMENT}: Vercel answered 200 (internal: Something broke)`,
    );
    // An answer that isn't a deployment at all is asked again.
    const garbled = await run([async () => new Response('<html>', { status: 200 }), found(LIVE)]);
    expect(garbled).toMatchObject({ code: 0, requests: 2 });
    expect(garbled.out[1]).toBe(
      'vercel:wait: 0 s: Vercel answered 200 with no deployment, asking again',
    );
  });

  it('gives up at the deadline with the last state it saw', async () => {
    const building = await run([found(at('BUILDING'))]);
    // Asked every 5 s from 0 to 600 s.
    expect(building).toMatchObject({ code: 1, requests: 121, elapsed: 600_000 });
    expect(building.out).toEqual([
      WAITING,
      'vercel:wait: 0 s: BUILDING',
      `::error::vercel:wait: ${DEPLOYMENT} is not live after 10 minutes: its last state was BUILDING. Inspect: ${INSPECT}`,
    ]);
    const shorter = await run([found(at('QUEUED'))], [DEPLOYMENT, '--deadline', '2']);
    expect(shorter).toMatchObject({ code: 1, requests: 25, elapsed: 120_000 });
    expect(shorter.out[0]).toBe(
      `vercel:wait: waiting for ${DEPLOYMENT} to go live, for up to 2 minutes`,
    );
    // READY that never gets its domain: a rolled-back project does that.
    const staged = await run([found(at('READY', { readySubstate: 'STAGED' }))]);
    expect(staged.out.at(-1)).toBe(
      `::error::vercel:wait: ${DEPLOYMENT} is not live after 10 minutes: its last state was READY (STAGED), aliases not assigned yet. A project rolled back with Instant Rollback gives new production deployments no domain until Undo Rollback (docs/RUNBOOK.md, Rolling back). Inspect: ${INSPECT}`,
    );
    // The last problem after the last state, or the problem alone when no state came.
    const flaky = await run([found(at('BUILDING')), answered(503)]);
    expect(flaky.out.at(-1)).toBe(
      `::error::vercel:wait: ${DEPLOYMENT} is not live after 10 minutes: its last state was BUILDING, and then Vercel answered 503. Inspect: ${INSPECT}`,
    );
    const silent = await run([refused('ENOTFOUND')]);
    expect(silent.out.at(-1)).toBe(
      `::error::vercel:wait: ${DEPLOYMENT} is not live after 10 minutes: Vercel never showed its state (no answer from Vercel (ENOTFOUND))`,
    );
  });

  it('refuses an alias in place of the new deployment: Vercel would answer with an older one', async () => {
    const result = await run([found(LIVE)], ['https://menumesh.in']);
    expect(result).toMatchObject({ code: 1, requests: 1 });
    expect(result.calls[0].url).toBe(
      `https://api.vercel.com/v13/deployments/menumesh.in?teamId=${TEAM}`,
    );
    expect(result.out.at(-1)).toBe(
      `::error::vercel:wait: https://menumesh.in is an alias of ${DEPLOYMENT}, not a new deployment: pass the URL vercel deploy printed. Inspect: ${INSPECT}`,
    );
  });

  it('takes the URL as vercel deploy prints it, with or without https:// and trailing space', async () => {
    for (const value of [
      DEPLOYMENT,
      HOST,
      `${DEPLOYMENT}/`,
      `${DEPLOYMENT}\n`,
      `  ${DEPLOYMENT.toUpperCase()} \t\r\n`,
      `HTTPS://${HOST}`,
    ]) {
      expect(deploymentOf(value), JSON.stringify(value)).toBe(HOST);
    }
    expect(deploymentOf(' dpl_9xY2bQ7cR4tU1vW3\n')).toBe('dpl_9xY2bQ7cR4tU1vW3');
    for (const value of [
      '',
      'https://',
      `http://${HOST}`,
      `${DEPLOYMENT}/api/health`,
      `${DEPLOYMENT}?x=1`,
      `${DEPLOYMENT}:443`,
      `https://user@${HOST}`,
      'https://localhost',
      'https://-menumesh.vercel.app',
      `${DEPLOYMENT} ${DEPLOYMENT}`,
      'dpl_',
      TOKEN,
    ]) {
      expect(deploymentOf(value), JSON.stringify(value)).toBeUndefined();
    }
    // As the workflow passes it, the host alone goes to the API.
    const result = await run([found(LIVE)], [`${DEPLOYMENT}/ \n`]);
    expect(result.code).toBe(0);
    expect(result.calls[0].url).toBe(
      `https://api.vercel.com/v13/deployments/${HOST}?teamId=${TEAM}`,
    );
  });

  it('reads the command line before anything goes to Vercel', () => {
    expect(parse(['--help'], ENV)).toEqual({ help: true });
    expect(parse([DEPLOYMENT], ENV)).toEqual({
      options: { deployment: HOST, token: TOKEN, teamId: TEAM, minutes: DEADLINE_MINUTES },
    });
    expect(parse([DEPLOYMENT, '--deadline', '60'], ENV)).toMatchObject({
      options: { minutes: 60 },
    });
    for (const args of [[], [DEPLOYMENT, DEPLOYMENT], [DEPLOYMENT, '--verbose'], ['--deadline']]) {
      expect(parse(args, ENV)).toEqual({ refusal: USAGE });
    }
    for (const deadline of ['0', '61', '1.5', 'ten', '05', '']) {
      expect(parse([DEPLOYMENT, '--deadline', deadline], ENV)).toEqual({
        refusal: 'vercel:wait: --deadline takes whole minutes, from 1 to 60',
      });
    }
    expect(parse([DEPLOYMENT], { VERCEL_ORG_ID: TEAM })).toEqual({
      refusal: 'vercel:wait: VERCEL_TOKEN must hold a Vercel token (from the environment)',
    });
  });

  it('never prints the token, whatever Vercel or a mistyped argument says', async () => {
    const results = await Promise.all([
      run([
        answered(403, { error: { code: 'forbidden', message: `Token ${TOKEN} is not allowed` } }),
      ]),
      run([found(at('BLOCKED', { readyStateReason: `blocked for ${TOKEN}` }))]),
      run([found({ ...LIVE, alias: [TOKEN], aliasWarning: { message: TOKEN } })]),
      run([
        async () => {
          throw new Error(`connect failed with ${TOKEN}`);
        },
        found(LIVE),
      ]),
      run([found(LIVE)], [TOKEN]),
      run([found(LIVE)], [`${DEPLOYMENT}/${TOKEN}`]),
    ]);
    // And a clock that breaks stops it with the error's name alone.
    const lines: string[] = [];
    const broken = await main(
      [DEPLOYMENT],
      ENV,
      {
        fetch: async () => json(200, at('BUILDING')),
        now: () => START,
        sleep: async () => {
          throw new Error(`sleep broke near ${TOKEN}`);
        },
      },
      (line) => lines.push(line),
      (line) => lines.push(line),
    );
    expect(broken).toBe(1);
    expect(lines.at(-1)).toBe('::error::vercel:wait: stopped by Error');
    const printed = [...results.flatMap((result) => [...result.out, ...result.err]), ...lines].join(
      '\n',
    );
    expect(printed).not.toContain(TOKEN);
    expect(printed).not.toMatch(/bearer|authorization/i);
    expect(printed).toContain('Token *** is not allowed');
  });

  it('keeps what Vercel says to one line, so it can neither break the annotation nor add one', async () => {
    const result = await run([
      found(at('BLOCKED', { readyStateReason: '50% off\n::warning::not ours\r\u0007done' })),
    ]);
    expect(result.out.at(-1)).toBe(
      `::error::vercel:wait: ${DEPLOYMENT} is BLOCKED on Vercel: 50%25 off ::warning::not ours done. Inspect: ${INSPECT}`,
    );
    for (const line of result.out) expect(line).not.toMatch(/[\r\n]/);
    expect(judge(at('READY'))).toEqual({ verdict: 'waiting' });
  });

  it('runs as pnpm vercel:wait does: its usage and exit codes, refusing before any request', async () => {
    const execute = promisify(execFile);
    const environment = { ...process.env };
    delete environment.VERCEL_TOKEN;
    delete environment.VERCEL_ORG_ID;
    const cli = async (args: string[], extra: Record<string, string> = {}) => {
      try {
        const { stdout, stderr } = await execute(
          process.execPath,
          ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', 'scripts/vercel-wait.mts', ...args],
          { encoding: 'utf8', env: { ...environment, ...extra } },
        );
        return { code: 0, stdout, stderr };
      } catch (error) {
        const failed = error as { code: number; stdout: string; stderr: string };
        return { code: failed.code, stdout: failed.stdout, stderr: failed.stderr };
      }
    };
    const usage = { code: 1, stdout: '', stderr: `${USAGE}\n` };
    const refusal = (line: string) => ({ code: 1, stdout: '', stderr: `vercel:wait: ${line}\n` });
    // Never a run that would ask: each is refused, by its arguments or for want of a token.
    const runs = await Promise.all([
      cli(['--help']),
      cli([]),
      cli([DEPLOYMENT, DEPLOYMENT]),
      cli([DEPLOYMENT, '--wait']),
      cli([`http://${HOST}`], { VERCEL_TOKEN: TOKEN }),
      cli([TOKEN], { VERCEL_TOKEN: TOKEN }),
      cli([DEPLOYMENT, '--deadline', '0'], { VERCEL_TOKEN: TOKEN }),
      cli([DEPLOYMENT]),
    ]);
    expect(runs).toEqual([
      { code: 0, stdout: `${USAGE}\n`, stderr: '' },
      usage,
      usage,
      usage,
      refusal(
        'the deployment is its URL as vercel deploy prints it (https://<host>) or its id (dpl_...)',
      ),
      refusal(
        'the deployment is its URL as vercel deploy prints it (https://<host>) or its id (dpl_...)',
      ),
      refusal('--deadline takes whole minutes, from 1 to 60'),
      refusal('VERCEL_TOKEN must hold a Vercel token (from the environment)'),
    ]);
    expect(JSON.stringify(runs)).not.toContain(TOKEN);
    // As package.json runs it.
    const { scripts } = JSON.parse(readFileSync('package.json', 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(scripts['vercel:wait']).toBe(
      'node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/vercel-wait.mts',
    );
  }, 30_000);

  it("uses Node alone, and reaches Vercel and the clock only through Io's functions", () => {
    const source = readFileSync('scripts/vercel-wait.mts', 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    const imported = [...code.matchAll(/\bfrom '([^']+)'/g)].map((match) => match[1]);
    expect(imported).toEqual(['node:util']);
    const system = source.indexOf('// --- the system');
    expect(system).toBeGreaterThan(0);
    expect(source.slice(0, system).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')).not.toMatch(
      /[^.]\bfetch\(|setTimeout\(|Date\.now\(/,
    );
    for (const call of [/[^.]\bfetch\(/, /setTimeout\(/, /Date\.now\(/]) {
      expect(source.slice(system)).toMatch(call);
    }
  });

  it('is how the deploy workflow waits: --no-wait with stdout to a file, then this in a step of its own', () => {
    const workflow = readFileSync('.github/workflows/deploy.yml', 'utf8');
    const names = [
      'Build and deploy on Vercel',
      'Wait for the deployment to go live',
      'Smoke-test the live site',
    ];
    const starts = names.map((name) => workflow.indexOf(`- name: ${name}`));
    expect(starts.every((start) => start > 0)).toBe(true);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    const [deploy, wait] = starts.map((start) =>
      workflow.slice(start, workflow.indexOf('- name:', start + 1)),
    );
    // Not piped: the default shell has no pipefail, so a pipe would hide the CLI's failure.
    expect(deploy).toMatch(/^ +stdout="\$RUNNER_TEMP\/[\w.-]+"$/m);
    expect(deploy).toMatch(
      /^ +vercel deploy --prebuilt --prod --no-wait > "\$stdout" \|\| code=\$\?$/m,
    );
    // The URL from the end of the last line alone, and only a deployment's: pnpm's lines may end
    // in other URLs, and are all there is when the CLI made no deployment.
    expect(deploy).toContain(
      `url="$(tail -n 1 "$stdout" | grep -Eo 'https://[a-z0-9.-]+\\.vercel\\.app$' | tail -n 1)"`,
    );
    // No URL fails the deploy step; the URL and the CLI's exit code go to the wait.
    expect(deploy).toMatch(/^ +if \[ -z "\$url" \]; then$/m);
    expect(deploy).toMatch(/^ +id: vercel$/m);
    expect(deploy).toMatch(/^ +echo "url=\$url" >> "\$GITHUB_OUTPUT"$/m);
    expect(deploy).toMatch(/^ +echo "code=\$code" >> "\$GITHUB_OUTPUT"$/m);
    // Through the environment, never spliced into the script.
    expect(wait).toMatch(/^ +DEPLOYMENT_URL: \$\{\{ steps\.vercel\.outputs\.url \}\}$/m);
    expect(wait).toMatch(/^ +DEPLOY_EXIT_CODE: \$\{\{ steps\.vercel\.outputs\.code \}\}$/m);
    expect(wait).toMatch(/^ +pnpm vercel:wait "\$DEPLOYMENT_URL"$/m);
    // Live is not enough: a CLI that failed still fails the deploy.
    expect(wait).toMatch(/^ +if \[ "\$DEPLOY_EXIT_CODE" != 0 \]; then$/m);
    // A backstop each, so a slow build can't cut the wait short; the wait's leaves room for its
    // deadline, and together they end before the job's.
    const timeout = (step: string) => Number(/^ {8}timeout-minutes: (\d+)$/m.exec(step)?.[1]);
    const job = Number(/^ {4}timeout-minutes: (\d+)$/m.exec(workflow)?.[1]);
    expect(timeout(wait)).toBeGreaterThan(DEADLINE_MINUTES);
    expect(timeout(deploy)).toBeGreaterThan(0);
    expect(timeout(deploy) + timeout(wait)).toBeLessThan(job);
  });
});
