'use client';

import { cn } from 'cn';
import { Check } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import { Money } from '@/components/shared/money';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { FEATURE_KEYS, FEATURE_LABELS } from '@/features/plans/plan-features';

import { withGst } from '../gst';

import { cancelAutopay, confirmCheckout, startSubscription, type CheckoutStart } from '../actions';
import type { BillingCycle, CheckoutPlan } from '../autopay';

/**
 * Paying online (spec §14.3, docs/DECISIONS.md P8-7): plan cards with a
 * monthly/yearly choice that open Razorpay Checkout, or, once autopay is set
 * up, a way to cancel it.
 */

const CHECKOUT_SRC = 'https://checkout.razorpay.com/v1/checkout.js';

type CheckoutReply = {
  razorpay_payment_id: string;
  razorpay_subscription_id: string;
  razorpay_signature: string;
};

type RazorpayCheckout = {
  open(): void;
  on(event: 'payment.failed', handler: (reply: { error?: { description?: string } }) => void): void;
};

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => RazorpayCheckout;
  }
}

let checkoutScript: Promise<void> | null = null;

/** Loads Checkout on first use, so the page itself never waits for Razorpay. */
function loadCheckout(): Promise<void> {
  if (window.Razorpay) return Promise.resolve();
  checkoutScript ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = CHECKOUT_SRC;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      checkoutScript = null;
      script.remove();
      reject(new Error('Checkout did not load'));
    };
    document.body.append(script);
  });
  return checkoutScript;
}

type AutopayPanelProps = {
  plans: CheckoutPlan[];
  /** Plan cards are shown while nothing will charge (or autopay is ending). */
  canSubscribe: boolean;
  /** Autopay is on and can be cancelled. */
  cancel: CancelOptions | null;
  /** Text about when the first payment happens, for the cards. */
  firstPayment: string;
  /** The plan and cycle chosen on the website before signing up (docs/DECISIONS.md W-9). */
  chosen?: { planCode: string | null; cycle: BillingCycle };
};

export function AutopayPanel({
  plans,
  canSubscribe,
  cancel,
  firstPayment,
  chosen,
}: AutopayPanelProps) {
  const router = useRouter();
  const [cycle, setCycle] = useState<BillingCycle>(chosen?.cycle ?? 'monthly');
  const [busy, setBusy] = useState<string | null>(null);
  const [activating, setActivating] = useState(false);

  async function subscribe(plan: CheckoutPlan) {
    setBusy(plan.code);
    let opened = false;
    try {
      const result = await startSubscription({ planCode: plan.code, cycle });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      try {
        await loadCheckout();
      } catch {
        toast.error('Razorpay Checkout could not load. Check the connection and try again.');
        return;
      }
      openCheckout(result.data);
      opened = true;
    } catch {
      toast.error('Something went wrong. Try again.');
    } finally {
      // Once Checkout is open, closing it or paying clears the busy state.
      if (!opened) setBusy(null);
    }
  }

  async function confirm(reply: CheckoutReply) {
    setActivating(true);
    try {
      const confirmed = await confirmCheckout({
        paymentId: reply.razorpay_payment_id,
        subscriptionId: reply.razorpay_subscription_id,
        signature: reply.razorpay_signature,
      });
      if (confirmed.ok) toast.success('Autopay is set up');
      else toast.error(confirmed.error);
    } catch {
      toast.error('Autopay is being confirmed. Refresh the page in a minute.');
    } finally {
      setActivating(false);
      setBusy(null);
      router.refresh();
    }
  }

  function openCheckout(start: CheckoutStart) {
    const Razorpay = window.Razorpay!;
    const checkout = new Razorpay({
      key: start.keyId,
      subscription_id: start.subscriptionId,
      name: start.name,
      description: start.description,
      prefill: start.prefill,
      handler: (reply: CheckoutReply) => void confirm(reply),
      modal: { ondismiss: () => setBusy(null) },
    });
    checkout.on('payment.failed', (reply) => {
      toast.error(reply.error?.description ?? 'The payment failed. Try another card or UPI app.');
    });
    checkout.open();
  }

  if (activating) {
    return (
      <p role="status" className="text-sm text-ink">
        Activating your subscription…
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {cancel && <CancelAutopay {...cancel} />}
      {canSubscribe && plans.length > 0 && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-ink-muted">{firstPayment}</p>
            <div
              role="group"
              aria-label="Billing cycle"
              className="flex rounded-lg border border-line p-0.5"
            >
              {(['monthly', 'yearly'] as const).map((value) => (
                <Button
                  key={value}
                  type="button"
                  size="sm"
                  variant={cycle === value ? 'default' : 'ghost'}
                  aria-pressed={cycle === value}
                  onClick={() => setCycle(value)}
                >
                  {value === 'monthly' ? 'Monthly' : 'Yearly'}
                </Button>
              ))}
            </div>
          </div>
          <ul aria-label="Plans" className="grid gap-3 md:grid-cols-3">
            {plans.map((plan) => {
              const available = plan.cycles.includes(cycle);
              const picked = plan.code === chosen?.planCode;
              return (
                <li
                  key={plan.code}
                  aria-label={plan.name}
                  className={cn(
                    'flex flex-col gap-3 rounded-lg border p-4',
                    picked ? 'border-brand ring-2 ring-brand/25' : 'border-line',
                  )}
                >
                  <div>
                    {picked && (
                      <p className="text-xs font-semibold tracking-wide text-brand uppercase">
                        Your choice
                      </p>
                    )}
                    <h3 className="text-base font-semibold text-ink">{plan.name}</h3>
                    <p className="text-sm text-ink-muted">
                      <span className="text-xl font-semibold text-ink">
                        <Money paise={cycle === 'monthly' ? plan.monthlyPaise : plan.yearlyPaise} />
                      </span>{' '}
                      {cycle === 'monthly' ? 'a month' : 'a year'} + GST
                    </p>
                    <p className="text-sm text-ink-muted">
                      You pay{' '}
                      <Money
                        paise={withGst(cycle === 'monthly' ? plan.monthlyPaise : plan.yearlyPaise)}
                      />{' '}
                      {cycle === 'monthly' ? 'a month' : 'a year'} with 18% GST
                    </p>
                  </div>
                  <ul className="flex flex-col gap-1 text-sm text-ink">
                    <li>
                      {plan.maxTables === null
                        ? 'Unlimited tables'
                        : `Up to ${plan.maxTables} tables`}
                    </li>
                    <li>
                      {plan.maxStaff === null
                        ? 'Unlimited staff logins'
                        : `Up to ${plan.maxStaff} staff logins`}
                    </li>
                    {FEATURE_KEYS.filter((key) => plan.features[key]).map((key) => (
                      <li key={key} className="flex items-center gap-1.5">
                        <Check aria-hidden className="size-4 text-status-served" />
                        {FEATURE_LABELS[key]}
                      </li>
                    ))}
                  </ul>
                  <Button
                    className="mt-auto"
                    size="touch"
                    disabled={!available || busy !== null}
                    onClick={() => subscribe(plan)}
                  >
                    {available
                      ? busy === plan.code
                        ? 'Opening Razorpay…'
                        : `Subscribe to ${plan.name}`
                      : `Not available ${cycle}`}
                  </Button>
                </li>
              );
            })}
          </ul>
          <p className="text-xs text-ink-muted">
            Payments go through Razorpay by UPI Autopay or card, include 18% GST and renew
            automatically. You can cancel any time; it stops at the end of the paid period.
          </p>
        </>
      )}
    </div>
  );
}

export type CancelOptions = {
  /** Charged already, so it stops at the end of the paid cycle; otherwise now. */
  atCycleEnd: boolean;
  /** The last day of the trial or paid period still running. */
  until: string | null;
  running: 'trial' | 'paid';
};

function CancelAutopay({ atCycleEnd, until, running }: CancelOptions) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  function confirm() {
    startTransition(async () => {
      const result = await cancelAutopay();
      if (result.ok) {
        toast.success(
          atCycleEnd ? 'Autopay will stop at the end of the paid period' : 'Autopay cancelled',
        );
        setOpen(false);
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <p className="text-sm text-ink">Autopay is on.</p>
      <Button variant="outline" size="touch" onClick={() => setOpen(true)}>
        {atCycleEnd ? 'Cancel at period end' : 'Cancel autopay'}
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel autopay?</AlertDialogTitle>
            <AlertDialogDescription>
              {atCycleEnd
                ? `Nothing more will be charged. Ordering stays on until ${until ?? 'the paid period ends'}.`
                : `Nothing will be charged.${until ? ` Your ${running === 'trial' ? 'free trial' : 'paid period'} still runs until ${until}.` : ''}`}{' '}
              This can&apos;t be undone, but you can subscribe again at any time.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep autopay</AlertDialogCancel>
            <AlertDialogAction onClick={confirm} disabled={pending}>
              Cancel autopay
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
