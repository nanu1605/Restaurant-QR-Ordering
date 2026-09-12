import 'server-only';

import { cache } from 'react';

import { createClient } from '@/lib/supabase/server';
import type { Tables } from '@/types/database';

export type RestaurantSettings = Pick<
  Tables<'restaurants'>,
  | 'id'
  | 'name'
  | 'slug'
  | 'legal_name'
  | 'address_line'
  | 'city'
  | 'state'
  | 'pincode'
  | 'phone'
  | 'email'
  | 'logo_path'
  | 'accent_color'
  | 'gstin'
  | 'fssai_license'
  | 'gst_mode'
  | 'gst_rate_bps'
  | 'prices_include_tax'
  | 'service_charge_enabled'
  | 'service_charge_bps'
  | 'invoice_prefix'
  | 'bill_footer_text'
  | 'paper_width'
  | 'show_upi_qr_on_bill'
  | 'upi_vpa'
  | 'upi_payee_name'
  | 'require_first_order_approval'
  | 'customer_cancel_window_seconds'
  | 'max_tables_per_waiter'
  | 'staff_can_remove_served_items'
  | 'print_waiter_on_bill'
  | 'reopen_window_minutes'
  | 'business_day_start_hour'
  | 'timezone'
  | 'updated_at'
>;

const COLUMNS =
  'id, name, slug, legal_name, address_line, city, state, pincode, phone, email, logo_path, accent_color, gstin, fssai_license, gst_mode, gst_rate_bps, prices_include_tax, service_charge_enabled, service_charge_bps, invoice_prefix, bill_footer_text, paper_width, show_upi_qr_on_bill, upi_vpa, upi_payee_name, require_first_order_approval, customer_cancel_window_seconds, max_tables_per_waiter, staff_can_remove_served_items, print_waiter_on_bill, reopen_window_minutes, business_day_start_hour, timezone, updated_at';

/** The signed-in member's restaurant settings (RLS-scoped), once per request. */
export const getRestaurantSettings = cache(
  async (restaurantId: string): Promise<RestaurantSettings> => {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from('restaurants')
      .select(COLUMNS)
      .eq('id', restaurantId)
      .single();
    if (error) throw new Error(`Could not load restaurant settings: ${error.message}`);
    return data;
  },
);
