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
