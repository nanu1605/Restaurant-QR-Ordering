'use client';

import { Printer } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { recordQrSheetPrinted } from '@/features/tables/actions';

export function PrintButton({ tableIds }: { tableIds: string[] }) {
  function print() {
    // Sent before the print dialog opens; printing never waits for it.
    void recordQrSheetPrinted(tableIds).catch(() => {});
    window.print();
  }
  return (
    <Button size="lg" onClick={print} disabled={tableIds.length === 0}>
      <Printer aria-hidden /> Print
    </Button>
  );
}
