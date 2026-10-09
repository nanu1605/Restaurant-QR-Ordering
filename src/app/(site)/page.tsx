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
import { FAQ } from '@/features/site/content';
import { getSitePricing } from '@/features/site/queries';
import { siteCta } from '@/features/site/signup';
import { faqPage, JsonLd, organization, website } from '@/features/site/structured-data';
import { APP_NAME } from '@/lib/config';

export const metadata: Metadata = {
  title: { absolute: `${APP_NAME} · QR table ordering for restaurants` },
  description:
    'Guests order from their phone by scanning the table QR code. Kitchen and waiter screens update live, and bills print in one tap. Made for restaurants in India.',
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
      <Hero />
      <Problems />
      <How />
      <Roles />
      <Highlights />
      <Hindi />
      <NextSteps fromPaise={fromPaise} />
      <Faq />
      <FinalCta />
      <StickyCta cta={siteCta()} />
      <JsonLd nodes={[organization(), website(), faqPage(FAQ)]} />
    </>
  );
}
