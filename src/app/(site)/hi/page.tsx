import { SITE } from '@/features/site/content';
import { pageMetadata } from '@/features/site/i18n';
import { HomeView } from '@/features/site/views/home';
import { APP_NAME } from '@/lib/config';

const { meta } = SITE.hi.home;

export const metadata = pageMetadata('hi', '/', {
  title: { absolute: `${APP_NAME} · ${meta.title}` },
  description: meta.description,
});

export default function HindiHomePage() {
  return <HomeView lang="hi" />;
}
