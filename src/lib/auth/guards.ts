import 'server-only';

import { redirect } from 'next/navigation';

import { homePathFor } from './redirects';
import type { MemberRole } from './roles';
import {
  getCurrentMembership,
  getCurrentUser,
  getIsPlatformAdmin,
  getPlatformAdminStatus,
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

/**
 * A platform admin who has passed the second factor. Without it, the admin is
 * sent to /super/mfa to enrol or enter a code (docs/DECISIONS.md P7-1).
 */
export async function requirePlatformAdmin(): Promise<CurrentUser> {
  const user = await requirePlatformAdminLogin();
  if ((await getPlatformAdminStatus()) !== 'ok') redirect('/super/mfa');
  return user;
}

/** The super-admin permissions (docs/SUPER_ADMIN_PLAN.md §3), checked again in SQL. */
export type PlatformPermission =
  | 'restaurants.view'
  | 'restaurants.manage'
  | 'restaurants.support'
  | 'restaurants.close'
  | 'money.view'
  | 'money.record'
  | 'growth.manage'
  | 'insights.view'
  | 'settings.manage'
  | 'team.manage'
  | 'system.view'
  | 'audit.view';

/** A platform admin allowed to do `permission` (docs/DECISIONS.md SA-2). */
export async function requirePlatformPermission(
  permission: PlatformPermission,
): Promise<CurrentUser> {
  // ponytail: every platform admin holds every permission until team roles (13g) check it.
  void permission;
  return requirePlatformAdmin();
}

/**
 * Whether the platform admin holds a permission, for what only some see (money
 * on the restaurants list); the page itself is guarded by requirePlatformPermission.
 */
export async function hasPlatformPermission(permission: PlatformPermission): Promise<boolean> {
  // ponytail: every platform admin holds every permission until team roles (13g) check it.
  void permission;
  await requirePlatformAdmin();
  return true;
}

/** A platform admin, second factor or not: only for the /super/mfa page. */
export async function requirePlatformAdminLogin(): Promise<CurrentUser> {
  const user = await requireUser();

  if ((await getPlatformAdminStatus()) === 'none') {
    const membership = await getCurrentMembership();
    redirect(
      homePathFor({ isPlatformAdmin: false, role: membership?.role ?? null }) ??
        '/login?error=no_access',
    );
  }

  return user;
}
