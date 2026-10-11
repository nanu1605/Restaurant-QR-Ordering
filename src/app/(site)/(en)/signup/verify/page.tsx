import type { Metadata } from 'next';

import { SITE } from '@/features/site/content';
import { VerifyView } from '@/features/site/views/verify';

export const metadata: Metadata = {
  title: SITE.en.verify.meta.title,
  robots: { index: false },
};

export default function VerifyPage() {
  return <VerifyView lang="en" />;
}
