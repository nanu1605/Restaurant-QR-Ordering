import 'server-only';

import { createClient } from '@/lib/supabase/server';

import { parseUsageReport } from './usage';

/** Usage over business dates, with the days just before when comparing (SA-62). */
export async function getUsageReport(from: string, to: string, compare: boolean) {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('platform_usage_report', {
    p_from: from,
    p_to: to,
    p_compare: compare,
  });
  if (error) throw new Error(`Could not load usage: ${error.message}`);
  return parseUsageReport(data);
}
