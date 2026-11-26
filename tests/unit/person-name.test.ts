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
});
