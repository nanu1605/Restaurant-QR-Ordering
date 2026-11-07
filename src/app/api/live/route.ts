import { NextResponse } from 'next/server';

// The commit this build came from, set by the deploy (docs/DECISIONS.md P10-7).
const version = process.env.NEXT_PUBLIC_BUILD_SHA ?? null;

/**
 * Liveness: the process answers, nothing more. It never reaches the database, so a Supabase
 * outage doesn't make the web container look dead (docs/DECISIONS.md VPS-17). The container's
 * own check calls this; /api/health, which reaches the database, is for uptime monitors and
 * the deploy.
 */
export function GET() {
  return NextResponse.json(
    { status: 'ok', version, time: new Date().toISOString() },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
