'use client';

import { LoaderCircle } from 'lucide-react';
import { usePathname } from 'next/navigation';
import { useEffect } from 'react';

import {
  isCartPage,
  showRefreshedNotice,
  useNewVersionNotice,
  usePageLang,
  watchForNewVersion,
} from '../notice';
import { NEW_VERSION_STRINGS } from '../strings';

// Before the page hydrates, so its first server action is already watched (as sound.ts
// installs its listeners).
if (typeof window !== 'undefined') watchForNewVersion();

/**
 * The "Refreshing…" screen while a page from an older build reloads, over everything (the
 * dialogs are z-50), and the note on the page the refresh opens (docs/DECISIONS.md VPS-8).
 * In the root layout, after the Toaster.
 */
export function NewVersionNotice() {
  const { notice, cause } = useNewVersionNotice();
  const lang = usePageLang();
  const cart = isCartPage(usePathname());

  // Once per refresh: the record is marked as shown, so Strict Mode's second run does nothing.
  useEffect(() => showRefreshedNotice(), []);

  if (notice !== 'refreshing') return null;
  const t = NEW_VERSION_STRINGS[lang];
  return (
    <div role="status" className="fixed inset-0 z-60 grid place-items-center bg-paper/95 p-6">
      <div className="flex max-w-sm flex-col items-center gap-3 text-center">
        <LoaderCircle aria-hidden className="size-8 text-ink-muted motion-safe:animate-spin" />
        <p className="text-lg font-semibold text-ink">
          {cause === 'chunk' ? t.chunk.refreshing : t.refreshing}
        </p>
        {cart && <p className="text-base text-ink-muted">{t.cartSaved}</p>}
      </div>
    </div>
  );
}
