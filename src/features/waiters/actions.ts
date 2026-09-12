'use server';

import { refresh } from 'next/cache';
import { z } from 'zod';

import { createStaffLogin, removeNewStaffLogin } from '@/features/staff/create-login';
import {
  actionError,
  actionOk,
  fromDbError,
  fromZodError,
  type ActionResult,
} from '@/lib/action-result';
import { requireMember } from '@/lib/auth/guards';
import { ADMIN_PANEL_ROLES } from '@/lib/auth/roles';
import { getCurrentUser } from '@/lib/auth/session';
import { dbErrorCode, GENERIC_ERROR } from '@/lib/db-errors';
import { createClient } from '@/lib/supabase/server';

import { normalizeIndianMobile, waiterFormSchema, type WaiterForm } from './schemas';

/** Waiter profiles (spec §13.3 Waiters; admin_upsert_waiter and friends, §9.3). */

// Database codes that belong to one form field.
const FIELD_FOR_CODE: Record<string, string> = {
  WAITER_CODE_TAKEN: 'employeeCode',
  INVALID_PHONE: 'phone',
  INVALID_WAITER_NAME: 'fullName',
  LOGIN_NOT_WAITER: 'memberId',
  LOGIN_ALREADY_LINKED: 'memberId',
};

export async function saveWaiter(input: WaiterForm): Promise<ActionResult<{ id: string }>> {
  const membership = await requireMember(ADMIN_PANEL_ROLES);
  const user = await getCurrentUser();
  const parsed = waiterFormSchema.safeParse(input);
  if (!parsed.success) return fromZodError(parsed.error);
  if (!user) return actionError(GENERIC_ERROR);
  const waiter = parsed.data;

  // "Create a login for this waiter": a waiter-role login, linked below.
  let memberId: string | null = waiter.loginMode === 'link' ? waiter.memberId : null;
  let newLoginUserId: string | null = null;
  if (waiter.loginMode === 'create') {
    const created = await createStaffLogin(membership, user.id, {
      displayName: waiter.fullName,
      username: waiter.username.trim().toLowerCase(),
      role: 'waiter',
      password: waiter.password,
    });
    if (!created.ok) return created;
    memberId = created.memberId;
    newLoginUserId = created.userId;
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc('admin_upsert_waiter', {
    p_waiter: {
      ...(waiter.id ? { id: waiter.id } : {}),
      full_name: waiter.fullName,
      phone: waiter.phone ? normalizeIndianMobile(waiter.phone) : null,
      employee_code: waiter.employeeCode || null,
      joined_on: waiter.joinedOn || null,
      notes: waiter.notes || null,
      member_id: memberId,
    },
  });
  if (error) {
    // Don't leave a login behind for a waiter that wasn't saved.
    if (newLoginUserId) await removeNewStaffLogin(newLoginUserId);
    const result = fromDbError(error, 'admin_upsert_waiter');
    const field = FIELD_FOR_CODE[dbErrorCode(error) ?? ''];
    return field ? actionError(result.error, { [field]: result.error }) : result;
  }

  refresh();
  return actionOk({ id: data });
}

/** Shift start/end or leave; allowed while read-only (spec §10.7). */
export async function setWaiterOnDuty(id: string, onDuty: boolean): Promise<ActionResult> {
  await requireMember(ADMIN_PANEL_ROLES);
  const parsed = z.object({ id: z.uuid(), onDuty: z.boolean() }).safeParse({ id, onDuty });
  if (!parsed.success) return actionError(GENERIC_ERROR);

  const supabase = await createClient();
  const { error } = await supabase.rpc('admin_set_waiter_on_duty', {
    p_waiter_id: parsed.data.id,
    p_on_duty: parsed.data.onDuty,
  });
  if (error) return fromDbError(error, 'admin_set_waiter_on_duty');
  refresh();
  return actionOk();
}

/** Soft delete; blocked while the waiter has open tables ("Reassign Table 3 first"). */
export async function deleteWaiter(id: string): Promise<ActionResult> {
  await requireMember(ADMIN_PANEL_ROLES);
  const parsed = z.uuid().safeParse(id);
  if (!parsed.success) return actionError(GENERIC_ERROR);

  const supabase = await createClient();
  const { error } = await supabase.rpc('admin_delete_waiter', { p_waiter_id: parsed.data });
  if (error) return fromDbError(error, 'admin_delete_waiter');
  refresh();
  return actionOk();
}
