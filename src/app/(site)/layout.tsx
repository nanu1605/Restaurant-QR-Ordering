import type { Metadata } from 'next';

import { SiteAnalytics } from '@/features/analytics/site-analytics';
import { SiteMotion } from '@/features/site/components/motion';
import { SiteFooter } from '@/features/site/components/site-footer';
import { SiteHeader } from '@/features/site/components/site-header';
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
 * The public website (docs/DECISIONS.md W-1): home, contact and the policies.
 * Always English: a guest who chose Hindi on the menu may arrive here by a
 * client-side link, which keeps <html lang> from the menu.
 */
export default function SiteLayout({ children }: LayoutProps<'/'>) {
  return (
    <SiteMotion>
      <div lang="en" className="site flex flex-1 flex-col">
        <a
          href="#main"
          className="sr-only z-50 rounded-md bg-surface px-4 py-2 font-semibold text-brand focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
        >
          Skip to content
        </a>
        <SiteHeader />
        <main id="main" className="flex flex-1 flex-col">
          {children}
        </main>
        <SiteFooter />
        <SiteAnalytics />
      </div>
    </SiteMotion>
  );
}
