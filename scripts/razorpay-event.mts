/**
 * Sends a simulated, correctly signed Razorpay webhook to the local app
 * (docs/DECISIONS.md P8-13), so subscription states can be tried without a
 * Razorpay account or a tunnel. Uses .env.local: the Supabase URL and secret
 * key (to read the restaurant) and RAZORPAY_WEBHOOK_SECRET (any string
 * locally; the app must run with the same value).
 *
 *   pnpm razorpay:event --restaurant demo --event charged
 *   pnpm razorpay:event --restaurant demo --event payment-link --months 3
 *
 * A restaurant without a Razorpay subscription, or whose one has ended, gets
 * a made-up one first, as if the owner had started checkout.
 */
import { createHmac, randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';

import { createClient } from '@supabase/supabase-js';

import { setupFeeDiscountPaise } from '../src/features/platform/setup-fee.ts';
import { withGst } from '../src/features/subscriptions/gst.ts';
import type { Database } from '../src/types/database.ts';

// Event → the subscription status Razorpay reports with it.
const SUBSCRIPTION_EVENTS: Record<string, string> = {
  authenticated: 'authenticated',
  activated: 'active',
  charged: 'active',
  pending: 'pending',
  halted: 'halted',
  cancelled: 'cancelled',
  completed: 'completed',
};
const EVENTS = [...Object.keys(SUBSCRIPTION_EVENTS), 'payment-link', 'setup-fee'];

const USAGE = `Usage: pnpm razorpay:event --restaurant <code> --event <${EVENTS.join('|')}>
       [--months <1-24>] [--amount <paise>] [--url http://localhost:3000]

<code> is the restaurant code staff log in with. For example:
  pnpm razorpay:event --restaurant demo --event charged
  pnpm razorpay:event --restaurant demo --event payment-link --months 3`;

function fail(message: string): never {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}

const { values: args } = parseArgs({
  options: {
    restaurant: { type: 'string' },
    event: { type: 'string' },
    months: { type: 'string', default: '1' },
    amount: { type: 'string' },
    url: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
  strict: true,
});
if (args.help) {
  console.log(USAGE);
  process.exit(0);
}
if (!args.restaurant || !args.event || !EVENTS.includes(args.event)) fail(USAGE);

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secretKey = process.env.SUPABASE_SECRET_KEY;
const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
if (!supabaseUrl || !secretKey)
  fail('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY must be set.');
if (!webhookSecret)
  fail('Set RAZORPAY_WEBHOOK_SECRET in .env.local (any string) and restart the app.');
const appUrl = args.url ?? process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';

const admin = createClient<Database>(supabaseUrl, secretKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const devId = (prefix: string) => `${prefix}_dev${randomUUID().replaceAll('-', '').slice(0, 14)}`;
const unix = (date: Date) => Math.floor(date.getTime() / 1000);

const { data: restaurant } = await admin
  .from('restaurants')
  .select('id, name')
  .eq('slug', args.restaurant)
  .maybeSingle();
if (!restaurant) fail(`No restaurant with the code "${args.restaurant}".`);

const { data: sub, error } = await admin
  .from('restaurant_subscriptions')
  .select(
    'razorpay_subscription_id, razorpay_status, billing_cycle, next_billing_cycle, current_period_end, plan:plans!restaurant_subscriptions_plan_id_fkey (code, price_monthly_paise, price_yearly_paise), next_plan:plans!restaurant_subscriptions_next_plan_id_fkey (code, price_monthly_paise, price_yearly_paise)',
  )
  .eq('restaurant_id', restaurant.id)
  .single();
if (error) fail(`Could not read the subscription: ${error.message}`);

const { data: settings, error: settingsError } = await admin
  .from('platform_settings')
  .select('setup_fee_paise, setup_fee_discount_paise, setup_fee_discount_ends_at')
  .eq('id', 1)
  .single();
if (settingsError) fail(`Could not read the setup fee: ${settingsError.message}`);

const plan = sub.next_plan ?? sub.plan;
const cycle = sub.next_billing_cycle ?? sub.billing_cycle ?? 'monthly';
const price = cycle === 'yearly' ? plan.price_yearly_paise : plan.price_monthly_paise;
// What Razorpay takes: the fee plus GST (docs/DECISIONS.md W-11), unless --amount says otherwise.
const amount = Number(
  args.amount ??
    withGst(
      args.event === 'setup-fee'
        ? settings.setup_fee_paise - setupFeeDiscountPaise(settings)
        : args.event === 'payment-link'
          ? price * Number(args.months)
          : price,
    ),
);
const now = new Date();

let payload: Record<string, unknown>;
if (args.event === 'payment-link' || args.event === 'setup-fee') {
  const notes =
    args.event === 'setup-fee'
      ? {
          restaurant_id: restaurant.id,
          purpose: 'setup_fee',
          list_price_paise: String(settings.setup_fee_paise),
          discount_paise: String(setupFeeDiscountPaise(settings)),
        }
      : { restaurant_id: restaurant.id, purpose: 'subscription', months: args.months };
  payload = {
    entity: 'event',
    event: 'payment_link.paid',
    created_at: unix(now),
    payload: {
      payment_link: {
        entity: { id: devId('plink'), amount, amount_paid: amount, status: 'paid', notes },
      },
      payment: { entity: { id: devId('pay'), amount, status: 'captured', method: 'upi' } },
    },
  };
} else {
  let subscriptionId = sub.razorpay_subscription_id;
  // Razorpay sends nothing more for an ended subscription: the owner subscribes again.
  const ended = ['cancelled', 'completed', 'expired'].includes(sub.razorpay_status ?? '');
  if (!subscriptionId || ended) {
    subscriptionId = devId('sub');
    const attached = await admin.rpc('razorpay_save_subscription', {
      p_restaurant_id: restaurant.id,
      p_entity: {
        id: subscriptionId,
        status: 'created',
        notes: { restaurant_id: restaurant.id, plan_code: plan.code, billing_cycle: cycle },
      },
    });
    if (attached.error) fail(`Could not attach a subscription: ${attached.error.message}`);
    console.log(`Attached made-up subscription ${subscriptionId} (${plan.code}, ${cycle}).`);
  }

  // A new paid period starts when the current one ends, or now.
  const start = new Date(Math.max(now.getTime(), Date.parse(sub.current_period_end ?? '') || 0));
  const end = new Date(start);
  if (cycle === 'yearly') end.setFullYear(end.getFullYear() + 1);
  else end.setMonth(end.getMonth() + 1);
  const paid = args.event === 'activated' || args.event === 'charged';

  payload = {
    entity: 'event',
    event: `subscription.${args.event}`,
    created_at: unix(now),
    payload: {
      subscription: {
        entity: {
          id: subscriptionId,
          status: SUBSCRIPTION_EVENTS[args.event],
          customer_id: 'cust_dev0000000001',
          notes: { restaurant_id: restaurant.id, plan_code: plan.code, billing_cycle: cycle },
          ...(paid ? { current_start: unix(start), current_end: unix(end) } : {}),
        },
      },
      ...(args.event === 'charged'
        ? { payment: { entity: { id: devId('pay'), amount, status: 'captured', method: 'card' } } }
        : {}),
    },
  };
}

const body = JSON.stringify(payload);
const response = await fetch(`${appUrl.replace(/\/+$/, '')}/api/webhooks/razorpay`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Razorpay-Signature': createHmac('sha256', webhookSecret).update(body).digest('hex'),
    'X-Razorpay-Event-Id': devId('evt'),
  },
  body,
}).catch((cause: unknown) => fail(`Could not reach ${appUrl}: ${String(cause)}`));

const text = await response.text();
if (!response.ok) fail(`The app answered ${response.status}: ${text}`);
console.log(`✔ ${String(payload.event)} for ${restaurant.name}: ${text}`);
