import type { Metadata, Viewport } from 'next';
import { cookies, headers } from 'next/headers';

import { AppSplash } from '@/components/shared/app-splash';
import { Toaster } from '@/components/ui/sonner';
import { NewVersionNotice } from '@/features/new-version/components/new-version-notice';
import { getLang } from '@/features/ordering/lang';
import { type Lang, STRINGS } from '@/features/ordering/strings';
import { SITE_LANG_HEADER } from '@/features/site/i18n';
import { parseTheme, THEME_COOKIE } from '@/features/theme/theme';
import { ThemeProvider } from '@/features/theme/theme-switch';
import { getCurrentMembership } from '@/lib/auth/session';
import { APP_NAME, STAFF_PANEL_HEADER, THEME_COLOR, THEME_COLOR_DARK } from '@/lib/config';
import { getPublicEnv } from '@/lib/env';

import { notoSans } from './fonts';
import './globals.css';

export const metadata: Metadata = {
  // Absolute link-preview and canonical URLs on this environment's host (docs/DECISIONS.md W-12).
  metadataBase: new URL(getPublicEnv().NEXT_PUBLIC_APP_URL),
  title: {
    default: APP_NAME,
    template: `%s · ${APP_NAME}`,
  },
  description: 'QR code table ordering for restaurants.',
};

async function getTheme() {
  return parseTheme((await cookies()).get(THEME_COOKIE)?.value);
}

// The chosen theme is in the first HTML, so no script is needed against a flash.
export async function generateViewport(): Promise<Viewport> {
  const theme = await getTheme();
  if (theme !== 'system') {
    return { colorScheme: theme, themeColor: theme === 'dark' ? THEME_COLOR_DARK : THEME_COLOR };
  }
  return {
    colorScheme: 'light dark',
    themeColor: [
      { media: '(prefers-color-scheme: light)', color: THEME_COLOR },
      { media: '(prefers-color-scheme: dark)', color: THEME_COLOR_DARK },
    ],
  };
}

/**
 * The website's language from the proxy (Hindi under /hi), the worker panel's from its login,
 * else the customer panel's choice. A move between panels in the browser keeps the first page's
 * toast labels; the worker panel sets <html lang> itself (P11-15).
 */
async function getPageLang(): Promise<Lang> {
  const request = await headers();
  if (request.get(SITE_LANG_HEADER) === 'hi') return 'hi';
  if (request.get(STAFF_PANEL_HEADER) === '1')
    return (await getCurrentMembership())?.uiLang ?? 'en';
  // The customer panel's cookie is only sent to /t pages.
  return getLang();
}

export default async function RootLayout({ children }: LayoutProps<'/'>) {
  const [lang, theme] = await Promise.all([getPageLang(), getTheme()]);
  const { toasts } = STRINGS[lang];
  return (
    // data-scroll-behavior: page changes jump to the top even where the website
    // scrolls smoothly to its sections (Next 16 no longer forces this).
    <html
      lang={lang}
      data-theme={theme}
      data-scroll-behavior="smooth"
      className={`${notoSans.variable} h-full`}
    >
      <body className="flex min-h-full flex-col">
        {/* On every page, so the installed app shows it wherever it opens (P11-4). */}
        <AppSplash />
        <ThemeProvider theme={theme}>{children}</ThemeProvider>
        <Toaster
          position="top-center"
          theme={theme}
          richColors={false}
          closeButton
          containerAriaLabel={toasts.region}
          toastOptions={{ closeButtonAriaLabel: toasts.close }}
        />
        {/* Last: on every page, and after the Toaster and the worker panel's <html lang>. */}
        <NewVersionNotice />
      </body>
    </html>
  );
}
