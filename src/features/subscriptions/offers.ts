import { z } from 'zod';

import type { BillingCycle } from './autopay';

/**
 * Special prices at the owner's checkout (docs/SUPER_ADMIN_PLAN.md 14b,
 * docs/DECISIONS.md SA-77+): the team's price for this restaurant, or an
 * offer code's. Prices are before GST, per charge.
 */

const cycleSchema = z.enum(['monthly', 'yearly']);

/** The price the team set for this restaurant, waiting for its next autopay. */
export const teamDealSchema = z.object({
  plan_code: z.string(),
  billing_cycle: cycleSchema,
  list_price_paise: z.number().int(),
  price_paise: z.number().int(),
  cycles: z.number().int().nullable(),
});
export type TeamDeal = z.infer<typeof teamDealSchema>;

/** The team's deal, and the deal prices the restaurant pays now and next. */
export const ownerPricesSchema = z.object({
  deal: teamDealSchema.nullable(),
  current_price_paise: z.number().int().nullable(),
  next_price_paise: z.number().int().nullable(),
});
export type OwnerPrices = z.infer<typeof ownerPricesSchema>;

/** An offer code's price for each plan and cycle it covers. */
export const offerPreviewSchema = z.object({
  code: z.string(),
  description: z.string().nullable(),
  cycles: z.number().int().nullable(),
  prices: z.array(
    z.object({ plan_code: z.string(), billing_cycle: cycleSchema, price_paise: z.number().int() }),
  ),
});
export type OfferPreview = z.infer<typeof offerPreviewSchema>;

export const offerCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{3,20}$/, 'Enter the code as you were given it.');

/** The deal checkout uses on Razorpay (subscription_checkout_deal). */
export const checkoutDealSchema = z
  .object({
    deal_id: z.uuid(),
    price_paise: z.number().int(),
    list_price_paise: z.number().int(),
    cycles: z.number().int().nullable(),
    razorpay_plan_id: z.string().nullable(),
  })
  .nullable();

export type SpecialPrice = { pricePaise: number; cycles: number | null };

/** This plan and cycle's special price: the team's deal first, then an applied code. */
export function specialPrice(
  planCode: string,
  cycle: BillingCycle,
  deal: TeamDeal | null,
  offer: OfferPreview | null,
): SpecialPrice | null {
  if (deal) {
    return deal.plan_code === planCode && deal.billing_cycle === cycle
      ? { pricePaise: deal.price_paise, cycles: deal.cycles }
      : null;
  }
  const price = offer?.prices.find(
    (row) => row.plan_code === planCode && row.billing_cycle === cycle,
  );
  return price ? { pricePaise: price.price_paise, cycles: offer!.cycles } : null;
}

/** "for 3 months", "for 1 year". */
export function forCycles(cycles: number, cycle: BillingCycle) {
  return `for ${cycles} ${cycle === 'monthly' ? 'month' : 'year'}${cycles === 1 ? '' : 's'}`;
}
