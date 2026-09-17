import { cn } from 'cn';
import { Circle, CircleCheck, CircleDashed, Hand, Timer, type LucideIcon } from 'lucide-react';

import { TABLE_STATE_LABELS, type TableState } from '../board-view';

const STATE_STYLES: Record<TableState, { icon: LucideIcon; className: string }> = {
  // The one pulsing element on the board (spec §16.2 Motion).
  needs_approval: {
    icon: Hand,
    className:
      'bg-attention text-attention-foreground border-transparent motion-safe:animate-pulse',
  },
  in_progress: { icon: Timer, className: 'bg-surface text-ink border-line' },
  all_served: {
    icon: CircleCheck,
    className: 'bg-status-served-fill text-status-served-foreground border-transparent',
  },
  idle: { icon: CircleDashed, className: 'bg-surface text-ink-muted border-line' },
  free: { icon: Circle, className: 'bg-paper text-ink-muted border-line' },
};

/** Table state as icon + label; colour is never the only signal (spec §10.4). */
export function TableStateBadge({ state, className }: { state: TableState; className?: string }) {
  const { icon: Icon, className: stateClassName } = STATE_STYLES[state];
  return (
    <span
      data-state={state}
      className={cn(
        'inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-sm font-semibold whitespace-nowrap',
        stateClassName,
        className,
      )}
    >
      <Icon aria-hidden className="size-4 shrink-0" strokeWidth={2.25} />
      {TABLE_STATE_LABELS[state]}
    </span>
  );
}
