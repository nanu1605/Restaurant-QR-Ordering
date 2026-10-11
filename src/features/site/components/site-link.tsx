import Link from 'next/link';

import type { SiteLang } from '../content';
import { siteLangOf, sitePath } from '../i18n';

/**
 * A website link in the page's language (sitePath). A page in the other language (from Hindi
 * also /login and the policies) is a full page load, so <html lang> follows it. Section links
 * ("/#faq") are plain anchors, so the browser also moves keyboard focus to the section; pages
 * use next/link.
 */
export function SiteLink({
  siteLang,
  href,
  ...props
}: React.ComponentProps<'a'> & { siteLang: SiteLang; href: string }) {
  const target = sitePath(siteLang, href);
  const targetLang = siteLangOf(target);
  if (targetLang !== siteLang) return <a href={target} hrefLang={targetLang} {...props} />;
  return target.includes('#') ? <a href={target} {...props} /> : <Link href={target} {...props} />;
}
