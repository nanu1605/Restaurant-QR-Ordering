import 'server-only';

import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js';

import { dbErrorCode } from '@/lib/db-errors';
import { createClient } from '@/lib/supabase/server';
import type { Database } from '@/types/database';

import type { ActivityKind } from './report';
import {
  type ActivityReport,
  type ItemsReport,
  parseActivityReport,
  parseItemsReport,
  parseSalesReport,
  parseTablesReport,
  parseWaiterReport,
  type SalesReport,
  type TablesReport,
  type WaiterReport,
} from './report';

/**
 * Report data for the admin pages (spec §13.3). A report the plan doesn't
 * include comes back as null, so the page can show the upgrade hint instead
 * of failing (the database refuses it either way).
 */

export type ReportFilters = {
  from?: string;
  to?: string;
  kind?: ActivityKind;
  page?: number;
  export?: boolean;
};

type ReportFunction =
  | 'admin_report_sales'
  | 'admin_report_items'
  | 'admin_report_tables'
  | 'admin_report_waiters'
  | 'admin_report_activity';

/** A report the database refused, with its error code (e.g. INVALID_INPUT). */
export class ReportError extends Error {
  readonly code: string | null;

  constructor(error: PostgrestError) {
    super(`Could not load the report: ${error.message}`);
    this.name = 'ReportError';
    this.code = dbErrorCode(error);
  }
}

async function callReport(
  name: ReportFunction,
  filters: ReportFilters,
  client?: SupabaseClient<Database>,
): Promise<unknown | null> {
  const supabase = client ?? (await createClient());
  const { data, error } = await supabase.rpc(name, { p_filters: filters });
  if (!error) return data;
  if (dbErrorCode(error) === 'FEATURE_NOT_IN_PLAN') return null;
  throw new ReportError(error);
}

export async function getSalesReport(
  filters: ReportFilters = {},
  client?: SupabaseClient<Database>,
): Promise<SalesReport | null> {
  const data = await callReport('admin_report_sales', filters, client);
  return data === null ? null : parseSalesReport(data);
}

export async function getItemsReport(filters: ReportFilters = {}): Promise<ItemsReport | null> {
  const data = await callReport('admin_report_items', filters);
  return data === null ? null : parseItemsReport(data);
}

export async function getTablesReport(filters: ReportFilters = {}): Promise<TablesReport | null> {
  const data = await callReport('admin_report_tables', filters);
  return data === null ? null : parseTablesReport(data);
}

export async function getWaiterReport(filters: ReportFilters = {}): Promise<WaiterReport | null> {
  const data = await callReport('admin_report_waiters', filters);
  return data === null ? null : parseWaiterReport(data);
}

export async function getActivityReport(
  filters: ReportFilters = {},
): Promise<ActivityReport | null> {
  const data = await callReport('admin_report_activity', filters);
  return data === null ? null : parseActivityReport(data);
}
