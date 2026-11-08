import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { jobRun, runExclusive } from '@/lib/jobs';
import { drainSignal, isDraining, stopJobsOnSigterm } from '@/lib/shutdown';

// The jobs' shared parts (docs/DECISIONS.md VPS-25): one run of a kind at a time in a process,
// a budget for starting work, and the server's stop.

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

/** A process with its own SIGTERM listener, as Next.js's has, that then gets SIGTERM. */
function stopTheServer() {
  const proc = new EventEmitter();
  proc.on('SIGTERM', () => undefined);
  stopJobsOnSigterm(proc);
  proc.emit('SIGTERM');
}

beforeEach(() => {
  const holder = globalThis as Record<symbol, unknown>;
  delete holder[Symbol.for('menumesh.drain')];
  delete holder[Symbol.for('menumesh.jobGates')];
});

describe('runExclusive', () => {
  it('turns others away without calling them, then runs once more for them', async () => {
    const first = deferred();
    const work = vi
      .fn(async () => 'more')
      .mockImplementationOnce(async () => {
        await first.promise;
        return 'first';
      });
    const turnedAway = vi.fn(async () => 'never');

    const running = runExclusive('data_exports', 60_000, work);
    await expect(runExclusive('data_exports', 60_000, turnedAway)).resolves.toEqual({
      skipped: 'busy',
    });
    await expect(runExclusive('data_exports', 60_000, turnedAway)).resolves.toEqual({
      skipped: 'busy',
    });
    expect(turnedAway).not.toHaveBeenCalled();
    expect(work).toHaveBeenCalledTimes(1);

    first.resolve();
    // Its own result; once more for both callers it turned away.
    await expect(running).resolves.toBe('first');
    expect(work).toHaveBeenCalledTimes(2);
    expect(turnedAway).not.toHaveBeenCalled();

    // Nothing was turned away during that: the next call runs at once, and only once.
    await expect(runExclusive('data_exports', 60_000, work)).resolves.toBe('more');
    expect(work).toHaveBeenCalledTimes(3);
  });

  it('keeps each kind to its own runs', async () => {
    const first = deferred();
    const running = runExclusive('data_exports', 60_000, () => first.promise);
    await expect(runExclusive('hindi_names', 60_000, async () => 'names')).resolves.toBe('names');
    first.resolve();
    await running;
  });

  it('waits for the run going on, then runs, one at a time', async () => {
    const first = deferred();
    const order: string[] = [];
    let inside = 0;
    const step = (name: string, wait?: Promise<void>) => async () => {
      inside += 1;
      expect(inside).toBe(1);
      await wait;
      await Promise.resolve();
      order.push(name);
      inside -= 1;
      return name;
    };

    const running = runExclusive('announcement_emails', 60_000, step('first', first.promise));
    const second = runExclusive('announcement_emails', 60_000, step('second'), { ifBusy: 'wait' });
    const third = runExclusive('announcement_emails', 60_000, step('third'), { ifBusy: 'wait' });
    await Promise.resolve();
    expect(order).toEqual([]);

    first.resolve();
    await expect(Promise.all([running, second, third])).resolves.toEqual([
      'first',
      'second',
      'third',
    ]);
    expect(order).toEqual(['first', 'second', 'third']);
  });

  it('lets the next run in when one throws', async () => {
    await expect(
      runExclusive('hindi_names', 60_000, async () => {
        throw new Error('database down');
      }),
    ).rejects.toThrow('database down');
    await expect(runExclusive('hindi_names', 60_000, async () => 'ok')).resolves.toBe('ok');
  });

  it('logs a second run that throws, and keeps the first run’s result', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const first = deferred();
    const work = vi
      .fn(async (): Promise<string> => {
        throw new Error('database down');
      })
      .mockImplementationOnce(async () => {
        await first.promise;
        return 'first';
      });

    const running = runExclusive('data_exports', 60_000, work);
    await runExclusive('data_exports', 60_000, work);
    first.resolve();
    await expect(running).resolves.toBe('first');
    expect(error).toHaveBeenCalledWith(
      '[jobs] data_exports failed',
      expect.objectContaining({ message: 'database down' }),
    );
    await expect(runExclusive('data_exports', 60_000, async () => 'free')).resolves.toBe('free');
  });

  it('starts nothing once the server is stopping', async () => {
    stopTheServer();
    const work = vi.fn(async () => 'never');
    await expect(runExclusive('data_exports', 60_000, work)).resolves.toEqual({
      skipped: 'stopping',
    });
    await expect(
      runExclusive('announcement_emails', 60_000, work, { ifBusy: 'wait' }),
    ).resolves.toEqual({ skipped: 'stopping' });
    expect(work).not.toHaveBeenCalled();
  });

  it('runs neither the waiting nor the turned-away work after a stop', async () => {
    const first = deferred();
    const work = vi.fn(async () => {
      await first.promise;
      return 'first';
    });
    const waiter = vi.fn(async () => 'never');

    const running = runExclusive('announcement_emails', 60_000, work);
    await runExclusive('announcement_emails', 60_000, work);
    const waiting = runExclusive('announcement_emails', 60_000, waiter, { ifBusy: 'wait' });
    stopTheServer();
    first.resolve();

    await expect(running).resolves.toBe('first');
    await expect(waiting).resolves.toEqual({ skipped: 'stopping' });
    expect(work).toHaveBeenCalledTimes(1);
    expect(waiter).not.toHaveBeenCalled();
  });

  it('holds across copies of the module, as Next’s bundles can make', async () => {
    const first = deferred();
    const running = runExclusive('data_exports', 60_000, () => first.promise);

    vi.resetModules();
    const copy = await import('@/lib/jobs');
    const work = vi.fn(async () => 'never');
    await expect(copy.runExclusive('data_exports', 60_000, work)).resolves.toEqual({
      skipped: 'busy',
    });
    expect(work).not.toHaveBeenCalled();

    stopTheServer();
    expect((await import('@/lib/shutdown')).isDraining()).toBe(true);
    first.resolve();
    await running;
  });
});

describe('jobRun', () => {
  it('stops starting work once its budget is spent', () => {
    let now = 1_000;
    const run = jobRun(500, () => now);
    expect(run.stopping()).toBe(false);
    now = 1_499;
    expect(run.stopping()).toBe(false);
    now = 1_500;
    expect(run.stopping()).toBe(true);
    expect(run.signal.aborted).toBe(false);
  });

  it('stops at once when the server stops, and aborts what is in flight', () => {
    const run = jobRun(60_000);
    expect(run.stopping()).toBe(false);
    stopTheServer();
    expect(run.stopping()).toBe(true);
    expect(run.signal.aborted).toBe(true);
  });
});

describe('stopJobsOnSigterm', () => {
  it('adds no listener to a process without one, so SIGTERM still ends it', () => {
    const proc = new EventEmitter();
    expect(stopJobsOnSigterm(proc)).toBe(false);
    expect(proc.listenerCount('SIGTERM')).toBe(0);
    expect(isDraining()).toBe(false);
  });

  it('aborts the drain signal at SIGTERM, beside the listener already there', () => {
    const proc = new EventEmitter();
    const nextjs = vi.fn();
    proc.on('SIGTERM', nextjs);

    expect(stopJobsOnSigterm(proc)).toBe(true);
    expect(stopJobsOnSigterm(proc)).toBe(true);
    expect(proc.listenerCount('SIGTERM')).toBe(2);
    const signal = drainSignal();
    expect(signal.aborted).toBe(false);

    proc.emit('SIGTERM');
    expect(nextjs).toHaveBeenCalledTimes(1);
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toMatchObject({ name: 'AbortError' });
    expect(isDraining()).toBe(true);
    // Once: Next's own listener is the one left.
    expect(proc.listenerCount('SIGTERM')).toBe(1);
  });

  it('finds Next.js’s listener there: its server adds it before it loads what runs register()', () => {
    // An upgrade that moved it after would leave the stop off, with only register()'s warning.
    const startServer = readFileSync(
      createRequire(import.meta.url).resolve('next/dist/server/lib/start-server.js'),
      'utf8',
    );
    const listener = startServer.indexOf("process.on('SIGTERM', cleanup)");
    expect(listener).toBeGreaterThan(-1);
    expect(startServer.indexOf('await getRequestHandlers(')).toBeGreaterThan(listener);
  });
});
