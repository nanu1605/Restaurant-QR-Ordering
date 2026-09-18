import { ChartColumn } from 'lucide-react';
import type { Metadata } from 'next';

import { EmptyState } from '@/components/shared/empty-state';
import { PageHeader } from '@/components/shared/page-header';
import { hasFeature, upgradeHint } from '@/features/plans/plan-features';
import { getPlanFeatures } from '@/features/plans/queries';
import {
  REPORT_FEATURE,
  REPORT_LABELS,
  readReportParams,
  type ReportKey,
} from '@/features/reports/params';
import {
  getActivityReport,
  getItemsReport,
  getSalesReport,
  getTablesReport,
} from '@/features/reports/queries';
import { ActivityReportView } from '@/features/reports/components/activity-report';
import { ItemsReportView } from '@/features/reports/components/items-report';
import {
  ActivityKindTabs,
  ExportLink,
  ReportPager,
  ReportRange,
  ReportTabs,
} from '@/features/reports/components/report-nav';
import { TablesReportView } from '@/features/reports/components/tables-report';
import {
  PaymentModes,
  SalesHeatmap,
  SalesSummary,
  SalesTrend,
} from '@/features/reports/components/sales-report';
import { requireMember } from '@/lib/auth/guards';
import { ADMIN_PANEL_ROLES } from '@/lib/auth/roles';

export const metadata: Metadata = {
  title: 'Reports',
};

const STARTER_RANGE_NOTICE = 'Your plan shows today and yesterday, so today is shown.';

/** Reports (spec §13.3, §19 Phase 6): sales, dishes, tables, waiters and activity. */
export default async function ReportsPage({ searchParams }: PageProps<'/admin/reports'>) {
  const membership = await requireMember(ADMIN_PANEL_ROLES);
  const plan = await getPlanFeatures(membership.restaurant.id);
  const params = readReportParams(await searchParams);
  const canExport = hasFeature(plan, 'csv_export');
  const allowed = Object.fromEntries(
    Object.entries(REPORT_FEATURE).map(([report, feature]) => [
      report,
      report === 'sales' || hasFeature(plan, feature),
    ]),
  ) as Record<ReportKey, boolean>;

  const filters = { from: params.range.from, to: params.range.to };
  const open = allowed[params.report];
  let notice = params.notice;
  let sales = params.report === 'sales' ? await getSalesReport(filters) : null;
  if (params.report === 'sales' && !sales) {
    // Starter asked for a range its plan doesn't cover: fall back to today.
    sales = await getSalesReport();
    notice = STARTER_RANGE_NOTICE;
  }
  const items = open && params.report === 'items' ? await getItemsReport(filters) : null;
  const tables = open && params.report === 'tables' ? await getTablesReport(filters) : null;
  const activity =
    open && params.report === 'activity'
      ? await getActivityReport({ ...filters, kind: params.kind, page: params.page })
      : null;
  const range = sales ?? items ?? tables ?? activity;

  return (
    <>
      <PageHeader
        title="Reports"
        description="How the restaurant is doing, by business day in your timezone."
      />
      <ReportTabs params={params} allowed={allowed} />

      {notice && (
        <p
          role="status"
          className="rounded-lg border-2 border-attention bg-surface p-3 text-base text-ink"
        >
          {notice}
        </p>
      )}

      {params.report === 'sales' && sales && (
        <>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <ReportRange
              params={params}
              today={sales.today}
              from={sales.from}
              to={sales.to}
              basic={sales.basic}
            />
            {!sales.basic && (
              <ExportLink
                report="sales"
                from={sales.from}
                to={sales.to}
                label="Sales CSV"
                canExport={canExport}
              />
            )}
          </div>
          <SalesSummary report={sales} />
          {sales.basic ? (
            <EmptyState
              icon={ChartColumn}
              title="More reports on Growth"
              description={`${upgradeHint('advanced_reports')}. Growth adds payment modes, dishes, tables, waiters, busy hours and CSV downloads.`}
            />
          ) : (
            <>
              <PaymentModes report={sales} />
              <SalesTrend report={sales} />
              <SalesHeatmap report={sales} />
            </>
          )}
        </>
      )}

      {range && params.report !== 'sales' && (
        <div className="flex flex-wrap items-end justify-between gap-3">
          <ReportRange params={params} today={range.today} from={range.from} to={range.to} />
          <div className="flex flex-wrap gap-2">
            {items && (
              <>
                <ExportLink
                  report="items"
                  from={range.from}
                  to={range.to}
                  label="Dishes CSV"
                  canExport={canExport}
                />
                <ExportLink
                  report="categories"
                  from={range.from}
                  to={range.to}
                  label="Categories CSV"
                  canExport={canExport}
                />
              </>
            )}
            {tables && (
              <ExportLink
                report="tables"
                from={range.from}
                to={range.to}
                label="Tables CSV"
                canExport={canExport}
              />
            )}
            {activity && (
              <ExportLink
                report="activity"
                from={range.from}
                to={range.to}
                kind={params.kind}
                label="Activity CSV"
                canExport={canExport}
              />
            )}
          </div>
        </div>
      )}

      {items && <ItemsReportView report={items} />}
      {tables && <TablesReportView report={tables} />}
      {activity && (
        <>
          <ActivityKindTabs params={params} />
          <ActivityReportView report={activity} timezone={membership.restaurant.timezone} />
          <ReportPager
            params={params}
            page={activity.page}
            pageSize={activity.pageSize}
            total={activity.total}
          />
        </>
      )}

      {params.report !== 'sales' && !allowed[params.report] && (
        <EmptyState
          icon={ChartColumn}
          title={`${REPORT_LABELS[params.report]} report`}
          description={`${upgradeHint(REPORT_FEATURE[params.report])}. Ask the owner to upgrade to see this report.`}
        />
      )}
    </>
  );
}
