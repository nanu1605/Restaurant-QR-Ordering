import { createHash, timingSafeEqual } from 'node:crypto';

import { NextResponse } from 'next/server';

import { removeOldImportPhotos } from '@/features/menu-import/cleanup';
import { getServerEnv } from '@/lib/env.server';
import { createAdminClient } from '@/lib/supabase/admin';

const noStore = { 'Cache-Control': 'no-store' };

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/** `Authorization: Bearer <CRON_SECRET>`; nobody gets in while the secret is unset. */
function authorised(request: Request): boolean {
  const secret = getServerEnv().CRON_SECRET;
  if (!secret) return false;
  const header = request.headers.get('authorization') ?? '';
  return timingSafeEqual(digest(header), digest(`Bearer ${secret}`));
}

/**
 * Daily housekeeping, called by the scheduler in vercel.json (spec §14.6,
 * docs/DECISIONS.md P7-20). Today: menu import photo cleanup. Phase 8 adds
 * subscription reminders here.
 */
export async function GET(request: Request) {
  if (!authorised(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: noStore });
  }
  try {
    const menuImports = await removeOldImportPhotos(createAdminClient());
    return NextResponse.json({ ok: true, menuImports }, { headers: noStore });
  } catch (error) {
    console.error('[cron/daily] failed', error);
    return NextResponse.json({ ok: false }, { status: 500, headers: noStore });
  }
}
