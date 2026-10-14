/**
 * Staff sign in with restaurant code + username (spec §9.5). Each staff login
 * is still a Supabase Auth user, so staff without an email get a synthetic,
 * non-deliverable address: <username>@<slug>.staff.<domain>.
 *
 * Pure (no server-only imports) so the create-restaurant script can use it.
 */

export const USERNAME_PATTERN = /^[a-z0-9_]{3,30}$/;
export const RESTAURANT_CODE_PATTERN = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;

export function normalizeLoginName(value: string): string {
  return value.trim().toLowerCase();
}

/** Whether an address is one of these made-up logins, not one that receives email. */
export function isStaffEmail(email: string, domain: string): boolean {
  return normalizeLoginName(email).endsWith(`.staff.${normalizeLoginName(domain)}`);
}

export function staffEmail(username: string, restaurantSlug: string, domain: string): string {
  const user = normalizeLoginName(username);
  const slug = normalizeLoginName(restaurantSlug);
  if (!USERNAME_PATTERN.test(user)) {
    throw new Error(`Invalid username "${username}": use 3–30 lowercase letters, digits or _`);
  }
  if (!RESTAURANT_CODE_PATTERN.test(slug)) {
    throw new Error(`Invalid restaurant code "${restaurantSlug}"`);
  }
  return `${user}@${slug}.staff.${normalizeLoginName(domain)}`;
}
