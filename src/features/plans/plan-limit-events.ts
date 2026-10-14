import 'server-only';

import { dbErrorCode, type DbErrorLike } from '@/lib/db-errors';
import { createClient } from '@/lib/supabase/server';

const PLAN_REFUSALS = new Set(['PLAN_LIMIT_TABLES', 'PLAN_LIMIT_STAFF', 'FEATURE_NOT_IN_PLAN']);

/**
 * Records a refusal because of the restaurant's plan, so super-admin can see
 * who might upgrade (docs/DECISIONS.md SA-13). The refusing function rolls
 * back, so the action records it afterwards. Never fails the action.
 */
export async function notePlanLimit(error: DbErrorLike): Promise<void> {
  const code = dbErrorCode(error);
  if (!code || !PLAN_REFUSALS.has(code)) return;
  const supabase = await createClient();
  const { error: recordError } = await supabase.rpc('member_record_plan_limit', {
    p_code: code,
    p_detail: error.details?.trim() || undefined,
  });
  if (recordError) console.error('[plan limits] not recorded:', recordError.message);
}
