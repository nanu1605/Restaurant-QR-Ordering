import { createClient, StorageApiError } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { readMenuPage } from '@/features/menu-import/actions';
import {
  extractPage,
  PAGE_DEADLINE_MS,
  READER_UNAVAILABLE,
  type PageOutcome,
} from '@/features/menu-import/extract';

// Reading one page in its server action: its time counts from the action's start, and a photo
// that did not arrive stops the reading, so that Try again reads the page once more
// (docs/DECISIONS.md P7-15, VPS-5).

const IMPORT_ID = '123e4567-e89b-42d3-a456-426614174000';

const NOT_FETCHED =
  'The photo of this page could not be fetched. Try again. If you leave instead, the import goes on without this page when you open it again.';
/** The same where no other page can still give dishes, as in this file's one-page import. */
const NOT_FETCHED_ONLY_PAGE =
  'The photo of this page could not be fetched. Try again. If you leave instead, the import fails when you open it again, and you will need to start a new one.';
const NOT_UPLOADED = 'The photo of this page did not upload. Start a new import with this page.';

const db = vi.hoisted(() => ({
  rpc: vi.fn(),
  download: vi.fn(),
  // The import's pages as the caller reads them: one, unless a case sets more.
  pages: [] as { index: number; status: string }[],
}));
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
              file_paths: db.pages.map((page) => `r1/i1/${page.index}.jpg`),
              pages: db.pages,
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

/** What Storage's own API answers for a missing object: 400, with the 404 in its body. */
const notThere = () => new StorageApiError('Object not found', 400, '404', 'storage', 'NoSuchKey');

beforeEach(() => {
  db.pages = [{ index: 1, status: 'pending' }];
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

  it('records a photo that timed out as one to read again, and stops the reading', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(AbortSignal.abort());
    db.download.mockResolvedValue({ data: null, error: new Error('The operation was aborted') });

    // Not ok: the progress loop stops on it, and Try again reads the failed page once more.
    await expect(readMenuPage(IMPORT_ID, 1)).resolves.toMatchObject({
      ok: false,
      error: NOT_FETCHED_ONLY_PAGE,
    });

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

    await expect(readMenuPage(IMPORT_ID, 1)).resolves.toMatchObject({
      ok: false,
      error: NOT_FETCHED_ONLY_PAGE,
    });

    expect(extractPage).not.toHaveBeenCalled();
    expect(recorded()).toMatchObject({ index: 1, status: 'failed', error: READER_UNAVAILABLE });
  });

  it('does the same when the connection drops while the photo downloads', async () => {
    // undici's error for a reset mid-body: the timer has not fired, and the photo is there.
    db.download.mockRejectedValue(new TypeError('terminated'));

    await expect(readMenuPage(IMPORT_ID, 1)).resolves.toMatchObject({
      ok: false,
      error: NOT_FETCHED_ONLY_PAGE,
    });

    expect(extractPage).not.toHaveBeenCalled();
    expect(recorded()).toMatchObject({ index: 1, status: 'failed', error: READER_UNAVAILABLE });
  });

  it('does the same when Storage cannot answer before the headers, the timer not fired', async () => {
    // The storage service restarting behind the gateway: storage-js returns the failure, and the
    // photo is still in Storage.
    db.download.mockResolvedValue({
      data: null,
      error: new StorageApiError('Service Unavailable', 503, '503'),
    });

    await expect(readMenuPage(IMPORT_ID, 1)).resolves.toMatchObject({
      ok: false,
      error: NOT_FETCHED_ONLY_PAGE,
    });

    expect(extractPage).not.toHaveBeenCalled();
    expect(recorded()).toMatchObject({ index: 1, status: 'failed', error: READER_UNAVAILABLE });
  });

  it('says the import goes on without the page when another page can still give dishes', async () => {
    db.pages = [
      { index: 1, status: 'pending' },
      { index: 2, status: 'pending' },
    ];
    db.download.mockResolvedValue({ data: null, error: new Error('Gateway Timeout') });

    await expect(readMenuPage(IMPORT_ID, 1)).resolves.toMatchObject({
      ok: false,
      error: NOT_FETCHED,
    });
  });

  it('says the import fails when every other page has failed', async () => {
    // Opening the import again would finish it with no page to give dishes.
    db.pages = [
      { index: 1, status: 'pending' },
      { index: 2, status: 'failed' },
    ];
    db.download.mockResolvedValue({ data: null, error: new Error('Gateway Timeout') });

    await expect(readMenuPage(IMPORT_ID, 1)).resolves.toMatchObject({
      ok: false,
      error: NOT_FETCHED_ONLY_PAGE,
    });
  });

  it('tells the owner to start again when the photo is not there', async () => {
    db.download.mockResolvedValue({ data: null, error: notThere() });

    // Ok: reading it again would find nothing, so the reading goes on without the page.
    await expect(readMenuPage(IMPORT_ID, 1)).resolves.toMatchObject({ ok: true });

    expect(extractPage).not.toHaveBeenCalled();
    expect(recorded()).toMatchObject({ status: 'failed', error: NOT_UPLOADED });
  });

  it('does not ask to try again when the import was closed while the photo was fetched', async () => {
    db.download.mockRejectedValue(new TypeError('terminated'));
    db.rpc.mockImplementation(async (fn: string) =>
      fn === 'menu_import_record_page'
        ? { data: null, error: { code: 'P0001', message: 'IMPORT_NOT_OPEN', details: null } }
        : { data: true, error: null },
    );

    await expect(readMenuPage(IMPORT_ID, 1)).resolves.toMatchObject({ ok: true });
  });
});

describe('readMenuPage with storage-js between it and Storage', () => {
  // The real client over a canned network, so each failure is the one storage-js builds. A new
  // version that shapes one differently shows up here, not as owners told to fetch a missing
  // photo again for good, or to start over for one that was only out of reach (VPS-5).
  it.each([
    {
      name: 'a missing object (400, with the 404 in its body) is lost for good',
      answer: async () =>
        Response.json(
          { statusCode: '404', error: 'not_found', message: 'Object not found', code: 'NoSuchKey' },
          { status: 400 },
        ),
      lost: true,
    },
    {
      name: 'a 404 whose body names a code and no statusCode is lost for good',
      answer: async () =>
        Response.json({ code: 'NoSuchKey', message: 'Object not found' }, { status: 404 }),
      lost: true,
    },
    {
      name: 'a 404 from a proxy is lost for good',
      answer: async () => new Response('<html>Not Found</html>', { status: 404 }),
      lost: true,
    },
    {
      name: 'a 503 from the gateway is worth another try',
      answer: async () =>
        new Response('upstream connect error or disconnect/reset before headers', { status: 503 }),
      lost: false,
    },
    {
      name: 'a refused connection is worth another try',
      answer: async () => {
        throw new TypeError('fetch failed');
      },
      lost: false,
    },
    {
      name: 'a body cut off after the headers is worth another try',
      answer: async () =>
        new Response(
          new ReadableStream({
            pull: (controller) => controller.error(new TypeError('terminated')),
          }),
        ),
      lost: false,
    },
  ])('$name', async ({ answer, lost }) => {
    const bucket = createClient('http://storage.test', 'key', {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: answer },
    }).storage.from('menu-imports');
    db.download.mockImplementation((...args: Parameters<typeof bucket.download>) =>
      bucket.download(...args),
    );

    const result = await readMenuPage(IMPORT_ID, 1);

    expect(extractPage).not.toHaveBeenCalled();
    if (lost) {
      expect(result).toMatchObject({ ok: true });
      expect(recorded()).toMatchObject({ status: 'failed', error: NOT_UPLOADED });
    } else {
      expect(result).toMatchObject({ ok: false, error: NOT_FETCHED_ONLY_PAGE });
      expect(recorded()).toMatchObject({ status: 'failed', error: READER_UNAVAILABLE });
    }
  });
});
