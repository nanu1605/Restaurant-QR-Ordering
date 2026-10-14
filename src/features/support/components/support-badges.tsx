import { cn } from 'cn';
import {
  ArrowDown,
  ArrowUp,
  CircleCheck,
  CircleDot,
  Hourglass,
  LoaderCircle,
  Minus,
  type LucideIcon,
} from 'lucide-react';

import {
  SUPPORT_PRIORITY_LABELS,
  SUPPORT_STATUS_LABELS,
  type SupportPriority,
  type SupportStatus,
} from '../support';

const BADGE =
  'inline-flex h-6 w-fit items-center gap-1 rounded-md border px-2 text-xs font-semibold whitespace-nowrap';

const STATUS_STYLES: Record<SupportStatus, { icon: LucideIcon; className: string }> = {
  open: {
    icon: CircleDot,
    className: 'bg-status-placed-fill text-status-placed-foreground border-transparent',
  },
  in_progress: {
    icon: LoaderCircle,
    className: 'bg-status-preparing-fill text-status-preparing-foreground border-transparent',
  },
  waiting: { icon: Hourglass, className: 'bg-surface text-ink border-line' },
  resolved: {
    icon: CircleCheck,
    className: 'bg-status-served-fill text-status-served-foreground border-transparent',
  },
};

/** A request's status, icon and words; the restaurant sees its own words for it. */
export function SupportStatusBadge({
  status,
  labels = SUPPORT_STATUS_LABELS,
}: {
  status: SupportStatus;
  labels?: Record<SupportStatus, string>;
}) {
  const { icon: Icon, className } = STATUS_STYLES[status];
  return (
    <span data-status={status} className={cn(BADGE, className)}>
      <Icon aria-hidden className="size-3.5 shrink-0" strokeWidth={2.5} />
      {labels[status]}
    </span>
  );
}

const PRIORITY_STYLES: Record<SupportPriority, { icon: LucideIcon; className: string }> = {
  high: {
    icon: ArrowUp,
    className: 'bg-sub-payment-failed-fill text-sub-payment-failed-foreground border-transparent',
  },
  normal: { icon: Minus, className: 'bg-surface text-ink border-line' },
  low: { icon: ArrowDown, className: 'bg-surface text-ink-muted border-line' },
};

export function PriorityBadge({ priority }: { priority: SupportPriority }) {
  const { icon: Icon, className } = PRIORITY_STYLES[priority];
  return (
    <span data-priority={priority} className={cn(BADGE, className)}>
      <Icon aria-hidden className="size-3.5 shrink-0" strokeWidth={2.5} />
      {SUPPORT_PRIORITY_LABELS[priority]}
    </span>
  );
}
