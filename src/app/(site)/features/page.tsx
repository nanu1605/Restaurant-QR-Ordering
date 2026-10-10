import type { Metadata } from 'next';

import { SITE } from '@/features/site/content';
import { FeaturesView } from '@/features/site/views/features';
import { APP_NAME } from '@/lib/config';

const { meta } = SITE.en.featuresPage;

export const metadata: Metadata = {
  title: { absolute: `${APP_NAME} · ${meta.title}` },
  description: meta.description,
};

export default function FeaturesPage() {
  return <FeaturesView lang="en" />;
}
