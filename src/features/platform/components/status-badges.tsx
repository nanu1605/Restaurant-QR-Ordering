import { cn } from 'cn';
import {
  Ban,
  CircleCheck,
  CircleDashed,
  CirclePause,
  CircleSlash,
  CircleAlert,
  DoorClosed,
  Hourglass,
  Lock,
  Sprout,
  TrendingDown,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';

import {
  ACCESS_STATE_LABELS,
  formatShortDate,
  HEALTH_LABELS,
  SUBSCRIPTION_STATE_LABELS,
  SUBSCRIPTION_STATUS_LABELS,
  type Health,
  type SubscriptionState,
  type SubscriptionStatus,
} from '../platform';

const STATE_STYLES: Record<SubscriptionState, { icon: LucideIcon; className: string }> = {
  closed: {
    icon: DoorClosed,
    className: 'bg-sub-suspended-fill text-sub-suspended-foreground border-transparent',
  },
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

const HEALTH_STYLES: Record<Health, { icon: LucideIcon; className: string }> = {
  active: {
    icon: CircleCheck,
    className: 'bg-status-served-fill text-status-served-foreground border-transparent',
  },
  slowing: {
    icon: TrendingDown,
    className: 'bg-status-preparing-fill text-status-preparing-foreground border-transparent',
  },
  inactive: {
    icon: CirclePause,
    className: 'bg-status-void-fill text-status-void-foreground border-transparent',
  },
  never_started: {
    icon: CircleDashed,
    className: 'bg-surface text-status-void border-status-void',
  },
  setting_up: { icon: Sprout, className: 'bg-surface text-ink border-line' },
};

/**
 * A restaurant's health (docs/SUPER_ADMIN_PLAN.md §5.11): icon and words, in
 * colour; muted for a restaurant that is suspended or read-only.
 */
export function HealthBadge({ health, muted = false }: { health: Health; muted?: boolean }) {
  const { icon: Icon, className } = HEALTH_STYLES[health];
  return (
    <span
      data-health={health}
      className={cn(
        'inline-flex h-6 w-fit items-center gap-1 rounded-md border px-2 text-xs font-semibold whitespace-nowrap',
        muted ? 'border-line bg-surface text-ink-muted' : className,
      )}
    >
      <Icon aria-hidden className="size-3.5 shrink-0" strokeWidth={2.5} />
      {HEALTH_LABELS[health]}
    </span>
  );
}

/**
 * Onboarding with a step to do and nothing done in 3 days (docs/DECISIONS.md
 * SA-41): since the last step was done.
 */
export function StuckBadge({ since }: { since: string }) {
  return (
    <span
      data-stuck
      className="inline-flex h-6 w-fit items-center gap-1 rounded-md border border-transparent bg-status-preparing-fill px-2 text-xs font-semibold whitespace-nowrap text-status-preparing-foreground"
    >
      <CircleAlert aria-hidden className="size-3.5 shrink-0" strokeWidth={2.5} />
      Stuck since {formatShortDate(since)}
    </span>
  );
}

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
  status: 'active' | 'suspended' | 'closed';
  accessState: string;
}) {
  if (status === 'closed') return <Badge variant="destructive">Closed</Badge>;
  if (status === 'suspended') return <Badge variant="destructive">Suspended</Badge>;
  return (
    <Badge variant={accessState === 'full' ? 'outline' : 'destructive'}>
      {ACCESS_STATE_LABELS[accessState] ?? accessState}
    </Badge>
  );
}
