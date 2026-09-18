import { ClipboardList } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { EmptyState } from '@/components/shared/empty-state';
import { Money } from '@/components/shared/money';
import { buttonVariants } from '@/components/ui/button';
import { formatElapsed } from '@/features/orders/board-view';
import { hrefWithParams } from '@/lib/date-range';

import {
  type ClosedSession,
  PAYMENT_MODE_LABELS,
  type TotalOrders,
  type TotalOrdersBill,
} from '../bill';
import { filterParams, type TotalOrdersFilters } from '../schemas';
import { BillStatusBadge } from './bill-activity';
import { formatBillDate } from './bill-document';

const PATH = '/admin/total-orders';

/** Summary strip for the selected range (spec §13.3). Void bills never count. */
export function TotalOrdersSummary({ data }: { data: TotalOrders }) {
  const s = data.summary;
  const stats: { label: string; value: ReactNode }[] = [
    { label: 'Bills', value: s.bills },
    { label: 'Orders', value: s.orders },
    { label: 'Items', value: s.items },
    { label: 'Gross sales', value: <Money paise={s.grossPaise} /> },
    { label: 'Discounts', value: <Money paise={s.discountPaise} /> },
    { label: 'Tax', value: <Money paise={s.taxPaise} /> },
    { label: 'Net collected', value: <Money paise={s.collectedPaise} /> },
    { label: 'Unpaid bills', value: s.unpaidBills },
  ];
  return (
    <dl
      aria-label="Summary"
      className="grid grid-cols-2 gap-2 rounded-lg border border-line bg-surface p-3 sm:grid-cols-4"
    >
      {stats.map((stat) => (
        <div key={stat.label} className="flex flex-col">
          <dt className="text-sm text-ink-muted">{stat.label}</dt>
          <dd className="text-lg font-semibold text-ink tabular-nums">{stat.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function TotalOrdersResults({
  data,
  filters,
  timezone,
}: {
  data: TotalOrders;
  filters: TotalOrdersFilters;
  timezone: string;
}) {
  const range =
    data.from === data.to
      ? formatDay(data.from)
      : `${formatDay(data.from)} – ${formatDay(data.to)}`;

  if (data.rows.length === 0) {
    return (
      <EmptyState
        icon={ClipboardList}
        title={
          data.view === 'bills'
            ? `No bills for ${range}`
            : `No tables closed without a bill for ${range}`
        }
        description="Try another date range or clear the filters."
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-x-auto rounded-lg border border-line bg-surface">
        {data.view === 'bills' ? (
          <BillsTable rows={data.rows} timezone={timezone} range={range} />
        ) : (
          <ClosedTable rows={data.rows} timezone={timezone} range={range} />
        )}
      </div>
      <Pagination data={data} filters={filters} />
    </div>
  );
}

function BillsTable({
  rows,
  timezone,
  range,
}: {
  rows: TotalOrdersBill[];
  timezone: string;
  range: string;
}) {
  return (
    <table className="w-full min-w-[56rem] text-left text-sm text-ink">
      <caption className="sr-only">Bills for {range}</caption>
      <thead className="border-b border-line text-ink-muted">
        <tr>
          {[
            'Invoice',
            'Table',
            'Waiter',
            'Seated → billed',
            'Items',
            'Total',
            'Payment',
            'Billed by',
          ].map((heading) => (
            <th
              key={heading}
              scope="col"
              className={`px-3 py-2 font-medium ${heading === 'Items' || heading === 'Total' ? 'text-right' : ''}`}
            >
              {heading}
            </th>
          ))}
        </tr>
      </thead>
      <tbody className="divide-y divide-line">
        {rows.map((row) => (
          <tr key={row.id} className={row.status === 'void' ? 'text-ink-muted' : undefined}>
            <td className="px-3 py-2">
              <Link
                href={`/admin/bills/${row.id}`}
                className="font-semibold text-primary underline-offset-4 hover:underline"
              >
                {row.invoiceNumber}
              </Link>
              {row.status === 'void' && (
                <span className="ml-2 rounded border border-status-void px-1 text-xs font-bold text-status-void">
                  VOID
                </span>
              )}
            </td>
            <td className="px-3 py-2">{row.tableLabel}</td>
            <td className="px-3 py-2">{row.waiterName ?? '—'}</td>
            <td className="px-3 py-2 tabular-nums">
              {formatBillDate(row.openedAt, timezone)} → {formatClock(row.generatedAt, timezone)}
              <span className="block text-ink-muted">{formatElapsed(row.minutes)}</span>
            </td>
            <td className="px-3 py-2 text-right tabular-nums">{row.items}</td>
            <td className="px-3 py-2 text-right font-semibold">
              <Money paise={row.grandTotalPaise} />
            </td>
            <td className="px-3 py-2">
              <span className="flex flex-wrap items-center gap-2">
                <BillStatusBadge
                  status={row.status}
                  paymentStatus={row.paymentStatus}
                  className="h-6 px-2 text-sm"
                />
                {row.modes.map((mode) => PAYMENT_MODE_LABELS[mode]).join(', ')}
              </span>
            </td>
            <td className="px-3 py-2">{row.generatedByName ?? '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ClosedTable({
  rows,
  timezone,
  range,
}: {
  rows: ClosedSession[];
  timezone: string;
  range: string;
}) {
  return (
    <table className="w-full min-w-[44rem] text-left text-sm text-ink">
      <caption className="sr-only">Tables closed without a bill for {range}</caption>
      <thead className="border-b border-line text-ink-muted">
        <tr>
          {['Table', 'Waiter', 'Seated', 'Closed', 'Closed by', 'Reason'].map((heading) => (
            <th key={heading} scope="col" className="px-3 py-2 font-medium">
              {heading}
            </th>
          ))}
        </tr>
      </thead>
      <tbody className="divide-y divide-line">
        {rows.map((row) => (
          <tr key={row.sessionId}>
            <td className="px-3 py-2 font-semibold">{row.tableLabel}</td>
            <td className="px-3 py-2">{row.waiterName ?? '—'}</td>
            <td className="px-3 py-2 tabular-nums">{formatBillDate(row.openedAt, timezone)}</td>
            <td className="px-3 py-2 tabular-nums">{formatBillDate(row.closedAt, timezone)}</td>
            <td className="px-3 py-2">{row.closedByName ?? '—'}</td>
            <td className="px-3 py-2">{row.reason ?? '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Pagination({ data, filters }: { data: TotalOrders; filters: TotalOrdersFilters }) {
  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
  const first = (data.page - 1) * data.pageSize + 1;
  const last = Math.min(data.total, data.page * data.pageSize);
  const params = filterParams(filters);
  const href = (page: number) =>
    hrefWithParams(PATH, { ...params, page: page > 1 ? String(page) : undefined });

  return (
    <nav
      aria-label="Pages"
      className="flex flex-wrap items-center justify-between gap-2 text-sm text-ink-muted"
    >
      <span className="tabular-nums">
        {first}–{last} of {data.total}
      </span>
      {pages > 1 && (
        <span className="flex gap-2">
          {data.page > 1 && (
            <Link
              href={href(data.page - 1)}
              className={buttonVariants({ variant: 'outline', size: 'touch' })}
            >
              Previous
            </Link>
          )}
          {data.page < pages && (
            <Link
              href={href(data.page + 1)}
              className={buttonVariants({ variant: 'outline', size: 'touch' })}
            >
              Next
            </Link>
          )}
        </span>
      )}
    </nav>
  );
}

/** "17 Sep" for a 'YYYY-MM-DD' business date. */
function formatDay(date: string): string {
  return new Intl.DateTimeFormat('en-IN', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  }).format(new Date(`${date}T00:00:00Z`));
}

function formatClock(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(iso));
}
