import { cn } from 'cn';
import { ArrowRight, CircleCheck, Circle } from 'lucide-react';
import Link from 'next/link';

import { autopayState } from '@/features/subscriptions/autopay';
import {
  getCheckoutPlans,
  getOwnerSubscription,
  getPlanUsage,
} from '@/features/subscriptions/queries';
import { razorpayConfig } from '@/lib/razorpay/razorpay';
import { createClient } from '@/lib/supabase/server';

type Step = { title: string; body: string; href: string; done: boolean };

/** What a new restaurant still has to do, read from its data; nothing is stored. */
async function steps(restaurantId: string): Promise<Step[]> {
  const supabase = await createClient();
  const online = razorpayConfig() !== null;
  const [usage, items, restaurant, subscription, checkoutPlans] = await Promise.all([
    getPlanUsage(restaurantId),
    supabase
      .from('menu_items')
      .select('id', { count: 'exact', head: true })
      .eq('restaurant_id', restaurantId)
      .eq('is_active', true),
    supabase.from('restaurants').select('address_line').eq('id', restaurantId).single(),
    online ? getOwnerSubscription(restaurantId) : Promise.resolve(null),
    online ? getCheckoutPlans() : Promise.resolve([]),
  ]);
  if (items.error) throw new Error(`Could not count dishes: ${items.error.message}`);
  if (restaurant.error)
    throw new Error(`Could not read the restaurant: ${restaurant.error.message}`);

  const list: Step[] = [
    {
      title: 'Add your menu',
      body: 'Type it in, or import it from a photo, PDF or CSV.',
      href: '/admin/menu/import',
      done: (items.count ?? 0) > 0,
    },
    {
      title: 'Add your tables',
      body: 'Then print a QR code for each one.',
      href: '/admin/tables',
      done: usage.tables > 0,
    },
    {
      title: 'Give your staff their logins',
      body: 'Waiters, kitchen and managers each get their own.',
      href: '/admin/staff',
      done: usage.staff > 0,
    },
    {
      title: 'Add your address and GST details',
      body: 'They print on every bill.',
      href: '/admin/settings',
      done: Boolean(restaurant.data.address_line),
    },
  ];
  // Only when a plan can be paid online; otherwise support takes payment.
  if (subscription && checkoutPlans.length > 0) {
    list.push({
      title: 'Set up autopay',
      body: 'So ordering keeps running when your free trial ends.',
      href: '/admin/subscription',
      done: subscription.status === 'active' || autopayState(subscription) === 'on',
    });
  }
  return list;
}

/** A checklist on the owner's dashboard until the restaurant is set up (docs/DECISIONS.md W-9). */
export async function FirstSteps({ restaurantId }: { restaurantId: string }) {
  let list: Step[];
  try {
    list = await steps(restaurantId);
  } catch (error) {
    // A nicety: the dashboard works without it.
    console.error('[dashboard] first steps not loaded', error);
    return null;
  }
  const done = list.filter((step) => step.done).length;
  if (done === list.length) return null;

  return (
    <section
      aria-labelledby="first-steps-title"
      className="flex flex-col gap-3 rounded-lg border border-brand/30 bg-surface p-4"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="first-steps-title" className="text-base font-semibold text-ink">
          Set up your restaurant
        </h2>
        <p className="text-sm text-ink-muted">
          {done} of {list.length} done
        </p>
      </div>
      <ol className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {list.map((step) => {
          const Icon = step.done ? CircleCheck : Circle;
          return (
            <li key={step.href}>
              <Link
                href={step.href}
                className="flex min-h-11 items-start gap-3 rounded-md border border-line p-3 hover:border-brand/50"
              >
                <Icon
                  aria-hidden
                  className={cn(
                    'mt-0.5 size-5 shrink-0',
                    step.done ? 'text-status-served' : 'text-ink-muted',
                  )}
                />
                <span className="flex flex-1 flex-col">
                  <span className="text-sm font-semibold text-ink">
                    {step.title}
                    <span className="sr-only">{step.done ? ' (done)' : ' (to do)'}</span>
                  </span>
                  <span className="text-sm text-ink-muted">{step.body}</span>
                </span>
                {!step.done && <ArrowRight aria-hidden className="mt-0.5 size-4 text-brand" />}
              </Link>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
