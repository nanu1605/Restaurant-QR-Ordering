import { cn } from 'cn';
import { Info } from 'lucide-react';

import { customerErrorMessage } from '@/lib/db-errors';

const MESSAGE = customerErrorMessage({ code: 'P0001', message: 'ORDERING_UNAVAILABLE' });

/** Read-only restaurants: the menu is view-only (spec §10.6). */
export function OrderingUnavailable({ className }: { className?: string }) {
  return (
    <p
      role="status"
      className={cn(
        'flex items-start gap-2 rounded-lg border border-line bg-paper px-4 py-3 text-sm text-ink',
        className,
      )}
    >
      <Info aria-hidden className="mt-0.5 size-4 shrink-0 text-ink-muted" />
      {MESSAGE}
    </p>
  );
}
