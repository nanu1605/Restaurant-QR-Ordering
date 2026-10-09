import type { MetadataRoute } from 'next';

import { getPublicEnv } from '@/lib/env';

/**
 * What search engines may crawl (docs/DECISIONS.md W-12): the website and the login page. The
 * panels only redirect to login when signed out, and the API and the email code step have
 * nothing to show. Customer pages stay crawlable so their noindex is seen. Hosts other than
 * menumesh.in also send noindex (src/proxy.ts).
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: ['/admin', '/staff', '/super', '/api/', '/logout', '/signup/verify'],
    },
    sitemap: new URL('/sitemap.xml', getPublicEnv().NEXT_PUBLIC_APP_URL).href,
  };
}
