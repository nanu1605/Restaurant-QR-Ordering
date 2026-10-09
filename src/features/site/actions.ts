'use server';

import { after } from 'next/server';
import { headers } from 'next/headers';

import { captureServerEvent, parseAttribution } from '@/features/analytics/server';
import { dbErrorCode } from '@/lib/db-errors';
import { emailConfig } from '@/lib/email/resend';
import { getPublicEnv } from '@/lib/env';
import { createAdminClient } from '@/lib/supabase/admin';
import { turnstileConfig, verifyTurnstile } from '@/lib/turnstile';

import { hashIp, notifyLead } from './leads';
import { leadSchema } from './schemas';

const FIELDS = ['name', 'restaurantName', 'city', 'phone', 'email', 'planCode', 'message'] as const;
type LeadField = (typeof FIELDS)[number];

export type LeadFormState =
  | { ok: true }
  | {
      ok: false;
      error?: string;
      fieldErrors?: Partial<Record<LeadField, string>>;
      /** Echoed back so the form keeps what the visitor typed. */
      values: Record<LeadField, string>;
    }
  | null;

const CHECK_FAILED =
  'We couldn’t confirm you’re not a robot. Wait for the check above the button to finish, then try again.';
const RATE_LIMITED =
  'We already have a few requests from you. We’ll be in touch soon, or try again later.';
const FAILED = 'Your request didn’t go through. Please try again in a minute.';

/** The "Book a demo" form (docs/DECISIONS.md W-6): Turnstile, then site_create_lead. */
export async function submitLead(
  _previous: LeadFormState,
  formData: FormData,
): Promise<LeadFormState> {
  const values = Object.fromEntries(
    FIELDS.map((field) => [field, String(formData.get(field) ?? '')]),
  ) as Record<LeadField, string>;
  const turnstile = turnstileConfig();
  if (!turnstile) return { ok: false, error: FAILED, values };

  const parsed = leadSchema.safeParse(values);
  if (!parsed.success) {
    const fieldErrors: Partial<Record<LeadField, string>> = {};
    for (const issue of parsed.error.issues)
      fieldErrors[issue.path[0] as LeadField] ??= issue.message;
    return { ok: false, fieldErrors, values };
  }

  const requestHeaders = await headers();
  const ip =
    requestHeaders.get('x-real-ip') ??
    requestHeaders.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    null;
  const token = String(formData.get('cf-turnstile-response') ?? '');
  if (!(await verifyTurnstile(turnstile, token, ip))) {
    return { ok: false, error: CHECK_FAILED, values };
  }

  const lead = parsed.data;
  const attribution = parseAttribution(formData.get('attribution'));
  const admin = createAdminClient();
  const { data: leadId, error } = await admin.rpc('site_create_lead', {
    p_lead: {
      name: lead.name,
      restaurant_name: lead.restaurantName,
      city: lead.city,
      phone: lead.phone,
      email: lead.email,
      plan_code: lead.planCode,
      message: lead.message,
      source: attribution.source,
    },
    p_ip_hash: ip ? hashIp(ip) : undefined,
  });
  if (error) {
    if (dbErrorCode(error) === 'RATE_LIMITED') return { ok: false, error: RATE_LIMITED, values };
    console.error('site_create_lead failed:', error.code, error.message, error.details);
    return { ok: false, error: FAILED, values };
  }

  after(() => captureServerEvent('lead_submitted', attribution, { plan: lead.planCode }));
  const email = emailConfig();
  if (email) {
    after(() => notifyLead(admin, email, leadId, lead, getPublicEnv().NEXT_PUBLIC_APP_URL));
  } else {
    console.warn('[leads] not emailed: RESEND_API_KEY or EMAIL_FROM not set');
  }
  return { ok: true };
}
