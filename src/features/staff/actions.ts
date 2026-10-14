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
import { ADMIN_PANEL_ROLES, STAFF_PANEL_ROLES } from '@/lib/auth/roles';
import { getCurrentUser } from '@/lib/auth/session';
import { GENERIC_ERROR } from '@/lib/db-errors';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';

import { createStaffLogin } from './create-login';
import {
  editStaffSchema,
  newStaffSchema,
  resetPasswordSchema,
  type EditStaff,
  type NewStaff,
  type ResetPassword,
  uiLangSchema,
} from './schemas';

/**
 * Staff logins (spec §9.5, §13.3; docs/DECISIONS.md P2-5). Creating a login
 * and setting passwords need the Supabase Admin API, so those run with the
 * service role after the caller is verified; everything else runs as the
 * signed-in manager and the database checks the role hierarchy.
 */

const memberIdSchema = z.uuid();

export async function createStaff(input: NewStaff): Promise<ActionResult<{ memberId: string }>> {
  const membership = await requireMember(ADMIN_PANEL_ROLES);
  const user = await getCurrentUser();
  const parsed = newStaffSchema.safeParse(input);
  if (!parsed.success) return fromZodError(parsed.error);
  if (!user) return actionError(GENERIC_ERROR);

  // The actor comes from the verified session, never from the client.
  const created = await createStaffLogin(membership, user.id, parsed.data);
  if (!created.ok) return created;

  refresh();
  return actionOk({ memberId: created.memberId });
}

export async function updateStaff(memberId: string, input: EditStaff): Promise<ActionResult> {
  await requireMember(ADMIN_PANEL_ROLES);
  const parsedId = memberIdSchema.safeParse(memberId);
  const parsed = editStaffSchema.safeParse(input);
  if (!parsedId.success) return actionError(GENERIC_ERROR);
  if (!parsed.success) return fromZodError(parsed.error);

  const supabase = await createClient();
  const { error } = await supabase.rpc('admin_update_staff', {
    p_member_id: parsedId.data,
    p_patch: {
      display_name: parsed.data.displayName,
      role: parsed.data.role,
      ...(parsed.data.uiLang ? { ui_lang: parsed.data.uiLang } : {}),
    },
  });
  if (error) return fromDbError(error, 'admin_update_staff');
  refresh();
  return actionOk();
}

export async function setStaffActive(memberId: string, active: boolean): Promise<ActionResult> {
  await requireMember(ADMIN_PANEL_ROLES);
  const parsedId = memberIdSchema.safeParse(memberId);
  if (!parsedId.success || typeof active !== 'boolean') return actionError(GENERIC_ERROR);

  const supabase = await createClient();
  const { error } = active
    ? await supabase.rpc('admin_reactivate_staff', { p_member_id: parsedId.data })
    : await supabase.rpc('admin_deactivate_staff', { p_member_id: parsedId.data });
  if (error) {
    await notePlanLimit(error);
    return fromDbError(error, active ? 'admin_reactivate_staff' : 'admin_deactivate_staff');
  }
  refresh();
  return actionOk();
}

/** Owners and managers set a new password for staff (no email flow, spec §9.5). */
export async function resetStaffPassword(
  memberId: string,
  input: ResetPassword,
): Promise<ActionResult> {
  await requireMember(ADMIN_PANEL_ROLES);
  const parsedId = memberIdSchema.safeParse(memberId);
  const parsed = resetPasswordSchema.safeParse(input);
  if (!parsedId.success) return actionError(GENERIC_ERROR);
  if (!parsed.success) return fromZodError(parsed.error);

  // The database checks the hierarchy and logs the reset first.
  const supabase = await createClient();
  const { data: userId, error } = await supabase.rpc('admin_reset_staff_password', {
    p_member_id: parsedId.data,
  });
  if (error) return fromDbError(error, 'admin_reset_staff_password');

  const { error: updateError } = await createAdminClient().auth.admin.updateUserById(userId, {
    password: parsed.data.password,
  });
  if (updateError) {
    if (updateError.code === 'weak_password') {
      const message = 'Choose a longer, harder to guess password.';
      return actionError(message, { password: message });
    }
    console.error('Password not updated:', updateError.code, updateError.message);
    return actionError(GENERIC_ERROR);
  }
  return actionOk();
}

/**
 * The signed-in login's own worker panel language, from its account menu
 * (docs/DECISIONS.md P11-15); the panel then draws again in it.
 */
export async function setMyLanguage(lang: string): Promise<ActionResult> {
  await requireMember(STAFF_PANEL_ROLES);
  const parsed = uiLangSchema.safeParse(lang);
  if (!parsed.success) return actionError(GENERIC_ERROR);
  const supabase = await createClient();
  const { error } = await supabase.rpc('member_set_ui_lang', { p_lang: parsed.data });
  if (error) return fromDbError(error, 'member_set_ui_lang');
  refresh();
  return actionOk();
}
