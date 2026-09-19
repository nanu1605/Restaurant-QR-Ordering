import { hasFeature } from '@/features/plans/plan-features';
import { getPlanFeatures } from '@/features/plans/queries';
import {
  activityCsv,
  categoriesCsv,
  type CsvTable,
  csvFilename,
  hoursCsv,
  itemsCsv,
  salesCsv,
  tablesCsv,
  toCsv,
  waitersCsv,
} from '@/features/reports/csv';
import {
  getActivityReport,
  getItemsReport,
  getSalesReport,
  getTablesReport,
  getWaiterReport,
  ReportError,
} from '@/features/reports/queries';
import { ACTIVITY_KINDS, type ActivityKind } from '@/features/reports/report';
import { ADMIN_PANEL_ROLES } from '@/lib/auth/roles';
import { getCurrentMembership } from '@/lib/auth/session';
import { daysBetween, isDate, MAX_RANGE_DAYS } from '@/lib/date-range';

/**
 * CSV downloads of the reports (spec §19 Phase 6, plan feature csv_export;
 * docs/DECISIONS.md P6-13). The report functions apply the same plan rules,
 * so a Starter restaurant gets nothing even by typing the URL.
 */

const REPORTS = ['sales', 'hours', 'items', 'categories', 'tables', 'waiters', 'activity'] as const;

type CsvReport = (typeof REPORTS)[number];

export async function GET(request: Request) {
  const membership = await getCurrentMembership();
  if (!membership || !(ADMIN_PANEL_ROLES as readonly string[]).includes(membership.role)) {
    return new Response('Not allowed', { status: 403 });
  }
  const plan = await getPlanFeatures(membership.restaurant.id);
  if (!hasFeature(plan, 'csv_export')) {
    return new Response('CSV downloads are available on Growth', { status: 403 });
  }

  const url = new URL(request.url);
  const report = url.searchParams.get('report') ?? '';
  if (!(REPORTS as readonly string[]).includes(report)) {
    return new Response('Unknown report', { status: 404 });
  }
  const kindParam = url.searchParams.get('kind') ?? '';
  const kind: ActivityKind = (ACTIVITY_KINDS as readonly string[]).includes(kindParam)
    ? (kindParam as ActivityKind)
    : 'voids_discounts';
  const from = url.searchParams.get('from') || undefined;
  const to = url.searchParams.get('to') || undefined;
  // The same range rules as the page: an end needs a start, and at most a year.
  const badRange =
    (from !== undefined && !isDate(from)) ||
    (to !== undefined && (!isDate(to) || from === undefined)) ||
    (from !== undefined &&
      to !== undefined &&
      (to < from || daysBetween(from, to) > MAX_RANGE_DAYS));
  if (badRange) return new Response('Those dates are not right', { status: 400 });
  const filters: Filters = { from, to, export: true };

  let built: Awaited<ReturnType<typeof build>>;
  try {
    built = await build(report as CsvReport, filters, kind, membership.restaurant.timezone);
  } catch (error) {
    if (error instanceof ReportError && error.code === 'INVALID_INPUT') {
      return new Response('Those dates are not right', { status: 400 });
    }
    throw error;
  }
  if (!built) return new Response('That report is not in your plan', { status: 403 });

  return new Response(toCsv(built.table), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${csvFilename(built.name, built.from, built.to)}"`,
      'Cache-Control': 'private, no-store',
    },
  });
}

type Filters = { from?: string; to?: string; export: true };

async function build(
  report: CsvReport,
  filters: Filters,
  kind: ActivityKind,
  timeZone: string,
): Promise<{ table: CsvTable; name: string; from: string; to: string } | null> {
  if (report === 'sales' || report === 'hours') {
    const sales = await getSalesReport(filters);
    if (!sales) return null;
    return {
      table: report === 'sales' ? salesCsv(sales) : hoursCsv(sales),
      name: report,
      from: sales.from,
      to: sales.to,
    };
  }
  if (report === 'items' || report === 'categories') {
    const items = await getItemsReport(filters);
    if (!items) return null;
    return {
      table: report === 'items' ? itemsCsv(items) : categoriesCsv(items),
      name: report === 'items' ? 'dishes' : 'categories',
      from: items.from,
      to: items.to,
    };
  }
  if (report === 'tables') {
    const tables = await getTablesReport(filters);
    if (!tables) return null;
    return { table: tablesCsv(tables), name: 'tables', from: tables.from, to: tables.to };
  }
  if (report === 'waiters') {
    const waiters = await getWaiterReport(filters);
    if (!waiters) return null;
    return { table: waitersCsv(waiters), name: 'waiters', from: waiters.from, to: waiters.to };
  }
  const activity = await getActivityReport({ ...filters, kind });
  if (!activity) return null;
  return {
    table: activityCsv(activity, timeZone),
    name: kind.replaceAll('_', '-'),
    from: activity.from,
    to: activity.to,
  };
}
