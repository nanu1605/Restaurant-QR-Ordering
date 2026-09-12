import type { Enums } from '@/types/database';

export type MemberRole = Enums<'member_role'>;

/** Worker panel: every role (owners and managers can use it too, spec §3). */
export const STAFF_PANEL_ROLES = [
  'owner',
  'manager',
  'waiter',
  'kitchen',
] as const satisfies readonly MemberRole[];

/** Admin panel: owners and managers. */
export const ADMIN_PANEL_ROLES = ['owner', 'manager'] as const satisfies readonly MemberRole[];

export const ROLE_LABELS: Record<MemberRole, string> = {
  owner: 'Owner',
  manager: 'Manager',
  waiter: 'Waiter',
  kitchen: 'Kitchen',
};

/** Roles a staff login can be given; the owner comes from onboarding only. */
export const STAFF_LOGIN_ROLES = [
  'manager',
  'waiter',
  'kitchen',
] as const satisfies readonly MemberRole[];
export type StaffLoginRole = (typeof STAFF_LOGIN_ROLES)[number];

/**
 * Role hierarchy (spec §3, §13.3): the owner manages managers, waiters and
 * kitchen staff; a manager manages waiters and kitchen staff. The database
 * applies the same rule (private.can_manage_role).
 */
export function canManageRole(actor: MemberRole, target: MemberRole): boolean {
  if (actor === 'owner') return target !== 'owner';
  if (actor === 'manager') return target === 'waiter' || target === 'kitchen';
  return false;
}

/** Roles the actor may give to a login. */
export function assignableRoles(actor: MemberRole): StaffLoginRole[] {
  return STAFF_LOGIN_ROLES.filter((role) => canManageRole(actor, role));
}
