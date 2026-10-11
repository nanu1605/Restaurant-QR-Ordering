import { SITE } from '@/features/site/content';
import { pageMetadata } from '@/features/site/i18n';
import { FeaturesView } from '@/features/site/views/features';
import { APP_NAME } from '@/lib/config';

const { meta } = SITE.en.featuresPage;

export const metadata = pageMetadata('en', '/features', {
  title: { absolute: `${APP_NAME} · ${meta.title}` },
  description: meta.description,
});

export default function FeaturesPage() {
  return <FeaturesView lang="en" />;
}
