import 'server-only';

import { createClient } from '@/lib/supabase/server';

export type WaiterOverview = {
  id: string;
  fullName: string;
  phone: string | null;
  employeeCode: string | null;
  joinedOn: string | null;
  notes: string | null;
  onDuty: boolean;
  memberId: string | null;
  memberUsername: string | null;
  memberActive: boolean | null;
  /** Labels of tables the waiter is serving right now. */
  openTables: string[];
  /** Tables attended during the current business day. */
  tablesToday: number;
};

/** Active waiter profiles with their live status (managers and owners only). */
export async function getWaitersOverview(): Promise<WaiterOverview[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('admin_waiters_overview');
  if (error) throw new Error(`Could not load waiters: ${error.message}`);
  return data.map((row) => ({
    id: row.waiter_id,
    fullName: row.full_name,
    phone: row.phone,
    employeeCode: row.employee_code,
    joinedOn: row.joined_on,
    notes: row.notes,
    onDuty: row.on_duty,
    memberId: row.member_id,
    memberUsername: row.member_username,
    memberActive: row.member_active,
    openTables: row.open_tables ?? [],
    tablesToday: row.tables_today,
  }));
}
