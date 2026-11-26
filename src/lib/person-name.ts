/**
 * A person's name as the app takes it (the Team page, signup, the "Book a demo" form, onboarding,
 * staff logins, waiters, support sessions and leads added by hand) goes on admin screens, bills and
 * emails, so it may not hold a character that hides or reorders the text around it: a control
 * character (Unicode Cc), a format character (Cf) such as the right-to-left override or the
 * zero-width space, or a line or paragraph separator (Zl, Zp). Ordinary spaces stay. A joiner is a
 * format character too, so a name written with one, such as a joined emoji, is refused as well.
 *
 * Three copies run without the app, each held to this one at every code point: the first-admin
 * tool's and its values maker's (deploy/vps/tools/first-admin.mjs and first-admin-values.mjs
 * beside it, by tests/unit/vps-first-admin.test.ts) and the database's,
 * private.has_no_hidden_characters, which every name column checks
 * (supabase/migrations/20261121100000_person_names.sql, by tests/unit/person-name.test.ts).
 */
const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/** Whether a name holds none of those characters. */
export function hasNoHiddenCharacters(name: string): boolean {
  return !HIDDEN.test(name);
}
