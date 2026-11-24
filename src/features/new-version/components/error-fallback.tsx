'use client';

import { cn } from 'cn';
import { type LucideIcon, RefreshCw, TriangleAlert } from 'lucide-react';
import type { ErrorInfo } from 'next/error';
import { type ReactNode, useEffect, useRef } from 'react';

import { EmptyState } from '@/components/shared/empty-state';
import { Button } from '@/components/ui/button';
import type { Lang } from '@/features/ordering/strings';

import { newVersionFound, refreshNow, useNewVersionNotice } from '../notice';
import { staleCause } from '../stale';
import { NEW_VERSION_STRINGS } from '../strings';

type ErrorFallbackProps = Pick<ErrorInfo, 'error' | 'retry'> & {
  lang: Lang;
  /**
   * A whole page in not-found's layout, with an <h1> that takes focus; the same inside the
   * customer layout's 560 px column; or a card inside a panel's own <main>.
   */
  surface: 'page' | 'customer' | 'panel';
};

/**
 * What every error boundary shows (docs/DECISIONS.md VPS-9). A page from an older build
 * refreshes, or offers Refresh once it can't; anything else offers Try again and Refresh, with
 * a server error's code for support.
 */
export function ErrorFallback({ error, retry, lang, surface }: ErrorFallbackProps) {
  const t = NEW_VERSION_STRINGS[lang];
  const cause = staleCause(error);
  const { notice } = useNewVersionNotice();
  const digest =
    error instanceof Error && 'digest' in error && typeof error.digest === 'string'
      ? error.digest
      : null;
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (cause) newVersionFound('boundary', cause);
    // In production Next.js only logs what an explicit boundary catches, so report the rest
    // as its own boundary did, for Sentry. An older build's action is the refresh's to handle,
    // and a server error (with a digest) is reported by onRequestError. Development shows it
    // in the overlay already.
    if (cause === 'version' || digest || process.env.NODE_ENV !== 'production') return;
    if (typeof reportError === 'function') reportError(error);
  }, [error, cause, digest]);

  useEffect(() => {
    heading.current?.focus();
  }, []);

  let icon: LucideIcon = TriangleAlert;
  let title = t.error.title;
  let description: string | undefined = t.error.description;
  let actions: ReactNode = (
    <div className="flex flex-wrap justify-center gap-3">
      <Button size="touch" onClick={() => retry()}>
        {t.error.retry}
      </Button>
      <Button size="touch" variant="outline" onClick={refreshNow}>
        {t.refresh}
      </Button>
    </div>
  );
  if (cause) {
    const words = cause === 'chunk' ? t.chunk : t.stuck;
    const stuck = notice === 'stuck';
    icon = RefreshCw;
    // Until it is stuck, "Refreshing…": also before the report above is decided, so no error
    // flashes on a page that is about to go.
    title = stuck ? words.title : cause === 'chunk' ? t.chunk.refreshing : t.refreshing;
    description = stuck ? words.description : undefined;
    actions = stuck && (
      <Button size="touch" onClick={refreshNow}>
        {t.refresh}
      </Button>
    );
  }
  const code = digest && <p className="text-xs text-ink-muted">{t.error.code(digest)}</p>;

  if (surface === 'panel') {
    return (
      <div role={cause ? 'status' : 'alert'} className="my-auto flex flex-col items-center gap-2">
        <EmptyState
          icon={icon}
          title={title}
          description={description}
          action={actions}
          className="w-full"
        />
        {code}
      </div>
    );
  }
  const Icon = icon;
  const page = surface === 'page';
  return (
    <main
      className={cn(
        'flex flex-1 flex-col items-center justify-center gap-4 px-6 py-16 text-center',
        page && 'mx-auto w-full max-w-md',
      )}
    >
      <Icon aria-hidden className="size-12 text-ink-muted" strokeWidth={1.5} />
      <h1
        ref={heading}
        tabIndex={-1}
        className={cn('font-semibold text-ink outline-none', page ? 'text-2xl' : 'text-xl')}
      >
        {title}
      </h1>
      {description && <p className="max-w-sm text-base text-ink-muted">{description}</p>}
      {actions}
      {code}
    </main>
  );
}
