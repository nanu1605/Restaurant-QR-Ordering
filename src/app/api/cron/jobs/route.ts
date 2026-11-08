import { after, NextResponse } from 'next/server';

import { EMAIL_RUN_MS, sendAnnouncementEmails } from '@/features/announcements/email';
import { EXPORT_RUN_MS, runExportJobs } from '@/features/closure/export-jobs';
import { fillWaitingHindiNames, HINDI_RUN_MS } from '@/features/menu/hindi-names';
import { menuImportProviders } from '@/features/menu-import/providers';
import { cronAuthorised } from '@/lib/cron';
import { emailConfig } from '@/lib/email/resend';
import { getPublicEnv } from '@/lib/env';
import { JOB_KINDS, jobsWaitingSchema, runExclusive, type JobKind } from '@/lib/jobs';
import { createAdminClient } from '@/lib/supabase/admin';

const noStore = { 'Cache-Control': 'no-store' };

// The runs go on after the answer, each starting no work after its budget (200 s at most), so on
// Vercel they end inside this.
export const maxDuration = 300;

// The scheduler calls this every minute, so a database outage would log an error, and through
// Sentry's console capture report one, at every call. Once a minute per process, as /api/health.
const LOG_EVERY_MS = 60_000;
let lastLogged = -Infinity;

function logFailure(message: string, detail: unknown) {
  const now = Date.now();
  if (now - lastLogged < LOG_EVERY_MS) return;
  lastLogged = now;
  console.error(message, detail);
}

type Admin = ReturnType<typeof createAdminClient>;

/** A kind's run, or null when this server can't do its work: no menu reader, or no Resend. */
function runner(kind: JobKind, admin: Admin): (() => Promise<unknown>) | null {
  switch (kind) {
    case 'data_exports':
      return () => runExclusive(kind, EXPORT_RUN_MS, (run) => runExportJobs(admin, run));
    case 'hindi_names':
      if (menuImportProviders().length === 0) return null;
      return () => runExclusive(kind, HINDI_RUN_MS, (run) => fillWaitingHindiNames(admin, { run }));
    case 'announcement_emails': {
      const email = emailConfig();
      if (!email) return null;
      const appUrl = getPublicEnv().NEXT_PUBLIC_APP_URL;
      return () =>
        runExclusive(kind, EMAIL_RUN_MS, (run) =>
          sendAnnouncementEmails(admin, email, appUrl, { run, minuteJob: true }),
        );
    }
  }
}

/**
 * The minute job (docs/DECISIONS.md VPS-25, VPS-29), called every minute by the scheduler with
 * `Authorization: Bearer <CRON_SECRET>`; `?kinds=a,b` keeps it to those kinds. It asks which kinds
 * have work waiting, and after its answer starts a run of each that this server can do, exports
 * first. A run of that kind already going in this process goes once more instead. It answers at
 * once with the kinds it started, and never waits for their work.
 */
export async function GET(request: Request) {
  if (!cronAuthorised(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: noStore });
  }
  const asked = new URL(request.url).searchParams.get('kinds');
  const kinds = asked === null ? [...JOB_KINDS] : asked.split(',').map((kind) => kind.trim());
  if (!kinds.every((kind): kind is JobKind => (JOB_KINDS as readonly string[]).includes(kind))) {
    return NextResponse.json({ error: 'Unknown kind' }, { status: 400, headers: noStore });
  }

  const admin = createAdminClient();
  let waiting;
  try {
    const { data, error } = await admin.rpc('jobs_waiting');
    const parsed = jobsWaitingSchema.safeParse(data);
    if (error || !parsed.success) {
      logFailure('[cron/jobs] jobs_waiting failed', error ?? { data });
      return NextResponse.json({ ok: false }, { status: 500, headers: noStore });
    }
    waiting = parsed.data;
  } catch (error) {
    logFailure('[cron/jobs] jobs_waiting threw', error);
    return NextResponse.json({ ok: false }, { status: 500, headers: noStore });
  }

  const started: JobKind[] = [];
  for (const kind of JOB_KINDS) {
    const run = kinds.includes(kind) && waiting[kind] ? runner(kind, admin) : null;
    if (!run) continue;
    after(() =>
      run().catch((error: unknown) => console.error(`[cron/jobs] ${kind} failed`, error)),
    );
    started.push(kind);
  }
  return NextResponse.json({ ok: true, started }, { headers: noStore });
}
