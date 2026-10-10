import { Fragment, type ReactNode } from 'react';

import type { SiteLang } from './content';

/**
 * The website's language helpers. Safe on the client: they never import a
 * dictionary (content.ts), so client components carry only the words passed
 * to them.
 */

/** Every website language; the compiler keeps it in step with SITE. */
const SITE_LANGS: Record<SiteLang, true> = { en: true };

/** A language from a form field or header; English for anything else. */
export function parseSiteLang(value: unknown): SiteLang {
  return typeof value === 'string' && Object.hasOwn(SITE_LANGS, value) ? (value as SiteLang) : 'en';
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
