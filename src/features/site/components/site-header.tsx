import { cn } from 'cn';

import { Wordmark } from '@/components/shared/logo';
import { buttonVariants } from '@/components/ui/button';
import { LANG_NAMES, STRINGS } from '@/features/ordering/strings';
import { ThemeMenu } from '@/features/theme/theme-switch';
import { APP_NAME } from '@/lib/config';

import { SITE, type SiteLang } from '../content';
import { fill } from '../i18n';
import { siteCta } from '../signup';
import { LanguageSwitch } from './language-switch';
import { SiteLink } from './site-link';
import { SiteMobileNav } from './site-mobile-nav';

/** The website's top bar: logo, sections, language, theme, log in and the main call to action. */
export function SiteHeader({ lang }: { lang: SiteLang }) {
  const t = SITE[lang];
  const cta = siteCta(lang);
  const { theme } = STRINGS[lang];
  const otherLanguage = LANG_NAMES[lang === 'en' ? 'hi' : 'en'];
  return (
    <header
      data-cta="header"
      className="sticky top-0 z-40 border-b border-line/70 bg-paper/85 backdrop-blur-md"
    >
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-3 px-4 sm:gap-6 sm:px-6">
        <SiteLink
          siteLang={lang}
          href="/"
          aria-label={fill(t.header.home, { app: APP_NAME })}
          className="inline-flex h-11 items-center rounded-lg"
        >
          <Wordmark />
        </SiteLink>
        <nav aria-label={t.header.main} className="hidden lg:block">
          <ul className="flex items-center gap-1">
            {t.nav.map((item) => (
              <li key={item.href}>
                <SiteLink
                  siteLang={lang}
                  href={item.href}
                  className="rounded-md px-3 py-2.5 text-sm font-medium text-ink-muted transition-colors hover:bg-muted hover:text-ink"
                >
                  {item.label}
                </SiteLink>
              </li>
            ))}
          </ul>
        </nav>
        <div className="ml-auto flex items-center gap-1 sm:gap-2">
          {/* Below 1024px the menu sheet carries them. */}
          <LanguageSwitch
            label={otherLanguage}
            className="hidden rounded-md px-3 text-sm font-medium text-ink-muted transition-colors hover:bg-muted hover:text-ink lg:inline-flex"
          />
          <ThemeMenu labels={theme} className="hidden lg:inline-flex" />
          <SiteLink
            siteLang={lang}
            href="/login"
            className={cn(
              buttonVariants({ variant: 'ghost' }),
              'hidden h-11 px-4 text-base sm:inline-flex',
            )}
          >
            {t.login}
          </SiteLink>
          {/* On the narrowest phones the menu and the hero carry it instead. */}
          <SiteLink
            siteLang={lang}
            href={cta.href}
            className={cn(
              buttonVariants(),
              'hidden h-11 px-3 text-sm min-[380px]:inline-flex sm:px-4 sm:text-base',
            )}
          >
            {cta.label}
          </SiteLink>
          <SiteMobileNav
            siteLang={lang}
            t={{
              nav: t.nav,
              login: t.login,
              menu: t.menu,
              main: t.header.main,
              theme,
              otherLanguage,
            }}
            cta={cta}
          />
        </div>
      </div>
    </header>
  );
}
