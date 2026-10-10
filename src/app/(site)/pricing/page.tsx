import type { Metadata } from 'next';

import { Money } from '@/components/shared/money';
import { PlanCards } from '@/features/site/components/plan-cards';
import { PlanComparison } from '@/features/site/components/plan-comparison';
import { PlanHelper } from '@/features/site/components/plan-helper';
import { Faq, FinalCta, Section } from '@/features/site/components/sections';
import { SITE } from '@/features/site/content';
import { fill, fillNodes } from '@/features/site/i18n';
import { getSitePricing } from '@/features/site/queries';
import { signupOpen } from '@/features/site/signup';
import { faqPage, JsonLd, softwareApplication } from '@/features/site/structured-data';
import { APP_NAME } from '@/lib/config';

const { meta } = SITE.en.pricing;

export const metadata: Metadata = {
  title: { absolute: `${APP_NAME} · ${meta.title}` },
  description: meta.description,
};

/** Plans, prices and limits straight from the database (docs/DECISIONS.md W-5). */
export default async function PricingPage() {
  const t = SITE.en.pricing;
  const pricing = await getSitePricing();
  const trialPlan = pricing.plans.find((plan) => plan.code === pricing.trialPlanCode);
  const signup = signupOpen();

  return (
    <>
      <section className="site-dots px-4 pt-12 pb-16 sm:px-6 sm:pt-16">
        <div className="mx-auto flex max-w-6xl flex-col gap-10">
          <div className="mx-auto flex max-w-2xl flex-col gap-4 text-center">
            <h1 className="text-3xl font-bold tracking-tight text-ink sm:text-4xl">{t.title}</h1>
            <p className="text-base text-ink-muted sm:text-lg">{t.lead}</p>
            {trialPlan && (
              <p className="font-semibold text-brand">
                {fill(t.trial, { plan: trialPlan.name, days: pricing.trialDays })}
              </p>
            )}
          </div>
          <PlanCards pricing={pricing} signup={signup} />
          <div className="mx-auto flex max-w-3xl flex-col gap-2 text-center text-sm text-ink-muted">
            {/* Self-serve signups set up for free (docs/DECISIONS.md W-10). */}
            <p>
              {fillNodes(signup ? t.setupFee.signup : t.setupFee.demo, {
                fee: (
                  <Money paise={pricing.setupFeePaise} fraction="auto" className="font-semibold" />
                ),
              })}
            </p>
            <p>{t.gst}</p>
            <p>{t.noCommission}</p>
          </div>
        </div>
      </section>
      <Section id="fit" title={t.fit.title} lead={t.fit.lead} className="bg-surface">
        <PlanHelper plans={pricing.plans} signup={signup} />
      </Section>
      <Section id="compare" title={t.compare.title}>
        <PlanComparison lang="en" plans={pricing.plans} />
      </Section>
      <Faq lang="en" items={t.faq.items} title={t.faq.title} />
      <FinalCta lang="en" />
      <JsonLd nodes={[softwareApplication(pricing), faqPage(t.faq.items)]} />
    </>
  );
}
