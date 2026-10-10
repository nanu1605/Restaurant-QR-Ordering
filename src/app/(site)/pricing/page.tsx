import type { Metadata } from 'next';

import { SITE } from '@/features/site/content';
import { PricingView } from '@/features/site/views/pricing';
import { APP_NAME } from '@/lib/config';

const { meta } = SITE.en.pricing;

export const metadata: Metadata = {
  title: { absolute: `${APP_NAME} · ${meta.title}` },
  description: meta.description,
};

export default function PricingPage() {
  return <PricingView lang="en" />;
}
