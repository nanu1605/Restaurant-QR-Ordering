'use client';

import { Copy } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';

/** Copies a value such as a Razorpay payment ID. */
export function CopyButton({ value, label }: { value: string; label: string }) {
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      toast.success('Copied');
    } catch {
      toast.error("Couldn't copy. Select it and copy it instead.");
    }
  }
  return (
    <Button type="button" variant="ghost" size="icon-sm" onClick={copy} aria-label={label}>
      <Copy aria-hidden />
    </Button>
  );
}
