import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The health check's failure log (docs/DECISIONS.md VPS-17): the web container's own check calls
// it every 30 s, so a failing database is logged once a minute per process, and every answer is
// still the 503 it was.

const db = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ rpc: db.rpc }) }));

const START = new Date('2026-11-08T10:00:00.000Z');

/** The route with its once-a-minute log not yet used, whatever ran before. */
async function freshRoute() {
  vi.resetModules();
  return import('@/app/api/health/route');
}

/** Moves the clock on by `ms`. */
const later = (ms: number) => vi.setSystemTime(new Date(START.getTime() + ms));

let log: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(START);
  log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('GET /api/health', () => {
  it('answers ok with the database check, and logs nothing', async () => {
    db.rpc.mockResolvedValue({ data: 'ok', error: null });
    const { GET } = await freshRoute();

    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({ status: 'ok', db: 'ok' });
    expect(db.rpc).toHaveBeenCalledWith('health_check');
    expect(log).not.toHaveBeenCalled();
  });

  it('answers 503 and logs the first failure', async () => {
    db.rpc.mockResolvedValue({ data: null, error: { message: 'connection refused' } });
    const { GET } = await freshRoute();

    const response = await GET();
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      status: 'error',
      db: 'error',
      time: START.toISOString(),
    });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('[health] health_check failed', {
      message: 'connection refused',
    });
  });

  it('logs a failing check once a minute, and answers 503 every time', async () => {
    db.rpc.mockResolvedValue({ data: null, error: { message: 'connection refused' } });
    const { GET } = await freshRoute();

    const answers = [];
    for (const at of [0, 30_000, 59_999]) {
      later(at);
      answers.push((await GET()).status);
    }
    expect(answers).toEqual([503, 503, 503]);
    expect(log).toHaveBeenCalledTimes(1);

    later(60_000);
    expect((await GET()).status).toBe(503);
    expect(log).toHaveBeenCalledTimes(2);

    later(90_000);
    await GET();
    expect(log).toHaveBeenCalledTimes(2);
  });

  it('counts an unexpected error and a failed answer as one failure', async () => {
    db.rpc.mockRejectedValueOnce(new Error('fetch failed'));
    db.rpc.mockResolvedValue({ data: 'degraded', error: null });
    const { GET } = await freshRoute();

    expect((await GET()).status).toBe(503);
    expect(log).toHaveBeenCalledWith('[health] health_check threw', expect.any(Error));

    later(30_000);
    const response = await GET();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ status: 'error', db: 'error' });
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("doesn't start the minute over when the database answers in between", async () => {
    db.rpc.mockResolvedValueOnce({ data: null, error: { message: 'down' } });
    db.rpc.mockResolvedValueOnce({ data: 'ok', error: null });
    db.rpc.mockResolvedValue({ data: null, error: { message: 'down again' } });
    const { GET } = await freshRoute();

    await GET();
    later(20_000);
    expect((await GET()).status).toBe(200);
    later(40_000);
    expect((await GET()).status).toBe(503);
    expect(log).toHaveBeenCalledTimes(1);
  });
});
