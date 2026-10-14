import { LifeBuoy } from 'lucide-react';
import type { Metadata } from 'next';
import Form from 'next/form';
import Link from 'next/link';

import { EmptyState } from '@/components/shared/empty-state';
import { PageHeader } from '@/components/shared/page-header';
import { Pager } from '@/components/shared/pager';
import { Button, buttonVariants } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { filterParams } from '@/features/platform/params';
import { formatDateTime } from '@/features/platform/platform';
import { getTeam } from '@/features/platform/queries';
import { PriorityBadge, SupportStatusBadge } from '@/features/support/components/support-badges';
import { listSupportRequests } from '@/features/support/inbox-queries';
import {
  INBOX_TAB_LABELS,
  INBOX_TABS,
  readInboxFilters,
  requestAge,
  SUPPORT_PRIORITIES,
  SUPPORT_PRIORITY_LABELS,
  SUPPORT_TOPIC_LABELS,
  SUPPORT_TOPICS,
  type InboxRow,
} from '@/features/support/support';
import { requirePlatformPermission } from '@/lib/auth/guards';
import { hrefWithParams } from '@/lib/date-range';

export const metadata: Metadata = {
  title: 'Support inbox',
};

const PATH = '/super/support';

const SELECT_CLASS =
  'h-11 w-full rounded-lg border border-input bg-surface px-2.5 text-base text-ink outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:h-9 md:text-sm';
const LABEL_CLASS = 'flex flex-col gap-1 text-sm font-medium text-ink';
const linkClass = 'font-medium text-brand underline-offset-4 hover:underline';

/**
 * The support inbox (docs/SUPER_ADMIN_PLAN.md 13b, docs/DECISIONS.md SA-43):
 * what restaurants asked through Get help, by status, highest priority and
 * oldest first.
 */
export default async function SupportInboxPage({ searchParams }: PageProps<'/super/support'>) {
  await requirePlatformPermission('restaurants.support');
  const filters = readInboxFilters(await searchParams);
  const [inbox, team] = await Promise.all([listSupportRequests(filters), getTeam()]);
  const tab = filters.status ?? 'active';
  const withoutPage = { ...filters, page: undefined };
  const current = filterParams(withoutPage);
  const filtered = Object.keys(current).some((key) => key !== 'status');

  return (
    <>
      <PageHeader
        title="Support inbox"
        description="Requests restaurants sent from Get help in their admin panel. Notes here are the team's only."
      />

      <nav aria-label="Status" className="flex flex-wrap gap-2">
        {INBOX_TABS.map((value) => (
          <Link
            key={value}
            href={hrefWithParams(
              PATH,
              filterParams({ ...withoutPage, status: value === 'active' ? undefined : value }),
            )}
            aria-current={tab === value ? 'page' : undefined}
            className={buttonVariants({
              variant: tab === value ? 'default' : 'outline',
              size: 'touch',
            })}
          >
            {INBOX_TAB_LABELS[value]} ({inbox.counts[value].toLocaleString('en-IN')})
          </Link>
        ))}
      </nav>

      <Form
        key={JSON.stringify(current)}
        action={PATH}
        role="search"
        aria-label="Support requests"
        className="grid gap-3 rounded-lg border border-line bg-surface p-3 sm:grid-cols-3 lg:grid-cols-4"
      >
        {filters.status && <input type="hidden" name="status" value={filters.status} />}
        {filters.restaurant && <input type="hidden" name="restaurant" value={filters.restaurant} />}
        <label className={LABEL_CLASS}>
          Assignee
          <select name="assignee" defaultValue={filters.assignee ?? ''} className={SELECT_CLASS}>
            <option value="">Anyone</option>
            <option value="me">Me</option>
            <option value="none">No one</option>
            {team.map((member) => (
              <option key={member.user_id} value={member.user_id}>
                {member.email}
              </option>
            ))}
          </select>
        </label>
        <label className={LABEL_CLASS}>
          Priority
          <select name="priority" defaultValue={filters.priority ?? ''} className={SELECT_CLASS}>
            <option value="">Any priority</option>
            {SUPPORT_PRIORITIES.map((value) => (
              <option key={value} value={value}>
                {SUPPORT_PRIORITY_LABELS[value]}
              </option>
            ))}
          </select>
        </label>
        <label className={LABEL_CLASS}>
          About
          <select name="topic" defaultValue={filters.topic ?? ''} className={SELECT_CLASS}>
            <option value="">Anything</option>
            {SUPPORT_TOPICS.map((value) => (
              <option key={value} value={value}>
                {SUPPORT_TOPIC_LABELS[value]}
              </option>
            ))}
          </select>
        </label>
        <div className="flex items-end gap-2">
          <Button type="submit" size="touch">
            Apply
          </Button>
          <Link
            href={hrefWithParams(PATH, filterParams({ status: filters.status }))}
            className={buttonVariants({ variant: 'ghost', size: 'touch' })}
          >
            Clear
          </Link>
        </div>
      </Form>

      {inbox.rows.length === 0 ? (
        <EmptyState
          icon={LifeBuoy}
          title={filtered ? 'No requests match' : 'No requests here'}
          description={
            filtered
              ? 'Try other filters, or clear them.'
              : 'Restaurants send requests from Get help in their admin panel.'
          }
        />
      ) : (
        <>
          <ul aria-label="Support requests" className="flex flex-col gap-3 md:hidden">
            {inbox.rows.map((row) => (
              <RequestCard key={row.id} row={row} />
            ))}
          </ul>
          <div className="hidden rounded-lg border border-line bg-surface md:block">
            <Table label="Support requests">
              <TableHeader>
                <TableRow>
                  <TableHead>Request</TableHead>
                  <TableHead>Restaurant</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Priority</TableHead>
                  <TableHead>Assignee</TableHead>
                  <TableHead>Age</TableHead>
                  <TableHead>Last change</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {inbox.rows.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="max-w-96 whitespace-normal">
                      <RequestLink row={row} />
                      <p className="line-clamp-2 text-sm text-ink-muted">
                        {row.more ? `${row.message}…` : row.message}
                      </p>
                    </TableCell>
                    <TableCell>
                      <Link href={`/super/restaurants/${row.restaurant_id}`} className={linkClass}>
                        {row.restaurant_name}
                      </Link>
                      <p className="text-xs text-ink-muted">{row.created_by_name}</p>
                    </TableCell>
                    <TableCell>
                      <SupportStatusBadge status={row.status} />
                    </TableCell>
                    <TableCell>
                      <PriorityBadge priority={row.priority} />
                    </TableCell>
                    <TableCell>{row.assignee ?? '—'}</TableCell>
                    <TableCell className="tabular-nums">
                      <span title={formatDateTime(row.created_at)}>
                        {requestAge(row.created_at)}
                      </span>
                    </TableCell>
                    <TableCell className="tabular-nums">{formatDateTime(row.updated_at)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}
      <Pager
        page={inbox.page}
        pageSize={inbox.page_size}
        total={inbox.total}
        hrefFor={(page) => hrefWithParams(PATH, filterParams({ ...withoutPage, page }))}
      />
    </>
  );
}

function RequestLink({ row }: { row: InboxRow }) {
  return (
    <Link href={`${PATH}/${row.id}`} className={linkClass}>
      {SUPPORT_TOPIC_LABELS[row.topic]}
      <span className="sr-only"> from {row.restaurant_name}</span>
    </Link>
  );
}

/** A request on a phone: the same facts as a table row, stacked. */
function RequestCard({ row }: { row: InboxRow }) {
  return (
    <li
      aria-label={`${SUPPORT_TOPIC_LABELS[row.topic]}, ${row.restaurant_name}`}
      className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <RequestLink row={row} />
        <span className="text-sm text-ink-muted tabular-nums">{requestAge(row.created_at)}</span>
      </div>
      <p className="text-sm text-ink">
        {row.restaurant_name}, {row.created_by_name}
      </p>
      <p className="line-clamp-3 text-sm text-ink-muted">
        {row.more ? `${row.message}…` : row.message}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <SupportStatusBadge status={row.status} />
        <PriorityBadge priority={row.priority} />
        <span className="text-sm text-ink-muted">{row.assignee ?? 'No one assigned'}</span>
      </div>
    </li>
  );
}
