import { SITE, type SiteLang } from '../content';
import { SiteFooter } from './site-footer';
import { SiteHeader } from './site-header';

/**
 * The website's frame in one language: the skip link, header and footer. The wrapper's lang
 * also covers a page reached by a client-side link from the guest menu, which keeps the menu's
 * <html lang>.
 */
export function SiteChrome({ lang, children }: { lang: SiteLang; children: React.ReactNode }) {
  return (
    <div lang={lang} className="site flex flex-1 flex-col">
      <a
        href="#main"
        className="sr-only z-50 rounded-md bg-surface px-4 py-2 font-semibold text-brand focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        {SITE[lang].skipToContent}
      </a>
      <SiteHeader lang={lang} />
      <main id="main" className="flex flex-1 flex-col">
        {children}
      </main>
      <SiteFooter lang={lang} />
    </div>
  );
}
