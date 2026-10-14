import { z } from 'zod';

/**
 * A restaurant's setup steps (docs/SUPER_ADMIN_PLAN.md §5.13, docs/DECISIONS.md
 * SA-41), as private.restaurant_onboarding works them out for the restaurant
 * page, the Restaurants list, Needs attention and the owner's first-steps card.
 */
export const ONBOARDING_STEPS = [
  'menu',
  'tables',
  'qr',
  'team',
  'first_order',
  'first_bill',
  'paid',
] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export const ONBOARDING_STEP_LABELS: Record<OnboardingStep, string> = {
  menu: 'Menu added (5 dishes)',
  tables: 'Tables created',
  qr: 'QR codes downloaded or printed',
  team: 'Team added',
  first_order: 'First QR order',
  first_bill: 'First bill',
  paid: 'First payment or autopay',
};

const summary = {
  done: z.number(),
  /** The first step still to do; null when all are done. */
  next: z.enum(ONBOARDING_STEPS).nullable(),
  /** When the last step was done, or the restaurant created before the first. */
  since: z.string(),
  /** A step to do and none done in 3 days. */
  stuck: z.boolean(),
};
export const onboardingSummarySchema = z.object(summary);
export type OnboardingSummary = z.infer<typeof onboardingSummarySchema>;

export const onboardingSchema = z.object({
  ...summary,
  steps: z.array(z.object({ key: z.enum(ONBOARDING_STEPS), done_at: z.string().nullable() })),
});
export type Onboarding = z.infer<typeof onboardingSchema>;
export const parseOnboarding = (json: unknown) => onboardingSchema.parse(json);

/** "3 of 7 done", or "Done". */
export function onboardingLabel(onboarding: OnboardingSummary): string {
  return onboarding.next === null
    ? 'Done'
    : `${onboarding.done} of ${ONBOARDING_STEPS.length}: ${ONBOARDING_STEP_LABELS[onboarding.next]}`;
}
