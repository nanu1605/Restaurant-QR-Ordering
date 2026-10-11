'use client';

import { cn } from 'cn';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useEffect } from 'react';

import type { SiteLang } from '../content';
import { otherLanguageHref, siteLangOf } from '../i18n';

/**
 * English / हिन्दी: this page in the other language, keeping its query (plan, cycle, campaign
 * tags), or the Hindi home page from a page that is English only. A client-side move, so the
 * visit's source and its PostHog id carry over (W-13); HtmlLang sets <html lang> after it.
 * `label` is the other language's own name; हिन्दी is drawn in the system font, so an English
 * page doesn't download Noto's Devanagari file for one word.
 */
export function LanguageSwitch({ label, className }: { label: string; className?: string }) {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const to = siteLangOf(pathname) === 'hi' ? 'en' : 'hi';
  return (
    <Link
      href={otherLanguageHref(pathname) + (search ? `?${search}` : '')}
      lang={to}
      hrefLang={to}
      className={cn(
        'inline-flex min-h-11 min-w-11 items-center justify-center',
        to === 'hi' && '[font-family:system-ui,sans-serif]',
        className,
      )}
    >
      {label}
    </Link>
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
