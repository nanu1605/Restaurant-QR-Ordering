import { Money } from '@/components/shared/money';

import { PlanCards } from '../components/plan-cards';
import { PlanComparison } from '../components/plan-comparison';
import { PlanHelper } from '../components/plan-helper';
import { Faq, FinalCta, Section } from '../components/sections';
import { SITE, type SiteLang } from '../content';
import { fill, fillNodes } from '../i18n';
import { getSitePricing } from '../queries';
import { signupOpen } from '../signup';
import { faqPage, JsonLd, softwareApplication } from '../structured-data';

/** Plans, prices and limits straight from the database (docs/DECISIONS.md W-5). */
export async function PricingView({ lang }: { lang: SiteLang }) {
  const site = SITE[lang];
  const t = site.pricing;
  // The words both client parts share.
  const shared = { cta: site.cta, per: site.per, limits: t.limits, features: site.labels.features };
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
          <PlanCards
            siteLang={lang}
            t={{ ...shared, cards: t.cards, blurbs: t.blurbs, everyPlan: t.everyPlan }}
            pricing={pricing}
            signup={signup}
          />
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
        <PlanHelper
          siteLang={lang}
          t={{ ...shared, helper: t.helper }}
          plans={pricing.plans}
          signup={signup}
        />
      </Section>
      <Section id="compare" title={t.compare.title}>
        <PlanComparison lang={lang} plans={pricing.plans} />
      </Section>
      <Faq lang={lang} items={t.faq.items} title={t.faq.title} />
      <FinalCta lang={lang} />
      <JsonLd nodes={[softwareApplication(pricing, lang), faqPage(t.faq.items)]} />
    </>
  );
}
