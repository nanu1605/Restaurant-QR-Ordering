import { NextResponse } from 'next/server';

import { createAdminClient } from '@/lib/supabase/admin';

const noStore = { 'Cache-Control': 'no-store' };

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
    return NextResponse.json({ status: 'ok', db: 'ok', time }, { headers: noStore });
  } catch (err) {
    console.error('[health] health_check threw', err);
    return NextResponse.json(
      { status: 'error', db: 'error', time },
      { status: 503, headers: noStore },
    );
  }
}
