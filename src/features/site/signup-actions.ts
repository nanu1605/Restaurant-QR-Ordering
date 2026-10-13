'use server';

import { redirect } from 'next/navigation';
import { after } from 'next/server';

import {
  captureServerEvent,
  parseAttribution,
  type Attribution,
} from '@/features/analytics/server';
import { OnboardError, onboardRestaurant } from '@/features/platform/onboard';
import { dbErrorCode } from '@/lib/db-errors';
import { emailConfig, sendEmail } from '@/lib/email/resend';
import { getPublicEnv } from '@/lib/env';
import { getServerEnv } from '@/lib/env.server';
import { clientIp, hashCode, newCode } from '@/lib/one-time-code';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';
import { turnstileConfig, verifyTurnstile } from '@/lib/turnstile';

import { SITE, type SiteLang } from './content';
import { parseSiteLang, plural, sitePath } from './i18n';
import { hashIp } from './leads';
import { SITE_SCHEMAS, type Signup } from './schemas';
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

/** Emails a code; false when email is off, or Resend refused or couldn't be reached. */
async function sendCode(
  email: string,
  code: string,
  key: string,
  lang: SiteLang,
): Promise<boolean> {
  const config = emailConfig();
  if (!config) return false;
  try {
    await sendEmail(config, { ...signupCodeEmail(code, lang), to: [email], idempotencyKey: key });
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
  const lang = parseSiteLang(formData.get('lang'));
  const { checkFailed, signup: replies } = SITE[lang].replies;
  const turnstile = turnstileConfig();
  if (!turnstile || !emailConfig()) return { error: replies.closed, values };

  const parsed = SITE_SCHEMAS[lang].signup.safeParse(values);
  if (!parsed.success) {
    const fieldErrors: Partial<Record<SignupField, string>> = {};
    for (const issue of parsed.error.issues)
      fieldErrors[issue.path[0] as SignupField] ??= issue.message;
    return { fieldErrors, values };
  }

  const ip = await clientIp();
  const token = String(formData.get('cf-turnstile-response') ?? '');
  if (!(await verifyTurnstile(turnstile, token, ip))) return { error: checkFailed, values };

  const { email, restaurantName, city, cuisine, ownerName, phone, planCode, cycle } = parsed.data;
  const { source, visitor, dnt } = parseAttribution(formData.get('attribution'));
  const code = newCode();
  const { data: id, error } = await createAdminClient().rpc('site_signup_start', {
    p_email: email,
    p_details: {
      restaurantName,
      city,
      cuisine,
      ownerName,
      phone,
      planCode,
      cycle,
      source,
      visitor,
      dnt,
    },
    p_code_hash: hashCode('signup', code),
    p_ip_hash: ip ? hashIp(ip) : undefined,
  });
  if (error) {
    if (dbErrorCode(error) === 'RATE_LIMITED') return { error: replies.rateLimited, values };
    console.error('[signup] site_signup_start failed:', error.code, error.message);
    return { error: replies.failed, values };
  }
  if (!(await sendCode(email, code, `signup/${id}/1`, lang))) {
    return { error: replies.notSent, values };
  }
  await setSignupCookie(id);
  after(() =>
    captureServerEvent('signup_started', { source, visitor, dnt }, { plan: planCode, cycle }),
  );
  redirect(sitePath(lang, '/signup/verify'));
}

/**
 * "Send a new code": replaces the code of the signup in progress. Bounded in
 * the database (3 codes per signup, within its first hour), since it takes
 * no new bot check.
 */
export async function resendSignupCode(
  previous: ResendState,
  formData: FormData,
): Promise<ResendState> {
  const sends = previous?.sends ?? 0;
  const lang = parseSiteLang(formData.get('lang'));
  const { failed, notSent } = SITE[lang].replies.signup;
  const t = SITE[lang].replies.resend;
  const id = await signupIdFromCookie();
  if (!id) redirect(sitePath(lang, '/signup'));
  const code = newCode();
  const { data: email, error } = await createAdminClient().rpc('site_signup_resend', {
    p_id: id,
    p_code_hash: hashCode('signup', code),
  });
  if (error) {
    const reason = dbErrorCode(error);
    if (reason === 'NOT_FOUND' || reason === 'RATE_LIMITED') {
      return {
        ok: false,
        restart: true,
        sends,
        message: reason === 'NOT_FOUND' ? t.tooOld : t.lastCode,
      };
    }
    console.error('[signup] site_signup_resend failed:', error.code, error.message);
    return { ok: false, sends, message: failed };
  }
  if (
    !(await sendCode(email, code, `signup/${id}/${hashCode('signup', code).slice(0, 16)}`, lang))
  ) {
    return { ok: false, sends, message: notSent };
  }
  return { ok: true, sends: sends + 1, message: sends === 0 ? t.sent : t.sentAgain };
}

// Where the visit came from is missing on signups started before it was kept.
type StoredDetails = Omit<Signup, 'email' | 'terms'> & Partial<Attribution>;

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
  const lang = parseSiteLang(formData.get('lang'));
  const id = await signupIdFromCookie();
  if (!id) redirect(sitePath(lang, '/signup'));
  const { failed } = SITE[lang].replies.signup;
  const t = SITE[lang].replies.code;
  const parsed = SITE_SCHEMAS[lang].verify.safeParse({
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
    p_code_hash: hashCode('signup', parsed.data.code),
  });
  if (error) {
    console.error('[signup] could not check a code', error);
    return { error: failed };
  }
  const result = data as
    | { status: 'ok'; email: string; details: StoredDetails }
    | { status: 'wrong'; tries_left: number }
    | { status: 'expired' | 'locked' | 'gone' };
  switch (result.status) {
    case 'wrong':
      return { fieldErrors: { code: plural(result.tries_left, t.wrong) } };
    case 'expired':
      return { fieldErrors: { code: t.expired } };
    case 'locked':
      return { fieldErrors: { code: t.locked } };
    case 'gone':
      return { error: t.gone, restart: 'signup' };
  }

  // The right code doesn't use the signup up, so a failure here can be tried again.
  const { email, details } = result;
  let restaurant;
  try {
    restaurant = await createRestaurant(email, details, parsed.data.password);
  } catch (error) {
    if (error instanceof OnboardError && error.code === 'EMAIL_TAKEN') {
      return { error: t.emailTaken, restart: 'login' };
    }
    if (error instanceof OnboardError && error.code === 'weak_password') {
      return { fieldErrors: { password: t.weakPassword } };
    }
    console.error('[signup] could not create the restaurant', error);
    return { error: failed };
  }

  const finished = await admin.rpc('site_signup_finish', {
    p_id: id,
    p_restaurant_id: restaurant.restaurantId,
  });
  if (finished.error) console.error('[signup] could not finish a signup', finished.error);
  await clearSignupCookie();
  after(() =>
    captureServerEvent(
      'signup_completed',
      { source: details.source ?? {}, visitor: details.visitor, dnt: details.dnt ?? false },
      { plan: details.planCode, cycle: details.cycle, restaurant_id: restaurant.restaurantId },
    ),
  );
  const config = emailConfig();
  if (config) {
    after(() =>
      sendEmail(config, {
        ...welcomeEmail({
          ownerName: details.ownerName,
          restaurantName: details.restaurantName,
          slug: restaurant.slug,
          appUrl: getPublicEnv().NEXT_PUBLIC_APP_URL,
          lang,
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
