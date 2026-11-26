import { z } from 'zod';

import { CUISINE_SETS } from '@/features/menu/default-categories';
import { passwordRule } from '@/features/platform/schemas';
import { GSTIN_PATTERN } from '@/features/settings/schemas';
import { hasNoHiddenCharacters } from '@/lib/person-name';

import { SITE, type SiteContent, type SiteLang } from './content';
import { fill } from './i18n';

/** Ten digits, without spaces, +91 or a leading 0 ("+91 98765-43210" → "9876543210"). */
export function normalizePhone(text: string): string {
  const digits = text.replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) return digits.slice(1);
  return digits;
}

/** The website's forms, with their messages in one language. */
export function siteSchemas(m: SiteContent['errors']) {
  const tooLong = (max: number) => fill(m.tooLong, { max });
  const text = (missing: string, max: number) =>
    z.string().trim().min(1, missing).max(max, tooLong(max));
  /** The visitor's own name, which the team reads on its screens and in emails. */
  const personName = text(m.name, 80).refine(hasNoHiddenCharacters, m.nameHidden);

  /** The "Book a demo" form (docs/DECISIONS.md W-6); site_leads checks the same lengths. */
  const lead = z.object({
    name: personName,
    restaurantName: text(m.restaurantName, 120),
    city: text(m.city, 60),
    phone: z
      .string()
      .transform(normalizePhone)
      .pipe(z.string().regex(/^[0-9]{10}$/, m.phone)),
    email: z
      .string()
      .trim()
      .toLowerCase()
      .max(254, tooLong(254))
      .pipe(z.union([z.literal(''), z.email(m.emailOrEmpty)]))
      .transform((value) => value || null),
    planCode: z.string().transform((value) => (/^[a-z_]{2,30}$/.test(value) ? value : null)),
    message: z
      .string()
      // Forms send line breaks as CRLF; the textarea counted each as one character.
      .transform((value) => value.replace(/\r\n?/g, '\n'))
      .pipe(z.string().trim().max(1000, tooLong(1000)))
      .transform((value) => value || null),
  });

  /** Step 1 of the self-serve signup (docs/DECISIONS.md W-9). */
  const signup = z.object({
    restaurantName: text(m.restaurantName, 120),
    city: text(m.city, 60),
    cuisine: z.enum(CUISINE_SETS, { message: m.cuisine }),
    ownerName: personName,
    email: z.string().trim().toLowerCase().max(254, tooLong(254)).pipe(z.email(m.email)),
    phone: lead.shape.phone,
    // One trial per restaurant (docs/DECISIONS.md P11-10): its licence, address and GSTIN.
    addressLine: text(m.address, 300),
    pincode: z
      .string()
      .trim()
      .regex(/^[1-9][0-9]{5}$/, m.pincode),
    fssaiLicense: z
      .string()
      .transform((value) => value.replace(/[\s-]/g, ''))
      .pipe(z.string().regex(/^[0-9]{14}$/, m.fssai)),
    gstin: z
      .string()
      .transform((value) => value.replace(/\s/g, '').toUpperCase())
      .pipe(z.union([z.literal(''), z.string().regex(GSTIN_PATTERN, m.gstin)]))
      .transform((value) => value || null),
    terms: z.literal('on', { message: m.terms }),
    /** The plan the visitor came from on /pricing, for autopay after signup. */
    planCode: lead.shape.planCode,
    cycle: z.string().transform((value) => (value === 'yearly' ? 'yearly' : 'monthly')),
  });

  /** Step 2: the emailed code and the owner's password. */
  const verify = z.object({
    code: z
      .string()
      .transform((value) => value.replace(/\D/g, ''))
      .pipe(z.string().length(6, m.code)),
    // Supabase Auth (bcrypt) reads 72 bytes, fewer characters in Hindi.
    password: passwordRule(m.passwordShort, m.passwordLong).refine(
      (password) => new TextEncoder().encode(password).length <= 72,
      m.passwordBytes,
    ),
  });

  return { lead, signup, verify };
}

export const SITE_SCHEMAS: Record<SiteLang, ReturnType<typeof siteSchemas>> = {
  en: siteSchemas(SITE.en.errors),
  hi: siteSchemas(SITE.hi.errors),
};

/** The English forms. */
export const { lead: leadSchema, signup: signupSchema, verify: verifySchema } = SITE_SCHEMAS.en;

export type LeadInput = z.input<typeof leadSchema>;
export type Lead = z.output<typeof leadSchema>;
export type SignupInput = z.input<typeof signupSchema>;
export type Signup = z.output<typeof signupSchema>;
