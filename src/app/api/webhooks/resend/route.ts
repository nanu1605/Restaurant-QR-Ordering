import { NextResponse } from 'next/server';

import { verifySvix } from '@/lib/email/webhook';
import { getServerEnv } from '@/lib/env.server';
import { createAdminClient } from '@/lib/supabase/admin';

const noStore = { 'Cache-Control': 'no-store' };
const MAX_BODY_BYTES = 1_000_000;

function reply(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, { status, headers: noStore });
}

/**
 * Resend's webhook (docs/DECISIONS.md SA-88): a bounce, complaint or later
 * failure marks our row in email_log by Resend's email id. Only the event
 * type and that id are read; the payload (with its addresses) isn't kept.
 * Other events and unknown ids get a 200, so Resend doesn't retry them.
 */
export async function POST(request: Request) {
  const secret = getServerEnv().RESEND_WEBHOOK_SECRET;
  if (!secret) return reply({ error: 'Webhooks are not set up' }, 503);

  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) {
    return reply({ error: 'Too large' }, 413);
  }
  const body = await request.text();
  if (Buffer.byteLength(body) > MAX_BODY_BYTES) return reply({ error: 'Too large' }, 413);

  const signed = verifySvix(
    body,
    {
      id: request.headers.get('svix-id'),
      timestamp: request.headers.get('svix-timestamp'),
      signature: request.headers.get('svix-signature'),
    },
    secret,
  );
  if (!signed) return reply({ error: 'Invalid signature' }, 400);

  let event: { type?: unknown; data?: { email_id?: unknown } } | null;
  try {
    event = JSON.parse(body);
  } catch {
    return reply({ error: 'Not JSON' }, 400);
  }
  const type = event?.type;
  const emailId = event?.data?.email_id;
  if (typeof type !== 'string' || typeof emailId !== 'string') {
    return reply({ ok: true, updated: 0 });
  }

  const { data, error } = await createAdminClient().rpc('email_log_record_event', {
    p_provider_id: emailId.slice(0, 100),
    p_type: type.slice(0, 60),
  });
  if (error) {
    console.error('[webhooks/resend] could not record event', type, error);
    return reply({ error: 'Not stored' }, 500);
  }
  return reply({ ok: true, updated: data });
}
