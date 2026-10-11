import { SiteChrome } from '@/features/site/components/site-chrome';

/** The English website: every page outside /hi, the policies too. */
export default function EnglishLayout({ children }: LayoutProps<'/'>) {
  return <SiteChrome lang="en">{children}</SiteChrome>;
}
