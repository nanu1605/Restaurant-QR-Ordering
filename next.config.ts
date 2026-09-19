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

const nextConfig: NextConfig = {
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

export default nextConfig;
