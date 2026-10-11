import {
  Faq,
  FinalCta,
  Hero,
  Highlights,
  Hindi,
  How,
  NextSteps,
  Problems,
  Roles,
} from '../components/sections';
import { StickyCta } from '../components/sticky-cta';
import { SITE, type SiteLang } from '../content';
import { getSitePricing } from '../queries';
import { siteCta } from '../signup';
import { faqPage, JsonLd, organization, website } from '../structured-data';

/** The lowest monthly price, or null if the plans can't be read (the page still renders). */
async function lowestMonthlyPaise(): Promise<number | null> {
  try {
    const { plans } = await getSitePricing();
    return plans.length > 0 ? Math.min(...plans.map((plan) => plan.monthlyPaise)) : null;
  } catch (error) {
    console.error('[site] plans not loaded for the home page:', error);
    return null;
  }
}

export async function HomeView({ lang }: { lang: SiteLang }) {
  const fromPaise = await lowestMonthlyPaise();
  return (
    <>
      <Hero lang={lang} />
      <Problems lang={lang} />
      <How lang={lang} />
      <Roles lang={lang} />
      <Highlights lang={lang} />
      <Hindi lang={lang} />
      <NextSteps lang={lang} fromPaise={fromPaise} />
      <Faq lang={lang} />
      <FinalCta lang={lang} />
      <StickyCta cta={siteCta(lang)} />
      <JsonLd nodes={[organization(), website(), faqPage(SITE[lang].faq.items, lang)]} />
    </>
  );
}
