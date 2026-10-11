'use client';

import { cn } from 'cn';
import { usePathname } from 'next/navigation';

import { otherLanguageHref, siteLangOf } from '../i18n';

/**
 * English / हिन्दी: this page in the other language, or the Hindi home page from a page that is
 * English only. A plain link, so <html lang> changes with the page. `label` is the other
 * language's own name; हिन्दी is drawn in the system font, so an English page doesn't download
 * Noto's Devanagari file for one word.
 */
export function LanguageSwitch({ label, className }: { label: string; className?: string }) {
  const pathname = usePathname();
  const to = siteLangOf(pathname) === 'hi' ? 'en' : 'hi';
  return (
    <a
      href={otherLanguageHref(pathname)}
      lang={to}
      hrefLang={to}
      className={cn(
        'inline-flex min-h-11 min-w-11 items-center justify-center',
        to === 'hi' && '[font-family:system-ui,sans-serif]',
        className,
      )}
    >
      {label}
    </a>
  );
}
