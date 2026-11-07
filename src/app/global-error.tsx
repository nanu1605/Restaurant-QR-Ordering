'use client';

import type { ErrorInfo } from 'next/error';
import { useSyncExternalStore } from 'react';

import { ErrorFallback } from '@/features/new-version/components/error-fallback';
import { usePageLang } from '@/features/new-version/notice';
import { parseTheme, type Theme } from '@/features/theme/theme';

import { notoSans } from './fonts';
import './globals.css';

const unchanging = () => () => {};

/**
 * The root layout itself failed (docs/DECISIONS.md VPS-9). This replaces it, so it brings its
 * own <html>, styles and font, and the language and theme of the page it replaced (English and
 * the device's theme when rendered on the server). Next.js takes no metadata here, and the
 * toasts are gone with the layout: the card is the message.
 */
export default function GlobalError({ error, retry }: ErrorInfo) {
  const lang = usePageLang();
  const theme = useSyncExternalStore<Theme>(
    unchanging,
    () => parseTheme(document.documentElement.dataset.theme),
    () => 'system',
  );
  return (
    <html lang={lang} data-theme={theme} className={`${notoSans.variable} h-full`}>
      <body className="flex min-h-full flex-col">
        <ErrorFallback error={error} retry={retry} lang={lang} surface="page" />
      </body>
    </html>
  );
}
