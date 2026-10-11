import { SITE } from '@/features/site/content';
import { pageMetadata } from '@/features/site/i18n';
import { PricingView } from '@/features/site/views/pricing';
import { APP_NAME } from '@/lib/config';

const { meta } = SITE.hi.pricing;

export const metadata = pageMetadata('hi', '/pricing', {
  title: { absolute: `${APP_NAME} · ${meta.title}` },
  description: meta.description,
});

export default function HindiPricingPage() {
  return <PricingView lang="hi" />;
}
