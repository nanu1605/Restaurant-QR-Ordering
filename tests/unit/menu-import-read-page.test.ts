import { beforeEach, describe, expect, it, vi } from 'vitest';

import { readMenuPage } from '@/features/menu-import/actions';
import {
  extractPage,
  PAGE_DEADLINE_MS,
  READER_UNAVAILABLE,
  type PageOutcome,
} from '@/features/menu-import/extract';

// Reading one page in its server action: its time counts from the action's start, and a photo
// that is slow to arrive can be tried again (docs/DECISIONS.md P7-15, VPS-5).

const IMPORT_ID = '123e4567-e89b-42d3-a456-426614174000';

const db = vi.hoisted(() => ({ rpc: vi.fn(), download: vi.fn() }));
vi.mock('next/cache', () => ({ refresh: vi.fn() }));
vi.mock('@/lib/auth/guards', () => ({ requireUser: async () => ({}) }));
vi.mock('@/lib/env.server', () => ({ getServerEnv: () => ({ MENU_IMPORT_USD_INR: 96 }) }));
vi.mock('@/features/menu-import/providers', () => ({ menuImportProviders: () => [] }));
vi.mock('@/features/menu-import/extract', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/menu-import/extract')>()),
  extractPage: vi.fn(),
}));
// The caller's own read of the import, then the service role's claim, photo and record.
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: {
              status: 'uploaded',
              source: 'photo',
              file_paths: ['r1/i1/1.jpg'],
              pages: [{ index: 1, status: 'pending' }],
            },
            error: null,
          }),
        }),
      }),
    }),
  }),
}));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    rpc: db.rpc,
    storage: { from: () => ({ download: db.download }) },
  }),
}));

const unavailable: PageOutcome = {
  status: 'failed',
  result: null,
  raw: null,
  error: READER_UNAVAILABLE,
  provider: null,
  model: null,
  inputTokens: 0,
  outputTokens: 0,
  costPaise: 0,
};

/** The page as the action recorded it. */
const recorded = () =>
  db.rpc.mock.calls.find(([fn]) => fn === 'menu_import_record_page')![1].p_page as {
    index: number;
    status: string;
    error: string;
  };

beforeEach(() => {
  db.rpc.mockImplementation(async (fn: string) => ({
    data: fn === 'menu_import_claim_page' ? true : { total: 1, done: 0, failed: 1 },
    error: null,
  }));
  db.download.mockResolvedValue({ data: new Blob(['jpeg']), error: null });
  vi.mocked(extractPage).mockResolvedValue(unavailable);
});

describe('readMenuPage', () => {
  it('gives the reader what the steps before it left of the page’s time', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-11-08T10:00:00Z'));
      db.rpc.mockImplementation(async (fn: string) => {
        // The claim, a slow call to the database, takes 12 s.
        if (fn === 'menu_import_claim_page') vi.setSystemTime(Date.now() + 12_000);
        return { data: fn === 'menu_import_claim_page' ? true : {}, error: null };
      });

      await readMenuPage(IMPORT_ID, 1);

      expect(extractPage).toHaveBeenCalledWith(
        expect.objectContaining({ deadlineMs: PAGE_DEADLINE_MS - 12_000 }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('records a photo that timed out as one to read again, without calling the reader', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(AbortSignal.abort());
    db.download.mockResolvedValue({ data: null, error: new Error('The operation was aborted') });

    await readMenuPage(IMPORT_ID, 1);

    expect(timeout).toHaveBeenCalledWith(15_000);
    expect(db.download).toHaveBeenCalledWith(
      'r1/i1/1.jpg',
      {},
      { signal: expect.any(AbortSignal) },
    );
    expect(extractPage).not.toHaveBeenCalled();
    expect(recorded()).toMatchObject({ index: 1, status: 'failed', error: READER_UNAVAILABLE });
  });

  it('records a photo cut off after Storage answered as one to read again, too', async () => {
    // storage-js returns an abort that lands before the headers, but throws one that lands while
    // the body is read: the page must not stay claimed until the lease runs out.
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(AbortSignal.abort());
    db.download.mockRejectedValue(
      new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
    );

    await expect(readMenuPage(IMPORT_ID, 1)).resolves.toMatchObject({ ok: true });

    expect(extractPage).not.toHaveBeenCalled();
    expect(recorded()).toMatchObject({ index: 1, status: 'failed', error: READER_UNAVAILABLE });
  });

  it('does the same when the connection drops while the photo downloads', async () => {
    // undici's error for a reset mid-body: the timer has not fired, and the photo is there.
    db.download.mockRejectedValue(new TypeError('terminated'));

    await expect(readMenuPage(IMPORT_ID, 1)).resolves.toMatchObject({ ok: true });

    expect(extractPage).not.toHaveBeenCalled();
    expect(recorded()).toMatchObject({ index: 1, status: 'failed', error: READER_UNAVAILABLE });
  });

  it('tells the owner to start again when the photo is not there', async () => {
    db.download.mockResolvedValue({ data: null, error: new Error('Object not found') });

    await readMenuPage(IMPORT_ID, 1);

    expect(extractPage).not.toHaveBeenCalled();
    expect(recorded()).toMatchObject({
      status: 'failed',
      error: 'The photo of this page did not upload. Start a new import with this page.',
    });
  });
});
