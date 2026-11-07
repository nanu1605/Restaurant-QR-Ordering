'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useTransition } from 'react';
import { toast } from 'sonner';

import { Button, buttonVariants } from '@/components/ui/button';
import { CopyButton } from '@/features/platform/components/copy-button';
import type { ActionResult } from '@/lib/action-result';

import type { DataExport } from '../closure';

const POLL_MS = 4000;

// When this tab first had each link, by a clock that only counts up: Back and
// Forward bring a page back with its old count of seconds left.
const linkSeen = new Map<string, number>();

const STATUS: Record<DataExport['state'], { text: string; className: string }> = {
  none: { text: '', className: 'sr-only' },
  building: {
    text: 'Preparing the download. This can take a few minutes; you can leave this page and come back.',
    className: 'text-sm text-ink',
  },
  ready: { text: 'The download is ready.', className: 'sr-only' },
  failed: {
    text: 'The last download couldn’t be prepared. Try again.',
    className: 'text-sm font-medium text-destructive',
  },
  expired: { text: 'The last link has ended.', className: 'text-sm text-ink-muted' },
};

/**
 * Asks for a data export, follows its build and hands over the link
 * (docs/DECISIONS.md SA-93). In the owner's Settings and on the team's Account
 * tab; the team can also copy the link, to send to an owner who can't log in.
 */
export function DataExportCard({
  title,
  dataExport,
  request,
  shareable = false,
}: {
  title: string;
  dataExport: DataExport;
  request: () => Promise<ActionResult>;
  shareable?: boolean;
}) {
  const router = useRouter();
  const ids = useId();
  const [pending, startTransition] = useTransition();
  const heading = useRef<HTMLHeadingElement>(null);
  const shown = useRef(dataExport.state);
  const pressed = useRef(false);
  const { state } = dataExport;
  const link = dataExport.state === 'ready' ? dataExport.url : null;
  const secondsLeft = dataExport.state === 'ready' ? dataExport.secondsLeft : null;

  useEffect(() => {
    if (state !== 'building') return;
    const timer = setInterval(() => router.refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [state, router]);

  // A page left open past the link's end stops offering it. Timed by the
  // server's count, not the device's clock; each refresh brings a new link.
  useEffect(() => {
    if (link === null || secondsLeft === null) return;
    const seen = linkSeen.get(link) ?? performance.now();
    linkSeen.set(link, seen);
    const wait = seen + secondsLeft * 1000 - performance.now();
    const timer = setTimeout(() => router.refresh(), Math.max(0, wait));
    return () => clearTimeout(timer);
  }, [link, secondsLeft, router]);

  // The button just pressed can be gone: keep a keyboard user in this card.
  // Only after a press here, so a build ending on its own leaves the page be.
  useEffect(() => {
    if (shown.current === state) return;
    shown.current = state;
    if (pressed.current && document.activeElement === document.body) heading.current?.focus();
    pressed.current = false;
  }, [state]);

  function ask() {
    pressed.current = true;
    startTransition(async () => {
      const result = await request();
      if (result.ok) return;
      pressed.current = false;
      toast.error(result.error);
    });
  }

  return (
    <section
      aria-labelledby={`${ids}-title`}
      className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-4 md:p-6"
    >
      <div className="flex flex-col gap-1">
        <h2
          ref={heading}
          id={`${ids}-title`}
          tabIndex={-1}
          className="text-base font-semibold text-ink outline-none"
        >
          {title}
        </h2>
        <p className="max-w-prose text-sm text-ink-muted">
          A ZIP of the restaurant’s details, menu, tables, staff, waiters, orders, bills and
          payments, as JSON and CSV files. Passwords aren’t in it. One an hour; the link works for
          24 hours.
        </p>
      </div>

      {/* Always there, so a screen reader hears each change. */}
      <p role="status" className={STATUS[state].className}>
        {STATUS[state].text}
      </p>

      {dataExport.state === 'ready' && (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <a href={dataExport.url} rel="noreferrer" className={buttonVariants({ size: 'touch' })}>
              Download ZIP ({dataExport.size})
            </a>
            {shareable && <CopyButton value={dataExport.url} label="Copy the download link" />}
            <Button variant="outline" size="touch" onClick={ask} disabled={pending}>
              {pending ? 'Starting…' : 'Prepare a new one'}
            </Button>
          </div>
          <p className="text-sm text-ink-muted">
            Works until {dataExport.until}. Anyone with the link can open it, so share it only with
            the restaurant’s owner.
          </p>
        </div>
      )}
      {state !== 'ready' && state !== 'building' && (
        <div>
          <Button size="touch" onClick={ask} disabled={pending}>
            {pending ? 'Starting…' : 'Prepare a download'}
          </Button>
        </div>
      )}
    </section>
  );
}
