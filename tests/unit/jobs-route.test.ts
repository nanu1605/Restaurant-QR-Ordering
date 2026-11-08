import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The minute job's route (docs/DECISIONS.md VPS-29): the scheduler's bearer, the kinds asked for,
// one question for what waits, and a run of each waiting kind after the answer.

const db = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ rpc: db.rpc }) }));
const next = vi.hoisted(() => ({ tasks: [] as (() => Promise<unknown>)[] }));
vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/server')>()),
  after: (task: () => Promise<unknown>) => next.tasks.push(task),
}));
const env = vi.hoisted(() => ({
  secret: 'cron-secret' as string | undefined,
  email: null as object | null,
  providers: [] as object[],
}));
vi.mock('@/lib/env.server', () => ({ getServerEnv: () => ({ CRON_SECRET: env.secret }) }));
vi.mock('@/lib/env', () => ({ getPublicEnv: () => ({ NEXT_PUBLIC_APP_URL: APP }) }));
vi.mock('@/lib/email/resend', () => ({ emailConfig: () => env.email }));
vi.mock('@/features/menu-import/providers', () => ({ menuImportProviders: () => env.providers }));
// Each kind's work, and the gate each run went through (its kind and budget).
const work = vi.hoisted(() => ({
  exports: vi.fn(async () => ({ ready: 1, failed: 0, released: 0, lost: 0 })),
  hindi: vi.fn(async () => ({ leased: 0, stored: 0 })),
  emails: vi.fn(async () => ({ sent: 0, duplicate: 0, refused: 0 })),
  gates: [] as unknown[][],
}));
vi.mock('@/features/closure/export-jobs', () => ({
  EXPORT_RUN_MS: 180_000,
  runExportJobs: work.exports,
}));
vi.mock('@/features/menu/hindi-names', () => ({
  HINDI_RUN_MS: 90_000,
  fillHindiNames: work.hindi,
}));
vi.mock('@/features/announcements/email', () => ({
  EMAIL_RUN_MS: 200_000,
  sendAnnouncementEmails: work.emails,
}));
vi.mock('@/lib/jobs', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/jobs')>();
  return {
    ...real,
    runExclusive: (...args: Parameters<typeof real.runExclusive>) => {
      work.gates.push(args.slice(0, 2));
      return real.runExclusive(...args);
    },
  };
});

const APP = 'https://menumesh.test';
const START = new Date('2026-11-08T10:00:00.000Z');
const EMAIL = { apiKey: 're_test', from: 'MenuMesh <news@menumesh.test>', baseUrl: 'x' };

/** The route with its once-a-minute log not yet used, whatever ran before. */
async function freshRoute() {
  vi.resetModules();
  return import('@/app/api/cron/jobs/route');
}

/** Moves the clock on by `ms`. */
const later = (ms: number) => vi.setSystemTime(new Date(START.getTime() + ms));

/** The scheduler's call: with the bearer, unless the case gives another header or none. */
const tick = (query = '', authorization: string | null = 'Bearer cron-secret') =>
  new Request(
    `http://web:3000/api/cron/jobs${query}`,
    authorization === null ? {} : { headers: { Authorization: authorization } },
  );

type Kind = 'data_exports' | 'hindi_names' | 'announcement_emails';
const waiting = (...kinds: Kind[]) =>
  db.rpc.mockResolvedValue({
    data: {
      data_exports: kinds.includes('data_exports'),
      hindi_names: kinds.includes('hindi_names'),
      announcement_emails: kinds.includes('announcement_emails'),
    },
    error: null,
  });

/** What the route left for after its answer, run to the end. */
const runAfter = () => Promise.all(next.tasks.map((task) => task()));

let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  const holder = globalThis as Record<symbol, unknown>;
  delete holder[Symbol.for('menumesh.drain')];
  delete holder[Symbol.for('menumesh.jobGates')];
  next.tasks = [];
  work.gates = [];
  env.secret = 'cron-secret';
  env.email = EMAIL;
  env.providers = [{ name: 'reader' }];
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(START);
  error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('GET /api/cron/jobs', () => {
  it('refuses a call without the secret, and asks nothing', async () => {
    const { GET } = await freshRoute();
    for (const request of [tick('', null), tick('', 'Bearer wrong')]) {
      const response = await GET(request);
      expect(response.status).toBe(401);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toEqual({ error: 'Unauthorized' });
    }
    // Nobody gets in while the secret is unset.
    env.secret = undefined;
    expect((await GET(tick())).status).toBe(401);
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it('refuses a kind it doesn’t know', async () => {
    const { GET } = await freshRoute();
    for (const query of ['?kinds=nope', '?kinds=data_exports,nope', '?kinds=']) {
      const response = await GET(tick(query));
      expect(response.status).toBe(400);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toEqual({ error: 'Unknown kind' });
    }
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it('asks what waits, and starts nothing when nothing does', async () => {
    waiting();
    const { GET } = await freshRoute();

    const response = await GET(tick());
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ ok: true, started: [] });
    expect(db.rpc).toHaveBeenCalledTimes(1);
    expect(db.rpc).toHaveBeenCalledWith('jobs_waiting');
    expect(next.tasks).toHaveLength(0);
    expect(error).not.toHaveBeenCalled();
  });

  it('starts a run of each kind that waits once it has answered, exports first', async () => {
    waiting('announcement_emails', 'hindi_names', 'data_exports');
    const { GET } = await freshRoute();

    const response = await GET(tick());
    expect(await response.json()).toEqual({
      ok: true,
      started: ['data_exports', 'hindi_names', 'announcement_emails'],
    });
    // Nothing before the answer, then one task per kind.
    expect(work.exports).not.toHaveBeenCalled();
    expect(next.tasks).toHaveLength(3);

    await runAfter();
    expect(work.gates).toEqual([
      ['data_exports', 180_000],
      ['hindi_names', 90_000],
      ['announcement_emails', 200_000],
    ]);
    const run = expect.objectContaining({ signal: expect.any(AbortSignal) });
    const admin = { rpc: db.rpc };
    expect(work.exports).toHaveBeenCalledWith(admin, run);
    expect(work.hindi).toHaveBeenCalledWith(admin, { run });
    // The minute job's emails: announcements that have started or whose emails have begun.
    expect(work.emails).toHaveBeenCalledWith(admin, EMAIL, APP, { run, minuteJob: true });
  });

  it('keeps to the kinds asked for, in its own order', async () => {
    waiting('data_exports', 'hindi_names', 'announcement_emails');
    const { GET } = await freshRoute();
    expect(await (await GET(tick('?kinds=announcement_emails,data_exports'))).json()).toEqual({
      ok: true,
      started: ['data_exports', 'announcement_emails'],
    });

    waiting('hindi_names');
    expect(await (await GET(tick('?kinds=data_exports,hindi_names'))).json()).toEqual({
      ok: true,
      started: ['hindi_names'],
    });
  });

  it('starts no emails without Resend, and no Hindi names without a menu reader', async () => {
    waiting('data_exports', 'hindi_names', 'announcement_emails');
    env.email = null;
    env.providers = [];
    const { GET } = await freshRoute();

    expect(await (await GET(tick())).json()).toEqual({ ok: true, started: ['data_exports'] });
    await runAfter();
    expect(work.hindi).not.toHaveBeenCalled();
    expect(work.emails).not.toHaveBeenCalled();
  });

  it('logs a run that fails, and the other kinds still run', async () => {
    waiting('data_exports', 'announcement_emails');
    work.exports.mockRejectedValueOnce(new Error('Could not claim an export: connection refused'));
    const { GET } = await freshRoute();

    expect((await GET(tick())).status).toBe(200);
    await runAfter();
    expect(error).toHaveBeenCalledWith('[cron/jobs] data_exports failed', expect.any(Error));
    expect(work.emails).toHaveBeenCalledTimes(1);
  });

  it('answers 500 when it can’t ask what waits, and logs that once a minute', async () => {
    db.rpc.mockResolvedValue({ data: null, error: { message: 'connection refused' } });
    const { GET } = await freshRoute();

    for (const at of [0, 30_000, 59_999]) {
      later(at);
      const response = await GET(tick());
      expect(response.status).toBe(500);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toEqual({ ok: false });
    }
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith('[cron/jobs] jobs_waiting failed', {
      message: 'connection refused',
    });

    later(60_000);
    expect((await GET(tick())).status).toBe(500);
    expect(error).toHaveBeenCalledTimes(2);
    expect(next.tasks).toHaveLength(0);
  });

  it('counts an answer it can’t read, or a call that throws, as that failure', async () => {
    db.rpc.mockResolvedValueOnce({ data: { data_exports: 'yes' }, error: null });
    db.rpc.mockRejectedValueOnce(new Error('fetch failed'));
    const { GET } = await freshRoute();

    expect((await GET(tick())).status).toBe(500);
    expect(error).toHaveBeenCalledWith('[cron/jobs] jobs_waiting failed', {
      data: { data_exports: 'yes' },
    });
    later(60_000);
    expect((await GET(tick())).status).toBe(500);
    expect(error).toHaveBeenCalledWith('[cron/jobs] jobs_waiting threw', expect.any(Error));
    expect(next.tasks).toHaveLength(0);
  });
});
