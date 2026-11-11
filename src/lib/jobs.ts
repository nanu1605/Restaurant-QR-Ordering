import 'server-only';

import { z } from 'zod';

import { drainSignal, isDraining } from '@/lib/shutdown';

/**
 * Background work that resumes (docs/DECISIONS.md VPS-25). Each kind finds its waiting work in
 * the rows it changes and leases it there; after() starts a run at once, and the minute job
 * (/api/cron/jobs) picks up what was cut off or left. This is the part inside one process: one
 * run of a kind at a time, and a budget for how long a run keeps starting work.
 */

export const JOB_KINDS = ['data_exports', 'hindi_names', 'announcement_emails'] as const;
export type JobKind = (typeof JOB_KINDS)[number];

/** What public.jobs_waiting() returns: which kinds have work waiting. */
export const jobsWaitingSchema = z.object({
  data_exports: z.boolean(),
  hindi_names: z.boolean(),
  announcement_emails: z.boolean(),
});

/**
 * What a run checks. `signal` aborts when the server stops; `stopping()` is also true once the
 * budget is spent.
 */
export type JobRun = { signal: AbortSignal; stopping(): boolean };

/**
 * A run that starts work for `budgetMs`. The budget caps starting work and never cuts it: what
 * has started finishes, unless the server stops.
 */
export function jobRun(budgetMs: number, now: () => number = Date.now): JobRun {
  const startedAt = now();
  return {
    signal: drainSignal(),
    stopping: () => isDraining() || now() - startedAt >= budgetMs,
  };
}

type Gate = { running: Promise<void> | null; again: boolean };

// On globalThis, as the drain is: Next can bundle this file more than once.
const GATES = Symbol.for('menumesh.jobGates');

function gate(kind: JobKind): Gate {
  const holder = globalThis as { [GATES]?: Partial<Record<JobKind, Gate>> };
  const gates = (holder[GATES] ??= {});
  return (gates[kind] ??= { running: null, again: false });
}

export type JobSkipped = { skipped: 'busy' | 'stopping' };

/**
 * Runs `work` for one kind, one run at a time in this process, with a fresh budget each time.
 * When a run is already going:
 * - 'skip', the default, returns at once without touching the database, and the run going on
 *   goes once more when it ends, so what this caller asked for still happens;
 * - 'wait' waits for it to end, then runs.
 * Nothing starts once the server is stopping. Returns the first run's result, or throws its error,
 * once the run asked for meanwhile has gone too.
 */
export async function runExclusive<T>(
  kind: JobKind,
  budgetMs: number,
  work: (run: JobRun) => Promise<T>,
  { ifBusy = 'skip' }: { ifBusy?: 'skip' | 'wait' } = {},
): Promise<T | JobSkipped> {
  const current = gate(kind);
  if (isDraining()) return { skipped: 'stopping' };
  if (current.running) {
    if (ifBusy === 'skip') {
      current.again = true;
      return { skipped: 'busy' };
    }
    while (current.running) await current.running;
    if (isDraining()) return { skipped: 'stopping' };
  }

  let release!: () => void;
  const running = new Promise<void>((resolve) => (release = resolve));
  current.running = running;
  current.again = false;
  try {
    // A caller turned away meanwhile has no run of its own (on Vercel no minute job comes either),
    // so the run once more goes even when this one throws.
    let first: { result: T } | { error: unknown };
    try {
      first = { result: await work(jobRun(budgetMs)) };
    } catch (error) {
      first = { error };
    }
    while (current.again && !isDraining()) {
      current.again = false;
      try {
        await work(jobRun(budgetMs));
      } catch (error) {
        // Logged, and the runs go on: a caller turned away during this one is owed a run too.
        console.error(`[jobs] ${kind} failed`, error);
      }
    }
    if ('error' in first) throw first.error;
    return first.result;
  } finally {
    if (current.running === running) current.running = null;
    release();
  }
}
