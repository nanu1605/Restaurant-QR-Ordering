import { cn } from 'cn';
import Link from 'next/link';

import { Wordmark } from '@/components/shared/logo';
import { buttonVariants } from '@/components/ui/button';
import { APP_NAME } from '@/lib/config';

import { SITE_NAV } from '../content';
import { siteCta } from '../signup';
import { SiteLink } from './site-link';
import { SiteMobileNav } from './site-mobile-nav';

/** The website's top bar: logo, sections, log in and the main call to action. */
export function SiteHeader() {
  const cta = siteCta();
  return (
    <header className="sticky top-0 z-40 border-b border-line/70 bg-paper/85 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-3 px-4 sm:gap-6 sm:px-6">
        <Link
          href="/"
          aria-label={`${APP_NAME} home`}
          className="inline-flex h-11 items-center rounded-lg"
        >
          <Wordmark />
        </Link>
        <nav aria-label="Main" className="hidden lg:block">
          <ul className="flex items-center gap-1">
            {SITE_NAV.map((item) => (
              <li key={item.href}>
                <SiteLink
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
          <Link
            href="/login"
            className={cn(
              buttonVariants({ variant: 'ghost' }),
              'hidden h-11 px-4 text-base sm:inline-flex',
            )}
          >
            Log in
          </Link>
          {/* On the narrowest phones the menu and the hero carry it instead. */}
          <Link
            href={cta.href}
            className={cn(
              buttonVariants(),
              'hidden h-11 px-3 text-sm min-[380px]:inline-flex sm:px-4 sm:text-base',
            )}
          >
            {cta.label}
          </Link>
          <SiteMobileNav cta={cta} />
        </div>
      </div>
    </header>
  );
}
