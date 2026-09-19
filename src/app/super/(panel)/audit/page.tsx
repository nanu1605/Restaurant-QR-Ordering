import { ScrollText } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';

import { EmptyState } from '@/components/shared/empty-state';
import { PageHeader } from '@/components/shared/page-header';
import { Pager } from '@/components/shared/pager';
import { AuditFiltersForm } from '@/features/platform/components/audit-filters';
import { filterParams, readAuditFilters, type AuditFilters } from '@/features/platform/params';
import { ACTOR_TYPE_LABELS, formatDateTime, type AuditRow } from '@/features/platform/platform';
import { listPlatformAudit } from '@/features/platform/queries';
import { requirePlatformAdmin } from '@/lib/auth/guards';
import { hrefWithParams } from '@/lib/date-range';

export const metadata: Metadata = {
  title: 'Audit log',
};

const PATH = '/super/audit';

/** Platform audit log (spec §13.4, docs/DECISIONS.md P7-11), newest first. */
export default async function SuperAuditPage({ searchParams }: PageProps<'/super/audit'>) {
  await requirePlatformAdmin();
  const filters = readAuditFilters(await searchParams);
  const list = await listPlatformAudit(filters);
  const restaurantName = filters.restaurant_id ? list.rows[0]?.restaurant_name : null;

  return (
    <>
      <PageHeader
        title="Audit log"
        description="Everything staff, customers, the system and platform admins did. Times are India time."
      />
      {filters.restaurant_id && (
        <p role="status" className="flex flex-wrap items-center gap-2 text-sm text-ink">
          Showing {restaurantName ?? 'one restaurant'} only.
          <Link
            href={auditHref({ ...filters, restaurant_id: undefined, page: 1 })}
            className="font-medium text-brand underline underline-offset-4"
          >
            Show every restaurant
          </Link>
        </p>
      )}
      <AuditFiltersForm filters={filters} />

      {list.rows.length === 0 ? (
        <EmptyState icon={ScrollText} title="Nothing logged for these filters" />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line bg-surface">
          <table className="w-full min-w-[48rem] text-left text-sm text-ink">
            <caption className="sr-only">Audit log</caption>
            <thead className="border-b border-line text-ink-muted">
              <tr>
                {['When', 'Restaurant', 'Who', 'What', 'Details'].map((heading) => (
                  <th key={heading} scope="col" className="px-3 py-2 font-medium">
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {list.rows.map((row) => (
                <AuditTableRow key={row.id} row={row} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pager
        page={list.page}
        pageSize={list.page_size}
        total={list.total}
        hrefFor={(page) => auditHref({ ...filters, page })}
      />
    </>
  );
}

/** The audit page with these filters, in its URL keys. */
function auditHref(filters: AuditFilters) {
  return hrefWithParams(
    PATH,
    filterParams({
      restaurant: filters.restaurant_id,
      actor: filters.actor_type,
      action: filters.action,
      from: filters.from,
      to: filters.to,
      page: filters.page,
    }),
  );
}

function AuditTableRow({ row }: { row: AuditRow }) {
  const changes = row.before != null || row.after != null;
  return (
    <tr data-action={row.action} className="align-top">
      <td className="px-3 py-2 whitespace-nowrap tabular-nums">{formatDateTime(row.created_at)}</td>
      <td className="px-3 py-2">
        {row.restaurant_id ? (
          <Link
            href={`/super/restaurants/${row.restaurant_id}`}
            className="text-brand underline-offset-4 hover:underline"
          >
            {row.restaurant_name}
          </Link>
        ) : (
          <span className="text-ink-muted">Platform</span>
        )}
      </td>
      <td className="px-3 py-2">
        <div>{row.actor_label}</div>
        <div className="text-xs text-ink-muted">
          {ACTOR_TYPE_LABELS[row.actor_type]}
          {row.actor_role ? `, ${row.actor_role}` : ''}
          {row.actor_type === 'platform_admin' && row.actor_email ? `, ${row.actor_email}` : ''}
        </div>
      </td>
      <td className="px-3 py-2 font-mono text-xs">{row.action}</td>
      <td className="px-3 py-2">
        {row.reason && <div>{row.reason}</div>}
        {changes && (
          <details>
            <summary className="cursor-pointer text-xs text-brand">Changes</summary>
            <pre className="mt-1 max-w-md overflow-x-auto rounded bg-muted p-2 text-xs whitespace-pre-wrap">
              {JSON.stringify({ before: row.before, after: row.after }, null, 2)}
            </pre>
          </details>
        )}
        {!row.reason && !changes && <span className="text-ink-muted">—</span>}
      </td>
    </tr>
  );
}
