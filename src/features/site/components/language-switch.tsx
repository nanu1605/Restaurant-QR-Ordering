'use client';

import { cn } from 'cn';
import { Languages } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect } from 'react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

import type { SiteLang } from '../content';
import { otherLanguageHref, siteLangOf } from '../i18n';

/** The group's name in the page's language, and each language by its own name. */
export type LanguageLabels = Record<SiteLang, string> & { group: string };

const LANGS: SiteLang[] = ['en', 'hi'];

/**
 * हिन्दी in the system font, so an English page doesn't download Noto's Devanagari file for
 * one word.
 */
const SYSTEM_FONT = { en: undefined, hi: '[font-family:system-ui,sans-serif]' };

/**
 * The page's language, and the same page in the other language keeping its query (plan, cycle,
 * campaign tags), or the Hindi home page from a page that is English only. Moves are
 * client-side, so the visit's source and its PostHog id carry over (W-13); HtmlLang sets
 * <html lang> after one.
 */
function useLanguages() {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  return {
    current: siteLangOf(pathname),
    other: otherLanguageHref(pathname) + (search ? `?${search}` : ''),
  };
}

/** English / हिन्दी buttons beside the theme ones. Links, so they also work before the page's JavaScript. */
export function LanguageSwitch({
  labels,
  className,
}: {
  labels: LanguageLabels;
  className?: string;
}) {
  const { current, other } = useLanguages();
  return (
    <div
      role="group"
      aria-label={labels.group}
      className={cn(
        'inline-flex gap-0.5 rounded-lg border border-line bg-surface p-0.5',
        className,
      )}
    >
      {LANGS.map((value) => {
        const item = cn(
          'inline-flex min-h-11 min-w-11 items-center justify-center rounded-md px-2.5 text-sm font-medium',
          SYSTEM_FONT[value],
        );
        return value === current ? (
          <span
            key={value}
            lang={value}
            aria-current="true"
            className={cn(item, 'bg-primary text-primary-foreground ring-1 ring-brand ring-inset')}
          >
            {labels[value]}
          </span>
        ) : (
          <Link
            key={value}
            href={other}
            lang={value}
            hrefLang={value}
            className={cn(item, 'text-ink-muted transition-colors hover:text-ink')}
          >
            {labels[value]}
          </Link>
        );
      })}
    </div>
  );
}

/** A language button for the website's top bar, beside the theme one. */
export function LanguageMenu({
  labels,
  className,
}: {
  labels: LanguageLabels;
  className?: string;
}) {
  const { current, other } = useLanguages();
  const router = useRouter();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-touch"
            aria-label={labels.group}
            className={className}
          />
        }
      >
        <Languages aria-hidden className="size-5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{labels.group}</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={current}
            onValueChange={(value) => {
              if (value !== current) router.push(other);
            }}
          >
            {LANGS.map((value) => (
              <DropdownMenuRadioItem
                key={value}
                value={value}
                lang={value}
                closeOnClick
                className={cn('min-h-11', SYSTEM_FONT[value])}
              >
                {labels[value]}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Keeps <html lang> on the page's language after a client-side move between the languages; a
 * full load already gets it from the proxy's x-site-lang header (W-16).
 */
export function HtmlLang({ lang }: { lang: SiteLang }) {
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);
  return null;
}
