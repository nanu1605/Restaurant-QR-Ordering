import { SITE } from '@/features/site/content';
import { pageMetadata } from '@/features/site/i18n';
import { HomeView } from '@/features/site/views/home';
import { APP_NAME } from '@/lib/config';

const { meta } = SITE.en.home;

export const metadata = pageMetadata('en', '/', {
  title: { absolute: `${APP_NAME} · ${meta.title}` },
  description: meta.description,
});

export default function HomePage() {
  return <HomeView lang="en" />;
}
