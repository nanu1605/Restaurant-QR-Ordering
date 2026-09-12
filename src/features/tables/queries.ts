import 'server-only';

import { createClient } from '@/lib/supabase/server';

export type AdminTable = {
  id: string;
  label: string;
  qrToken: string;
  isActive: boolean;
  sortOrder: number;
  /** A session is open on the table right now. */
  occupied: boolean;
};

/** Every table of the signed-in member's restaurant (RLS-scoped), in display order. */
export async function getAdminTables(): Promise<AdminTable[]> {
  const supabase = await createClient();
  const [tables, sessions] = await Promise.all([
    supabase
      .from('dining_tables')
      .select('id, label, qr_token, is_active, sort_order')
      .order('sort_order')
      .order('created_at'),
    supabase.from('table_sessions').select('dining_table_id').eq('status', 'open'),
  ]);
  if (tables.error) throw new Error(`Could not load tables: ${tables.error.message}`);
  if (sessions.error) throw new Error(`Could not load open tables: ${sessions.error.message}`);

  const occupied = new Set(sessions.data.map((session) => session.dining_table_id));
  return tables.data.map((table) => ({
    id: table.id,
    label: table.label,
    qrToken: table.qr_token,
    isActive: table.is_active,
    sortOrder: table.sort_order,
    occupied: occupied.has(table.id),
  }));
}
