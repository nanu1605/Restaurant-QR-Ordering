import { z } from 'zod';

import { qrFileName, qrPng, tableUrl } from '@/features/tables/qr';
import { getCurrentMembership } from '@/lib/auth/session';
import { ADMIN_PANEL_ROLES } from '@/lib/auth/roles';
import { getPublicEnv } from '@/lib/env';
import { createClient } from '@/lib/supabase/server';

/** Downloads one table's QR code as a PNG (spec §13.3 Tables & QR). */
export async function GET(_request: Request, ctx: RouteContext<'/admin/tables/[tableId]/qr'>) {
  const membership = await getCurrentMembership();
  if (!membership || !(ADMIN_PANEL_ROLES as readonly string[]).includes(membership.role)) {
    return new Response('Not allowed', { status: 403 });
  }

  const { tableId } = await ctx.params;
  if (!z.uuid().safeParse(tableId).success) return new Response('Not found', { status: 404 });

  // RLS limits this to the member's own restaurant.
  const supabase = await createClient();
  const { data: table } = await supabase
    .from('dining_tables')
    .select('label, qr_token')
    .eq('id', tableId)
    .maybeSingle();
  if (!table) return new Response('Not found', { status: 404 });

  const png = await qrPng(tableUrl(getPublicEnv().NEXT_PUBLIC_APP_URL, table.qr_token));
  return new Response(new Uint8Array(png), {
    headers: {
      'Content-Type': 'image/png',
      'Content-Disposition': `attachment; filename="${qrFileName(table.label)}"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
