import type { Metadata } from 'next';

/**
 * Product name used across the UI, bills ("Powered by …") and metadata.
 * Renaming the product should only require changing this value, APP_DOMAIN
 * and the package name in package.json.
 */
export const APP_NAME = 'MenuMesh';

/** The brand colour (globals.css --brand): browser chrome and app icons. */
export const BRAND_COLOR = '#3B4BA8';

/**
 * The staff and admin layouts' install manifest and home screen name (spec §19
 * Phase 9, docs/DECISIONS.md P9-6). Customer pages don't link it.
 */
export const INSTALLABLE = {
  manifest: '/app.webmanifest',
  appleWebApp: { capable: true, title: APP_NAME },
} satisfies Metadata;

/** The public domain, printed after "Powered by …" on bills. */
export const APP_DOMAIN = 'menumesh.in';

/** Default timezone for new restaurants; each restaurant stores its own. */
export const DEFAULT_TIMEZONE = 'Asia/Kolkata';

export const DEFAULT_LOCALE = 'en-IN';
