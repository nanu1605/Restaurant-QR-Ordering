'use server';

import { redirect } from 'next/navigation';
import { z } from 'zod';

import { actionError, actionOk, type ActionResult } from '@/lib/action-result';
import { requirePlatformAdminLogin } from '@/lib/auth/guards';
import { APP_NAME } from '@/lib/config';
import { GENERIC_ERROR } from '@/lib/db-errors';
import { createClient } from '@/lib/supabase/server';

import { qrCodeDataUrl } from './platform';

/**
 * Two-step sign-in for platform admins (spec §9.5, docs/DECISIONS.md P7-2):
 * enrol an authenticator app once, then enter its code after each password
 * login. Verifying upgrades the session to aal2, which platform data needs.
 */

export type TotpEnrolment = {
  factorId: string;
  /** An image URL (data: SVG) of the QR code for the authenticator app. */
  qrCode: string;
  /** The same key as text, for apps that can't scan. */
  secret: string;
};

export async function startTotpEnrolment(): Promise<ActionResult<TotpEnrolment>> {
  await requirePlatformAdminLogin();
  const supabase = await createClient();

  const factors = await supabase.auth.mfa.listFactors();
  if (factors.error) return logged('List factors', factors.error);
  if (factors.data.totp.some((factor) => factor.status === 'verified')) {
    return actionError('An authenticator app is already set up. Enter its code instead.');
  }
  // An enrolment left unfinished (page closed before the code) blocks a new one.
  for (const factor of factors.data.all) {
    if (factor.factor_type === 'totp' && factor.status === 'unverified') {
      const removed = await supabase.auth.mfa.unenroll({ factorId: factor.id });
      if (removed.error) return logged('Remove unfinished factor', removed.error);
    }
  }

  const enrolled = await supabase.auth.mfa.enroll({
    factorType: 'totp',
    friendlyName: `${APP_NAME} platform admin`,
  });
  if (enrolled.error) return logged('Enrol TOTP', enrolled.error);

  const { qr_code: qrCode, secret } = enrolled.data.totp;
  return actionOk({
    factorId: enrolled.data.id,
    qrCode: qrCodeDataUrl(qrCode),
    secret,
  });
}

export type VerifyTotpState = { error: string } | null;

const codeSchema = z
  .string()
  .transform((code) => code.replace(/\s/g, ''))
  .pipe(z.string().regex(/^\d{6}$/, 'Enter the 6-digit code from your authenticator app.'));

export async function verifyTotp(
  _previous: VerifyTotpState,
  formData: FormData,
): Promise<VerifyTotpState> {
  await requirePlatformAdminLogin();
  const code = codeSchema.safeParse(formData.get('code') ?? '');
  if (!code.success) return { error: code.error.issues[0]?.message ?? GENERIC_ERROR };

  const supabase = await createClient();
  let factorId =
    typeof formData.get('factorId') === 'string' ? String(formData.get('factorId')) : '';
  if (!factorId) {
    const factors = await supabase.auth.mfa.listFactors();
    if (factors.error) return { error: logged('List factors', factors.error).error };
    const factor = factors.data.totp.find((candidate) => candidate.status === 'verified');
    if (!factor) return { error: 'Set up your authenticator app first.' };
    factorId = factor.id;
  }

  const verified = await supabase.auth.mfa.challengeAndVerify({ factorId, code: code.data });
  if (verified.error) {
    if (verified.error.status === 429) {
      return { error: 'Too many tries. Wait a minute, then enter the newest code.' };
    }
    if (verified.error.code === 'mfa_verification_failed' || verified.error.status === 422) {
      return {
        error: "That code didn't work. Enter the newest code, and check the time on your phone.",
      };
    }
    return { error: logged('Verify TOTP', verified.error).error };
  }

  redirect('/super');
}

function logged(context: string, error: { status?: number; code?: string; message: string }) {
  console.error(`${context} failed:`, error.status, error.code, error.message);
  return actionError(GENERIC_ERROR);
}
