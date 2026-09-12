import { cn } from 'cn';
import {
  BellRing,
  CircleCheck,
  CircleX,
  Clock3,
  Flame,
  Trash2,
  type LucideIcon,
} from 'lucide-react';

import { ORDER_ITEM_STATUS_LABELS, type OrderItemStatus } from '@/lib/order-status';

const STATUS_STYLES: Record<OrderItemStatus, { icon: LucideIcon; className: string }> = {
  placed: {
    icon: Clock3,
    className: 'bg-status-placed-fill text-status-placed-foreground border-transparent',
  },
  preparing: {
    icon: Flame,
    className: 'bg-status-preparing-fill text-status-preparing-foreground border-transparent',
  },
  ready: {
    icon: BellRing,
    className: 'bg-status-ready-fill text-status-ready-foreground border-transparent',
  },
  served: {
    icon: CircleCheck,
    className: 'bg-status-served-fill text-status-served-foreground border-transparent',
  },
  // Void states are muted outlines; the item name itself is struck through.
  cancelled: {
    icon: CircleX,
    className: 'bg-surface text-status-void border-status-void',
  },
  removed: {
    icon: Trash2,
    className: 'bg-surface text-status-void border-status-void',
  },
};

type StatusChipProps = {
  status: OrderItemStatus;
  /** Overrides the staff wording, e.g. "Placed" instead of "New" for customers. */
  label?: string;
  className?: string;
};

/** Item status as colour fill + icon + label — colour is never the only signal. */
export function StatusChip({ status, label, className }: StatusChipProps) {
  const { icon: Icon, className: statusClassName } = STATUS_STYLES[status];

  return (
    <span
      data-status={status}
      className={cn(
        'inline-flex h-6 items-center gap-1 rounded-md border px-2 text-xs font-semibold whitespace-nowrap',
        statusClassName,
        className,
      )}
    >
      <Icon aria-hidden className="size-3.5 shrink-0" strokeWidth={2.5} />
      {label ?? ORDER_ITEM_STATUS_LABELS[status]}
    </span>
  );
}
