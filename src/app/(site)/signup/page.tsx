import { Check } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { Money } from '@/components/shared/money';
import { SIGNUP } from '@/features/site/content';
import { SignupForm } from '@/features/site/components/signup-form';
import { getSitePricing } from '@/features/site/queries';
import { signupOpen } from '@/features/site/signup';
import { firstParam } from '@/lib/date-range';
import { turnstileConfig } from '@/lib/turnstile';

export const metadata: Metadata = {
  title: 'Start your free trial',
  description: 'Set up QR ordering, the staff board and bills for your restaurant in minutes.',
};

/** The chosen plan from /pricing, and the trial, for the page's summary. */
async function chosenPlan(code: string | undefined, cycle: 'monthly' | 'yearly') {
  try {
    const pricing = await getSitePricing();
    const plan = pricing.plans.find((candidate) => candidate.code === code) ?? null;
    return {
      trialDays: pricing.trialDays,
      plan: plan && {
        code: plan.code,
        name: plan.name,
        paise: cycle === 'yearly' ? plan.yearlyPaise : plan.monthlyPaise,
      },
    };
  } catch (error) {
    console.error('[site] plans not loaded for the signup page:', error);
    return { trialDays: null, plan: null };
  }
}

/** Step 1 of the self-serve signup (docs/DECISIONS.md W-9); without it, visitors book a demo. */
export default async function SignupPage({ searchParams }: PageProps<'/signup'>) {
  const params = await searchParams;
  const requested = firstParam(params, 'plan');
  const turnstile = turnstileConfig();
  if (!turnstile || !signupOpen()) {
    redirect(requested ? `/contact?plan=${encodeURIComponent(requested)}` : '/contact');
  }
  const cycle = firstParam(params, 'cycle') === 'yearly' ? 'yearly' : 'monthly';
  const { trialDays, plan } = await chosenPlan(requested, cycle);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-10 px-4 py-12 sm:px-6 sm:py-16">
      <div className="flex max-w-2xl flex-col gap-3">
        <h1 className="text-2xl font-bold text-ink sm:text-3xl">{SIGNUP.title}</h1>
        <p className="text-base text-ink-muted sm:text-lg">
          {SIGNUP.lead}
          {trialDays !== null && <> Your first {trialDays} days are free on the Growth plan.</>}
        </p>
      </div>
      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[1.6fr_1fr]">
        <SignupForm siteKey={turnstile.siteKey} planCode={plan?.code ?? ''} cycle={cycle} />
        <section aria-labelledby="perks-title" className="flex flex-col gap-4">
          <h2 id="perks-title" className="text-lg font-semibold text-ink">
            What you get
          </h2>
          <ul className="flex flex-col gap-3 text-base text-ink">
            {SIGNUP.perks.map((perk) => (
              <li key={perk} className="flex items-start gap-2">
                <Check aria-hidden className="mt-1 size-4 shrink-0 text-status-served" />
                {perk}
              </li>
            ))}
          </ul>
          {plan && (
            <p className="rounded-lg border border-line bg-surface px-4 py-3 text-sm text-ink">
              After the trial: the {plan.name} plan at{' '}
              <Money paise={plan.paise} fraction="auto" className="font-semibold" />{' '}
              {cycle === 'yearly' ? 'a year' : 'a month'} + GST, once you set up autopay.
            </p>
          )}
          <p className="text-sm text-ink-muted">
            Already have an account?{' '}
            <Link href="/login" className="font-medium text-brand underline underline-offset-2">
              Log in
            </Link>
          </p>
        </section>
      </div>
    </div>
  );
}
