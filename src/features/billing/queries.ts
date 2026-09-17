import 'server-only';

import { createClient } from '@/lib/supabase/server';
import { dbErrorCode } from '@/lib/db-errors';

import {
  type BillDetail,
  type BillingSessions,
  fetchBillingSessions,
  parseBillDetail,
  parseSampleBill,
  parseTotalOrders,
  type PrintableBill,
  type TotalOrders,
} from './bill';
import type { TotalOrdersFilters } from './schemas';

/** Open tables to bill, for the first render; the browser keeps them fresh. */
export async function getBillingSessions(): Promise<BillingSessions> {
  return fetchBillingSessions(await createClient());
}

/** Where a session stands for billing: open, billed (with its bill) or gone. */
export async function getSessionBillingState(
  sessionId: string,
): Promise<{ state: 'open' } | { state: 'billed'; billId: string } | { state: 'closed' }> {
  const supabase = await createClient();
  const { error } = await supabase.rpc('admin_preview_bill', {
    p_session_id: sessionId,
    p_discount_type: 'none',
    p_discount_value: 0,
    p_apply_service_charge: false,
  });
  if (!error) return { state: 'open' };
  const code = dbErrorCode(error);
  if (code === 'ALREADY_BILLED' && error.details) return { state: 'billed', billId: error.details };
  if (code === 'SESSION_NOT_OPEN' || code === 'NOT_FOUND') return { state: 'closed' };
  throw new Error(`Could not load the table: ${error.message}`);
}

/** A bill with its payments and audit trail, or null when it isn't this restaurant's. */
export async function getBill(billId: string): Promise<BillDetail | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('admin_get_bill', { p_bill_id: billId });
  if (error) {
    if (dbErrorCode(error) === 'NOT_FOUND') return null;
    throw new Error(`Could not load the bill: ${error.message}`);
  }
  return parseBillDetail(data);
}

/** The sample bill for "Test print", with the saved settings. */
export async function getSampleBill(): Promise<PrintableBill> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('admin_sample_bill');
  if (error) throw new Error(`Could not build the sample bill: ${error.message}`);
  return parseSampleBill(data);
}

export async function getTotalOrders(filters: TotalOrdersFilters): Promise<TotalOrders> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('admin_total_orders', { p_filters: filters });
  if (error) throw new Error(`Could not load total orders: ${error.message}`);
  return parseTotalOrders(data);
}
