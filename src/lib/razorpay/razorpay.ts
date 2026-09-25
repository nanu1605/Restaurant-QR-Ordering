import { createHmac, timingSafeEqual } from 'node:crypto';

import { z } from 'zod';

import { getServerEnv } from '@/lib/env.server';

/**
 * A small Razorpay REST client over fetch, for platform subscriptions only
 * (spec §14, docs/DECISIONS.md P8-1): plans, subscriptions, payment links and
 * the two signature checks. Server-side only: it carries the key secret.
 */

export type RazorpayConfig = {
  keyId: string;
  keySecret: string;
  baseUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

/** The Razorpay account from the environment, or null when online payment is off. */
export function razorpayConfig(): RazorpayConfig | null {
  const env = getServerEnv();
  if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) return null;
  return {
    keyId: env.RAZORPAY_KEY_ID,
    keySecret: env.RAZORPAY_KEY_SECRET,
    baseUrl: env.RAZORPAY_API_BASE_URL,
  };
}

export type RazorpayErrorKind = 'network' | 'timeout' | 'http' | 'response';

export class RazorpayError extends Error {
  constructor(
    message: string,
    readonly kind: RazorpayErrorKind,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = 'RazorpayError';
  }
}

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_ERROR_TEXT = 300;

/** A subscription entity; the database checks the rest of it. */
export const subscriptionEntitySchema = z.looseObject({
  id: z.string().regex(/^sub_[A-Za-z0-9]{1,40}$/),
  status: z.string(),
  short_url: z.string().nullish(),
});
export type SubscriptionEntity = z.infer<typeof subscriptionEntitySchema>;

const planEntitySchema = z.looseObject({ id: z.string().regex(/^plan_[A-Za-z0-9]{1,40}$/) });
const paymentLinkEntitySchema = z.looseObject({
  id: z.string().regex(/^plink_[A-Za-z0-9]{1,40}$/),
  short_url: z.string(),
  status: z.string(),
});
export type PaymentLinkEntity = z.infer<typeof paymentLinkEntitySchema>;

async function errorText(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  try {
    const body = JSON.parse(text) as { error?: { description?: unknown } };
    const description = body.error?.description;
    return (typeof description === 'string' ? description : text).slice(0, MAX_ERROR_TEXT);
  } catch {
    return text.slice(0, MAX_ERROR_TEXT);
  }
}

async function request<T>(
  config: RazorpayConfig,
  method: 'GET' | 'POST',
  path: string,
  schema: z.ZodType<T>,
  body?: Record<string, unknown>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const auth = Buffer.from(`${config.keyId}:${config.keySecret}`).toString('base64');
  try {
    let response: Response;
    try {
      response = await (config.fetchImpl ?? fetch)(`${config.baseUrl.replace(/\/+$/, '')}${path}`, {
        method,
        headers: {
          Authorization: `Basic ${auth}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) throw error;
      throw new RazorpayError(
        `Razorpay could not be reached: ${error instanceof Error ? error.message : String(error)}`,
        'network',
      );
    }
    if (!response.ok) {
      throw new RazorpayError(
        `Razorpay answered ${response.status}: ${await errorText(response)}`,
        'http',
        response.status,
      );
    }
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new RazorpayError('Razorpay sent a reply that is not JSON', 'response');
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new RazorpayError('Razorpay sent a reply MenuMesh does not understand', 'response');
    }
    return parsed.data;
  } catch (error) {
    if (controller.signal.aborted) {
      throw new RazorpayError('Razorpay did not answer in time', 'timeout');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** A Razorpay plan: one price for one cycle. Plans can't be edited later. */
export async function createPlan(
  config: RazorpayConfig,
  plan: {
    cycle: 'monthly' | 'yearly';
    name: string;
    amountPaise: number;
    notes: Record<string, string>;
  },
): Promise<{ id: string }> {
  return request(config, 'POST', '/plans', planEntitySchema, {
    period: plan.cycle,
    interval: 1,
    item: { name: plan.name, amount: plan.amountPaise, currency: 'INR' },
    notes: plan.notes,
  });
}

/**
 * A subscription the owner then authorises in Checkout. With startAt, the
 * first charge waits until then (the end of a trial or paid period).
 */
export async function createSubscription(
  config: RazorpayConfig,
  subscription: {
    planId: string;
    totalCount: number;
    startAt: Date | null;
    notes: Record<string, string>;
  },
): Promise<SubscriptionEntity> {
  return request(config, 'POST', '/subscriptions', subscriptionEntitySchema, {
    plan_id: subscription.planId,
    total_count: subscription.totalCount,
    customer_notify: true,
    notes: subscription.notes,
    ...(subscription.startAt
      ? { start_at: Math.floor(subscription.startAt.getTime() / 1000) }
      : {}),
  });
}

export async function fetchSubscription(
  config: RazorpayConfig,
  id: string,
): Promise<SubscriptionEntity> {
  return request(
    config,
    'GET',
    `/subscriptions/${encodeURIComponent(id)}`,
    subscriptionEntitySchema,
  );
}

/** Cancels now, or at the end of the paid cycle. Razorpay allows this once. */
export async function cancelSubscription(
  config: RazorpayConfig,
  id: string,
  atCycleEnd: boolean,
): Promise<SubscriptionEntity> {
  return request(
    config,
    'POST',
    `/subscriptions/${encodeURIComponent(id)}/cancel`,
    subscriptionEntitySchema,
    { cancel_at_cycle_end: atCycleEnd },
  );
}

export async function createPaymentLink(
  config: RazorpayConfig,
  link: {
    amountPaise: number;
    description: string;
    notes: Record<string, string>;
    customer: { name?: string; email?: string; contact?: string };
  },
): Promise<PaymentLinkEntity> {
  const notify = { email: Boolean(link.customer.email), sms: Boolean(link.customer.contact) };
  return request(config, 'POST', '/payment_links', paymentLinkEntitySchema, {
    amount: link.amountPaise,
    currency: 'INR',
    description: link.description,
    customer: link.customer,
    notify,
    reminder_enable: true,
    notes: link.notes,
  });
}

function hmacMatches(message: string, secret: string, signature: string): boolean {
  const expected = Buffer.from(createHmac('sha256', secret).update(message).digest('hex'));
  const given = Buffer.from(signature);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** X-Razorpay-Signature: HMAC-SHA256 of the raw body with the webhook secret. */
export function verifyWebhookSignature(
  rawBody: string,
  signature: string | null,
  secret: string,
): boolean {
  return Boolean(signature) && hmacMatches(rawBody, secret, signature as string);
}

/** Checkout's reply for a subscription: HMAC-SHA256 of "payment_id|subscription_id". */
export function verifyCheckoutSignature(
  reply: { paymentId: string; subscriptionId: string; signature: string },
  keySecret: string,
): boolean {
  return hmacMatches(`${reply.paymentId}|${reply.subscriptionId}`, keySecret, reply.signature);
}
