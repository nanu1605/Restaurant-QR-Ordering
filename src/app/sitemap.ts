import type { MetadataRoute } from 'next';

import { HINDI_PAGES, sitePath } from '@/features/site/i18n';
import { getPublicEnv } from '@/lib/env';

/**
 * The website's pages (docs/DECISIONS.md W-12), each with its Hindi twin under /hi; the policies
 * are English only. Sign-up isn't listed: the pages link to it, and while it is closed it
 * redirects to the contact page.
 */
const PATHS = [
  '/',
  '/features',
  '/pricing',
  '/demo',
  '/contact',
  '/terms',
  '/privacy',
  '/refund',
  '/shipping',
];

export default function sitemap(): MetadataRoute.Sitemap {
  const appUrl = getPublicEnv().NEXT_PUBLIC_APP_URL;
  const url = (path: string) => new URL(path, appUrl).href;
  return PATHS.flatMap((path) => {
    if (!HINDI_PAGES.includes(path)) return [{ url: url(path) }];
    const hindi = url(sitePath('hi', path));
    const languages = { 'en-IN': url(path), 'hi-IN': hindi, 'x-default': url(path) };
    return [
      { url: url(path), alternates: { languages } },
      { url: hindi, alternates: { languages } },
    ];
  });
}
