import { cn } from 'cn';
import {
  AlarmClock,
  CalendarCheck,
  CalendarClock,
  CircleCheck,
  CircleDot,
  CircleSlash,
  Hourglass,
  PhoneCall,
  type LucideIcon,
} from 'lucide-react';

import { LEAD_STAGE_LABELS, LOST_REASON_LABELS, type LeadStage, type LostReason } from '../leads';

const BADGE =
  'inline-flex h-6 w-fit items-center gap-1 rounded-md border px-2 text-xs font-semibold whitespace-nowrap';

const STAGE_STYLES: Record<LeadStage, { icon: LucideIcon; className: string }> = {
  new: {
    icon: CircleDot,
    className: 'bg-status-ready-fill text-status-ready-foreground border-transparent',
  },
  contacted: { icon: PhoneCall, className: 'bg-surface text-ink border-line' },
  demo_scheduled: { icon: CalendarClock, className: 'bg-surface text-ink border-line' },
  demo_done: { icon: CalendarCheck, className: 'bg-surface text-ink border-line' },
  trial: {
    icon: Hourglass,
    className: 'bg-sub-trial-fill text-sub-trial-foreground border-transparent',
  },
  won: {
    icon: CircleCheck,
    className: 'bg-sub-paid-fill text-sub-paid-foreground border-transparent',
  },
  lost: { icon: CircleSlash, className: 'bg-surface text-ink-muted border-line' },
};

/** A lead's stage, icon and words; Lost says why. */
export function LeadStageBadge({
  stage,
  lostReason = null,
}: {
  stage: LeadStage;
  lostReason?: LostReason | null;
}) {
  const { icon: Icon, className } = STAGE_STYLES[stage];
  return (
    <span data-stage={stage} className={cn(BADGE, className)}>
      <Icon aria-hidden className="size-3.5 shrink-0" strokeWidth={2.5} />
      {LEAD_STAGE_LABELS[stage]}
      {stage === 'lost' && lostReason && `: ${LOST_REASON_LABELS[lostReason].toLowerCase()}`}
    </span>
  );
}

/** A follow-up whose time has passed. */
export function OverdueBadge() {
  return (
    <span
      data-overdue
      className={cn(
        BADGE,
        'border-transparent bg-sub-payment-failed-fill text-sub-payment-failed-foreground',
      )}
    >
      <AlarmClock aria-hidden className="size-3.5 shrink-0" strokeWidth={2.5} />
      Overdue
    </span>
  );
}
