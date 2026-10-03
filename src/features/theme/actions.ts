'use server';

import { cookies } from 'next/headers';

import { deviceCookieOptions } from '@/features/ordering/device-token';
import { getPublicEnv } from '@/lib/env';

import { parseTheme, THEME_COOKIE } from './theme';

/** Remembers the theme on this device for every page; "system" forgets it. */
export async function setTheme(formData: FormData): Promise<void> {
  const theme = parseTheme(formData.get('theme'));
  const jar = await cookies();
  if (theme === 'system') jar.delete(THEME_COOKIE);
  else jar.set(THEME_COOKIE, theme, deviceCookieOptions(getPublicEnv().NEXT_PUBLIC_APP_URL, '/'));
}
