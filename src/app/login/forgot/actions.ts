'use server';

import { redirect } from 'next/navigation';
import { after } from 'next/server';

import { hashIp } from '@/features/site/leads';
import { dbErrorCode, GENERIC_ERROR } from '@/lib/db-errors';
import { emailConfig, sendEmail } from '@/lib/email/resend';
import { clientIp, hashCode, newCode } from '@/lib/one-time-code';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';
import { turnstileConfig, verifyTurnstile } from '@/lib/turnstile';

import { clearResetCookie, passwordResetEmail, resetFromCookie, setResetCookie } from './reset';
import { resetPasswordSchema, resetRequestSchema } from './schemas';

/**
 * "Forgot password" (docs/DECISIONS.md P11-6 to P11-9): an email and the bot
 * check send a 6-digit code, if the email has an account; the code and a new
 * password then set it, which signs the account out everywhere, and sign in here.
 */

export type ResetRequestState = {
  error?: string;
  fieldErrors?: { email?: string };
  /** Echoed back so the form keeps what was typed. */
  email: string;
} | null;

type ResetField = 'code' | 'password' | 'confirm';
export type ResetPasswordState = {
  error?: string;
  fieldErrors?: Partial<Record<ResetField, string>>;
} | null;

const UNAVAILABLE =
  'Password reset by email isn’t available right now. Contact MenuMesh support to reset it.';
const CHECK_FAILED = 'The check that you’re not a robot didn’t pass. Try again.';
const RATE_LIMITED = 'Too many reset requests. Try again later, or contact MenuMesh support.';

/** Step 1: the email and the bot check; the code goes out after the answer. */
export async function requestPasswordReset(
  _previous: ResetRequestState,
  formData: FormData,
): Promise<ResetRequestState> {
  const email = String(formData.get('email') ?? '');
  const turnstile = turnstileConfig();
  const config = emailConfig();
  if (!turnstile || !config) return { error: UNAVAILABLE, email };

  const parsed = resetRequestSchema.safeParse({ email });
  if (!parsed.success) return { fieldErrors: { email: parsed.error.issues[0]?.message }, email };

  const ip = await clientIp();
  const token = String(formData.get('cf-turnstile-response') ?? '');
  if (!(await verifyTurnstile(turnstile, token, ip))) return { error: CHECK_FAILED, email };

  const code = newCode();
  const { data, error } = await createAdminClient().rpc('auth_password_reset_start', {
    p_email: parsed.data.email,
    p_code_hash: hashCode('password-reset', code),
    p_ip_hash: ip ? hashIp(ip) : undefined,
  });
  if (error) {
    if (dbErrorCode(error) === 'RATE_LIMITED') return { error: RATE_LIMITED, email };
    console.error('[password reset] start failed:', error.code, error.message);
    return { error: GENERIC_ERROR, email };
  }
  const { id, send } = data as { id: string; send: boolean };
  // Sent after the answer, so how long it takes never tells whether the email has an account (P11-7).
  if (send) {
    after(() =>
      sendEmail(config, {
        ...passwordResetEmail(code),
        to: [parsed.data.email],
        idempotencyKey: `password-reset/${id}`,
      }).catch((sendError) => console.error('[password reset] could not send a code', sendError)),
    );
  }
  await setResetCookie({ id, email: parsed.data.email });
  redirect('/login/forgot');
}

/** Step 2: the code and the new password. */
export async function resetPassword(
  _previous: ResetPasswordState,
  formData: FormData,
): Promise<ResetPasswordState> {
  const reset = await resetFromCookie();
  if (!reset) redirect('/login/forgot');
  const parsed = resetPasswordSchema.safeParse({
    code: String(formData.get('code') ?? ''),
    password: String(formData.get('password') ?? ''),
    confirm: String(formData.get('confirm') ?? ''),
  });
  if (!parsed.success) {
    const fieldErrors: Partial<Record<ResetField, string>> = {};
    for (const issue of parsed.error.issues)
      fieldErrors[issue.path[0] as ResetField] ??= issue.message;
    return { fieldErrors };
  }

  const admin = createAdminClient();
  const { data, error } = await admin.rpc('auth_password_reset_verify', {
    p_id: reset.id,
    p_code_hash: hashCode('password-reset', parsed.data.code),
  });
  if (error) {
    console.error('[password reset] could not check a code', error.code, error.message);
    return { error: GENERIC_ERROR };
  }
  const result = data as
    | { status: 'ok'; user_id: string; email: string }
    | { status: 'wrong'; tries_left: number }
    | { status: 'expired' | 'locked' | 'gone' };
  switch (result.status) {
    case 'wrong': {
      const tries = result.tries_left === 1 ? '1 try' : `${result.tries_left} tries`;
      return { fieldErrors: { code: `That code isn’t right. ${tries} left.` } };
    }
    case 'expired':
      return { fieldErrors: { code: 'That code has expired. Get a new code below.' } };
    case 'locked':
      return { fieldErrors: { code: 'Too many wrong tries. Get a new code below.' } };
    case 'gone':
      return { fieldErrors: { code: 'That code no longer works. Get a new code below.' } };
  }

  // The code isn't used up until the password is saved, so a refused password can be tried again.
  const { error: updateError } = await admin.auth.admin.updateUserById(result.user_id, {
    password: parsed.data.password,
  });
  if (updateError) {
    if (updateError.code === 'weak_password') {
      return { fieldErrors: { password: 'Choose a longer, harder to guess password.' } };
    }
    console.error('[password reset] password not updated:', updateError.code, updateError.message);
    return { error: GENERIC_ERROR };
  }
  const finished = await admin.rpc('auth_password_reset_finish', { p_id: reset.id });
  if (finished.error) console.error('[password reset] could not finish a reset', finished.error);
  await clearResetCookie();

  // Saving the password signed the account out everywhere (P11-8): sign in here again. The login
  // page sends the account on to its panel.
  const supabase = await createClient();
  const signIn = await supabase.auth.signInWithPassword({
    email: result.email,
    password: parsed.data.password,
  });
  if (signIn.error) {
    console.error('[password reset] sign-in after a reset failed', signIn.error);
    redirect('/login?error=password_changed');
  }
  redirect('/login');
}

/** "Get a new code, or use another email": back to step 1. */
export async function restartPasswordReset() {
  await clearResetCookie();
  redirect('/login/forgot');
}
