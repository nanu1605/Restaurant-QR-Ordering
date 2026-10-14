import { cn } from 'cn';
import {
  Ban,
  CircleCheck,
  CircleSlash,
  Hourglass,
  Lock,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';

import {
  ACCESS_STATE_LABELS,
  formatShortDate,
  SUBSCRIPTION_STATE_LABELS,
  SUBSCRIPTION_STATUS_LABELS,
  type SubscriptionState,
  type SubscriptionStatus,
} from '../platform';

const STATE_STYLES: Record<SubscriptionState, { icon: LucideIcon; className: string }> = {
  suspended: {
    icon: Ban,
    className: 'bg-sub-suspended-fill text-sub-suspended-foreground border-transparent',
  },
  read_only: {
    icon: Lock,
    className: 'bg-sub-read-only-fill text-sub-read-only-foreground border-transparent',
  },
  trial: {
    icon: Hourglass,
    className: 'bg-sub-trial-fill text-sub-trial-foreground border-transparent',
  },
  payment_failed: {
    icon: TriangleAlert,
    className: 'bg-sub-payment-failed-fill text-sub-payment-failed-foreground border-transparent',
  },
  paid: {
    icon: CircleCheck,
    className: 'bg-sub-paid-fill text-sub-paid-foreground border-transparent',
  },
  cancelled: { icon: CircleSlash, className: 'bg-surface text-ink-muted border-line' },
};

/**
 * A restaurant's subscription state (docs/SUPER_ADMIN_PLAN.md §5.1): colour,
 * icon and words. A paid period set to end reads "Paid, ends 13 Nov" (its
 * last day).
 */
export function SubscriptionStateBadge({
  state,
  endsAt,
}: {
  state: SubscriptionState;
  /** current_period_end of a paid period that is set to end. */
  endsAt?: string | null;
}) {
  const { icon: Icon, className } = STATE_STYLES[state];
  const label =
    state === 'paid' && endsAt
      ? `Paid, ends ${formatShortDate(new Date(new Date(endsAt).getTime() - 86_400_000).toISOString())}`
      : SUBSCRIPTION_STATE_LABELS[state];
  return (
    <span
      data-state={state}
      className={cn(
        'inline-flex h-6 w-fit items-center gap-1 rounded-md border px-2 text-xs font-semibold whitespace-nowrap',
        className,
      )}
    >
      <Icon aria-hidden className="size-3.5 shrink-0" strokeWidth={2.5} />
      {label}
    </span>
  );
}

/** Subscription status; payment problems stand out. */
export function SubscriptionBadge({ status }: { status: SubscriptionStatus | null }) {
  if (!status) return <Badge variant="outline">No subscription</Badge>;
  const problem = status === 'past_due' || status === 'halted';
  const ended = status === 'cancelled' || status === 'expired';
  return (
    <Badge variant={problem ? 'destructive' : ended ? 'outline' : 'secondary'}>
      {SUBSCRIPTION_STATUS_LABELS[status]}
    </Badge>
  );
}

/** Suspended first; otherwise whether the restaurant can take orders. */
export function AccessBadge({
  status,
  accessState,
}: {
  status: 'active' | 'suspended';
  accessState: string;
}) {
  if (status === 'suspended') return <Badge variant="destructive">Suspended</Badge>;
  return (
    <Badge variant={accessState === 'full' ? 'outline' : 'destructive'}>
      {ACCESS_STATE_LABELS[accessState] ?? accessState}
    </Badge>
  );
}
