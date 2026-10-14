import { NextResponse } from 'next/server';

import { sendDigest } from '@/features/platform/digest';
import { cronAuthorised, cronStep } from '@/lib/cron';
import { emailConfig } from '@/lib/email/resend';
import { getPublicEnv } from '@/lib/env';
import { createAdminClient } from '@/lib/supabase/admin';

const noStore = { 'Cache-Control': 'no-store' };

export const maxDuration = 60;

/**
 * The super-admin daily digest at 08:45 India time (vercel.json;
 * docs/DECISIONS.md SA-31), recorded in cron_runs as job "digest". Sent once
 * a day however often this runs.
 */
export async function GET(request: Request) {
  if (!cronAuthorised(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: noStore });
  }
  const admin = createAdminClient();
  const digest = await cronStep(admin, 'digest', 'digest', () =>
    sendDigest(admin, emailConfig(), getPublicEnv().NEXT_PUBLIC_APP_URL),
  );
  return NextResponse.json(
    { ok: digest !== null, digest },
    { status: digest ? 200 : 500, headers: noStore },
  );
}
