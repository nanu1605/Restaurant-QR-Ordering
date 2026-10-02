import { SiteMotion } from '@/features/site/components/motion';
import { SiteFooter } from '@/features/site/components/site-footer';
import { SiteHeader } from '@/features/site/components/site-header';

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
      </div>
    </SiteMotion>
  );
}
