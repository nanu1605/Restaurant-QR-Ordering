'use server';

import { refresh } from 'next/cache';
import { z } from 'zod';

import { notePlanLimit } from '@/features/plans/plan-limit-events';
import {
  actionError,
  actionOk,
  fromDbError,
  fromZodError,
  type ActionResult,
} from '@/lib/action-result';
import { requireMember } from '@/lib/auth/guards';
import { ADMIN_PANEL_ROLES } from '@/lib/auth/roles';
import { dbErrorCode, dbErrorMessage } from '@/lib/db-errors';
import { createClient } from '@/lib/supabase/server';

import {
  generateBillSchema,
  recordPaymentSchema,
  voidBillSchema,
  type GenerateBillInput,
  type RecordPaymentInput,
  type VoidBillInput,
} from './schemas';

/**
 * Billing actions for managers and owners (spec §9.3, §10.5, §13.3). The
 * database functions own the rules; these validate and map errors.
 */

export type GenerateBillResult =
  | { ok: true; data: { billId: string; alreadyBilled: boolean } }
  | { ok: false; error: string; changed?: boolean };

const generatedJson = z.object({ bill_id: z.uuid() });

/**
 * Generates the bill. If someone billed the table meanwhile, their bill is
 * returned so the screen can open it instead.
 */
export async function generateBill(input: GenerateBillInput): Promise<GenerateBillResult> {
  await requireMember(ADMIN_PANEL_ROLES);
  const parsed = generateBillSchema.safeParse(input);
  if (!parsed.success) return fromZodError(parsed.error);
  const {
    sessionId,
    discountType,
    discountValue,
    discountReason,
    applyServiceCharge,
    expectedGrandTotalPaise,
  } = parsed.data;

  const supabase = await createClient();
  const { data, error } = await supabase.rpc('admin_generate_bill', {
    p_session_id: sessionId,
    p_discount_type: discountType,
    p_discount_value: discountType === 'none' ? 0 : discountValue,
    p_discount_reason: discountReason,
    p_apply_service_charge: applyServiceCharge,
    p_expected_grand_total_paise: expectedGrandTotalPaise,
  });
  if (error) {
    if (dbErrorCode(error) === 'ALREADY_BILLED' && error.details) {
      return actionOk({ billId: error.details, alreadyBilled: true });
    }
    if (dbErrorCode(error) === 'BILL_CHANGED') {
      return { ok: false, error: dbErrorMessage(error)!, changed: true };
    }
    await notePlanLimit(error);
    return fromDbError(error, 'admin_generate_bill');
  }
  return actionOk({ billId: generatedJson.parse(data).bill_id, alreadyBilled: false });
}

export async function recordPayment(input: RecordPaymentInput): Promise<ActionResult> {
  await requireMember(ADMIN_PANEL_ROLES);
  const parsed = recordPaymentSchema.safeParse(input);
  if (!parsed.success) return fromZodError(parsed.error);
  const supabase = await createClient();
  const { error } = await supabase.rpc('admin_record_payment', {
    p_bill_id: parsed.data.billId,
    p_payments: parsed.data.payments.map((payment) => ({
      mode: payment.mode,
      amount_paise: payment.amountPaise,
      reference: payment.reference || null,
    })),
  });
  // Refused or not, show the bill as it is now (someone may have paid or voided it).
  refresh();
  if (error) {
    await notePlanLimit(error);
    return fromDbError(error, 'admin_record_payment');
  }
  return actionOk();
}

export async function voidBill(input: VoidBillInput): Promise<ActionResult<{ reopened: boolean }>> {
  await requireMember(ADMIN_PANEL_ROLES);
  const parsed = voidBillSchema.safeParse(input);
  if (!parsed.success) return fromZodError(parsed.error);
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('admin_void_bill', {
    p_bill_id: parsed.data.billId,
    p_reason: parsed.data.reason,
    p_reopen: parsed.data.reopen,
  });
  refresh();
  if (error) return fromDbError(error, 'admin_void_bill');
  return actionOk({ reopened: z.object({ reopened: z.boolean() }).parse(data).reopened });
}

/** Counts a print (spec §15). Failing to count never blocks printing. */
export async function incrementPrintCount(billId: string): Promise<ActionResult> {
  await requireMember(ADMIN_PANEL_ROLES);
  if (!z.uuid().safeParse(billId).success) {
    return actionError(dbErrorMessage({ code: 'P0001', message: 'INVALID_INPUT' })!);
  }
  const supabase = await createClient();
  const { error } = await supabase.rpc('admin_increment_print_count', { p_bill_id: billId });
  if (error) return fromDbError(error, 'admin_increment_print_count');
  return actionOk();
}
