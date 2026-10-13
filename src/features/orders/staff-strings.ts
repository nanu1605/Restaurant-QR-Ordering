import 'server-only';

import { getCurrentMembership } from '@/lib/auth/session';

import { STAFF_STRINGS, type StaffStrings } from './strings';

/** The worker panel's words for the signed-in login, on the server (P11-15). */
export async function staffStrings(): Promise<StaffStrings> {
  const membership = await getCurrentMembership();
  return STAFF_STRINGS[membership?.uiLang ?? 'en'];
}
