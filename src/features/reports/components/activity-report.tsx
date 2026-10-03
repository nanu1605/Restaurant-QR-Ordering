import { ClipboardList } from 'lucide-react';
import Link from 'next/link';

import { EmptyState } from '@/components/shared/empty-state';
import { Money } from '@/components/shared/money';
import { percentLabel } from '@/features/billing/bill';
import { formatBillDate, tableHeading } from '@/features/ordering/format';

import { type ActivityReport, dishLabel } from '../report';
import { ScrollRegion } from '@/components/shared/scroll-region';

/**
 * The activity logs (spec §19 Phase 6, §10.8): voids and discounts, removed
 * dishes and deleted orders, each with who did it, their role and why.
 */
export function ActivityReportView({
  report,
  timezone,
}: {
  report: ActivityReport;
  timezone: string;
}) {
  if (report.rows.length === 0) {
    return (
      <EmptyState
        icon={ClipboardList}
        title="Nothing logged"
        description="No voids, discounts or removals in this range."
      />
    );
  }

  if (report.kind === 'voids_discounts') {
    return (
      <Log
        caption="Voids and discounts, newest first"
        headers={['When', 'What', 'Invoice', 'Table', 'Amount', 'By', 'Reason']}
      >
        {report.rows.map((row) => (
          <tr key={`${row.at}-${row.billId}-${row.kind}`} className="border-b border-line">
            <td className="py-2 whitespace-nowrap text-ink-muted">
              {formatBillDate(row.at, timezone)}
            </td>
            <td className="py-2 text-ink">
              {row.kind === 'void' ? 'Void' : 'Discount'}
              {row.kind === 'discount' && row.discountType === 'percent' && row.discountValue ? (
                <span className="text-ink-muted"> · {percentLabel(row.discountValue)}</span>
              ) : null}
              {row.kind === 'void' && row.reopened ? (
                <span className="text-ink-muted"> · table reopened</span>
              ) : null}
            </td>
            <td className="py-2">
              <Link
                href={`/admin/bills/${row.billId}`}
                className="font-medium text-brand underline underline-offset-4"
              >
                {row.invoiceNumber}
              </Link>
            </td>
            <td className="py-2 text-ink">{tableHeading(row.tableLabel)}</td>
            <td className="py-2 text-right text-ink">
              <Money paise={row.amountPaise} />
            </td>
            <Who name={row.actorName} role={row.actorRole} />
            <td className="py-2 text-ink">{row.reason ?? '—'}</td>
          </tr>
        ))}
      </Log>
    );
  }

  if (report.kind === 'removed_items') {
    return (
      <Log
        caption="Removed dishes, newest first"
        headers={['When', 'Dish', 'Quantity', 'Value', 'Table', 'By', 'Reason']}
      >
        {report.rows.map((row, index) => (
          <tr key={`${row.at}-${index}`} className="border-b border-line">
            <td className="py-2 whitespace-nowrap text-ink-muted">
              {formatBillDate(row.at, timezone)}
            </td>
            <td className="py-2 text-ink">
              {dishLabel(row.name ?? 'Dish', row.variant)}
              {row.wasServed && <span className="text-ink-muted"> · was served</span>}
            </td>
            <td className="py-2 text-right text-ink tabular-nums">{row.quantity}</td>
            <td className="py-2 text-right text-ink">
              <Money paise={row.valuePaise} />
            </td>
            <td className="py-2 text-ink">
              {row.tableLabel ? tableHeading(row.tableLabel) : '—'}
              {row.roundNumber !== null && (
                <span className="text-ink-muted"> · round {row.roundNumber}</span>
              )}
            </td>
            <Who name={row.actorName} role={row.actorRole} />
            <td className="py-2 text-ink">{row.reason ?? '—'}</td>
          </tr>
        ))}
      </Log>
    );
  }

  return (
    <Log
      caption="Deleted orders, newest first"
      headers={['When', 'Table', 'Dishes', 'Quantity', 'Value', 'By', 'Reason']}
    >
      {report.rows.map((row, index) => (
        <tr key={`${row.at}-${index}`} className="border-b border-line">
          <td className="py-2 whitespace-nowrap text-ink-muted">
            {formatBillDate(row.at, timezone)}
          </td>
          <td className="py-2 text-ink">
            {row.tableLabel ? tableHeading(row.tableLabel) : '—'}
            {row.roundNumber !== null && (
              <span className="text-ink-muted"> · round {row.roundNumber}</span>
            )}
          </td>
          <td className="py-2 text-ink">
            {row.items.length === 0
              ? '—'
              : row.items
                  .map(
                    (item) => `${dishLabel(item.name ?? 'Dish', item.variant)} × ${item.quantity}`,
                  )
                  .join(', ')}
          </td>
          <td className="py-2 text-right text-ink tabular-nums">{row.quantity}</td>
          <td className="py-2 text-right text-ink">
            <Money paise={row.valuePaise} />
          </td>
          <Who name={row.actorName} role={row.actorRole} />
          <td className="py-2 text-ink">{row.reason ?? '—'}</td>
        </tr>
      ))}
    </Log>
  );
}

function Who({ name, role }: { name: string | null; role: string | null }) {
  return (
    <td className="py-2 text-ink">
      {name ?? 'Someone'}
      {role && <span className="text-ink-muted"> · {role}</span>}
    </td>
  );
}

function Log({
  caption,
  headers,
  children,
}: {
  caption: string;
  headers: string[];
  children: React.ReactNode;
}) {
  return (
    <ScrollRegion label={caption}>
      <table className="w-full border-collapse text-base">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-line text-left text-sm text-ink-muted">
            {headers.map((header) => (
              <th
                key={header}
                scope="col"
                className={
                  header === 'Quantity' || header === 'Value' || header === 'Amount'
                    ? 'py-2 text-right font-medium'
                    : 'py-2 font-medium'
                }
              >
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </ScrollRegion>
  );
}
