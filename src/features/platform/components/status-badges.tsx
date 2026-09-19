import { Badge } from '@/components/ui/badge';

import {
  ACCESS_STATE_LABELS,
  SUBSCRIPTION_STATUS_LABELS,
  type SubscriptionStatus,
} from '../platform';

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
