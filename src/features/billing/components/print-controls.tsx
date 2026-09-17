'use client';

import { Printer } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef } from 'react';

import { Button, buttonVariants } from '@/components/ui/button';

import { incrementPrintCount } from '../actions';
import type { BillCopy } from './bill-document';

type PrintControlsProps = {
  /** Null for the sample bill, which isn't counted. */
  billId: string | null;
  copy: BillCopy;
  backHref: string;
  backLabel: string;
  /** Path of this page, for switching between customer and office copy. */
  selfHref: string;
};

/**
 * Opens the print dialog once when the page loads, then counts the print
 * (spec §15). The toolbar isn't printed.
 */
export function PrintControls({ billId, copy, backHref, backLabel, selfHref }: PrintControlsProps) {
  const printed = useRef(false);

  function printNow() {
    // window.print() returns once the dialog closes.
    window.print();
    if (billId) void incrementPrintCount(billId);
  }

  useEffect(() => {
    if (printed.current) return;
    printed.current = true;
    printNow();
    // Only on first load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <nav
      aria-label="Print"
      className="print-toolbar flex flex-wrap items-center justify-center gap-2 border-b border-line bg-surface p-3"
    >
      <Link href={backHref} className={buttonVariants({ variant: 'outline', size: 'touch' })}>
        {backLabel}
      </Link>
      <Link
        href={copy === 'office' ? selfHref : `${selfHref}?copy=office`}
        replace
        className={buttonVariants({ variant: 'outline', size: 'touch' })}
      >
        {copy === 'office' ? 'Customer copy' : 'Office copy'}
      </Link>
      <Button size="touch" onClick={printNow}>
        <Printer aria-hidden /> Print
      </Button>
    </nav>
  );
}
