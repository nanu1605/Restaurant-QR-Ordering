/**
 * A person's name as the app takes it (the Team page, signup, the "Book a demo" form, onboarding,
 * staff logins, waiters, support sessions and leads added by hand) goes on admin screens, bills and
 * emails, so it may not hold a character that hides or reorders the text around it: a control
 * character (Unicode Cc), a format character (Cf) such as the right-to-left override or the
 * zero-width space, or a line or paragraph separator (Zl, Zp). Ordinary spaces stay. A joiner is a
 * format character too, so a name written with one, such as a joined emoji, is refused as well.
 *
 * deploy/vps/tools/first-admin.mjs and its values maker, first-admin-values.mjs beside it, keep
 * their own copies of the rule, as they run without the app; tests/unit/vps-first-admin.test.ts
 * holds the three to the same characters.
 */
const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/** Whether a name holds none of those characters. */
export function hasNoHiddenCharacters(name: string): boolean {
  return !HIDDEN.test(name);
}
