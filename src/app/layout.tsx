import type { Metadata, Viewport } from 'next';
import { Noto_Sans } from 'next/font/google';

import { Toaster } from '@/components/ui/sonner';
import { APP_NAME } from '@/lib/config';

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
  themeColor: '#3B4BA8',
};

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" className={`${notoSans.variable} h-full`}>
      <body className="flex min-h-full flex-col">
        {children}
        <Toaster position="top-center" richColors={false} closeButton />
      </body>
    </html>
  );
}
