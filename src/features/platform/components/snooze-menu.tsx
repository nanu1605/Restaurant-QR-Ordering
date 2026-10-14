'use client';

import { AlarmClock } from 'lucide-react';
import { useTransition } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

import { snoozeAttention } from '../actions';
import { SNOOZE_DAYS, type SnoozeDays } from '../home';

const LABELS: Record<SnoozeDays, string> = { 1: '1 day', 3: '3 days', 7: '1 week' };

/** Puts one Needs attention item aside for this admin (docs/DECISIONS.md SA-28). */
export function SnoozeMenu({ itemKey, label }: { itemKey: string; label: string }) {
  const [pending, startTransition] = useTransition();

  function snooze(days: SnoozeDays) {
    startTransition(async () => {
      const result = await snoozeAttention(itemKey, days);
      if (result.ok) toast.success(`Snoozed for ${LABELS[days]}`);
      else toast.error(result.error);
    });
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            className="h-11 md:h-8"
            disabled={pending}
            aria-label={`Snooze ${label}`}
          />
        }
      >
        <AlarmClock aria-hidden />
        Snooze
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {SNOOZE_DAYS.map((days) => (
          <DropdownMenuItem key={days} className="min-h-11 px-2" onClick={() => snooze(days)}>
            For {LABELS[days]}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
