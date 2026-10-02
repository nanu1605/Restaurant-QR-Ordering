import type { Metadata } from 'next';

import {
  Faq,
  FinalCta,
  Hero,
  Highlights,
  Hindi,
  How,
  Problems,
  Roles,
} from '@/features/site/components/sections';
import { StickyCta } from '@/features/site/components/sticky-cta';
import { APP_NAME } from '@/lib/config';

export const metadata: Metadata = {
  title: { absolute: `${APP_NAME} · QR table ordering for restaurants` },
  description:
    'Guests order from their phone by scanning the table QR code. Kitchen and waiter screens update live, and bills print in one tap. Made for restaurants in India.',
};

export default function HomePage() {
  return (
    <>
      <Hero />
      <Problems />
      <How />
      <Roles />
      <Highlights />
      <Hindi />
      <Faq />
      <FinalCta />
      <StickyCta />
    </>
  );
}
