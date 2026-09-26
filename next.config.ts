import { withSentryConfig } from '@sentry/nextjs/config';
import type { NextConfig } from 'next';

type RemotePattern = Exclude<
  NonNullable<NextConfig['images']>['remotePatterns'],
  undefined
>[number];

/**
 * Menu photos and logos come from Supabase Storage's public buckets and are
 * resized by next/image for the customer menu (spec §13.1 performance).
 */
function storageImages(): { patterns: RemotePattern[]; local: boolean } {
  const raw = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!raw) return { patterns: [], local: false };
  const url = new URL(raw);
  return {
    patterns: [
      {
        protocol: url.protocol === 'https:' ? 'https' : 'http',
        hostname: url.hostname,
        port: url.port,
        pathname: '/storage/v1/object/public/**',
        // No `search`: image URLs carry ?v=<updated_at> so replaced photos refresh.
      },
    ],
    local: ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname),
  };
}

const images = storageImages();

/** Static security headers; the per-request Content-Security-Policy is set in src/proxy.ts. */
const SECURITY_HEADERS = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  // Screen wake lock (the board tablets) stays allowed.
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  // No includeSubDomains: other subdomains of the domain are not ours to promise.
  { key: 'Strict-Transport-Security', value: 'max-age=63072000' },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [{ source: '/:path*', headers: SECURITY_HEADERS }];
  },
  images: {
    remotePatterns: images.patterns,
    // Next.js 16 refuses to optimise images from local addresses. Only the
    // local Supabase stack (dev and CI) serves from one.
    dangerouslyAllowLocalIP: images.local,
  },
  experimental: {
    // A menu CSV may be up to 1 MB (docs/DECISIONS.md P7-16); the default limit is 1 MB.
    serverActions: { bodySizeLimit: '2mb' },
  },
};

/**
 * Sentry (docs/DECISIONS.md P10-3): errors only, so tracing, replay and debug
 * code are left out of the bundle. Browsers send to Sentry directly: a relay on
 * our origin would forward our cookies too. Source maps are uploaded only where
 * the Sentry build token is set (Vercel).
 */
export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  sourcemaps: { disable: !process.env.SENTRY_AUTH_TOKEN },
  silent: !process.env.SENTRY_AUTH_TOKEN,
  telemetry: false,
  suppressOnRouterTransitionStartWarning: true,
  bundleSizeOptimizations: {
    excludeDebugStatements: true,
    excludeTracing: true,
    excludeReplayIframe: true,
    excludeReplayShadowDom: true,
    excludeReplayWorker: true,
  },
});
