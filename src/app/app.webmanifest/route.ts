import type { MetadataRoute } from 'next';

import { APP_NAME, THEME_COLOR } from '@/lib/config';

/**
 * The install manifest for the staff and admin panels (spec §19 Phase 9,
 * docs/DECISIONS.md P9-6). Only their layouts link it, so customer pages are
 * never offered for install. It opens on /login, which sends a signed-in user
 * straight to their panel.
 */
export function GET() {
  const manifest: MetadataRoute.Manifest = {
    id: '/login',
    name: APP_NAME,
    short_name: APP_NAME,
    description: 'Live orders, kitchen and billing for your restaurant.',
    start_url: '/login',
    scope: '/',
    display: 'standalone',
    background_color: '#FAF8F5',
    theme_color: THEME_COLOR,
    icons: [
      { src: '/icon/192?v=2', sizes: '192x192', type: 'image/png' },
      { src: '/icon/512?v=2', sizes: '512x512', type: 'image/png' },
      { src: '/maskable-icon.png?v=2', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
  return Response.json(manifest, { headers: { 'Content-Type': 'application/manifest+json' } });
}
