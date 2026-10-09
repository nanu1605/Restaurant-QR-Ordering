'use client';

import { cn } from 'cn';
import { Menu, XIcon } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useRef, useState } from 'react';

import { Button, buttonVariants } from '@/components/ui/button';
import { Sheet, SheetClose, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { ThemeSwitch } from '@/features/theme/theme-switch';

import { SITE_NAV } from '../content';

/**
 * The sections and log in, in a sheet below 1024px. A section on this page is
 * reached once the sheet has closed and released its scroll lock; focus then
 * moves to the section's heading rather than back to the menu button.
 */
export function SiteMobileNav({ cta }: { cta: { href: string; label: string } }) {
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
          <Button variant="ghost" size="icon-touch" className="lg:hidden" aria-label="Open menu" />
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
          <SheetTitle className="text-base font-semibold text-ink">Menu</SheetTitle>
          <SheetClose render={<Button variant="ghost" size="icon-touch" aria-label="Close" />}>
            <XIcon aria-hidden className="size-5" />
          </SheetClose>
        </div>
        <nav aria-label="Main">
          <ul className="flex flex-col gap-1">
            {SITE_NAV.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  onClick={(event) => goTo(event, item.href)}
                  className="flex h-12 items-center rounded-lg px-3 text-base font-medium text-ink hover:bg-muted"
                >
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <ThemeSwitch className="self-start" />
        <div className="mt-auto flex flex-col gap-3">
          <Link
            href="/login"
            onClick={() => setOpen(false)}
            className={cn(buttonVariants({ variant: 'outline', size: 'touch' }), 'w-full')}
          >
            Log in
          </Link>
          <Link
            href={cta.href}
            onClick={() => setOpen(false)}
            className={cn(buttonVariants({ size: 'touch' }), 'w-full')}
          >
            {cta.label}
          </Link>
        </div>
      </SheetContent>
    </Sheet>
  );
}
