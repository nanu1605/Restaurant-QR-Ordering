import 'server-only';

import { after } from 'next/server';

import { runExclusive, type JobRun } from '@/lib/jobs';
import { createAdminClient } from '@/lib/supabase/admin';

import { parseExportClaim } from './closure';
import { buildExport, EXPORT_LEASE_SECONDS, type ExportOutcome } from './export';

type Admin = ReturnType<typeof createAdminClient>;

/**
 * How long a run of the export queue keeps starting builds (docs/DECISIONS.md VPS-25, VPS-26).
 * One started then finishes, so a run ends inside the 300 s that the pages asking for exports
 * allow on Vercel.
 */
export const EXPORT_RUN_MS = 180_000;

/**
 * Builds queued exports, oldest first, one at a time, until none waits, another server holds the
 * platform's one build, or the run stops. Each claim also queues again an export whose build was
 * cut off. Says how many builds ended each way; throws when the claim does.
 */
export async function runExportJobs(admin: Admin, run: JobRun) {
  const ended: Record<ExportOutcome, number> = { ready: 0, failed: 0, released: 0, lost: 0 };
  while (!run.stopping()) {
    const { data, error } = await admin.rpc('restaurant_export_claim', {
      p_lease_seconds: EXPORT_LEASE_SECONDS,
    });
    if (error) throw new Error(`Could not claim an export: ${error.message}`);
    const claim = parseExportClaim(data);
    if (!claim) break;
    const outcome = await buildExport(admin, claim, run);
    ended[outcome] += 1;
    // The server is stopping: the export went back to the queue for the next one.
    if (outcome === 'released') break;
  }
  return ended;
}

/**
 * Runs the export queue once the action has answered: the export just asked for, and any other
 * waiting (docs/DECISIONS.md VPS-26). One run at a time in this process, and a request while one
 * runs makes it go once more. What a run leaves waits for the next run, which the minute job
 * starts too.
 */
export function startExportJobs(): void {
  after(() =>
    runExclusive('data_exports', EXPORT_RUN_MS, (run) =>
      runExportJobs(createAdminClient(), run),
    ).catch((error: unknown) => console.error('[closure] export run failed', error)),
  );
}
