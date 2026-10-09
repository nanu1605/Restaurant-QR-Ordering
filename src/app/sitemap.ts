import type { MetadataRoute } from 'next';

import { getPublicEnv } from '@/lib/env';

/**
 * The website's pages (docs/DECISIONS.md W-12). Sign-up isn't listed: the pages link to it, and
 * while it is closed it redirects to the contact page.
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
  return PATHS.map((path) => ({ url: new URL(path, appUrl).href }));
}
