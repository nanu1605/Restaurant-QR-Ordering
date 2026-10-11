import { SITE } from '@/features/site/content';
import { pageMetadata } from '@/features/site/i18n';
import { DemoView } from '@/features/site/views/demo';
import { APP_NAME } from '@/lib/config';

const { meta } = SITE.hi.demo;

export const metadata = pageMetadata('hi', '/demo', {
  title: { absolute: `${APP_NAME} · ${meta.title}` },
  description: meta.description,
});

export default function HindiDemoPage() {
  return <DemoView lang="hi" />;
}
