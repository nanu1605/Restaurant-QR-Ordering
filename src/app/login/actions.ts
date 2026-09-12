'use server';

import { redirect } from 'next/navigation';

import { allowedPanelsFor, homePathFor, safeNextPath } from '@/lib/auth/redirects';
import { emailLoginSchema, staffLoginSchema } from '@/lib/auth/schemas';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';

export type LoginFormState = {
  error?: string;
  fieldErrors?: Partial<Record<'restaurantCode' | 'username' | 'email' | 'password', string>>;
  /** Echoed back so the form keeps what the user typed (never the password). */
  values?: { restaurantCode?: string; username?: string; email?: string };
} | null;

const WRONG_STAFF_LOGIN = 'Wrong restaurant code, username or password. Check them and try again.';
const WRONG_EMAIL_LOGIN = 'Wrong email or password. Check them and try again.';
const RATE_LIMITED = 'Too many login attempts. Wait a few minutes, then try again.';
const NO_ACCESS = 'Your account is inactive. Ask your manager to turn it back on.';

function firstErrors(issues: { path: PropertyKey[]; message: string }[]) {
  const fieldErrors: Record<string, string> = {};
  for (const issue of issues) {
    const key = String(issue.path[0]);
    fieldErrors[key] ??= issue.message;
  }
  return fieldErrors;
}

/** Restaurant code + username + password (staff, and owners without email). */
export async function signInWithUsername(
  _previous: LoginFormState,
  formData: FormData,
): Promise<LoginFormState> {
  const values = {
    restaurantCode: String(formData.get('restaurantCode') ?? ''),
    username: String(formData.get('username') ?? ''),
  };
  const parsed = staffLoginSchema.safeParse({ ...values, password: formData.get('password') });
  if (!parsed.success) {
    return { fieldErrors: firstErrors(parsed.error.issues), values };
  }

  // Resolve the stored auth email server-side (service role only), so changing
  // the synthetic email domain can never break existing logins.
  const { data: email, error } = await createAdminClient().rpc('auth_staff_login_email', {
    p_slug: parsed.data.restaurantCode,
    p_username: parsed.data.username,
  });
  if (error) throw new Error(`Login lookup failed: ${error.message}`);
  if (!email) return { error: WRONG_STAFF_LOGIN, values };

  return completeSignIn(
    email,
    parsed.data.password,
    formData.get('next'),
    WRONG_STAFF_LOGIN,
    values,
  );
}

/** Email + password (owners with a real email, platform admins). */
export async function signInWithEmail(
  _previous: LoginFormState,
  formData: FormData,
): Promise<LoginFormState> {
  const values = { email: String(formData.get('email') ?? '') };
  const parsed = emailLoginSchema.safeParse({ ...values, password: formData.get('password') });
  if (!parsed.success) {
    return { fieldErrors: firstErrors(parsed.error.issues), values };
  }

  return completeSignIn(
    parsed.data.email,
    parsed.data.password,
    formData.get('next'),
    WRONG_EMAIL_LOGIN,
    values,
  );
}

async function completeSignIn(
  email: string,
  password: string,
  next: FormDataEntryValue | null,
  wrongCredentials: string,
  values: NonNullable<LoginFormState>['values'],
): Promise<LoginFormState> {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });

  if (error || !data.user) {
    if (error?.status === 429) return { error: RATE_LIMITED, values };
    return { error: wrongCredentials, values };
  }

  const [adminCheck, membership] = await Promise.all([
    supabase.rpc('is_platform_admin'),
    supabase
      .from('restaurant_members')
      .select('role')
      .eq('user_id', data.user.id)
      .eq('is_active', true)
      .order('created_at')
      .limit(1)
      .maybeSingle(),
  ]);
  if (adminCheck.error) throw new Error(`Platform admin check failed: ${adminCheck.error.message}`);
  if (membership.error) throw new Error(`Membership lookup failed: ${membership.error.message}`);

  const access = { isPlatformAdmin: adminCheck.data === true, role: membership.data?.role ?? null };
  const home = homePathFor(access);

  if (!home) {
    // Valid password but no active restaurant (deactivated staff): don't keep a session.
    await supabase.auth.signOut({ scope: 'local' });
    return { error: NO_ACCESS, values };
  }

  redirect(safeNextPath(next, allowedPanelsFor(access)) ?? home);
}
