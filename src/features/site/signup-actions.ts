'use server';

import { createHmac, randomInt } from 'node:crypto';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { after } from 'next/server';

import { OnboardError, onboardRestaurant } from '@/features/platform/onboard';
import { dbErrorCode } from '@/lib/db-errors';
import { emailConfig, sendEmail } from '@/lib/email/resend';
import { getPublicEnv } from '@/lib/env';
import { getServerEnv } from '@/lib/env.server';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';
import { turnstileConfig, verifyTurnstile } from '@/lib/turnstile';

import { hashIp } from './leads';
import { signupSchema, verifySchema, type Signup } from './schemas';
import {
  clearSignupCookie,
  setSignupCookie,
  signupCodeEmail,
  signupIdFromCookie,
  slugFromName,
  welcomeEmail,
} from './signup';

/**
 * The self-serve signup (docs/DECISIONS.md W-9): details and a Turnstile
 * check, an emailed 6-digit code, then the code and a password create the
 * restaurant with a trial, sign the owner in and open autopay.
 */

const FIELDS = [
  'restaurantName',
  'city',
  'cuisine',
  'ownerName',
  'email',
  'phone',
  'terms',
  'planCode',
  'cycle',
] as const;
type SignupField = (typeof FIELDS)[number];

export type SignupFormState = {
  error?: string;
  fieldErrors?: Partial<Record<SignupField, string>>;
  /** Echoed back so the form keeps what the visitor typed. */
  values: Record<SignupField, string>;
} | null;

export type VerifyFormState = {
  error?: string;
  /** The sign-up is over: only starting again, or logging in, helps. */
  restart?: 'signup' | 'login';
  fieldErrors?: Partial<Record<'code' | 'password', string>>;
} | null;

export type ResendState = {
  ok: boolean;
  message: string;
  /** No new code is possible: only starting again helps. */
  restart?: boolean;
  /** New codes sent so far, so each one reads differently. */
  sends: number;
} | null;

const CLOSED = 'Signing up isn’t open yet. Book a demo instead, and we’ll set you up.';
const CHECK_FAILED =
  'We couldn’t confirm you’re not a robot. Wait for the check above the button to finish, then try again.';
const RATE_LIMITED = 'Too many codes asked for. Try again later.';
const NOT_SENT = 'We couldn’t send the email. Check the address and try again.';
const FAILED = 'Something went wrong. Please try again in a minute.';

const hashCode = (code: string) =>
  createHmac('sha256', getServerEnv().CUSTOMER_COOKIE_SECRET)
    .update(`signup-code:${code}`)
    .digest('hex');

const newCode = () => String(randomInt(0, 1_000_000)).padStart(6, '0');

async function clientIp(): Promise<string | null> {
  const requestHeaders = await headers();
  return (
    requestHeaders.get('x-real-ip') ??
    requestHeaders.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    null
  );
}

/** Emails a code; false when email is off, or Resend refused or couldn't be reached. */
async function sendCode(email: string, code: string, key: string): Promise<boolean> {
  const config = emailConfig();
  if (!config) return false;
  try {
    await sendEmail(config, { ...signupCodeEmail(code), to: [email], idempotencyKey: key });
    return true;
  } catch (error) {
    console.error('[signup] could not send a code', error);
    return false;
  }
}

/** Step 1: details and the bot check; emails a code and moves on to /signup/verify. */
export async function startSignup(
  _previous: SignupFormState,
  formData: FormData,
): Promise<SignupFormState> {
  const values = Object.fromEntries(
    FIELDS.map((field) => [field, String(formData.get(field) ?? '')]),
  ) as Record<SignupField, string>;
  const turnstile = turnstileConfig();
  if (!turnstile || !emailConfig()) return { error: CLOSED, values };

  const parsed = signupSchema.safeParse(values);
  if (!parsed.success) {
    const fieldErrors: Partial<Record<SignupField, string>> = {};
    for (const issue of parsed.error.issues)
      fieldErrors[issue.path[0] as SignupField] ??= issue.message;
    return { fieldErrors, values };
  }

  const ip = await clientIp();
  const token = String(formData.get('cf-turnstile-response') ?? '');
  if (!(await verifyTurnstile(turnstile, token, ip))) return { error: CHECK_FAILED, values };

  const { email, restaurantName, city, cuisine, ownerName, phone, planCode, cycle } = parsed.data;
  const code = newCode();
  const { data: id, error } = await createAdminClient().rpc('site_signup_start', {
    p_email: email,
    p_details: { restaurantName, city, cuisine, ownerName, phone, planCode, cycle },
    p_code_hash: hashCode(code),
    p_ip_hash: ip ? hashIp(ip) : undefined,
  });
  if (error) {
    if (dbErrorCode(error) === 'RATE_LIMITED') return { error: RATE_LIMITED, values };
    console.error('[signup] site_signup_start failed:', error.code, error.message);
    return { error: FAILED, values };
  }
  if (!(await sendCode(email, code, `signup/${id}/1`))) return { error: NOT_SENT, values };
  await setSignupCookie(id);
  redirect('/signup/verify');
}

/**
 * "Send a new code": replaces the code of the signup in progress. Bounded in
 * the database (3 codes per signup, within its first hour), since it takes
 * no new bot check.
 */
export async function resendSignupCode(previous: ResendState): Promise<ResendState> {
  const sends = previous?.sends ?? 0;
  const id = await signupIdFromCookie();
  if (!id) redirect('/signup');
  const code = newCode();
  const { data: email, error } = await createAdminClient().rpc('site_signup_resend', {
    p_id: id,
    p_code_hash: hashCode(code),
  });
  if (error) {
    const reason = dbErrorCode(error);
    if (reason === 'NOT_FOUND' || reason === 'RATE_LIMITED') {
      return {
        ok: false,
        restart: true,
        sends,
        message:
          reason === 'NOT_FOUND'
            ? 'This sign-up is too old for a new code.'
            : 'That was the last new code for this sign-up. Check your spam folder too.',
      };
    }
    console.error('[signup] site_signup_resend failed:', error.code, error.message);
    return { ok: false, sends, message: FAILED };
  }
  if (!(await sendCode(email, code, `signup/${id}/${hashCode(code).slice(0, 16)}`))) {
    return { ok: false, sends, message: NOT_SENT };
  }
  return {
    ok: true,
    sends: sends + 1,
    message:
      sends === 0
        ? 'We sent a new code. Use it instead of the old one.'
        : 'We sent another new code. Use the latest one.',
  };
}

type StoredDetails = Omit<Signup, 'email' | 'terms'>;

/** Creates the restaurant, trying a code with a suffix when the plain one is taken. */
async function createRestaurant(email: string, details: StoredDetails, password: string) {
  const env = getServerEnv();
  for (let attempt = 0; ; attempt++) {
    const suffix = attempt === 0 ? undefined : newCode().slice(0, 4);
    try {
      // The trial runs on the platform's default plan (Growth); the plan
      // chosen on /pricing is offered for autopay afterwards.
      return await onboardRestaurant(createAdminClient(), {
        name: details.restaurantName,
        slug: slugFromName(details.restaurantName, suffix),
        ownerName: details.ownerName,
        ownerUsername: 'owner',
        ownerPassword: password,
        ownerEmail: email,
        city: details.city,
        cuisine: details.cuisine,
        phone: `+91 ${details.phone}`,
        email,
        staffEmailDomain: env.STAFF_EMAIL_DOMAIN,
      });
    } catch (error) {
      if (error instanceof OnboardError && error.code === 'SLUG_TAKEN' && attempt < 3) continue;
      throw error;
    }
  }
}

/** Step 2: the code and a password; creates the restaurant and signs the owner in. */
export async function completeSignup(
  _previous: VerifyFormState,
  formData: FormData,
): Promise<VerifyFormState> {
  const id = await signupIdFromCookie();
  if (!id) redirect('/signup');
  const parsed = verifySchema.safeParse({
    code: String(formData.get('code') ?? ''),
    password: String(formData.get('password') ?? ''),
  });
  if (!parsed.success) {
    const fieldErrors: NonNullable<VerifyFormState>['fieldErrors'] = {};
    for (const issue of parsed.error.issues)
      fieldErrors[issue.path[0] as 'code' | 'password'] ??= issue.message;
    return { fieldErrors };
  }

  const admin = createAdminClient();
  const { data, error } = await admin.rpc('site_signup_verify', {
    p_id: id,
    p_code_hash: hashCode(parsed.data.code),
  });
  if (error) {
    console.error('[signup] could not check a code', error);
    return { error: FAILED };
  }
  const result = data as
    | { status: 'ok'; email: string; details: StoredDetails }
    | { status: 'wrong'; tries_left: number }
    | { status: 'expired' | 'locked' | 'gone' };
  switch (result.status) {
    case 'wrong':
      return {
        fieldErrors: {
          code: `That code isn’t right. ${result.tries_left} ${result.tries_left === 1 ? 'try' : 'tries'} left.`,
        },
      };
    case 'expired':
      return { fieldErrors: { code: 'This code has expired. Send a new code below.' } };
    case 'locked':
      return { fieldErrors: { code: 'Too many wrong codes. Send a new code below.' } };
    case 'gone':
      return { error: 'This sign-up has already been used or is too old.', restart: 'signup' };
  }

  // The right code doesn't use the signup up, so a failure here can be tried again.
  const { email, details } = result;
  let restaurant;
  try {
    restaurant = await createRestaurant(email, details, parsed.data.password);
  } catch (error) {
    if (error instanceof OnboardError && error.code === 'EMAIL_TAKEN') {
      return {
        error: 'This email already has a MenuMesh account. Log in instead.',
        restart: 'login',
      };
    }
    if (error instanceof OnboardError && error.code === 'weak_password') {
      return { fieldErrors: { password: 'Choose a password that’s harder to guess.' } };
    }
    console.error('[signup] could not create the restaurant', error);
    return { error: FAILED };
  }

  const finished = await admin.rpc('site_signup_finish', { p_id: id });
  if (finished.error) console.error('[signup] could not finish a signup', finished.error);
  await clearSignupCookie();
  const config = emailConfig();
  if (config) {
    after(() =>
      sendEmail(config, {
        ...welcomeEmail({
          ownerName: details.ownerName,
          restaurantName: details.restaurantName,
          slug: restaurant.slug,
          appUrl: getPublicEnv().NEXT_PUBLIC_APP_URL,
        }),
        to: [email],
        idempotencyKey: `welcome/${restaurant.restaurantId}`,
      }).catch((error) => console.error('[signup] welcome email failed', error)),
    );
  }

  const supabase = await createClient();
  const signIn = await supabase.auth.signInWithPassword({ email, password: parsed.data.password });
  if (signIn.error) {
    // The restaurant exists; the owner can still log in by hand.
    console.error('[signup] sign-in after signup failed', signIn.error);
    redirect('/login');
  }

  const query = new URLSearchParams({ welcome: '1', cycle: details.cycle });
  if (details.planCode) query.set('plan', details.planCode);
  redirect(`/admin/subscription?${query}`);
}
