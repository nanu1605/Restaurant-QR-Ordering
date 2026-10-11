import { SITE } from '@/features/site/content';
import { pageMetadata } from '@/features/site/i18n';
import { ContactView } from '@/features/site/views/contact';

const { meta } = SITE.en.contact;

export const metadata = pageMetadata('en', '/contact', meta);

export default function ContactPage({ searchParams }: PageProps<'/contact'>) {
  return <ContactView lang="en" searchParams={searchParams} />;
}
