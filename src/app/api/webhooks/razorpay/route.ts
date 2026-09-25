import { createHash } from 'node:crypto';

import { NextResponse } from 'next/server';

import { getServerEnv } from '@/lib/env.server';
import { verifyWebhookSignature } from '@/lib/razorpay/razorpay';
import { createAdminClient } from '@/lib/supabase/admin';
import type { Json } from '@/types/database';

const noStore = { 'Cache-Control': 'no-store' };
const MAX_BODY_BYTES = 1_000_000;

function reply(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, { status, headers: noStore });
}

/**
 * Razorpay webhooks (spec §14.4, docs/DECISIONS.md P8-4). The signature is
 * checked on the raw body; the event is then stored once and processed in the
 * database. A 200 goes back once the event is stored, even if processing
 * failed (the error shows on the super-admin webhooks page), so Razorpay
 * doesn't retry forever; only a failure to store it asks for a retry.
 */
export async function POST(request: Request) {
  const secret = getServerEnv().RAZORPAY_WEBHOOK_SECRET;
  if (!secret) return reply({ error: 'Webhooks are not set up' }, 503);

  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) {
    return reply({ error: 'Too large' }, 413);
  }
  const body = await request.text();
  if (Buffer.byteLength(body) > MAX_BODY_BYTES) return reply({ error: 'Too large' }, 413);

  if (!verifyWebhookSignature(body, request.headers.get('x-razorpay-signature'), secret)) {
    return reply({ error: 'Invalid signature' }, 400);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return reply({ error: 'Not JSON' }, 400);
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return reply({ error: 'Not an event' }, 400);
  }

  const eventId =
    request.headers.get('x-razorpay-event-id')?.trim().slice(0, 200) ||
    `sha256:${createHash('sha256').update(body).digest('hex')}`;

  const { data, error } = await createAdminClient().rpc('razorpay_record_webhook', {
    p_event_id: eventId,
    p_payload: payload as Json,
  });
  if (error) {
    console.error('[webhooks/razorpay] could not store event', eventId, error);
    return reply({ error: 'Not stored' }, 500);
  }
  if (data === 'failed') {
    console.warn('[webhooks/razorpay] event stored, processing failed', eventId);
  }
  return reply({ ok: true, result: data });
}
