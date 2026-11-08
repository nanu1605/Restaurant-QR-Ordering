// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { finishReading, readMenuPage } from '@/features/menu-import/actions';
import { ImportProgress } from '@/features/menu-import/components/import-progress';

// The reading loop when a page's photo did not arrive, or the menu reader did not answer: the
// action answers with an error, the loop stops on it, and Try again reads that page once more
// (docs/DECISIONS.md VPS-5).

const IMPORT_ID = '123e4567-e89b-42d3-a456-426614174000';
const NOT_FETCHED =
  'The photo of this page could not be fetched. Try again. If you leave instead, the import goes on without this page when you open it again.';
const READER_STOPPED =
  'The menu reader is not answering right now. Try this page again in a few minutes. If you leave instead, the import goes on without this page when you open it again.';
const CARRIES_ON = /coming back later carries on from here/;

const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('@/features/menu-import/actions', () => ({
  finishReading: vi.fn(),
  readMenuPage: vi.fn(),
}));

/** The pages the loop read, in order. */
const pagesRead = () => vi.mocked(readMenuPage).mock.calls.map(([, page]) => page);

describe('ImportProgress', () => {
  it('stops at a photo that did not arrive, and Try again reads that page before finishing', async () => {
    vi.mocked(readMenuPage)
      .mockResolvedValueOnce({ ok: true, data: { total: 3, done: 1, failed: 0 } })
      .mockResolvedValueOnce({ ok: false, error: NOT_FETCHED });
    const view = render(
      <ImportProgress
        importId={IMPORT_ID}
        pages={[
          { index: 1, status: 'pending' },
          { index: 2, status: 'pending' },
          { index: 3, status: 'pending' },
        ]}
      />,
    );

    // While it reads, leaving and coming back carries on.
    expect(screen.getByText(CARRIES_ON)).toBeInTheDocument();
    expect(await screen.findByRole('alert')).toHaveTextContent(NOT_FETCHED);
    expect(screen.getByRole('status')).toHaveTextContent('Reading stopped.');
    // Stopped, it no longer says so: coming back would skip the failed page.
    expect(screen.queryByText(CARRIES_ON)).toBeNull();
    // Neither the page after it nor the end of the reading: the import is still open.
    expect(pagesRead()).toEqual([1, 2]);
    expect(finishReading).not.toHaveBeenCalled();

    // The page as Try again's refresh brings it: the second one is what the server recorded as failed.
    const refreshed = [
      { index: 1, status: 'done' as const },
      { index: 2, status: 'failed' as const },
      { index: 3, status: 'pending' as const },
    ];
    router.refresh.mockImplementationOnce(() =>
      view.rerender(<ImportProgress importId={IMPORT_ID} pages={refreshed} />),
    );
    vi.mocked(readMenuPage).mockClear();
    vi.mocked(readMenuPage).mockResolvedValue({ ok: true, data: { total: 3, done: 3, failed: 0 } });
    vi.mocked(finishReading).mockResolvedValue({ ok: true, data: { status: 'review' } });
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    await waitFor(() => expect(finishReading).toHaveBeenCalledWith(IMPORT_ID));
    expect(pagesRead()).toEqual([2, 3]);
    // Then the page reloads into the review: once for Try again, once for the finished reading.
    await waitFor(() => expect(router.refresh).toHaveBeenCalledTimes(2));
  });

  it('stops when the menu reader does not answer, and Try again reads that page again before finishing', async () => {
    vi.mocked(readMenuPage)
      .mockResolvedValueOnce({ ok: true, data: { total: 2, done: 1, failed: 0 } })
      .mockResolvedValueOnce({ ok: false, error: READER_STOPPED });
    const view = render(
      <ImportProgress
        importId={IMPORT_ID}
        pages={[
          { index: 1, status: 'pending' },
          { index: 2, status: 'pending' },
        ]}
      />,
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(READER_STOPPED);
    expect(screen.getByRole('status')).toHaveTextContent('Reading stopped.');
    // Stopped, it no longer says coming back carries on: that would skip the failed page.
    expect(screen.queryByText(CARRIES_ON)).toBeNull();
    // The reading did not go on to the end: the import is still open.
    expect(pagesRead()).toEqual([1, 2]);
    expect(finishReading).not.toHaveBeenCalled();

    // The page as Try again's refresh brings it: the second one is what the server recorded as failed.
    const refreshed = [
      { index: 1, status: 'done' as const },
      { index: 2, status: 'failed' as const },
    ];
    router.refresh.mockImplementationOnce(() =>
      view.rerender(<ImportProgress importId={IMPORT_ID} pages={refreshed} />),
    );
    vi.mocked(readMenuPage).mockClear();
    // The reader still does not answer. The page had already failed, so the action answers ok:
    // it is left out, and the reading goes on to its end.
    vi.mocked(readMenuPage).mockResolvedValue({ ok: true, data: { total: 2, done: 1, failed: 1 } });
    vi.mocked(finishReading).mockResolvedValue({ ok: true, data: { status: 'review' } });
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    await waitFor(() => expect(finishReading).toHaveBeenCalledWith(IMPORT_ID));
    expect(pagesRead()).toEqual([2]);
    // Then the page reloads into the review: once for Try again, once for the finished reading.
    await waitFor(() => expect(router.refresh).toHaveBeenCalledTimes(2));
  });

  it('leaves a page the server recorded as failed alone until Try again is pressed', async () => {
    // What a reload shows: the failed page is not read again by itself, and the reading ends.
    vi.mocked(finishReading).mockResolvedValue({ ok: true, data: { status: 'review' } });
    render(
      <ImportProgress
        importId={IMPORT_ID}
        pages={[
          { index: 1, status: 'done' },
          { index: 2, status: 'failed' },
        ]}
      />,
    );

    await waitFor(() => expect(finishReading).toHaveBeenCalledWith(IMPORT_ID));
    expect(readMenuPage).not.toHaveBeenCalled();
  });
});
