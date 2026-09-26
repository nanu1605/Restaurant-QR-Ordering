import { NextResponse } from 'next/server';

import { createAdminClient } from '@/lib/supabase/admin';

const noStore = { 'Cache-Control': 'no-store' };
// The commit this build came from, set by the deploy (docs/DECISIONS.md P10-7).
const version = process.env.NEXT_PUBLIC_BUILD_SHA ?? null;

/** Liveness + database connectivity check for uptime monitors. */
export async function GET() {
  const time = new Date().toISOString();

  try {
    const { data, error } = await createAdminClient().rpc('health_check');
    if (error || data !== 'ok') {
      console.error('[health] health_check failed', error ?? { data });
      return NextResponse.json(
        { status: 'error', db: 'error', time },
        { status: 503, headers: noStore },
      );
    }
    return NextResponse.json({ status: 'ok', db: 'ok', version, time }, { headers: noStore });
  } catch (err) {
    console.error('[health] health_check threw', err);
    return NextResponse.json(
      { status: 'error', db: 'error', time },
      { status: 503, headers: noStore },
    );
  }
}
