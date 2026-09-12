import 'server-only';

import type { MemberRole } from '@/lib/auth/roles';
import { createClient } from '@/lib/supabase/server';

export type StaffMember = {
  memberId: string;
  displayName: string;
  username: string;
  role: MemberRole;
  isActive: boolean;
  lastSignInAt: string | null;
  createdAt: string;
  /** The waiter profile this login is linked to, if any. */
  waiterId: string | null;
  waiterName: string | null;
};

/** Every login of the caller's restaurant (managers and owners only). */
export async function getStaff(): Promise<StaffMember[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('admin_list_staff');
  if (error) throw new Error(`Could not load staff logins: ${error.message}`);
  return data.map((row) => ({
    memberId: row.member_id,
    displayName: row.display_name,
    username: row.username,
    role: row.role,
    isActive: row.is_active,
    lastSignInAt: row.last_sign_in_at,
    createdAt: row.created_at,
    waiterId: row.waiter_id,
    waiterName: row.waiter_name,
  }));
}
