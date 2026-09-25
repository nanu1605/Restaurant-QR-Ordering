'use client';

import { RotateCw } from 'lucide-react';
import { useTransition } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';

import { reprocessWebhook } from '../actions';

/** Runs a failed webhook again (docs/DECISIONS.md P8-11). */
export function ReprocessButton({ eventId }: { eventId: string }) {
  const [pending, startTransition] = useTransition();

  function reprocess() {
    startTransition(async () => {
      const result = await reprocessWebhook(eventId);
      if (!result.ok) toast.error(result.error);
      else if (result.data.result === 'failed') toast.error(`Still failing: ${result.data.error}`);
      else toast.success(`Reprocessed: ${result.data.result}`);
    });
  }

  return (
    <Button variant="outline" size="sm" onClick={reprocess} disabled={pending}>
      <RotateCw aria-hidden />
      {pending ? 'Reprocessing…' : 'Reprocess'}
    </Button>
  );
}
