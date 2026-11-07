import 'server-only';

import { createClient } from '@/lib/supabase/server';

import { parseSystem } from './system';

/** Everything on /super/system that the database knows (system.view). */
export async function getSystem() {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('platform_system');
  if (error) throw new Error(`Could not load system health: ${error.message}`);
  return parseSystem(data);
}
