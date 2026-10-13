import type { Metadata } from 'next';

/**
 * Product name used across the UI, bills ("Powered by …") and metadata.
 * Renaming the product should only require changing this value, APP_DOMAIN
 * and the package name in package.json.
 */
export const APP_NAME = 'MenuMesh';

/** The company behind MenuMesh, on the installed app's launch screen (docs/DECISIONS.md P11-4). */
export const COMPANY_NAME = 'Jainav Infotech Pvt Ltd';

/** Browser and installed-app bar colour: the header surface (globals.css --surface), per theme. */
export const THEME_COLOR = '#FFFFFF';
export const THEME_COLOR_DARK = '#1C1A18';

/**
 * The install manifest and home screen name, linked from the website, the login
 * page and the staff and admin layouts (spec §19 Phase 9, docs/DECISIONS.md
 * P9-6). Customer pages don't link it.
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

/** Set by the proxy on worker panel pages, so the root layout uses the login's language (P11-15). */
export const STAFF_PANEL_HEADER = 'x-staff-panel';
