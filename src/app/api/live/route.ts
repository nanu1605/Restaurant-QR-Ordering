import { NextResponse } from 'next/server';

// The commit this build came from, set by the deploy (docs/DECISIONS.md P10-7).
const version = process.env.NEXT_PUBLIC_BUILD_SHA ?? null;

/**
 * Liveness: the process answers, nothing more. It never reaches the database, so it tells a web
 * process that is down from a database that is (docs/DECISIONS.md VPS-17). The container's own
 * check calls /api/health instead, so that a healthy container means the database answers too;
 * this one is for local checks (pnpm docker:check).
 */
export function GET() {
  return NextResponse.json(
    { status: 'ok', version, time: new Date().toISOString() },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
