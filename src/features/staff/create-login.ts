import 'server-only';

import { actionError, fromDbError } from '@/lib/action-result';
import { canManageRole, type StaffLoginRole } from '@/lib/auth/roles';
import type { CurrentMembership } from '@/lib/auth/session';
import { staffEmail } from '@/lib/auth/staff-email';
import { dbErrorCode, GENERIC_ERROR } from '@/lib/db-errors';
import { getServerEnv } from '@/lib/env.server';
import { createAdminClient } from '@/lib/supabase/admin';

type NewLogin = {
  displayName: string;
  username: string;
  role: StaffLoginRole;
  password: string;
};

type Created = { ok: true; memberId: string; userId: string };
type Failed = ReturnType<typeof actionError>;

function authErrorMessage(code: string | undefined, username: string): string | null {
  if (code === 'email_exists' || code === 'user_already_exists') {
    return `The username “${username}” is already taken.`;
  }
  if (code === 'weak_password') return 'Choose a longer, harder to guess password.';
  return null;
}

/**
 * Creates a staff login (docs/DECISIONS.md P2-5): the auth user through the
 * Admin API, then the membership through admin_create_staff as the verified
 * actor. If the database refuses, the auth user is deleted again.
 */
export async function createStaffLogin(
  membership: CurrentMembership,
  actorUserId: string,
  login: NewLogin,
): Promise<Created | Failed> {
  if (!canManageRole(membership.role, login.role)) {
    return actionError("You can't add logins with that role.");
  }

  const admin = createAdminClient();
  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email: staffEmail(
      login.username,
      membership.restaurant.slug,
      getServerEnv().STAFF_EMAIL_DOMAIN,
    ),
    password: login.password,
    email_confirm: true,
    user_metadata: { display_name: login.displayName },
  });
  if (createError || !created.user) {
    const message = authErrorMessage(createError?.code, login.username);
    if (message) {
      return actionError(message, {
        [createError?.code === 'weak_password' ? 'password' : 'username']: message,
      });
    }
    console.error('Staff login not created:', createError?.code, createError?.message);
    return actionError(GENERIC_ERROR);
  }

  const { data, error } = await admin.rpc('admin_create_staff', {
    p_actor_user_id: actorUserId,
    p_payload: {
      user_id: created.user.id,
      display_name: login.displayName,
      username: login.username,
      role: login.role,
    },
  });
  if (error) {
    await admin.auth.admin.deleteUser(created.user.id);
    const result = fromDbError(error, 'admin_create_staff');
    return dbErrorCode(error) === 'USERNAME_TAKEN'
      ? actionError(result.error, { username: result.error })
      : result;
  }
  return { ok: true, memberId: data, userId: created.user.id };
}

/** Undo a login created moments ago (its membership goes with the auth user). */
export async function removeNewStaffLogin(userId: string): Promise<void> {
  const { error } = await createAdminClient().auth.admin.deleteUser(userId);
  if (error) console.error('New staff login not removed:', error.message);
}
