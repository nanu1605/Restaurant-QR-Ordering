import { Webhook } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';

import { EmptyState } from '@/components/shared/empty-state';
import { PageHeader } from '@/components/shared/page-header';
import { Pager } from '@/components/shared/pager';
import { ScrollRegion } from '@/components/shared/scroll-region';
import { buttonVariants } from '@/components/ui/button';
import { ReprocessButton } from '@/features/platform/components/reprocess-button';
import { formatDateTime } from '@/features/platform/platform';
import { listWebhookEvents, WEBHOOK_PAGE_SIZE } from '@/features/platform/queries';
import { requirePlatformAdmin } from '@/lib/auth/guards';
import { hrefWithParams } from '@/lib/date-range';

export const metadata: Metadata = {
  title: 'Webhooks',
};

const PATH = '/super/webhooks';

/**
 * Razorpay webhooks as received (spec §14.4, docs/DECISIONS.md P8-11), newest
 * first. A failed one keeps its error and can be run again.
 */
export default async function SuperWebhooksPage({ searchParams }: PageProps<'/super/webhooks'>) {
  await requirePlatformAdmin();
  const params = await searchParams;
  const failedOnly = params.status === 'failed';
  const requested = Math.max(1, Number.parseInt(String(params.page ?? '1'), 10) || 1);
  const list = await listWebhookEvents({ failedOnly, page: requested });
  const href = (next: { failed: boolean; page?: number }) =>
    hrefWithParams(PATH, {
      status: next.failed ? 'failed' : undefined,
      page: next.page && next.page > 1 ? String(next.page) : undefined,
    });

  return (
    <>
      <PageHeader
        title="Webhooks"
        description="What Razorpay sent, and whether it was applied. Times are India time."
      />
      <nav aria-label="Webhook filter" className="flex gap-2">
        <Link
          href={href({ failed: false })}
          aria-current={failedOnly ? undefined : 'page'}
          className={buttonVariants({ variant: failedOnly ? 'outline' : 'default', size: 'sm' })}
        >
          All
        </Link>
        <Link
          href={href({ failed: true })}
          aria-current={failedOnly ? 'page' : undefined}
          className={buttonVariants({ variant: failedOnly ? 'default' : 'outline', size: 'sm' })}
        >
          Failed
        </Link>
      </nav>

      {list.rows.length === 0 ? (
        <EmptyState
          icon={Webhook}
          title={failedOnly ? 'No failed webhooks' : 'No webhooks yet'}
          description={
            failedOnly
              ? undefined
              : 'They arrive once the webhook is set up in the Razorpay dashboard.'
          }
        />
      ) : (
        <ScrollRegion label="Webhooks" className="rounded-lg border border-line bg-surface">
          <table className="w-full min-w-[48rem] text-left text-sm text-ink">
            <caption className="sr-only">Webhooks</caption>
            <thead className="border-b border-line text-ink-muted">
              <tr>
                {['Received', 'Event', 'Result', 'Details'].map((heading) => (
                  <th key={heading} scope="col" className="px-3 py-2 font-medium">
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {list.rows.map((row) => (
                <tr key={row.id} data-event-id={row.event_id} className="align-top">
                  <td className="px-3 py-2 whitespace-nowrap tabular-nums">
                    {formatDateTime(row.received_at)}
                  </td>
                  <td className="px-3 py-2">
                    <div className="font-mono text-xs">{row.event_type}</div>
                    <div className="text-xs break-all text-ink-muted">{row.event_id}</div>
                  </td>
                  <td className="px-3 py-2">
                    {row.processing_error ? (
                      <div className="flex flex-col items-start gap-2">
                        <span className="font-medium text-destructive">Failed</span>
                        <span className="text-xs break-words">{row.processing_error}</span>
                        <ReprocessButton eventId={row.id} />
                      </div>
                    ) : row.processed_at ? (
                      <span>Processed {formatDateTime(row.processed_at)}</span>
                    ) : (
                      <span className="text-ink-muted">Received</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <details>
                      <summary className="cursor-pointer text-xs text-brand">Payload</summary>
                      <pre className="mt-1 max-w-md rounded bg-muted p-2 text-xs wrap-anywhere whitespace-pre-wrap">
                        {JSON.stringify(row.payload, null, 2)}
                      </pre>
                    </details>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollRegion>
      )}
      <Pager
        page={list.page}
        pageSize={WEBHOOK_PAGE_SIZE}
        total={list.total}
        hrefFor={(next) => href({ failed: failedOnly, page: next })}
      />
    </>
  );
}
