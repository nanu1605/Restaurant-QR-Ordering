import type { FeatureKey } from '@/features/plans/plan-features';
import {
  type DateRange,
  firstParam,
  hrefWithParams,
  readDateRange,
  type SearchParams,
} from '@/lib/date-range';

import { ACTIVITY_KINDS, type ActivityKind } from './report';

/** Which report the page shows, and the range it covers (spec §13.3 Reports). */

export const REPORTS = ['sales', 'items', 'tables', 'waiters', 'activity'] as const;

export type ReportKey = (typeof REPORTS)[number];

export const REPORT_LABELS: Record<ReportKey, string> = {
  sales: 'Sales',
  items: 'Dishes',
  tables: 'Tables',
  waiters: 'Waiters',
  activity: 'Activity',
};

/** The plan feature each report needs (docs/DECISIONS.md P6-9). */
export const REPORT_FEATURE: Record<ReportKey, FeatureKey> = {
  sales: 'advanced_reports',
  items: 'advanced_reports',
  tables: 'advanced_reports',
  waiters: 'waiter_reports',
  activity: 'advanced_reports',
};

export const REPORTS_PATH = '/admin/reports';

export type ReportParams = {
  report: ReportKey;
  range: DateRange;
  kind: ActivityKind;
  page: number;
  notice: string | null;
};

/** The report page's URL, read leniently: bad values fall back with a note. */
export function readReportParams(params: SearchParams): ReportParams {
  const { range, notice } = readDateRange(params, 'Reports');
  const report = firstParam(params, 'report');
  const kind = firstParam(params, 'kind');
  const page = Number(firstParam(params, 'page'));
  return {
    report: (REPORTS as readonly string[]).includes(report ?? '') ? (report as ReportKey) : 'sales',
    range,
    kind: (ACTIVITY_KINDS as readonly string[]).includes(kind ?? '')
      ? (kind as ActivityKind)
      : 'voids_discounts',
    page: Number.isInteger(page) && page > 1 && page <= 10_000 ? page : 1,
    notice,
  };
}

type HrefParams = Partial<{
  report: ReportKey;
  from: string;
  to: string;
  kind: ActivityKind;
  page: number;
}>;

/** A link to another report, range or page, keeping the rest of the URL. */
export function reportHref(current: ReportParams, changes: HrefParams = {}): string {
  const report = changes.report ?? current.report;
  const kind = changes.kind ?? current.kind;
  const page = changes.page ?? (changes.report || changes.from || changes.kind ? 1 : current.page);
  return hrefWithParams(REPORTS_PATH, {
    report: report === 'sales' ? undefined : report,
    from: 'from' in changes ? changes.from : current.range.from,
    to: 'to' in changes ? changes.to : current.range.to,
    kind: report === 'activity' && kind !== 'voids_discounts' ? kind : undefined,
    page: page > 1 ? String(page) : undefined,
  });
}

/** The CSV download link for a report (docs/DECISIONS.md P6-13). */
export function exportHref(report: string, range: DateRange, kind?: ActivityKind): string {
  return hrefWithParams(`${REPORTS_PATH}/export`, {
    report,
    from: range.from,
    to: range.to,
    kind,
  });
}
