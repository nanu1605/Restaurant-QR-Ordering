import Link from 'next/link';

/**
 * A website link. Section links ("/#faq") are plain anchors, so the browser
 * also moves keyboard focus to the section; pages use next/link.
 */
export function SiteLink({ href, ...props }: React.ComponentProps<'a'> & { href: string }) {
  return href.includes('#') ? <a href={href} {...props} /> : <Link href={href} {...props} />;
}
