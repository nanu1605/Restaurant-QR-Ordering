'use server';

import { refresh } from 'next/cache';

import { imageExtension, MAX_IMAGE_BYTES, MENU_IMAGE_TYPES } from '@/features/menu/schemas';
import { notePlanLimit } from '@/features/plans/plan-limit-events';
import {
  actionError,
  actionOk,
  fromDbError,
  fromZodError,
  type ActionResult,
} from '@/lib/action-result';
import { getRestaurantAccess } from '@/lib/auth/access';
import { requireMember } from '@/lib/auth/guards';
import { ADMIN_PANEL_ROLES } from '@/lib/auth/roles';
import { dbErrorCode, dbErrorMessage, GENERIC_ERROR } from '@/lib/db-errors';
import { createClient } from '@/lib/supabase/server';

import {
  billTabSchema,
  orderingTabSchema,
  restaurantTabSchema,
  settingsPatch,
  taxTabSchema,
} from './schemas';

/** Restaurant settings (spec §13.3 Settings; admin_update_settings, docs/DECISIONS.md P2-14). */

export type SettingsTabName = 'restaurant' | 'tax' | 'bill' | 'ordering';

const SCHEMAS = {
  restaurant: restaurantTabSchema,
  tax: taxTabSchema,
  bill: billTabSchema,
  ordering: orderingTabSchema,
} as const;

// Database keys, codes and check constraints → the form field to highlight.
const FIELD_FOR: Record<string, string> = {
  name: 'name',
  email: 'email',
  pincode: 'pincode',
  restaurants_pincode_check: 'pincode',
  restaurants_name_check: 'name',
  restaurants_accent_color_check: 'accentColor',
  restaurants_gstin_check: 'gstin',
  restaurants_fssai_license_check: 'fssaiLicense',
  restaurants_gst_rate_bps_check: 'gstRateBps',
  restaurants_service_charge_bps_check: 'serviceChargePercent',
  restaurants_invoice_prefix_check: 'invoicePrefix',
  restaurants_bill_footer_text_check: 'billFooterText',
  restaurants_upi_vpa_check: 'upiVpa',
  restaurants_upi_payee_name_check: 'upiPayeeName',
  restaurants_customer_cancel_window_seconds_check: 'customerCancelWindowSeconds',
  restaurants_reopen_window_minutes_check: 'reopenWindowMinutes',
  restaurants_business_day_start_hour_check: 'businessDayStartHour',
  restaurants_max_tables_per_waiter_check: 'maxTablesPerWaiter',
  UPI_VPA_REQUIRED: 'upiVpa',
  FEATURE_NOT_IN_PLAN: 'showUpiQrOnBill',
};

export async function saveSettings(tab: SettingsTabName, values: unknown): Promise<ActionResult> {
  await requireMember(ADMIN_PANEL_ROLES);
  const schema = SCHEMAS[tab];
  if (!schema) return actionError(GENERIC_ERROR);
  const parsed = schema.safeParse(values);
  if (!parsed.success) return fromZodError(parsed.error);

  const supabase = await createClient();
  const { error } = await supabase.rpc('admin_update_settings', {
    p_patch: settingsPatch(tab, parsed.data),
  });
  if (error) {
    await notePlanLimit(error);
    const result = fromDbError(error, 'admin_update_settings');
    const code = dbErrorCode(error);
    const field = FIELD_FOR[error.details?.trim() || ''] ?? FIELD_FOR[code ?? ''];
    return field ? actionError(result.error, { [field]: result.error }) : result;
  }
  refresh();
  return actionOk();
}

/** Logo upload (compressed in the browser) to logos/<restaurant_id>/logo.<ext>. */
export async function uploadLogo(formData: FormData): Promise<ActionResult> {
  const membership = await requireMember(ADMIN_PANEL_ROLES);
  const file = formData.get('logo');
  if (!(file instanceof File) || file.size === 0) return actionError('Choose an image.');
  if (!(MENU_IMAGE_TYPES as readonly string[]).includes(file.type)) {
    return actionError('Upload a JPG, PNG or WebP image.');
  }
  if (file.size > MAX_IMAGE_BYTES) return actionError('Images must be 1 MB or smaller.');

  const access = await getRestaurantAccess(membership.restaurant.id);
  if (access.state !== 'full') {
    return actionError(dbErrorMessage({ code: 'P0001', message: 'RESTAURANT_READ_ONLY' })!);
  }

  const supabase = await createClient();
  const logos = supabase.storage.from('logos');
  const { data: current } = await supabase
    .from('restaurants')
    .select('logo_path')
    .eq('id', membership.restaurant.id)
    .single();
  const path = `${membership.restaurant.id}/logo.${imageExtension(file.type)}`;

  const { error: uploadError } = await logos.upload(path, file, {
    upsert: true,
    contentType: file.type,
    cacheControl: '3600',
  });
  if (uploadError) {
    console.error('Logo upload failed:', uploadError.message);
    return actionError('The logo could not be uploaded. Try again.');
  }

  const { error } = await supabase.rpc('admin_update_settings', { p_patch: { logo_path: path } });
  if (error) return fromDbError(error, 'admin_update_settings');

  if (current?.logo_path && current.logo_path !== path) {
    await logos.remove([current.logo_path]);
  }
  refresh();
  return actionOk();
}

export async function removeLogo(): Promise<ActionResult> {
  const membership = await requireMember(ADMIN_PANEL_ROLES);
  const supabase = await createClient();
  const { data: current } = await supabase
    .from('restaurants')
    .select('logo_path')
    .eq('id', membership.restaurant.id)
    .single();
  if (!current?.logo_path) return actionOk();

  const { error } = await supabase.rpc('admin_update_settings', { p_patch: { logo_path: null } });
  if (error) return fromDbError(error, 'admin_update_settings');
  const { error: removeError } = await supabase.storage.from('logos').remove([current.logo_path]);
  if (removeError) console.error('Old logo not removed:', removeError.message);
  refresh();
  return actionOk();
}
