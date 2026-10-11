import type { Metadata } from 'next';

import { SITE } from '@/features/site/content';
import { ContactView } from '@/features/site/views/contact';

const { meta } = SITE.en.contact;

export const metadata: Metadata = { title: meta.title, description: meta.description };

export default function ContactPage({ searchParams }: PageProps<'/contact'>) {
  return <ContactView lang="en" searchParams={searchParams} />;
}
