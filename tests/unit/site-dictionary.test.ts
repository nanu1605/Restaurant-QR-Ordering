import { describe, expect, it } from 'vitest';

import { SITE } from '@/features/site/content';

// The Hindi website dictionary (content-hi.ts) against the English one: the same shape, the same
// {slots}, and the same links, ids and plan marks (docs/DECISIONS.md W-15).

type Leaf = { path: string; key: string; value: unknown };

/** Every value with its path ("nav[0].href") and its own key; list items keep the list's key. */
function leaves(value: unknown, path = '', key = ''): Leaf[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => leaves(item, `${path}[${index}]`, key));
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([name, item]) =>
      leaves(item, path ? `${path}.${name}` : name, name),
    );
  }
  return [{ path, key, value }];
}

/** Data on list items (links, sections, plan marks); contact.form.plan is a label. */
const isData = ({ path, key }: Leaf) => ['href', 'id', 'plan'].includes(key) && path.includes('[');

const slots = (text: string) => [...new Set(text.match(/\{\w+\}/g))].sort();

/** Brand names that read the same in Hindi. */
const BRAND_ONLY = new Set(['WhatsApp']);

const en = leaves(SITE.en);
const hi = leaves(SITE.hi);

describe('the Hindi website dictionary', () => {
  it('has every English key and list item, in the same places', () => {
    expect(hi.map((leaf) => leaf.path)).toEqual(en.map((leaf) => leaf.path));
    for (const leaf of [...en, ...hi]) expect(typeof leaf.value, leaf.path).toBe('string');
  });

  it('keeps every {slot}, link, id and plan mark', () => {
    hi.forEach((leaf, index) => {
      const english = en[index]!;
      if (isData(leaf)) expect(leaf.value, leaf.path).toBe(english.value);
      else expect(slots(leaf.value as string), leaf.path).toEqual(slots(english.value as string));
    });
  });

  it('types no ₹ (prices go through <Money>) and no transliteration marks', () => {
    for (const leaf of [...en, ...hi]) {
      expect(leaf.value, leaf.path).not.toMatch(/[₹\u0100-\u02BA]/);
    }
  });

  it('is written in Devanagari, spelt as the menu spells it', () => {
    for (const leaf of hi.filter((item) => !isData(item))) {
      const text = leaf.value as string;
      if (!BRAND_ONLY.has(text)) expect(text, leaf.path).toMatch(/[\u0900-\u097F]/);
      expect(text, leaf.path).not.toMatch(/हिंदी/);
      // A nukta is its own mark after the letter (फ़ = फ + ़), as in STRINGS.hi, so text matches.
      expect(text, leaf.path).not.toMatch(/[\u0958-\u095F]/);
    }
  });
});
