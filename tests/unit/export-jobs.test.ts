import { EventEmitter, getEventListeners } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { parseExportClaim } from '@/features/closure/closure';
import { buildExport, EXPORT_BUCKET } from '@/features/closure/export';
import {
  EXPORT_BUSY_WAIT_MS,
  runExportJobs,
  startExportJobs,
} from '@/features/closure/export-jobs';
import { jobRun } from '@/lib/jobs';
import { drainSignal, stopJobsOnSigterm } from '@/lib/shutdown';

import { readZip } from '../read-zip';

// Data exports built from a queue (docs/DECISIONS.md VPS-26), against a fake Supabase client: a
// claim, the build under its heartbeat, and how it ends.

const next = vi.hoisted(() => ({ tasks: [] as (() => Promise<unknown>)[] }));
vi.mock('next/server', () => ({
  after: (task: () => Promise<unknown>) => next.tasks.push(task),
}));
const db = vi.hoisted(() => ({ admin: null as unknown }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => db.admin }));
// The real ZIP writer, which a test can watch file by file.
const zip = vi.hoisted(() => ({
  entries: [] as string[],
  onEntry: null as ((name: string) => void) | null,
}));
vi.mock('@/lib/zip', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/zip')>();
  return {
    ...real,
    zipEntry: (name: string, text: string) => {
      zip.entries.push(name);
      zip.onEntry?.(name);
      return real.zipEntry(name, text);
    },
  };
});

const RESTAURANT = '0b5b4a5e-6f0f-4c55-9a7e-2f6a1d1c0001';
const FIRST = '1c6c5b6f-7a1a-4d66-8b8f-3a7b2e2d0002';
const SECOND = '1c6c5b6f-7a1a-4d66-8b8f-3a7b2e2d0003';
const CLAIM = '2d7d6c7a-8b2b-4e77-9c9a-4b8c3f3e0004';

const claimed = (exportId = FIRST) => ({
  export_id: exportId,
  restaurant_id: RESTAURANT,
  claim_id: CLAIM,
});
const claim = { exportId: FIRST, restaurantId: RESTAURANT, claimId: CLAIM };
const ids = { p_export_id: FIRST, p_claim_id: CLAIM };

type Reply = { data?: unknown; count?: number; error: { message: string } | null };

/** What rpc() gives back: awaited, or given .abortSignal() first, as the real one is. */
function rpcReply(reply: Reply, onSignal?: (signal: AbortSignal) => void) {
  const promise = Promise.resolve(reply);
  return Object.assign(promise, {
    abortSignal: (signal: AbortSignal) => {
      onSignal?.(signal);
      return promise;
    },
  });
}

/**
 * A Supabase client whose claims hand out these exports in turn. `page` can hold or fail a
 * table's read (the rows come after it), `upload` the upload.
 */
function fakeAdmin({
  claims = [],
  heartbeat = () => true,
  page,
  upload = async () => ({ error: null }),
}: {
  claims?: object[];
  heartbeat?: () => boolean;
  page?: (table: string, signal: AbortSignal) => Promise<Reply | void>;
  upload?: () => Promise<{ error: { message: string } | null }>;
} = {}) {
  const queue = [...claims];
  // What each call was given to abort it.
  const signals = new Map<string, AbortSignal>();
  const reads: string[] = [];

  const rpc = vi.fn<(fn: string, args?: object) => ReturnType<typeof rpcReply>>((fn) => {
    const data =
      fn === 'restaurant_export_claim'
        ? (queue.shift() ?? null)
        : fn === 'restaurant_export_heartbeat'
          ? heartbeat()
          : true;
    return rpcReply({ data, error: null }, (signal) => signals.set(fn, signal));
  });

  const from = (table: string) => {
    let head = false;
    let signal = new AbortController().signal;
    const answer = async (): Promise<Reply> => {
      if (table === 'restaurants') {
        return {
          data: { name: 'Spice Cafe', slug: 'spice', timezone: 'Asia/Kolkata' },
          error: null,
        };
      }
      if (table === 'restaurant_subscriptions') return { data: null, error: null };
      if (head) return { count: 0, error: null };
      reads.push(table);
      const held = await page?.(table, signal);
      if (held) return held;
      if (signal.aborted) return { data: null, error: { message: `AbortError: ${signal.reason}` } };
      return { data: [], error: null };
    };
    const builder = {
      select: (_columns: string, options?: { head?: boolean }) => {
        head = Boolean(options?.head);
        return builder;
      },
      eq: () => builder,
      order: () => builder,
      limit: () => builder,
      gt: () => builder,
      single: () => builder,
      maybeSingle: () => builder,
      abortSignal: (given: AbortSignal) => {
        signal = given;
        return builder;
      },
      then: (done: (reply: Reply) => unknown, failed: (error: unknown) => unknown) =>
        answer().then(done, failed),
    };
    return builder;
  };

  const uploads = vi.fn<(path: string, zip: Buffer, options: object) => ReturnType<typeof upload>>(
    () => upload(),
  );
  const storage = { from: vi.fn(() => ({ upload: uploads })) };
  const admin = { rpc, from, storage } as unknown as Parameters<typeof buildExport>[0];
  const calls = (fn: string) => rpc.mock.calls.filter(([name]) => name === fn);
  return { admin, rpc, calls, signals, reads, uploads, storage };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

const aborted = (signal: AbortSignal) =>
  new Promise<void>((done) =>
    signal.aborted ? done() : signal.addEventListener('abort', () => done()),
  );

/** A process with its own SIGTERM listener, as Next.js's has, that then gets SIGTERM. */
function stopTheServer() {
  const proc = new EventEmitter();
  proc.on('SIGTERM', () => undefined);
  stopJobsOnSigterm(proc);
  proc.emit('SIGTERM');
}

let info: ReturnType<typeof vi.spyOn>;
let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  const holder = globalThis as Record<symbol, unknown>;
  delete holder[Symbol.for('menumesh.drain')];
  delete holder[Symbol.for('menumesh.jobGates')];
  next.tasks = [];
  zip.entries = [];
  zip.onEntry = null;
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  // No heartbeat outlives its build, whichever way it ended.
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});

describe('runExportJobs', () => {
  it('claims once when nothing waits', async () => {
    const { admin, rpc } = fakeAdmin();
    await expect(runExportJobs(admin, jobRun(60_000))).resolves.toEqual({
      ready: 0,
      failed: 0,
      released: 0,
      lost: 0,
    });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('restaurant_export_claim', { p_lease_seconds: 90 });
  });

  it('builds each claimed export into its own file, and completes it under its claim', async () => {
    const { admin, calls, uploads, storage } = fakeAdmin({
      claims: [claimed(FIRST), claimed(SECOND)],
    });

    await expect(runExportJobs(admin, jobRun(60_000))).resolves.toMatchObject({ ready: 2 });

    expect(calls('restaurant_export_claim')).toHaveLength(3);
    expect(storage.from).toHaveBeenCalledWith(EXPORT_BUCKET);
    // The export's own path, replaced when it is built again.
    expect(uploads.mock.calls.map(([path, , options]) => [path, options])).toEqual([
      [`${RESTAURANT}/${FIRST}.zip`, { contentType: 'application/zip', upsert: true }],
      [`${RESTAURANT}/${SECOND}.zip`, { contentType: 'application/zip', upsert: true }],
    ]);
    expect(Object.keys(readZip(uploads.mock.calls[0]![1]))).toContain('README.txt');
    const size = uploads.mock.calls[0]![1].length;
    expect(calls('restaurant_export_complete')).toEqual([
      ['restaurant_export_complete', { ...ids, p_size_bytes: size }],
      [
        'restaurant_export_complete',
        { p_export_id: SECOND, p_claim_id: CLAIM, p_size_bytes: size },
      ],
    ]);
    expect(info).toHaveBeenCalledWith('[closure] export ready', FIRST, {
      rows: 0,
      bytes: size,
      ms: expect.any(Number),
    });
  });

  it('starts no build once its budget is spent, and finishes the one it started', async () => {
    const { admin, calls } = fakeAdmin({
      claims: [claimed(FIRST), claimed(SECOND)],
      upload: async () => {
        vi.setSystemTime(Date.now() + 2_000);
        return { error: null };
      },
    });

    await expect(runExportJobs(admin, jobRun(1_000))).resolves.toMatchObject({ ready: 1 });
    expect(calls('restaurant_export_claim')).toHaveLength(1);
    expect(calls('restaurant_export_complete')).toHaveLength(1);
  });

  it('claims nothing once the server is stopping', async () => {
    stopTheServer();
    const { admin, rpc } = fakeAdmin({ claims: [claimed()] });
    await expect(runExportJobs(admin, jobRun(60_000))).resolves.toMatchObject({ ready: 0 });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('hands the export back and stops when the server stops during a build', async () => {
    const { admin, calls, signals, uploads } = fakeAdmin({
      claims: [claimed(FIRST), claimed(SECOND)],
      page: async (table, signal) => {
        if (table !== 'menu_categories') return;
        stopTheServer();
        expect(signal.aborted).toBe(true);
      },
    });

    await expect(runExportJobs(admin, jobRun(60_000))).resolves.toEqual({
      ready: 0,
      failed: 0,
      released: 1,
      lost: 0,
    });
    expect(calls('restaurant_export_release')).toEqual([['restaurant_export_release', ids]]);
    // Sent although the server is stopping: it has its own timeout, not the stop's signal.
    expect(signals.get('restaurant_export_release')!.aborted).toBe(false);
    expect(calls('restaurant_export_fail')).toHaveLength(0);
    expect(uploads).not.toHaveBeenCalled();
    // Not counted as a failure, and the next export waits for the next server.
    expect(error).not.toHaveBeenCalled();
    expect(calls('restaurant_export_claim')).toHaveLength(1);
  });

  it('throws when the claim does', async () => {
    const { admin, rpc } = fakeAdmin();
    rpc.mockImplementationOnce(() =>
      rpcReply({ data: null, error: { message: 'connection refused' } }),
    );
    await expect(runExportJobs(admin, jobRun(60_000))).rejects.toThrow(
      'Could not claim an export: connection refused',
    );
  });

  describe('while another server holds the one build', () => {
    beforeEach(() => {
      vi.useFakeTimers({
        toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
      });
    });

    it('claims again every 5 seconds, and builds once the slot is free', async () => {
      const { admin, calls } = fakeAdmin({ claims: [{ busy: true }, { busy: true }, claimed()] });

      const running = runExportJobs(admin, jobRun(60_000));
      await vi.advanceTimersByTimeAsync(EXPORT_BUSY_WAIT_MS - 1);
      expect(calls('restaurant_export_claim')).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(calls('restaurant_export_claim')).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(EXPORT_BUSY_WAIT_MS);

      await expect(running).resolves.toEqual({ ready: 1, failed: 0, released: 0, lost: 0 });
      expect(calls('restaurant_export_complete')).toHaveLength(1);
      // Then the queue is empty.
      expect(calls('restaurant_export_claim')).toHaveLength(4);
      // The waits left nothing on the stop's signal.
      expect(getEventListeners(drainSignal(), 'abort')).toHaveLength(0);
    });

    it('ends the run at once when the server stops during the wait', async () => {
      const { admin, calls } = fakeAdmin({ claims: [{ busy: true }, claimed()] });
      let ended = false;
      const running = runExportJobs(admin, jobRun(60_000)).finally(() => {
        ended = true;
      });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(calls('restaurant_export_claim')).toHaveLength(1);

      stopTheServer();
      await vi.advanceTimersByTimeAsync(0);
      expect(ended).toBe(true);
      await expect(running).resolves.toEqual({ ready: 0, failed: 0, released: 0, lost: 0 });
      expect(calls('restaurant_export_claim')).toHaveLength(1);
    });

    it('stops waiting once its budget is spent', async () => {
      const { admin, calls } = fakeAdmin({ claims: [{ busy: true }, { busy: true }, claimed()] });

      const running = runExportJobs(admin, jobRun(8_000));
      await vi.advanceTimersByTimeAsync(2 * EXPORT_BUSY_WAIT_MS);

      await expect(running).resolves.toEqual({ ready: 0, failed: 0, released: 0, lost: 0 });
      // At 0 and 5 s; at 10 s the budget is spent.
      expect(calls('restaurant_export_claim')).toHaveLength(2);
    });
  });
});

describe('buildExport', () => {
  it('renews its claim every 15 seconds, and once more before the upload', async () => {
    const hold = deferred();
    const reading = deferred();
    const { admin, calls } = fakeAdmin({
      page: async (table) => {
        if (table !== 'menu_categories') return;
        reading.resolve();
        await hold.promise;
      },
    });

    const building = buildExport(admin, claim, jobRun(60_000));
    await reading.promise;
    expect(calls('restaurant_export_heartbeat')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(45_000);
    expect(calls('restaurant_export_heartbeat')).toEqual(
      Array(3).fill(['restaurant_export_heartbeat', { ...ids, p_lease_seconds: 90 }]),
    );

    hold.resolve();
    await expect(building).resolves.toBe('ready');
    expect(calls('restaurant_export_heartbeat')).toHaveLength(4);
  });

  it('stops quietly once its claim is gone: no upload, no complete, no fail', async () => {
    const reading = deferred();
    const { admin, calls, reads, uploads } = fakeAdmin({
      heartbeat: () => false,
      // Every read takes until the build stops.
      page: async (_table, signal) => {
        reading.resolve();
        await aborted(signal);
      },
    });

    const building = buildExport(admin, claim, jobRun(60_000));
    await reading.promise;
    await vi.advanceTimersByTimeAsync(15_000);

    await expect(building).resolves.toBe('lost');
    expect(uploads).not.toHaveBeenCalled();
    for (const fn of ['complete', 'fail', 'release']) {
      expect(calls(`restaurant_export_${fn}`)).toHaveLength(0);
    }
    // The four readers stopped there.
    expect(reads).toHaveLength(4);
    expect(warn).toHaveBeenCalledWith('[closure] export claim lost', FIRST);
  });

  it('uploads nothing when its claim is gone by the upload', async () => {
    const { admin, calls, uploads } = fakeAdmin({ heartbeat: () => false });
    await expect(buildExport(admin, claim, jobRun(60_000))).resolves.toBe('lost');
    expect(calls('restaurant_export_heartbeat')).toHaveLength(1);
    expect(uploads).not.toHaveBeenCalled();
    expect(calls('restaurant_export_complete')).toHaveLength(0);
  });

  it('hands the export back when the server stops between its files', async () => {
    const { admin, calls, uploads } = fakeAdmin();
    zip.onEntry = (name) => {
      if (name === 'menu.json') stopTheServer();
    };

    await expect(buildExport(admin, claim, jobRun(60_000))).resolves.toBe('released');
    expect(zip.entries).toEqual(['README.txt', 'profile.json', 'menu.json']);
    expect(uploads).not.toHaveBeenCalled();
    expect(calls('restaurant_export_release')).toEqual([['restaurant_export_release', ids]]);
  });

  it('finishes an upload the stop comes during, and completes it', async () => {
    const { admin, calls } = fakeAdmin({
      upload: async () => {
        stopTheServer();
        return { error: null };
      },
    });
    await expect(buildExport(admin, claim, jobRun(60_000))).resolves.toBe('ready');
    expect(calls('restaurant_export_complete')).toHaveLength(1);
    expect(calls('restaurant_export_release')).toHaveLength(0);
  });

  it('fails the export on an error, and logs it', async () => {
    const { admin, calls } = fakeAdmin({
      page: async (table) =>
        table === 'orders' ? { data: null, error: { message: 'permission denied' } } : undefined,
    });

    await expect(buildExport(admin, claim, jobRun(60_000))).resolves.toBe('failed');
    expect(calls('restaurant_export_fail')).toEqual([
      ['restaurant_export_fail', { ...ids, p_error: 'orders: permission denied' }],
    ]);
    expect(error).toHaveBeenCalledWith(
      '[closure] export failed',
      RESTAURANT,
      FIRST,
      expect.objectContaining({ message: 'orders: permission denied' }),
    );
    expect(calls('restaurant_export_complete')).toHaveLength(0);
  });

  it('fails the export when the upload does', async () => {
    const { admin, calls } = fakeAdmin({
      upload: async () => ({ error: { message: 'The object exceeded the maximum allowed size' } }),
    });
    await expect(buildExport(admin, claim, jobRun(60_000))).resolves.toBe('failed');
    expect(calls('restaurant_export_fail')).toEqual([
      [
        'restaurant_export_fail',
        { ...ids, p_error: 'upload: The object exceeded the maximum allowed size' },
      ],
    ]);
  });

  it('stops the other readers at the first error, and ends only once they have', async () => {
    const reading = ['menu_items', 'menu_item_variants', 'menu_addon_groups'];
    const settled: string[] = [];
    const { admin, calls, reads } = fakeAdmin({
      page: async (table, signal) => {
        if (table === 'menu_categories') return { data: null, error: { message: 'reset' } };
        if (!reading.includes(table)) return;
        await aborted(signal);
        settled.push(table);
      },
    });

    await expect(buildExport(admin, claim, jobRun(60_000))).resolves.toBe('failed');
    // Four at a time: the first error stopped the three reading, and none started after it.
    expect(reads).toEqual(['menu_categories', ...reading]);
    expect(settled.sort()).toEqual([...reading].sort());
    expect(calls('restaurant_export_fail')).toEqual([
      ['restaurant_export_fail', { ...ids, p_error: 'menu_categories: reset' }],
    ]);

    // Nothing reads on after the build.
    await new Promise((done) => setImmediate(done));
    expect(reads).toHaveLength(4);
  });
});

describe('startExportJobs', () => {
  it('runs the export queue after the response, one run at a time', async () => {
    const hold = deferred();
    const fake = fakeAdmin({
      claims: [claimed()],
      page: async (table) => {
        if (table === 'menu_categories') await hold.promise;
      },
    });
    db.admin = fake.admin;

    startExportJobs();
    startExportJobs();
    expect(next.tasks).toHaveLength(2);
    expect(fake.rpc).not.toHaveBeenCalled();

    const first = next.tasks[0]!();
    // Asked for while it builds: no second claim now, one more once it ends.
    await expect(next.tasks[1]!()).resolves.toEqual({ skipped: 'busy' });
    expect(fake.calls('restaurant_export_claim')).toHaveLength(1);

    hold.resolve();
    await first;
    expect(fake.calls('restaurant_export_complete')).toHaveLength(1);
    expect(fake.calls('restaurant_export_claim')).toHaveLength(3);
  });

  it('logs a run that fails', async () => {
    const fake = fakeAdmin();
    fake.rpc.mockImplementationOnce(() =>
      rpcReply({ data: null, error: { message: 'connection refused' } }),
    );
    db.admin = fake.admin;

    startExportJobs();
    await next.tasks[0]!();
    expect(error).toHaveBeenCalledWith(
      '[closure] export run failed',
      expect.objectContaining({ message: 'Could not claim an export: connection refused' }),
    );
  });
});

describe('parseExportClaim', () => {
  it('reads a claim, a slot another build holds, or none', () => {
    expect(parseExportClaim(null)).toBeNull();
    expect(parseExportClaim(claimed())).toEqual(claim);
    expect(parseExportClaim({ busy: true })).toBe('busy');
    expect(() => parseExportClaim({ busy: false })).toThrow();
    expect(() => parseExportClaim({ export_id: FIRST, restaurant_id: RESTAURANT })).toThrow();
    expect(() => parseExportClaim({ ...claimed(), claim_id: 'c1' })).toThrow();
  });
});
