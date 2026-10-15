import { UserRoundX } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';

import { EmptyState } from '@/components/shared/empty-state';
import { PageHeader } from '@/components/shared/page-header';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { LeadsSections } from '@/features/growth/components/leads-sections';
import { SIGNUP_STEP_LABELS, type UnfinishedSignups } from '@/features/growth/leads';
import { getUnfinishedSignups } from '@/features/growth/queries';
import { formatMobile } from '@/features/platform/dues-messages';
import { formatDate, formatDateTime } from '@/features/platform/platform';
import { requirePlatformPermission } from '@/lib/auth/guards';

export const metadata: Metadata = {
  title: 'Unfinished signups',
};

const linkClass = 'font-medium text-brand underline-offset-4 hover:underline';

type Row = UnfinishedSignups['rows'][number];

/**
 * Website signups that stopped before the restaurant was created
 * (docs/SUPER_ADMIN_PLAN.md 13d, docs/DECISIONS.md SA-57), while their rows
 * last. There is no "Add as lead" until the privacy policy covers following
 * them up.
 */
export default async function UnfinishedSignupsPage() {
  await requirePlatformPermission('growth.manage');
  const { rows, total } = await getUnfinishedSignups();

  return (
    <>
      <PageHeader
        title="Leads"
        description="Demo requests from the website and leads the team added. Times are India time."
      />
      <LeadsSections current="/super/leads/signups" />
      <div className="flex flex-col gap-1 text-sm text-ink">
        <p>
          Signups started on the website in the last 7 days that never became a restaurant, newest
          first, with the details as they were typed. Each is deleted 7 days after it started.
        </p>
        <p className="text-ink-muted">
          Use them to spot where signup goes wrong. Following them up needs the privacy policy to
          cover it first.
        </p>
      </div>
      {rows.length === 0 ? (
        <EmptyState
          icon={UserRoundX}
          title="No unfinished signups"
          description="Every signup in the last 7 days became a restaurant."
        />
      ) : (
        <>
          {total > rows.length && (
            <p className="text-sm text-ink-muted">
              Showing the newest {rows.length.toLocaleString('en-IN')} of{' '}
              {total.toLocaleString('en-IN')}.
            </p>
          )}
          <ul aria-label="Unfinished signups" className="flex flex-col gap-3 md:hidden">
            {rows.map((row) => (
              <li
                key={row.id}
                aria-label={row.restaurant_name ?? row.email}
                className="flex flex-col gap-1 rounded-lg border border-line bg-surface p-3 text-sm"
              >
                <p className="font-medium text-ink">{row.restaurant_name ?? 'No name given'}</p>
                <Who row={row} />
                <p className="text-ink">{SIGNUP_STEP_LABELS[row.step]}</p>
                <p className="text-ink-muted">
                  Started {formatDateTime(row.created_at)}, deleted on {formatDate(row.deleted_at)}
                </p>
                <LeadLink row={row} />
              </li>
            ))}
          </ul>
          <div className="hidden rounded-lg border border-line bg-surface md:block">
            <Table label="Unfinished signups">
              <TableHeader>
                <TableRow>
                  <TableHead>Started</TableHead>
                  <TableHead>Restaurant</TableHead>
                  <TableHead>Who</TableHead>
                  <TableHead>Plan</TableHead>
                  <TableHead>Got to</TableHead>
                  <TableHead>Deleted on</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="tabular-nums">{formatDateTime(row.created_at)}</TableCell>
                    <TableCell className="max-w-64 whitespace-normal">
                      <p className="text-ink">{row.restaurant_name ?? '—'}</p>
                      <p className="text-sm text-ink-muted">{row.city}</p>
                      <LeadLink row={row} />
                    </TableCell>
                    <TableCell className="max-w-72 whitespace-normal">
                      <Who row={row} />
                    </TableCell>
                    <TableCell>
                      {row.plan_code ? `${row.plan_code}${row.cycle ? `, ${row.cycle}` : ''}` : '—'}
                    </TableCell>
                    <TableCell>{SIGNUP_STEP_LABELS[row.step]}</TableCell>
                    <TableCell className="tabular-nums">{formatDate(row.deleted_at)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}
    </>
  );
}

function Who({ row }: { row: Row }) {
  return (
    <div className="flex flex-col text-sm">
      {row.owner_name && <span className="text-ink">{row.owner_name}</span>}
      <span className="break-all text-ink">{row.email}</span>
      {row.phone && (
        <span className="text-ink tabular-nums">+91 {formatMobile(row.phone) ?? row.phone}</span>
      )}
    </div>
  );
}

/** A lead with the same mobile, when there is one. */
function LeadLink({ row }: { row: Row }) {
  if (!row.lead_id) return null;
  return (
    <Link href={`/super/leads/${row.lead_id}`} className={`${linkClass} text-sm`}>
      Already a lead
    </Link>
  );
}
