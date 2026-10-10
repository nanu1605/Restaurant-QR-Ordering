import type { Metadata } from 'next';

import { SITE } from '@/features/site/content';
import { SignupView } from '@/features/site/views/signup';

const { meta } = SITE.en.signup;

export const metadata: Metadata = { title: meta.title, description: meta.description };

export default function SignupPage({ searchParams }: PageProps<'/signup'>) {
  return <SignupView lang="en" searchParams={searchParams} />;
}
