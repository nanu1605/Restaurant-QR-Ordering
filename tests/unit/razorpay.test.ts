import { createHmac } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  cancelSubscription,
  createPaymentLink,
  createPlan,
  createSubscription,
  RazorpayError,
  verifyCheckoutSignature,
  verifyWebhookSignature,
  type RazorpayConfig,
} from '@/lib/razorpay/razorpay';

// Razorpay client and signature checks (spec §14.3–14.4, docs/DECISIONS.md P8-1).

const hmac = (message: string, secret: string) =>
  createHmac('sha256', secret).update(message).digest('hex');

function config(fetchImpl: typeof fetch): RazorpayConfig {
  return {
    keyId: 'rzp_test_key',
    keySecret: 'secret',
    baseUrl: 'https://api.razorpay.test/v1/',
    fetchImpl,
  };
}

function reply(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }));
}

describe('verifyWebhookSignature', () => {
  const body = '{"event":"subscription.charged","payload":{}}';

  it('accepts the signature of the raw body', () => {
    expect(verifyWebhookSignature(body, hmac(body, 'whsec'), 'whsec')).toBe(true);
  });

  it('rejects a changed body, another secret, a missing or short signature', () => {
    const signature = hmac(body, 'whsec');
    expect(verifyWebhookSignature(`${body} `, signature, 'whsec')).toBe(false);
    expect(verifyWebhookSignature(body, signature, 'other')).toBe(false);
    expect(verifyWebhookSignature(body, null, 'whsec')).toBe(false);
    expect(verifyWebhookSignature(body, signature.slice(0, 10), 'whsec')).toBe(false);
  });
});

describe('verifyCheckoutSignature', () => {
  it('checks payment id | subscription id with the key secret', () => {
    const signature = hmac('pay_1|sub_1', 'secret');
    expect(
      verifyCheckoutSignature({ paymentId: 'pay_1', subscriptionId: 'sub_1', signature }, 'secret'),
    ).toBe(true);
    expect(
      verifyCheckoutSignature({ paymentId: 'pay_1', subscriptionId: 'sub_2', signature }, 'secret'),
    ).toBe(false);
  });
});

describe('requests', () => {
  it('creates a subscription that starts later, with basic auth', async () => {
    const fetchImpl = reply(200, {
      id: 'sub_Abc1',
      status: 'created',
      short_url: 'https://rzp.io/x',
    });
    const entity = await createSubscription(config(fetchImpl), {
      planId: 'plan_Growth1',
      totalCount: 120,
      startAt: new Date('2026-10-10T09:30:00Z'),
      notes: { restaurant_id: 'r1', plan_code: 'growth', billing_cycle: 'monthly' },
    });
    expect(entity.id).toBe('sub_Abc1');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.razorpay.test/v1/subscriptions');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from('rzp_test_key:secret').toString('base64')}`,
    );
    expect(JSON.parse(init.body as string)).toEqual({
      plan_id: 'plan_Growth1',
      total_count: 120,
      customer_notify: true,
      notes: { restaurant_id: 'r1', plan_code: 'growth', billing_cycle: 'monthly' },
      start_at: 1791624600,
    });
  });

  it('starts now when there is no start time', async () => {
    const fetchImpl = reply(200, { id: 'sub_Abc1', status: 'created' });
    await createSubscription(config(fetchImpl), {
      planId: 'plan_Growth1',
      totalCount: 10,
      startAt: null,
      notes: {},
    });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).not.toHaveProperty('start_at');
  });

  it('cancels at the end of the cycle', async () => {
    const fetchImpl = reply(200, { id: 'sub_Abc1', status: 'active' });
    await cancelSubscription(config(fetchImpl), 'sub_Abc1', true);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.razorpay.test/v1/subscriptions/sub_Abc1/cancel');
    expect(JSON.parse(init.body as string)).toEqual({ cancel_at_cycle_end: true });
  });

  it('creates a plan and a payment link', async () => {
    const plan = await createPlan(config(reply(200, { id: 'plan_New1' })), {
      cycle: 'yearly',
      name: 'MenuMesh Pro — yearly',
      amountPaise: 1799000,
      notes: { plan_code: 'pro' },
    });
    expect(plan.id).toBe('plan_New1');

    const fetchImpl = reply(200, {
      id: 'plink_1',
      short_url: 'https://rzp.io/l',
      status: 'created',
    });
    const link = await createPaymentLink(config(fetchImpl), {
      amountPaise: 149900,
      description: 'Setup fee',
      notes: { restaurant_id: 'r1', purpose: 'setup_fee' },
      customer: { name: 'Tandoor', email: 'owner@example.com' },
    });
    expect(link.short_url).toBe('https://rzp.io/l');
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({
      amount: 149900,
      currency: 'INR',
      notify: { email: true, sms: false },
    });
  });

  it('turns failures into RazorpayError with Razorpay’s description', async () => {
    const failing = reply(400, {
      error: { code: 'BAD_REQUEST_ERROR', description: 'The id provided does not exist' },
    });
    await expect(cancelSubscription(config(failing), 'sub_X1', false)).rejects.toMatchObject({
      kind: 'http',
      status: 400,
      message: 'Razorpay answered 400: The id provided does not exist',
    });

    const down = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(cancelSubscription(config(down), 'sub_X1', false)).rejects.toMatchObject({
      kind: 'network',
    });

    const odd = reply(200, { id: 'not-a-subscription' });
    await expect(cancelSubscription(config(odd), 'sub_X1', false)).rejects.toBeInstanceOf(
      RazorpayError,
    );
  });
});
