import 'server-only';

import type { SeriesBy } from '@/features/usage/usage';
import { createClient } from '@/lib/supabase/server';

import { parseMovementList, parseRevenueReport, type Movement } from './revenue';

/** Revenue over India dates, with the days just before when comparing. */
export async function getRevenueReport(from: string, to: string, by: SeriesBy, compare: boolean) {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('platform_revenue_report', {
    p_from: from,
    p_to: to,
    p_by: by,
    p_compare: compare,
  });
  if (error) throw new Error(`Could not load revenue: ${error.message}`);
  return parseRevenueReport(data);
}

/** The restaurants behind one movement over these dates. */
export async function getRevenueMovements(from: string, to: string, kind: Movement) {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('platform_revenue_movements', {
    p_from: from,
    p_to: to,
    p_kind: kind,
  });
  if (error) throw new Error(`Could not load the movement: ${error.message}`);
  return parseMovementList(data);
}
