'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { isUnrecognizedAction } from '@/features/new-version/stale';

import { finishReading, readMenuPage } from '../actions';

type PageState = { index: number; status: 'pending' | 'reading' | 'done' | 'failed' };

/**
 * Reads the pages one request at a time (spec §20A.1 step 2), showing
 * "Reading page 2 of 4…". Pages already read are skipped, so a reload picks
 * up where it stopped. When every page is done or failed, the draft is built
 * and the page reloads into the review.
 */
export function ImportProgress({ importId, pages }: { importId: string; pages: PageState[] }) {
  const router = useRouter();
  const [current, setCurrent] = useState<number | null>(null);
  const waiting = (page: PageState) => page.status === 'pending' || page.status === 'reading';
  const [done, setDone] = useState(pages.filter((page) => !waiting(page)).length);
  const [error, setError] = useState<string | null>(null);
  // Bumped by "Try again", which also re-reads the pages that failed.
  const [attempt, setAttempt] = useState(0);
  const retry = attempt > 0;
  const running = useRef(false);

  // One reading loop at a time. It is not cancelled on unmount: each step is
  // safe to repeat on the server, and a remount (Strict Mode) must not stop it.
  useEffect(() => {
    if (running.current) return;
    running.current = true;

    (async () => {
      setError(null);
      for (const page of pages) {
        // A page another reader is on is claimed by the server, which returns
        // the progress without paying for a second read. Failed pages are only
        // read again when the owner presses "Try again".
        if (!waiting(page) && !(retry && page.status === 'failed')) continue;
        setCurrent(page.index);
        try {
          const result = await readMenuPage(importId, page.index);
          if (!result.ok) {
            setError(result.error);
            return;
          }
          setDone(result.data.done + result.data.failed);
        } catch (error) {
          // An older build: the refresh notice explains (docs/DECISIONS.md VPS-8), and the
          // refreshed page carries on reading.
          if (!isUnrecognizedAction(error)) {
            setError('The connection dropped while reading. Try again.');
          }
          return;
        }
      }
      setCurrent(null);
      try {
        const finished = await finishReading(importId);
        if (!finished.ok) {
          setError(finished.error);
          return;
        }
      } catch (error) {
        // As above.
        if (!isUnrecognizedAction(error)) {
          setError('The connection dropped while reading. Try again.');
        }
        return;
      }
      router.refresh();
    })().finally(() => {
      running.current = false;
    });
    // `retry` and `waiting` are derived from the values already listed here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [importId, pages, router, attempt]);

  const total = pages.length;
  return (
    <section
      aria-label="Reading the menu"
      className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4"
    >
      <p role="status" className="text-base font-medium text-ink">
        {error
          ? 'Reading stopped.'
          : current !== null
            ? `Reading page ${current} of ${total}…`
            : 'Putting the pages together…'}
      </p>
      <div
        className="h-2 w-full overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-label="Pages read"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={done}
      >
        <div
          className="h-full bg-brand transition-[width]"
          style={{ width: `${total ? (done / total) * 100 : 0}%` }}
        />
      </div>
      <p className="text-sm text-ink-muted">
        Each page takes up to a minute and a half. You can leave this page open; coming back later
        carries on from here.
      </p>
      {error && (
        <div className="flex flex-wrap items-center gap-3">
          <p role="alert" className="text-sm font-medium text-destructive">
            {error}
          </p>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              router.refresh();
              setAttempt((value) => value + 1);
            }}
          >
            Try again
          </Button>
        </div>
      )}
    </section>
  );
}
