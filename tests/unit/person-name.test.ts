import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import type { z } from 'zod';

import { newLeadSchema } from '@/features/growth/leads';
import { onboardOwnerSchema } from '@/features/platform/schemas';
import { inviteSchema } from '@/features/platform/team';
import { SITE_SCHEMAS } from '@/features/site/schemas';
import { displayNameSchema } from '@/features/staff/schemas';
import { staffNameSchema } from '@/features/support/support-access';
import { waiterFormSchema } from '@/features/waiters/schemas';
import { hasNoHiddenCharacters } from '@/lib/person-name';

/** The database's character class (hex escapes, alone or as ranges) as code point ranges. */
function sqlRanges(sqlClass: string): [number, number][] {
  const ranges: [number, number][] = [];
  let from: number | undefined;
  // Each escape is a backslash, u or U, then 4 or 8 hex digits; a "-" after one opens a range.
  for (const escape of sqlClass.split(String.fromCharCode(92)).slice(1)) {
    const code = Number.parseInt(escape.slice(1), 16);
    if (from !== undefined) {
      ranges.push([from, code]);
      from = undefined;
    } else if (escape.endsWith('-')) from = code;
    else ranges.push([code, code]);
  }
  return ranges;
}

describe('a person’s name', () => {
  it('keeps ordinary spaces, accents, punctuation, emoji and every script', () => {
    for (const name of [
      'Tara Singh',
      'Ōwner Nāme',
      "Seán O'Brien-Lee",
      // Devanagari's and Tamil's vowel signs and virama are marks (Mn, Mc), not format characters.
      'आशा वर्मा',
      'அனிதா',
      '李小龍',
      // A no-break space is a space (Zs), as is the ordinary one.
      'Tara\u00A0Singh',
      'Tara 🌸',
    ]) {
      expect(hasNoHiddenCharacters(name), name).toBe(true);
    }
  });

  it('refuses control and format characters and the line and paragraph separators', () => {
    const refused: [string, string][] = [
      ['Tara \u202Enimda', 'a right-to-left override (Cf)'],
      ['Tara \u2066nimda\u2069', 'a bidi isolate (Cf)'],
      ['Tara\u200E', 'a left-to-right mark (Cf)'],
      ['Ta\u200Bra', 'a zero-width space (Cf)'],
      ['Ta\u00ADra', 'a soft hyphen (Cf)'],
      ['Ta\uFEFFra', 'a byte order mark inside the name (Cf)'],
      ['Tara 👩\u200D🍳', 'a joiner, here in a joined emoji (Cf)'],
      ['Ta\u{E0041}ra', 'a tag character, past the BMP (Cf)'],
      ['Tara\u2028Singh', 'a line separator (Zl)'],
      ['Tara\u2029Singh', 'a paragraph separator (Zp)'],
      ['Tara\tSingh', 'a tab (Cc)'],
      ['Tara\nSingh', 'a line feed (Cc)'],
      ['Tara\u001b[31m', 'an escape (Cc)'],
      ['Tara\u0000', 'a NUL (Cc)'],
      ['Tara\u0085', 'a C1 next line (Cc)'],
    ];
    for (const [name, what] of refused) expect(hasNoHiddenCharacters(name), what).toBe(false);
  });

  it('is refused on every form that takes one, in that form’s words', () => {
    const theName = 'Remove the hidden characters from the name.';
    const yourName = 'Remove the hidden characters from your name.';
    const forms: [string, z.ZodType, string][] = [
      ['the Team page', inviteSchema.shape.displayName, theName],
      ['the signup', SITE_SCHEMAS.en.signup.shape.ownerName, yourName],
      [
        'the Hindi signup',
        SITE_SCHEMAS.hi.signup.shape.ownerName,
        'अपने नाम से छिपे हुए अक्षर हटाएँ।',
      ],
      ['the "Book a demo" form', SITE_SCHEMAS.en.lead.shape.name, yourName],
      ['onboarding', onboardOwnerSchema.shape.ownerName, theName],
      ['a staff login', displayNameSchema, theName],
      ['a waiter', waiterFormSchema.shape.fullName, theName],
      ['a support session', staffNameSchema, yourName],
      ['a lead added by hand', newLeadSchema.shape.name, theName],
    ];
    for (const [form, schema, message] of forms) {
      expect(schema.safeParse(' Tara Singh ').data, form).toBe('Tara Singh');
      for (const name of ['Tara \u202Enimda', 'Tara\u2028Singh']) {
        expect(
          schema.safeParse(name).error?.issues.map((issue) => issue.message),
          `${form}: ${JSON.stringify(name)}`,
        ).toEqual([message]);
      }
    }
  });

  it('is the database’s rule too, at every code point', () => {
    // The latest migration that defines private.has_no_hidden_characters.
    const folder = join('supabase', 'migrations');
    const sql = readdirSync(folder)
      .filter((name) => name.endsWith('.sql'))
      .sort()
      .map((name) => readFileSync(join(folder, name), 'utf8'))
      .filter((text) => text.includes('function private.has_no_hidden_characters('))
      .at(-1);
    const sqlClass = /p_text !~ '\[([^\]']+)\]'/.exec(sql ?? '')?.[1];
    expect(sqlClass, 'no migration defines private.has_no_hidden_characters').toBeDefined();
    const ranges = sqlRanges(sqlClass!);
    const differ: string[] = [];
    // U+0000 is left out of the database's list: text cannot hold it.
    for (let code = 1; code <= 0x10ffff; code++) {
      const refused = ranges.some(([from, to]) => code >= from && code <= to);
      if (refused === hasNoHiddenCharacters(String.fromCodePoint(code))) {
        differ.push(`U+${code.toString(16).toUpperCase()}`);
      }
    }
    // Newer Unicode data in Node shows here first: the database's list is then defined again.
    expect(differ).toEqual([]);
  });
});
