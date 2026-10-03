import type { Metadata, Viewport } from 'next';
import { Noto_Sans } from 'next/font/google';

import { Toaster } from '@/components/ui/sonner';
import { getLang } from '@/features/ordering/lang';
import { STRINGS } from '@/features/ordering/strings';
import { APP_NAME, THEME_COLOR } from '@/lib/config';

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

export const viewport: Viewport = {
  themeColor: THEME_COLOR,
};

export default async function RootLayout({ children }: LayoutProps<'/'>) {
  // The customer panel may be in Hindi; its cookie is only sent to /t pages.
  const lang = await getLang();
  const { toasts } = STRINGS[lang];
  return (
    // data-scroll-behavior: page changes jump to the top even where the website
    // scrolls smoothly to its sections (Next 16 no longer forces this).
    <html lang={lang} data-scroll-behavior="smooth" className={`${notoSans.variable} h-full`}>
      <body className="flex min-h-full flex-col">
        {children}
        <Toaster
          position="top-center"
          richColors={false}
          closeButton
          containerAriaLabel={toasts.region}
          toastOptions={{ closeButtonAriaLabel: toasts.close }}
        />
      </body>
    </html>
  );
}
