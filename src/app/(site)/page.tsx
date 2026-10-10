import type { Metadata } from 'next';

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
} from '@/features/site/components/sections';
import { StickyCta } from '@/features/site/components/sticky-cta';
import { SITE } from '@/features/site/content';
import { getSitePricing } from '@/features/site/queries';
import { siteCta } from '@/features/site/signup';
import { faqPage, JsonLd, organization, website } from '@/features/site/structured-data';
import { APP_NAME } from '@/lib/config';

const { meta } = SITE.en.home;

export const metadata: Metadata = {
  title: { absolute: `${APP_NAME} · ${meta.title}` },
  description: meta.description,
};

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

export default async function HomePage() {
  const fromPaise = await lowestMonthlyPaise();
  return (
    <>
      <Hero lang="en" />
      <Problems lang="en" />
      <How lang="en" />
      <Roles lang="en" />
      <Highlights lang="en" />
      <Hindi lang="en" />
      <NextSteps lang="en" fromPaise={fromPaise} />
      <Faq lang="en" />
      <FinalCta lang="en" />
      <StickyCta cta={siteCta('en')} />
      <JsonLd nodes={[organization(), website(), faqPage(SITE.en.faq.items)]} />
    </>
  );
}
