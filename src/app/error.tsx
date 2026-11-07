'use client';

import type { ErrorInfo } from 'next/error';

import { ErrorFallback } from '@/features/new-version/components/error-fallback';
import { usePageLang } from '@/features/new-version/notice';

/**
 * Anything below the root layout that no closer boundary takes: the website, login, the admin
 * and super panels, and the panels' own layouts (docs/DECISIONS.md VPS-9). The root layout
 * stays, with its toasts, theme and font.
 */
export default function AppError({ error, retry }: ErrorInfo) {
  const lang = usePageLang();
  return <ErrorFallback error={error} retry={retry} lang={lang} surface="page" />;
}
