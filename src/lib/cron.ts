import 'server-only';

import { createHash, timingSafeEqual } from 'node:crypto';

import { getServerEnv } from '@/lib/env.server';
import type { createAdminClient } from '@/lib/supabase/admin';

/** The scheduled jobs' shared parts (docs/DECISIONS.md SA-11, SA-31). */

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/** `Authorization: Bearer <CRON_SECRET>`; nobody gets in while the secret is unset. */
export function cronAuthorised(request: Request): boolean {
  const secret = getServerEnv().CRON_SECRET;
  if (!secret) return false;
  const header = request.headers.get('authorization') ?? '';
  return timingSafeEqual(digest(header), digest(`Bearer ${secret}`));
}

type Admin = ReturnType<typeof createAdminClient>;

/**
 * Runs one step of a job and records it in cron_runs; a failure is logged and
 * doesn't stop the others. Null when it failed.
 */
export async function cronStep<T>(
  admin: Admin,
  job: string,
  name: string,
  run: () => Promise<T>,
): Promise<T | null> {
  const startedAt = new Date().toISOString();
  let result: T | null = null;
  let detail: string;
  try {
    result = await run();
    detail = JSON.stringify(result ?? null);
  } catch (error) {
    console.error(`[cron/${job}] ${name} failed`, error);
    detail = error instanceof Error ? error.message : String(error);
  }
  const logged = await admin.from('cron_runs').insert({
    job,
    step: name,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    ok: result !== null,
    detail: detail.slice(0, 2000),
  });
  if (logged.error) console.error(`[cron/${job}] could not log ${name}`, logged.error.message);
  return result;
}
