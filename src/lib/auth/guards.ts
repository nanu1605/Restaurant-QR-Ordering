import 'server-only';

import { redirect } from 'next/navigation';

import { homePathFor } from './redirects';
import type { MemberRole } from './roles';
import {
  getCurrentMembership,
  getCurrentUser,
  getIsPlatformAdmin,
  type CurrentMembership,
  type CurrentUser,
} from './session';

/**
 * Server-side role guards. Call them in every page and server action that
 * needs them — layouts alone are not enough, because they don't re-run on
 * client navigation and don't stop nested segments from rendering. Results
 * are cached per request, so repeated calls are cheap.
 *
 * A user who opens a panel their role can't use is sent to their own panel.
 */

export async function requireUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  return user;
}

export async function requireMember(roles?: readonly MemberRole[]): Promise<CurrentMembership> {
  await requireUser();
  const membership = await getCurrentMembership();

  if (!membership) {
    if (await getIsPlatformAdmin()) redirect('/super');
    redirect('/login?error=no_access');
  }

  if (roles && !roles.includes(membership.role)) {
    redirect(homePathFor({ isPlatformAdmin: false, role: membership.role }) ?? '/login');
  }

  return membership;
}

export async function requirePlatformAdmin(): Promise<CurrentUser> {
  const user = await requireUser();

  if (!(await getIsPlatformAdmin())) {
    const membership = await getCurrentMembership();
    redirect(
      homePathFor({ isPlatformAdmin: false, role: membership?.role ?? null }) ??
        '/login?error=no_access',
    );
  }

  return user;
}
