import type { Metadata, ResolvingMetadata } from 'next';

import { SiteChrome } from '@/features/site/components/site-chrome';
import { APP_NAME } from '@/lib/config';

/** The English link preview (../opengraph-image.tsx) in a Hindi page's preview. */
export async function generateMetadata(
  _props: LayoutProps<'/hi'>,
  parent: ResolvingMetadata,
): Promise<Metadata> {
  // A layout's openGraph replaces its parent's, the preview image too.
  const { images } = (await parent).openGraph ?? {};
  return { openGraph: { type: 'website', siteName: APP_NAME, locale: 'hi_IN', url: './', images } };
}

/** The website in Hindi under /hi. The policies stay English only; links to them say so. */
export default function HindiLayout({ children }: LayoutProps<'/hi'>) {
  return <SiteChrome lang="hi">{children}</SiteChrome>;
}
