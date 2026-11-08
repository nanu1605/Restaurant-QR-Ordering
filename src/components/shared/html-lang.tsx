'use client';

import { useEffect } from 'react';

import type { Lang } from '@/features/ordering/strings';

/**
 * Puts <html lang> on `lang` once it mounts. A client-side move keeps the language of the first
 * page's HTML, and the worker panel leaves its Hindi on while an error page replaces it
 * (docs/DECISIONS.md VPS-12), so the panels that are always English say so themselves. The
 * website has its own, beside its language switch, so that the panels don't carry its code.
 */
export function HtmlLang({ lang }: { lang: Lang }) {
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);
  return null;
}
