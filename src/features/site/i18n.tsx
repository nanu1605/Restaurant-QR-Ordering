import type { Metadata } from 'next';
import { Fragment, type ReactNode } from 'react';

import type { SiteLang } from './content';

/**
 * The website's language helpers. Safe on the client: they never import a
 * dictionary (content.ts), so client components carry only the words passed
 * to them.
 */

/** Every website language; the compiler keeps it in step with SITE. */
const SITE_LANGS: Record<SiteLang, true> = { en: true, hi: true };

/** A language from a form field or header; English for anything else. */
export function parseSiteLang(value: unknown): SiteLang {
  return typeof value === 'string' && Object.hasOwn(SITE_LANGS, value) ? (value as SiteLang) : 'en';
}

/** The request header with the address's website language, set by the proxy (src/proxy.ts). */
export const SITE_LANG_HEADER = 'x-site-lang';

/** Hindi under /hi, English everywhere else. */
export function siteLangOf(pathname: string): SiteLang {
  return /^\/hi(?=$|[/?#])/.test(pathname) ? 'hi' : 'en';
}

/** The English pages with a Hindi twin under /hi. The legal pages stay English only. */
export const HINDI_PAGES = [
  '/',
  '/features',
  '/pricing',
  '/demo',
  '/contact',
  '/signup',
  '/signup/verify',
];

/**
 * A website link in `lang`, keeping its ?query and #hash: '/pricing?plan=x' → '/hi/pricing?plan=x',
 * '/#how' → '/hi#how'. Pages without a Hindi twin (/login, the legal pages) stay as they are.
 */
export function sitePath(lang: SiteLang, href: string): string {
  const path = href.split(/[?#]/, 1)[0]!;
  if (lang === 'en' || !HINDI_PAGES.includes(path)) return href;
  return `${path === '/' ? '/hi' : `/hi${path}`}${href.slice(path.length)}`;
}

/** The language switch's target: the page's twin, or the Hindi home page for an English-only page. */
export function otherLanguageHref(pathname: string): string {
  if (siteLangOf(pathname) === 'hi') return pathname.slice('/hi'.length) || '/';
  return HINDI_PAGES.includes(pathname) ? sitePath('hi', pathname) : '/hi';
}

/**
 * A page's title and description, its own address as canonical (without ?plan or ?cycle), and
 * its twin in the other language for search engines. `path` is the English page.
 */
export function pageMetadata(
  lang: SiteLang,
  path: string,
  meta: Pick<Metadata, 'title' | 'description'>,
): Metadata {
  return {
    ...meta,
    alternates: {
      canonical: sitePath(lang, path),
      languages: { 'en-IN': path, 'hi-IN': sitePath('hi', path), 'x-default': path },
    },
  };
}

/** "Up to {n} tables" with { n: 8 } → "Up to 8 tables". A slot without a value stays as it is. */
export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (slot, name: string) =>
    Object.hasOwn(values, name) ? String(values[name]) : slot,
  );
}

/** fill() with elements in the slots (a price, a link, <strong>), wherever each language puts them. */
export function fillNodes(template: string, values: Record<string, ReactNode>): ReactNode {
  return template
    .split(/\{(\w+)\}/)
    .map((part, index) =>
      index % 2 === 0 ? (
        part
      ) : (
        <Fragment key={index}>{Object.hasOwn(values, part) ? values[part] : `{${part}}`}</Fragment>
      ),
    );
}

/** One of `{ one, other }` by count, with {n} filled: "1 month", "2 months". */
export function plural(count: number, forms: { one: string; other: string }): string {
  return fill(count === 1 ? forms.one : forms.other, { n: count });
}
