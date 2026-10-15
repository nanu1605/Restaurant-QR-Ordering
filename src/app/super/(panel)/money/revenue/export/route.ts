import { todayInIndia } from '@/features/platform/platform';
import { csvFilename, toCsv } from '@/features/reports/csv';
import { getRevenueReport } from '@/features/revenue/queries';
import { readRevenueParams } from '@/features/revenue/revenue';
import { revenueCsv } from '@/features/revenue/revenue-csv';
import { requirePlatformPermission } from '@/lib/auth/guards';

/**
 * The Revenue page's period table as a CSV, for the page's dates and grouping
 * (docs/DECISIONS.md SA-27). The database checks the permission and the second
 * factor too.
 */
export async function GET(request: Request) {
  await requirePlatformPermission('money.view');
  const url = new URL(request.url);
  const params = readRevenueParams(Object.fromEntries(url.searchParams), todayInIndia());
  const report = await getRevenueReport(params.from, params.to, params.by, false);

  return new Response(toCsv(revenueCsv(report)), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${csvFilename('revenue', params.from, params.to)}"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
