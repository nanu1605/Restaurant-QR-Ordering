import type { Metadata } from 'next';

import { Money } from '@/components/shared/money';
import { PRICING, PRICING_FAQ } from '@/features/site/content';
import { PlanCards } from '@/features/site/components/plan-cards';
import { PlanComparison } from '@/features/site/components/plan-comparison';
import { PlanHelper } from '@/features/site/components/plan-helper';
import { Faq, FinalCta, Section } from '@/features/site/components/sections';
import { getSitePricing } from '@/features/site/queries';
import { APP_NAME } from '@/lib/config';

export const metadata: Metadata = {
  title: { absolute: `${APP_NAME} · Pricing` },
  description:
    'Plans for every size of restaurant, paid monthly or yearly. QR ordering, the staff board, bills and the Hindi menu in every plan.',
};

/** Plans, prices and limits straight from the database (docs/DECISIONS.md W-5). */
export default async function PricingPage() {
  const pricing = await getSitePricing();
  const trialPlan = pricing.plans.find((plan) => plan.code === pricing.trialPlanCode);

  return (
    <>
      <section className="site-dots px-4 pt-12 pb-16 sm:px-6 sm:pt-16">
        <div className="mx-auto flex max-w-6xl flex-col gap-10">
          <div className="mx-auto flex max-w-2xl flex-col gap-4 text-center">
            <h1 className="text-3xl font-bold tracking-tight text-ink sm:text-4xl">
              {PRICING.title}
            </h1>
            <p className="text-base text-ink-muted sm:text-lg">{PRICING.lead}</p>
            {trialPlan && (
              <p className="font-semibold text-brand">
                Try the {trialPlan.name} plan free for {pricing.trialDays} days.
              </p>
            )}
          </div>
          <PlanCards pricing={pricing} />
          <div className="mx-auto flex max-w-3xl flex-col gap-2 text-center text-sm text-ink-muted">
            <p>
              One-time setup fee of{' '}
              <Money paise={pricing.setupFeePaise} fraction="auto" className="font-semibold" />: we
              set up your menu and tables with you, with printed QR codes for your tables.
            </p>
            <p>{PRICING.noCommission}</p>
          </div>
        </div>
      </section>
      <Section
        id="fit"
        title="Which plan fits me?"
        lead="Tell us about your restaurant and we’ll pick the plan that covers it."
        className="bg-surface"
      >
        <PlanHelper plans={pricing.plans} />
      </Section>
      <Section id="compare" title="Compare the plans">
        <PlanComparison plans={pricing.plans} />
      </Section>
      <Faq items={PRICING_FAQ} title="Pricing questions" />
      <FinalCta />
    </>
  );
}
