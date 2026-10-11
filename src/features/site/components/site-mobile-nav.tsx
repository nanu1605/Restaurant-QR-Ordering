'use client';

import { cn } from 'cn';
import { Menu, XIcon } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useRef, useState } from 'react';

import { Button, buttonVariants } from '@/components/ui/button';
import { Sheet, SheetClose, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { ThemeSwitch } from '@/features/theme/theme-switch';
import type { ThemeLabels } from '@/features/theme/theme';

import type { SiteContent, SiteLang } from '../content';
import { sitePath } from '../i18n';
import { type LanguageLabels, LanguageSwitch } from './language-switch';
import { SiteLink } from './site-link';

/**
 * The sections and log in, in a sheet below 1024px. A section on this page is
 * reached once the sheet has closed and released its scroll lock; focus then
 * moves to the section's heading rather than back to the menu button.
 */
export function SiteMobileNav({
  siteLang,
  t,
  cta,
}: {
  siteLang: SiteLang;
  t: Pick<SiteContent, 'nav' | 'login' | 'menu'> & {
    main: string;
    theme: ThemeLabels;
    language: LanguageLabels;
  };
  cta: { href: string; label: string };
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const section = useRef<string | null>(null);

  function goTo(event: React.MouseEvent<HTMLAnchorElement>, href: string) {
    const [path, hash] = href.split('#');
    if (hash && path === pathname) {
      event.preventDefault();
      section.current = hash;
    }
    setOpen(false);
  }

  return (
    <Sheet
      open={open}
      onOpenChange={setOpen}
      onOpenChangeComplete={(isOpen) => {
        const id = section.current;
        if (isOpen || !id) return;
        section.current = null;
        // After the scroll lock has put the page back where it was.
        requestAnimationFrame(() => {
          const target = document.getElementById(id);
          if (!target) return;
          history.pushState(null, '', `#${id}`);
          target.scrollIntoView();
          target.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true });
        });
      }}
    >
      <SheetTrigger
        render={
          <Button
            variant="ghost"
            size="icon-touch"
            className="lg:hidden"
            aria-label={t.menu.open}
          />
        }
      >
        <Menu aria-hidden className="size-6" />
      </SheetTrigger>
      <SheetContent
        side="right"
        showCloseButton={false}
        data-cta="menu"
        finalFocus={() => section.current === null}
        className="gap-6 overflow-y-auto p-6 data-[side=right]:w-80"
      >
        <div className="flex items-center justify-between">
          <SheetTitle className="text-base font-semibold text-ink">{t.menu.title}</SheetTitle>
          <SheetClose
            render={<Button variant="ghost" size="icon-touch" aria-label={t.menu.close} />}
          >
            <XIcon aria-hidden className="size-5" />
          </SheetClose>
        </div>
        <nav aria-label={t.main}>
          <ul className="flex flex-col gap-1">
            {t.nav.map((item) => {
              // Each entry has a twin in both languages, so next/link never leaves the language.
              const href = sitePath(siteLang, item.href);
              return (
                <li key={item.href}>
                  <Link
                    href={href}
                    onClick={(event) => goTo(event, href)}
                    className="flex h-12 items-center rounded-lg px-3 text-base font-medium text-ink hover:bg-muted"
                  >
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
        <div className="flex flex-col items-start gap-3">
          <ThemeSwitch labels={t.theme} />
          <LanguageSwitch labels={t.language} />
        </div>
        <div className="mt-auto flex flex-col gap-3">
          <SiteLink
            siteLang={siteLang}
            href="/login"
            onClick={() => setOpen(false)}
            className={cn(buttonVariants({ variant: 'outline', size: 'touch' }), 'w-full')}
          >
            {t.login}
          </SiteLink>
          <SiteLink
            siteLang={siteLang}
            href={cta.href}
            onClick={() => setOpen(false)}
            className={cn(buttonVariants({ size: 'touch' }), 'w-full')}
          >
            {cta.label}
          </SiteLink>
        </div>
      </SheetContent>
    </Sheet>
  );
}
