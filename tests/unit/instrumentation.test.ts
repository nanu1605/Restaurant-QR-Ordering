import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { register } from '@/instrumentation';

// register() (docs/DECISIONS.md VPS-25): the jobs' stop goes in beside Next.js's own SIGTERM
// listener, and a server that had none says so, as its stops would then run job work to the kill.

vi.mock('@sentry/nextjs', () => ({
  init: vi.fn(),
  captureConsoleIntegration: vi.fn(),
  captureRequestError: vi.fn(),
}));
const shutdown = vi.hoisted(() => ({ stopJobsOnSigterm: vi.fn<() => boolean>() }));
vi.mock('@/lib/shutdown', () => shutdown);

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  shutdown.stopJobsOnSigterm.mockReset();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.stubEnv('NEXT_RUNTIME', 'nodejs');
  vi.stubEnv('VERCEL', undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('register', () => {
  it('warns once when the stop found no SIGTERM listener to go beside', async () => {
    shutdown.stopJobsOnSigterm.mockReturnValue(false);

    await register();
    expect(shutdown.stopJobsOnSigterm).toHaveBeenCalledTimes(1);
    // pnpm docker:check fails on this line in the container's logs.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[jobs] no SIGTERM listener'));
  });

  it('says nothing when the stop listens, on Vercel, or on the edge runtime', async () => {
    shutdown.stopJobsOnSigterm.mockReturnValue(true);
    await register();

    shutdown.stopJobsOnSigterm.mockReturnValue(false);
    vi.stubEnv('VERCEL', '1');
    await register();

    vi.stubEnv('VERCEL', undefined);
    vi.stubEnv('NEXT_RUNTIME', 'edge');
    await register();

    expect(shutdown.stopJobsOnSigterm).toHaveBeenCalledTimes(2);
    expect(warn).not.toHaveBeenCalled();
  });
});
