import { Inbox } from 'lucide-react';
import type { Metadata } from 'next';

import { EmptyState } from '@/components/shared/empty-state';
import { PageHeader } from '@/components/shared/page-header';
import { Pager } from '@/components/shared/pager';
import { ScrollRegion } from '@/components/shared/scroll-region';
import { describeSource } from '@/features/analytics/attribution';
import { formatDateTime } from '@/features/platform/platform';
import { LEADS_PAGE_SIZE, listSiteLeads } from '@/features/platform/queries';
import { requirePlatformAdmin } from '@/lib/auth/guards';
import { hrefWithParams } from '@/lib/date-range';

export const metadata: Metadata = {
  title: 'Leads',
};

const PATH = '/super/leads';

/** "Book a demo" requests from the website (docs/DECISIONS.md W-6), newest first. */
export default async function SuperLeadsPage({ searchParams }: PageProps<'/super/leads'>) {
  await requirePlatformAdmin();
  const params = await searchParams;
  const requested = Math.max(1, Number.parseInt(String(params.page ?? '1'), 10) || 1);
  const list = await listSiteLeads(requested);

  return (
    <>
      <PageHeader
        title="Leads"
        description="Demo requests from the website’s contact page. Times are India time."
      />
      {list.rows.length === 0 ? (
        <EmptyState
          icon={Inbox}
          title="No demo requests yet"
          description="They appear here when someone sends the form on the website’s contact page."
        />
      ) : (
        <ScrollRegion label="Leads" className="rounded-lg border border-line bg-surface">
          <table className="w-full min-w-[64rem] text-left text-sm text-ink">
            <caption className="sr-only">Leads</caption>
            <thead className="border-b border-line text-ink-muted">
              <tr>
                {['Received', 'Who', 'Restaurant', 'Contact', 'Plan', 'Source', 'Message'].map(
                  (heading) => (
                    <th key={heading} scope="col" className="px-3 py-2 font-medium">
                      {heading}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {list.rows.map((row) => (
                <tr key={row.id} data-lead-id={row.id} className="align-top">
                  <td className="px-3 py-2 whitespace-nowrap tabular-nums">
                    {formatDateTime(row.created_at)}
                  </td>
                  <td className="px-3 py-2 font-medium">{row.name}</td>
                  <td className="px-3 py-2">
                    <div>{row.restaurant_name}</div>
                    <div className="text-xs text-ink-muted">{row.city}</div>
                  </td>
                  <td className="px-3 py-2">
                    <a href={`tel:+91${row.phone}`} className="block text-brand hover:underline">
                      +91 {row.phone}
                    </a>
                    {row.email && (
                      <a
                        href={`mailto:${row.email}`}
                        className="block break-all text-brand hover:underline"
                      >
                        {row.email}
                      </a>
                    )}
                  </td>
                  <td className="px-3 py-2">{row.plan_code ?? '—'}</td>
                  <td className="px-3 py-2">
                    {describeSource(row.source).map((line) => (
                      <div key={line} className="break-words">
                        {line}
                      </div>
                    ))}
                    {!row.source && '—'}
                  </td>
                  <td className="max-w-sm px-3 py-2 break-words whitespace-pre-wrap">
                    {row.message ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollRegion>
      )}
      <Pager
        page={list.page}
        pageSize={LEADS_PAGE_SIZE}
        total={list.total}
        hrefFor={(next) => hrefWithParams(PATH, { page: next > 1 ? String(next) : undefined })}
      />
    </>
  );
}
