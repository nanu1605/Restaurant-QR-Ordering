import { SITE } from '@/features/site/content';
import { pageMetadata } from '@/features/site/i18n';
import { ContactView } from '@/features/site/views/contact';

const { meta } = SITE.hi.contact;

export const metadata = pageMetadata('hi', '/contact', meta);

export default function HindiContactPage({ searchParams }: PageProps<'/hi/contact'>) {
  return <ContactView lang="hi" searchParams={searchParams} />;
}
