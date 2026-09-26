import 'server-only';

import { cookies } from 'next/headers';

import { LANG_COOKIE, type Lang, STRINGS, type Strings } from './strings';

/** The language this phone chose for the customer panel (English by default). */
export async function getLang(): Promise<Lang> {
  return (await cookies()).get(LANG_COOKIE)?.value === 'hi' ? 'hi' : 'en';
}

export async function getStrings(): Promise<Strings> {
  return STRINGS[await getLang()];
}
