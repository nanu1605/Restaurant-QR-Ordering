import { SITE } from '@/features/site/content';
import { pageMetadata } from '@/features/site/i18n';
import { SignupView } from '@/features/site/views/signup';

const { meta } = SITE.en.signup;

export const metadata = pageMetadata('en', '/signup', meta);

export default function SignupPage({ searchParams }: PageProps<'/signup'>) {
  return <SignupView lang="en" searchParams={searchParams} />;
}
