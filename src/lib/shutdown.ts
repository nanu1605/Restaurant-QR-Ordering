/**
 * The server's stop (docs/DECISIONS.md VPS-25). At SIGTERM Next.js stops taking requests and
 * waits for every after() before it exits; Docker kills it 25 s after the signal. The jobs watch
 * this signal: they claim nothing more and hand back what they hold, so a stop takes seconds.
 *
 * Not server-only: instrumentation.ts imports it. The state lives on globalThis because the
 * instrumentation and the app's code can be separate bundles, each with its own copy of this file.
 */

const DRAIN = Symbol.for('menumesh.drain');

type Drain = { controller: AbortController; listening: boolean };

function drain(): Drain {
  const holder = globalThis as { [DRAIN]?: Drain };
  return (holder[DRAIN] ??= { controller: new AbortController(), listening: false });
}

/** Aborted once the server is stopping. */
export const drainSignal = (): AbortSignal => drain().controller.signal;

export const isDraining = (): boolean => drainSignal().aborted;

type Signals = {
  once(event: 'SIGTERM', listener: () => void): unknown;
  listenerCount(event: 'SIGTERM'): number;
};

/**
 * Aborts drainSignal() at SIGTERM, and only beside a listener that is already there: Next.js
 * adds its own before register() runs. A process with none exits at SIGTERM, which a listener of
 * ours would stop, so then none is added and a stop behaves as it always did. Says whether it
 * listens.
 */
export function stopJobsOnSigterm(proc: Signals = process): boolean {
  const state = drain();
  if (state.listening) return true;
  if (proc.listenerCount('SIGTERM') === 0) return false;
  // An AbortError, so the Supabase client gives up the request instead of retrying it.
  proc.once('SIGTERM', () =>
    state.controller.abort(new DOMException('The server is stopping', 'AbortError')),
  );
  state.listening = true;
  return true;
}
