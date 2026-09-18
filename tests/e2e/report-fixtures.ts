import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { staffEmail } from '../../src/lib/auth/staff-email';
import type { Database } from '../../src/types/database';
import { adminClient, TEST_PASSWORD } from './helpers';
import { type LiveRestaurant, placeCustomerOrder } from './live-fixtures';

/**
 * Report tests need billed tables. The data is made the way the app makes it —
 * a customer order, a waiter, served dishes, a bill and a payment — so bills,
 * audit rows and waiter history are all real (spec §19 Phase 6).
 */

/** A supabase client signed in as the restaurant's owner, for calling the RPCs. */
export async function ownerClient(restaurant: { slug: string }): Promise<SupabaseClient<Database>> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new Error('E2E needs the Supabase URL and publishable key');
  const client = createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error } = await client.auth.signInWithPassword({
    email: staffEmail(
      'owner',
      restaurant.slug,
      process.env.STAFF_EMAIL_DOMAIN || 'tableorder.test',
    ),
    password: TEST_PASSWORD,
  });
  if (error) throw new Error(`Could not sign the owner in: ${error.message}`);
  return client;
}

export type BillOptions = {
  /** Which fixture table to seat (labels '3', '4' or '5'). */
  table: string;
  quantity?: number;
  waiter?: string;
  /** Percent discount in basis points, with a reason. */
  discountBps?: number;
  discountReason?: string;
  payment?: { mode: 'cash' | 'upi' | 'card' | 'other'; reference?: string } | null;
};

export type BilledTable = {
  sessionId: string;
  orderId: string;
  itemId: string;
  billId: string;
  invoiceNumber: string;
  grandTotalPaise: number;
};

/** Seats a table, serves it and bills it, as the app would. */
export async function billTable(
  owner: SupabaseClient<Database>,
  restaurant: LiveRestaurant,
  options: BillOptions,
): Promise<BilledTable> {
  const { sessionId, orderId, itemId } = await seatTable(owner, restaurant, options);
  await owner.rpc('staff_mark_order_served', { p_order_id: orderId }).throwOnError();

  const { data: bill } = await owner
    .rpc('admin_generate_bill', {
      p_session_id: sessionId,
      p_discount_type: options.discountBps ? 'percent' : 'none',
      p_discount_value: options.discountBps ?? 0,
      p_discount_reason: options.discountReason ?? '',
      p_apply_service_charge: false,
    })
    .throwOnError();
  const generated = bill as { bill_id: string; invoice_number: string; grand_total_paise: number };

  const payment = options.payment === undefined ? { mode: 'cash' as const } : options.payment;
  if (payment) {
    await owner
      .rpc('admin_record_payment', {
        p_bill_id: generated.bill_id,
        p_payments: [
          {
            mode: payment.mode,
            amount_paise: generated.grand_total_paise,
            reference: payment.reference ?? null,
          },
        ],
      })
      .throwOnError();
  }

  return {
    sessionId,
    orderId,
    itemId,
    billId: generated.bill_id,
    invoiceNumber: generated.invoice_number,
    grandTotalPaise: generated.grand_total_paise,
  };
}

/** Seats a table with one accepted round and a waiter, without billing it. */
export async function seatTable(
  owner: SupabaseClient<Database>,
  restaurant: LiveRestaurant,
  options: Pick<BillOptions, 'table' | 'quantity' | 'waiter'>,
): Promise<{ sessionId: string; orderId: string; itemId: string }> {
  const table = restaurant.tables[options.table];
  if (!table) throw new Error(`No fixture table "${options.table}"`);
  const order = await placeCustomerOrder(table.token, [
    { menu_item_id: restaurant.item.paneer, quantity: options.quantity ?? 2 },
  ]);

  const db = adminClient();
  const { data: session } = await db
    .from('table_sessions')
    .select('id')
    .eq('dining_table_id', table.id)
    .eq('status', 'open')
    .single()
    .throwOnError();

  // Assigning the waiter also approves the first order (spec §10.7).
  await owner
    .rpc('admin_assign_waiter', {
      p_session_id: session!.id,
      p_waiter_id: options.waiter ?? restaurant.waiters.ravi,
      p_force: true,
    })
    .throwOnError();

  const { data: item } = await db
    .from('order_items')
    .select('id')
    .eq('order_id', order.order_id)
    .single()
    .throwOnError();

  return { sessionId: session!.id, orderId: order.order_id, itemId: item!.id };
}
