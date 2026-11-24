/**
 * Waits for a Vercel deployment to go live (docs/DECISIONS.md P10-18). The deploy workflow
 * (.github/workflows/deploy.yml) runs it after `vercel deploy --prebuilt --prod --no-wait`, in place
 * of the CLI's own wait, which never ends on a deployment Vercel blocks.
 *
 *   pnpm vercel:wait <deployment URL or id> [--deadline <minutes>]
 *
 * The deployment is the URL vercel deploy prints (https://<host>; the scheme may be left out) or
 * its id (dpl_...). It asks Vercel's API for it every 5 s with VERCEL_TOKEN, scoped to the team in
 * VERCEL_ORG_ID when that is a team (team_...), as the CLI does. It succeeds when the CLI would:
 * once the deployment is READY with its aliases assigned, so a production deployment answers on its
 * domains. It fails at once when Vercel blocks, cancels or fails the deployment, its checks fail or
 * Vercel cannot assign its aliases, printing Vercel's state, reason and inspector link; at once on
 * 401 and 403 (the token or the team) and on a 404 that outlasts the first minute (the URL or the
 * team); and with the last state it saw once the deadline (10 minutes) passes. No answer, 429 and
 * 5xx are asked again until then. It prints each new state once. The token goes only to
 * api.vercel.com, in the Authorization header, and is never printed. Vercel's API and the clock are
 * reached only through Io, which the tests replace.
 */
import { parseArgs } from 'node:util';

export const USAGE = 'Usage: pnpm vercel:wait <deployment URL or id> [--deadline <minutes>]';

/** Vercel's API: the only place the token goes. */
export const API = 'https://api.vercel.com';

/** How often it asks, and how long one answer may take, in ms. */
export type Timings = { poll: number; request: number };
export const TIMINGS: Timings = { poll: 5_000, request: 10_000 };

/** Minutes before it gives up: a deployment normally goes live about 20 s after its upload. */
export const DEADLINE_MINUTES = 10;

/** How long a 404 is taken for a deployment Vercel doesn't show yet, in ms. */
const NOT_FOUND_GRACE = 60_000;
/** The longest a 429 or 503's Retry-After is honoured, in ms. */
const RETRY_AFTER_MAX = 60_000;
/** The states a deployment never leaves for READY; older answers end ERROR's in _ERROR. */
const STOPPED = ['BLOCKED', 'CANCELED', 'ERROR'];
const USER_AGENT = 'menumesh-vercel-wait';

/** What the wait reaches outside itself: Vercel's API and the clock. The tests pass their own. */
export type Io = {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  /** The time in ms, as Date.now() gives it (a Retry-After may be a date). */
  now: () => number;
  sleep: (ms: number) => Promise<void>;
};

export type Options = {
  /** The deployment's host or id, as the API takes it. */
  deployment: string;
  token: string;
  /** VERCEL_ORG_ID when it is a team; a personal account's id is not sent, as the CLI does. */
  teamId?: string;
  minutes: number;
};

const said = (line: string) => `vercel:wait: ${line}`;

/** The deployment as the API takes it, from its URL (the scheme optional), host or id. */
export function deploymentOf(value: string): string | undefined {
  const text = value.trim();
  if (/^dpl_[A-Za-z0-9]+$/.test(text)) return text;
  const host = text
    .replace(/^https:\/\//i, '')
    .replace(/\/$/, '')
    .toLowerCase();
  const label = '[a-z0-9](?:[a-z0-9-]*[a-z0-9])?';
  return new RegExp(`^(?:${label}\\.)+${label}$`).test(host) ? host : undefined;
}

/** The command line and the environment, checked before anything goes to Vercel. */
export function parse(
  args: string[],
  env: Record<string, string | undefined>,
): { help: true } | { options: Options } | { refusal: string } {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      options: { deadline: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
      allowPositionals: true,
      strict: true,
    });
  } catch {
    return { refusal: USAGE };
  }
  const { values, positionals } = parsed;
  if (values.help) return { help: true };
  if (positionals.length !== 1) return { refusal: USAGE };
  // Not echoed: a mistyped argument could be anything, the token included.
  const deployment = deploymentOf(positionals[0]);
  if (!deployment) {
    return {
      refusal: said(
        'the deployment is its URL as vercel deploy prints it (https://<host>) or its id (dpl_...)',
      ),
    };
  }
  let minutes = DEADLINE_MINUTES;
  if (values.deadline !== undefined) {
    if (!/^[1-9][0-9]?$/.test(values.deadline) || Number(values.deadline) > 60) {
      return { refusal: said('--deadline takes whole minutes, from 1 to 60') };
    }
    minutes = Number(values.deadline);
  }
  const token = env.VERCEL_TOKEN;
  if (!token) {
    return { refusal: said('VERCEL_TOKEN must hold a Vercel token (from the environment)') };
  }
  const org = env.VERCEL_ORG_ID;
  return {
    options: { deployment, token, teamId: org?.startsWith('team_') ? org : undefined, minutes },
  };
}

type Fields = Record<string, unknown>;

const fields = (value: unknown): Fields =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Fields) : {};

/** Vercel's text on one line: no control character, so nothing it says starts a line of its own. */
function clean(value: unknown, max = 300): string {
  return typeof value === 'string'
    ? value
        .replace(/\p{Cc}+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max)
    : '';
}

/** The deployment's state, read as the CLI reads it (readyState, or state on older answers). */
const stateOf = (deployment: Fields) =>
  clean(deployment.readyState) || clean(deployment.state) || 'no state';

/** A state for the log; READY says whether its aliases are assigned yet. */
function describe(deployment: Fields): string {
  const state = stateOf(deployment);
  const substate = clean(deployment.readySubstate);
  const shown = substate ? `${state} (${substate})` : state;
  return state === 'READY' && !deployment.aliasAssigned
    ? `${shown}, aliases not assigned yet`
    : shown;
}

/** An alias error as code: message, from whichever of the two Vercel filled. */
function aliasProblem(deployment: Fields): string {
  const error = fields(deployment.aliasError);
  return [clean(error.code), clean(error.message)].filter(Boolean).join(': ') || 'no detail';
}

/** Why Vercel stopped it, from whichever of its fields it filled. */
function reasons(deployment: Fields): string {
  const parts = [
    clean(deployment.readyStateReason),
    [clean(deployment.errorCode), clean(deployment.errorMessage)].filter(Boolean).join(': '),
    deployment.aliasError ? `alias error ${aliasProblem(deployment)}` : '',
  ].filter(Boolean);
  return parts.length ? parts.join('; ') : 'Vercel gave no reason';
}

export type Verdict =
  | { verdict: 'live'; warnings: string[] }
  | { verdict: 'stopped'; why: string }
  | { verdict: 'waiting' };

/**
 * What an answer means. Live is the CLI's success (aliasAssigned, and READY, which a deployment
 * always is by then), an alias error beside it only a warning, as the CLI prints it. Stopped is
 * the CLI's failures (a failed deployment-alias check, failed checks, an alias error, CANCELED,
 * ERROR) plus BLOCKED, which it waits out. The why follows the deployment's URL.
 */
export function judge(deployment: Fields): Verdict {
  const state = stateOf(deployment);
  if (STOPPED.includes(state) || state.endsWith('_ERROR')) {
    return { verdict: 'stopped', why: `is ${state} on Vercel: ${reasons(deployment)}` };
  }
  if (fields(fields(deployment.checks)['deployment-alias']).state === 'failed') {
    return {
      verdict: 'stopped',
      why: `is ${state} on Vercel, but its deployment-alias check failed`,
    };
  }
  // Checks the domain waits on before it moves (Vercel's deployment checks): the CLI fails too.
  if (deployment.checksConclusion === 'failed') {
    return { verdict: 'stopped', why: `is ${state} on Vercel, but its checks failed` };
  }
  if (state === 'READY' && deployment.aliasAssigned) {
    const warning = clean(fields(deployment.aliasWarning).message);
    return {
      verdict: 'live',
      warnings: [
        ...(deployment.aliasError ? [`some aliases failed: ${aliasProblem(deployment)}`] : []),
        ...(warning ? [warning] : []),
      ],
    };
  }
  if (deployment.aliasError) {
    return {
      verdict: 'stopped',
      why: `is ${state} on Vercel, but Vercel could not assign its aliases: ${aliasProblem(deployment)}`,
    };
  }
  return { verdict: 'waiting' };
}

/** A workflow command, which GitHub shows as an annotation; % and line breaks escaped as it reads them. */
const annotation = (kind: 'error' | 'warning', message: string) =>
  `::${kind}::${message.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')}`;

const seconds = (ms: number) => `${Math.round(ms / 1000)} s`;

/** A request's failure in a word: the system's code (ECONNRESET...) or the error's name, never the request. */
function failure(error: unknown): string {
  let current = error;
  for (let depth = 0; current && depth < 4; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && /^[A-Z][A-Z0-9_]*$/.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  const name = (error as { name?: unknown } | undefined)?.name;
  return typeof name === 'string' && /^[A-Za-z]+$/.test(name) ? name : 'an unknown error';
}

/** A 429 or 503's Retry-After in ms (seconds or a date), from the poll interval up to a minute. */
function retryAfter(response: Response, now: number, poll: number): number | undefined {
  if (response.status !== 429 && response.status !== 503) return undefined;
  const header = response.headers.get('retry-after')?.trim();
  if (!header) return undefined;
  const ms = /^\d+$/.test(header) ? Number(header) * 1000 : Date.parse(header) - now;
  return Number.isFinite(ms) ? Math.min(RETRY_AFTER_MAX, Math.max(poll, ms)) : undefined;
}

type Answer =
  | { kind: 'deployment'; deployment: Fields }
  | { kind: 'retry'; why: string; after?: number }
  | { kind: 'fail'; why: string };

/** One request for the deployment, and what its answer calls for. */
async function ask(
  url: string,
  token: string,
  io: Io,
  timings: Timings,
  elapsed: number,
): Promise<Answer> {
  let response: Response;
  let body: unknown;
  try {
    response = await io.fetch(url, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        'user-agent': USER_AGENT,
      },
      // Never followed: the token goes to Vercel's API and nowhere else.
      redirect: 'manual',
      signal: AbortSignal.timeout(timings.request),
    });
    body = await response.json().catch(() => undefined);
  } catch (error) {
    const why = failure(error);
    return {
      kind: 'retry',
      why:
        why === 'TimeoutError'
          ? `no answer from Vercel within ${timings.request / 1000} s`
          : `no answer from Vercel (${why})`,
    };
  }
  const { status } = response;
  const error = fields(fields(body).error);
  const detail = [clean(error.code), clean(error.message)].filter(Boolean).join(': ');
  const answered = `Vercel answered ${status}${detail ? ` (${detail})` : ''}`;
  if (response.ok) {
    // An error in place of the deployment stops the CLI's wait too.
    if (detail) return { kind: 'fail', why: answered };
    return body && typeof body === 'object' && !Array.isArray(body)
      ? { kind: 'deployment', deployment: body as Fields }
      : { kind: 'retry', why: `${answered} with no deployment` };
  }
  if (status === 401 || status === 403) {
    return {
      kind: 'fail',
      why: `${answered}: check VERCEL_TOKEN, and that VERCEL_ORG_ID is the team that owns the project`,
    };
  }
  // Vercel may not show a deployment it has just made; past a minute, it is the URL or the team.
  if (status === 404 && elapsed < NOT_FOUND_GRACE) return { kind: 'retry', why: answered };
  if (status === 404) {
    return {
      kind: 'fail',
      why: `${answered} for over a minute: check the URL, and that VERCEL_ORG_ID is the team that owns the project`,
    };
  }
  if (status === 429 || status >= 500) {
    return { kind: 'retry', why: answered, after: retryAfter(response, io.now(), timings.poll) };
  }
  return { kind: 'fail', why: answered };
}

/** Asks until the deployment is live (true) or stopped, or the deadline passes (false). */
export async function wait(
  options: Options,
  io: Io,
  out: (line: string) => void,
  timings: Timings = TIMINGS,
): Promise<boolean> {
  const { deployment: target, token, teamId, minutes } = options;
  const name = target.startsWith('dpl_') ? target : `https://${target}`;
  const team = teamId ? `?teamId=${encodeURIComponent(teamId)}` : '';
  const url = `${API}/v13/deployments/${encodeURIComponent(target)}${team}`;
  const start = io.now();
  const deadline = start + minutes * 60_000;
  let inspector = '';
  let lastState: string | undefined;
  let lastProblem: string | undefined;
  let readyWithoutAliases = false;
  let printed = '';
  const fail = (message: string) => {
    out(annotation('error', said(`${message}${inspector ? `. Inspect: ${inspector}` : ''}`)));
    return false;
  };
  out(said(`waiting for ${name} to go live, for up to ${minutes} minutes`));
  for (;;) {
    const elapsed = io.now() - start;
    const answer = await ask(url, token, io, timings, elapsed);
    if (answer.kind === 'fail') return fail(`${name}: ${answer.why}`);
    let delay = timings.poll;
    let line: string;
    if (answer.kind === 'retry') {
      lastProblem = answer.why;
      delay = answer.after ?? delay;
      line = `${answer.why}, asking again`;
    } else {
      const deployment = answer.deployment;
      const link = clean(deployment.inspectorUrl);
      if (link.startsWith('https://')) inspector = link;
      // Asked by a domain, Vercel answers with the deployment the domain points at: an older one.
      const own = clean(deployment.url).toLowerCase();
      if (!target.startsWith('dpl_') && own && own !== target) {
        return fail(
          `${name} is an alias of https://${own}, not a new deployment: pass the URL vercel deploy printed`,
        );
      }
      const verdict = judge(deployment);
      if (verdict.verdict === 'stopped') return fail(`${name} ${verdict.why}`);
      if (verdict.verdict === 'live') {
        for (const warning of verdict.warnings) out(annotation('warning', said(warning)));
        const aliases = Array.isArray(deployment.alias)
          ? deployment.alias.map((alias) => clean(alias, 100)).filter(Boolean)
          : [];
        const listed =
          aliases.length > 8 ? [...aliases.slice(0, 8), `${aliases.length - 8} more`] : aliases;
        const named = listed.length ? `, aliases ${listed.join(', ')}` : '';
        const inspect = inspector ? `. Inspect: ${inspector}` : '';
        out(said(`live after ${seconds(elapsed)}: ${describe(deployment)}${named}${inspect}`));
        return true;
      }
      lastState = describe(deployment);
      lastProblem = undefined;
      readyWithoutAliases = stateOf(deployment) === 'READY';
      line = lastState;
    }
    // Each state once, as it changes.
    if (line !== printed) {
      out(said(`${seconds(elapsed)}: ${line}`));
      printed = line;
    }
    const now = io.now();
    if (now >= deadline) {
      const seen = lastState
        ? `its last state was ${lastState}${lastProblem ? `, and then ${lastProblem}` : ''}`
        : `Vercel never showed its state (${lastProblem ?? 'no answer'})`;
      const rollback = readyWithoutAliases
        ? '. A project rolled back with Instant Rollback gives new production deployments no domain until Undo Rollback (docs/RUNBOOK.md, Rolling back)'
        : '';
      return fail(`${name} is not live after ${minutes} minutes: ${seen}${rollback}`);
    }
    await io.sleep(Math.min(delay, deadline - now));
  }
}

/** Runs pnpm vercel:wait: the exit code, 1 when the command is refused or the deployment isn't live. */
export async function main(
  args: string[],
  env: Record<string, string | undefined>,
  io: Io,
  out: (line: string) => void,
  err: (line: string) => void,
  timings: Timings = TIMINGS,
): Promise<number> {
  // No line it prints holds the token, whatever Vercel or a mistyped argument put in it.
  const token = env.VERCEL_TOKEN;
  const scrub = (line: string) => (token ? line.split(token).join('***') : line);
  const parsed = parse(args, env);
  if ('help' in parsed) {
    out(USAGE);
    return 0;
  }
  if ('refusal' in parsed) {
    err(scrub(parsed.refusal));
    return 1;
  }
  try {
    return (await wait(parsed.options, io, (line) => out(scrub(line)), timings)) ? 0 : 1;
  } catch (error) {
    out(scrub(annotation('error', said(`stopped by ${failure(error)}`))));
    return 1;
  }
}

// --- the system: Node's fetch and clock ---

export function systemIo(): Io {
  return {
    fetch: (url, init) => fetch(url, init),
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

if (import.meta.main) {
  process.exitCode = await main(
    process.argv.slice(2),
    process.env,
    systemIo(),
    (line) => console.log(line),
    (line) => console.error(line),
  );
}
