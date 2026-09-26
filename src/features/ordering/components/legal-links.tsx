'use client';

import { cn } from 'cn';
import Link from 'next/link';

import { useStrings } from './lang-provider';

/** Terms and privacy in small print (docs/DECISIONS.md P10-5), in the customer's language. */
export function LegalLinks({ className }: { className?: string }) {
  const { legal } = useStrings();
  const link = 'inline-flex min-h-6 items-center px-1 underline underline-offset-4';
  return (
    <p className={cn('flex justify-center gap-2 text-xs text-ink-muted', className)}>
      <Link href="/terms" className={link}>
        {legal.terms}
      </Link>
      <span aria-hidden className="self-center">
        ·
      </span>
      <Link href="/privacy" className={link}>
        {legal.privacy}
      </Link>
    </p>
  );
}
