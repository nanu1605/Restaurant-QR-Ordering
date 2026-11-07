import { Noto_Sans } from 'next/font/google';

/**
 * The app's font, defined once so every document that uses it shares one
 * instance (next/font: a font definitions file).
 */
export const notoSans = Noto_Sans({
  variable: '--font-noto-sans',
  subsets: ['latin'],
  display: 'swap',
});
