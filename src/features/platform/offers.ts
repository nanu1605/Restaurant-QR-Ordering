import { z } from 'zod';

import { parsePriceInput } from '@/features/menu/schemas';
import { FEATURE_KEYS, FEATURE_LABELS, type FeatureKey } from '@/features/plans/plan-features';
import { isDate } from '@/lib/date-range';
import { formatINR } from '@/lib/money';

import { discountEndsAt } from './setup-fee';

/**
 * Offers, one restaurant's price (a deal) and overrides
 * (docs/SUPER_ADMIN_PLAN.md 14b, docs/DECISIONS.md SA-77+). Prices are
 * before GST, per charge; the database rounds and checks them.
 */

const cycleSchema = z.enum(['monthly', 'yearly']);
export type DealCycle = z.infer<typeof cycleSchema>;
const isoOrNull = z.string().nullable();

// ─── Offers ──────────────────────────────────────────────────────────────────
const offerRowSchema = z.object({
  id: z.string(),
  code: z.string(),
  description: z.string().nullable(),
  discount_kind: z.enum(['percent', 'flat']),
  discount_value: z.number(),
  plan_codes: z.array(z.string()).nullable(),
  cycles: z.array(cycleSchema).nullable(),
  duration_cycles: z.number().nullable(),
  valid_from: z.string(),
  valid_until: isoOrNull,
  max_redemptions: z.number().nullable(),
  new_only: z.boolean(),
  ended_at: isoOrNull,
  used: z.number(),
  discount_paise: z.number(),
  created_by: z.string().nullable(),
  created_at: z.string(),
});
export type OfferRow = z.infer<typeof offerRowSchema>;
export const parseOffers = (json: unknown) => z.array(offerRowSchema).parse(json);

export function offerStatus(offer: OfferRow, now = new Date()): 'live' | 'scheduled' | 'ended' {
  if (
    offer.ended_at ||
    (offer.valid_until && Date.parse(offer.valid_until) <= now.getTime()) ||
    (offer.max_redemptions !== null && offer.used >= offer.max_redemptions)
  ) {
    return 'ended';
  }
  return Date.parse(offer.valid_from) > now.getTime() ? 'scheduled' : 'live';
}

/** "20% off", "₹100 off". */
export function discountLabel(offer: Pick<OfferRow, 'discount_kind' | 'discount_value'>) {
  return offer.discount_kind === 'percent'
    ? `${offer.discount_value}% off`
    : `${formatINR(offer.discount_value, { fraction: 'auto' })} off`;
}

/** "Growth, monthly · first 3 charges · new restaurants only". */
export function offerTerms(offer: OfferRow, planNames: Record<string, string>) {
  return [
    `${offer.plan_codes ? offer.plan_codes.map((code) => planNames[code] ?? code).join(', ') : 'Every plan'}, ${
      offer.cycles?.length === 1 ? offer.cycles[0] : 'monthly or yearly'
    }`,
    offer.duration_cycles === null
      ? 'every charge'
      : `first ${offer.duration_cycles} ${offer.duration_cycles === 1 ? 'charge' : 'charges'}`,
    ...(offer.new_only ? ['new restaurants only'] : []),
  ].join(' · ');
}

const optionalCount = (max: number, message: string) =>
  z
    .string()
    .trim()
    .refine(
      (text) => text === '' || (/^\d+$/.test(text) && Number(text) >= 1 && Number(text) <= max),
      message,
    );
const optionalDate = z.string().refine((text) => text === '' || isDate(text), 'Choose a date.');

export const offerSchema = z
  .object({
    code: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9]{3,20}$/, 'Use 3 to 20 letters or digits.'),
    description: z.string().trim().max(200, 'Use 200 characters or fewer.'),
    discountKind: z.enum(['percent', 'flat']),
    discount: z.string().trim(),
    planCodes: z.array(z.string()),
    cycles: z.array(cycleSchema),
    durationCycles: optionalCount(120, 'Enter 1 to 120, or leave empty for every charge.'),
    validFrom: optionalDate,
    validUntil: optionalDate,
    maxRedemptions: optionalCount(100000, 'Enter a number, or leave empty for no limit.'),
    newOnly: z.boolean(),
  })
  .superRefine((value, ctx) => {
    const ok =
      value.discountKind === 'percent'
        ? /^\d+$/.test(value.discount) &&
          Number(value.discount) >= 1 &&
          Number(value.discount) <= 99
        : /^\d+$/.test(value.discount.replace(/[₹,\s]/g, '')) &&
          (parsePriceInput(value.discount) ?? 0) >= 100;
    if (!ok) {
      ctx.addIssue({
        code: 'custom',
        path: ['discount'],
        message:
          value.discountKind === 'percent'
            ? 'Enter a whole percentage from 1 to 99.'
            : 'Enter whole rupees, e.g. 100.',
      });
    }
    if (value.validFrom && value.validUntil && value.validUntil < value.validFrom) {
      ctx.addIssue({ code: 'custom', path: ['validUntil'], message: 'On or after the first day.' });
    }
  });
export type OfferInput = z.input<typeof offerSchema>;

/** The form as platform_save_offer takes it; dates are India's. */
export function offerPayload(value: z.output<typeof offerSchema>) {
  return {
    code: value.code,
    description: value.description || null,
    discount_kind: value.discountKind,
    discount_value:
      value.discountKind === 'percent'
        ? Number(value.discount)
        : (parsePriceInput(value.discount) ?? 0),
    plan_codes: value.planCodes.length > 0 ? value.planCodes : null,
    cycles: value.cycles.length > 0 ? value.cycles : null,
    duration_cycles: value.durationCycles ? Number(value.durationCycles) : null,
    ...(value.validFrom && {
      valid_from: new Date(`${value.validFrom}T00:00:00+05:30`).toISOString(),
    }),
    ...(value.validUntil && { valid_until: discountEndsAt(value.validUntil) }),
    ...(value.maxRedemptions && { max_redemptions: Number(value.maxRedemptions) }),
    new_only: value.newOnly,
  };
}

export const offerEditSchema = z.object({
  description: z.string().trim().max(200, 'Use 200 characters or fewer.'),
  validUntil: optionalDate,
  maxRedemptions: optionalCount(100000, 'Enter a number, or leave empty for no limit.'),
});
export type OfferEditInput = z.input<typeof offerEditSchema>;

// ─── One restaurant's price ──────────────────────────────────────────────────
export const dealRowSchema = z.object({
  id: z.string(),
  offer_code: z.string().nullable(),
  plan_code: z.string(),
  plan_name: z.string(),
  billing_cycle: cycleSchema,
  // Null without money.view.
  list_price_paise: z.number().nullable(),
  price_paise: z.number().nullable(),
  cycles: z.number().nullable(),
  reason: z.string().nullable(),
  by_owner: z.boolean(),
  created_by: z.string().nullable(),
  created_at: z.string(),
  used_at: isoOrNull,
  ended_at: isoOrNull,
});
export type DealRow = z.infer<typeof dealRowSchema>;

export const dealSchema = z
  .object({
    mode: z.enum(['offer', 'custom']),
    planCode: z.string().regex(/^[a-z_]{2,30}$/, 'Choose a plan.'),
    billingCycle: cycleSchema,
    offerCode: z.string().trim().toUpperCase(),
    price: z.string().trim(),
    cycles: optionalCount(120, 'Enter 1 to 120, or leave empty for every charge.'),
    reason: z.string().trim().max(500, 'Use 500 characters or fewer.'),
  })
  .superRefine((value, ctx) => {
    if (value.mode === 'offer') {
      if (!/^[A-Z0-9]{3,20}$/.test(value.offerCode)) {
        ctx.addIssue({ code: 'custom', path: ['offerCode'], message: 'Enter the offer code.' });
      }
      return;
    }
    if (
      !/^\d+$/.test(value.price.replace(/[₹,\s]/g, '')) ||
      (parsePriceInput(value.price) ?? 0) < 100
    ) {
      ctx.addIssue({ code: 'custom', path: ['price'], message: 'Enter whole rupees, e.g. 699.' });
    }
    if (!value.reason) {
      ctx.addIssue({ code: 'custom', path: ['reason'], message: 'Say why, for the audit log.' });
    }
  });
export type DealInput = z.input<typeof dealSchema>;

/** The form as platform_set_deal takes it. */
export function dealPayload(value: z.output<typeof dealSchema>) {
  return {
    plan_code: value.planCode,
    billing_cycle: value.billingCycle,
    ...(value.mode === 'offer'
      ? { offer_code: value.offerCode }
      : {
          price_paise: parsePriceInput(value.price) ?? 0,
          ...(value.cycles && { cycles: Number(value.cycles) }),
        }),
    ...(value.reason && { reason: value.reason }),
  };
}

/** "₹699 a month + GST for 3 months", from a deal. */
export function dealPriceLine(deal: DealRow) {
  if (deal.price_paise === null) return null;
  const per = deal.billing_cycle === 'monthly' ? 'a month' : 'a year';
  const unit = deal.billing_cycle === 'monthly' ? 'month' : 'year';
  return `${formatINR(deal.price_paise, { fraction: 'auto' })} ${per} + GST${
    deal.cycles === null ? '' : ` for ${deal.cycles} ${unit}${deal.cycles === 1 ? '' : 's'}`
  }`;
}

// ─── Overrides and beta flags ────────────────────────────────────────────────
export const OVERRIDE_KINDS = ['feature', 'max_tables', 'max_staff'] as const;
export type OverrideKind = (typeof OVERRIDE_KINDS)[number];
export const OVERRIDE_KIND_LABELS: Record<OverrideKind, string> = {
  feature: 'A feature or beta flag',
  max_tables: 'More tables',
  max_staff: 'More staff logins',
};

export const overrideRowSchema = z.object({
  id: z.string(),
  kind: z.enum(OVERRIDE_KINDS),
  feature: z.string().nullable(),
  value: z.number().nullable(),
  expires_at: isoOrNull,
  expired: z.boolean().nullable(),
  reason: z.string(),
  created_by: z.string().nullable(),
  created_at: z.string(),
});
export type OverrideRow = z.infer<typeof overrideRowSchema>;

/** "Kitchen view", "Beta: waitlist", "Tables: 12", "Staff logins: unlimited". */
export function overrideLabel(override: Pick<OverrideRow, 'kind' | 'feature' | 'value'>) {
  if (override.kind === 'feature') {
    const feature = override.feature ?? '';
    return FEATURE_KEYS.includes(feature as FeatureKey)
      ? FEATURE_LABELS[feature as FeatureKey]
      : `Beta: ${feature.replace(/^beta_/, '').replace(/_/g, ' ')}`;
  }
  const what = override.kind === 'max_tables' ? 'Tables' : 'Staff logins';
  return `${what}: ${override.value ?? 'unlimited'}`;
}

export const overrideSchema = z
  .object({
    kind: z.enum(OVERRIDE_KINDS),
    feature: z.string().trim().toLowerCase(),
    value: z.string().trim(),
    expiresOn: optionalDate,
    reason: z
      .string()
      .trim()
      .min(1, 'Say why, for the audit log.')
      .max(500, 'Use 500 characters or fewer.'),
  })
  .superRefine((value, ctx) => {
    if (value.kind === 'feature' && !/^[a-z_]{1,40}$/.test(value.feature)) {
      ctx.addIssue({
        code: 'custom',
        path: ['feature'],
        message: 'Choose a feature, or name a beta flag in lower case, e.g. beta_waitlist.',
      });
    }
    if (
      value.kind !== 'feature' &&
      value.value !== '' &&
      !(/^\d+$/.test(value.value) && Number(value.value) >= 1 && Number(value.value) <= 10000)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['value'],
        message: 'Enter a number, or leave empty for unlimited.',
      });
    }
  });
export type OverrideInput = z.input<typeof overrideSchema>;

/** The form as platform_set_override takes it; an expiry ends after that India day. */
export function overridePayload(value: z.output<typeof overrideSchema>) {
  return {
    kind: value.kind,
    ...(value.kind === 'feature'
      ? { feature: value.feature }
      : { value: value.value ? Number(value.value) : null }),
    ...(value.expiresOn && { expires_at: discountEndsAt(value.expiresOn) }),
    reason: value.reason,
  };
}
