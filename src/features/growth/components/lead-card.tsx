import Link from 'next/link';

import { formatDateTime } from '@/features/platform/platform';

import { followUpOverdue, type LeadRow } from '../leads';
import { LeadStageBadge, OverdueBadge } from './lead-badges';

const linkClass = 'font-medium text-brand underline-offset-4 hover:underline';

/** A lead's name, linked to its page. */
export function LeadLink({ row }: { row: Pick<LeadRow, 'id' | 'name' | 'restaurant_name'> }) {
  return (
    <Link href={`/super/leads/${row.id}`} className={linkClass}>
      {row.name}
      <span className="sr-only">, {row.restaurant_name}</span>
    </Link>
  );
}

/** When the next follow-up is, flagged once it has passed. */
export function FollowUp({ row, now }: { row: LeadRow; now: Date }) {
  if (!row.follow_up_at) return <span className="text-ink-muted">—</span>;
  return (
    <span className="flex flex-wrap items-center gap-1.5 tabular-nums">
      {formatDateTime(row.follow_up_at)}
      {followUpOverdue(row, now) && <OverdueBadge />}
    </span>
  );
}

/** A lead on a phone, or on the board. */
export function LeadCard({ row, now, showStage }: { row: LeadRow; now: Date; showStage: boolean }) {
  return (
    <li
      aria-label={`${row.name}, ${row.restaurant_name}`}
      className="flex flex-col gap-1.5 rounded-lg border border-line bg-surface p-3"
    >
      <LeadLink row={row} />
      <p className="text-sm [overflow-wrap:anywhere] text-ink">
        {row.restaurant_name}, {row.city}
      </p>
      {showStage && <LeadStageBadge stage={row.stage} lostReason={row.lost_reason} />}
      {row.follow_up_at && (
        <p className="text-sm text-ink-muted">
          Follow up: <FollowUp row={row} now={now} />
        </p>
      )}
      <p className="text-sm text-ink-muted">{row.assignee ?? 'No one assigned'}</p>
    </li>
  );
}
