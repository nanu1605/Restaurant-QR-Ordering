import type { Metadata } from 'next';

import { SiteAnalytics } from '@/features/analytics/site-analytics';
import { SiteMotion } from '@/features/site/components/motion';
import { APP_NAME } from '@/lib/config';

/**
 * Every page is its own canonical, without ?plan or ?cycle, and shares the site's link preview
 * (opengraph-image.tsx; docs/DECISIONS.md W-12). Titles and descriptions come from each page.
 */
export const metadata: Metadata = {
  alternates: { canonical: './' },
  openGraph: { type: 'website', siteName: APP_NAME, locale: 'en_IN', url: './' },
  twitter: { card: 'summary_large_image' },
};

/**
 * The public website (docs/DECISIONS.md W-1): home, contact and the policies, in English, and in
 * Hindi under /hi. Each language's layout draws the header and footer (SiteChrome).
 */
export default function SiteLayout({ children }: LayoutProps<'/'>) {
  return (
    <SiteMotion>
      {children}
      <SiteAnalytics />
    </SiteMotion>
  );
}
