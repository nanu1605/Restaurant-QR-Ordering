import type { Metadata, Viewport } from 'next';
import { Noto_Sans } from 'next/font/google';
import { cookies } from 'next/headers';

import { Toaster } from '@/components/ui/sonner';
import { getLang } from '@/features/ordering/lang';
import { STRINGS } from '@/features/ordering/strings';
import { parseTheme, THEME_COOKIE } from '@/features/theme/theme';
import { APP_NAME, THEME_COLOR, THEME_COLOR_DARK } from '@/lib/config';

import './globals.css';

const notoSans = Noto_Sans({
  variable: '--font-noto-sans',
  subsets: ['latin'],
  display: 'swap',
});

export const metadata: Metadata = {
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

export default async function RootLayout({ children }: LayoutProps<'/'>) {
  // The customer panel may be in Hindi; its cookie is only sent to /t pages.
  const [lang, theme] = await Promise.all([getLang(), getTheme()]);
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
        {children}
        <Toaster
          position="top-center"
          theme={theme}
          richColors={false}
          closeButton
          containerAriaLabel={toasts.region}
          toastOptions={{ closeButtonAriaLabel: toasts.close }}
        />
      </body>
    </html>
  );
}
