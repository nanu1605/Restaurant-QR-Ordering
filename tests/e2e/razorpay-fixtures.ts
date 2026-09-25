import { createHmac, randomUUID } from 'node:crypto';

import type { APIRequestContext, Page } from '@playwright/test';

/**
 * Razorpay stand-ins for E2E (docs/DECISIONS.md P8-1, P8-4): the fake keys
 * the test server runs with (playwright.config.ts), signed webhooks, and a
 * Checkout script that "pays" at once with a correctly signed reply.
 */

export const RAZORPAY_KEY_SECRET = 'e2e-razorpay-secret';
export const WEBHOOK_SECRET = 'e2e-webhook-secret';

const hmac = (message: string, secret: string) =>
  createHmac('sha256', secret).update(message).digest('hex');
export const razorpayId = (prefix: string) =>
  `${prefix}_E2E${randomUUID().replaceAll('-', '').slice(0, 14)}`;
const unix = (date: Date) => Math.floor(date.getTime() / 1000);

/** False when the running server has no Razorpay webhook secret (a reused dev server). */
export async function razorpayReady(request: APIRequestContext): Promise<boolean> {
  const response = await request.post('/api/webhooks/razorpay', { data: '{}' });
  return response.status() !== 503;
}

export function subscriptionEvent(
  event: string,
  subscription: {
    id: string;
    status: string;
    restaurantId?: string;
    period?: { start: Date; end: Date };
  },
  payment?: { id: string; amount: number },
) {
  return {
    entity: 'event',
    event: `subscription.${event}`,
    created_at: unix(new Date()),
    payload: {
      subscription: {
        entity: {
          id: subscription.id,
          status: subscription.status,
          customer_id: 'cust_E2E0000000001',
          ...(subscription.restaurantId
            ? { notes: { restaurant_id: subscription.restaurantId } }
            : {}),
          ...(subscription.period
            ? {
                current_start: unix(subscription.period.start),
                current_end: unix(subscription.period.end),
              }
            : {}),
        },
      },
      ...(payment ? { payment: { entity: { ...payment, status: 'captured' } } } : {}),
    },
  };
}

export function paymentLinkEvent(
  notes: Record<string, string>,
  payment: { id: string; amount: number },
) {
  return {
    entity: 'event',
    event: 'payment_link.paid',
    created_at: unix(new Date()),
    payload: {
      payment_link: {
        entity: {
          id: razorpayId('plink'),
          amount: payment.amount,
          amount_paid: payment.amount,
          status: 'paid',
          notes,
        },
      },
      payment: { entity: { ...payment, status: 'captured' } },
    },
  };
}

/** Posts a webhook the way Razorpay does: raw JSON, its signature and an event id. */
export async function sendWebhook(
  request: APIRequestContext,
  payload: unknown,
  { eventId = razorpayId('evt'), secret = WEBHOOK_SECRET } = {},
) {
  const body = JSON.stringify(payload);
  return request.post('/api/webhooks/razorpay', {
    headers: {
      'Content-Type': 'application/json',
      'X-Razorpay-Signature': hmac(body, secret),
      'X-Razorpay-Event-Id': eventId,
    },
    data: body,
  });
}

/**
 * Replaces Razorpay Checkout with a script that completes at once and replies
 * with a signature made from the test key secret.
 */
export async function stubCheckout(page: Page) {
  await page.exposeFunction('e2eSignCheckout', (paymentId: string, subscriptionId: string) =>
    hmac(`${paymentId}|${subscriptionId}`, RAZORPAY_KEY_SECRET),
  );
  await page.route('https://checkout.razorpay.com/v1/checkout.js', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: `
        window.Razorpay = function (options) {
          this.on = function () {};
          this.open = async function () {
            const paymentId = 'pay_E2E' + Math.random().toString(36).slice(2, 12);
            const signature = await window.e2eSignCheckout(paymentId, options.subscription_id);
            options.handler({
              razorpay_payment_id: paymentId,
              razorpay_subscription_id: options.subscription_id,
              razorpay_signature: signature,
            });
          };
        };`,
    }),
  );
}
