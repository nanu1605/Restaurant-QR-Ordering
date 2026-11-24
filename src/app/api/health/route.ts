import { NextResponse } from 'next/server';

import { createAdminClient } from '@/lib/supabase/admin';

const noStore = { 'Cache-Control': 'no-store' };
// The commit this build came from, set by the deploy (docs/DECISIONS.md P10-7).
const version = process.env.NEXT_PUBLIC_BUILD_SHA ?? null;

// The web container's own check calls this every 30 s (docs/DECISIONS.md VPS-17), so a database
// outage would log an error, and through Sentry's console capture report one, for every probe.
// Once a minute per process is enough to see it.
const LOG_EVERY_MS = 60_000;
let lastLogged = -Infinity;

function logFailure(message: string, detail: unknown) {
  const now = Date.now();
  if (now - lastLogged < LOG_EVERY_MS) return;
  lastLogged = now;
  console.error(message, detail);
}

/** Liveness + database connectivity check for uptime monitors and the container's own check. */
export async function GET() {
  const time = new Date().toISOString();

  try {
    const { data, error } = await createAdminClient().rpc('health_check');
    if (error || data !== 'ok') {
      logFailure('[health] health_check failed', error ?? { data });
      return NextResponse.json(
        { status: 'error', db: 'error', time },
        { status: 503, headers: noStore },
      );
    }
    return NextResponse.json({ status: 'ok', db: 'ok', version, time }, { headers: noStore });
  } catch (err) {
    logFailure('[health] health_check threw', err);
    return NextResponse.json(
      { status: 'error', db: 'error', time },
      { status: 503, headers: noStore },
    );
  }
}
