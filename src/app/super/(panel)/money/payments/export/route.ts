import { readPaymentFilters } from '@/features/platform/params';
import { paymentsCsv } from '@/features/platform/payments-csv';
import { todayInIndia } from '@/features/platform/platform';
import { listPayments } from '@/features/platform/queries';
import { csvFilename, toCsv } from '@/features/reports/csv';
import { requirePlatformPermission } from '@/lib/auth/guards';

/**
 * The payments ledger as a CSV, with the page's filters (docs/DECISIONS.md
 * SA-18). The database checks the permission and the second factor too.
 */
export async function GET(request: Request) {
  await requirePlatformPermission('money.view');
  const today = todayInIndia();
  const url = new URL(request.url);
  const filters = readPaymentFilters(Object.fromEntries(url.searchParams), today);
  const list = await listPayments(filters, true);
  if (list.total > list.rows.length) {
    return new Response('Too many payments for one file: choose fewer days.', { status: 413 });
  }
  const name =
    filters.period === 'all' || !filters.from
      ? `payments-to-${filters.to ?? today}.csv`
      : csvFilename('payments', filters.from, filters.to ?? today);

  return new Response(toCsv(paymentsCsv(list.rows)), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${name}"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
