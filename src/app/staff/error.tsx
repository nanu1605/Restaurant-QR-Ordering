'use client';

import type { ErrorInfo } from 'next/error';

import { ErrorFallback } from '@/features/new-version/components/error-fallback';
import { useStaffLang } from '@/features/orders/staff-lang';

/**
 * The worker panel's pages, in the login's language (docs/DECISIONS.md VPS-9). The layout stays
 * around them, header, nav, live status and offline banner, so staff can still switch screens.
 */
export default function StaffError({ error, retry }: ErrorInfo) {
  const lang = useStaffLang();
  return <ErrorFallback error={error} retry={retry} lang={lang} surface="panel" />;
}
