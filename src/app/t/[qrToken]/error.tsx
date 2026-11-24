'use client';

import type { ErrorInfo } from 'next/error';

import { ErrorFallback } from '@/features/new-version/components/error-fallback';
import { useLang } from '@/features/ordering/components/lang-provider';

/**
 * The guest's menu, cart and orders pages, in the phone's language (docs/DECISIONS.md VPS-9).
 * The layout stays around them: the restaurant's header, the language switch and Call waiter.
 * A QR code that doesn't work still gets t/not-found.tsx.
 */
export default function CustomerError({ error, retry }: ErrorInfo) {
  const lang = useLang();
  return <ErrorFallback error={error} retry={retry} lang={lang} surface="customer" />;
}
