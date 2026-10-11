import { SITE } from '@/features/site/content';
import { pageMetadata } from '@/features/site/i18n';
import { SignupView } from '@/features/site/views/signup';

const { meta } = SITE.hi.signup;

export const metadata = pageMetadata('hi', '/signup', meta);

export default function HindiSignupPage({ searchParams }: PageProps<'/hi/signup'>) {
  return <SignupView lang="hi" searchParams={searchParams} />;
}
